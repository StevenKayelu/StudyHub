import { z } from 'zod';

import { richTextSchema } from './rich-text';

/**
 * Assessment contracts (M7; blueprint 05 §3.5, §4.4, §4.7; F17–F23). Shared by the API and the web app.
 * Learner-facing shapes never carry correct answers or explanations before submission (BR-20).
 */

export const questionTypeSchema = z.enum([
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'NUMERIC',
  'LONG_ANSWER',
]);
export const difficultySchema = z.enum(['EASY', 'MEDIUM', 'HARD']);
export const feedbackPolicySchema = z.enum(['IMMEDIATE', 'AFTER_CLOSE', 'NEVER']);
export const attemptStatusSchema = z.enum(['IN_PROGRESS', 'NEEDS_REVIEW', 'GRADED', 'ABANDONED']);

const tag = z.string().trim().toLowerCase().min(1).max(30);
const points = z.number().min(0.25).max(1000);

export const questionSettingsSchema = z.object({
  partialCredit: z.boolean().optional(),
  acceptedAnswers: z.array(z.string().trim().max(200)).max(20).optional(),
  caseSensitive: z.boolean().optional(),
  value: z.number().finite().optional(),
  tolerance: z.number().min(0).finite().optional(),
  unit: z.string().trim().max(20).optional(),
});

export const questionOptionInputSchema = z.object({
  content: z.string().trim().min(1).max(500),
  isCorrect: z.boolean(),
  feedback: z.string().trim().max(1000).optional(),
});

/** POST /studio/courses/{id}/questions */
export const questionInputSchema = z.object({
  type: questionTypeSchema,
  stem: richTextSchema,
  explanation: richTextSchema.nullable().optional(),
  points: points.default(1),
  difficulty: difficultySchema.default('MEDIUM'),
  tags: z.array(tag).max(10).default([]),
  /** Defaults to on for auto-gradable types; long answers are never practice questions (F22 AC 3). */
  practiceEligible: z.boolean().optional(),
  settings: questionSettingsSchema.default({}),
  options: z.array(questionOptionInputSchema).max(10).default([]),
});

/** PATCH /studio/questions/{id}: a full replacement of the editable fields, guarded by `version`. */
export const questionUpdateSchema = questionInputSchema.omit({ type: true }).extend({
  version: z.number().int().min(1),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export const questionViewSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  type: questionTypeSchema,
  stem: z.unknown(),
  stemText: z.string(),
  explanation: z.unknown().nullable(),
  points: z.number(),
  difficulty: difficultySchema,
  tags: z.array(z.string()),
  practiceEligible: z.boolean(),
  settings: questionSettingsSchema,
  options: z.array(
    z.object({ id: z.uuid(), content: z.string(), isCorrect: z.boolean(), feedback: z.string().nullable() }),
  ),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number(),
  usedInQuizzes: z.number(),
  updatedAt: z.iso.datetime(),
});

export const questionListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: questionTypeSchema.optional(),
  difficulty: difficultySchema.optional(),
  tag: tag.optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export const questionListSchema = z.object({
  items: z.array(questionViewSchema),
  tags: z.array(z.string()),
});

// --- Quizzes (F18) -----------------------------------------------------------------------------

export const createQuizSchema = z.object({ title: z.string().trim().min(1).max(120) });

export const updateQuizSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(120).optional(),
    instructions: richTextSchema.nullable().optional(),
    timeLimitMinutes: z.number().int().min(1).max(600).nullable().optional(),
    attemptsAllowed: z.number().int().min(1).max(100).nullable().optional(),
    passMarkPercent: z.number().int().min(0).max(100).nullable().optional(),
    shuffleQuestions: z.boolean().optional(),
    shuffleOptions: z.boolean().optional(),
    opensAt: z.iso.datetime().nullable().optional(),
    closesAt: z.iso.datetime().nullable().optional(),
    feedbackPolicy: feedbackPolicySchema.optional(),
    showCorrectAnswers: z.boolean().optional(),
    /** READY makes the quiz available; refused while the quiz checklist has problems. */
    status: z.enum(['DRAFT', 'READY']).optional(),
  })
  .refine((v) => (v.opensAt ?? null) === null || (v.closesAt ?? null) === null || v.opensAt! < v.closesAt!, {
    message: 'The quiz must open before it closes',
    path: ['closesAt'],
  });

