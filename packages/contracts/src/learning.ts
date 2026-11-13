import { z } from 'zod';

import { coursePeriodRefSchema, lessonTypeSchema } from './content';
import { emailSchema } from './identity';

/**
 * Learning contracts (M6; blueprint 05 §4.6, F14–F16). Shared by the API and the web app.
 */

export const enrollmentStatusSchema = z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']);
export const enrollmentSourceSchema = z.enum(['FREE', 'PURCHASE', 'ADMIN_GRANT']);
export const lessonProgressStatusSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']);

/**
 * How the viewer reaches a course's content: their enrolment, as its owner or a school administrator
 * (F14 AC 3), or only its preview lessons.
 */
export const learnAccessSchema = z.enum(['ENROLLED', 'OWNER', 'ADMIN', 'PREVIEW']);

/** POST /courses/{id}/enrol (free courses; repeating it returns the existing enrolment). */
export const enrolResponseSchema = z.object({
  enrollmentId: z.uuid(),
  courseId: z.uuid(),
  created: z.boolean(),
  resumeLessonId: z.uuid().nullable(),
});

const lessonStateFields = {
  status: lessonProgressStatusSchema,
  positionSeconds: z.number(),
};

/** GET /learn/courses/{id}: player bootstrap (outline, progress, resume point). */
export const playerCourseSchema = z.object({
  course: z.object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']),
  }),
  access: learnAccessSchema.exclude(['PREVIEW']),
  /** The school is suspended (BR-52): content is readable, nothing is saved. */
  readOnly: z.boolean(),
  enrollment: z
    .object({
      id: z.uuid(),
      progressPercent: z.number(),
      completedAt: z.iso.datetime().nullable(),
      expiresAt: z.iso.datetime().nullable(),
      /** A deposit enrolment with its balance unpaid: only `lessonPct` % of the lessons are open. */
      balance: z
        .object({
          amount: z.object({ amountMinor: z.number().int(), currency: z.string().length(3) }),
          dueAt: z.iso.datetime(),
          overdue: z.boolean(),
          lessonPct: z.number().int(),
        })
        .nullable(),
    })
    .nullable(),
  sections: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      lessons: z.array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          type: lessonTypeSchema,
          durationSeconds: z.number().nullable(),
          period: coursePeriodRefSchema.nullable(),
          isPreview: z.boolean(),
          isRequired: z.boolean(),
          periodLocked: z.boolean(),
          /** Before the course opens (`lock`), or beyond what the deposit opened (balance first). */
          locked: z.boolean(),
          ...lessonStateFields,
        }),
      ),
    }),
  ),
  resume: z.object({ lessonId: z.uuid(), positionSeconds: z.number() }).nullable(),
  counts: z.object({ required: z.number(), completedRequired: z.number() }),
});

/** GET /learn/lessons/{id}: one lesson's content for the player (or a preview). */
export const playerLessonSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  courseSlug: z.string(),
  courseTitle: z.string(),
  title: z.string(),
  type: lessonTypeSchema,
  access: learnAccessSchema,
  readOnly: z.boolean(),
  isRequired: z.boolean(),
  /** Learners may save the lesson's files (and video, where offered); else stream and view only. */
  downloadable: z.boolean(),
  /** Protected content (docs/design/content-protection.md): show the watermark; no copying or printing. */
  protection: z.object({ watermark: z.string() }).nullable(),
  durationSeconds: z.number().nullable(),
  /** Allowlisted rich text (F10); images reference `asset:{id}`, resolved through `images`. */
  content: z.unknown().nullable(),
  images: z.record(z.string(), z.string()),
  video: z
    .object({
      status: z.enum(['PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'PROCESSING', 'READY', 'REJECTED']),
      durationSeconds: z.number().nullable(),
      /** The video can be saved for offline viewing (downloads allowed and the video service offers it). */
      downloadable: z.boolean(),
    })
    .nullable(),
  attachments: z.array(
    z.object({ assetId: z.uuid(), name: z.string(), mime: z.string(), sizeBytes: z.number() }),
  ),
  /** QUIZ lessons: the quiz to take (its intro shows rules, attempts and results). */
  quizId: z.uuid().nullable(),
  /** The viewer's own progress (enrolled learners only). */
  progress: z.object(lessonStateFields).nullable(),
  /** The video completion threshold of this school (BR-64 `videoCompletionThresholdPct`). */
  completionThresholdPct: z.number(),
  previous: z.object({ id: z.uuid(), title: z.string() }).nullable(),
  next: z.object({ id: z.uuid(), title: z.string() }).nullable(),
});

