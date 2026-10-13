import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { getConsoleMe } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** Console pages need a staff session that has passed two-step verification (04 §17.5). */
export default async function ConsoleAppLayout({ children }: { children: ReactNode }) {
  if ((await getConsoleMe()) === null) redirect('/sign-in');
  return children;
}
