'use client';

import { Button } from '@studyhub/ui';

/** Opens the browser's print dialog (receipts: print or "Save as PDF", PROPOSED M8-7). */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button variant="secondary" className="self-start print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
