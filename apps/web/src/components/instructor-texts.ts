import 'server-only';

import { getTranslations } from 'next-intl/server';

import type { InstructorFormTexts } from './instructor-form';

/** Texts for the instructor application / profile form (raw strings; the client fills {date}). */
export async function instructorFormTexts(): Promise<InstructorFormTexts> {
  const t = await getTranslations();
  return {
    errorSummary: t('common.errorSummary'),
    networkError: t('common.networkError'),
    displayName: t('instructor.displayName'),
    headline: t('instructor.headline'),
    headlineHint: t('instructor.headlineHint'),
    bio: t('instructor.bio'),
    subjects: t('instructor.subjects'),
    subjectsHint: t('instructor.subjectsHint'),
    qualifications: t('instructor.qualifications'),
    saveDraft: t('instructor.saveDraft'),
    save: t('common.save'),
    saved: t('common.saved'),
    submit: t('instructor.submit'),
    submitting: t('instructor.submitting'),
    status: t.raw('instructor.status') as Record<string, string>,
    reapplyAfter: t.raw('instructor.reapplyAfter') as string,
  };
}
