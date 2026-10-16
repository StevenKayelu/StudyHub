// Public surface of the identity module (enforced by dependency-cruiser).
export { registerSessionHook } from './api/session.hook';
export {
  clearCookie,
  clientIp,
  CONSOLE_API_PREFIX,
  CONSOLE_COOKIE,
  currentActor,
  parseCookies,
  registerOriginCheckHook,
  SESSION_COOKIE,
  sessionCookie,
  SUPPORT_COOKIE,
  setCookie,
  TENANT_API_PREFIX,
  userAgent,
} from './api/http';
export { SessionService } from './application/sessions';
export { recordBoth, SupportSessionService } from './application/support-sessions';
export { limitForRole, TeamService } from './application/team.service';
export { supportVerdict } from './domain/support-policy';
export {
  allowedActions,
  can,
  canManageMember,
  canManageRole,
  sessionLifetime,
  SUPPORT_MEMBERSHIP_ID,
  type SupportContext,
  type TenantAction,
  type TenantActor,
  type TenantRole,
} from './domain/policy';
export { IdentityModule } from './identity.module';
