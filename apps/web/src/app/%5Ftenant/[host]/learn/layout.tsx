import type { ReactNode } from 'react';

import { requireMember } from '../../../../lib/session';

// Signed-in pages are never cached or indexed.
export const dynamic = 'force-dynamic';

/** Learner space: any signed-in member of this school; others sign in first. */
export default async function Guard({ children }: { children: ReactNode }) {
  await requireMember();
  return children;
}
