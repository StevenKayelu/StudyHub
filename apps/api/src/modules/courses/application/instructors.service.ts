import { Injectable } from '@nestjs/common';
import type { InstructorProfileView } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { enforceLimit, readContentSettings, readFeatures, requireFeature } from '../../tenancy';
import { nextFreeSlug, slugify } from '../domain/course-rules';

const REAPPLY_AFTER_MS = 30 * 24 * 3600_000;

type ProfileRow = Awaited<ReturnType<TenantTx['instructorProfile']['findUnique']>>;

/**
 * Instructors (F06, F07, BR-03, BR-28, BR-56). A school adds instructors by invitation (INVITE_ONLY,
 * the default; M4) or takes applications (APPLICATION) that an administrator approves. Approval grants
 * the INSTRUCTOR role. A profile exists per membership; SUSPENDED blocks Studio and hides the
 * instructor's courses from the catalogue (BR-28).
 */
@Injectable()
export class InstructorsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** The caller's profile or application (null when none), and how this school onboards instructors. */
  async mine(
    actor: TenantActor,
  ): Promise<{ profile: InstructorProfileView | null; onboardingMode: 'INVITE_ONLY' | 'APPLICATION' }> {
    return this.db.run(async (tx) => {
      const settings = await readContentSettings(tx);
      const onboardingMode = (await readFeatures(tx)).instructorApplications
        ? settings.instructorOnboardingMode
        : 'INVITE_ONLY';
      const profile = await tx.instructorProfile.findUnique({ where: { membershipId: actor.membershipId } });
      return {
        profile: profile === null ? null : this.view(profile, onboardingMode),
        onboardingMode,
      };
    });
  }

  /** Saves the application draft (APPLICATION schools) or the profile of an approved instructor. */
  async save(
    actor: TenantActor,
    input: {
      displayName: string;
      headline?: string | undefined;
      bio?: string | undefined;
      subjects: string[];
      qualifications?: string | undefined;
    },
  ): Promise<InstructorProfileView> {
    return this.db.run(async (tx) => {
      const settings = await readContentSettings(tx);
      const isInstructor = can(actor, 'studio.access');
      if (!isInstructor) await requireFeature(tx, 'instructorApplications');
      if (!isInstructor && settings.instructorOnboardingMode !== 'APPLICATION') {
        throw new AppError('FORBIDDEN', { detail: 'This school adds instructors by invitation.' });
      }
      if (!isInstructor) await this.requireVerifiedEmail(tx, actor);
      const existing = await tx.instructorProfile.findUnique({ where: { membershipId: actor.membershipId } });
      if (
        existing !== null &&
        !isInstructor &&
        !['DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(existing.status)
      ) {
        throw new AppError('INVALID_STATE', { detail: 'Your application is being reviewed.' });
      }
      const data = {
        displayName: input.displayName,
        headline: input.headline ?? null,
        bio: input.bio ?? null,
        subjects: input.subjects,
        qualifications: input.qualifications ?? null,
        updatedAt: new Date(),
      };
      const saved =
        existing === null
          ? await tx.instructorProfile.create({
              data: {
                ...data,
                membershipId: actor.membershipId,
                tenantId: requireTenantId(),
                slug: await this.freeSlug(tx, input.displayName),
                status: isInstructor ? 'APPROVED' : 'DRAFT',
              },
            })
          : await tx.instructorProfile.update({
              where: { membershipId: actor.membershipId },
              data: { ...data, version: { increment: 1 } },
            });
      return this.view(saved, settings.instructorOnboardingMode);
    });
  }

  /** DRAFT / CHANGES_REQUESTED / REJECTED (after the waiting period) → SUBMITTED. */
  async submit(actor: TenantActor): Promise<InstructorProfileView> {
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'instructorApplications');
      const settings = await readContentSettings(tx);
      if (settings.instructorOnboardingMode !== 'APPLICATION') throw new AppError('FORBIDDEN');
      await this.requireVerifiedEmail(tx, actor);
      const profile = await tx.instructorProfile.findUnique({ where: { membershipId: actor.membershipId } });
      if (profile === null) throw new AppError('NOT_FOUND');
      const waiting =
        profile.status === 'REJECTED' && profile.reapplyAfter !== null && profile.reapplyAfter > new Date();
      if (!['DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(profile.status) || waiting) {
        throw new AppError('INVALID_STATE', {
          detail: waiting
            ? 'You can apply again after the waiting period.'
            : 'This application is already submitted.',
        });
      }
      const saved = await tx.instructorProfile.update({
        where: { membershipId: actor.membershipId },
        data: { status: 'SUBMITTED', submittedAt: new Date(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'instructor.applied',
        entityType: 'instructor_profile',
        entityId: actor.membershipId,
        actorId: actor.userId,
      });
      return this.view(saved, settings.instructorOnboardingMode);
    });
  }

  /** Administrators: applications waiting for a decision (S-AD02). */
  async queue(actor: TenantActor) {
    this.requireAdmin(actor);
    const rows = await this.db.run((tx) =>
      tx.instructorProfile.findMany({ where: { status: 'SUBMITTED' }, orderBy: { submittedAt: 'asc' } }),
    );
    return { items: rows.map((row) => this.view(row, 'APPLICATION')) };
  }

  /** Decision on an application, or suspension of an instructor (audited with the reason, F06 AC 2). */
  async decide(
    actor: TenantActor,
    membershipId: string,
    input: {
      decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'SUSPENDED';
      note?: string | undefined;
    },
  ): Promise<void> {
    this.requireAdmin(actor);
    await this.db.run(async (tx) => {
      const profile = await tx.instructorProfile.findUnique({ where: { membershipId } });
      if (profile === null) throw new AppError('NOT_FOUND');
      const allowed: Record<string, string[]> = {
        APPROVED: ['SUBMITTED', 'SUSPENDED'],
        CHANGES_REQUESTED: ['SUBMITTED'],
        REJECTED: ['SUBMITTED'],
        SUSPENDED: ['APPROVED'],
      };
      if (!allowed[input.decision]!.includes(profile.status)) throw new AppError('INVALID_STATE');
      if (input.decision !== 'APPROVED' && (input.note ?? '').length === 0) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'note', code: 'required', message: 'Give a reason' }],
        });
      }
      await tx.instructorProfile.update({
        where: { membershipId },
        data: {
          status: input.decision,
          decidedBy: actor.userId,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
          reapplyAfter: input.decision === 'REJECTED' ? new Date(Date.now() + REAPPLY_AFTER_MS) : null,
          version: { increment: 1 },
        },
      });
      if (input.decision === 'APPROVED') {
        const already = await tx.membershipRole.findFirst({ where: { membershipId, role: 'INSTRUCTOR' } });
        if (already === null) await enforceLimit(tx, 'instructors', { includeInvitations: true });
        await tx.membershipRole.upsert({
          where: {
            tenantId_membershipId_role: { tenantId: requireTenantId(), membershipId, role: 'INSTRUCTOR' },
          },
          create: { tenantId: requireTenantId(), membershipId, role: 'INSTRUCTOR', grantedBy: actor.userId },
          update: {},
        });
      }
      // New rights (or their loss) apply at the instructor's next sign-in here.
      if (input.decision === 'APPROVED' || input.decision === 'SUSPENDED') {
        await tx.session.deleteMany({ where: { membershipId } });
      }
      await this.audit.record(tx, {
        action: `instructor.${input.decision.toLowerCase()}`,
        entityType: 'instructor_profile',
        entityId: membershipId,
        actorId: actor.userId,
        before: { status: profile.status },
        after: { status: input.decision, note: input.note ?? null },
      });
    });
  }

  /**
   * BR-03: Studio needs the INSTRUCTOR role and a profile that isn't suspended. Invited instructors get
   * an APPROVED profile on first use.
   */
  async requireStudioAccess(tx: TenantTx, actor: TenantActor): Promise<void> {
    if (!can(actor, 'studio.access')) throw new AppError('FORBIDDEN');
    const profile = await tx.instructorProfile.findUnique({
      where: { membershipId: actor.membershipId },
      select: { status: true },
    });
    if (profile?.status === 'SUSPENDED')
      throw new AppError('FORBIDDEN', { detail: 'Your instructor account is suspended.' });
    if (profile === null) {
      const account = await tx.userAccount.findUnique({
        where: { id: actor.userId },
        select: { displayName: true },
      });
      const name = account?.displayName ?? 'Instructor';
      await tx.instructorProfile.create({
        data: {
          membershipId: actor.membershipId,
          tenantId: requireTenantId(),
          slug: await this.freeSlug(tx, name),
          displayName: name,
          status: 'APPROVED',
        },
      });
    }
  }

  private async freeSlug(tx: TenantTx, name: string): Promise<string> {
    const base = slugify(name);
    const taken = new Set(
      (
        await tx.instructorProfile.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })
      ).map((p) => p.slug),
    );
    return nextFreeSlug(base, taken);
  }

  private async requireVerifiedEmail(tx: TenantTx, actor: TenantActor): Promise<void> {
    const account = await tx.userAccount.findUnique({
      where: { id: actor.userId },
      select: { emailVerifiedAt: true },
    });
    if (account?.emailVerifiedAt === null || account === null) {
      throw new AppError('FORBIDDEN', { detail: 'Confirm your email address before applying.' });
    }
  }

  private requireAdmin(actor: TenantActor): void {
    if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
  }

  private view(
    profile: NonNullable<ProfileRow>,
    onboardingMode: 'INVITE_ONLY' | 'APPLICATION',
  ): InstructorProfileView {
    return {
      membershipId: profile.membershipId,
      slug: profile.slug,
      displayName: profile.displayName,
      headline: profile.headline,
      bio: profile.bio,
      subjects: profile.subjects,
      qualifications: profile.qualifications,
      status: profile.status,
      decisionNote: profile.decisionNote,
      reapplyAfter: profile.reapplyAfter?.toISOString() ?? null,
      onboardingMode,
    };
  }
}
