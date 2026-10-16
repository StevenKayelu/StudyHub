import { Injectable } from '@nestjs/common';
import {
  type AdminSettings,
  COMMERCE_SETTING_KEYS,
  CONTENT_SETTING_KEYS,
  GENERAL_SETTING_KEYS,
  generalSettingsFrom,
  type SettingsPatch,
  SUPPORTED_LOCALES,
  supportedMethods,
} from '@studyhub/contracts';

import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { readCommerceSettings, readContentSettings, readFeatures, readPlan } from '../../tenancy';
import { settingsProblems } from '../domain/capability-rules';
import { activeAccount } from './checkout.service';

/**
 * GET/PATCH /admin/settings (S-AD09): every settings group of a school. Every change needs a reason and
 * is ONE audit entry listing each changed key with its old and new value (F41 AC 2, F34 AC). Methods and
 * refund modes the active account doesn't support are refused (BR-62, 07 M8 AC 5); upload sizes can't
 * exceed the plan (04 §17.8); legal texts only in the school's enabled languages (BR-61).
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
      const fieldErrors: { field: string; code: string; message: string }[] = [];
      if (changes.maxDocumentMb !== undefined && changes.maxDocumentMb > before.planCaps.maxDocumentMb) {
        fieldErrors.push({
          field: 'maxDocumentMb',
          code: 'over_plan',
          message: `Your plan allows documents up to ${before.planCaps.maxDocumentMb} MB`,
        });
      }
      if (changes.maxVideoGb !== undefined && changes.maxVideoGb > before.planCaps.maxVideoGb) {
        fieldErrors.push({
          field: 'maxVideoGb',
          code: 'over_plan',
          message: `Your plan allows videos up to ${before.planCaps.maxVideoGb} GB`,
        });
      }
      if (changes.legalPages !== undefined) {
        const locales = await enabledLocales(tx);
        for (const [page, text] of Object.entries(changes.legalPages)) {
          if (Object.keys(text ?? {}).some((locale) => !locales.includes(locale))) {
            fieldErrors.push({
              field: `legalPages.${page}`,
              code: 'locale_not_enabled',
              message: 'Add texts only in the languages your school has enabled',
            });
          }
        }
      }
      if (
        changes.learnerRegistrationMode === 'EMAIL_DOMAIN' &&
        (changes.allowedEmailDomains ?? before.general.allowedEmailDomains).length === 0
      ) {
        fieldErrors.push({
          field: 'allowedEmailDomains',
          code: 'required',
          message: 'Add at least one email domain',
        });
      }
      if (fieldErrors.length > 0) throw new AppError('VALIDATION_FAILED', { errors: fieldErrors });

      const current: Record<string, unknown> = {
        ...before.commerce,
        ...before.general,
        ...before.content,
      };
      const tenantId = requireTenantId();
      const now = new Date();
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        const previous = current[key];
        if (JSON.stringify(previous) === JSON.stringify(value)) continue;
        changed[key] = { from: previous, to: value };
        const json = value === null ? Prisma.JsonNull : (value as object);
        await tx.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key } },
          create: { tenantId, key, value: json, updatedBy: actor.membershipId, updatedAt: now },
          update: { value: json, updatedBy: actor.membershipId, updatedAt: now },
        });
      }
      if (Object.keys(changed).length > 0) {
        await this.audit.record(tx, {
          action: 'settings.updated',
          entityType: 'tenant_setting',
          actorId: actor.userId,
          after: { group: groupOf(Object.keys(changed)), changes: changed, reason } as Record<
            string,
            unknown
          >,
        });
      }
      return this.read(tx);
    });
  }

  private async read(tx: TenantTx): Promise<AdminSettings> {
    const commerce = await readCommerceSettings(tx);
    const content = await readContentSettings(tx);
    const general = generalSettingsFrom(
      await tx.tenantSetting.findMany({
        where: { key: { in: GENERAL_SETTING_KEYS } },
        select: { key: true, value: true },
      }),
    );
    const plan = await readPlan(tx);
    const tenant = await tx.tenant.findFirst({ select: { currency: true } });
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
    const { minPaidPriceMinor, ...contentDefaults } = content;
    return {
      commerce: { ...commerce, minPaidPriceMinor },
      general,
      content: contentDefaults,
      planCaps: { maxDocumentMb: plan.limits.maxDocumentMb, maxVideoGb: plan.limits.maxVideoGb },
      currency: tenant?.currency ?? 'ZMW',
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

/** The S-AD09 group(s) of the changed keys, for the audit entry. */
function groupOf(keys: string[]): string {
  const groups = new Set(
    keys.map((key) =>
      (COMMERCE_SETTING_KEYS as string[]).includes(key) || key === 'minPaidPriceMinor'
        ? 'commerce'
        : (GENERAL_SETTING_KEYS as string[]).includes(key)
          ? 'general'
          : (CONTENT_SETTING_KEYS as string[]).includes(key)
            ? 'content'
            : 'other',
    ),
  );
  return [...groups].sort().join(',');
}

async function enabledLocales(tx: TenantTx): Promise<string[]> {
  const row = await tx.tenantSetting.findFirst({ where: { key: 'enabledLocales' }, select: { value: true } });
  return Array.isArray(row?.value) ? (row.value as string[]) : [...SUPPORTED_LOCALES];
}

function requireAdmin(actor: TenantActor): void {
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
}
