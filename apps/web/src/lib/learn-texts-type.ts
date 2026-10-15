import type messages from '../../messages/en.json';

/** Raw learner-space strings passed to client components (see learn-texts.ts). */
export interface LearnTexts {
  player: (typeof messages)['learn']['player'];
  video: (typeof messages)['learn']['video'];
  cta: (typeof messages)['course']['cta'];
  common: (typeof messages)['common'];
  quiz: (typeof messages)['learn']['quiz'];
  runner: (typeof messages)['learn']['runner'];
  result: (typeof messages)['learn']['result'];
  practice: (typeof messages)['learn']['practice'];
  assessment: (typeof messages)['assessment'];
}
