import { z } from 'zod';

/** Public development-only key (base64 of a fixed 32-byte string). Refused in production. */
export const DEV_IDENTITY_ENCRYPTION_KEY = Buffer.from('studyhub-local-development-key!!').toString('base64');

/** Public development-only key-encryption key for payment credentials (M8). Refused in production. */
export const DEV_PAYMENT_ENCRYPTION_KEY = Buffer.from('studyhub-local-payments-kek-dev!').toString('base64');

/** The local object store's access key (infra/seaweedfs/s3.json). Refused in production. */
export const DEV_S3_ACCESS_KEY = 'studyhub-local';

/** Placeholder marker used in .env.example; real deployments must never run with it. */
const PLACEHOLDER_MARKER = 'change-me';

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\/[^\s]+$/.test(value), {
    message: 'must be a postgresql:// connection URL',
  });

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

function rejectPlaceholdersInProduction(
  env: { NODE_ENV: string } & Record<string, unknown>,
  context: z.RefinementCtx,
  keys: readonly string[],
): void {
  if (env.NODE_ENV !== 'production') return;
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.includes(PLACEHOLDER_MARKER)) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `contains the "${PLACEHOLDER_MARKER}" development placeholder; set a real credential for production`,
      });
    }
  }
}

/** Environment for the API and worker processes. */
export const apiEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    APP_VERSION: z.string().min(1).default('0.1.0-dev'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
    /**
     * Addresses allowed to set X-Forwarded-Host / X-Forwarded-For (the reverse proxy and the web
     * server). Requests from anywhere else are resolved from their own Host header (threat T3).
     */
    TRUSTED_PROXIES: z
      .string()
      .default('127.0.0.1,::1')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      )
      .pipe(z.array(z.string().regex(/^[0-9a-fA-F.:/]+$/, 'must be IP addresses or CIDR ranges')).min(1)),
    DATABASE_URL_APP: postgresUrl,
    /**
     * 32-byte key (base64) for secrets at rest: TOTP secrets and links in queued emails. Development
     * uses a fixed, public key; production must set its own (a KMS-managed key later).
     */
    IDENTITY_ENCRYPTION_KEY: z
      .string()
      .default(DEV_IDENTITY_ENCRYPTION_KEY)
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must be 32 bytes, base64-encoded',
      }),
    /** How emails link to a school host. `{host}` is replaced by the school's primary host. */
    SCHOOL_URL_TEMPLATE: z
      .string()
      .default('http://{host}:3000')
      .refine((value) => /^https?:\/\/\{host\}(:\d{1,5})?$/.test(value), {
        message: 'must look like https://{host} (optionally with a port)',
      }),
    /** The platform domain under which schools get `{slug}.<domain>` (F37, F38; Q-OPS-2 decides it). */
    SCHOOL_HOST_SUFFIX: z
      .string()
      .default('localhost')
      .transform((value) =>
        value
          .trim()
          .toLowerCase()
          .replace(/^\.+|\.+$/g, ''),
      )
      .pipe(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/)),
    /** Hosts of the platform console; /api/console/* answers only on these (realm separation). */
    CONSOLE_HOSTS: z
      .string()
      .default('console.localhost')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      )
      .pipe(z.array(z.string().min(1)).min(1)),
    /** Outgoing mail (local: Mailpit from docker compose). */
    SMTP_URL: z.string().default('smtp://127.0.0.1:1025'),
    MAIL_FROM_ADDRESS: z.email().default('no-reply@mail.studyhub.localhost'),
    /** Object storage (S3 API; production: Cloudflare R2). Local: SeaweedFS from docker compose. */
    S3_ENDPOINT: z.url().optional().default('http://127.0.0.1:8333'),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(3).default('studyhub-local'),
    S3_ACCESS_KEY_ID: z.string().min(1).default(DEV_S3_ACCESS_KEY),
    S3_SECRET_ACCESS_KEY: z.string().min(1).default('studyhub-local-object-store'),
    S3_FORCE_PATH_STYLE: z.stringbool().default(true),
    /** Development only: create the bucket on first use. */
    S3_CREATE_BUCKET: z.stringbool().default(true),
    /** clamd (production) or eicar-only (development and tests: flags only the EICAR test file). */
    MALWARE_SCANNER: z.enum(['clamd', 'eicar-only']).default('eicar-only'),
    CLAMD_HOST: z.string().default('127.0.0.1'),
    CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    /** Managed video provider. Only the fake exists until a provider is approved (as for payments). */
    VIDEO_PROVIDER: z.enum(['fake']).default('fake'),
    FAKE_VIDEO_SECRET: z.string().min(16).default('studyhub-local-fake-video-secret'),
    /**
     * Key-encryption key (32 bytes, base64) for school payment credentials, webhook secrets, payer numbers
     * and payout details (04 §17.10 envelope encryption). A KMS-managed key replaces it later.
     */
    PAYMENT_ENCRYPTION_KEY: z
      .string()
      .default(DEV_PAYMENT_ENCRYPTION_KEY)
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must be 32 bytes, base64-encoded',
      }),
    /** Payment provider adapters schools may connect. Only the fake exists until one is approved (Q-PAY-3). */
    PAYMENT_PROVIDERS: z
      .string()
      .default('fake')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      )
      .pipe(z.array(z.enum(['fake']))),
    /** Storage per school until plans exist (M9): BR-49 limits apply against this. */
    DEFAULT_STORAGE_QUOTA_MB: z.coerce.number().int().min(1).default(10_240),
  })
  .superRefine((env, context) => {
    rejectPlaceholdersInProduction(env, context, ['DATABASE_URL_APP']);
    if (env.NODE_ENV === 'production') {
      const refuse = (path: string, message: string) =>
        context.addIssue({ code: 'custom', path: [path], message });
      if (env.MALWARE_SCANNER !== 'clamd') refuse('MALWARE_SCANNER', 'must be clamd in production');
      if (env.VIDEO_PROVIDER === 'fake')
        refuse('VIDEO_PROVIDER', 'the fake provider is for development only');
      if (env.PAYMENT_PROVIDERS.includes('fake'))
        refuse('PAYMENT_PROVIDERS', 'the fake payment provider is for development only');
      if (env.PAYMENT_ENCRYPTION_KEY === DEV_PAYMENT_ENCRYPTION_KEY)
        refuse('PAYMENT_ENCRYPTION_KEY', 'is the public development key; set a real key for production');
      if (env.S3_ACCESS_KEY_ID === DEV_S3_ACCESS_KEY)
        refuse('S3_ACCESS_KEY_ID', 'is the local development key');
      if (env.S3_CREATE_BUCKET)
        refuse('S3_CREATE_BUCKET', 'buckets are provisioned, never created by the API');
      if (env.IDENTITY_ENCRYPTION_KEY === DEV_IDENTITY_ENCRYPTION_KEY) {
        context.addIssue({
          code: 'custom',
          path: ['IDENTITY_ENCRYPTION_KEY'],
          message: 'is the public development key; set a real key for production',
        });
      }
      if (!env.SCHOOL_URL_TEMPLATE.startsWith('https://')) {
        context.addIssue({
          code: 'custom',
          path: ['SCHOOL_URL_TEMPLATE'],
          message: 'must use https in production',
        });
      }
    }
  });

/** Environment for the migration CLI (runs as the migrator role). */
export const migratorEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    DATABASE_URL_MIGRATOR: postgresUrl,
  })
  .superRefine((env, context) => rejectPlaceholdersInProduction(env, context, ['DATABASE_URL_MIGRATOR']));

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type MigratorEnv = z.infer<typeof migratorEnvSchema>;

/** Thrown when configuration is invalid. The message names variables but never echoes their values. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid configuration — fix these environment variables (see .env.example):\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  // Treat empty strings as unset so `KEY=` in a .env file falls back to defaults or fails clearly.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

export const loadApiEnv = (source?: Record<string, string | undefined>): ApiEnv =>
  loadEnv(apiEnvSchema, source);

export const loadMigratorEnv = (source?: Record<string, string | undefined>): MigratorEnv =>
  loadEnv(migratorEnvSchema, source);
