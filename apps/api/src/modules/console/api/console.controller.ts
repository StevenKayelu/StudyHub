import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  type ConsoleMeResponse,
  signInRequestSchema,
  type StaffListResponse,
  totpCodeRequestSchema,
} from '@studyhub/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  clearCookie,
  clientIp,
  CONSOLE_API_PREFIX,
  CONSOLE_COOKIE,
  parseCookies,
  sessionCookie,
  setCookie,
  userAgent,
} from '../../identity';
import { AppError, currentContext, parseOrThrow, type RequestContext, sendProblem } from '../../platform';
import { normalizeHost } from '../../tenancy';
import {
  CONSOLE_ABSOLUTE_MS,
  type ConsoleActor,
  ConsoleAuthService,
  REAUTH_VALID_MS,
} from '../application/console-auth.service';

const actors = new WeakMap<RequestContext, ConsoleActor>();

function consoleActor(): ConsoleActor | null {
  const context = currentContext();
  return context === undefined ? null : (actors.get(context) ?? null);
}

/** A console session that has passed TOTP. */
function requireStaff(): ConsoleActor {
  const actor = consoleActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  if (!actor.mfaVerified) throw new AppError('MFA_REQUIRED');
  return actor;
}

/** A password-only (partial) session: may enrol or verify the second factor, nothing else. */
function requirePartial(): ConsoleActor {
  const actor = consoleActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

/** Sensitive actions need a TOTP re-authentication within REAUTH_VALID_MS (04 §17.5). */
function requireRecentReauth(actor: ConsoleActor): void {
  if (actor.reauthAt === null || Date.now() - actor.reauthAt.getTime() > REAUTH_VALID_MS) {
    throw new AppError('REAUTH_REQUIRED');
  }
}

function requireRole(actor: ConsoleActor, ...roles: ConsoleActor['role'][]): void {
  if (!roles.includes(actor.role)) throw new AppError('FORBIDDEN');
}

/**
 * Console realm guard: /console/* answers ONLY on a console host (anything else is a plain 404, so a
 * school host can't reach the console API), and resolves the console cookie into the staff actor.
 */
export function registerConsoleHook(
  instance: FastifyInstance,
  service: ConsoleAuthService,
  consoleHosts: readonly string[],
): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(CONSOLE_API_PREFIX)) return undefined;
    const host = normalizeHost(request.host);
    if (host === null || !consoleHosts.includes(host)) return sendProblem(reply, request.id, 'NOT_FOUND');
    const token = parseCookies(request.headers.cookie).get(CONSOLE_COOKIE);
    if (token === undefined || token === '') return undefined;
    const actor = await service.authenticate(token);
    const context = currentContext();
    if (actor === null || context === undefined) {
      setCookie(reply, clearCookie(CONSOLE_COOKIE));
      return undefined;
    }
    context.platformUserId = actor.userId;
    actors.set(context, actor);
    return undefined;
  });
}

const staffIdSchema = z.uuid();

/** Platform console API (05 §8.3, S-C01, S-C07). Mounted at /console; the web proxies /api/console. */
@Controller('console')
export class ConsoleController {
  constructor(private readonly service: ConsoleAuthService) {}

  @Post('auth/sign-in')
  @HttpCode(200)
  async signIn(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseOrThrow(signInRequestSchema, body);
    const result = await this.service.signIn(input, { ip: clientIp(request), userAgent: userAgent(request) });
    setCookie(reply, sessionCookie(CONSOLE_COOKIE, result.token, CONSOLE_ABSOLUTE_MS / 1000));
    return { next: result.next };
  }

  @Post('auth/totp/setup')
  @HttpCode(200)
  setupTotp() {
    return this.service.setupTotp(requirePartial());
  }

  @Post('auth/totp/enable')
  @HttpCode(200)
  enableTotp(@Body() body: unknown) {
    const { code } = parseOrThrow(totpCodeRequestSchema, body);
    return this.service.enableTotp(requirePartial(), code);
  }

  @Post('auth/totp/verify')
  @HttpCode(204)
  async verifyTotp(@Body() body: unknown): Promise<void> {
    const { code } = parseOrThrow(z.object({ code: z.string().trim().min(6).max(16) }), body);
    await this.service.verifySecondFactor(requirePartial(), code, 'sign-in');
  }

  /** Re-authentication before sensitive actions (lifecycle, plans, staff, emergency access). */
  @Post('auth/reauth')
  @HttpCode(204)
  async reauth(@Body() body: unknown): Promise<void> {
    const { code } = parseOrThrow(totpCodeRequestSchema, body);
    await this.service.verifySecondFactor(requireStaff(), code, 'reauth');
  }

  @Post('auth/sign-out')
  @HttpCode(204)
  async signOut(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const actor = consoleActor();
    if (actor !== null) await this.service.signOut(actor);
    setCookie(reply, clearCookie(CONSOLE_COOKIE));
  }

  @Get('me')
  @Header('Cache-Control', 'private, no-store')
  me(): ConsoleMeResponse {
    return this.service.me(requireStaff());
  }

  @Get('staff')
  @Header('Cache-Control', 'private, no-store')
  staff(): Promise<StaffListResponse> {
    requireRole(requireStaff(), 'PLATFORM_OWNER', 'PLATFORM_OPERATOR');
    return this.service.listStaff();
  }

  @Post('staff/:id/disable')
  @HttpCode(204)
  async disableStaff(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    const actor = requireStaff();
    requireRole(actor, 'PLATFORM_OWNER');
    requireRecentReauth(actor);
    await this.service.disableStaff(actor, staffIdSchema.parse(id));
  }
}
