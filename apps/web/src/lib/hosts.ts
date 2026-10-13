/**
 * Which part of the product a host serves. Read from the environment at build time by next.config
 * (rewrites) and at runtime here; both must agree, so both use these helpers.
 *
 * - platform: the system status page (PLATFORM_HOSTS)
 * - console:  the platform console realm (CONSOLE_HOSTS; `console` is a reserved school slug, BR-50)
 * - school:   everything else, resolved by the API from the host
 */
export type HostKind = 'platform' | 'console' | 'school';

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

export const platformHosts = (): string[] => list(process.env.PLATFORM_HOSTS, 'localhost,127.0.0.1');
export const consoleHosts = (): string[] => list(process.env.CONSOLE_HOSTS, 'console.localhost');

/** Lowercase hostname without port or trailing dot. */
export function hostnameOf(rawHost: string | null | undefined): string {
  return (rawHost ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '');
}

export function classifyHost(rawHost: string | null | undefined): HostKind {
  const host = hostnameOf(rawHost);
  if (consoleHosts().includes(host)) return 'console';
  if (platformHosts().includes(host)) return 'platform';
  return 'school';
}
