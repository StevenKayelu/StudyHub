import { Injectable } from '@nestjs/common';
import { type AdminSettings, type SettingsPatch, supportedMethods } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { readCommerceSettings, readContentSettings, readFeatures } from '../../tenancy';
import { settingsProblems } from '../domain/capability-rules';
import { activeAccount } from './checkout.service';

/**
 * GET/PATCH /admin/settings (S-AD09). M8 brings the payments group (BR-62); M9 adds the other groups to
 * the same endpoint. Every change needs a reason and is audited; methods and refund modes the active
 * account doesn't support are refused (07 M8 AC 5).
 */
@Injectable()
export class CommerceSettingsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async get(actor: TenantActor): Promise<AdminSettings> {
    requireAdmin(actor);
    return this.db.run((tx) => this.read(tx));
  }

  async patch(actor: TenantActor, input: SettingsPatch): Promise<AdminSettings> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const before = await this.read(tx);
      const { reason, ...changes } = input;
      const merged = {
        enabledPaymentMethods: changes.enabledPaymentMethods ?? before.commerce.enabledPaymentMethods,
        refundMode: changes.refundMode ?? before.commerce.refundMode,
      };
      const account = await activeAccount(tx);
      const problems = settingsProblems(merged, account?.capabilities ?? null).filter(
        // Only refuse what this request changes, so an old value never blocks other edits.
        (problem) => problem.field in changes,
      );
      if (problems.length > 0) {
        throw new AppError('PAYMENT_METHOD_NOT_SUPPORTED', {
          errors: problems.map((p) => ({ field: p.field, code: p.code, message: p.message })),
        });
      }
      const tenantId = requireTenantId();
      const now = new Date();
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        const previous = (before.commerce as Record<string, unknown>)[key];
        if (JSON.stringify(previous) === JSON.stringify(value)) continue;
        changed[key] = { from: previous, to: value };
        await tx.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key } },
          create: { tenantId, key, value: value as object, updatedBy: actor.membershipId, updatedAt: now },
          update: { value: value as object, updatedBy: actor.membershipId, updatedAt: now },
        });
      }
      if (Object.keys(changed).length > 0) {
        await this.audit.record(tx, {
          action: 'settings.updated',
          entityType: 'tenant_setting',
          actorId: actor.userId,
          after: { group: 'commerce', changes: changed, reason } as Record<string, unknown>,
        });
      }
      return this.read(tx);
    });
  }

  private async read(tx: TenantTx): Promise<AdminSettings> {
    const commerce = await readCommerceSettings(tx);
    const content = await readContentSettings(tx);
    const account = await activeAccount(tx);
    const features = await readFeatures(tx);
    const last = await tx.auditLog.findFirst({
      where: { action: 'settings.updated' },
      orderBy: { createdAt: 'desc' },
      select: { actorId: true, createdAt: true, after: true },
    });
    const lastAfter = (last?.after ?? null) as { changes?: Record<string, unknown>; reason?: string } | null;
    const by =
      last?.actorId === null || last === null
        ? null
        : ((await tx.userAccount.findUnique({ where: { id: last.actorId }, select: { displayName: true } }))
            ?.displayName ?? null);
    return {
      commerce: { ...commerce, minPaidPriceMinor: content.minPaidPriceMinor },
      supported:
        account === null || account.capabilities === null
          ? null
          : { methods: supportedMethods(account.capabilities), refundApi: account.capabilities.refundApi },
      revenueShare: features.instructorRevenueShare,
      lastChange:
        last === null
          ? null
          : {
              key: Object.keys(lastAfter?.changes ?? {}).join(', '),
              by,
              at: last.createdAt.toISOString(),
              reason: lastAfter?.reason ?? null,
            },
    };
  }
}

function requireAdmin(actor: TenantActor): void {
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
}
