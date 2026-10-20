import { Injectable } from '@nestjs/common';
import {
  type EnrolResponse,
  generalSettingsFrom,
  type MyLearning,
  type Playback,
  type PlayerCourse,
  type PlayerLesson,
  type ProgressResult,
  type ProgressUpdate,
  richTextAssetIds,
} from '@studyhub/contracts';

import type { TenantActor } from '../../identity';
import { MediaService } from '../../media';
import { AppError, isSchoolReadOnly, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { readContentSettings } from '../../tenancy';
import { courseProgress, type LessonProgressStatus, nextLessonState } from '../domain/progress-rules';
import {
  activeEnrollment,
  balanceRequired,
  type CourseForAccess,
  type EnrollmentRow,
  grantFor,
  inCatalogue,
  lockedLessons,
  refusal,
} from './access';

const COURSE_FOR_ACCESS = {
  id: true,
  slug: true,
  title: true,
  status: true,
  ownerMembershipId: true,
  firstPublishedAt: true,
  currency: true,
} as const;

/** A deposit enrolment's unpaid balance for the player (null with full access). */
function balanceView(enrollment: EnrollmentRow, currency: string, now = new Date()) {
  if (enrollment.accessLimitPct === null || enrollment.balanceDueAt === null) return null;
  return {
    amount: { amountMinor: Number(enrollment.balanceMinor ?? 0n), currency },
    dueAt: enrollment.balanceDueAt.toISOString(),
    overdue: enrollment.balanceDueAt <= now,
    lessonPct: enrollment.accessLimitPct,
  };
}

const UNIQUE_VIOLATION = 'P2002';

function requireActor(actor: TenantActor | null): TenantActor {
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

/** Every lesson of a course in reading order (sections by position, then lessons by position). */
async function orderedLessons(tx: TenantTx, courseId: string) {
  const sections = await tx.section.findMany({
    where: { courseId },
    orderBy: { position: 'asc' },
    select: {
      id: true,
      title: true,
      lessons: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          title: true,
          type: true,
          durationSeconds: true,
          isPreview: true,
          isRequired: true,
        },
      },
    },
  });
  return { sections, lessons: sections.flatMap((section) => section.lessons) };
}

/**
 * Learning (F14–F16; 05 §4.6): free enrolment, the course player, progress and My learning. Every
 * query runs in the host's school (RLS), so another school's courses, lessons and enrolments are
 * never found here (07 M6 AC 1).
 */
@Injectable()
export class LearningService {
  constructor(
    private readonly db: TenantDb,
    private readonly media: MediaService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Enrolment (F14)

  /** Free enrolment. Repeating it returns the existing enrolment (PROPOSED 2). */
  async enrol(actor: TenantActor | null, slug: string): Promise<EnrolResponse> {
    const member = requireActor(actor);
    try {
      return await this.db.run((tx) => this.enrolIn(tx, member, slug));
    } catch (error) {
      // Two enrolments raced: the partial unique index kept one (F14 AC 1); return it.
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      return this.db.run((tx) => this.enrolIn(tx, member, slug));
    }
  }

  private async enrolIn(tx: TenantTx, actor: TenantActor, slug: string): Promise<EnrolResponse> {
    const found = await tx.course.findFirst({
      where: { slug },
      select: { ...COURSE_FOR_ACCESS, priceMinor: true, accessDays: true },
    });
    if (found === null || !(await inCatalogue(tx, actor, found))) throw new AppError('NOT_FOUND');
    const course = found;
    const courseId = course.id;
    const { lessons } = await orderedLessons(tx, courseId);
    const existing = await activeEnrollment(tx, actor.membershipId, courseId);
    if (existing !== null) {
      return {
        enrollmentId: existing.id,
        courseId,
        created: false,
        resumeLessonId: existing.lastLessonId ?? lessons[0]?.id ?? null,
      };
    }
    if (course.ownerMembershipId === actor.membershipId) {
      throw new AppError('INVALID_STATE', {
        detail: 'You teach this course, so you open it without enrolling.',
      });
    }
    if (course.priceMinor > 0n) {
      // Paid courses are bought through checkout (M8, BR-09); only free enrolment exists here.
      throw new AppError('INVALID_STATE', { detail: 'This course is paid. Payments are coming soon.' });
    }
    // BR-02 (M9 setting): a school may require a verified email even for free courses.
    const general = generalSettingsFrom(
      await tx.tenantSetting.findMany({
        where: { key: 'unverifiedFreeEnrolment' },
        select: { key: true, value: true },
      }),
    );
    if (!general.unverifiedFreeEnrolment) {
      const account = await tx.userAccount.findUnique({
        where: { id: actor.userId },
        select: { emailVerifiedAt: true },
      });
      if (!account?.emailVerifiedAt) throw new AppError('EMAIL_NOT_VERIFIED');
    }
    const settings = await readContentSettings(tx);
    const days = course.accessDays ?? settings.defaultAccessDays;
    const now = new Date();
    const created = await tx.enrollment.create({
      data: {
        tenantId: requireTenantId(),
        membershipId: actor.membershipId,
        courseId,
        source: 'FREE',
        startedAt: now,
        expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000),
      },
      select: { id: true },
    });
    await tx.course.update({ where: { id: courseId }, data: { enrollmentCount: { increment: 1 } } });
    return { enrollmentId: created.id, courseId, created: true, resumeLessonId: lessons[0]?.id ?? null };
  }

