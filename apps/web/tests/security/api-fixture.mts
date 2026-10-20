import { createServer } from 'node:http';

import { DEFAULT_LOCALE_SETTINGS, FEATURE_KEYS, tenantBootstrapSchema } from '@studyhub/contracts';

// Read-only fixture server: no database connections, real identities or payment side effects.
const tenant = tenantBootstrapSchema.parse({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  slug: 'security',
  name: 'Security Academy',
  status: 'ACTIVE',
  branding: {
    version: 1,
    displayName: 'Security Academy',
    accentHex: '#0b7285',
    fontPreset: 'HUMANIST',
    showPoweredBy: true,
    terminology: {},
  },
  locales: DEFAULT_LOCALE_SETTINGS,
  features: Object.fromEntries(FEATURE_KEYS.map((key) => [key, true])),
});
const api = createServer((request, response) => {
  request.resume();
  const path = request.url?.split('?')[0];
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host).split(':')[0];
  if (path === '/healthz') {
    response.end('ok');
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  if (path === '/readyz') {
    response.end(JSON.stringify({ status: 'ok', version: 'security-fixture', checks: { database: 'ok' } }));
    return;
  }
  if (path === '/api/v1/tenant' && host === 'security.localhost') {
    response.end(JSON.stringify(tenant));
    return;
  }
  response.statusCode = path === '/api/v1/tenant' ? 404 : 401;
  response.end(
    JSON.stringify({
      type: 'about:blank',
      title: 'Sign-in required',
      status: response.statusCode,
      code: response.statusCode === 404 ? 'TENANT_NOT_FOUND' : 'INVALID_CREDENTIALS',
      requestId: 'security-fixture',
    }),
  );
});
const storage = createServer((request, response) => {
  request.resume();
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  response.end(request.method === 'OPTIONS' ? '' : 'fixture-upload-ok');
});
api.listen(4400, '127.0.0.1');
storage.listen(4401, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    api.close();
    storage.close();
  });
