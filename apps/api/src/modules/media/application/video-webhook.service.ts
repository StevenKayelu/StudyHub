import { Inject, Injectable } from '@nestjs/common';

import {
  APP_LOGGER,
  AppError,
  currentContext,
  PrismaService,
  runWithContext,
  VIDEO_PROVIDER,
  type VideoProvider,
} from '../../platform';
import type { Logger } from 'pino';
import { MediaService } from './media.service';

/**
 * Video provider webhooks (04 §17.9, M5 AC 5). The provider calls a shared endpoint with its own video
 * id. Order: verify the signature over the raw body → resolve_video_asset() (definer: returns only the
 * asset id and its school) → apply the event inside that school's tenant context. An unknown id is
 * logged and acknowledged; no school's data is read or written.
 */
@Injectable()
export class VideoWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Inject(VIDEO_PROVIDER) private readonly provider: VideoProvider,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  async handle(
    providerName: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ) {
    if (providerName !== this.provider.name) throw new AppError('NOT_FOUND');
    const event = this.provider.parseWebhook(rawBody, headers);
    if (event === null) {
      this.logger.warn({ provider: providerName }, 'Video webhook with an invalid signature');
      throw new AppError('FORBIDDEN', { detail: 'Invalid signature.' });
    }
    const rows = await this.prisma.$queryRaw<{ asset_id: string; tenant_id: string }[]>`
      SELECT asset_id, tenant_id FROM resolve_video_asset(${providerName}, ${event.providerVideoId})`;
    const target = rows[0];
    if (target === undefined) {
      this.logger.warn({ provider: providerName }, 'Video webhook for an unknown video; ignored');
      return;
    }
    await runWithContext(
      {
        requestId: currentContext()?.requestId ?? `webhook_${event.providerVideoId}`,
        tenantId: target.tenant_id,
      },
      () => this.media.applyVideoEvent(target.asset_id, event),
    );
  }
}
