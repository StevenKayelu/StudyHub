import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
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
  type MalwareScanner,
  PrismaService,
  runWithContext,
  S3VersionRecoveryStorage,
} from '../../src/modules/platform';
import { type Harness, startHarness } from '../setup/school-harness';
import { ref, seedFixtures } from '../setup/tenant-fixtures';

const bucket = 'studyhub-test';
const pdf = (label: string) => Buffer.from(('%PDF-1.7\n' + label).padEnd(2048, ' '));
const oldBytes = pdf('Original lesson file');
const damagedBytes = pdf('Damaged lesson file');

describe('school-scoped native-version document recovery (M10)', () => {
  let h: Harness;
  let prisma: PrismaService;
  let observer: Client;
  let s3: S3Client;
  let recovery: S3VersionRecoveryStorage;
  let ownerId: string;
  let sourceKey: string;
  let selectedVersion: string;
  let betaKey: string;
  let betaVersion: string;
  let assetId: string;
  const approval = {
    reason: 'Restore externally reviewed lesson PDF',
    ownerReviewReference: 'disposable-file-review-001',
  };
  const asOwner = <T>(fn: () => T) =>
    runWithContext({ requestId: `object-recovery-${randomUUID()}`, platformUserId: ownerId }, fn);
  const plan = (version = selectedVersion, id = assetId) =>
    asOwner(() => planDocumentObjectRecovery(prisma, recovery, h.tenants.acme, id, version));
  const apply = (digest: string, scanner: MalwareScanner = new EicarOnlyScanner()) =>
    asOwner(() =>
      applyDocumentObjectRecovery(prisma, recovery, scanner, h.tenants.acme, assetId, selectedVersion, {
        digest,
        ...approval,
      }),
    );
  async function put(key: string, bytes: Buffer): Promise<string> {
    const result = await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/pdf' }),
    );
    expect(result.VersionId).toBeTruthy();
    expect(result.VersionId).not.toBe('null');
    return result.VersionId!;
  }
  async function bytesAt(key: string, version?: string): Promise<Buffer> {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ...(version ? { VersionId: version } : {}) }),
    );
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
      `INSERT INTO platform_user (id,email,display_name,role) VALUES ($1,'file-recovery@platform.test','File recovery owner','PLATFORM_OWNER')`,
      [ownerId],
    );
    const options = {
      endpoint: h.s3Endpoint!,
      region: 'us-east-1',
      bucket,
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
    recovery = new S3VersionRecoveryStorage(options);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(
      new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }),
    );
    assetId = ref('asset', h.tenants.acme);
    betaKey = `t/${h.tenants.beta}/lesson_file/other-school.pdf`;
    betaVersion = await put(betaKey, pdf('Other school file'));
  }, 300_000);
  beforeEach(async () => {
    sourceKey = `t/${h.tenants.acme}/lesson_file/${randomUUID()}.pdf`;
    selectedVersion = await put(sourceKey, oldBytes);
    await put(sourceKey, damagedBytes);
    await observer.query(
      `UPDATE asset SET storage_key=$2, derivative_key=NULL, kind='DOCUMENT', mime='application/pdf',size_bytes=2048,status='READY' WHERE id=$1`,
      [assetId, sourceKey],
    );
  });
  afterAll(async () => {
    s3?.destroy();
    recovery?.destroy();
    await observer?.end();
    await h?.close();
  });

  async function snapshot(): Promise<Record<string, string>> {
    const { rows } = await observer.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    const result: Record<string, string> = {};
    for (const { tablename } of rows) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename)) throw new Error('Unexpected table');
      result[tablename] = (
        await observer.query<{ hash: string }>(
          `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS hash FROM "${tablename}" t`,
        )
      ).rows[0]!.hash;
      result[`beta:${tablename}`] = (
        await observer.query<{ hash: string }>(
          `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS hash FROM "${tablename}" t WHERE coalesce(to_jsonb(t)->>'tenant_id',to_jsonb(t)->>'tenant_ref')=$1`,
          [h.tenants.beta],
        )
      ).rows[0]!.hash;
    }
    return result;
  }

  it('recovers selected immutable bytes to a fresh school key with atomic pointer/audits, preserving both original versions and other-school data', async () => {
    const before = await snapshot();
    const reviewed = await plan();
    expect(await snapshot()).toEqual(before);
    const start = performance.now();
    const restored = await apply(reviewed.reviewDigest);
    expect(await bytesAt(restored.storageKey)).toEqual(oldBytes);
    const served: Buffer[] = [];
    for await (const chunk of await h.app.get<ObjectStorage>(OBJECT_STORAGE).stream(restored.storageKey))
      served.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(served)).toEqual(oldBytes);
    expect(await bytesAt(sourceKey, selectedVersion)).toEqual(oldBytes);
    expect(await bytesAt(sourceKey)).toEqual(damagedBytes);
    expect(await bytesAt(betaKey)).toEqual(pdf('Other school file'));
    expect((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: betaKey }))).VersionId).toBe(
      betaVersion,
    );
    const after = await snapshot();
    for (const [table, hash] of Object.entries(before))
      if (!['asset', 'audit_log', 'platform_audit_log'].includes(table))
        expect(after[table], table).toBe(hash);
    expect(
      (await observer.query('SELECT storage_key,checksum_sha256 FROM asset WHERE id=$1', [assetId])).rows[0],
    ).toEqual({ storage_key: restored.storageKey, checksum_sha256: restored.checksumSha256 });
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
      'test-results/recovery/objects.json',
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          scope: reviewed.scope,
          bytes: oldBytes.length,
          validatedMs: performance.now() - start,
          protectedTables: Object.keys(before).filter((name) => !name.startsWith('beta:')).length - 3,
          otherSchoolUnchanged: true,
          originalVersionsRetained: true,
        },
        null,
        2,
      ),
    );
  });

  it('refuses a foreign asset or key, null/nonexistent versions and stale database review', async () => {
    const before = await snapshot();
    await expect(plan(selectedVersion, ref('asset', h.tenants.beta))).rejects.toThrow();
    await expect(recovery.inspect(h.tenants.acme, betaKey, betaVersion)).rejects.toThrow('another school');
    await expect(plan('null')).rejects.toThrow('immutable');
    await expect(plan('nonexistent-version')).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const reviewed = await plan();
    await observer.query(`UPDATE asset SET original_name='Newer file metadata.pdf' WHERE id=$1`, [assetId]);
    const changed = await snapshot();
    await expect(apply(reviewed.reviewDigest)).rejects.toThrow('stale');
    expect(await snapshot()).toEqual(changed);
  });

  it('rejects mismatched file type/size and malware without changing the asset pointer', async () => {
    const malformed = await put(sourceKey, Buffer.alloc(2048, 'x'));
    const selected = await plan(malformed);
    const before = await snapshot();
    await expect(
      asOwner(() =>
        applyDocumentObjectRecovery(
          prisma,
          recovery,
          new EicarOnlyScanner(),
          h.tenants.acme,
          assetId,
          malformed,
          { digest: selected.reviewDigest, ...approval },
        ),
      ),
    ).rejects.toThrow('type/size');
    expect(await snapshot()).toEqual(before);
    const mismatch = await put(sourceKey, pdf('different size').subarray(0, 100));
    await expect(plan(mismatch)).rejects.toThrow('size/type');
    const reviewed = await plan();
    await expect(
      apply(reviewed.reviewDigest, {
        name: 'rejecting-fixture',
        scan: async () => ({ clean: false, signature: 'fixture-test' }),
      }),
    ).rejects.toThrow('malware');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back the asset pointer and school audit if platform audit fails, retaining original bytes', async () => {
    const reviewed = await plan();
    const before = await snapshot();
    const prefix = `t/${h.tenants.acme}/recovery/`;
    const candidatesBefore = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    await observer.query('REVOKE INSERT ON platform_audit_log FROM studyhub_app');
    try {
      await expect(apply(reviewed.reviewDigest)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await observer.query('GRANT INSERT ON platform_audit_log TO studyhub_app');
    }
    expect(await bytesAt(sourceKey)).toEqual(damagedBytes);
    expect(await bytesAt(sourceKey, selectedVersion)).toEqual(oldBytes);
    const candidatesAfter = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    expect(candidatesAfter.Contents?.length).toBe((candidatesBefore.Contents?.length ?? 0) + 1);
  });

  it('keeps a newer database change if the target changes during staging and denies ordinary school sessions', async () => {
    await expect(
      runWithContext({ requestId: 'school-recovery-denial', userId: ownerId }, () =>
        planDocumentObjectRecovery(prisma, recovery, h.tenants.acme, assetId, selectedVersion),
      ),
    ).rejects.toThrow();
    const reviewed = await plan();
    const staged = {
      inspect: recovery.inspect.bind(recovery),
      read: recovery.read.bind(recovery),
      stage: async (tenantId: string, bytes: Buffer, contentType: string) => {
        const key = await recovery.stage(tenantId, bytes, contentType);
        await observer.query(`UPDATE asset SET original_name='Newer concurrent edit.pdf' WHERE id=$1`, [
          assetId,
        ]);
        return key;
      },
    };
    const countBefore = (
      await observer.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='asset.recovered'`)
    ).rows[0].n;
    await expect(
      asOwner(() =>
        applyDocumentObjectRecovery(
          prisma,
          staged,
          new EicarOnlyScanner(),
          h.tenants.acme,
          assetId,
          selectedVersion,
          { digest: reviewed.reviewDigest, ...approval },
        ),
      ),
    ).rejects.toThrow('changed while preparing');
    expect(
      (await observer.query('SELECT storage_key,original_name FROM asset WHERE id=$1', [assetId])).rows[0],
    ).toEqual({ storage_key: sourceKey, original_name: 'Newer concurrent edit.pdf' });
    expect(
      (await observer.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='asset.recovered'`))
        .rows[0].n,
    ).toBe(countBefore);
  });
});
