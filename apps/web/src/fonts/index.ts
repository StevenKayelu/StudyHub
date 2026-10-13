import localFont from 'next/font/local';

/**
 * The three curated font presets (06 §10.1), self-hosted: one Latin variable WOFF2 per family
 * (licences next to each file). Each family is exposed as the CSS variable a theme selects
 * (`--sh-font-{preset}-{ui|reading}`, see @studyhub/ui/theme). Browsers download only the files
 * the page actually uses; only the default UI font is preloaded (06 §9: ≤4 files, ≤120 KB per page).
 */
const atkinson = localFont({
  src: './atkinson-hyperlegible-next-latin-wght-normal.woff2',
  weight: '200 800',
  display: 'swap',
  variable: '--sh-font-copperline-ui',
  preload: true,
});

const literata = localFont({
  src: './literata-latin-wght-normal.woff2',
  weight: '200 900',
  display: 'swap',
  variable: '--sh-font-copperline-reading',
  preload: false,
});

const sourceSans = localFont({
  src: './source-sans-3-latin-wght-normal.woff2',
  weight: '200 900',
  display: 'swap',
  variable: '--sh-font-humanist-ui',
  preload: false,
});

const sourceSerif = localFont({
  src: './source-serif-4-latin-wght-normal.woff2',
  weight: '200 900',
  display: 'swap',
  variable: '--sh-font-humanist-reading',
  preload: false,
});

const jakarta = localFont({
  src: './plus-jakarta-sans-latin-wght-normal.woff2',
  weight: '200 800',
  display: 'swap',
  variable: '--sh-font-geometric-ui',
  preload: false,
});

/** Geometric pairs with Literata for reading; it reuses the same file under the preset's variable. */
const literataGeometric = localFont({
  src: './literata-latin-wght-normal.woff2',
  weight: '200 900',
  display: 'swap',
  variable: '--sh-font-geometric-reading',
  preload: false,
});

/** Class names that define every preset's font variables; put on <html>. */
export const fontVariables = [atkinson, literata, sourceSans, sourceSerif, jakarta, literataGeometric]
  .map((font) => font.variable)
  .join(' ');
