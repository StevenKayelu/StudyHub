import type { ReactNode } from 'react';

import { PermissionDenied } from '../../../../components/auth-page';
import { requireMember } from '../../../../lib/session';

// Signed-in pages are never cached or indexed.
export const dynamic = 'force-dynamic';

/** Tenant administration: administrators and owners only (S-X05 for other members). */
export default async function Guard({ children }: { children: ReactNode }) {
  const me = await requireMember();
  if (!me.allowedActions.includes('admin.access')) return <PermissionDenied name={me.user.displayName} />;
  return children;
}