/** GET /learn/lessons/{id}/playback: how to play the lesson's video. */
export const playbackSchema = z.object({
  /** `simulated`: the development provider keeps no video bytes; the player simulates playback. */
  kind: z.enum(['hls', 'mp4', 'simulated']),
  url: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  expiresAt: z.iso.datetime(),
});

/** GET /learn/lessons/{id}/files/{assetId}/url */
export const signedUrlSchema = z.object({ url: z.string(), expiresAt: z.iso.datetime() });

/** PUT /learn/lessons/{id}/progress */
export const progressUpdateSchema = z
  .object({
    status: z.enum(['IN_PROGRESS', 'COMPLETED']).optional(),
    positionSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .refine((value) => value.status !== undefined || value.positionSeconds !== undefined, {
    message: 'Send a status or a position',
  });

export const progressResultSchema = z.object({
  lesson: z.object(lessonStateFields),
  progressPercent: z.number(),
  courseCompleted: z.boolean(),
  /** This update completed the course (BR-22): the player shows the completion screen. */
  completedNow: z.boolean(),
});

/** GET /me/enrollments: My learning (F16), most recently used first. */
export const myLearningSchema = z.object({
  items: z.array(
    z.object({
      enrollmentId: z.uuid(),
      startedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable(),
      lastAccessedAt: z.iso.datetime().nullable(),
      completedAt: z.iso.datetime().nullable(),
      progressPercent: z.number(),
      course: z.object({
        id: z.uuid(),
        slug: z.string(),
        title: z.string(),
        coverUrl: z.string().nullable(),
        instructorName: z.string(),
      }),
      resume: z
        .object({ lessonId: z.uuid(), lessonTitle: z.string(), positionSeconds: z.number() })
        .nullable(),
    }),
  ),
});

/** GET /studio/courses/{id}/learners (S-T09): display names only (Q-PRIV-2). */
export const courseLearnersSchema = z.object({
  items: z.array(
    z.object({
      enrollmentId: z.uuid(),
      name: z.string(),
      source: enrollmentSourceSchema,
      startedAt: z.iso.datetime(),
      progressPercent: z.number(),
      completedAt: z.iso.datetime().nullable(),
      lastAccessedAt: z.iso.datetime().nullable(),
    }),
  ),
});

/** GET /admin/courses/{id}/enrollments: every enrolment of the course, for grant and revoke. */
export const adminEnrollmentsSchema = z.object({
  course: z.object({ id: z.uuid(), title: z.string(), status: z.string() }),
  items: z.array(
    z.object({
      enrollmentId: z.uuid(),
      name: z.string(),
      email: z.string(),
      source: enrollmentSourceSchema,
      status: enrollmentStatusSchema,
      startedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable(),
      progressPercent: z.number(),
      grantReason: z.string().nullable(),
      revokeReason: z.string().nullable(),
    }),
  ),
});

export const grantEnrollmentSchema = z.object({
  email: emailSchema,
  reason: z.string().trim().min(3).max(2000),
});

export const revokeEnrollmentSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

export type EnrolResponse = z.infer<typeof enrolResponseSchema>;
export type PlayerCourse = z.infer<typeof playerCourseSchema>;
export type PlayerLesson = z.infer<typeof playerLessonSchema>;
export type Playback = z.infer<typeof playbackSchema>;
export type ProgressUpdate = z.infer<typeof progressUpdateSchema>;
export type ProgressResult = z.infer<typeof progressResultSchema>;
export type MyLearning = z.infer<typeof myLearningSchema>;
export type CourseLearners = z.infer<typeof courseLearnersSchema>;
export type AdminEnrollments = z.infer<typeof adminEnrollmentsSchema>;
export type LearnAccess = z.infer<typeof learnAccessSchema>;
export type LessonProgressStatus = z.infer<typeof lessonProgressStatusSchema>;
