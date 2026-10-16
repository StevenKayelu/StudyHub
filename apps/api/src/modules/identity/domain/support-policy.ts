/**
 * What a support session may do on a school host (F44, BR-47; 04 §17.12). Framework-free.
 *
 * - READ_ONLY: every write is refused (reads of the admin area work as for an administrator).
 * - READ_WRITE: writes in the admin area, except the BR-47 exclusions (owners and team, the payment
 *   account, domains) and everything that needs a real person or an owner decision (support access
 *   itself, exports, offboarding, going live). Studio, learning, purchases and account routes are
 *   refused too: a support session has no membership of its own (M9 PROPOSED 4).
 */
export type SupportVerdict = 'OK' | 'READ_ONLY' | 'EXCLUDED';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes that end or describe the support session itself are always allowed. */
const ALWAYS = [/^\/api\/v1\/support\/end$/];

const EXCLUDED = [
  /^\/api\/v1\/admin\/payment-accounts(\/|$)/,
  /^\/api\/v1\/admin\/domains(\/|$)/,
  /^\/api\/v1\/admin\/owners(\/|$)/,
  /^\/api\/v1\/admin\/members(\/|$)/,
  /^\/api\/v1\/admin\/invitations(\/|$)/,
  /^\/api\/v1\/admin\/users\/[^/]+\/(suspend|unsuspend)$/,
  /^\/api\/v1\/admin\/support-access(\/|$)/,
  /^\/api\/v1\/admin\/exports\/tenant$/,
  /^\/api\/v1\/admin\/offboarding$/,
  /^\/api\/v1\/admin\/onboarding\/go-live$/,
];

export function supportVerdict(
  scope: 'READ_ONLY' | 'READ_WRITE',
  method: string,
  url: string,
): SupportVerdict {
  const path = url.split('?')[0] ?? url;
  if (READS.has(method)) return 'OK';
  if (ALWAYS.some((pattern) => pattern.test(path))) return 'OK';
  if (scope === 'READ_ONLY') return 'READ_ONLY';
  if (!path.startsWith('/api/v1/admin/')) return 'EXCLUDED';
  return EXCLUDED.some((pattern) => pattern.test(path)) ? 'EXCLUDED' : 'OK';
}
