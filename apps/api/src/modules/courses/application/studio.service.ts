import { Inject, Injectable } from '@nestjs/common';
import {
  type Checklist,
  type LessonDetail,
  type Outline,
  richTextAssetIds,
  richTextToPlain,
  sanitizeRichText,
  type StudioCourse,
} from '@studyhub/contracts';

import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit';
import { paymentsProblem } from '../../commerce';
import type { TenantActor } from '../../identity';
import {
  AppError,
  requireTenantId,
  STORAGE_LOCATIONS,
  type StorageLocations,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { readContentSettings } from '../../tenancy';
import {
  type CourseAction,
  type CourseStatus,
  EDITABLE,
  evaluateChecklist,
  nextFreeSlug,
  nextStatus,
  slugify,
} from '../domain/course-rules';
import { InstructorsService } from './instructors.service';

const COVER_URL_SECONDS = 3600;
/** Reading speed for the estimated duration of text lessons. */
const WORDS_PER_MINUTE = 200;

type LessonRow = {
  id: string;
  title: string;
  type: 'TEXT' | 'VIDEO' | 'FILE' | 'QUIZ';
  position: number;
  isPreview: boolean;
  isRequired: boolean;
  durationSeconds: number | null;
  contentJson: unknown;
  videoAssetId: string | null;
  quizId: string | null;
  attachments: { assetId: string }[];
};

/**
 * Studio: course authoring by the course's owner (F09, F10, F12). Another instructor's course is not
 * found (F09 AC 2); a stale write is a 409 (F09 AC 1: `version`).
 */
@Injectable()
export class StudioService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly instructors: InstructorsService,
    @Inject(STORAGE_LOCATIONS) private readonly locations: StorageLocations,
  ) {}

  // --- Courses -----------------------------------------------------------------------------------

  async list(actor: TenantActor) {
    const rows = await this.db.run(async (tx) => {
      await this.instructors.requireStudioAccess(tx, actor);
      return tx.course.findMany({
        where: { ownerMembershipId: actor.membershipId, status: { not: 'ARCHIVED' } },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, slug: true, title: true, status: true, updatedAt: true, coverAssetId: true },
      });
    });
    const covers = await this.coverUrls(rows.map((r) => r.coverAssetId));
    return {
      courses: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        status: r.status,
        updatedAt: r.updatedAt.toISOString(),
        coverUrl: r.coverAssetId === null ? null : (covers.get(r.coverAssetId) ?? null),
      })),
    };
  }

  async create(
    actor: TenantActor,
    input: { title: string; subjectId?: string | undefined },
  ): Promise<StudioCourse> {
    const id = await this.db.run(async (tx) => {
      await this.instructors.requireStudioAccess(tx, actor);
      if (input.subjectId !== undefined) await this.requireSubject(tx, input.subjectId);
      const course = await tx.course.create({
        data: {
          tenantId: requireTenantId(),
          ownerMembershipId: actor.membershipId,
          title: input.title,
          slug: await this.freeCourseSlug(tx, input.title),
          subjectId: input.subjectId ?? null,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'course.created',
        entityType: 'course',
        entityId: course.id,
        actorId: actor.userId,
      });
      return course.id;
    });
    return this.get(actor, id);
  }

  async get(actor: TenantActor, courseId: string): Promise<StudioCourse> {
    const course = await this.db.run(async (tx) => {
      const found = await this.ownCourse(tx, actor, courseId);
      const note = await tx.courseSubmission.findFirst({
        where: { courseId, decision: 'CHANGES_REQUESTED' },
        orderBy: { decidedAt: 'desc' },
        select: { notes: true },
      });
      return { ...found, reviewNote: note?.notes ?? null };
    });
    const covers = await this.coverUrls([course.coverAssetId]);
    return {
      id: course.id,
      slug: course.slug,
      title: course.title,
      subtitle: course.subtitle,
      description: course.descriptionJson,
      outcomes: course.outcomes,
      requirements: course.requirements,
      level: course.level,
      language: course.language,
      tags: course.tags,
      subjectId: course.subjectId,
      coverAssetId: course.coverAssetId,
      coverUrl: course.coverAssetId === null ? null : (covers.get(course.coverAssetId) ?? null),
      priceMinor: Number(course.priceMinor),
      currency: course.currency,
      accessDays: course.accessDays,
      status: course.status,
      version: course.version,
      publishedAt: course.publishedAt?.toISOString() ?? null,
      updatedAt: course.updatedAt.toISOString(),
      reviewNote: course.reviewNote,
    };
  }

  async update(
    actor: TenantActor,
    courseId: string,
    input: {
      version: number;
      title?: string | undefined;
      subtitle?: string | null | undefined;
      description?: unknown;
      outcomes?: string[] | undefined;
      requirements?: string[] | undefined;
      level?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'ALL_LEVELS' | undefined;
      language?: string | undefined;
      tags?: string[] | undefined;
      subjectId?: string | null | undefined;
      coverAssetId?: string | null | undefined;
      priceMinor?: number | undefined;
      accessDays?: number | null | undefined;
    },
  ): Promise<StudioCourse> {
    await this.db.run(async (tx) => {
      const course = await this.editableCourse(tx, actor, courseId);
      if (course.version !== input.version) throw new AppError('VERSION_CONFLICT');
      if (input.subjectId !== undefined && input.subjectId !== null)
        await this.requireSubject(tx, input.subjectId);
      if (input.coverAssetId !== undefined && input.coverAssetId !== null) {
        await this.requireAssets(tx, [input.coverAssetId], { kind: 'IMAGE', readyOnly: true });
      }
      if (input.description !== undefined && input.description !== null) {
        await this.requireAssets(tx, richTextAssetIds(input.description), { kind: 'IMAGE', readyOnly: true });
      }
      const neverPublished = course.firstPublishedAt === null;
      await tx.course.update({
        where: { id: courseId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          // The address stays fixed once the course has been published (05 §3.3).
          ...(input.title !== undefined &&
            neverPublished &&
            input.title !== course.title && {
              slug: await this.freeCourseSlug(tx, input.title, courseId),
            }),
          ...(input.subtitle !== undefined && { subtitle: input.subtitle }),
          ...(input.description !== undefined && {
            descriptionJson:
              input.description === null ? Prisma.DbNull : (sanitizeRichText(input.description) as object),
            descriptionText: input.description === null ? '' : richTextToPlain(input.description),
          }),
          ...(input.outcomes !== undefined && { outcomes: input.outcomes }),
          ...(input.requirements !== undefined && { requirements: input.requirements }),
          ...(input.level !== undefined && { level: input.level }),
          ...(input.language !== undefined && { language: input.language }),
          ...(input.tags !== undefined && { tags: [...new Set(input.tags)] }),
          ...(input.subjectId !== undefined && { subjectId: input.subjectId }),
          ...(input.coverAssetId !== undefined && { coverAssetId: input.coverAssetId }),
          // A price change applies to new orders only (F12): orders snapshot the price (BR-08).
          ...(input.priceMinor !== undefined && { priceMinor: BigInt(input.priceMinor) }),
          ...(input.accessDays !== undefined && { accessDays: input.accessDays }),
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
    });
    return this.get(actor, courseId);
  }

  // --- Outline -----------------------------------------------------------------------------------

  async outline(actor: TenantActor, courseId: string): Promise<Outline> {
    return this.db.run(async (tx) => {
      const course = await this.ownCourse(tx, actor, courseId);
      const sections = await tx.section.findMany({
        where: { courseId },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          title: true,
          position: true,
          lessons: { orderBy: { position: 'asc' }, select: LESSON_SELECT },
        },
      });
      const ready = await this.readiness(
        tx,
        sections.flatMap((s) => s.lessons),
      );
      return {
        courseId,
        version: course.version,
        sections: sections.map((s) => ({
          id: s.id,
          title: s.title,
          position: s.position,
          lessons: s.lessons.map((l) => this.summary(l, ready.get(l.id) ?? false)),
        })),
      };
    });
  }

  /** Reorders sections and lessons (and moves lessons between sections) in one transaction. */
  async reorder(
    actor: TenantActor,
    courseId: string,
    input: { version: number; sections: { id: string; lessonIds: string[] }[] },
  ): Promise<Outline> {
    await this.db.run(async (tx) => {
      const course = await this.editableCourse(tx, actor, courseId);
      if (course.version !== input.version) throw new AppError('VERSION_CONFLICT');
      const sections = await tx.section.findMany({ where: { courseId }, select: { id: true } });
      const lessons = await tx.lesson.findMany({ where: { courseId }, select: { id: true } });
      const sentSections = input.sections.map((s) => s.id);
      const sentLessons = input.sections.flatMap((s) => s.lessonIds);
      const same = (a: string[], b: string[]) =>
        a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
      if (
        !same(
          sentSections,
          sections.map((s) => s.id),
        ) ||
        !same(
          sentLessons,
          lessons.map((l) => l.id),
        )
      ) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            {
              field: 'sections',
              code: 'incomplete',
              message: 'Send every section and lesson of the course exactly once',
            },
          ],
        });
      }
      // Positions are unique per course/section, checked at commit (deferrable constraints).
      for (const [index, section] of input.sections.entries()) {
        await tx.section.update({ where: { id: section.id }, data: { position: index } });
        for (const [position, lessonId] of section.lessonIds.entries()) {
          await tx.lesson.update({ where: { id: lessonId }, data: { sectionId: section.id, position } });
        }
      }
      await this.touch(tx, courseId);
    });
    return this.outline(actor, courseId);
  }

  async addSection(actor: TenantActor, courseId: string, title: string): Promise<Outline> {
    await this.db.run(async (tx) => {
      await this.editableCourse(tx, actor, courseId);
      const position = await tx.section.count({ where: { courseId } });
      await tx.section.create({ data: { tenantId: requireTenantId(), courseId, title, position } });
      await this.touch(tx, courseId);
    });
    return this.outline(actor, courseId);
  }

  async renameSection(
    actor: TenantActor,
    courseId: string,
    sectionId: string,
    title: string,
  ): Promise<Outline> {
    await this.db.run(async (tx) => {
      await this.editableCourse(tx, actor, courseId);
      const updated = await tx.section.updateMany({ where: { id: sectionId, courseId }, data: { title } });
      if (updated.count === 0) throw new AppError('NOT_FOUND');
      await this.touch(tx, courseId);
    });
    return this.outline(actor, courseId);
  }

  async deleteSection(actor: TenantActor, courseId: string, sectionId: string): Promise<Outline> {
    await this.db.run(async (tx) => {
      await this.editableCourse(tx, actor, courseId);
      const deleted = await tx.section.deleteMany({ where: { id: sectionId, courseId } });
      if (deleted.count === 0) throw new AppError('NOT_FOUND');
      await this.compactSections(tx, courseId);
      await this.touch(tx, courseId);
    });
    return this.outline(actor, courseId);
  }

  // --- Lessons -----------------------------------------------------------------------------------

  async addLesson(
    actor: TenantActor,
    courseId: string,
    input: { sectionId: string; title: string; type: 'TEXT' | 'VIDEO' | 'FILE' | 'QUIZ' },
  ): Promise<LessonDetail> {
    const lessonId = await this.db.run(async (tx) => {
      await this.editableCourse(tx, actor, courseId);
      const section = await tx.section.findFirst({
        where: { id: input.sectionId, courseId },
        select: { id: true },
      });
      if (section === null) throw new AppError('NOT_FOUND');
      const settings = await readContentSettings(tx);
      const position = await tx.lesson.count({ where: { sectionId: input.sectionId } });
      const lesson = await tx.lesson.create({
        data: {
          tenantId: requireTenantId(),
          courseId,
          sectionId: input.sectionId,
          title: input.title,
          type: input.type,
          position,
          // BR-64: school defaults apply to new lessons only.
          downloadable: settings.downloadsAllowedDefault,
        },
        select: { id: true },
      });
      await this.touch(tx, courseId);
      return lesson.id;
    });
    return this.lesson(actor, courseId, lessonId);
  }

  async lesson(actor: TenantActor, courseId: string, lessonId: string): Promise<LessonDetail> {
    return this.db.run(async (tx) => {
      await this.ownCourse(tx, actor, courseId);
      const lesson = await tx.lesson.findFirst({
        where: { id: lessonId, courseId },
        select: { ...LESSON_SELECT, sectionId: true, version: true, downloadable: true },
      });
      if (lesson === null) throw new AppError('NOT_FOUND');
      const assets = await tx.asset.findMany({
        where: { id: { in: lesson.attachments.map((a) => a.assetId) } },
        select: { id: true, originalName: true, status: true, sizeBytes: true },
      });
      const ready = await this.readiness(tx, [lesson]);
      return {
        ...this.summary(lesson, ready.get(lesson.id) ?? false),
        sectionId: lesson.sectionId,
        version: lesson.version,
        content: lesson.contentJson,
        videoAssetId: lesson.videoAssetId,
        quizId: lesson.quizId,
        downloadable: lesson.downloadable,
        attachments: lesson.attachments.map(({ assetId }) => {
          const asset = assets.find((a) => a.id === assetId);
          return {
            assetId,
            name: asset?.originalName ?? '',
            status: asset?.status ?? 'REJECTED',
            sizeBytes: Number(asset?.sizeBytes ?? 0),
          };
        }),
      };
    });
  }

  async updateLesson(
    actor: TenantActor,
    courseId: string,
    lessonId: string,
    input: {
      version: number;
      title?: string | undefined;
      content?: unknown;
      videoAssetId?: string | null | undefined;
      quizId?: string | null | undefined;
      attachmentAssetIds?: string[] | undefined;
      isPreview?: boolean | undefined;
      isRequired?: boolean | undefined;
      downloadable?: boolean | undefined;
    },
  ): Promise<LessonDetail> {
    await this.db.run(async (tx) => {
      await this.editableCourse(tx, actor, courseId);
      const lesson = await tx.lesson.findFirst({
        where: { id: lessonId, courseId },
        select: { version: true, type: true },
      });
      if (lesson === null) throw new AppError('NOT_FOUND');
      if (lesson.version !== input.version) throw new AppError('VERSION_CONFLICT');
      if (input.content !== undefined && input.content !== null) {
        await this.requireAssets(tx, richTextAssetIds(input.content), { kind: 'IMAGE', readyOnly: true });
      }
      let durationSeconds: number | null | undefined;
      if (input.videoAssetId !== undefined && input.videoAssetId !== null) {
        if (lesson.type !== 'VIDEO')
          throw new AppError('INVALID_STATE', { detail: 'Only video lessons have a video.' });
        const [video] = await this.requireAssets(tx, [input.videoAssetId], {
          kind: 'VIDEO',
          readyOnly: false,
        });
        durationSeconds = video?.durationSeconds ?? null;
      }
      if (input.quizId !== undefined && input.quizId !== null) {
        if (lesson.type !== 'QUIZ')
          throw new AppError('INVALID_STATE', { detail: 'Only quiz lessons have a quiz.' });
        const quiz = await tx.quiz.findFirst({ where: { id: input.quizId, courseId }, select: { id: true } });
        if (quiz === null) {
          throw new AppError('VALIDATION_FAILED', {
            errors: [{ field: 'quizId', code: 'unknown', message: 'Choose a quiz of this course' }],
          });
        }
      }
      if (lesson.type === 'TEXT' && input.content !== undefined) {
        const words =
          input.content === null ? 0 : richTextToPlain(input.content).split(' ').filter(Boolean).length;
        durationSeconds = Math.ceil((words / WORDS_PER_MINUTE) * 60);
      }
      if (input.attachmentAssetIds !== undefined) {
        await this.requireAssets(tx, input.attachmentAssetIds, { kind: 'DOCUMENT', readyOnly: false });
        await tx.lessonAttachment.deleteMany({ where: { lessonId } });
        for (const [position, assetId] of [...new Set(input.attachmentAssetIds)].entries()) {
          await tx.lessonAttachment.create({
            data: { tenantId: requireTenantId(), lessonId, assetId, position },
          });
        }
      }
      await tx.lesson.update({
        where: { id: lessonId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.content !== undefined && {
            contentJson: input.content === null ? Prisma.DbNull : (sanitizeRichText(input.content) as object),
          }),
          ...(input.videoAssetId !== undefined && { videoAssetId: input.videoAssetId }),
          ...(input.quizId !== undefined && { quizId: input.quizId }),
          ...(durationSeconds !== undefined && { durationSeconds }),
          ...(input.isPreview !== undefined && { isPreview: input.isPreview }),
          ...(input.isRequired !== undefined && { isRequired: input.isRequired }),
          ...(input.downloadable !== undefined && { downloadable: input.downloadable }),
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await this.touch(tx, courseId);
    });
    return this.lesson(actor, courseId, lessonId);
  }

  async deleteLesson(actor: TenantActor, courseId: string, lessonId: string): Promise<Outline> {
    await this.db.run(async (tx) => {
      await this.editableCourse(tx, actor, courseId);
      const lesson = await tx.lesson.findFirst({
        where: { id: lessonId, courseId },
        select: { sectionId: true },
      });
      if (lesson === null) throw new AppError('NOT_FOUND');
      await tx.lesson.delete({ where: { id: lessonId } });
      const rest = await tx.lesson.findMany({
        where: { sectionId: lesson.sectionId },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      for (const [position, row] of rest.entries())
        await tx.lesson.update({ where: { id: row.id }, data: { position } });
      await this.touch(tx, courseId);
    });
    return this.outline(actor, courseId);
  }

  // --- Checklist and workflow (F12) -------------------------------------------------------------

  async checklist(actor: TenantActor, courseId: string): Promise<Checklist> {
    return this.db.run(async (tx) => this.evaluate(tx, await this.ownCourse(tx, actor, courseId)));
  }

  /** Publish: the checklist must pass; review when the school requires it (BR-05). */
  async submit(actor: TenantActor, courseId: string): Promise<StudioCourse> {
    await this.db.run(async (tx) => {
      const course = await this.ownCourse(tx, actor, courseId);
      await this.instructors.requireStudioAccess(tx, actor);
      const checklist = await this.evaluate(tx, course);
      if (!checklist.ready) {
        throw new AppError('CHECKLIST_INCOMPLETE', {
          extensions: { items: checklist.items.filter((i) => !i.ok) },
        });
      }
      const settings = await readContentSettings(tx);
      const target = nextStatus(course.status, 'submit', {
        reviewRequired: settings.courseReviewRequired,
        everPublished: course.firstPublishedAt !== null,
      });
      if (target === null) throw new AppError('INVALID_STATE');
      await tx.courseSubmission.create({
        data: {
          tenantId: requireTenantId(),
          courseId,
          submittedBy: actor.userId,
          checklistSnapshot: checklist.items,
          ...(target === 'PUBLISHED' && {
            decision: 'APPROVED',
            decidedAt: new Date(),
            notes: 'Published without review',
          }),
        },
      });
      await this.setStatus(tx, courseId, course.status, target, actor.userId);
    });
    return this.get(actor, courseId);
  }

  /** Owner actions: unpublish, publish again, archive. */
  async transition(
    actor: TenantActor,
    courseId: string,
    action: 'unpublish' | 'republish' | 'archive',
  ): Promise<StudioCourse> {
    await this.db.run(async (tx) => {
      const course = await this.ownCourse(tx, actor, courseId);
      if (action === 'republish') await this.instructors.requireStudioAccess(tx, actor);
      const target = nextStatus(course.status, action, {
        reviewRequired: false,
        everPublished: course.firstPublishedAt !== null,
      });
      if (target === null) throw new AppError('INVALID_STATE');
      await this.setStatus(tx, courseId, course.status, target, actor.userId);
    });
    return this.get(actor, courseId);
  }

  /** Shared with the administrator review (CoursesAdminService). */
  async setStatus(
    tx: TenantTx,
    courseId: string,
    from: CourseStatus,
    to: CourseStatus,
    actorId: string,
  ): Promise<void> {
    const now = new Date();
    await tx.course.update({
      where: { id: courseId },
      data: {
        status: to,
        ...(to === 'PUBLISHED' && { publishedAt: now }),
        ...(to === 'ARCHIVED' && { archivedAt: now }),
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    if (to === 'PUBLISHED') {
      await tx.course.updateMany({
        where: { id: courseId, firstPublishedAt: null },
        data: { firstPublishedAt: now },
      });
    }
    await this.audit.record(tx, {
      action: `course.${to.toLowerCase()}`,
      entityType: 'course',
      entityId: courseId,
      actorId,
      before: { status: from },
      after: { status: to },
    });
  }

  async evaluate(
    tx: TenantTx,
    course: {
      id: string;
      title: string;
      subtitle: string | null;
      descriptionText: string;
      subjectId: string | null;
      coverAssetId: string | null;
      outcomes: string[];
      priceMinor: bigint;
      ownerMembershipId: string;
    },
  ): Promise<Checklist> {
    const settings = await readContentSettings(tx);
    const sections = await tx.section.findMany({
      where: { courseId: course.id },
      orderBy: { position: 'asc' },
      select: { lessons: { orderBy: { position: 'asc' }, select: LESSON_SELECT } },
    });
    const ready = await this.readiness(
      tx,
      sections.flatMap((s) => s.lessons),
    );
    const cover =
      course.coverAssetId === null
        ? null
        : await tx.asset.findFirst({ where: { id: course.coverAssetId }, select: { status: true } });
    const items = evaluateChecklist(course.id, {
      title: course.title,
      subtitle: course.subtitle,
      descriptionLength: course.descriptionText.length,
      subjectId: course.subjectId,
      coverReady: cover?.status === 'READY',
      outcomes: course.outcomes.length,
      priceMinor: Number(course.priceMinor),
      minPaidPriceMinor: settings.minPaidPriceMinor,
      paymentsProblem: course.priceMinor > 0n ? await paymentsProblem(tx, course.ownerMembershipId) : null,
      sections: sections.map((s) => ({
        lessons: s.lessons.map((l) => ({ title: l.title, type: l.type, ready: ready.get(l.id) ?? false })),
      })),
    });
    return { ready: items.every((item) => item.ok), items };
  }

  // --- Helpers -----------------------------------------------------------------------------------

  /** The caller's own course; another instructor's (or another school's) is not found. */
  async ownCourse(tx: TenantTx, actor: TenantActor, courseId: string) {
    const course = await tx.course.findFirst({
      where: { id: courseId, ownerMembershipId: actor.membershipId },
    });
    if (course === null) throw new AppError('NOT_FOUND');
    return course;
  }

  private async editableCourse(tx: TenantTx, actor: TenantActor, courseId: string) {
    const course = await this.ownCourse(tx, actor, courseId);
    await this.instructors.requireStudioAccess(tx, actor);
    if (!EDITABLE.has(course.status)) {
      throw new AppError('INVALID_STATE', {
        detail:
          course.status === 'IN_REVIEW'
            ? 'The course is being reviewed.'
            : 'Archived courses can’t be changed.',
      });
    }
    return course;
  }

  private async touch(tx: TenantTx, courseId: string): Promise<void> {
    await tx.course.update({
      where: { id: courseId },
      data: { updatedAt: new Date(), version: { increment: 1 } },
    });
  }

  private async compactSections(tx: TenantTx, courseId: string): Promise<void> {
    const rest = await tx.section.findMany({
      where: { courseId },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    for (const [position, row] of rest.entries())
      await tx.section.update({ where: { id: row.id }, data: { position } });
  }

  private async requireSubject(tx: TenantTx, subjectId: string): Promise<void> {
    const subject = await tx.subject.findFirst({
      where: { id: subjectId, archivedAt: null },
      select: { id: true },
    });
    if (subject === null) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'subjectId', code: 'not_found', message: 'Choose a subject' }],
      });
    }
  }

  /** Assets referenced by content must be this school's, of the right kind (and ready when required). */
  private async requireAssets(
    tx: TenantTx,
    ids: string[],
    rule: { kind: 'IMAGE' | 'DOCUMENT' | 'VIDEO'; readyOnly: boolean },
  ) {
    if (ids.length === 0) return [];
    const assets = await tx.asset.findMany({
      where: { id: { in: ids }, kind: rule.kind, status: rule.readyOnly ? 'READY' : { not: 'REJECTED' } },
      select: { id: true, durationSeconds: true },
    });
    if (assets.length !== new Set(ids).size) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            field: 'asset',
            code: 'invalid',
            message: 'A file is missing, not ready yet, or of the wrong type',
          },
        ],
      });
    }
    return assets;
  }

  private async freeCourseSlug(tx: TenantTx, title: string, exceptId?: string): Promise<string> {
    const base = slugify(title);
    const taken = new Set(
      (
        await tx.course.findMany({
          where: { slug: { startsWith: base }, ...(exceptId !== undefined && { id: { not: exceptId } }) },
          select: { slug: true },
        })
      ).map((c) => c.slug),
    );
    return nextFreeSlug(base, taken);
  }

  /**
   * BR-04 "every lesson has ready content": TEXT has text; VIDEO a READY video; FILE a READY attachment;
   * QUIZ a READY quiz (F18 AC 1: a quiz without questions, or with unsatisfiable draw rules, can't be READY).
   */
  private async readiness(tx: TenantTx, lessons: LessonRow[]): Promise<Map<string, boolean>> {
    const quizIds = lessons.flatMap((l) => (l.quizId === null ? [] : [l.quizId]));
    const readyQuizzes = new Set(
      quizIds.length === 0
        ? []
        : (
            await tx.quiz.findMany({ where: { id: { in: quizIds }, status: 'READY' }, select: { id: true } })
          ).map((q) => q.id),
    );
    const assetIds = lessons.flatMap((l) => [
      ...(l.videoAssetId === null ? [] : [l.videoAssetId]),
      ...l.attachments.map((a) => a.assetId),
    ]);
    const readyAssets = new Set(
      assetIds.length === 0
        ? []
        : (
            await tx.asset.findMany({
              where: { id: { in: assetIds }, status: 'READY' },
              select: { id: true },
            })
          ).map((a) => a.id),
    );
    return new Map(
      lessons.map((l) => {
        switch (l.type) {
          case 'TEXT':
            return [l.id, richTextToPlain(l.contentJson).length > 0];
          case 'VIDEO':
            return [l.id, l.videoAssetId !== null && readyAssets.has(l.videoAssetId)];
          case 'FILE':
            return [l.id, l.attachments.some((a) => readyAssets.has(a.assetId))];
          case 'QUIZ':
            return [l.id, l.quizId !== null && readyQuizzes.has(l.quizId)];
        }
      }),
    );
  }

  private summary(lesson: LessonRow, ready: boolean) {
    return {
      id: lesson.id,
      title: lesson.title,
      type: lesson.type,
      position: lesson.position,
      isPreview: lesson.isPreview,
      isRequired: lesson.isRequired,
      durationSeconds: lesson.durationSeconds,
      ready,
    };
  }

  /** Short-lived URLs for cover images (the web-sized derivative when it exists). */
  async coverUrls(assetIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = assetIds.filter((id): id is string => id !== null);
    if (ids.length === 0) return new Map();
    const assets = await this.db.run((tx) =>
      tx.asset.findMany({
        where: { id: { in: ids }, status: 'READY' },
        select: { id: true, storageKey: true, derivativeKey: true, storageLocationId: true },
      }),
    );
    const entries = await Promise.all(
      assets.map(async (a) => {
        const storage = await this.locations.at(a.storageLocationId, requireTenantId());
        return [
          a.id,
          await storage.presignGet(a.derivativeKey ?? a.storageKey!, {
            expiresSeconds: COVER_URL_SECONDS,
          }),
        ] as const;
      }),
    );
    return new Map(entries);
  }
}

export const LESSON_SELECT = {
  id: true,
  title: true,
  type: true,
  position: true,
  isPreview: true,
  isRequired: true,
  durationSeconds: true,
  contentJson: true,
  videoAssetId: true,
  quizId: true,
  attachments: { select: { assetId: true }, orderBy: { position: 'asc' } },
} as const;

export type { CourseAction };