  // ---------------------------------------------------------------------------------------------
  // Player (F15)

  /** Player bootstrap: outline with each lesson's state, progress and the resume point. */
  async course(actor: TenantActor | null, courseId: string): Promise<PlayerCourse> {
    const member = requireActor(actor);
    return this.run(async (tx, expired) => {
      const course = await tx.course.findUnique({ where: { id: courseId }, select: COURSE_FOR_ACCESS });
      if (course === null) throw new AppError('NOT_FOUND');
      const grant = await grantFor(tx, member, course, expired);
      if (grant === null) throw await refusal(tx, member, course);
      const { sections, lessons } = await orderedLessons(tx, courseId);
      const locked = await lockedLessons(tx, grant, courseId);
      const progress =
        grant.enrollment === null
          ? []
          : await tx.lessonProgress.findMany({
              where: { enrollmentId: grant.enrollment.id },
              select: { lessonId: true, status: true, positionSeconds: true },
            });
      const byLesson = new Map(progress.map((p) => [p.lessonId, p]));
      const completed = new Set(progress.filter((p) => p.status === 'COMPLETED').map((p) => p.lessonId));
      const summary = courseProgress(lessons, completed);
      const lastLessonId = grant.enrollment?.lastLessonId ?? null;
      const resumeLesson = lessons.find((lesson) => lesson.id === lastLessonId);
      return {
        course: { id: course.id, slug: course.slug, title: course.title, status: course.status },
        access: grant.access,
        readOnly: isSchoolReadOnly(),
        enrollment:
          grant.enrollment === null
            ? null
            : {
                id: grant.enrollment.id,
                progressPercent: summary.percent,
                completedAt: grant.enrollment.completedAt?.toISOString() ?? null,
                expiresAt: grant.enrollment.expiresAt?.toISOString() ?? null,
                balance: balanceView(grant.enrollment, course.currency),
              },
        sections: sections.map((section) => ({
          id: section.id,
          title: section.title,
          lessons: section.lessons.map((lesson) => ({
            ...lesson,
            locked: locked.has(lesson.id),
            status: (byLesson.get(lesson.id)?.status ?? 'NOT_STARTED') as LessonProgressStatus,
            positionSeconds: byLesson.get(lesson.id)?.positionSeconds ?? 0,
          })),
        })),
        resume:
          resumeLesson === undefined
            ? null
            : {
                lessonId: resumeLesson.id,
                positionSeconds: byLesson.get(resumeLesson.id)?.positionSeconds ?? 0,
              },
        counts: { required: summary.required, completedRequired: summary.completedRequired },
      };
    });
  }

