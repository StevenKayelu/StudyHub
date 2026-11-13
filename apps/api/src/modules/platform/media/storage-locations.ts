import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { PrismaClient } from '../../../generated/prisma/client';
import type { ApiEnv } from '../config/env.schema';
import { runInPlatformTenantTx, runInPlatformTx, type TenantTx } from '../db/tenant-db';
import { AppError } from '../errors/app-error';
import { SecretBox } from '../security/secret-box';
import { toBytes } from '../security/tokens';
import { type ObjectStorage, S3ObjectStorage } from './object-storage';

export const STORAGE_LOCATIONS = Symbol('STORAGE_LOCATIONS');
export const BOOTSTRAP_STORAGE_LOCATION_ID = '00000000-0000-4000-8000-000000000010';
export const ACTIVE_STORAGE_LOCATION_KEY = 'storage.activeLocationId';

export const storageLocationConfigSchema = z
  .object({
    version: z.literal(1),
    endpoint: z
      .url()
      .nullable()
      .refine((value) => {
        if (value === null) return true;
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, 'Storage endpoints cannot contain credentials, query parameters or fragments'),
    region: z.string().min(1).max(100),
    bucket: z.string().min(3).max(255),
    forcePathStyle: z.boolean(),
    createBucket: z.boolean(),
  })
  .strict();
export type StorageLocationConfig = z.infer<typeof storageLocationConfigSchema>;
const credentialsSchema = z
  .object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) })
  .strict();
const context = (id: string) => `storage-location:${id}:v1`;

export function deploymentStorageDescriptor(env: ApiEnv) {
  const endpoint = env.S3_ENDPOINT === undefined ? null : new URL(env.S3_ENDPOINT).href.replace(/\/$/, '');
  const config = storageLocationConfigSchema.parse({
    version: 1,
    endpoint,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    createBucket: env.S3_CREATE_BUCKET,
  });
  const provider =
    endpoint !== null && new URL(endpoint).hostname.endsWith('.r2.cloudflarestorage.com') ? 'R2' : 'S3';
  return { provider, config, fingerprint: storageLocationFingerprint(provider, config) };
}

export function storageLocationFingerprint(provider: string, config: StorageLocationConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        provider,
        config.version,
        config.endpoint,
        config.region,
        config.bucket,
        config.forcePathStyle,
        config.createBucket,
      ]),
    )
    .digest('hex');
}

/** Bound adapter rejects a substituted school key before making any provider request. */
export function schoolStorage(storage: ObjectStorage, tenantId: string): ObjectStorage {
  if (!z.uuid().safeParse(tenantId).success) throw new AppError('TENANT_CONTEXT_MISSING');
  const prefix = `t/${tenantId}/`;
  const check = (key: string) => {
    const rest = key.slice(prefix.length);
    if (
      !key.startsWith(prefix) ||
      rest === '' ||
      key.includes('\\') ||
      key.includes('\0') ||
      /%(?:2e|2f|5c)/i.test(key) ||
      rest.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new AppError('FORBIDDEN', { detail: 'The object key does not belong to this school.' });
    }
  };
  return {
    presignPut: (key, options) => {
      check(key);
      return storage.presignPut(key, options);
    },
    presignGet: (key, options) => {
      check(key);
      return storage.presignGet(key, options);
    },
    head: (key) => {
      check(key);
      return storage.head(key);
    },
    readStart: (key, length) => {
      check(key);
      return storage.readStart(key, length);
    },
    stream: (key) => {
      check(key);
      return storage.stream(key);
    },
    put: (key, body, mime) => {
      check(key);
      return storage.put(key, body, mime);
    },
    delete: (key) => {
      check(key);
      return storage.delete(key);
    },
    deletePrefix: (candidate) => {
      if (candidate !== prefix) throw new AppError('FORBIDDEN');
      return storage.deletePrefix(candidate);
    },
  };
}

/** Immutable encrypted location snapshots. Neither reads nor retries consult the active writer. */
export class StorageLocations {
  private readonly box: SecretBox;
  private readonly adapters = new Map<string, Promise<ObjectStorage>>();

  constructor(
    private readonly prisma: PrismaClient,
    env: ApiEnv,
    private readonly factory: (
      config: StorageLocationConfig,
      credentials: z.infer<typeof credentialsSchema>,
    ) => ObjectStorage = (config, credentials) =>
      new S3ObjectStorage({ ...config, ...credentials, endpoint: config.endpoint ?? undefined }),
  ) {
    this.box = new SecretBox(env.IDENTITY_ENCRYPTION_KEY);
  }

  async active(tx: TenantTx, tenantId: string): Promise<{ locationId: string; storage: ObjectStorage }> {
    const pointer = await tx.platformSetting.findUnique({ where: { key: ACTIVE_STORAGE_LOCATION_KEY } });
    const locationId = pointer === null ? BOOTSTRAP_STORAGE_LOCATION_ID : pointer.value;
    if (!z.uuid().safeParse(locationId).success) throw this.unavailable();
    return { locationId: locationId as string, storage: await this.at(locationId as string, tenantId) };
  }

  async at(locationId: string | null, tenantId: string): Promise<ObjectStorage> {
    if (locationId === null || !z.uuid().safeParse(locationId).success) throw this.unavailable();
    let pending = this.adapters.get(locationId);
    if (pending === undefined) {
      pending = this.load(locationId).catch(() => {
        this.adapters.delete(locationId);
        // Do not expose decrypted data or SDK/crypto errors to callers/logs.
        throw this.unavailable();
      });
      this.adapters.set(locationId, pending);
      if (this.adapters.size > 64) this.adapters.delete(this.adapters.keys().next().value!);
    }
    return schoolStorage(await pending, tenantId);
  }

