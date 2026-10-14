import type { ReactNode } from 'react';

import { ReadOnlyGate } from '../../../../components/school-status';

import { PermissionDenied } from '../../../../components/auth-page';
import { requireMember } from '../../../../lib/session';

// Signed-in pages are never cached or indexed.
export const dynamic = 'force-dynamic';

/** Studio: instructors only (S-X05 for other members; sign-in for visitors). */
async function SpaceGuard({ children }: { children: ReactNode }) {
  const me = await requireMember();
  if (!me.allowedActions.includes('studio.access')) return <PermissionDenied name={me.user.displayName} />;
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