  /** One lesson for the player, or a preview lesson for anyone who can see the catalogue. */
  async lesson(actor: TenantActor | null, lessonId: string): Promise<PlayerLesson> {
    const view = await this.run(async (tx, expired) => {
      const { lesson, course, access, enrollment } = await this.openLesson(tx, actor, lessonId, expired);
      const { lessons } = await orderedLessons(tx, course.id);
      const index = lessons.findIndex((l) => l.id === lesson.id);
      const neighbour = (l: (typeof lessons)[number] | undefined) =>
        l === undefined || access === 'PREVIEW' ? null : { id: l.id, title: l.title };
      const progress =
        enrollment === null
          ? null
          : await tx.lessonProgress.findUnique({
              where: {
                tenantId_enrollmentId_lessonId: {
                  tenantId: requireTenantId(),
                  enrollmentId: enrollment.id,
                  lessonId: lesson.id,
                },
              },
              select: { status: true, positionSeconds: true },
            });
      const video =
        lesson.videoAssetId === null
          ? null
          : await tx.asset.findUnique({
              where: { id: lesson.videoAssetId },
              select: { status: true, durationSeconds: true },
            });
      const attachments = await tx.lessonAttachment.findMany({
        where: { lessonId: lesson.id },
        orderBy: { position: 'asc' },
        select: { assetId: true },
      });
      const files = await tx.asset.findMany({
        where: { id: { in: attachments.map((a) => a.assetId) }, status: 'READY' },
        select: { id: true, originalName: true, mime: true, sizeBytes: true },
      });
      const fileById = new Map(files.map((f) => [f.id, f]));
      const settings = await readContentSettings(tx);
      return {
        id: lesson.id,
        courseId: course.id,
        courseSlug: course.slug,
        courseTitle: course.title,
        title: lesson.title,
        type: lesson.type,
        access,
        readOnly: isSchoolReadOnly(),
        isRequired: lesson.isRequired,
        downloadable: lesson.downloadable,
        durationSeconds: lesson.durationSeconds ?? video?.durationSeconds ?? null,
        content: lesson.contentJson,
        images: {} as Record<string, string>,
        video: video === null ? null : { status: video.status, durationSeconds: video.durationSeconds },
        attachments: attachments.flatMap((a) => {
          const file = fileById.get(a.assetId);
          return file === undefined
            ? []
            : [
                {
                  assetId: file.id,
                  name: file.originalName,
                  mime: file.mime,
                  sizeBytes: Number(file.sizeBytes),
                },
              ];
        }),
        quizId: lesson.quizId,
        progress: enrollment === null ? null : (progress ?? { status: 'NOT_STARTED', positionSeconds: 0 }),
        completionThresholdPct: settings.videoCompletionThresholdPct,
        previous: neighbour(lessons[index - 1]),
        next: neighbour(lessons[index + 1]),
      } satisfies PlayerLesson;
    });
    // Inline images (asset:{id}) become short-lived signed URLs; only this school's assets resolve.
    const imageIds = view.content === null ? [] : [...richTextAssetIds(view.content)];
    const urls = await this.media.readUrls(imageIds);
    return { ...view, images: Object.fromEntries(urls) };
  }

  /** A signed playback URL for the lesson's READY video. */
  async playback(actor: TenantActor | null, lessonId: string): Promise<Playback> {
    const asset = await this.run(async (tx, expired) => {
      const { lesson } = await this.openLesson(tx, actor, lessonId, expired);
      if (lesson.videoAssetId === null) throw new AppError('NOT_FOUND');
      const found = await tx.asset.findUnique({
        where: { id: lesson.videoAssetId },
        select: { status: true, providerVideoId: true, durationSeconds: true },
      });
      if (found === null) throw new AppError('NOT_FOUND');
      return { ...found, durationSeconds: lesson.durationSeconds ?? found.durationSeconds };
    });
    const playback = await this.media.playback(asset);
    return { ...playback, durationSeconds: asset.durationSeconds };
  }

  /** A signed download URL for one of the lesson's files. */
  async fileUrl(actor: TenantActor | null, lessonId: string, assetId: string) {
    const asset = await this.run(async (tx, expired) => {
      const { lesson } = await this.openLesson(tx, actor, lessonId, expired);
      const attached = await tx.lessonAttachment.findFirst({ where: { lessonId: lesson.id, assetId } });
      if (attached === null) throw new AppError('NOT_FOUND');
      const found = await tx.asset.findUnique({
        where: { id: assetId },
        select: { status: true, storageKey: true, storageLocationId: true, originalName: true },
      });
      if (found === null) throw new AppError('NOT_FOUND');
      return found;
    });
    return this.media.fileUrl(asset);
  }

