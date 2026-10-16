-- 0009_tenant_admin_console (M9): plans, school lifecycle columns, console read policies on metadata
-- tables, support access, usage metering, exports, domain change requests, settlement reconciliation
-- (W7), platform statements (W8), in-app notifications, and the purge archive.
-- Blueprint 03 F30–F35, F37–F44, F46–F49, W7, W8; 04 §17.4, §17.12; 05 §8.1–§8.5.
-- docs/design/m9-tenant-admin-console.md, ADR-0020.

CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE "SupportScope" AS ENUM ('READ_ONLY', 'READ_WRITE');
CREATE TYPE "SupportGrantStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'ACTIVE', 'EXPIRED', 'REVOKED');
CREATE TYPE "ExportType" AS ENUM ('ORDERS', 'PAYMENTS', 'LEDGER', 'ENROLMENTS', 'TENANT_FULL');
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');
CREATE TYPE "DomainRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "SettlementSource" AS ENUM ('API', 'CSV');
CREATE TYPE "SettlementStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');
CREATE TYPE "SettlementKind" AS ENUM ('MISSING_LOCAL', 'MISSING_PROVIDER', 'AMOUNT_MISMATCH');
CREATE TYPE "SettlementResolution" AS ENUM ('RECHECKED', 'ACCEPTED', 'REFUND_STARTED', 'NOTED');
CREATE TYPE "StatementStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID');

ALTER TYPE "AssetPurpose" ADD VALUE 'BRANDING';

-- ---------------------------------------------------------------------------------------------
-- Plans (05 §8.1): global. Everyone may read plans (a school reads its own); only the console writes.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "plan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "features" JSONB NOT NULL DEFAULT '{}',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "pricing" JSONB NOT NULL DEFAULT '{}',
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_code_format" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,39}$'),
    CONSTRAINT "plan_name_length" CHECK (char_length("name") BETWEEN 2 AND 80)
);
CREATE UNIQUE INDEX "plan_code_key" ON "plan"("code");
ALTER TABLE "plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan" FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_read ON "plan" FOR SELECT USING (true);
CREATE POLICY platform_realm ON "plan"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
GRANT SELECT, INSERT, UPDATE ON "plan" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- School lifecycle (F37, 05 §8.1) and the console's view of school metadata (ADR-0020).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "tenant"
    ADD COLUMN "plan_id" UUID,
    ADD COLUMN "legal_name" TEXT,
    ADD COLUMN "country" CHAR(2) NOT NULL DEFAULT 'ZM',
    ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'ZMW',
    ADD COLUMN "owner_contact_email" TEXT,
    ADD COLUMN "suspended_reason" TEXT,
    ADD COLUMN "offboarding_requested_at" TIMESTAMPTZ(3),
    ADD COLUMN "delete_after" TIMESTAMPTZ(3),
    ADD COLUMN "activated_at" TIMESTAMPTZ(3),
    ADD COLUMN "created_by" UUID,
    ADD CONSTRAINT "tenant_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT,
    ADD CONSTRAINT "tenant_country_format" CHECK ("country" ~ '^[A-Z]{2}$'),
    ADD CONSTRAINT "tenant_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "tenant_offboarding_dates" CHECK ("status" <> 'OFFBOARDING' OR "delete_after" IS NOT NULL);

CREATE POLICY platform_realm ON "tenant"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
GRANT INSERT ON "tenant" TO studyhub_app;
GRANT UPDATE ("slug", "name", "legal_name", "status", "plan_id", "receipt_prefix", "suspended_reason",
              "offboarding_requested_at", "delete_after", "activated_at", "updated_at", "version")
    ON "tenant" TO studyhub_app;

ALTER TABLE "tenant_domain" ADD COLUMN "redirect_until" TIMESTAMPTZ(3);
ALTER TABLE "tenant_domain" ADD CONSTRAINT "tenant_domain_redirect_until"
    CHECK ("status" <> 'REDIRECT' OR "redirect_until" IS NOT NULL);
