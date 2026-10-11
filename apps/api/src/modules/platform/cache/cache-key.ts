import { AppError } from '../errors/app-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PART = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The ONLY way to build a key for tenant data in any cache (blueprint 04 §17.11, threat T13).
 * A missing or malformed tenant id is a programming error and throws, so tenant data can never be
 * cached under a key another tenant could hit.
 */
export function tenantCacheKey(tenantId: string | undefined, ...parts: string[]): string {
  if (tenantId === undefined || !UUID.test(tenantId)) {
    throw new AppError('TENANT_CONTEXT_MISSING', { detail: 'A tenant cache key needs a tenant id.' });
  }
  if (parts.length === 0 || !parts.every((part) => SAFE_PART.test(part))) {
    throw new Error('tenantCacheKey: parts must be 1-128 characters of [A-Za-z0-9._-]');
  }
  return ['t', tenantId.toLowerCase(), ...parts].join(':');
}
