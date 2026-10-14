import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Managed video behind a port (ADR-009): the provider stores and transcodes; the browser uploads to it
 * directly; a signed webhook reports the result. Until a provider is chosen and approved, only the fake
 * adapter exists (no real credentials anywhere, as for payments).
 */
export interface VideoUpload {
  providerVideoId: string;
  /** Where the browser sends the file (a resumable/direct upload URL at the provider). */
  uploadUrl: string;
}

export interface VideoEvent {
  providerVideoId: string;
  status: 'READY' | 'FAILED';
  durationSeconds?: number;
  reason?: string;
}

/** How the player plays a READY video (a signed, short-lived URL at the provider). */
export interface VideoPlayback {
  /** `simulated`: the fake provider keeps no bytes; the player simulates playback for development. */
  kind: 'hls' | 'mp4' | 'simulated';
  url: string | null;
}

export interface VideoProvider {
  /** Name used in webhook paths and stored on the asset (`asset.provider`). */
  readonly name: string;
  createUpload(input: { tenantId: string; assetId: string; maxBytes: number }): Promise<VideoUpload>;
  /** Verifies the signature over the RAW body and parses the event; null when the signature is wrong. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): VideoEvent | null;
  /** A playback URL for one viewer, valid for `expiresSeconds`. */
  playback(providerVideoId: string, options: { expiresSeconds: number }): Promise<VideoPlayback>;
}

/** Signature header of the fake provider: hex HMAC-SHA256 of the raw body. */
export const FAKE_VIDEO_SIGNATURE_HEADER = 'x-fake-video-signature';

/**
 * DEVELOPMENT AND TESTS ONLY. Accepts any upload at a local URL and lets tests (or the dev upload
 * endpoint) send signed "transcoded" webhooks. Refused in production by configuration.
 */
export class FakeVideoProvider implements VideoProvider {
  readonly name = 'fake';

  constructor(
    private readonly secret: string,
    private readonly uploadBaseUrl: string,
  ) {}

  createUpload(_input: { tenantId: string; assetId: string; maxBytes: number }): Promise<VideoUpload> {
    const providerVideoId = `fake_${randomUUID()}`;
    return Promise.resolve({ providerVideoId, uploadUrl: `${this.uploadBaseUrl}/${providerVideoId}` });
  }

  playback(_providerVideoId: string, _options: { expiresSeconds: number }): Promise<VideoPlayback> {
    return Promise.resolve({ kind: 'simulated', url: null });
  }

  sign(rawBody: Buffer | string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): VideoEvent | null {
    const header = headers[FAKE_VIDEO_SIGNATURE_HEADER];
    const given = Buffer.from(typeof header === 'string' ? header : '', 'hex');
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const body = JSON.parse(rawBody.toString('utf8')) as Partial<VideoEvent>;
    if (typeof body.providerVideoId !== 'string' || (body.status !== 'READY' && body.status !== 'FAILED'))
      return null;
    return {
      providerVideoId: body.providerVideoId,
      status: body.status,
      ...(typeof body.durationSeconds === 'number' && {
        durationSeconds: Math.max(0, Math.round(body.durationSeconds)),
      }),
      ...(typeof body.reason === 'string' && { reason: body.reason.slice(0, 200) }),
    };
  }
}