CREATE POLICY platform_realm ON "tenant_domain"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
-- A school reads its own addresses (S-AD19); the console adds and retires them.
GRANT SELECT, INSERT ON "tenant_domain" TO studyhub_app;
GRANT UPDATE ("status", "is_primary", "redirect_until") ON "tenant_domain" TO studyhub_app;

-- Only the console realm creates schools, changes their address or plan, and adds or retires hosts.
-- A school updates its own row only for go-live and offboarding (status and dates).
CREATE FUNCTION tenant_platform_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF coalesce(current_setting('app.realm', true), '') = 'platform' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR TG_TABLE_NAME = 'tenant_domain' THEN
    RAISE EXCEPTION 'Only the platform console can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Nested, not OR-ed: PL/pgSQL may evaluate every operand, and only "tenant" has these columns.
  IF NEW.slug IS DISTINCT FROM OLD.slug OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.receipt_prefix IS DISTINCT FROM OLD.receipt_prefix OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason THEN
    RAISE EXCEPTION 'Only the platform console can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION tenant_platform_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_platform_guard() TO studyhub_app;
CREATE TRIGGER tenant_platform_guard BEFORE INSERT OR UPDATE ON "tenant"
    FOR EACH ROW EXECUTE FUNCTION tenant_platform_guard();
CREATE TRIGGER tenant_domain_platform_guard BEFORE INSERT OR UPDATE ON "tenant_domain"
    FOR EACH ROW EXECUTE FUNCTION tenant_platform_guard();

-- Branding editor (F39) and feature switches (F40) are written by the school from M9.
GRANT INSERT, UPDATE ON "tenant_branding" TO studyhub_app;
-- The branding draft is a setting row that publishing removes.
GRANT DELETE ON "tenant_setting" TO studyhub_app;
GRANT INSERT ON "tenant_branding_version" TO studyhub_app;
GRANT INSERT, UPDATE ON "tenant_feature" TO studyhub_app;
CREATE POLICY platform_realm ON "tenant_feature"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');

-- A school switches its features; only the console sets the platform override (BR-48).
CREATE FUNCTION tenant_feature_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF coalesce(current_setting('app.realm', true), '') <> 'platform' THEN
    IF TG_OP = 'INSERT' AND NEW.platform_override <> 'NONE' THEN
      RAISE EXCEPTION 'Only the platform console sets feature overrides' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.platform_override IS DISTINCT FROM OLD.platform_override THEN
      RAISE EXCEPTION 'Only the platform console sets feature overrides' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION tenant_feature_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_feature_guard() TO studyhub_app;
CREATE TRIGGER tenant_feature_guard BEFORE INSERT OR UPDATE ON "tenant_feature"
    FOR EACH ROW EXECUTE FUNCTION tenant_feature_guard();

-- ---------------------------------------------------------------------------------------------
-- Support access (F44, BR-47, 04 §17.12). Readable by the school (RLS) and the console (platform
-- realm). Staff names are snapshotted, so the school never needs to read platform_user.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "support_access_grant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "staff_display_name" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" "SupportScope" NOT NULL DEFAULT 'READ_ONLY',
    "emergency" BOOLEAN NOT NULL DEFAULT false,
    "status" "SupportGrantStatus" NOT NULL DEFAULT 'REQUESTED',
    "duration_minutes" INTEGER NOT NULL DEFAULT 240,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "starts_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "revoked_by_staff" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "handoff_hash" BYTEA,
    "handoff_expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "support_access_grant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_access_grant_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "support_access_grant_reason_length" CHECK (char_length("reason") BETWEEN 20 AND 1000),
    CONSTRAINT "support_access_grant_duration" CHECK ("duration_minutes" BETWEEN 15 AND 1440),
    CONSTRAINT "support_access_grant_window" CHECK (
        "expires_at" IS NULL OR ("starts_at" IS NOT NULL AND "expires_at" - "starts_at" <= interval '24 hours'))
);
CREATE UNIQUE INDEX "support_access_grant_tenant_id_id_key" ON "support_access_grant"("tenant_id", "id");
CREATE INDEX "support_access_grant_tenant_requested_idx" ON "support_access_grant"("tenant_id", "requested_at" DESC);
CREATE UNIQUE INDEX "support_access_grant_handoff_key" ON "support_access_grant"("tenant_id", "handoff_hash")
    WHERE "handoff_hash" IS NOT NULL;
