import { Module } from '@nestjs/common';

import { MediaController } from './api/media.controller';
import { MediaService } from './application/media.service';
import { VideoWebhookService } from './application/video-webhook.service';

/** Uploads, videos and their webhooks (F11; M5). */
@Module({
  controllers: [MediaController],
  providers: [MediaService, VideoWebhookService],
  exports: [MediaService],
})
export class MediaModule {}
