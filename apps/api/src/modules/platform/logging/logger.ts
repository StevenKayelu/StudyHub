import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Level, type Logger } from 'pino';

/**
 * Keys whose values must never reach logs (blueprint 04 §12). Matched at the top level and up to
 * three levels deep, plus HTTP request/response headers.
 */
export const REDACTED_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'msisdn',
] as const;

export const REDACTION_CENSOR = '[REDACTED]';

/** Injection token for the shared pino logger. */
export const APP_LOGGER = Symbol('APP_LOGGER');

const accessor = (key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`);

function redactionPaths(): string[] {
  const paths: string[] = [];
  for (const key of REDACTED_KEYS) {
    const leaf = accessor(key);
    paths.push(leaf.startsWith('.') ? leaf.slice(1) : leaf, `*${leaf}`, `*.*${leaf}`, `*.*.*${leaf}`);
  }
  paths.push('req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]');
  return paths;
}

export interface CreateLoggerOptions {
  level?: Level | 'silent';
  destination?: DestinationStream;
}

/** Structured JSON logger with redaction. Request logs carry `requestId` (see request-id.hook.ts). */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: { service: 'studyhub-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: redactionPaths(), censor: REDACTION_CENSOR },
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination,
  );
}

/** Adapts pino to NestJS's LoggerService so framework logs share the same format and redaction. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: Level, message: unknown, optionalParams: unknown[]): void {
    const context = optionalParams.length > 0 ? optionalParams[optionalParams.length - 1] : undefined;
    const fields = typeof context === 'string' ? { context } : {};
    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...message });
    } else {
      this.logger[level](fields, String(message));
    }
  }
}
