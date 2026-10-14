import { z } from 'zod';

import { richTextSchema } from './rich-text';

/**
 * Catalogue and authoring contracts (M5; blueprint 05 §4.2–4.5). Shared by the API and the web app.
 */

// --- Media ------------------------------------------------------------------------------------------

export const assetPurposeSchema = z.enum([
  'COURSE_COVER',
  'AVATAR',
  'LESSON_FILE',
  'LESSON_IMAGE',
  'LESSON_VIDEO',
]);

const fileFields = {
  fileName: z.string().trim().min(1).max(255),
  mime: z.string().trim().toLowerCase().max(120),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

export const uploadRequestSchema = z.object({ purpose: assetPurposeSchema, ...fileFields });
export const createVideoRequestSchema = z.object(fileFields);

export const uploadSlotSchema = z.object({
  assetId: z.uuid(),
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});

export const assetStatusSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['IMAGE', 'DOCUMENT', 'VIDEO']),
  purpose: assetPurposeSchema,
  status: z.enum(['PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'PROCESSING', 'READY', 'REJECTED']),
  originalName: z.string(),
  mime: z.string(),
  sizeBytes: z.number(),
  rejectReason: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationSeconds: z.number().nullable(),
});

// --- Categories (F08) ----------------------------------------------------------------------------------

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, numbers and hyphens')
  .max(80);

export const categoryTreeSchema = z.object({
  categories: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      archived: z.boolean(),
      subjects: z.array(
        z.object({ id: z.uuid(), slug: z.string(), name: z.string(), archived: z.boolean() }),
      ),
    }),
  ),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: slug.optional(),
});
export const createSubjectSchema = z.object({
  categoryId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  slug: slug.optional(),
});
export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  archived: z.boolean().optional(),
});

// --- Instructors (F06, F07) ----------------------------------------------------------------------------

export const instructorStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
]);

export const instructorApplicationSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  headline: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(4000).optional(),
  subjects: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  qualifications: z.string().trim().max(2000).optional(),
});

export const instructorProfileViewSchema = z.object({
  membershipId: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  headline: z.string().nullable(),
  bio: z.string().nullable(),
  subjects: z.array(z.string()),
  qualifications: z.string().nullable(),
  status: instructorStatusSchema,
  decisionNote: z.string().nullable(),
  reapplyAfter: z.iso.datetime().nullable(),
  /** INVITE_ONLY or APPLICATION (BR-56): whether this school takes applications. */
  onboardingMode: z.enum(['INVITE_ONLY', 'APPLICATION']),
});

/** GET /me/instructor: the caller's profile (if any) and how this school adds instructors. */
export const myInstructorSchema = z.object({
  profile: instructorProfileViewSchema.nullable(),
  onboardingMode: z.enum(['INVITE_ONLY', 'APPLICATION']),
});

export const instructorDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'SUSPENDED']),
  note: z.string().trim().max(2000).optional(),
});

// --- Courses (F09, F12) --------------------------------------------------------------------------------

export const courseLevelSchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS']);
export const courseStatusSchema = z.enum([
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'PUBLISHED',
  'UNPUBLISHED',
  'ARCHIVED',
]);
export const lessonTypeSchema = z.enum(['TEXT', 'VIDEO', 'FILE', 'QUIZ']);

const listItem = z.string().trim().min(1).max(160);

export const createCourseSchema = z.object({
  title: z.string().trim().min(5, 'Use at least 5 characters').max(120),
  subjectId: z.uuid().optional(),
});

/** PATCH /studio/courses/{id}: only the fields sent change; `version` is the If-Match guard. */
export const updateCourseSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().trim().min(5).max(120).optional(),
  subtitle: z.string().trim().max(200).nullable().optional(),
  description: richTextSchema.nullable().optional(),
  outcomes: z.array(listItem).max(12).optional(),
  requirements: z.array(listItem).max(12).optional(),
  level: courseLevelSchema.optional(),
  language: z
    .string()
    .regex(/^[a-z]{2,3}$/)
    .optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(5).optional(),
  subjectId: z.uuid().nullable().optional(),
  coverAssetId: z.uuid().nullable().optional(),
  priceMinor: z.number().int().min(0).max(100_000_000).optional(),
  accessDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export const lessonSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  type: lessonTypeSchema,
  position: z.number(),
  isPreview: z.boolean(),
  isRequired: z.boolean(),
  durationSeconds: z.number().nullable(),
  /** Whether the lesson has publishable content (BR-04). */
  ready: z.boolean(),
});

export const outlineSchema = z.object({
  courseId: z.uuid(),
  version: z.number(),
  sections: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      position: z.number(),
      lessons: z.array(lessonSummarySchema),
    }),
  ),
});

/** Reorder in one call: sections in order, each with its lessons in order (lessons may move sections). */
export const reorderOutlineSchema = z.object({
  version: z.number().int().min(1),
  sections: z.array(z.object({ id: z.uuid(), lessonIds: z.array(z.uuid()).max(500) })).max(100),
});

export const createSectionSchema = z.object({ title: z.string().trim().min(1).max(120) });
export const updateSectionSchema = z.object({ title: z.string().trim().min(1).max(120) });

export const createLessonSchema = z.object({
  sectionId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  type: lessonTypeSchema,
});

