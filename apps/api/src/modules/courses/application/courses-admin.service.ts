import { Injectable } from '@nestjs/common';
import type { ReviewQueue } from '@studyhub/contracts';

import { can, type TenantActor } from '../../identity';
import { AppError, TenantDb } from '../../platform';
import { nextStatus } from '../domain/course-rules';
import { StudioService } from './studio.service';

/** Course moderation and oversight by school administrators (F12, S-AD02, S-AD06). */
@Injectable()
export class CoursesAdminService {
  constructor(
    private readonly db: TenantDb,
    private readonly studio: StudioService,
  ) {}

  async reviewQueue(actor: TenantActor): Promise<ReviewQueue> {
    this.requireAdmin(actor);
    return this.db.run(async (tx) => {
      const open = await tx.courseSubmission.findMany({
        where: { decision: null, course: { status: 'IN_REVIEW' } },
        orderBy: { submittedAt: 'asc' },
        select: {
          id: true,
          submittedAt: true,
          checklistSnapshot: true,
          course: { select: { id: true, title: true, ownerMembershipId: true } },
        },
      });
      const owners = await tx.instructorProfile.findMany({
        where: { membershipId: { in: open.map((s) => s.course.ownerMembershipId) } },
        select: { membershipId: true, displayName: true },
      });
      return {
        items: open.map((s) => ({
          submissionId: s.id,
          courseId: s.course.id,
          title: s.course.title,
          instructorName:
            owners.find((o) => o.membershipId === s.course.ownerMembershipId)?.displayName ?? '',
          submittedAt: s.submittedAt.toISOString(),
          checklist: s.checklistSnapshot as ReviewQueue['items'][number]['checklist'],
        })),
      };
    });
  }

  /** Approve (→ PUBLISHED) or request changes (→ CHANGES_REQUESTED, note required). */
  async decide(
    actor: TenantActor,
    courseId: string,
    input: { decision: 'APPROVED' | 'CHANGES_REQUESTED'; notes?: string | undefined },
  ): Promise<void> {
    this.requireAdmin(actor);
    if (input.decision === 'CHANGES_REQUESTED' && (input.notes ?? '').length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'notes', code: 'required', message: 'Say what needs to change' }],
      });
    }
    await this.db.run(async (tx) => {
      const course = await tx.course.findFirst({ where: { id: courseId } });
      if (course === null) throw new AppError('NOT_FOUND');
      const target = nextStatus(course.status, input.decision === 'APPROVED' ? 'approve' : 'requestChanges', {
        reviewRequired: true,
        everPublished: course.firstPublishedAt !== null,
      });
      if (target === null) throw new AppError('INVALID_STATE');
      await tx.courseSubmission.updateMany({
        where: { courseId, decision: null },
        data: {
          decision: input.decision,
          decidedBy: actor.userId,
          decidedAt: new Date(),
          notes: input.notes ?? null,
        },
      });
      await this.studio.setStatus(tx, courseId, course.status, target, actor.userId);
    });
  }

  /** All courses of the school (S-AD06), optionally by status. */
  async courses(actor: TenantActor, status?: string) {
    this.requireAdmin(actor);
    return this.db.run(async (tx) => {
      const rows = await tx.course.findMany({
        where: status === undefined ? {} : { status: status as never },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        select: { id: true, slug: true, title: true, status: true, updatedAt: true, ownerMembershipId: true },
      });
      const owners = await tx.instructorProfile.findMany({
        where: { membershipId: { in: rows.map((r) => r.ownerMembershipId) } },
        select: { membershipId: true, displayName: true },
      });
      return {
        courses: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          status: r.status,
          updatedAt: r.updatedAt.toISOString(),
          instructorName: owners.find((o) => o.membershipId === r.ownerMembershipId)?.displayName ?? '',
        })),
      };
    });
  }

  /** Administrators can take a published course off the catalogue, with a reason (audited). */
  async unpublish(actor: TenantActor, courseId: string, reason: string): Promise<void> {
    this.requireAdmin(actor);
    if (reason.trim().length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'reason', code: 'required', message: 'Give a reason' }],
      });
    }
    await this.db.run(async (tx) => {
      const course = await tx.course.findFirst({ where: { id: courseId } });
      if (course === null) throw new AppError('NOT_FOUND');
      if (course.status !== 'PUBLISHED') throw new AppError('INVALID_STATE');
      await this.studio.setStatus(tx, courseId, course.status, 'UNPUBLISHED', actor.userId);
      await tx.courseSubmission.create({
        data: {
          tenantId: course.tenantId,
          courseId,
          submittedBy: actor.userId,
          checklistSnapshot: [],
          decision: 'CHANGES_REQUESTED',
          decidedBy: actor.userId,
          decidedAt: new Date(),
          notes: `Unpublished by an administrator: ${reason.trim()}`,
        },
      });
    });
  }

  private requireAdmin(actor: TenantActor): void {
    if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
  }
}
