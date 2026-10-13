import type { ReactNode } from 'react';

import { requireMember } from '../../../../lib/session';

// Signed-in pages are never cached or indexed.
export const dynamic = 'force-dynamic';

/** Account: any signed-in member. */
export default async function Guard({ children }: { children: ReactNode }) {
  await requireMember();
  return children;
}
