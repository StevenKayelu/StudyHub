import {
  createCourseSchema,
  createOrderSchema,
  createLessonSchema,
  createQuizSchema,
  createSectionSchema,
  createSubjectSchema,
  grantEnrollmentSchema,
  gradeItemSchema,
  practiceStartSchema,
  questionInputSchema,
  questionUpdateSchema,
  progressUpdateSchema,
  quizItemsSchema,
  reorderOutlineSchema,
  revokeEnrollmentSchema,
  refundRequestSchema,
  resolveExceptionSchema,
  saveAnswerSchema,
  updateCategorySchema,
  updateCourseSchema,
  updateLessonSchema,
  updatePeriodSchema,
  updateQuizSchema,
  updateSectionSchema,
} from '@studyhub/contracts';

type Ids = Readonly<Record<string, string>>;
function id(ids: Ids, key: string): string {
  const value = ids[key];
  if (value === undefined) throw new Error(`Missing isolation fixture: ${key}`);
  return value;
}

/** Route-specific bodies must survive the same Zod contract the real controller uses. These are
 * targeted mutation probes, separate from the generic malformed-input leak sweep. */
export const ISOLATION_PAYLOADS: Readonly<Record<string, (ids: Ids) => unknown>> = {
  'POST /api/v1/orders': (ids) => createOrderSchema.parse({ courseId: id(ids, 'course') }),
  'POST /api/v1/admin/orders/:id/refunds': () =>
    refundRequestSchema.parse({ mode: 'PROVIDER', reason: 'Cross-school isolation probe' }),
  'POST /api/v1/admin/payments/:id/resolve': () =>
    resolveExceptionSchema.parse({ decision: 'ACCEPT', note: 'Cross-school isolation probe' }),
  'POST /api/v1/studio/courses/:id/questions': () =>
    questionInputSchema.parse({
      type: 'SHORT_ANSWER',
      stem: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Isolation probe' }] }],
      },
      settings: { acceptedAnswers: ['probe'] },
    }),
  'PATCH /api/v1/studio/questions/:id': () =>
    questionUpdateSchema.parse({
      version: 1,
      stem: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Isolation probe' }] }],
      },
      settings: { acceptedAnswers: ['probe'] },
    }),
  'PUT /api/v1/studio/attempts/:id/items/:itemId/grade': () =>
    gradeItemSchema.parse({ points: 1, comment: 'Isolation probe' }),
  'POST /api/v1/learn/courses/:id/practice': () => practiceStartSchema.parse({ count: 1 }),
  'POST /api/v1/studio/courses': (ids) =>
    createCourseSchema.parse({ title: 'Isolation probe', subjectId: id(ids, 'subject') }),
  'PATCH /api/v1/studio/courses/:id': (ids) =>
    updateCourseSchema.parse({
      version: 1,
      title: 'Isolation probe',
      subjectId: id(ids, 'subject'),
      coverAssetId: id(ids, 'asset'),
    }),
  'PUT /api/v1/studio/courses/:id/outline/order': (ids) =>
    reorderOutlineSchema.parse({
      version: 1,
      sections: [{ id: id(ids, 'section'), lessonIds: [id(ids, 'lesson')] }],
    }),
  'POST /api/v1/studio/courses/:id/sections': () => createSectionSchema.parse({ title: 'Isolation probe' }),
  'PATCH /api/v1/studio/courses/:id/sections/:sectionId': () =>
    updateSectionSchema.parse({ title: 'Isolation probe' }),
  'POST /api/v1/studio/courses/:id/lessons': (ids) =>
    createLessonSchema.parse({ sectionId: id(ids, 'section'), title: 'Isolation probe', type: 'TEXT' }),
  'PATCH /api/v1/studio/courses/:id/lessons/:lessonId': (ids) =>
    updateLessonSchema.parse({
      version: 1,
      title: 'Isolation probe',
      periodId: id(ids, 'academic_period'),
      attachmentAssetIds: [id(ids, 'asset')],
    }),
  'POST /api/v1/admin/subjects': (ids) =>
    createSubjectSchema.parse({ categoryId: id(ids, 'category'), name: 'Isolation probe' }),
  'PATCH /api/v1/admin/categories/:id': () => updateCategorySchema.parse({ name: 'Isolation probe' }),
  'PATCH /api/v1/admin/subjects/:id': () => updateCategorySchema.parse({ name: 'Isolation probe' }),
  'PATCH /api/v1/admin/periods/:id': () =>
    updatePeriodSchema.parse({ name: 'Isolation probe', mode: 'OPEN' }),
  'POST /api/v1/admin/courses/:id/enrollments': () =>
    grantEnrollmentSchema.parse({ email: 'probe@beta.test', reason: 'Isolation probe' }),
  'POST /api/v1/admin/enrollments/:id/revoke': () =>
    revokeEnrollmentSchema.parse({ reason: 'Isolation probe' }),
  'PUT /api/v1/learn/lessons/:id/progress': () =>
    progressUpdateSchema.parse({ status: 'COMPLETED', positionSeconds: 10 }),
  'POST /api/v1/studio/courses/:id/quizzes': () => createQuizSchema.parse({ title: 'Isolation probe' }),
  'PATCH /api/v1/studio/quizzes/:id': () => updateQuizSchema.parse({ version: 1, title: 'Isolation probe' }),
  'PUT /api/v1/studio/quizzes/:id/items': (ids) =>
    quizItemsSchema.parse({
      version: 1,
      selectionMode: 'FIXED',
      items: [{ questionId: id(ids, 'question') }],
    }),
  'PUT /api/v1/learn/attempts/:id/answers/:itemId': () =>
    saveAnswerSchema.parse({ response: { text: 'Isolation probe' }, clientSeq: 1 }),
};

export function isolationPayload(route: string, ids: Ids): unknown | undefined {
  return ISOLATION_PAYLOADS[route]?.(ids);
}

/** Sequence keys such as "3" also occur in innocent status codes/counts/request ids. They cannot
 * identify a tenant in a generic response scan; use UUIDs and distinctive fixture text instead. */
export function foreignResponseMarkers(values: readonly string[]): string[] {
  return values.filter((value) => value.length >= 8 && !/^\d+$/.test(value));
}

/** The subject resolver uses field-level not_found for an invisible foreign reference. */
export function isReferenceValidationDenial(
  route: string,
  problem: { code?: string; errors?: Array<{ field?: string; code?: string }> },
): boolean {
  return (
    route === 'POST /api/v1/studio/courses' &&
    problem.code === 'VALIDATION_FAILED' &&
    problem.errors?.length === 1 &&
    problem.errors[0]?.field === 'subjectId' &&
    problem.errors[0]?.code === 'not_found'
  );
}
