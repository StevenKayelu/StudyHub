import type { Readable } from 'node:stream';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage port (ADR-008): direct-to-storage uploads with presigned URLs; the API never streams
 * uploads. Objects are private; downloads use short-lived presigned GET URLs. Keys always start with
 * `t/{tenantId}/` (enforced by a CHECK constraint on asset.storage_key).
 */
export interface ObjectStorage {
  /** A URL the browser PUTs the file to, valid for `expiresSeconds`, bound to type and length. */
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresSeconds: number },
  ): Promise<string>;
  /** A short-lived download URL. */
  presignGet(key: string, options: { expiresSeconds: number; downloadName?: string }): Promise<string>;
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** The first `length` bytes (magic-number check). */
  readStart(key: string, length: number): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Deletes every object under a prefix (offboarding purge, F46); returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>;
}

export interface S3StorageOptions {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (local SeaweedFS, MinIO); R2 and S3 work either way. */
  forcePathStyle: boolean;
  /** Development only: create the bucket on first use. */
  createBucket: boolean;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private bucketReady: Promise<void> | null = null;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint !== undefined && { endpoint: options.endpoint }),
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Presigned PUTs must not require a checksum header the browser doesn't send.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private ready(): Promise<void> {
    if (!this.options.createBucket) return Promise.resolve();
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.options.bucket }));
      }
    })().catch((error: unknown) => {
      this.bucketReady = null;
      throw error;
    });
    return this.bucketReady;
  }

  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresSeconds: number },
  ) {
    await this.ready();
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
      }),
      { expiresIn: options.expiresSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  async presignGet(key: string, options: { expiresSeconds: number; downloadName?: string }) {
    await this.ready();
    const disposition =
      options.downloadName === undefined
        ? undefined
        : `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ...(disposition !== undefined && { ResponseContentDisposition: disposition }),
      }),
      { expiresIn: options.expiresSeconds },
    );
  }

  async head(key: string) {
    await this.ready();
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { size: Number(result.ContentLength ?? 0), contentType: result.ContentType ?? null };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  async readStart(key: string, length: number): Promise<Buffer> {
    await this.ready();
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key, Range: `bytes=0-${length - 1}` }),
    );
    return Buffer.from(await result.Body!.transformToByteArray());
  }

  async stream(key: string): Promise<Readable> {
    await this.ready();
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    return result.Body as Readable;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ready();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.ready();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!/^t\/[0-9a-f-]{36}\/$/.test(prefix))
      throw new Error('deletePrefix only removes a school prefix t/{tenantId}/');
    await this.ready();
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (keys.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.options.bucket, Delete: { Objects: keys } }),
        );
        if ((result.Errors?.length ?? 0) > 0)
          throw new Error('Storage cleanup was incomplete. Retry before purging school records.');
        deleted += keys.length;
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return deleted;
  }
}
