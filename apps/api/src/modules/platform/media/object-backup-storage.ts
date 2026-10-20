import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

import type { RecoveryObjectVersion, VersionRecoveryStorage } from './object-recovery-storage';
import type { S3StorageOptions } from './object-storage';

const LIMIT = 25 * 1024 * 1024;
const manifestSchema = z
  .object({
    format: z.literal('studyhub-document-backup-v1'),
    tenantId: z.uuid(),
    backupId: z.uuid(),
    sourceKey: z.string().min(1),
    createdAt: z.iso.datetime(),
    size: z.number().int().min(1).max(LIMIT),
    contentType: z.string().min(1),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;

function client(options: S3StorageOptions): S3Client {
  return new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
function scope(tenantId: string, key: string): void {
  z.uuid().parse(tenantId);
  if (
    !key.startsWith(`t/${tenantId}/`) ||
    key.includes('\\') ||
    key.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Backup key is outside the selected school');
}
async function buffer(body: Readable | undefined, maximum: number): Promise<Buffer> {
  if (!body) throw new Error('Backup object body missing');
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      const part = Buffer.from(chunk as Uint8Array);
      bytes += part.length;
      if (bytes > maximum) throw new Error('Backup object exceeds byte limit');
      chunks.push(part);
    }
    return Buffer.concat(chunks);
  } finally {
    body.destroy();
  }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** R2-compatible, application-managed immutable snapshots. Buckets/permissions are provisioned
 * externally; this adapter never enables native versions, overwrites objects or deletes backups.
 * A backup id is an application UUID, NOT an S3 VersionId. The backup bucket may use a separate
 * account and credentials; the live runtime writer must not have backup deletion/overwrite rights.
 */
export class S3DocumentBackupStorage implements VersionRecoveryStorage {
  private readonly live: S3Client;
  private readonly backup: S3Client;
  constructor(
    private readonly liveOptions: S3StorageOptions,
    private readonly backupOptions: S3StorageOptions,
  ) {
    if (liveOptions.bucket === backupOptions.bucket && liveOptions.endpoint === backupOptions.endpoint)
      throw new Error('Backups require a separate bucket');
    this.live = client(liveOptions);
    this.backup = client(backupOptions);
  }
  destroy(): void {
    this.live.destroy();
    this.backup.destroy();
  }
  private prefix(tenantId: string, key: string, id: string): string {
    scope(tenantId, key);
    z.uuid().parse(id);
    return `t/${tenantId}/document-backups/${sha(Buffer.from(key))}/${id}`;
  }

  /** Explicit capture, after a document is verified. Caller records the returned id in the recovery
   * inventory. No background capture/retention policy or production setting is implied here.
   */
  async capture(
    tenantId: string,
    key: string,
    expected: { size: number; contentType: string },
  ): Promise<{ backupId: string; checksumSha256: string }> {
    scope(tenantId, key);
    if (!Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > LIMIT)
      throw new Error('Unsupported backup size');
    const response = await this.live.send(
      new GetObjectCommand({ Bucket: this.liveOptions.bucket, Key: key }),
    );
    const bytes = await buffer(response.Body as Readable | undefined, expected.size);
    if (
      bytes.length !== expected.size ||
      response.ContentLength !== expected.size ||
      response.ContentType !== expected.contentType
    )
      throw new Error('Live document changed before backup');
    const backupId = randomUUID();
    const prefix = this.prefix(tenantId, key, backupId);
    const manifest: Manifest = {
      format: 'studyhub-document-backup-v1',
      tenantId,
      backupId,
      sourceKey: key,
      createdAt: new Date().toISOString(),
      size: bytes.length,
      contentType: expected.contentType,
      checksumSha256: sha(bytes),
    };
    await this.backup.send(
      new PutObjectCommand({
        Bucket: this.backupOptions.bucket,
        Key: `${prefix}/content`,
        Body: bytes,
        ContentType: manifest.contentType,
        IfNoneMatch: '*',
      }),
    );
    // Publish the manifest only after content is stored. A failed manifest write leaves an
    // unreferenced object; it never advertises an incomplete snapshot as recoverable.
    await this.backup.send(
      new PutObjectCommand({
        Bucket: this.backupOptions.bucket,
        Key: `${prefix}/manifest.json`,
        Body: JSON.stringify(manifest),
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }),
    );
    return { backupId, checksumSha256: manifest.checksumSha256 };
  }

  private async manifest(tenantId: string, key: string, id: string): Promise<Manifest> {
    const prefix = this.prefix(tenantId, key, id);
    const response = await this.backup.send(
      new GetObjectCommand({ Bucket: this.backupOptions.bucket, Key: `${prefix}/manifest.json` }),
    );
    const data = manifestSchema.parse(
      JSON.parse((await buffer(response.Body as Readable | undefined, 16 * 1024)).toString('utf8')),
    );
    if (data.tenantId !== tenantId || data.sourceKey !== key || data.backupId !== id)
      throw new Error('Backup manifest belongs to another document/school');
    return data;
  }
  /** Inventory can be rediscovered after restart without rolling back shared database state. */
  async list(
    tenantId: string,
    key: string,
  ): Promise<Array<{ backupId: string; createdAt: string; size: number; checksumSha256: string }>> {
    scope(tenantId, key);
    const prefix = `t/${tenantId}/document-backups/${sha(Buffer.from(key))}/`;
    const result: Array<{ backupId: string; createdAt: string; size: number; checksumSha256: string }> = [];
    let token: string | undefined;
    do {
      const page = await this.backup.send(
        new ListObjectsV2Command({
          Bucket: this.backupOptions.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const entry of page.Contents ?? []) {
        const suffix = entry.Key?.slice(prefix.length);
        if (!suffix?.endsWith('/manifest.json')) continue;
        const id = suffix.slice(0, -'/manifest.json'.length);
        z.uuid().parse(id);
        const saved = await this.manifest(tenantId, key, id);
        result.push({
          backupId: id,
          createdAt: saved.createdAt,
          size: saved.size,
          checksumSha256: saved.checksumSha256,
        });
        if (result.length > 10000) throw new Error('Backup inventory exceeds review limit');
      }
      if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token))
        throw new Error('Invalid backup inventory pagination');
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async inspect(tenantId: string, key: string, id: string): Promise<RecoveryObjectVersion> {
    const saved = await this.manifest(tenantId, key, id);
    const head = await this.backup.send(
      new HeadObjectCommand({
        Bucket: this.backupOptions.bucket,
        Key: `${this.prefix(tenantId, key, id)}/content`,
      }),
    );
    if (head.ContentLength !== saved.size || head.ContentType !== saved.contentType)
      throw new Error('Backup content metadata differs from manifest');
    // SHA-256 is the logical immutable identity; do not rely on multipart/server ETag semantics.
    return { versionId: id, etag: saved.checksumSha256, size: saved.size, contentType: saved.contentType };
  }
  async read(
    tenantId: string,
    key: string,
    version: RecoveryObjectVersion,
    maximum: number,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > LIMIT)
      throw new Error('Unsupported backup read limit');
    const saved = await this.manifest(tenantId, key, version.versionId);
    if (
      saved.size > maximum ||
      saved.size !== version.size ||
      saved.contentType !== version.contentType ||
      saved.checksumSha256 !== version.etag
    )
      throw new Error('Reviewed backup metadata changed');
    const response = await this.backup.send(
      new GetObjectCommand({
        Bucket: this.backupOptions.bucket,
        Key: `${this.prefix(tenantId, key, saved.backupId)}/content`,
      }),
    );
    const bytes = await buffer(response.Body as Readable | undefined, maximum);
    if (bytes.length !== saved.size || sha(bytes) !== saved.checksumSha256)
      throw new Error('Backup checksum/length verification failed');
    return bytes;
  }
  async stage(tenantId: string, bytes: Buffer, contentType: string): Promise<string> {
    z.uuid().parse(tenantId);
    if (bytes.length < 1 || bytes.length > LIMIT) throw new Error('Unsupported recovery staging size');
    const key = `t/${tenantId}/recovery/${randomUUID()}`;
    await this.live.send(
      new PutObjectCommand({
        Bucket: this.liveOptions.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        IfNoneMatch: '*',
      }),
    );
    return key;
  }
}