  /** Whether the active writer's location has been captured (`storage:bootstrap`); false otherwise. */
  async activeCaptured(): Promise<boolean> {
    return runInPlatformTx(this.prisma, async (tx) => {
      const pointer = await tx.platformSetting.findUnique({ where: { key: ACTIVE_STORAGE_LOCATION_KEY } });
      const id = pointer === null ? BOOTSTRAP_STORAGE_LOCATION_ID : pointer.value;
      if (!z.uuid().safeParse(id).success) return false;
      return (await tx.platformStorageLocation.count({ where: { id: id as string } })) === 1;
    });
  }

  async retained(): Promise<string[]> {
    return runInPlatformTx(this.prisma, async (tx) =>
      (
        await tx.platformStorageLocation.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })
      ).map((row) => row.id),
    );
  }

  private async load(id: string): Promise<ObjectStorage> {
    const row = await runInPlatformTx(this.prisma, (tx) =>
      tx.platformStorageLocation.findUnique({ where: { id } }),
    );
    if (row === null) throw this.unavailable();
    const config = storageLocationConfigSchema.parse(row.config);
    if (
      !['S3', 'R2'].includes(row.provider) ||
      row.fingerprint !== storageLocationFingerprint(row.provider, config)
    )
      throw this.unavailable();
    const credentials = credentialsSchema.parse(
      JSON.parse(this.box.open(Buffer.from(row.credentialsEnc), context(id)).toString('utf8')),
    );
    return this.factory(config, credentials);
  }

  private unavailable() {
    return new AppError('SERVICE_UNAVAILABLE', {
      detail:
        'The recorded storage location is unavailable or has not been captured. Ask an operator to verify storage bootstrap and retained credentials.',
    });
  }
}

/** Explicit deployment adoption; no provider calls, file moves, deletions, or active-writer changes. */
export async function bootstrapStorageLocations(options: {
  prisma: PrismaClient;
  env: ApiEnv;
  allowExisting?: boolean;
}) {
  const { prisma, env } = options;
  const descriptor = deploymentStorageDescriptor(env);
  const box = new SecretBox(env.IDENTITY_ENCRYPTION_KEY);
  const credentials = credentialsSchema.parse({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  const tenants = await runInPlatformTx(prisma, (tx) =>
    tx.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } }),
  );
  if (options.allowExisting !== true) {
    for (const tenant of tenants) {
      const unresolved = await runInPlatformTenantTx(
        prisma,
        tenant.id,
        async (tx) =>
          (await tx.asset.count({
            where: {
              storageLocationId: null,
              OR: [{ storageKey: { not: null } }, { derivativeKey: { not: null } }],
            },
          })) +
          (await tx.dataExport.count({ where: { storageLocationId: null, storageKey: { not: null } } })),
      );
      if (unresolved > 0)
        throw new Error(
          'Existing objects need reviewed bootstrap capture with --capture-existing and the original deployment storage configuration.',
        );
    }
  }
  const created = await runInPlatformTx(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('storage:bootstrap', 0))`;
    const row = await tx.platformStorageLocation.findUnique({ where: { id: BOOTSTRAP_STORAGE_LOCATION_ID } });
    if (row !== null) {
      let same = row.fingerprint === descriptor.fingerprint;
      try {
        same &&=
          box.open(Buffer.from(row.credentialsEnc), context(row.id)).toString('utf8') ===
          JSON.stringify(credentials);
      } catch {
        same = false;
      }
      if (!same)
        throw new Error(
          'Bootstrap storage is already captured with different configuration or credentials. Retain its original values; do not rebind existing objects.',
        );
      return false;
    }
    await tx.platformStorageLocation.create({
      data: {
        id: BOOTSTRAP_STORAGE_LOCATION_ID,
        ...descriptor,
        credentialsEnc: toBytes(
          box.seal(JSON.stringify(credentials), context(BOOTSTRAP_STORAGE_LOCATION_ID)),
        ),
      },
    });
    await tx.platformAuditLog.create({
      data: {
        action: 'storage.bootstrap_captured',
        entityType: 'storage_location',
        entityId: BOOTSTRAP_STORAGE_LOCATION_ID,
        after: {
          fingerprint: descriptor.fingerprint,
          provider: descriptor.provider,
          credentialsPresent: true,
        },
      },
    });
    return true;
  });
  let backfilledAssets = 0;
  let backfilledExports = 0;
  for (const tenant of tenants) {
    const counts = await runInPlatformTenantTx(prisma, tenant.id, async (tx) => {
      const assets = await tx.asset.updateMany({
        where: {
          storageLocationId: null,
          OR: [{ storageKey: { not: null } }, { derivativeKey: { not: null } }],
        },
        data: { storageLocationId: BOOTSTRAP_STORAGE_LOCATION_ID },
      });
      // Not `exports`: compiled to CommonJS, that name would shadow the module's own exports.
      const exportRows = await tx.dataExport.updateMany({
        where: { storageLocationId: null },
        data: { storageLocationId: BOOTSTRAP_STORAGE_LOCATION_ID },
      });
      if (assets.count + exportRows.count > 0)
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: 'storage.provenance_backfilled',
            entityType: 'storage_location',
            entityId: BOOTSTRAP_STORAGE_LOCATION_ID,
            after: { assets: assets.count, exports: exportRows.count },
          },
        });
      return { assets: assets.count, exports: exportRows.count };
    });
    backfilledAssets += counts.assets;
    backfilledExports += counts.exports;
  }
  return { locationId: BOOTSTRAP_STORAGE_LOCATION_ID, backfilledAssets, backfilledExports, created };
}
