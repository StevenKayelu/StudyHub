import type { TenantRole } from './policy';

/**
 * One device at a time for learners (docs/design/single-device-learners.md): while the school's setting
 * is on, a new sign-in of an account whose only role in the school is learner replaces its other
 * sessions there. Instructors, administrators and owners keep several devices.
 */
export function replacesOtherSessions(roles: readonly TenantRole[], schoolSettingOn: boolean): boolean {
  return schoolSettingOn && roles.every((role) => role === 'LEARNER');
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** "Chrome on Android" from a user agent, for the signed-in-elsewhere email; never the raw string. */
export function deviceLabel(userAgent: string | null): string {
  if (userAgent === null || userAgent === '') return 'another device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser !== undefined && system !== undefined) return `${browser} on ${system}`;
  return browser ?? system ?? 'another device';
}
