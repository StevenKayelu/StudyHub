'use client';

import { createContext, type ReactNode, useContext } from 'react';

/** Already-translated strings for the error page (S-X02), which must be a client component. */
export interface ErrorTexts {
  title: string;
  message: string;
  tryAgain: string;
  goHome: string;
  details: string;
  /** Contains `{id}`, replaced with the error digest. */
  requestId: string;
}

const ErrorTextsContext = createContext<ErrorTexts | null>(null);

/**
 * Passes the error page's strings from the server layout. Shipping plain strings instead of the
 * next-intl client runtime keeps public pages within the 06 §9 JavaScript budget.
 */
export function ErrorTextsProvider({ texts, children }: { texts: ErrorTexts; children: ReactNode }) {
  return <ErrorTextsContext.Provider value={texts}>{children}</ErrorTextsContext.Provider>;
}

export function useErrorTexts(): ErrorTexts {
  const texts = useContext(ErrorTextsContext);
  if (texts === null) throw new Error('useErrorTexts must be used inside <ErrorTextsProvider>.');
  return texts;
}
