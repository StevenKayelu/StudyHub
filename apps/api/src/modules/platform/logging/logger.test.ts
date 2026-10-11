import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, REDACTED_KEYS, REDACTION_CENSOR } from './logger';

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: createLogger({ level: 'trace', destination }), output: () => lines.join('') };
}

const SECRET = 'S3cr3t-value-that-must-not-leak';

describe('createLogger redaction', () => {
  it.each(REDACTED_KEYS)('redacts "%s" at the top level and nested up to three levels', (key) => {
    const { logger, output } = captureLogger();
    logger.info({ [key]: SECRET }, 'top');
    logger.info({ outer: { [key]: SECRET } }, 'one level');
    logger.info({ a: { b: { [key]: SECRET } } }, 'two levels');
    logger.info({ a: { b: { c: { [key]: SECRET } } } }, 'three levels');

    const text = output();
    expect(text).not.toContain(SECRET);
    expect(text.split(REDACTION_CENSOR).length - 1).toBe(4);
  });

  it('redacts request and response headers', () => {
    const { logger, output } = captureLogger();
    logger.info({
      req: { headers: { authorization: `Bearer ${SECRET}`, cookie: `sid=${SECRET}` } },
      res: { headers: { 'set-cookie': `sid=${SECRET}` } },
    });
    expect(output()).not.toContain(SECRET);
  });

  it('keeps non-sensitive fields and emits JSON with an ISO timestamp', () => {
    const { logger, output } = captureLogger();
    logger.info({ requestId: 'req_123', route: '/healthz' }, 'served');
    const line = JSON.parse(output().trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', requestId: 'req_123', route: '/healthz', msg: 'served' });
    expect(typeof line.time).toBe('string');
    expect(line.service).toBe('studyhub-api');
  });
});
