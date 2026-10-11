import { describe, expect, it } from 'vitest';

import { ConfigError, loadApiEnv, loadMigratorEnv } from './env.schema';

const validDatabaseUrl = 'postgresql://studyhub_app:local-password@127.0.0.1:5432/studyhub';

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadApiEnv', () => {
  it('applies safe defaults when only the required variable is set', () => {
    const env = loadApiEnv({ DATABASE_URL_APP: validDatabaseUrl });
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      READINESS_TIMEOUT_MS: 2000,
    });
  });

  it('names a missing required variable', () => {
    const error = captureConfigError(() => loadApiEnv({}));
    expect(error.message).toContain('DATABASE_URL_APP');
    expect(error.message).toContain('.env.example');
  });

  it('treats an empty value as missing', () => {
    const error = captureConfigError(() => loadApiEnv({ DATABASE_URL_APP: '' }));
    expect(error.problems.join('\n')).toContain('DATABASE_URL_APP');
  });

  it('names an invalid variable without echoing its value', () => {
    const secretLookingValue = 'mysql://user:super-secret-value@db/studyhub';
    const error = captureConfigError(() => loadApiEnv({ DATABASE_URL_APP: secretLookingValue }));
    expect(error.message).toContain('DATABASE_URL_APP');
    expect(error.message).not.toContain('super-secret-value');
  });

  it('rejects an out-of-range port', () => {
    const error = captureConfigError(() =>
      loadApiEnv({ DATABASE_URL_APP: validDatabaseUrl, API_PORT: '70000' }),
    );
    expect(error.message).toContain('API_PORT');
  });

  it('rejects an unknown NODE_ENV and LOG_LEVEL', () => {
    const error = captureConfigError(() =>
      loadApiEnv({ DATABASE_URL_APP: validDatabaseUrl, NODE_ENV: 'staging-ish', LOG_LEVEL: 'loud' }),
    );
    expect(error.message).toContain('NODE_ENV');
    expect(error.message).toContain('LOG_LEVEL');
  });

  it('refuses development placeholder credentials in production', () => {
    const error = captureConfigError(() =>
      loadApiEnv({
        NODE_ENV: 'production',
        DATABASE_URL_APP: 'postgresql://studyhub_app:change-me-local-app@127.0.0.1:5432/studyhub',
      }),
    );
    expect(error.message).toContain('DATABASE_URL_APP');
    expect(error.message).toContain('placeholder');
  });
});

describe('loadMigratorEnv', () => {
  it('requires the migrator connection URL', () => {
    const error = captureConfigError(() => loadMigratorEnv({ DATABASE_URL_APP: validDatabaseUrl }));
    expect(error.message).toContain('DATABASE_URL_MIGRATOR');
  });
});
