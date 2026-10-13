import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  acceptInvitationRequestSchema,
  changePasswordRequestSchema,
  changeRolesRequestSchema,
  forgotPasswordRequestSchema,
  type InvitationPreview,
  inviteRequestSchema,
  joinRequestSchema,
  type MeResponse,
  type MySchoolsResponse,
  registerRequestSchema,
  resetPasswordRequestSchema,
  type SignInResponse,
  signInRequestSchema,
  type TeamResponse,
  tokenRequestSchema,
} from '@studyhub/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError, parseOrThrow } from '../../platform';
import { AuthService, type RequestMeta, type SignedIn } from '../application/auth.service';
import { TeamService } from '../application/team.service';
import type { TenantActor } from '../domain/policy';
import {
  clearCookie,
  clientIp,
  currentActor,
  SESSION_COOKIE,
  sessionCookie,
  setCookie,
  userAgent,
} from './http';

const ACCEPTED = { status: 'ACCEPTED' } as const;

function meta(request: FastifyRequest): RequestMeta {
  return { ip: clientIp(request), userAgent: userAgent(request), host: request.host };
}

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

function signIn(reply: FastifyReply, session: SignedIn): void {
  setCookie(reply, sessionCookie(SESSION_COOKIE, session.token, session.maxAgeSeconds));
}

/** Tenant-realm identity endpoints (blueprint 05 §3, §8.3). Authenticated JSON is never cached. */
@Controller('api/v1')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly team: TeamService,
  ) {}

  // --- Anonymous flows -------------------------------------------------------------------------

  @Post('auth/register')
  @HttpCode(202)
  async register(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parseOrThrow(registerRequestSchema, body);
    await this.auth.register(input, meta(request));
    return ACCEPTED;
  }

  @Post('auth/sign-in')
  @HttpCode(200)
  async signIn(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignInResponse> {
    const input = parseOrThrow(signInRequestSchema, body);
    const result = await this.auth.signIn(input, meta(request));
    if (result.status === 'JOIN_AVAILABLE') {
      return { status: 'JOIN_AVAILABLE', ticket: result.ticket, schoolName: result.schoolName };
    }
    signIn(reply, result.session);
    return { status: 'SIGNED_IN' };
  }

  @Post('auth/verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token } = parseOrThrow(tokenRequestSchema, body);
    const result = await this.auth.verifyEmail(token, meta(request));
    if (result.session !== null) signIn(reply, result.session);
    return { status: 'VERIFIED', signedIn: result.session !== null };
  }

  @Post('auth/password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Req() request: FastifyRequest) {
    const { email } = parseOrThrow(forgotPasswordRequestSchema, body);
    await this.auth.forgotPassword(email, meta(request));
    return ACCEPTED;
  }

  @Post('auth/password/reset')
  @HttpCode(200)
  async reset(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parseOrThrow(resetPasswordRequestSchema, body);
    await this.auth.resetPassword(input, meta(request));
    return { status: 'PASSWORD_RESET' };
  }

  @Post('auth/handoff')
  @HttpCode(200)
  async handoff(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token } = parseOrThrow(tokenRequestSchema, body);
    signIn(reply, await this.auth.exchangeHandoff(token, meta(request)));
    return { status: 'SIGNED_IN' };
  }

  @Get('invitations/preview')
  @Header('Cache-Control', 'no-store')
  async previewInvitation(@Query('token') token: unknown): Promise<InvitationPreview> {
    const parsed = parseOrThrow(tokenRequestSchema, { token });
    return this.team.preview(parsed.token);
  }

  @Post('invitations/accept')
  @HttpCode(200)
  async acceptInvitation(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseOrThrow(acceptInvitationRequestSchema, body);
    const session = await this.team.accept(input, meta(request), currentActor());
    if (session !== null) signIn(reply, session);
    return { status: 'SIGNED_IN' };
  }

  // --- Signed in -------------------------------------------------------------------------------

  @Post('auth/sign-out')
  @HttpCode(204)
  async signOut(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const actor = currentActor();
    if (actor !== null) await this.auth.signOut(actor);
    setCookie(reply, clearCookie(SESSION_COOKIE));
  }

  @Post('auth/verify-email/resend')
  @HttpCode(202)
  async resend(@Req() request: FastifyRequest) {
    await this.auth.resendVerification(requireActor(), meta(request));
    return ACCEPTED;
  }

  @Get('me')
  @Header('Cache-Control', 'private, no-store')
  me(): Promise<MeResponse> {
    return this.auth.me(requireActor());
  }

  @Post('me/password')
  @HttpCode(204)
  async changePassword(@Body() body: unknown): Promise<void> {
    await this.auth.changePassword(requireActor(), parseOrThrow(changePasswordRequestSchema, body));
  }

  @Get('me/sessions')
  @Header('Cache-Control', 'private, no-store')
  sessions() {
    return this.auth.listSessions(requireActor());
  }

  @Delete('me/sessions/:id')
  @HttpCode(204)
  async endSession(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.auth.endSession(requireActor(), id);
  }

  /** "Sign out everywhere": all of this account's sessions, in every school (BR-69). */
  @Delete('me/sessions')
  @HttpCode(204)
  async endAllSessions(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.endAllSessions(requireActor());
    setCookie(reply, clearCookie(SESSION_COOKIE));
  }

  @Get('me/schools')
  @Header('Cache-Control', 'private, no-store')
  schools(): Promise<MySchoolsResponse> {
    return this.auth.mySchools(requireActor());
  }

  @Post('me/schools/:tenantId/handoff')
  @HttpCode(200)
  createHandoff(@Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.auth.createHandoff(requireActor(), tenantId);
  }

  @Post('me/schools/current/join')
  @HttpCode(200)
  async join(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { ticket } = parseOrThrow(joinRequestSchema, body);
    signIn(reply, await this.auth.join(ticket, meta(request)));
    return { status: 'SIGNED_IN' };
  }

  @Post('me/schools/current/leave')
  @HttpCode(204)
  async leave(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.leaveSchool(requireActor());
    setCookie(reply, clearCookie(SESSION_COOKIE));
  }

  // --- School administration: team and invitations (S-AD14) ------------------------------------

  @Get('admin/team')
  @Header('Cache-Control', 'private, no-store')
  teamList(): Promise<TeamResponse> {
    return this.team.team(requireActor());
  }

  @Post('admin/invitations')
  @HttpCode(201)
  invite(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.team.invite(requireActor(), parseOrThrow(inviteRequestSchema, body), meta(request));
  }

  @Delete('admin/invitations/:id')
  @HttpCode(204)
  async revokeInvitation(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.team.revokeInvitation(requireActor(), id);
  }

  @Put('admin/members/:membershipId/roles')
  @HttpCode(204)
  async changeRoles(
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { roles } = parseOrThrow(changeRolesRequestSchema, body);
    await this.team.changeRoles(requireActor(), membershipId, roles);
  }

  @Delete('admin/members/:membershipId')
  @HttpCode(204)
  async removeMember(@Param('membershipId', new ParseUUIDPipe()) membershipId: string): Promise<void> {
    await this.team.removeMember(requireActor(), membershipId);
  }
}
