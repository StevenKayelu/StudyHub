import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { contrastRatio } from '../theme/color.js';
import { tokensCss } from './css.js';
import { type ColorScheme, consoleAccent, contrastRequirements, darkColors, lightColors } from './tokens.js';

const schemes: [string, ColorScheme][] = [
  ['light', lightColors],
  ['dark', darkColors],
  ['console light', { ...lightColors, ...consoleAccent.light }],
  ['console dark', { ...darkColors, ...consoleAccent.dark }],
];

describe('Copperline tokens', () => {
  it.each(schemes)('UX-09: every required pair meets its contrast in the %s theme', (_name, scheme) => {
    for (const { fg, bg, min } of contrastRequirements) {
      expect(contrastRatio(scheme[fg], scheme[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
    }
  });

  it('tokens.css is up to date with tokens.ts (run `pnpm --filter @studyhub/ui tokens`)', () => {
    const file = fileURLToPath(new URL('../styles/tokens.css', import.meta.url));
    expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(tokensCss());
  });
});
