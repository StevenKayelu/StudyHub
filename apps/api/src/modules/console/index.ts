// Public surface of the console module (enforced by dependency-cruiser).
export { registerConsoleHook } from './api/console.controller';
export { ConsoleAuthService } from './application/console-auth.service';
export { ConsoleModule } from './console.module';
export { LIFECYCLE } from './application/console-tenants.service';
export { platformCommission } from './domain/statements';
