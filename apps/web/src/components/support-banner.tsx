'use client';

import { Banner, Button } from '@studyhub/ui';
import { useState } from 'react';

import { callApi, reloadTo } from '../lib/client-api';

/** F44: the persistent banner of a support session, with a way to end it. */
export function SupportBanner({ message, endLabel }: { message: string; endLabel: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid="support-banner">
      <Banner
        tone="warning"
        action={
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await callApi('POST', '/api/v1/support/end');
              reloadTo('/');
            }}
          >
            {endLabel}
          </Button>
        }
      >
        {message}
      </Banner>
    </div>
  );
}
