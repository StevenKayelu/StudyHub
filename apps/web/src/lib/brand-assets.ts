import 'server-only';

import type { TenantBootstrap } from '@studyhub/contracts';
import { lightColors } from '@studyhub/ui/theme';

import { compiledAccent } from './tenant';

/** The school's light-theme accent pair (Copperline default when it has none). */
export function accentPair(tenant: TenantBootstrap): { accent: string; onAccent: string } {
  const compiled = compiledAccent(tenant.branding.accentHex);
  return {
    accent: compiled?.light.accent ?? lightColors.accent,
    onAccent: compiled?.light['on-accent'] ?? lightColors['on-accent'],
  };
}

/** First letter of the school's name, for generated icons until it uploads its own (F39). */
export function monogram(tenant: TenantBootstrap): string {
  return (Array.from(tenant.branding.displayName.trim())[0] ?? 'S').toLocaleUpperCase();
}

const escapeXml = (value: string) => value.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** A square monogram icon in the school's accent (favicon). */
export function monogramSvg(tenant: TenantBootstrap): string {
  const { accent, onAccent } = accentPair(tenant);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    `<rect width="64" height="64" rx="14" fill="${accent}"/>`,
    `<text x="32" y="44" text-anchor="middle" font-family="system-ui, sans-serif" font-size="36" font-weight="700" fill="${onAccent}">`,
    escapeXml(monogram(tenant)),
    '</text></svg>',
  ].join('');
}
