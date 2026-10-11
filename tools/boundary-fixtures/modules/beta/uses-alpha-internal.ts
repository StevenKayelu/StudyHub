// Fixture: VIOLATES module-internals-only-via-index (bypasses alpha/index.ts).
import { alphaInternal } from '../alpha/internal/secret';

export const leaked = alphaInternal;
