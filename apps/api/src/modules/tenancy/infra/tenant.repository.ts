import { Injectable } from '@nestjs/common';
import {
  DEFAULT_LOCALE_SETTINGS,
  footerLinkSchema,
  generalSettingsFrom,
  HOME_SECTION_KEYS,
  homeLayoutSchema,
  socialLinksSchema,
  type TenantBootstrap,
  type TenantBranding,
  type TenantLocaleSettings,
  tenantLocaleSettingsSchema,
  terminologySchema,
} from '@studyhub/contracts';
import { z } from 'zod';

import { PrismaService, type TenantTx } from '../../platform';
import type { ResolvedTenant, ResolvedTenantStatus, TenantLookup } from '../application/tenant-resolver';
import { readFeatures } from './features';

interface ResolveRow {
  tenant_id: string;
  status: ResolvedTenantStatus;
  primary_host: string | null;
  is_redirect: boolean;
}

/** tenant_setting keys that make up the locale settings (blueprint 05 §8, BR-61). */
export const LOCALE_SETTING_KEYS = ['defaultLocale', 'enabledLocales', 'timeZone'] as const;

/** The global maintenance banner (console S-C08), shown on every school page. */
export const MAINTENANCE_BANNER_KEY = 'maintenanceBanner';

const BRANDING_SELECT = {
  version: true,
  status: true,
  displayName: true,
  accentHex: true,
  fontPreset: true,
  showPoweredBy: true,
  terminology: true,
  logoAssetId: true,
  logoDarkAssetId: true,
  faviconAssetId: true,
  appIconAssetId: true,
  homeLayout: true,
  footerLinks: true,
  supportEmail: true,
  supportPhone: true,
  social: true,
} as const;

@Injectable()
export class TenantRepository implements TenantLookup {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Host lookup through the SECURITY DEFINER function resolve_tenant() (inventory, 04 §17.4). A host
   * retired by an address change still resolves for 90 days, marked as a redirect (BR-50).
   */
  async lookup(host: string): Promise<ResolvedTenant | null> {
    const rows = await this.prisma.$queryRaw<ResolveRow[]>`
      SELECT tenant_id, status::text AS status, primary_host, is_redirect FROM resolve_tenant(${host})`;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          tenantId: row.tenant_id,
          status: row.status,
          primaryHost: row.primary_host,
          redirect: row.is_redirect,
        };
  }

  /**
   * The current school with its published branding, language settings and features, read under RLS inside a
   * tenant transaction. A school without a published branding row or settings gets the defaults.
   */
  async findBootstrap(tx: TenantTx, tenantId: string): Promise<TenantBootstrap | null> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        branding: { select: BRANDING_SELECT },
        settings: {
          where: { key: { in: [...LOCALE_SETTING_KEYS, 'legalPages'] } },
          select: { key: true, value: true },
        },
      },
    });
    if (tenant === null) return null;
    const features = await readFeatures(tx);
    // platform_setting is a global table without school data.
    const banner = await tx.platformSetting.findUnique({ where: { key: MAINTENANCE_BANNER_KEY } });
    const legal = generalSettingsFrom(tenant.settings).legalPages;
    const branding = toBranding(tenant.name, tenant.branding);

    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      branding: { ...branding, showPoweredBy: branding.showPoweredBy || !features.whiteLabel },
      locales: toLocaleSettings(tenant.settings),
      features,
      notice: typeof banner?.value === 'string' && banner.value.trim() !== '' ? banner.value : null,
      legal: {
        terms: legal.terms !== undefined,
        privacy: legal.privacy !== undefined,
        refunds: legal.refunds !== undefined,
      },
    };
  }
}

type BrandingRow = {
  version: number;
  status: 'DRAFT' | 'PUBLISHED';
  displayName: string;
  accentHex: string | null;
  fontPreset: TenantBranding['fontPreset'];
  showPoweredBy: boolean;
  terminology: unknown;
  logoAssetId: string | null;
  logoDarkAssetId: string | null;
  faviconAssetId: string | null;
  appIconAssetId: string | null;
  homeLayout: unknown;
  footerLinks: unknown;
  supportEmail: string | null;
  supportPhone: string | null;
  social: unknown;
} | null;

const DEFAULT_HOME = { sections: HOME_SECTION_KEYS.map((key) => ({ key, visible: true })) };

/** Stored JSON that no longer matches its schema falls back to the default (never breaks a page). */
function parsed<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}

export function toBranding(name: string, row: BrandingRow): TenantBranding {
  if (row === null || row.status !== 'PUBLISHED') {
    return {
      version: 1,
      displayName: name,
      accentHex: null,
      fontPreset: 'COPPERLINE',
      showPoweredBy: true,
      terminology: {},
      logoAssetId: null,
      logoDarkAssetId: null,
      faviconAssetId: null,
      appIconAssetId: null,
      homeLayout: DEFAULT_HOME,
      footerLinks: [],
      supportEmail: null,
      supportPhone: null,
      social: {},
    };
  }
  return {
    version: row.version,
    displayName: row.displayName,
    accentHex: row.accentHex,
    fontPreset: row.fontPreset,
    showPoweredBy: row.showPoweredBy,
    terminology: parsed(terminologySchema, row.terminology, {}),
    logoAssetId: row.logoAssetId,
    logoDarkAssetId: row.logoDarkAssetId,
    faviconAssetId: row.faviconAssetId,
    appIconAssetId: row.appIconAssetId,
    homeLayout: parsed(homeLayoutSchema, row.homeLayout, DEFAULT_HOME),
    footerLinks: parsed(z.array(footerLinkSchema), row.footerLinks, []),
    supportEmail: row.supportEmail,
    supportPhone: row.supportPhone,
    social: parsed(socialLinksSchema, row.social, {}),
  };
}

function toLocaleSettings(rows: { key: string; value: unknown }[]): TenantLocaleSettings {
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const merged = tenantLocaleSettingsSchema.safeParse({ ...DEFAULT_LOCALE_SETTINGS, ...stored });
  return merged.success ? merged.data : DEFAULT_LOCALE_SETTINGS;
}
