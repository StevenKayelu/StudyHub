// Public surface of the console module (enforced by dependency-cruiser).
export { registerConsoleHook } from './api/console.controller';
export { requireRecentReauth, requireRole, requireStaff } from './api/console-guards';
export { type ConsoleActor, ConsoleAuthService } from './application/console-auth.service';
export { recordInSchool, recordPlatform } from './application/platform-audit';
export { ConsoleModule } from './console.module';
export { LIFECYCLE } from './application/console-tenants.service';
export { platformCommission } from './domain/statements';
