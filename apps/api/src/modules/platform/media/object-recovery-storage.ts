import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

import type { S3StorageOptions } from './object-storage';

export interface RecoveryObjectVersion {
  versionId: string;
  etag: string;
  size: number;
  contentType: string;
}

/** Optional immutable-history recovery port, separate from normal storage. No delete operation.
 * Implementations may use native versions or application-managed snapshots (the R2 path).
 */
export interface VersionRecoveryStorage {
  /**
   * The storage location (platform_storage_location) these credentials open. Recovery refuses a document
   * recorded at another location, so a restored key never points into the wrong bucket (M10 review).
   */
  readonly locationId: string;
  inspect(tenantId: string, key: string, versionId: string): Promise<RecoveryObjectVersion>;
  read(tenantId: string, key: string, version: RecoveryObjectVersion, maximumBytes: number): Promise<Buffer>;
  stage(tenantId: string, bytes: Buffer, contentType: string): Promise<string>;
}

function scopedKey(tenantId: string, key: string): void {
  z.uuid().parse(tenantId);
  if (
    !key.startsWith(`t/${tenantId}/`) ||
    key.includes('\\') ||
    key.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error('Recovery object belongs to another school or has an unsafe key');
  }
}
function versionId(value: string): void {
  if (!value || value === 'null' || value.length > 1024)
    throw new Error('An immutable object version is required');
}

export class S3VersionRecoveryStorage implements VersionRecoveryStorage {
  private readonly client: S3Client;
  constructor(
    private readonly options: S3StorageOptions,
    readonly locationId: string,
  ) {
    z.uuid().parse(locationId);
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  destroy(): void {
    this.client.destroy();
  }

  async inspect(tenantId: string, key: string, selectedVersion: string): Promise<RecoveryObjectVersion> {
    scopedKey(tenantId, key);
    versionId(selectedVersion);
    const bucket = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.options.bucket }));
    if (bucket.Status !== 'Enabled')
      throw new Error('Native version recovery is unavailable for this bucket');
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: key, VersionId: selectedVersion }),
    );
    if (
      head.VersionId !== selectedVersion ||
      !head.ETag ||
      !head.ContentType ||
      head.ContentLength === undefined
    ) {
      throw new Error('Storage did not identify the selected immutable version');
    }
    return {
      versionId: selectedVersion,
      etag: head.ETag,
      contentType: head.ContentType,
      size: head.ContentLength,
    };
  }

  async read(
    tenantId: string,
    key: string,
    version: RecoveryObjectVersion,
    maximumBytes: number,
  ): Promise<Buffer> {
    scopedKey(tenantId, key);
    versionId(version.versionId);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || version.size > maximumBytes)
      throw new Error('Recovery object exceeds the byte limit');
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key, VersionId: version.versionId }),
    );
    const body = result.Body as Readable | undefined;
    if (!body) throw new Error('Recovery version has no body');
    try {
      if (
        result.VersionId !== version.versionId ||
        result.ETag !== version.etag ||
        result.ContentType !== version.contentType ||
        result.ContentLength !== version.size
      ) {
        throw new Error('Recovery version metadata changed');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > maximumBytes || size > version.size)
          throw new Error('Recovery object exceeds the byte limit');
        chunks.push(bytes);
      }
      if (size !== version.size) throw new Error('Recovery object is incomplete');
      return Buffer.concat(chunks);
    } finally {
      body.destroy();
    }
  }

  async stage(tenantId: string, bytes: Buffer, contentType: string): Promise<string> {
    z.uuid().parse(tenantId);
    const key = `t/${tenantId}/recovery/${randomUUID()}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        IfNoneMatch: '*',
      }),
    );
    return key;
  }
}
