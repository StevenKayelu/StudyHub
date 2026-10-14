import type { ReactNode } from 'react';

import { ReadOnlyGate } from '../../../../components/school-status';

import { requireMember } from '../../../../lib/session';

// Signed-in pages are never cached or indexed.
export const dynamic = 'force-dynamic';

/** Account: any signed-in member. */
async function SpaceGuard({ children }: { children: ReactNode }) {
  await requireMember();
  return children;
}

/** A read-only school (BR-52) shows S-X07 here, also when this space is reached by client navigation. */
export default function Guard({ children }: { children: ReactNode }) {
  return (
    <ReadOnlyGate>
      <SpaceGuard>{children}</SpaceGuard>
    </ReadOnlyGate>
  );
}
