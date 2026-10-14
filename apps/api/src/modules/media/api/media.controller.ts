import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { createVideoRequestSchema, uploadRequestSchema } from '@studyhub/contracts';
import type { FastifyRequest } from 'fastify';

import { currentActor, type TenantActor } from '../../identity';
import {
  AppError,
  ConfigService,
  FakeVideoProvider,
  parseOrThrow,
  runWithContext,
  VIDEO_PROVIDER,
  type VideoProvider,
} from '../../platform';
import { MediaService } from '../application/media.service';
import { VideoWebhookService } from '../application/video-webhook.service';

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

/** Media API (05 §4.5). Uploads go browser → object storage; the API only issues slots. */
@Controller('api/v1')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly webhooks: VideoWebhookService,
    private readonly config: ConfigService,
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider,
  ) {}

  @Post('uploads')
  @HttpCode(201)
  createUpload(@Body() body: unknown) {
    return this.media.createUpload(requireActor(), parseOrThrow(uploadRequestSchema, body));
  }

  @Post('uploads/:id/complete')
  @HttpCode(200)
  complete(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.media.completeUpload(requireActor(), id);
  }

  @Post('videos')
  @HttpCode(201)
  createVideo(@Body() body: unknown) {
    return this.media.createVideo(requireActor(), parseOrThrow(createVideoRequestSchema, body));
  }

  @Get('assets/:id')
  @Header('Cache-Control', 'private, no-store')
  status(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.media.status(requireActor(), id);
  }

  @Get('assets/:id/download')
  @Header('Cache-Control', 'private, no-store')
  download(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.media.downloadUrl(requireActor(), id);
  }

  /**
   * Provider webhook (04 §17.9). Not school-scoped: signature first, then resolve_video_asset() gives
   * the school, and the update runs in that school's context. Unknown ids are acknowledged and ignored.
   */
  @Post('webhooks/video/:provider')
  @HttpCode(200)
  async videoWebhook(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ) {
    const raw = request.rawBody ?? Buffer.alloc(0);
    await this.webhooks.handle(
      provider,
      raw,
      request.headers as Record<string, string | string[] | undefined>,
    );
    return { received: true };
  }

  /**
   * DEVELOPMENT ONLY (fake provider): accepts the browser's upload, discards the bytes and reports the
   * video as transcoded through a signed webhook, as a real provider would.
   */
  @Put('dev/fake-video/:providerVideoId')
  @HttpCode(200)
  async fakeVideoUpload(@Param('providerVideoId') providerVideoId: string, @Req() request: FastifyRequest) {
    if (this.config.get('NODE_ENV') === 'production' || !(this.video instanceof FakeVideoProvider)) {
      throw new AppError('NOT_FOUND');
    }
    requireActor();
    const body = Buffer.from(JSON.stringify({ providerVideoId, status: 'READY', durationSeconds: 60 }));
    const signature = this.video.sign(body);
    // The provider's callback carries no school context of its own.
    await runWithContext({ requestId: request.id }, () =>
      this.webhooks.handle(this.video.name, body, { 'x-fake-video-signature': signature }),
    );
    return { status: 'uploaded' };
  }
}
