import type { ReactNode } from 'react';

import { ReadOnlyGate } from '../../../../components/school-status';

/** A read-only school (BR-52) shows S-X07 on its public pages; sign-in stays open for its learners. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <ReadOnlyGate allow={/^\/(sign-in|switch)(\/|\?|$)/}>{children}</ReadOnlyGate>;
}
