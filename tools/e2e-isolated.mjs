// Creates only disposable containers. Never reads .env, connects to the developer database,
// reuses application servers, or removes existing volumes. Requires built API/shared packages.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = path.join(root, 'apps/api');
const web = path.join(root, 'apps/web');
const requireApi = createRequire(path.join(api, 'package.json'));
const requireWeb = createRequire(path.join(web, 'package.json'));
const { PostgreSqlContainer } = requireApi('@testcontainers/postgresql');
const { GenericContainer, Wait } = requireApi('testcontainers');
const containers = [];
let storageLog = '';
const totpFile = path.join(tmpdir(), `studyhub-e2e-${randomUUID()}.json`);

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied; refusing to reuse a server.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

function run(entry, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(entry)} failed (${code ?? signal})`)),
    );
  });
}

try {
  await Promise.all([3400, 4500].map(requireFreePort));
  const password = randomBytes(24).toString('hex');
  const postgres = await new PostgreSqlContainer('postgres:17')
    .withDatabase('studyhub')
    .withUsername('postgres')
    .withPassword(password)
    .withEnvironment({ STUDYHUB_MIGRATOR_PASSWORD: password, STUDYHUB_APP_PASSWORD: password })
    .withCopyDirectoriesToContainer([
      { source: path.join(root, 'infra/postgres/init'), target: '/docker-entrypoint-initdb.d' },
    ])
    .start();
  containers.push(postgres);
  const mail = await new GenericContainer('axllent/mailpit:v1.29')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/readyz', 8025))
    .start();
  containers.push(mail);
  const objects = await new GenericContainer('chrislusf/seaweedfs:4.48')
    .withCommand([
      'server',
      '-dir=/data',
      '-ip=127.0.0.1',
      '-ip.bind=0.0.0.0',
      '-master.volumeSizeLimitMB=64',
      '-volume.max=20',
      '-s3',
      '-s3.port=8333',
      '-s3.config=/etc/seaweedfs/s3.json',
      '-s3.allowedOrigins=*',
    ])
    .withCopyFilesToContainer([
      { source: path.join(root, 'infra/seaweedfs/s3.json'), target: '/etc/seaweedfs/s3.json' },
    ])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forHttp('/healthz', 8333))
    .withStartupTimeout(120_000)
    .start();
  containers.push(objects);
  const logs = await objects.logs();
  logs.on('data', (chunk) => {
    storageLog = (storageLog + chunk.toString()).slice(-12000);
  });
  const dbUrl = (user) =>
    `postgresql://${user}:${password}@${postgres.getHost()}:${postgres.getPort()}/studyhub`;
  const env = {
    ...process.env,
    ...parseEnv(readFileSync(path.join(root, '.env.example'), 'utf8')),
    NODE_ENV: 'development',
    STUDYHUB_E2E_ISOLATED: '1',
    STUDYHUB_E2E_TOTP_FILE: totpFile,
    DATABASE_URL_APP: dbUrl('studyhub_app'),
    DATABASE_URL_MIGRATOR: dbUrl('studyhub_migrator'),
    API_PORT: '4500',
    API_INTERNAL_URL: 'http://127.0.0.1:4500',
    PORT: '3400',
    HOSTNAME: '127.0.0.1',
    SCHOOL_URL_TEMPLATE: 'http://{host}:3400',
    SMTP_URL: `smtp://${mail.getHost()}:${mail.getMappedPort(1025)}`,
    MAILPIT_URL: `http://${mail.getHost()}:${mail.getMappedPort(8025)}`,
    S3_ENDPOINT: `http://${objects.getHost()}:${objects.getMappedPort(8333)}`,
    // Functional journeys must reach handlers; default budget behavior has dedicated tests.
    API_RATE_IP_PER_MINUTE: '100000',
    API_RATE_TENANT_PER_MINUTE: '100000',
    API_RATE_ACCOUNT_PER_MINUTE: '100000',
  };
  env.WEB_CSP_CONNECT_ORIGINS = env.S3_ENDPOINT;
  await run('dist/cli/migrate.js', [], api, env);
  await run('dist/cli/seed.js', [], api, env);
  await run(requireWeb.resolve('next/dist/bin/next'), ['build'], web, { ...env, NODE_ENV: 'production' });
  await run('scripts/standalone.mjs', ['prepare'], web, env);
  await run(requireWeb.resolve('@playwright/test/cli'), ['test', ...process.argv.slice(2)], web, env);
} catch (error) {
  console.error(error.message);
  if (storageLog) console.error(`Disposable object-store diagnostics:\n${storageLog}`);
  process.exitCode = 1;
} finally {
  if (existsSync(totpFile)) unlinkSync(totpFile);
  for (const container of containers.reverse()) {
    try {
      await container.stop();
    } catch (error) {
      console.error(`Disposable container cleanup: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
