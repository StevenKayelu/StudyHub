import { Inject, Injectable } from '@nestjs/common';
import {
  type BrandingDraft,
  brandingDraftSchema,
  type BrandingEditor,
  type ValidateColourResponse,
} from '@studyhub/contracts';
import { type AccentRatios, compileAccent } from '@studyhub/ui/theme';

import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit';
import type { TenantActor } from '../../identity';
import {
  AppError,
  requireTenantId,
  STORAGE_LOCATIONS,
  type StorageLocations,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { readFeatures, toBranding } from '../../tenancy';
import { requireAdmin } from './guards';

const DRAFT_KEY = 'brandingDraft';
const ASSET_FIELDS = ['logoAssetId', 'logoDarkAssetId', 'faviconAssetId', 'appIconAssetId'] as const;

const RATIO_LABELS: Record<keyof AccentRatios, string> = {
  accentOnCanvas: 'Accent text on the page',
  accentOnSurface: 'Accent text on cards',
  accentOnSoft: 'Accent text on tinted areas',
  onAccentOnAccent: 'Button text on the accent',
  onAccentOnHover: 'Button text on hover',
};

/** BR-51 contrast report for the editor (06 §10.1, S-AD12). */
export function colourReport(hex: string): ValidateColourResponse {
  const result = compileAccent(hex);
  if (!result.ok) {
    return {
      ok: false,
      adjusted: null,
      checks: { light: [], dark: [] },
      suggestions: result.suggestions,
      message:
        result.reason === 'INVALID_COLOR'
          ? 'Enter a colour like #1D5DA6.'
          : result.reason === 'TOO_LIGHT'
            ? 'This colour is too light to read on white, even after darkening it a little. Try one of the suggestions.'
            : "This colour can't be made readable in the dark theme. Try one of the suggestions.",
    };
  }
  const checks = (ratios: AccentRatios) =>
    (Object.keys(RATIO_LABELS) as (keyof AccentRatios)[]).map((key) => ({
      pair: RATIO_LABELS[key],
      ratio: Math.round(ratios[key] * 100) / 100,
      required: 4.5,
      pass: ratios[key] >= 4.5,
    }));
  return {
    ok: true,
    adjusted: result.accent.adjusted ? result.accent.light.accent : null,
    checks: { light: checks(result.accent.ratios.light), dark: checks(result.accent.ratios.dark) },
    suggestions: [],
    message: result.accent.adjusted ? 'We darkened this colour slightly so text stays readable.' : null,
  };
}

/**
 * Branding editor (F39, S-AD12): the draft lives in a school setting until it is published, so the live
 * site never changes while someone edits. Publishing writes the branding row (next version) and a
 * snapshot for rollback; pages pick it up on their next render (F39 AC 2).
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    @Inject(STORAGE_LOCATIONS) private readonly locations: StorageLocations,
  ) {}

  async editor(actor: TenantActor): Promise<BrandingEditor> {
    requireAdmin(actor);
    const { editor, keys } = await this.db.run(async (tx) => {
      const published = await this.published(tx);
      const stored = await tx.tenantSetting.findFirst({ where: { key: DRAFT_KEY }, select: { value: true } });
      const parsed = stored === null ? null : brandingDraftSchema.safeParse(stored.value);
      const draft = parsed?.success === true ? parsed.data : published.draft;
      const versions = await tx.tenantBrandingVersion.findMany({
        orderBy: { version: 'desc' },
        take: 20,
        select: { version: true, publishedAt: true, publishedBy: true },
      });
      const names = await this.names(
        tx,
        versions.map((v) => v.publishedBy),
      );
      const ids = ASSET_FIELDS.map((field) => draft[field]).filter((id): id is string => id !== null);
      const assets = await tx.asset.findMany({
        where: { id: { in: ids }, purpose: 'BRANDING', status: 'READY' },
        select: { id: true, storageKey: true, derivativeKey: true, storageLocationId: true },
      });
      return {
        keys: assets,
        editor: {
          draft,
          hasUnpublishedChanges: JSON.stringify(draft) !== JSON.stringify(published.draft),
          publishedVersion: published.version,
          publishedAt: published.publishedAt?.toISOString() ?? null,
          versions: versions.map((v) => ({
            version: v.version,
            publishedAt: v.publishedAt.toISOString(),
            publishedBy: v.publishedBy === null ? null : (names.get(v.publishedBy) ?? null),
          })),
          whiteLabelAllowed: (await readFeatures(tx)).whiteLabel,
          assetUrls: {} as Record<string, string>,
        },
      };
    });
    for (const asset of keys) {
      const key = asset.derivativeKey ?? asset.storageKey;
      if (key !== null) {
        const storage = await this.locations.at(asset.storageLocationId, requireTenantId());
        editor.assetUrls[asset.id] = await storage.presignGet(key, { expiresSeconds: 600 });
      }
    }
    return editor;
  }

  async saveDraft(actor: TenantActor, draft: BrandingDraft): Promise<void> {
    requireAdmin(actor);
    await this.db.run(async (tx) => {
      await this.validate(tx, draft);
      const tenantId = requireTenantId();
      await tx.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: DRAFT_KEY } },
        create: { tenantId, key: DRAFT_KEY, value: draft as object, updatedBy: actor.membershipId },
        update: { value: draft as object, updatedBy: actor.membershipId, updatedAt: new Date() },
      });
      await this.audit.record(tx, {
        action: 'branding.draft_saved',
        entityType: 'tenant_branding',
        entityId: tenantId,
        actorId: actor.userId,
      });
    });
  }

  async publish(actor: TenantActor): Promise<{ version: number }> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const stored = await tx.tenantSetting.findFirst({ where: { key: DRAFT_KEY }, select: { value: true } });
      const parsed = stored === null ? null : brandingDraftSchema.safeParse(stored.value);
      if (parsed === null || !parsed.success) {
        throw new AppError('INVALID_STATE', { detail: 'There are no saved changes to publish.' });
      }
      await this.validate(tx, parsed.data);
      const version = await this.write(tx, actor, parsed.data);
      await tx.tenantSetting.deleteMany({ where: { key: DRAFT_KEY } });
      await this.audit.record(tx, {
        action: 'branding.published',
        entityType: 'tenant_branding',
        entityId: requireTenantId(),
        actorId: actor.userId,
        after: { version },
      });
      return { version };
    });
  }

  async rollback(actor: TenantActor, version: number): Promise<{ version: number }> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const snapshot = await tx.tenantBrandingVersion.findFirst({
        where: { version },
        select: { snapshot: true },
      });
      if (snapshot === null) throw new AppError('NOT_FOUND');
      const parsed = brandingDraftSchema.safeParse(snapshot.snapshot);
      if (!parsed.success)
        throw new AppError('INVALID_STATE', { detail: 'This version can no longer be restored.' });
      const next = await this.write(tx, actor, parsed.data);
      await this.audit.record(tx, {
        action: 'branding.rolled_back',
        entityType: 'tenant_branding',
        entityId: requireTenantId(),
        actorId: actor.userId,
        after: { restored: version, version: next },
      });
      return { version: next };
    });
  }

  /** Writes the published row as the next version and snapshots it (the first publish also snapshots v1). */
  private async write(tx: TenantTx, actor: TenantActor, draft: BrandingDraft): Promise<number> {
    const tenantId = requireTenantId();
    const current = await this.published(tx);
    const existing = await tx.tenantBrandingVersion.findFirst({
      where: { version: current.version },
      select: { version: true },
    });
    if (existing === null) {
      await tx.tenantBrandingVersion.create({
        data: {
          tenantId,
          version: current.version,
          snapshot: current.draft as object,
          publishedAt: current.publishedAt ?? new Date(),
        },
      });
    }
    const compiled = draft.accentHex === null ? null : compileAccent(draft.accentHex);
    const version = current.version + 1;
    const now = new Date();
    const data = {
      version,
      status: 'PUBLISHED' as const,
      displayName: draft.displayName,
      accentHex: draft.accentHex,
      derivedTokens: compiled?.ok === true ? (compiled.accent as unknown as object) : Prisma.JsonNull,
      fontPreset: draft.fontPreset,
      logoAssetId: draft.logoAssetId,
      logoDarkAssetId: draft.logoDarkAssetId,
      faviconAssetId: draft.faviconAssetId,
      appIconAssetId: draft.appIconAssetId,
      homeLayout: draft.homeLayout as object,
      footerLinks: draft.footerLinks as object,
      supportEmail: draft.supportEmail,
      supportPhone: draft.supportPhone,
      social: draft.social as object,
      terminology: draft.terminology as object,
      ...(draft.emailFromName !== null && { emailFromName: draft.emailFromName as object }),
      showPoweredBy: draft.showPoweredBy,
      publishedAt: now,
      publishedBy: actor.userId,
      updatedAt: now,
    };
    await tx.tenantBranding.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
    await tx.tenantBrandingVersion.create({
      data: { tenantId, version, snapshot: draft as object, publishedBy: actor.userId, publishedAt: now },
    });
    return version;
  }

  /** The published branding as an editor draft. */
  private async published(
    tx: TenantTx,
  ): Promise<{ draft: BrandingDraft; version: number; publishedAt: Date | null }> {
    const tenant = await tx.tenant.findFirst({ select: { name: true } });
    const row = await tx.tenantBranding.findFirst();
    const branding = toBranding(tenant?.name ?? 'School', row);
    const draft: BrandingDraft = {
      displayName: branding.displayName,
      accentHex: branding.accentHex,
      fontPreset: branding.fontPreset,
      logoAssetId: branding.logoAssetId,
      logoDarkAssetId: branding.logoDarkAssetId,
      faviconAssetId: branding.faviconAssetId,
      appIconAssetId: branding.appIconAssetId,
      homeLayout: branding.homeLayout,
      footerLinks: branding.footerLinks,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
      social: branding.social,
      terminology: branding.terminology,
      emailFromName: (row?.emailFromName ?? null) as BrandingDraft['emailFromName'],
      showPoweredBy: branding.showPoweredBy,
    };
    return { draft, version: row?.version ?? 1, publishedAt: row?.publishedAt ?? null };
  }

  /** F39 AC 1 (contrast), AC 3 (uploaded images only), whiteLabel and per-locale texts (BR-61). */
  private async validate(tx: TenantTx, draft: BrandingDraft): Promise<void> {
    if (draft.accentHex !== null) {
      const report = colourReport(draft.accentHex);
      if (!report.ok) {
        throw new AppError('COLOUR_NOT_COMPLIANT', {
          ...(report.message !== null && { detail: report.message }),
          extensions: { suggestions: report.suggestions },
        });
      }
    }
    const errors: { field: string; code: string; message: string }[] = [];
    for (const field of ASSET_FIELDS) {
      const id = draft[field];
      if (id === null) continue;
      const asset = await tx.asset.findFirst({
        where: { id, purpose: 'BRANDING', status: 'READY' },
        select: { id: true },
      });
      if (asset === null) {
        errors.push({ field, code: 'not_uploaded', message: 'Upload the image again; it is not ready.' });
      }
    }
    if (!draft.showPoweredBy && !(await readFeatures(tx)).whiteLabel) {
      errors.push({
        field: 'showPoweredBy',
        code: 'not_in_plan',
        message: 'Removing the "Powered by" badge needs the white-label feature.',
      });
    }
    const localesRow = await tx.tenantSetting.findFirst({
      where: { key: 'enabledLocales' },
      select: { value: true },
    });
    const locales = Array.isArray(localesRow?.value) ? (localesRow.value as string[]) : ['en'];
    const texts: [string, Record<string, string> | null | undefined][] = [
      ['homeLayout.heroTitle', draft.homeLayout.heroTitle],
      ['homeLayout.heroSubtitle', draft.homeLayout.heroSubtitle],
      ['emailFromName', draft.emailFromName],
      ...Object.entries(draft.terminology).map(
        ([key, value]) => [`terminology.${key}`, value] as [string, Record<string, string> | undefined],
      ),
      ...draft.footerLinks.map(
        (link, index) => [`footerLinks.${index}.label`, link.label] as [string, Record<string, string>],
      ),
    ];
    for (const [field, text] of texts) {
      if (
        text !== undefined &&
        text !== null &&
        Object.keys(text).some((locale) => !locales.includes(locale))
      ) {
        errors.push({
          field,
          code: 'locale_not_enabled',
          message: 'Add texts only in your enabled languages.',
        });
      }
    }
    if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { errors });
  }

  private async names(tx: TenantTx, userIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const accounts = await tx.userAccount.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(accounts.map((a) => [a.id, a.displayName]));
  }
}
