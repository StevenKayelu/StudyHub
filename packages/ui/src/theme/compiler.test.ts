import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ACCENT_ROLES, darkColors, lightColors } from '../tokens/tokens.js';
import { contrastRatio, deltaE, type Hex } from './color.js';
import { ACCENT_MIN_CONTRAST, compileAccent, type CompiledAccent } from './compiler.js';

/** Independent re-measurement of every BR-51 pair on the emitted hex values. */
function assertCompliant(accent: CompiledAccent): void {
  for (const [theme, bg] of [
    ['light', lightColors],
    ['dark', darkColors],
  ] as const) {
    const t = accent[theme];
    const pairs: [Hex, Hex][] = [
      [t.accent, bg['bg-canvas']],
      [t.accent, bg['bg-surface']],
      [t.accent, t['accent-soft']],
      [t['on-accent'], t.accent],
      [t['on-accent'], t['accent-hover']],
    ];
    for (const [fg, back] of pairs) {
      expect(contrastRatio(fg, back), `${theme} ${fg} on ${back}`).toBeGreaterThanOrEqual(
        ACCENT_MIN_CONTRAST,
      );
    }
  }
}

describe('theme compiler (BR-51)', () => {
  it('copper reference: #A3471C compiles to the 06 §2.2 accent tokens (light accent exact, others ΔE_OK < 0.02)', () => {
    const result = compileAccent('#A3471C');
    if (!result.ok) throw new Error(`copper rejected: ${result.reason}`);
    const { accent } = result;
    expect(accent.adjusted).toBe(false);
    expect(accent.light.accent).toBe(lightColors.accent);
    expect(accent.light['on-accent']).toBe(lightColors['on-accent']);
    for (const role of ACCENT_ROLES) {
      expect(deltaE(accent.light[role], lightColors[role]), `light ${role}`).toBeLessThan(0.02);
      expect(deltaE(accent.dark[role], darkColors[role]), `dark ${role}`).toBeLessThan(0.02);
    }
    assertCompliant(accent);
  });

  it('keeps an already compliant colour unchanged and darkens a slightly too light one', () => {
    const kept = compileAccent('#0e6a4e');
    expect(kept.ok && kept.accent.light.accent).toBe('#0e6a4e');

    const darkened = compileAccent('#d0602a'); // orange, a little too light for text on paper
    if (!darkened.ok) throw new Error(darkened.reason);
    expect(darkened.accent.adjusted).toBe(true);
    expect(darkened.accent.light.accent).not.toBe('#d0602a');
    assertCompliant(darkened.accent);
  });

  it('rejects colours that would have to change beyond recognition, with 3 compliant suggestions', () => {
    for (const input of ['#ffe600', '#7fffd4', '#f0f0f0']) {
      const result = compileAccent(input);
      expect(result.ok, input).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('TOO_LIGHT');
      expect(result.suggestions).toHaveLength(3);
      for (const suggestion of result.suggestions) {
        const compiled = compileAccent(suggestion);
        expect(compiled.ok && !compiled.accent.adjusted, `${input} → ${suggestion}`).toBe(true);
      }
    }
  });

  it('rejects malformed input without suggestions', () => {
    for (const input of ['', 'red', '#abc', '#a3471c80', 'a3471c', '#gggggg']) {
      expect(compileAccent(input)).toMatchObject({ ok: false, reason: 'INVALID_COLOR', suggestions: [] });
    }
  });

  it('accepts any case and surrounding whitespace', () => {
    const result = compileAccent('  #A3471c ');
    expect(result.ok && result.accent.input).toBe('#a3471c');
  });

  it('UX-16: across 10,000 random colours, every accepted colour meets BR-51 in both themes', () => {
    let accepted = 0;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const hex = `#${n.toString(16).padStart(6, '0')}`;
        const result = compileAccent(hex);
        if (result.ok) {
          accepted += 1;
          assertCompliant(result.accent);
        } else {
          expect(result.suggestions.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 10_000 },
    );
    // Sanity: the rule must not reject almost everything.
    expect(accepted).toBeGreaterThan(3_000);
  });

  it('every suggestion offered for a rejected colour compiles unchanged (sample of 300)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const result = compileAccent(`#${n.toString(16).padStart(6, '0')}`);
        if (result.ok) return;
        for (const suggestion of result.suggestions) {
          const compiled = compileAccent(suggestion);
          expect(compiled.ok && !compiled.accent.adjusted).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
