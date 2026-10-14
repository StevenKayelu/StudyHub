import type { ApiEnv } from '../config/env.schema';
import { type ObjectStorage, S3ObjectStorage } from './object-storage';
import { ClamdScanner, EicarOnlyScanner, type MalwareScanner } from './scanner';
import { FakeVideoProvider, type VideoProvider } from './video-provider';

/** Injection tokens for the media ports (ADR-008, ADR-009). */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');
export const VIDEO_PROVIDER = Symbol('VIDEO_PROVIDER');

/** Where the fake video provider accepts uploads (same origin as the school; development only). */
export const FAKE_VIDEO_UPLOAD_PATH = '/api/v1/dev/fake-video';

export interface MediaPorts {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  video: VideoProvider;
}

/** Builds the adapters chosen by configuration (development adapters are refused in production). */
export function createMediaPorts(env: ApiEnv): MediaPorts {
  return {
    storage: new S3ObjectStorage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      createBucket: env.S3_CREATE_BUCKET,
    }),
    scanner:
      env.MALWARE_SCANNER === 'clamd'
        ? new ClamdScanner(env.CLAMD_HOST, env.CLAMD_PORT)
        : new EicarOnlyScanner(),
    video: new FakeVideoProvider(env.FAKE_VIDEO_SECRET, FAKE_VIDEO_UPLOAD_PATH),
  };
}