export const drawRuleSchema = z.object({
  count: z.number().int().min(1).max(200),
  tags: z.array(tag).max(10).default([]),
  difficulty: difficultySchema.nullable().optional(),
  types: z.array(questionTypeSchema).max(6).default([]),
});

/** PUT /studio/quizzes/{id}/items: the question list (FIXED) or draw rules (DRAW), in order. */
export const quizItemsSchema = z.object({
  version: z.number().int().min(1),
  selectionMode: z.enum(['FIXED', 'DRAW']),
  items: z
    .array(z.object({ questionId: z.uuid(), pointsOverride: points.nullable().optional() }))
    .max(200)
    .default([]),
  drawRules: z.array(drawRuleSchema).max(20).default([]),
});

export const quizViewSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  title: z.string(),
  instructions: z.unknown().nullable(),
  selectionMode: z.enum(['FIXED', 'DRAW']),
  timeLimitMinutes: z.number().nullable(),
  attemptsAllowed: z.number().nullable(),
  passMarkPercent: z.number().nullable(),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  feedbackPolicy: feedbackPolicySchema,
  showCorrectAnswers: z.boolean(),
  status: z.enum(['DRAFT', 'READY']),
  version: z.number(),
  items: z.array(
    z.object({
      questionId: z.uuid(),
      position: z.number(),
      type: questionTypeSchema,
      stemText: z.string(),
      points: z.number(),
      pointsOverride: z.number().nullable(),
      archived: z.boolean(),
    }),
  ),
  drawRules: z.array(drawRuleSchema.extend({ available: z.number() })),
  /** F18 AC 2: the sum of question points (draw rules: count × each matching question's points, average). */
  totalPoints: z.number(),
  questionCount: z.number(),
  /** BR-23: attempts exist, so edits only affect new attempts. */
  attemptCount: z.number(),
  problems: z.array(z.object({ field: z.string(), message: z.string() })),
});

export const quizListSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      status: z.enum(['DRAFT', 'READY']),
      questionCount: z.number(),
      totalPoints: z.number(),
      attemptCount: z.number(),
      updatedAt: z.iso.datetime(),
    }),
  ),
});

// --- Attempts (F19–F21) ------------------------------------------------------------------------

export const answerResponseSchema = z.union([
  z.object({ optionIds: z.array(z.uuid()).max(10) }).strict(),
  z.object({ text: z.string().max(20_000) }).strict(),
  z.object({ number: z.number().finite() }).strict(),
]);

/** The public projection of a question (BR-20): no correctness, accepted answers or explanations. */
export const publicQuestionSchema = z.object({
  type: questionTypeSchema,
  stem: z.unknown(),
  options: z.array(z.object({ id: z.uuid(), content: z.string() })),
  unit: z.string().optional(),
});

export const attemptItemSchema = z.object({
  id: z.uuid(),
  position: z.number(),
  points: z.number(),
  question: publicQuestionSchema,
});

const savedAnswer = z.object({
  response: answerResponseSchema,
  clientSeq: z.number(),
  savedAt: z.iso.datetime(),
});

/** GET /learn/attempts/{id} and the Start response: everything to run or resume an attempt. */
export const attemptViewSchema = z.object({
  id: z.uuid(),
  mode: z.enum(['ASSESSED', 'PRACTICE']),
  quizId: z.uuid().nullable(),
  courseId: z.uuid(),
  title: z.string(),
  status: attemptStatusSchema,
  attemptNumber: z.number().nullable(),
  attemptsAllowed: z.number().nullable(),
  startedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime().nullable(),
  /** The server's clock, so the runner's countdown doesn't depend on the device's clock. */
  serverNow: z.iso.datetime(),
  items: z.array(attemptItemSchema),
  answers: z.record(z.string(), savedAnswer),
  /** Practice only: feedback for questions already checked. */
  feedback: z.record(
    z.string(),
    z.lazy(() => practiceFeedbackSchema),
  ),
  readOnly: z.boolean(),
});

