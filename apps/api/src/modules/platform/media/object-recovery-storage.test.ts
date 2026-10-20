import { Readable } from 'node:stream';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { S3VersionRecoveryStorage, type RecoveryObjectVersion } from './object-recovery-storage';

const tenant = '00000000-0000-4000-8000-000000000001';
const key = `t/${tenant}/lesson_file/example.pdf`;
const version: RecoveryObjectVersion = {
  versionId: 'fixture-version',
  etag: 'fixture-etag',
  size: 4,
  contentType: 'application/pdf',
};
const options = {
  endpoint: 'http://127.0.0.1:1',
  region: 'us-east-1',
  bucket: 'fixture-bucket',
  accessKeyId: 'fixture-access',
  secretAccessKey: 'fixture-secret',
  forcePathStyle: true,
  createBucket: false,
};
afterEach(() => vi.restoreAllMocks());

describe('native-version recovery storage fails closed', () => {
  it('rejects disabled/unsupported versioning without reading an object', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ Status: 'Suspended' } as never);
    const storage = new S3VersionRecoveryStorage(options);
    try {
      await expect(storage.inspect(tenant, key, version.versionId)).rejects.toThrow('unavailable');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      storage.destroy();
    }
  });
  it('rejects providers that ignore the selected VersionId instead of recovering latest bytes', async () => {
    vi.spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ Status: 'Enabled' } as never)
      .mockResolvedValueOnce({
        VersionId: 'other-version',
        ETag: version.etag,
        ContentLength: 4,
        ContentType: version.contentType,
      } as never);
    const storage = new S3VersionRecoveryStorage(options);
    try {
      await expect(storage.inspect(tenant, key, version.versionId)).rejects.toThrow(
        'selected immutable version',
      );
    } finally {
      storage.destroy();
    }
  });
  it('rejects foreign, traversal and null-version requests before provider access', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const storage = new S3VersionRecoveryStorage(options);
    try {
      for (const objectKey of ['t/other-school/file', `t/${tenant}/../file`, `t/${tenant}/x\\file`])
        await expect(storage.inspect(tenant, objectKey, version.versionId)).rejects.toThrow();
      await expect(storage.inspect(tenant, key, 'null')).rejects.toThrow('immutable');
      expect(send).not.toHaveBeenCalled();
    } finally {
      storage.destroy();
    }
  });
  it.each([3, 5])('rejects incomplete/oversized body (%i bytes) and closes the stream', async (size) => {
    const body = Readable.from([Buffer.alloc(size)]);
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({
      Body: body,
      VersionId: version.versionId,
      ETag: version.etag,
      ContentType: version.contentType,
      ContentLength: 4,
    } as never);
    const storage = new S3VersionRecoveryStorage(options);
    try {
      await expect(storage.read(tenant, key, version, 4)).rejects.toThrow();
      expect(body.destroyed).toBe(true);
    } finally {
      storage.destroy();
    }
  });
  it('rejects changed metadata and closes the stream', async () => {
    const body = Readable.from([Buffer.alloc(4)]);
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({
      Body: body,
      VersionId: version.versionId,
      ETag: 'changed',
      ContentType: version.contentType,
      ContentLength: 4,
    } as never);
    const storage = new S3VersionRecoveryStorage(options);
    try {
      await expect(storage.read(tenant, key, version, 4)).rejects.toThrow('metadata changed');
      expect(body.destroyed).toBe(true);
    } finally {
      storage.destroy();
    }
  });
  it('stages only to fresh school keys with a conditional create, never overwriting source keys', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const storage = new S3VersionRecoveryStorage(options);
    try {
      const first = await storage.stage(tenant, Buffer.from('test'), 'application/pdf');
      const second = await storage.stage(tenant, Buffer.from('test'), 'application/pdf');
      expect(first).toMatch(new RegExp(`^t/${tenant}/recovery/`));
      expect(second).not.toBe(first);
      expect(send.mock.calls[0]![0]).toBeInstanceOf(PutObjectCommand);
      expect((send.mock.calls[0]![0] as PutObjectCommand).input).toMatchObject({
        Key: first,
        IfNoneMatch: '*',
      });
    } finally {
      storage.destroy();
    }
  });
});
