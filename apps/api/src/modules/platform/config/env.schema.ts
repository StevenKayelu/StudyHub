import { z } from 'zod';

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
    DATABASE_URL_APP: postgresUrl,
  })
  .superRefine((env, context) => rejectPlaceholdersInProduction(env, context, ['DATABASE_URL_APP']));

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
