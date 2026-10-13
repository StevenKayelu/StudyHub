-- 0003_tenant_branding_settings (M3): school branding and typed settings, read by the theming
-- runtime and the i18n mechanism. Blueprint 05 §8 (tenant_branding, tenant_setting), 04 §17.7–17.8.
-- Runs as studyhub_migrator. Grants are closed by default (0002); the runtime role may only read
-- these tables until the branding editor and settings screens arrive.

CREATE TYPE "FontPreset" AS ENUM ('COPPERLINE', 'HUMANIST', 'GEOMETRIC');
CREATE TYPE "BrandingStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- ---------------------------------------------------------------------------------------------
-- tenant_branding: the school's identity tokens (06 §10.1). One row per school; the published
-- version drives the theme. No row = Copperline defaults.
-- Asset columns hold asset ids; their foreign keys arrive with the asset table (M5).
-- Tenant-authored texts are stored per locale: { "en": "…" } (BR-61).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_branding" (
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "BrandingStatus" NOT NULL DEFAULT 'PUBLISHED',
    "display_name" TEXT NOT NULL,
    "logo_asset_id" UUID,
    "logo_dark_asset_id" UUID,
    "favicon_asset_id" UUID,
    "app_icon_asset_id" UUID,
    -- NULL = the platform default accent (copper).
    "accent_hex" TEXT,
    -- Compiled light and dark accent tokens and their measured contrast ratios (written on publish).
    "derived_tokens" JSONB,
    "font_preset" "FontPreset" NOT NULL DEFAULT 'COPPERLINE',
    "home_layout" JSONB NOT NULL DEFAULT '{}',
    "footer_links" JSONB NOT NULL DEFAULT '[]',
    "support_email" TEXT,
    "support_phone" TEXT,
    "social" JSONB NOT NULL DEFAULT '{}',
    "terminology" JSONB NOT NULL DEFAULT '{}',
    "email_from_name" JSONB,
    "show_powered_by" BOOLEAN NOT NULL DEFAULT true,
    "published_at" TIMESTAMPTZ(3),
    "published_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "tenant_branding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_branding_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "tenant_branding_display_name_length" CHECK (char_length("display_name") BETWEEN 2 AND 120),
    CONSTRAINT "tenant_branding_accent_format" CHECK ("accent_hex" IS NULL OR "accent_hex" ~ '^#[0-9a-f]{6}$'),
    CONSTRAINT "tenant_branding_terminology_object" CHECK (jsonb_typeof("terminology") = 'object'),
    CONSTRAINT "tenant_branding_home_layout_object" CHECK (jsonb_typeof("home_layout") = 'object'),
    CONSTRAINT "tenant_branding_footer_links_array" CHECK (jsonb_typeof("footer_links") = 'array')
);

SELECT tenancy_apply_isolation('"tenant_branding"');
GRANT SELECT ON "tenant_branding" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- tenant_branding_version: published snapshots for rollback (written by the editor, later).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_branding_version" (
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_branding_version_pkey" PRIMARY KEY ("tenant_id", "version"),
    CONSTRAINT "tenant_branding_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT
);

SELECT tenancy_apply_isolation('"tenant_branding_version"');
GRANT SELECT ON "tenant_branding_version" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- tenant_setting: typed per-school settings; keys and value shapes are validated by the Zod schema
-- in @studyhub/contracts (tenantSettingsSchema). M3 uses defaultLocale, enabledLocales and timeZone.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_setting" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("tenant_id", "key"),
    CONSTRAINT "tenant_setting_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_setting_key_format" CHECK ("key" ~ '^[a-z][A-Za-z0-9]{1,63}$')
);

SELECT tenancy_apply_isolation('"tenant_setting"');
GRANT SELECT ON "tenant_setting" TO studyhub_app;
