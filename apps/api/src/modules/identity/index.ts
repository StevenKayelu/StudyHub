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
  setCookie,
  TENANT_API_PREFIX,
  userAgent,
} from './api/http';
export { SessionService } from './application/sessions';
export {
  allowedActions,
  can,
  canManageMember,
  canManageRole,
  sessionLifetime,
  type TenantAction,
  type TenantActor,
  type TenantRole,
} from './domain/policy';
export { IdentityModule } from './identity.module';