SELECT tenancy_apply_isolation('"support_access_grant"');
CREATE POLICY platform_realm ON "support_access_grant"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
GRANT SELECT, INSERT, UPDATE ON "support_access_grant" TO studyhub_app;

-- A support session on the school host (PROPOSED: its own table, so member sessions keep their membership).
CREATE TABLE "support_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip" INET,
    "user_agent" TEXT,

    CONSTRAINT "support_session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_session_grant_fkey" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "support_access_grant"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "support_session_tenant_token_key" ON "support_session"("tenant_id", "token_hash");
CREATE INDEX "support_session_tenant_grant_idx" ON "support_session"("tenant_id", "grant_id");
SELECT tenancy_apply_isolation('"support_session"');
GRANT SELECT, INSERT, DELETE ON "support_session" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- Usage metering (F47): one row per school per day.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_usage_daily" (
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "active_learners" INTEGER NOT NULL DEFAULT 0,
    "instructors" INTEGER NOT NULL DEFAULT 0,
    "admins" INTEGER NOT NULL DEFAULT 0,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "video_minutes_delivered" INTEGER NOT NULL DEFAULT 0,
    "emails_sent" INTEGER NOT NULL DEFAULT 0,
    "payments_count" INTEGER NOT NULL DEFAULT 0,
    "payments_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "measured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_usage_daily_pkey" PRIMARY KEY ("tenant_id", "date"),
    CONSTRAINT "tenant_usage_daily_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT
);
SELECT tenancy_apply_isolation('"tenant_usage_daily"');
CREATE POLICY platform_realm ON "tenant_usage_daily"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
GRANT SELECT, INSERT, UPDATE ON "tenant_usage_daily" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- Exports (F32 report CSVs, F46 full export): produced by the worker, kept for 7 days.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "data_export" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" "ExportType" NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "requested_by" UUID NOT NULL,
    "row_count" INTEGER,
    "storage_key" TEXT,
    "size_bytes" BIGINT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "data_export_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "data_export_requested_by_fkey" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "data_export_storage_key_prefix" CHECK ("storage_key" IS NULL OR "storage_key" LIKE 't/' || "tenant_id" || '/%')
);
CREATE UNIQUE INDEX "data_export_tenant_id_id_key" ON "data_export"("tenant_id", "id");
CREATE INDEX "data_export_tenant_created_idx" ON "data_export"("tenant_id", "created_at" DESC);
SELECT tenancy_apply_isolation('"data_export"');
GRANT SELECT, INSERT, UPDATE ON "data_export" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- Subdomain change requests (S-AD19; BR-50): the school asks, the console decides.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "domain_change_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "current_slug" TEXT NOT NULL,
    "requested_slug" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DomainRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "domain_change_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "domain_change_request_requested_by_fkey" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "domain_change_request_slug_format" CHECK ("requested_slug" ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
    CONSTRAINT "domain_change_request_reason_length" CHECK (char_length("reason") BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX "domain_change_request_tenant_id_id_key" ON "domain_change_request"("tenant_id", "id");
CREATE UNIQUE INDEX "domain_change_request_one_open" ON "domain_change_request"("tenant_id") WHERE "status" = 'REQUESTED';
CREATE INDEX "domain_change_request_tenant_created_idx" ON "domain_change_request"("tenant_id", "created_at" DESC);
SELECT tenancy_apply_isolation('"domain_change_request"');
CREATE POLICY platform_realm ON "domain_change_request"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
GRANT SELECT, INSERT, UPDATE ON "domain_change_request" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- Settlement reconciliation (W7, SHOULD): a report per range and one row per mismatch.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "settlement_report" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "payment_account_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "source" "SettlementSource" NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PROCESSING',
    "provider_count" INTEGER NOT NULL DEFAULT 0,
    "local_count" INTEGER NOT NULL DEFAULT 0,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "mismatch_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_report_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_report_account_fkey" FOREIGN KEY ("tenant_id", "payment_account_id") REFERENCES "payment_account"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "settlement_report_created_by_fkey" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "settlement_report_period" CHECK ("period_end" >= "period_start" AND "period_end" - "period_start" <= 92)
);
CREATE UNIQUE INDEX "settlement_report_tenant_id_id_key" ON "settlement_report"("tenant_id", "id");
CREATE INDEX "settlement_report_tenant_created_idx" ON "settlement_report"("tenant_id", "created_at" DESC);
SELECT tenancy_apply_isolation('"settlement_report"');

