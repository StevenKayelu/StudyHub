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

/** Home page sections a school can order and hide (F39, 06 §10.1). */
export const HOME_SECTION_KEYS = ['featured', 'categories', 'instructors', 'newest'] as const;
export const homeSectionKeySchema = z.enum(HOME_SECTION_KEYS);

export const homeLayoutSchema = z.object({
  heroTitle: localizedTextSchema.optional(),
  heroSubtitle: localizedTextSchema.optional(),
  sections: z
    .array(z.object({ key: homeSectionKeySchema, visible: z.boolean() }))
    .max(HOME_SECTION_KEYS.length)
    .default(HOME_SECTION_KEYS.map((key) => ({ key, visible: true }))),
});
export type HomeLayout = z.infer<typeof homeLayoutSchema>;

/** A footer link: https URL or a path on the school's own site. */
const linkUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^\/[^/]/.test(value) || /^https:\/\/[^\s]+$/.test(value), {
    message: 'Use a link that starts with https:// or /',
  });

export const footerLinkSchema = z.object({ label: localizedTextSchema, url: linkUrlSchema });
export type FooterLink = z.infer<typeof footerLinkSchema>;

export const SOCIAL_KEYS = ['facebook', 'x', 'instagram', 'linkedin', 'youtube', 'tiktok'] as const;
export const socialLinksSchema = z.partialRecord(
  z.enum(SOCIAL_KEYS),
  z
    .string()
    .trim()
    .regex(/^https:\/\/[^\s]+$/, 'Use a link that starts with https://')
    .max(300),
);

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
  /** M9 (F39): uploaded images, served from the school's own host at /brand/{assetId}. */
  logoAssetId: z.uuid().nullable().default(null),
  logoDarkAssetId: z.uuid().nullable().default(null),
  faviconAssetId: z.uuid().nullable().default(null),
  appIconAssetId: z.uuid().nullable().default(null),
  homeLayout: homeLayoutSchema.default({
    sections: HOME_SECTION_KEYS.map((key) => ({ key, visible: true })),
  }),
  footerLinks: z.array(footerLinkSchema).default([]),
  supportEmail: z.string().nullable().default(null),
  supportPhone: z.string().nullable().default(null),
  social: socialLinksSchema.default({}),
});

/**
 * GET /api/v1/tenant — public bootstrap for the school resolved from the request host
 * (blueprint 05 §8.3): identity, status, published branding, language settings and the effective
 * features (F40, BR-48), so navigation hides what is switched off; M9 adds the platform notice
 * (maintenance banner) and which legal pages the school has published.
 */
export const tenantBootstrapSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(3).max(30),
  name: z.string().min(2).max(120),
  status: tenantStatusSchema,
  branding: tenantBrandingSchema,
  locales: tenantLocaleSettingsSchema,
  features: featureMapSchema,
  notice: z.string().nullable().default(null),
  legal: z
    .object({ terms: z.boolean(), privacy: z.boolean(), refunds: z.boolean() })
    .default({ terms: false, privacy: false, refunds: false }),
});

export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type FontPreset = z.infer<typeof fontPresetSchema>;
export type Terminology = z.infer<typeof terminologySchema>;
export type TenantBranding = z.infer<typeof tenantBrandingSchema>;
export type TenantBootstrap = z.infer<typeof tenantBootstrapSchema>;
