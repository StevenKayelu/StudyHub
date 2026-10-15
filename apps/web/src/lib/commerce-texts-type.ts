import type messages from '../../messages/en.json';

/** Raw commerce strings passed to client components (see commerce-texts.ts). */
export interface CommerceTexts {
  commerce: (typeof messages)['commerce'];
  common: (typeof messages)['common'];
}