CREATE TABLE "settlement_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "payment_id" UUID,
    "local_amount_minor" BIGINT,
    "provider_amount_minor" BIGINT,
    "currency" CHAR(3) NOT NULL,
    "resolution" "SettlementResolution",
    "note" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "settlement_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_item_report_fkey" FOREIGN KEY ("tenant_id", "report_id") REFERENCES "settlement_report"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "settlement_item_reference_length" CHECK (char_length("reference") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "settlement_item_report_reference_key" ON "settlement_item"("tenant_id", "report_id", "reference");
SELECT tenancy_apply_isolation('"settlement_item"');
GRANT SELECT, INSERT, UPDATE ON "settlement_report", "settlement_item" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- Platform statements (W8, BR-63): written only in the platform realm; a school's owners read them.
-- Amounts are frozen once issued; corrections are a VOID plus a new statement.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "platform_statement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "plan_code" TEXT,
    "subscription_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "sales_gross_minor" BIGINT NOT NULL DEFAULT 0,
    "refunds_minor" BIGINT NOT NULL DEFAULT 0,
    "platform_commission_bps" INTEGER NOT NULL DEFAULT 0,
    "platform_commission_minor" BIGINT NOT NULL DEFAULT 0,
    "total_due_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'ZMW',
    "status" "StatementStatus" NOT NULL DEFAULT 'DRAFT',
    "issued_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "external_reference" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_statement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_statement_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_statement_period_format" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "platform_statement_bps" CHECK ("platform_commission_bps" BETWEEN 0 AND 10000),
    CONSTRAINT "platform_statement_amounts" CHECK (
        "subscription_fee_minor" >= 0 AND "sales_gross_minor" >= 0 AND "refunds_minor" >= 0
        AND "platform_commission_minor" >= 0
        AND "total_due_minor" = "subscription_fee_minor" + "platform_commission_minor")
);
CREATE UNIQUE INDEX "platform_statement_one_per_period" ON "platform_statement"("tenant_id", "period") WHERE "status" <> 'VOID';
CREATE INDEX "platform_statement_tenant_period_idx" ON "platform_statement"("tenant_id", "period" DESC);
SELECT tenancy_apply_isolation('"platform_statement"');
CREATE POLICY platform_realm ON "platform_statement"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
GRANT SELECT, INSERT, UPDATE ON "platform_statement" TO studyhub_app;

CREATE FUNCTION platform_statement_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF coalesce(current_setting('app.realm', true), '') <> 'platform' THEN
    RAISE EXCEPTION 'Platform statements are written by the console only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'DRAFT' AND (
         NEW.subscription_fee_minor, NEW.sales_gross_minor, NEW.refunds_minor, NEW.platform_commission_bps,
         NEW.platform_commission_minor, NEW.total_due_minor, NEW.currency, NEW.period, NEW.tenant_id)
       IS DISTINCT FROM (
         OLD.subscription_fee_minor, OLD.sales_gross_minor, OLD.refunds_minor, OLD.platform_commission_bps,
         OLD.platform_commission_minor, OLD.total_due_minor, OLD.currency, OLD.period, OLD.tenant_id) THEN
      RAISE EXCEPTION 'An issued statement can''t be changed; void it and create a new one' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD.status = NEW.status
            OR (OLD.status = 'DRAFT' AND NEW.status IN ('ISSUED', 'VOID'))
            OR (OLD.status = 'ISSUED' AND NEW.status IN ('PAID', 'VOID'))) THEN
      RAISE EXCEPTION 'Statement status can''t move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION platform_statement_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_statement_guard() TO studyhub_app;
