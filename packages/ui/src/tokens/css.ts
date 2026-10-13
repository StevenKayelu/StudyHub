import {
  breakpoints,
  type ColorScheme,
  containers,
  darkColors,
  duration,
  easing,
  elevation,
  lightColors,
  radius,
  space,
  typeScale,
  zIndex,
} from './tokens.js';

const HEADER =
  '/* GENERATED from src/tokens/tokens.ts by `pnpm --filter @studyhub/ui tokens`. Do not edit. */\n';

const rem = (px: number) => `${px / 16}rem`;

function colorLines(scheme: ColorScheme, indent: string): string {
  return Object.entries(scheme)
    .map(([role, hex]) => `${indent}--sh-color-${role}: ${hex};`)
    .join('\n');
}

/** Fluid size between the compact (≤600 px) and expanded (≥1024 px) values (06 §2.3). */
function fluid(compact: number, expanded: number): string {
  if (compact === expanded) return rem(compact);
  const min = breakpoints.medium;
  const max = breakpoints.expanded;
  const slope = (expanded - compact) / (max - min);
  const intercept = compact - slope * min;
  return `clamp(${rem(compact)}, ${(intercept / 16).toFixed(4)}rem + ${(slope * 100).toFixed(4)}vw, ${rem(expanded)})`;
}

/** Builds tokens.css: static tokens, light colours, and dark colours (system preference or data-theme). */
export function tokensCss(): string {
  const lines: string[] = [];
  lines.push(':root {');
  lines.push('  color-scheme: light dark;');
  lines.push(colorLines(lightColors, '  '));
  for (const [key, px] of Object.entries(space)) lines.push(`  --sh-space-${key}: ${rem(px)};`);
  for (const [key, px] of Object.entries(radius)) lines.push(`  --sh-radius-${key}: ${px}px;`);
  for (const [key, value] of Object.entries(elevation)) lines.push(`  --sh-elevation-${key}: ${value};`);
  for (const [key, ms] of Object.entries(duration)) lines.push(`  --sh-duration-${key}: ${ms}ms;`);
  lines.push(`  --sh-easing-standard: ${easing};`);
  for (const [key, value] of Object.entries(zIndex)) lines.push(`  --sh-z-${key}: ${value};`);
  for (const [key, px] of Object.entries(containers)) lines.push(`  --sh-container-${key}: ${px}px;`);
  for (const [key, spec] of Object.entries(typeScale)) {
    lines.push(`  --sh-text-${key}-size: ${fluid(spec.compact[0], spec.expanded[0])};`);
    lines.push(`  --sh-text-${key}-line: ${fluid(spec.compact[1], spec.expanded[1])};`);
    lines.push(`  --sh-text-${key}-weight: ${spec.weight};`);
  }
  lines.push('  --sh-font-ui: var(--sh-font-copperline-ui), system-ui, sans-serif;');
  lines.push('  --sh-font-reading: var(--sh-font-copperline-reading), Georgia, serif;');
  lines.push("  --sh-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;");
  lines.push('}');
  lines.push('');
  lines.push('@media (prefers-color-scheme: dark) {');
  lines.push('  :root:not([data-theme="light"]) {');
  lines.push(colorLines(darkColors, '    '));
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push(':root[data-theme="dark"] {');
  lines.push('  color-scheme: dark;');
  lines.push(colorLines(darkColors, '  '));
  lines.push('}');
  lines.push('');
  lines.push(':root[data-theme="light"] {');
  lines.push('  color-scheme: light;');
  lines.push('}');
  return `${HEADER}${lines.join('\n')}\n`;
}
