import { Injectable } from '@nestjs/common';
import type { AdminEnrollments, CourseLearners, CourseViewer } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { readContentSettings } from '../../tenancy';
import { courseProgress } from '../domain/progress-rules';
import { activeEnrollment } from './access';

const name = (m: { displayNameOverride: string | null; user: { displayName: string } }) =>
  m.displayNameOverride ?? m.user.displayName;

/**
 * Enrolments seen from the course side: the landing page's view of the visitor (05 §4.3 `viewer`),
 * the instructor's learner list (S-T09), and administrators' grants and revocations (F14).
 */
@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** What the landing page offers this visitor: Enrol, Continue, or open as owner/administrator. */
  async viewer(
    actor: TenantActor | null,
    course: { id: string; ownerMembershipId: string; priceMinor: number },
  ): Promise<CourseViewer> {
    const isOwner = actor !== null && actor.membershipId === course.ownerMembershipId;
    const base = {
      signedIn: actor !== null,
      isOwner,
      canOpenWithoutEnrolment: isOwner || can(actor, 'admin.access'),
    };
    if (actor === null) return { ...base, enrollment: null, canEnrolFree: course.priceMinor === 0 };
    return this.db.run(async (tx) => {
      const enrollment = await activeEnrollment(tx, actor.membershipId, course.id);
      if (enrollment === null) {
        return { ...base, enrollment: null, canEnrolFree: course.priceMinor === 0 && !isOwner };
      }
      const resume =
        enrollment.lastLessonId === null
          ? null
          : await tx.lesson.findUnique({
              where: { id: enrollment.lastLessonId },
              select: { id: true, title: true },
            });
      return {
        ...base,
        enrollment: {
          id: enrollment.id,
          progressPercent: enrollment.progressPercent,
          resumeLessonId: resume?.id ?? null,
          resumeLessonTitle: resume?.title ?? null,
          completed: enrollment.completedAt !== null,
        },
        canEnrolFree: false,
      };
    });
  }

  /** S-T09: the course owner's learners with progress (display names only, Q-PRIV-2). */
  async learners(actor: TenantActor, courseId: string): Promise<CourseLearners> {
    return this.db.run(async (tx) => {
      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { ownerMembershipId: true },
      });
      if (course === null || course.ownerMembershipId !== actor.membershipId) throw new AppError('NOT_FOUND');
      if (!can(actor, 'studio.access')) throw new AppError('FORBIDDEN');
      const rows = await this.enrollmentsOf(tx, courseId, ['ACTIVE']);
      return {
        items: rows.map((r) => ({
          enrollmentId: r.id,
          name: r.name,
          source: r.source,
          startedAt: r.startedAt,
          progressPercent: r.progressPercent,
          completedAt: r.completedAt,
          lastAccessedAt: r.lastAccessedAt,
        })),
      };
    });
  }

  /** An administrator's view of every enrolment of a course, for grant and revoke. */
  async forAdmin(actor: TenantActor, courseId: string): Promise<AdminEnrollments> {
    this.requireAdmin(actor);
    return this.db.run(async (tx) => {
      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { id: true, title: true, status: true },
      });
      if (course === null) throw new AppError('NOT_FOUND');
      const rows = await this.enrollmentsOf(tx, courseId, ['ACTIVE', 'EXPIRED', 'REVOKED']);
      return {
        course,
        items: rows.map((r) => ({
          enrollmentId: r.id,
          name: r.name,
          email: r.email,
          source: r.source,
          status: r.status,
          startedAt: r.startedAt,
          expiresAt: r.expiresAt,
          progressPercent: r.progressPercent,
          grantReason: r.grantReason,
          revokeReason: r.revokeReason,
        })),
      };
    });
  }

  /** F14 ADMIN_GRANT: gives a member of this school access to a course (paid ones too), audited. */
  async grant(actor: TenantActor, courseId: string, input: { email: string; reason: string }) {
    this.requireAdmin(actor);
    return this.db.run(async (tx) => {
      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { id: true, firstPublishedAt: true, accessDays: true, ownerMembershipId: true },
      });
      if (course === null) throw new AppError('NOT_FOUND');
      if (course.firstPublishedAt === null) {
        throw new AppError('INVALID_STATE', { detail: 'Only published courses can be granted.' });
      }
      const membership = await tx.tenantMembership.findFirst({
        where: { status: 'ACTIVE', user: { email: input.email } },
        select: { id: true },
      });
      if (membership === null) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            {
              field: 'email',
              code: 'not_member',
              message: 'No active member of this school has that email.',
            },
          ],
        });
      }
      if (membership.id === course.ownerMembershipId) {
        throw new AppError('INVALID_STATE', { detail: 'The course owner opens it without enrolling.' });
      }
      if ((await activeEnrollment(tx, membership.id, courseId)) !== null)
        throw new AppError('ALREADY_ENROLLED');
      const settings = await readContentSettings(tx);
      const days = course.accessDays ?? settings.defaultAccessDays;
      const now = new Date();
      const created = await tx.enrollment.create({
        data: {
          tenantId: requireTenantId(),
          membershipId: membership.id,
          courseId,
          source: 'ADMIN_GRANT',
          grantedBy: actor.membershipId,
          grantReason: input.reason,
          startedAt: now,
          expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000),
        },
        select: { id: true },
      });
      await tx.course.update({ where: { id: courseId }, data: { enrollmentCount: { increment: 1 } } });
      await this.audit.record(tx, {
        action: 'enrollment.granted',
        entityType: 'enrollment',
        entityId: created.id,
        actorId: actor.userId,
        after: { courseId, membershipId: membership.id, reason: input.reason },
      });
      return { enrollmentId: created.id };
    });
  }

  /** Revokes an enrolment; access ends on the learner's next request (F14 AC 2). Audited. */
  async revoke(actor: TenantActor, enrollmentId: string, reason: string): Promise<void> {
    this.requireAdmin(actor);
    await this.db.run(async (tx) => {
      const enrollment = await tx.enrollment.findUnique({
        where: { id: enrollmentId },
        select: { id: true, status: true, courseId: true, membershipId: true },
      });
      if (enrollment === null) throw new AppError('NOT_FOUND');
      if (enrollment.status !== 'ACTIVE') throw new AppError('INVALID_STATE');
      await tx.enrollment.update({
        where: { id: enrollmentId },
        data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason, updatedAt: new Date() },
      });
      await this.audit.record(tx, {
        action: 'enrollment.revoked',
        entityType: 'enrollment',
        entityId: enrollmentId,
        actorId: actor.userId,
        before: { status: 'ACTIVE' },
        after: {
          status: 'REVOKED',
          reason,
          courseId: enrollment.courseId,
          membershipId: enrollment.membershipId,
        },
      });
    });
  }

  // ---------------------------------------------------------------------------------------------

  private requireAdmin(actor: TenantActor): void {
    if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
  }

  /** Enrolments of a course with names and live progress, newest first (up to 500). */
  private async enrollmentsOf(
    tx: TenantTx,
    courseId: string,
    statuses: ('ACTIVE' | 'EXPIRED' | 'REVOKED')[],
  ) {
    const rows = await tx.enrollment.findMany({
      where: { courseId, status: { in: statuses } },
      orderBy: { startedAt: 'desc' },
      take: 500,
      select: {
        id: true,
        source: true,
        status: true,
        startedAt: true,
        expiresAt: true,
        completedAt: true,
        lastAccessedAt: true,
        grantReason: true,
        revokeReason: true,
        membership: {
          select: { displayNameOverride: true, user: { select: { displayName: true, email: true } } },
        },
      },
    });
    const lessons = await tx.lesson.findMany({ where: { courseId }, select: { id: true, isRequired: true } });
    const done = await tx.lessonProgress.findMany({
      where: { enrollmentId: { in: rows.map((r) => r.id) }, status: 'COMPLETED' },
      select: { enrollmentId: true, lessonId: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: name(r.membership),
      email: r.membership.user.email,
      source: r.source,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      lastAccessedAt: r.lastAccessedAt?.toISOString() ?? null,
      grantReason: r.grantReason,
      revokeReason: r.revokeReason,
      progressPercent: courseProgress(
        lessons,
        new Set(done.filter((d) => d.enrollmentId === r.id).map((d) => d.lessonId)),
      ).percent,
    }));
  }
}
