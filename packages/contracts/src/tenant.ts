import { z } from 'zod';

import { featureMapSchema } from './features';
import { localizedTextSchema, tenantLocaleSettingsSchema } from './i18n';

export const tenantStatusSchema = z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DELETED']);

/** The three curated, self-hosted font pairs (06 §10.1). */
export const fontPresetSchema = z.enum(['COPPERLINE', 'HUMANIST', 'GEOMETRIC']);

/**
 * What a school calls its instructors and courses (06 §10.1), per locale. Missing terms use the
 * platform's own words from the message catalog.
 */
export const terminologySchema = z.object({
  instructor: localizedTextSchema.optional(),
  instructors: localizedTextSchema.optional(),
  course: localizedTextSchema.optional(),
  courses: localizedTextSchema.optional(),
});

/** The published branding a school's pages render with (blueprint 05 §8, tenant_branding). */
export const tenantBrandingSchema = z.object({
  version: z.number().int().min(1),
  displayName: z.string().min(2).max(120),
  /** Lowercase #rrggbb, or null for the platform default (copper). Validated by the theme compiler. */
  accentHex: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable(),
  fontPreset: fontPresetSchema,
  showPoweredBy: z.boolean(),
  terminology: terminologySchema,
});

/**
 * GET /api/v1/tenant — public bootstrap for the school resolved from the request host
 * (blueprint 05 §8.3): identity, status, published branding, language settings and the effective
 * features (F40, BR-48), so navigation hides what is switched off. Plan data arrives with M9.
 */
export const tenantBootstrapSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(3).max(30),
  name: z.string().min(2).max(120),
  status: tenantStatusSchema,
  branding: tenantBrandingSchema,
  locales: tenantLocaleSettingsSchema,
  features: featureMapSchema,
});

export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type FontPreset = z.infer<typeof fontPresetSchema>;
export type Terminology = z.infer<typeof terminologySchema>;
export type TenantBranding = z.infer<typeof tenantBrandingSchema>;
export type TenantBootstrap = z.infer<typeof tenantBootstrapSchema>;