CREATE TRIGGER platform_statement_guard BEFORE INSERT OR UPDATE ON "platform_statement"
    FOR EACH ROW EXECUTE FUNCTION platform_statement_guard();

-- ---------------------------------------------------------------------------------------------
-- In-app notifications (F33) and email preferences for non-essential mail.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "notification_link_relative" CHECK ("link" IS NULL OR "link" ~ '^/[^/]')
);
CREATE INDEX "notification_tenant_member_idx" ON "notification"("tenant_id", "membership_id", "created_at" DESC);
SELECT tenancy_apply_isolation('"notification"');
GRANT SELECT, INSERT ON "notification" TO studyhub_app;
GRANT UPDATE ("read_at") ON "notification" TO studyhub_app;

CREATE TABLE "notification_preference" (
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("tenant_id", "membership_id", "category"),
    CONSTRAINT "notification_preference_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "notification_preference_category" CHECK ("category" IN ('learning', 'earnings'))
);
SELECT tenancy_apply_isolation('"notification_preference"');
GRANT SELECT, INSERT, UPDATE ON "notification_preference" TO studyhub_app;

-- Administrators may revoke a member's single session (F30, S-AD03 Sessions tab).
-- (session already has DELETE.)

-- ---------------------------------------------------------------------------------------------
-- Purge archive (BR-53, 05 §8.5): financial records and the audit trail of a deleted school.
-- No runtime grants: access-restricted; written only by purge_tenant().
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_archive" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "tenant_id" UUID NOT NULL,
    "source_table" TEXT NOT NULL,
    "row_data" JSONB NOT NULL,
    "archived_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_archive_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_archive_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT
);
CREATE INDEX "tenant_archive_tenant_table_idx" ON "tenant_archive"("tenant_id", "source_table");
SELECT tenancy_apply_isolation('"tenant_archive"');
REVOKE ALL ON "tenant_archive" FROM studyhub_app;

