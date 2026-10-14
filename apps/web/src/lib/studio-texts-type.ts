import type messages from '../../messages/en.json';

/** Raw Studio and administration strings passed to client components (see studio-texts.ts). */
export interface StudioTexts {
  studio: (typeof messages)['studio'];
  common: (typeof messages)['common'];
  admin: (typeof messages)['admin'];
  levels: (typeof messages)['catalogue']['levels'];
  lessonTypes: (typeof messages)['course']['lessonTypes'];
}
