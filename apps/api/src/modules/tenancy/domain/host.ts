// Pure domain rules for school addresses (blueprint BR-50, BR-60; design §3.6). No framework imports.

/** Labels reserved for the platform; no school may use them as its slug (BR-50). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'admin',
  'console',
  'api',
  'app',
  'auth',
  'accounts',
  'mail',
  'email',
  'static',
  'assets',
  'cdn',
  'media',
  'status',
  'help',
  'support',
  'docs',
  'blog',
  'studyhub',
  'localhost',
  'test',
]);

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type SlugProblem = 'FORMAT' | 'RESERVED' | 'DOUBLE_HYPHEN';

/** Returns why a slug is unacceptable, or null when it is valid. */
export function slugProblem(slug: string): SlugProblem | null {
  if (!SLUG.test(slug)) return 'FORMAT';
  if (slug.includes('--')) return 'DOUBLE_HYPHEN';
  if (RESERVED_SLUGS.has(slug)) return 'RESERVED';
  return null;
}

/**
 * Normalises a Host header value for tenant lookup: lower-case, port and trailing dot removed.
 * Returns null for anything that cannot be a school host (IP literals, single labels, bad characters),
 * so malformed or hostile input never reaches the database.
 */
export function normalizeHost(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  let host = raw.trim().toLowerCase();
  if (host.length === 0 || host.startsWith('[')) return null; // IPv6 literals are never schools

  const colon = host.lastIndexOf(':');
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;

  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return null;
  if (labels.every((label) => /^\d+$/.test(label))) return null; // IPv4 literals are never schools
  return host;
}
