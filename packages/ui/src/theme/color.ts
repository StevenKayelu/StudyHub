import { clampChroma, converter, differenceEuclidean, formatHex, type Oklch, parseHex } from 'culori';

/** A colour as 6-digit lowercase sRGB hex (#rrggbb): the only form tokens and tenant settings use. */
export type Hex = `#${string}`;

const HEX = /^#[0-9a-f]{6}$/;
const toOklch = converter('oklch');
const toRgb = converter('rgb');
const deltaEOk = differenceEuclidean('oklab');

/** Normalises `#RRGGBB` (any case) to lowercase; returns null for anything else (no shorthand, no alpha). */
export function normalizeHex(value: string): Hex | null {
  const hex = value.trim().toLowerCase();
  return HEX.test(hex) ? (hex as Hex) : null;
}

export interface Lch {
  /** OKLCH lightness, 0–1. */
  l: number;
  /** OKLCH chroma, ≥0. */
  c: number;
  /** OKLCH hue in degrees, 0–360 (0 for achromatic colours). */
  h: number;
}

/** Parses a value already validated as Hex (the type guarantees the format). */
function rgb(hex: Hex) {
  const color = toRgb(parseHex(hex));
  if (color === undefined) throw new Error(`Not a colour: ${hex}`);
  return color;
}

export function hexToOklch(hex: Hex): Lch {
  const color = toOklch(rgb(hex));
  return { l: color.l, c: color.c ?? 0, h: color.h ?? 0 };
}

/** OKLCH → hex, reducing chroma (never lightness or hue) until the colour fits the sRGB gamut. */
export function oklchToHex({ l, c, h }: Lch): Hex {
  const color: Oklch = { mode: 'oklch', l: Math.min(Math.max(l, 0), 1), c: Math.max(c, 0), h };
  return formatHex(clampChroma(color, 'oklch')) as Hex;
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance(hex: Hex): number {
  const { r, g, b } = rgb(hex);
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio (1–21). */
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Perceptual distance in OKLab (ΔE_OK). About 0.02 is a just-noticeable difference. */
export function deltaE(a: Hex, b: Hex): number {
  return deltaEOk(rgb(a), rgb(b));
}