/** PUT /learn/attempts/{id}/answers/{itemId} */
export const saveAnswerSchema = z.object({
  response: answerResponseSchema,
  clientSeq: z.number().int().min(0).max(2_000_000_000),
});
export const saveAnswerResultSchema = z.object({ savedAt: z.iso.datetime(), clientSeq: z.number() });

export const reviewVisibilitySchema = z.object({
  score: z.boolean(),
  details: z.boolean(),
  correctAnswers: z.boolean(),
  opensAt: z.iso.datetime().nullable(),
});

/** GET /learn/attempts/{id}/result (policy-filtered for learners; complete for staff). */
export const attemptResultSchema = z.object({
  id: z.uuid(),
  mode: z.enum(['ASSESSED', 'PRACTICE']),
  quizId: z.uuid().nullable(),
  courseId: z.uuid(),
  quizTitle: z.string(),
  courseTitle: z.string(),
  learnerName: z.string(),
  status: attemptStatusSchema,
  attemptNumber: z.number().nullable(),
  attemptsLeft: z.number().nullable(),
  startedAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  submitKind: z.enum(['MANUAL', 'AUTO']).nullable(),
  timeTakenSeconds: z.number().nullable(),
  visibility: reviewVisibilitySchema,
  score: z.number().nullable(),
  maxScore: z.number().nullable(),
  percent: z.number().nullable(),
  passed: z.boolean().nullable(),
  passMarkPercent: z.number().nullable(),
  items: z.array(
    attemptItemSchema.extend({
      response: answerResponseSchema.nullable(),
      isCorrect: z.boolean().nullable(),
      awardedPoints: z.number().nullable(),
      correct: z.unknown().nullable(),
      explanation: z.unknown().nullable(),
      graderComment: z.string().nullable(),
    }),
  ),
});

const historyItem = z.object({
  id: z.uuid(),
  attemptNumber: z.number().nullable(),
  status: attemptStatusSchema,
  startedAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  /** Null when the feedback policy hides scores (NEVER). */
  percent: z.number().nullable(),
  passed: z.boolean().nullable(),
});

/** GET /learn/quizzes/{id}: the quiz intro (S-L04). */
export const quizIntroSchema = z.object({
  quiz: z.object({
    id: z.uuid(),
    courseId: z.uuid(),
    courseTitle: z.string(),
    title: z.string(),
    instructions: z.unknown().nullable(),
    questionCount: z.number(),
    totalPoints: z.number(),
    timeLimitSeconds: z.number().nullable(),
    attemptsAllowed: z.number().nullable(),
    passMarkPercent: z.number().nullable(),
    opensAt: z.iso.datetime().nullable(),
    closesAt: z.iso.datetime().nullable(),
    feedbackPolicy: feedbackPolicySchema,
  }),
  window: z.enum(['OPEN', 'NOT_YET_OPEN', 'CLOSED']),
  attemptsUsed: z.number(),
  inProgress: z.object({ id: z.uuid(), deadlineAt: z.iso.datetime().nullable() }).nullable(),
  /** Why Start is unavailable, if it is. */
  blocked: z.enum(['NOT_YET_OPEN', 'CLOSED', 'LIMIT_REACHED', 'READ_ONLY', 'NOT_ENROLLED']).nullable(),
  attempts: z.array(historyItem),
  readOnly: z.boolean(),
  serverNow: z.iso.datetime(),
});

/** GET /learn/quizzes/{id}/attempts: the learner's own history. */
export const attemptHistorySchema = z.object({ items: z.array(historyItem) });

// --- Practice (F22) ----------------------------------------------------------------------------

export const practiceStartSchema = z.object({
  count: z.number().int().min(1).max(50).optional(),
  tags: z.array(tag).max(10).default([]),
  difficulty: difficultySchema.optional(),
  mistakesOnly: z.boolean().default(false),
});

/** GET /learn/courses/{id}/practice: what practice can draw from (S-L07 setup). */
export const practiceSetupSchema = z.object({
  courseId: z.uuid(),
  courseTitle: z.string(),
  available: z.number(),
  tags: z.array(z.string()),
  defaultCount: z.number(),
  mistakesModeEnabled: z.boolean(),
  mistakesAvailable: z.number(),
});

export const practiceFeedbackSchema = z.object({
  isCorrect: z.boolean(),
  awardedPoints: z.number(),
  correct: z.unknown().nullable(),
  explanation: z.unknown().nullable(),
});

