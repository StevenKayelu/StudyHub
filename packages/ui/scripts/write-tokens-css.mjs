// Regenerates src/styles/tokens.css from src/tokens/tokens.ts (run after `pnpm build`).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tokensCss } from '../dist/tokens/css.js';

const target = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));
writeFileSync(target, tokensCss());
console.log(`wrote ${target}`);
