import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

import { createApp } from '../../src/main';
import { createLogger, DEV_IDENTITY_ENCRYPTION_KEY, loadApiEnv, SecretBox } from '../../src/modules/platform';
import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from './postgres-container';

/**
 * Integration harness for school-facing features: a migrated database with two schools, optionally a
 * real S3-compatible object store (SeaweedFS), the API app, and helpers to act as members of a school
 * through the real HTTP API (registration, verification, sign-in, roles).
 */
export const PASSWORD = 'a long enough passphrase';
export const SESSION = '__Host-sh_session';
export const SCHOOLS = { acme: 'acme.localhost', beta: 'beta.localhost' } as const;

const S3_CONFIG = JSON.stringify({
  identities: [
    {
      name: 'test',
      credentials: [{ accessKey: 'test-access', secretKey: 'test-secret-object-store' }],
      actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
    },
  ],
});

export interface Harness {
  app: NestFastifyApplication;
  database: TestDatabase;
  migrator: Client;
  tenants: { acme: string; beta: string };
  s3Endpoint: string | null;
  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: { host: string; cookie?: string | undefined; body?: unknown },
  ): ReturnType<NestFastifyApplication['inject']>;
  asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
  /** Registers, verifies and returns a signed-in session cookie. */
  member(host: string, tenantId: string, email: string, name?: string): Promise<string>;
  grantRole(tenantId: string, email: string, role: string): Promise<void>;
  signIn(host: string, email: string): Promise<string>;
  setSetting(tenantId: string, key: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export function cookieFrom(setCookie: string | string[] | undefined, name = SESSION): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  for (const entry of list) {
    const [pair] = entry.split(';');
    const [key, value] = (pair ?? '').split('=');
    if (key === name && value !== undefined && value !== '') return `${name}=${value}`;
  }
  return undefined;
}

export async function startHarness(
  options: { objectStore?: boolean; env?: Record<string, string> } = {},
): Promise<Harness> {
  const database = await startTestDatabase({ migrate: true });
  const migrator = await database.connect(database.migratorUrl);
  const tenants = { acme: '', beta: '' };
  for (const [key, slug, name, hostname] of [
    ['acme', 'acme', 'Acme Academy', SCHOOLS.acme],
    ['beta', 'beta', 'Beta College', SCHOOLS.beta],
  ] as const) {
    const result = await provisionTenant(migrator, {
      slug,
      name,
      kind: 'SCHOOL',
      hostname,
      status: 'ACTIVE',
    });
    if (result.outcome !== 'created') throw new Error('provisioning failed');
    tenants[key] = result.tenantId;
  }

  let objectStore: StartedTestContainer | null = null;
  let s3Endpoint: string | null = null;
  if (options.objectStore === true) {
    objectStore = await new GenericContainer('chrislusf/seaweedfs:4.48')
      .withCommand([
        'server',
        '-dir=/data',
        '-ip=127.0.0.1',
        '-ip.bind=0.0.0.0',
        '-master.volumeSizeLimitMB=64',
        '-volume.max=5',
        '-s3',
        '-s3.port=8333',
        '-s3.config=/etc/seaweedfs/s3.json',
      ])
      .withCopyContentToContainer([{ content: S3_CONFIG, target: '/etc/seaweedfs/s3.json' }])
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forHttp('/healthz', 8333).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start();
    s3Endpoint = `http://${objectStore.getHost()}:${objectStore.getMappedPort(8333)}`;
  }

  const level = (process.env.TEST_LOG_LEVEL ?? 'silent') as 'silent';
  const env = loadApiEnv({
    DATABASE_URL_APP: database.appUrl,
    LOG_LEVEL: level,
    ...(s3Endpoint !== null && {
      S3_ENDPOINT: s3Endpoint,
      S3_ACCESS_KEY_ID: 'test-access',
      S3_SECRET_ACCESS_KEY: 'test-secret-object-store',
      S3_BUCKET: 'studyhub-test',
    }),
    ...options.env,
  });
  const app = await createApp({ env, logger: createLogger({ level }) });
  const box = new SecretBox(DEV_IDENTITY_ENCRYPTION_KEY);
  let ip = 1;

  const call: Harness['call'] = (method, url, opts) =>
    app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        host: opts.host,
        'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}`,
        ...(opts.cookie !== undefined && { cookie: opts.cookie }),
        ...(method !== 'GET' && { origin: `http://${opts.host}` }),
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(opts.body !== undefined && { payload: JSON.stringify(opts.body) }),
    });

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await migrator.query('BEGIN');
    try {
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn();
      await migrator.query('COMMIT');
      return result;
    } catch (error) {
      await migrator.query('ROLLBACK');
      throw error;
    }
  }

  async function signIn(host: string, email: string): Promise<string> {
    const response = await call('POST', '/api/v1/auth/sign-in', {
      host,
      body: { email, password: PASSWORD },
    });
    const cookie = cookieFrom(response.headers['set-cookie']);
    if (cookie === undefined) throw new Error(`sign-in failed for ${email}: ${response.body}`);
    return cookie;
  }

  async function member(
    host: string,
    tenantId: string,
    email: string,
    name = 'Test Person',
  ): Promise<string> {
    const register = await call('POST', '/api/v1/auth/register', {
      host,
      body: { displayName: name, email, password: PASSWORD, acceptTerms: true },
    });
    if (register.statusCode !== 202) throw new Error(`register failed: ${register.body}`);
    const { rows } = await asTenant(tenantId, () =>
      migrator.query<{ payload: { sealed: string } }>(
        `SELECT payload FROM outbox WHERE payload->>'to' = $1 AND payload->>'template' = 'verify-email' ORDER BY id DESC LIMIT 1`,
        [email],
      ),
    );
    const vars = JSON.parse(box.openText(rows[0]!.payload.sealed, `email:${tenantId}:${email}`)) as {
      link: string;
    };
    const token = /#token=(.+)$/.exec(vars.link)![1];
    const verified = await call('POST', '/api/v1/auth/verify-email', { host, body: { token } });
    return cookieFrom(verified.headers['set-cookie'])!;
  }

  async function grantRole(tenantId: string, email: string, role: string): Promise<void> {
    await asTenant(tenantId, () =>
      migrator.query(
        `INSERT INTO membership_role (tenant_id, membership_id, role)
         SELECT m.tenant_id, m.id, $2::"TenantRole" FROM tenant_membership m JOIN user_account a ON a.id = m.user_id
          WHERE a.email = $1 ON CONFLICT DO NOTHING`,
        [email, role],
      ),
    );
  }

  async function setSetting(tenantId: string, key: string, value: unknown): Promise<void> {
    await asTenant(tenantId, () =>
      migrator.query(
        `INSERT INTO tenant_setting (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [tenantId, key, JSON.stringify(value)],
      ),
    );
  }

  return {
    app,
    database,
    migrator,
    tenants,
    s3Endpoint,
    call,
    asTenant,
    member,
    grantRole,
    signIn,
    setSetting,
    async close() {
      await app.close();
      await migrator.end();
      await objectStore?.stop();
      await database.stop();
    },
  };
}