export const updateLessonSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(120).optional(),
  content: richTextSchema.nullable().optional(),
  videoAssetId: z.uuid().nullable().optional(),
  attachmentAssetIds: z.array(z.uuid()).max(20).optional(),
  isPreview: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  downloadable: z.boolean().optional(),
});

export const lessonDetailSchema = lessonSummarySchema.extend({
  sectionId: z.uuid(),
  version: z.number(),
  content: z.unknown().nullable(),
  videoAssetId: z.uuid().nullable(),
  downloadable: z.boolean(),
  attachments: z.array(
    z.object({ assetId: z.uuid(), name: z.string(), status: z.string(), sizeBytes: z.number() }),
  ),
});

export const checklistItemSchema = z.object({
  key: z.string(),
  ok: z.boolean(),
  message: z.string(),
  /** Studio path that fixes it (S-T08 "Fix" links). */
  fixPath: z.string(),
});
export const checklistSchema = z.object({ ready: z.boolean(), items: z.array(checklistItemSchema) });

export const studioCourseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  description: z.unknown().nullable(),
  outcomes: z.array(z.string()),
  requirements: z.array(z.string()),
  level: courseLevelSchema,
  language: z.string(),
  tags: z.array(z.string()),
  subjectId: z.uuid().nullable(),
  coverAssetId: z.uuid().nullable(),
  coverUrl: z.string().nullable(),
  priceMinor: z.number(),
  currency: z.string(),
  accessDays: z.number().nullable(),
  status: courseStatusSchema,
  version: z.number(),
  publishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  /** Latest moderation note when changes were requested. */
  reviewNote: z.string().nullable(),
});

export const studioCourseListSchema = z.object({
  courses: z.array(
    studioCourseSchema.pick({
      id: true,
      slug: true,
      title: true,
      status: true,
      updatedAt: true,
      coverUrl: true,
    }),
  ),
});

export const reviewDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
  notes: z.string().trim().max(4000).optional(),
});

export const reviewQueueSchema = z.object({
  items: z.array(
    z.object({
      submissionId: z.uuid(),
      courseId: z.uuid(),
      title: z.string(),
      instructorName: z.string(),
      submittedAt: z.iso.datetime(),
      checklist: z.array(checklistItemSchema),
    }),
  ),
});

/** GET /admin/instructor-applications: submitted applications, oldest first. */
export const instructorQueueSchema = z.object({ items: z.array(instructorProfileViewSchema) });

/** GET /admin/courses: every course of the school, newest change first (up to 200). */
export const adminCourseListSchema = z.object({
  courses: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      title: z.string(),
      status: courseStatusSchema,
      updatedAt: z.iso.datetime(),
      instructorName: z.string(),
    }),
  ),
});

// --- Catalogue (F13) -----------------------------------------------------------------------------------

export const catalogueQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().max(80).optional(),
  subject: z.string().max(80).optional(),
  level: courseLevelSchema.optional(),
  price: z.enum(['free', 'paid']).optional(),
  sort: z.enum(['relevance', 'newest', 'popular']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
});

export const courseCardSchema = z.object({
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  coverUrl: z.string().nullable(),
  level: courseLevelSchema,
  priceMinor: z.number(),
  currency: z.string(),
  lessonCount: z.number(),
  durationSeconds: z.number(),
  instructor: z.object({ name: z.string(), slug: z.string().nullable() }),
  subject: z.object({ slug: z.string(), name: z.string() }).nullable(),
});

export const catalogueResponseSchema = z.object({
  items: z.array(courseCardSchema),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});

export const courseLandingSchema = courseCardSchema.extend({
  description: z.unknown().nullable(),
  outcomes: z.array(z.string()),
  requirements: z.array(z.string()),
  language: z.string(),
  publishedAt: z.iso.datetime().nullable(),
  sections: z.array(
    z.object({
      title: z.string(),
      lessons: z.array(
        z.object({
          title: z.string(),
          type: lessonTypeSchema,
          durationSeconds: z.number().nullable(),
          isPreview: z.boolean(),
        }),
      ),
    }),
  ),
  instructorProfile: z
    .object({
      name: z.string(),
      slug: z.string(),
      headline: z.string().nullable(),
      bio: z.string().nullable(),
    })
    .nullable(),
});

export const instructorPageSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  headline: z.string().nullable(),
  bio: z.string().nullable(),
  subjects: z.array(z.string()),
  courses: z.array(courseCardSchema),
});

export type CourseCard = z.infer<typeof courseCardSchema>;
export type CatalogueResponse = z.infer<typeof catalogueResponseSchema>;
export type CourseLanding = z.infer<typeof courseLandingSchema>;
export type StudioCourse = z.infer<typeof studioCourseSchema>;
export type Outline = z.infer<typeof outlineSchema>;
export type LessonDetail = z.infer<typeof lessonDetailSchema>;
export type Checklist = z.infer<typeof checklistSchema>;
export type CategoryTree = z.infer<typeof categoryTreeSchema>;
export type InstructorProfileView = z.infer<typeof instructorProfileViewSchema>;
export type MyInstructor = z.infer<typeof myInstructorSchema>;
export type InstructorPage = z.infer<typeof instructorPageSchema>;
export type ReviewQueue = z.infer<typeof reviewQueueSchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type UploadSlot = z.infer<typeof uploadSlotSchema>;
