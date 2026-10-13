'use client';

import { buttonClasses } from '@studyhub/ui';
import { useState } from 'react';

import { reloadTo } from '../lib/client-api';

/** Ends the current session (school or console) and reloads, so every server component sees it. */
export function SignOutButton({
  label,
  endpoint = '/api/v1/auth/sign-out',
  next = '/',
}: {
  label: string;
  endpoint?: string;
  next?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={buttonClasses('ghost', 'sm')}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(endpoint, { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
        reloadTo(next);
      }}
    >
      {label}
    </button>
  );
}