-- The BR-58 owner check must not block the purge of a deleted school's memberships.
CREATE OR REPLACE FUNCTION tenant_keeps_an_owner() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  affected uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  IF EXISTS (SELECT 1 FROM tenant t WHERE t.id = affected AND t.status = 'DELETED') THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM membership_role r WHERE r.tenant_id = affected AND r.role = 'TENANT_OWNER')
     AND NOT EXISTS (
       SELECT 1 FROM membership_role r JOIN tenant_membership m ON m.tenant_id = r.tenant_id AND m.id = r.membership_id
        WHERE r.tenant_id = affected AND r.role = 'TENANT_OWNER' AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'A school must keep at least one active owner (BR-58)' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'membership_role' AND TG_OP = 'DELETE' THEN
    IF OLD.role = 'TENANT_OWNER'
       AND NOT EXISTS (SELECT 1 FROM membership_role r WHERE r.tenant_id = affected AND r.role = 'TENANT_OWNER') THEN
      RAISE EXCEPTION 'A school must keep at least one active owner (BR-58)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

-- ---------------------------------------------------------------------------------------------
-- resolve_tenant() also reports hosts that redirect to a new primary address (BR-50: 90 days).
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION resolve_tenant(text);
CREATE FUNCTION resolve_tenant(p_host text)
RETURNS TABLE (tenant_id uuid, status "TenantStatus", primary_host text, is_redirect boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT t.id,
           t.status,
           (SELECT p.hostname FROM tenant_domain p
             WHERE p.tenant_id = t.id AND p.is_primary AND p.status = 'ACTIVE'
             LIMIT 1),
           d.status = 'REDIRECT'
      FROM tenant_domain d
      JOIN tenant t ON t.id = d.tenant_id
     WHERE d.hostname = lower(p_host)
       AND (d.status = 'ACTIVE' OR (d.status = 'REDIRECT' AND d.redirect_until > now()))
       AND t.status <> 'DELETED'
$fn$;
REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO studyhub_app;
ALTER FUNCTION resolve_tenant(text) OWNER TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- slug_available() (S-AD19 live availability, BR-50): true when no school uses the label as its slug
-- or as the first label of any of its hosts (retired hosts included). Returns a boolean only.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION slug_available(p_slug text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT NOT EXISTS (SELECT 1 FROM tenant t WHERE t.slug = lower(p_slug))
       AND NOT EXISTS (SELECT 1 FROM tenant_domain d WHERE split_part(d.hostname, '.', 1) = lower(p_slug))
$fn$;
REVOKE ALL ON FUNCTION slug_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION slug_available(text) TO studyhub_app;
ALTER FUNCTION slug_available(text) OWNER TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- purge_tenant() (named job tenants.purge, 04 §17.4; F46 AC 2, BR-53). Refuses unless the school is
-- OFFBOARDING and its grace period has passed. Archives financial records and the audit trail, deletes
-- every other school-owned row (in passes, so foreign keys settle in any order), and keeps the tenant row
-- as a DELETED tombstone. Returns the number of rows deleted, or -1 when the school isn't due.
-- ---------------------------------------------------------------------------------------------
DO $do$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'tenant_archive'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('GRANT SELECT, DELETE ON %I TO studyhub_rls_definer', tbl);
  END LOOP;
END
$do$;
GRANT SELECT, INSERT ON "tenant_archive" TO studyhub_rls_definer;
GRANT UPDATE ("status", "updated_at", "version") ON "tenant" TO studyhub_rls_definer;

CREATE FUNCTION purge_tenant(p_tenant uuid)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  t record;
  tbl text;
  pass integer;
  blocked integer;
  deleted bigint := 0;
  n bigint;
BEGIN
  SELECT status, delete_after INTO t FROM tenant WHERE id = p_tenant FOR UPDATE;
  IF NOT FOUND OR t.status <> 'OFFBOARDING' OR t.delete_after IS NULL OR t.delete_after > now() THEN
    RETURN -1;
  END IF;
  UPDATE tenant SET status = 'DELETED', updated_at = now(), version = version + 1 WHERE id = p_tenant;

  FOREACH tbl IN ARRAY ARRAY['order', 'order_item', 'payment', 'refund', 'receipt', 'receipt_sequence',
                             'ledger_entry', 'payout', 'audit_log'] LOOP
    EXECUTE format(
      'INSERT INTO tenant_archive (tenant_id, source_table, row_data) SELECT $1, %L, to_jsonb(x) FROM %I x WHERE x.tenant_id = $1',
      tbl, tbl) USING p_tenant;
  END LOOP;

  FOR pass IN 1..40 LOOP
    blocked := 0;
    FOR tbl IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'tenant_archive'
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       ORDER BY c.relname
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', tbl) USING p_tenant;
        GET DIAGNOSTICS n = ROW_COUNT;
        deleted := deleted + n;
      EXCEPTION WHEN foreign_key_violation THEN
        blocked := blocked + 1;
      END;
    END LOOP;
    EXIT WHEN blocked = 0;
  END LOOP;
  IF blocked > 0 THEN
    RAISE EXCEPTION 'purge_tenant: % tables still reference this school', blocked;
  END IF;
  RETURN deleted;
END
$fn$;
REVOKE ALL ON FUNCTION purge_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tenant(uuid) TO studyhub_app;
ALTER FUNCTION purge_tenant(uuid) OWNER TO studyhub_rls_definer;
