import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Every registered route as "METHOD /path" (HEAD and OPTIONS omitted), reconstructed from Fastify's
 * route tree, where nested lines continue their parent's path:
 *   ├── /api/v1/me (GET, HEAD)
 *   │   ├── /sessions (GET, HEAD, DELETE)
 */
export function listRoutes(app: NestFastifyApplication): string[] {
  const printed = app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false });
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of printed.split('\n')) {
    const match = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (match === null) continue;
    const depth = (match[1] ?? '').length / 4;
    stack.length = depth;
    const path = `${stack[depth - 1] ?? ''}${match[2]}`;
    stack[depth] = path;
    for (const method of (match[3] ?? '').split(',').map((m) => m.trim())) {
      if (method !== '' && method !== 'HEAD' && method !== 'OPTIONS') routes.push(`${method} ${path}`);
    }
  }
  return routes.sort();
}