  /**
   * Saves the enrolled learner's progress on a lesson (F15 AC 1) and updates the enrolment's resume
   * point, progress % and completion (BR-22) in the same transaction. Owners and administrators
   * previewing a course are never recorded.
   */
  async saveProgress(
    actor: TenantActor | null,
    lessonId: string,
    input: ProgressUpdate,
  ): Promise<ProgressResult> {
    const member = requireActor(actor);
    return this.run(async (tx, expired) => {
      const { lesson, course, access, enrollment } = await this.openLesson(tx, member, lessonId, expired);
      if (access !== 'ENROLLED' || enrollment === null) throw new AppError('ENROLMENT_INACTIVE');
      // One writer per enrolment at a time; completion is read again under the lock, so it is decided once.
      const [locked] = await tx.$queryRaw<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM enrollment WHERE id = ${enrollment.id}::uuid FOR UPDATE`;
      const alreadyCompleted = (locked?.completed_at ?? null) !== null;
      const tenantId = requireTenantId();
      const key = { tenantId, enrollmentId: enrollment.id, lessonId: lesson.id };
      const current = await tx.lessonProgress.findUnique({
        where: { tenantId_enrollmentId_lessonId: key },
        select: { status: true, positionSeconds: true, completedAt: true },
      });
      const videoDuration =
        lesson.videoAssetId === null
          ? null
          : ((
              await tx.asset.findUnique({
                where: { id: lesson.videoAssetId },
                select: { durationSeconds: true },
              })
            )?.durationSeconds ?? null);
      const settings = await readContentSettings(tx);
      const next = nextLessonState({
        lessonType: lesson.type,
        durationSeconds: lesson.durationSeconds ?? videoDuration,
        thresholdPct: settings.videoCompletionThresholdPct,
        current,
        requested: input,
      });
      const now = new Date();
      const completedAt = next.status === 'COMPLETED' ? (current?.completedAt ?? now) : null;
      await tx.lessonProgress.upsert({
        where: { tenantId_enrollmentId_lessonId: key },
        create: {
          ...key,
          status: next.status,
          positionSeconds: next.positionSeconds,
          completedAt,
          updatedAt: now,
        },
        update: { status: next.status, positionSeconds: next.positionSeconds, completedAt, updatedAt: now },
      });

      const { lessons } = await orderedLessons(tx, course.id);
      const done = await tx.lessonProgress.findMany({
        where: { enrollmentId: enrollment.id, status: 'COMPLETED' },
        select: { lessonId: true },
      });
      const summary = courseProgress(lessons, new Set(done.map((d) => d.lessonId)));
      const completedNow = summary.complete && !alreadyCompleted;
      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: {
          progressPercent: summary.percent,
          lastLessonId: lesson.id,
          lastAccessedAt: now,
          updatedAt: now,
          ...(completedNow && { completedAt: now }),
        },
      });
      return {
        lesson: next,
        progressPercent: summary.percent,
        courseCompleted: completedNow || alreadyCompleted,
        completedNow,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // My learning (F16)

  async myLearning(actor: TenantActor | null): Promise<MyLearning> {
    const member = requireActor(actor);
    const rows = await this.db.run(async (tx) => {
      const enrollments = await tx.enrollment.findMany({
        where: { membershipId: member.membershipId, status: 'ACTIVE' },
        orderBy: [{ lastAccessedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
        take: 200,
        select: {
          id: true,
          startedAt: true,
          expiresAt: true,
          lastAccessedAt: true,
          completedAt: true,
          lastLessonId: true,
          course: {
            select: { id: true, slug: true, title: true, coverAssetId: true, ownerMembershipId: true },
          },
        },
      });
      const now = new Date();
      const live = enrollments.filter((e) => e.expiresAt === null || e.expiresAt > now);
      const expired = enrollments.filter((e) => !live.includes(e));
      if (expired.length > 0 && !isSchoolReadOnly()) {
        await tx.enrollment.updateMany({
          where: { id: { in: expired.map((e) => e.id) } },
          data: { status: 'EXPIRED', updatedAt: now },
        });
      }
      const courseIds = live.map((e) => e.course.id);
      const lessons = await tx.lesson.findMany({
        where: { courseId: { in: courseIds } },
        select: { id: true, courseId: true, title: true, isRequired: true },
      });
      const progress = await tx.lessonProgress.findMany({
        where: { enrollmentId: { in: live.map((e) => e.id) } },
        select: { enrollmentId: true, lessonId: true, status: true, positionSeconds: true },
      });
      const profiles = await tx.instructorProfile.findMany({
        where: { membershipId: { in: live.map((e) => e.course.ownerMembershipId) } },
        select: { membershipId: true, displayName: true },
      });
      return { live, lessons, progress, profiles };
    });
    const covers = await this.media.readUrls(
      rows.live.flatMap((e) => (e.course.coverAssetId === null ? [] : [e.course.coverAssetId])),
    );
    const names = new Map(rows.profiles.map((p) => [p.membershipId, p.displayName]));
    return {
      items: rows.live.map((e) => {
        const lessons = rows.lessons.filter((l) => l.courseId === e.course.id);
        const mine = rows.progress.filter((p) => p.enrollmentId === e.id);
        const completed = new Set(mine.filter((p) => p.status === 'COMPLETED').map((p) => p.lessonId));
        const resumeLesson = lessons.find((l) => l.id === e.lastLessonId);
        return {
          enrollmentId: e.id,
          startedAt: e.startedAt.toISOString(),
          expiresAt: e.expiresAt?.toISOString() ?? null,
          lastAccessedAt: e.lastAccessedAt?.toISOString() ?? null,
          completedAt: e.completedAt?.toISOString() ?? null,
          progressPercent: courseProgress(lessons, completed).percent,
          course: {
            id: e.course.id,
            slug: e.course.slug,
            title: e.course.title,
            coverUrl: e.course.coverAssetId === null ? null : (covers.get(e.course.coverAssetId) ?? null),
            instructorName: names.get(e.course.ownerMembershipId) ?? '',
          },
          resume:
            resumeLesson === undefined
              ? null
              : {
                  lessonId: resumeLesson.id,
                  lessonTitle: resumeLesson.title,
                  positionSeconds: mine.find((p) => p.lessonId === resumeLesson.id)?.positionSeconds ?? 0,
                },
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * One school transaction for a player request. Enrolments found expired on the way are marked
   * EXPIRED; when the request ends in a refusal (rolling that back), they are marked in a second
   * transaction so the status catches up anyway (BR-12).
   */
  private async run<T>(fn: (tx: TenantTx, expired: string[]) => Promise<T>): Promise<T> {
    const expired: string[] = [];
    try {
      return await this.db.run((tx) => fn(tx, expired));
    } catch (error) {
      if (expired.length > 0 && !isSchoolReadOnly()) {
        await this.db.run((tx) =>
          tx.enrollment.updateMany({
            where: { id: { in: expired }, status: 'ACTIVE' },
            data: { status: 'EXPIRED', updatedAt: new Date() },
          }),
        );
      }
      throw error;
    }
  }

  /**
   * A lesson the actor may open, with how they reach it: their enrolment, as owner or administrator,
   * or as a preview of a catalogue course. Locked lessons never return content (F15 AC 2).
   */
  private async openLesson(tx: TenantTx, actor: TenantActor | null, lessonId: string, expired: string[]) {
    const lesson = await tx.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        title: true,
        type: true,
        isPreview: true,
        isRequired: true,
        downloadable: true,
        durationSeconds: true,
        contentJson: true,
        videoAssetId: true,
        quizId: true,
        course: { select: COURSE_FOR_ACCESS },
      },
    });
    if (lesson === null) throw new AppError('NOT_FOUND');
    const course: CourseForAccess & { slug: string; title: string } = lesson.course;
    const grant = await grantFor(tx, actor, course, expired);
    if (grant !== null) {
      // Beyond what a deposit opened: locked until the balance is paid (no content, video or files).
      if (grant.enrollment !== null && (await lockedLessons(tx, grant, course.id)).has(lesson.id)) {
        throw balanceRequired(grant.enrollment, course.id);
      }
      return { lesson, course, access: grant.access, enrollment: grant.enrollment };
    }
    if (lesson.isPreview && (await inCatalogue(tx, actor, course))) {
      return { lesson, course, access: 'PREVIEW' as const, enrollment: null };
    }
    throw await refusal(tx, actor, course);
  }
}
