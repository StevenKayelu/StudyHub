import { Injectable } from '@nestjs/common';
import {
  DEFAULT_LOCALE_SETTINGS,
  type TenantBootstrap,
  type TenantBranding,
  type TenantLocaleSettings,
  tenantLocaleSettingsSchema,
  terminologySchema,
} from '@studyhub/contracts';

import { PrismaService, type TenantTx } from '../../platform';
import type { ResolvedTenant, ResolvedTenantStatus, TenantLookup } from '../application/tenant-resolver';
import { readFeatures } from './features';

interface ResolveRow {
  tenant_id: string;
  status: ResolvedTenantStatus;
  primary_host: string | null;
}

/** tenant_setting keys that make up the locale settings (blueprint 05 §8, BR-61). */
export const LOCALE_SETTING_KEYS = ['defaultLocale', 'enabledLocales', 'timeZone'] as const;

@Injectable()
export class TenantRepository implements TenantLookup {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Host lookup through the SECURITY DEFINER function resolve_tenant() (inventory, 04 §17.4).
   * The runtime role has no access to tenant_domain itself.
   */
  async lookup(host: string): Promise<ResolvedTenant | null> {
    const rows = await this.prisma.$queryRaw<ResolveRow[]>`
      SELECT tenant_id, status::text AS status, primary_host FROM resolve_tenant(${host})`;
    const row = rows[0];
    return row === undefined
      ? null
      : { tenantId: row.tenant_id, status: row.status, primaryHost: row.primary_host };
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
        branding: {
          select: {
            version: true,
            status: true,
            displayName: true,
            accentHex: true,
            fontPreset: true,
            showPoweredBy: true,
            terminology: true,
          },
        },
        settings: { where: { key: { in: [...LOCALE_SETTING_KEYS] } }, select: { key: true, value: true } },
      },
    });
    if (tenant === null) return null;
    const features = await readFeatures(tx);

    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      branding: toBranding(tenant.name, tenant.branding),
      locales: toLocaleSettings(tenant.settings),
      features,
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
} | null;

function toBranding(name: string, row: BrandingRow): TenantBranding {
  if (row === null || row.status !== 'PUBLISHED') {
    return {
      version: 1,
      displayName: name,
      accentHex: null,
      fontPreset: 'COPPERLINE',
      showPoweredBy: true,
      terminology: {},
    };
  }
  const terminology = terminologySchema.safeParse(row.terminology);
  return {
    version: row.version,
    displayName: row.displayName,
    accentHex: row.accentHex,
    fontPreset: row.fontPreset,
    showPoweredBy: row.showPoweredBy,
    // Stored JSON that no longer matches the schema falls back to the platform's own terms.
    terminology: terminology.success ? terminology.data : {},
  };
}

function toLocaleSettings(rows: { key: string; value: unknown }[]): TenantLocaleSettings {
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const merged = tenantLocaleSettingsSchema.safeParse({ ...DEFAULT_LOCALE_SETTINGS, ...stored });
  return merged.success ? merged.data : DEFAULT_LOCALE_SETTINGS;
}