export const practiceSummarySchema = z.object({
  attemptId: z.uuid(),
  courseId: z.uuid(),
  answered: z.number(),
  total: z.number(),
  score: z.number(),
  maxScore: z.number(),
  percent: z.number(),
  weakTags: z.array(z.object({ tag: z.string(), correct: z.number(), total: z.number() })),
});

// --- Grading, results and analytics (F20, F21, F23) ---------------------------------------------

export const gradingQueueSchema = z.object({
  items: z.array(
    z.object({
      attemptId: z.uuid(),
      itemId: z.uuid(),
      quizTitle: z.string(),
      learnerName: z.string(),
      position: z.number(),
      points: z.number(),
      stem: z.unknown(),
      response: z.string(),
      submittedAt: z.iso.datetime().nullable(),
    }),
  ),
});

export const gradeItemSchema = z.object({
  points: z.number().min(0).max(1000),
  comment: z.string().trim().max(4000).optional(),
});

export const studioAttemptsQuerySchema = z.object({
  quizId: z.uuid().optional(),
  status: attemptStatusSchema.optional(),
});

export const studioAttemptListSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      quizId: z.uuid(),
      quizTitle: z.string(),
      learnerName: z.string(),
      attemptNumber: z.number(),
      status: attemptStatusSchema,
      submittedAt: z.iso.datetime().nullable(),
      percent: z.number().nullable(),
      passed: z.boolean().nullable(),
    }),
  ),
});

export const quizAnalyticsSchema = z.object({
  quizId: z.uuid(),
  attempts: z.number(),
  averagePercent: z.number().nullable(),
  medianPercent: z.number().nullable(),
  passRate: z.number().nullable(),
  /** Ten bands: 0–9 %, 10–19 %, …, 90–100 %. */
  distribution: z.array(z.number()),
  questions: z.array(
    z.object({
      questionId: z.uuid(),
      stemText: z.string(),
      type: questionTypeSchema,
      answered: z.number(),
      correctRate: z.number().nullable(),
      options: z.array(
        z.object({ id: z.uuid(), content: z.string(), isCorrect: z.boolean(), picks: z.number() }),
      ),
    }),
  ),
});

/** GET /me/assessments: open quizzes and recent results for My learning (F16). */
export const myAssessmentsSchema = z.object({
  open: z.array(
    z.object({
      quizId: z.uuid(),
      courseId: z.uuid(),
      title: z.string(),
      courseTitle: z.string(),
      closesAt: z.iso.datetime().nullable(),
      inProgressAttemptId: z.uuid().nullable(),
    }),
  ),
  recent: z.array(
    z.object({
      attemptId: z.uuid(),
      quizTitle: z.string(),
      courseTitle: z.string(),
      status: attemptStatusSchema,
      percent: z.number().nullable(),
      passed: z.boolean().nullable(),
      submittedAt: z.iso.datetime().nullable(),
    }),
  ),
});

export type QuestionType = z.infer<typeof questionTypeSchema>;
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type QuestionView = z.infer<typeof questionViewSchema>;
export type QuestionList = z.infer<typeof questionListSchema>;
export type QuizView = z.infer<typeof quizViewSchema>;
export type QuizList = z.infer<typeof quizListSchema>;
export type AnswerResponse = z.infer<typeof answerResponseSchema>;
export type AttemptView = z.infer<typeof attemptViewSchema>;
export type AttemptResult = z.infer<typeof attemptResultSchema>;
export type QuizIntro = z.infer<typeof quizIntroSchema>;
export type AttemptHistory = z.infer<typeof attemptHistorySchema>;
export type PracticeSetup = z.infer<typeof practiceSetupSchema>;
export type PracticeFeedback = z.infer<typeof practiceFeedbackSchema>;
export type PracticeSummary = z.infer<typeof practiceSummarySchema>;
export type GradingQueue = z.infer<typeof gradingQueueSchema>;
export type StudioAttemptList = z.infer<typeof studioAttemptListSchema>;
export type QuizAnalytics = z.infer<typeof quizAnalyticsSchema>;
export type MyAssessments = z.infer<typeof myAssessmentsSchema>;
