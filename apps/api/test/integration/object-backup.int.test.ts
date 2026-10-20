import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyDocumentObjectRecovery, planDocumentObjectRecovery } from '../../src/modules/admin';
import {
  EicarOnlyScanner,
  OBJECT_STORAGE,
  type ObjectStorage,
  PrismaService,
  runWithContext,
  S3DocumentBackupStorage,
} from '../../src/modules/platform';
import { type Harness, startHarness } from '../setup/school-harness';
import { ref, seedFixtures } from '../setup/tenant-fixtures';

const liveBucket = 'studyhub-test';
const backupBucket = 'studyhub-backup-test';
const pdf = (label: string) => Buffer.from(('%PDF-1.7\n' + label).padEnd(2048, ' '));
const original = pdf('Original document');
const damaged = pdf('Damaged document');
describe('application-managed backups without native versioning (R2-compatible operations)', () => {
  let h: Harness;
  let prisma: PrismaService;
  let observer: Client;
  let s3: S3Client;
  let backups: S3DocumentBackupStorage;
  let ownerId: string;
  let assetId: string;
  let key: string;
  let backupId: string;
  let betaKey: string;
  const approval = {
    reason: 'Restore approved application-managed snapshot',
    ownerReviewReference: 'fixture-owner-backup-review',
  };
  const asOwner = <T>(fn: () => T) =>
    runWithContext({ requestId: randomUUID(), platformUserId: ownerId }, fn);
  const plan = () =>
    asOwner(() => planDocumentObjectRecovery(prisma, backups, h.tenants.acme, assetId, backupId));
  const apply = (digest: string) =>
    asOwner(() =>
      applyDocumentObjectRecovery(
        prisma,
        backups,
        new EicarOnlyScanner(),
        h.tenants.acme,
        assetId,
        backupId,
        { digest, ...approval },
      ),
    );
  const contentKey = () =>
    `t/${h.tenants.acme}/document-backups/${createHash('sha256').update(key).digest('hex')}/${backupId}/content`;
  const put = (bucket: string, key: string, bytes: Buffer, type = 'application/pdf') =>
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: type }));
  async function get(bucket: string, key: string) {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await result.Body!.transformToByteArray());
  }
  beforeAll(async () => {
    h = await startHarness({ objectStore: true });
    prisma = h.app.get(PrismaService);
    observer = await h.database.connect(h.database.superuserUrl);
    const app = await h.database.connect(h.database.appUrl);
    try {
      await seedFixtures(h.migrator, app, [h.tenants.acme, h.tenants.beta]);
    } finally {
      await app.end();
    }
    ownerId = randomUUID();
    await observer.query(
      `INSERT INTO platform_user (id,email,display_name,role) VALUES ($1,'backup-owner@platform.test','Backup owner','PLATFORM_OWNER')`,
      [ownerId],
    );
    const options = {
      endpoint: h.s3Endpoint!,
      region: 'us-east-1',
      bucket: liveBucket,
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret-object-store',
      forcePathStyle: true,
      createBucket: false,
    };
    s3 = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    await s3.send(new CreateBucketCommand({ Bucket: liveBucket }));
    await s3.send(new CreateBucketCommand({ Bucket: backupBucket }));
    expect((await s3.send(new GetBucketVersioningCommand({ Bucket: liveBucket }))).Status).not.toBe(
      'Enabled',
    );
    expect((await s3.send(new GetBucketVersioningCommand({ Bucket: backupBucket }))).Status).not.toBe(
      'Enabled',
    );
    backups = new S3DocumentBackupStorage(options, { ...options, bucket: backupBucket });
    assetId = ref('asset', h.tenants.acme);
    betaKey = `t/${h.tenants.beta}/lesson_file/beta.pdf`;
    await put(liveBucket, betaKey, pdf('Other school'));
  }, 300_000);
  beforeEach(async () => {
    key = `t/${h.tenants.acme}/lesson_file/${randomUUID()}.pdf`;
    await put(liveBucket, key, original);
    const captured = await backups.capture(h.tenants.acme, key, {
      size: 2048,
      contentType: 'application/pdf',
    });
    backupId = captured.backupId;
    await put(liveBucket, key, damaged);
    await observer.query(
      `UPDATE asset SET storage_key=$2,derivative_key=NULL,kind='DOCUMENT',mime='application/pdf',size_bytes=2048,status='READY' WHERE id=$1`,
      [assetId, key],
    );
  });
  afterAll(async () => {
    backups?.destroy();
    s3?.destroy();
    await observer?.end();
    await h?.close();
  });
  async function protectedSnapshot() {
    const result: Record<string, string> = {};
    const tables = await observer.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    for (const { tablename } of tables.rows) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename)) throw new Error('Unexpected table');
      if (!['asset', 'audit_log', 'platform_audit_log'].includes(tablename))
        result[tablename] = (
          await observer.query(
            `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS hash FROM "${tablename}" t`,
          )
        ).rows[0].hash;
      result[`beta:${tablename}`] = (
        await observer.query(
          `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS hash FROM "${tablename}" t WHERE coalesce(to_jsonb(t)->>'tenant_id',to_jsonb(t)->>'tenant_ref')=$1`,
          [h.tenants.beta],
        )
      ).rows[0].hash;
    }
    return result;
  }
  it('captures, verifies and restores original bytes with native versioning disabled, preserving shared/other-school data', async () => {
    const before = await protectedSnapshot();
    const reviewed = await plan();
    const start = performance.now();
    const restored = await apply(reviewed.reviewDigest);
    const served: Buffer[] = [];
    for await (const chunk of await h.app.get<ObjectStorage>(OBJECT_STORAGE).stream(restored.storageKey))
      served.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(served)).toEqual(original);
    expect(await get(liveBucket, key)).toEqual(damaged);
    expect(await get(backupBucket, contentKey())).toEqual(original);
    expect(await get(liveBucket, betaKey)).toEqual(pdf('Other school'));
    expect(await protectedSnapshot()).toEqual(before);
    expect(
      (
        await observer.query(`SELECT id FROM audit_log WHERE action='asset.recovered' AND tenant_id=$1`, [
          h.tenants.acme,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await observer.query(
          `SELECT id FROM platform_audit_log WHERE action='asset.recovered' AND tenant_ref=$1`,
          [h.tenants.acme],
        )
      ).rowCount,
    ).toBe(1);
    mkdirSync('test-results/recovery', { recursive: true });
    writeFileSync(
      'test-results/recovery/application-backups.json',
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          nativeVersioning: false,
          bytes: 2048,
          validatedMs: performance.now() - start,
          otherSchoolUnchanged: true,
          sharedTablesUnchanged: true,
        },
        null,
        2,
      ),
    );
  });
  it('rediscovers immutable snapshot ids without a database restore or in-memory registry', async () => {
    const next = await backups.capture(h.tenants.acme, key, { size: 2048, contentType: 'application/pdf' });
    const inventory = await backups.list(h.tenants.acme, key);
    expect(inventory.map((saved) => saved.backupId).sort()).toEqual([backupId, next.backupId].sort());
    const old = await backups.inspect(h.tenants.acme, key, backupId);
    expect(await backups.read(h.tenants.acme, key, old, 25 * 1024 * 1024)).toEqual(original);
    expect(await backups.list(h.tenants.acme, `t/${h.tenants.acme}/unknown.pdf`)).toEqual([]);
  });

  it('rejects modified backup content even when its size and content type still match', async () => {
    const reviewed = await plan();
    await put(backupBucket, contentKey(), damaged);
    await expect(apply(reviewed.reviewDigest)).rejects.toThrow('checksum');
    expect(
      (await observer.query('SELECT storage_key FROM asset WHERE id=$1', [assetId])).rows[0].storage_key,
    ).toBe(key);
  });
  it('rejects foreign and substituted manifests without changing any database rows', async () => {
    const before = await protectedSnapshot();
    await expect(backups.inspect(h.tenants.acme, betaKey, backupId)).rejects.toThrow('outside');
    const manifestKey = contentKey().replace(/content$/, 'manifest.json');
    const manifest = JSON.parse((await get(backupBucket, manifestKey)).toString()) as Record<string, unknown>;
    manifest.tenantId = h.tenants.beta;
    await put(backupBucket, manifestKey, Buffer.from(JSON.stringify(manifest)), 'application/json');
    await expect(plan()).rejects.toThrow('another document/school');
    expect(await protectedSnapshot()).toEqual(before);
  });
  it('recovers a physically missing live file from the retained application snapshot', async () => {
    await s3.send(new DeleteObjectCommand({ Bucket: liveBucket, Key: key }));
    const reviewed = await plan();
    const restored = await apply(reviewed.reviewDigest);
    expect(await get(liveBucket, restored.storageKey)).toEqual(original);
  });
  it('refuses incomplete capture or a shared live/backup bucket', async () => {
    await expect(
      backups.capture(h.tenants.acme, key, { size: 100, contentType: 'application/pdf' }),
    ).rejects.toThrow();
    const options = {
      endpoint: h.s3Endpoint!,
      region: 'us-east-1',
      bucket: liveBucket,
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret-object-store',
      forcePathStyle: true,
      createBucket: false,
    };
    expect(() => new S3DocumentBackupStorage(options, options)).toThrow('separate bucket');
  });
});
