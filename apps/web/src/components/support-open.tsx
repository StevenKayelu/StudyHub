'use client';

import { Alert } from '@studyhub/ui';
import { useEffect, useState } from 'react';

import { callApi, fragmentToken, reloadTo } from '../lib/client-api';

/** Exchanges the support hand-off token (04 §17.12) for a support session, then opens the admin area. */
export function SupportOpen({ opening, failed }: { opening: string; failed: string }) {
  const [problem, setProblem] = useState(false);
  useEffect(() => {
    const token = fragmentToken();
    // The token never stays in the address bar or history.
    window.history.replaceState(null, '', window.location.pathname);
    if (token === null) {
      setProblem(true);
      return;
    }
    void callApi('POST', '/api/v1/support/handoff', { token }).then((result) => {
      if (result.ok) reloadTo('/admin');
      else setProblem(true);
    });
  }, []);
  return problem ? (
    <Alert tone="danger" role="alert" title={failed} />
  ) : (
    <p role="status" className="text-body text-muted">
      {opening}
    </p>
  );
}
