import { Body, Controller, Get, Header, HttpCode, Post, Req, Res } from '@nestjs/common';
import { type SupportSessionInfo, tokenRequestSchema } from '@studyhub/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError, parseOrThrow } from '../../platform';
import { SupportSessionService } from '../application/support-sessions';
import {
  clearCookie,
  clientIp,
  currentActor,
  sessionCookie,
  setCookie,
  SUPPORT_COOKIE,
  userAgent,
} from './http';

/** Support sessions on the school host (F44, 04 §17.12): exchange, banner info, end. */
@Controller('api/v1/support')
export class SupportController {
  constructor(private readonly support: SupportSessionService) {}

  @Post('handoff')
  @HttpCode(200)
  async handoff(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token } = parseOrThrow(tokenRequestSchema, body);
    const session = await this.support.exchange(token, {
      ip: clientIp(request),
      userAgent: userAgent(request),
      host: request.host,
    });
    setCookie(reply, sessionCookie(SUPPORT_COOKIE, session.token, session.maxAgeSeconds));
    return { status: 'SIGNED_IN' };
  }

  @Get('session')
  @Header('Cache-Control', 'private, no-store')
  session(): SupportSessionInfo {
    const support = currentActor()?.support;
    return support === undefined
      ? { active: false, staffName: null, scope: null, expiresAt: null }
      : {
          active: true,
          staffName: support.staffName,
          scope: support.scope,
          expiresAt: support.expiresAt.toISOString(),
        };
  }

  @Post('end')
  @HttpCode(204)
  async end(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const actor = currentActor();
    if (actor?.support === undefined) throw new AppError('UNAUTHENTICATED');
    await this.support.end(actor);
    setCookie(reply, clearCookie(SUPPORT_COOKIE));
  }
}
