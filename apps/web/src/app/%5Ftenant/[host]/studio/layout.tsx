import type { ReactNode } from 'react';

import { PermissionDenied } from '../../../../components/auth-page';
import { requireMember } from '../../../../lib/session';

// Signed-in pages are never cached or indexed.
export const dynamic = 'force-dynamic';

/** Studio: instructors only (S-X05 for other members; sign-in for visitors). */
export default async function Guard({ children }: { children: ReactNode }) {
  const me = await requireMember();
  if (!me.allowedActions.includes('studio.access')) return <PermissionDenied name={me.user.displayName} />;
  return children;
}
