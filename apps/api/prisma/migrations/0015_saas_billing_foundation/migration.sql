-- SaaS billing foundation (docs/design/saas-billing.md, phase 2): commercial plans and immutable versions,
-- school contracts, frozen usage snapshots, SaaS invoices with immutable lines, and the platform's
-- double-entry ledger. All are the platform's own records: they name a school by `tenant_ref` (not
-- `tenant_id`), so a school's offboarding purge never deletes the platform's books. Schools can read
-- their own contracts, snapshots and invoices; only the platform realm writes. No table is granted DELETE.

CREATE TYPE "CommercialPlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "PlanVisibility" AS ENUM ('PUBLIC', 'CONTRACT_ONLY');
CREATE TYPE "PlanVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "BillingCycle" AS ENUM ('MONTH', 'QUARTER', 'YEAR');
CREATE TYPE "ContractKind" AS ENUM ('STANDARD', 'ENTERPRISE');
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ENDED');
CREATE TYPE "SaasInvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID');
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'SUSPENSE');
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- Policies shared by the tables below.
CREATE FUNCTION billing_platform_write() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF coalesce(current_setting('app.realm', true), '') <> 'platform' THEN
    RAISE EXCEPTION 'Billing records are written by the platform only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION billing_platform_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_platform_write() TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- Commercial plans and versions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "commercial_plan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "audience" "TenantKind"[] NOT NULL DEFAULT '{}',
    "visibility" "PlanVisibility" NOT NULL DEFAULT 'PUBLIC',
    "feature_plan_id" UUID,
    "status" "CommercialPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_plan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_plan_feature_plan_fkey" FOREIGN KEY ("feature_plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT,
    CONSTRAINT "commercial_plan_code_format" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,39}$'),
    CONSTRAINT "commercial_plan_name_length" CHECK (char_length("name") BETWEEN 2 AND 120)
);
CREATE UNIQUE INDEX "commercial_plan_code_key" ON "commercial_plan"("code");

CREATE TABLE "commercial_plan_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "billing_cycle" "BillingCycle" NOT NULL,
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "grace_days" INTEGER NOT NULL DEFAULT 7,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 14,
    "components" JSONB NOT NULL,
    "allowed_payment_modes" TEXT[] NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "published_at" TIMESTAMPTZ(3),
    "published_by" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_plan_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_plan_version_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "commercial_plan"("id") ON DELETE RESTRICT,
    CONSTRAINT "commercial_plan_version_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "commercial_plan_version_days" CHECK (
        "trial_days" BETWEEN 0 AND 365 AND "grace_days" BETWEEN 0 AND 90 AND "payment_terms_days" BETWEEN 0 AND 90),
    CONSTRAINT "commercial_plan_version_components" CHECK (jsonb_typeof("components") = 'array' AND jsonb_array_length("components") >= 1),
    CONSTRAINT "commercial_plan_version_modes" CHECK (
        cardinality("allowed_payment_modes") >= 1
        AND "allowed_payment_modes" <@ ARRAY['TENANT_MERCHANT', 'PLATFORM_MERCHANT', 'PLATFORM_COLLECT_SETTLE']::TEXT[]),
    CONSTRAINT "commercial_plan_version_published" CHECK (("status" = 'DRAFT') = ("published_at" IS NULL))
);
CREATE UNIQUE INDEX "commercial_plan_version_plan_version_key" ON "commercial_plan_version"("plan_id", "version");

-- A published version never changes (invoices reproduce from it); it can only be archived.
CREATE FUNCTION commercial_plan_version_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
    IF (NEW.plan_id, NEW.version, NEW.currency, NEW.billing_cycle, NEW.trial_days, NEW.grace_days,
        NEW.payment_terms_days, NEW.components, NEW.allowed_payment_modes, NEW.published_at)
       IS DISTINCT FROM
       (OLD.plan_id, OLD.version, OLD.currency, OLD.billing_cycle, OLD.trial_days, OLD.grace_days,
        OLD.payment_terms_days, OLD.components, OLD.allowed_payment_modes, OLD.published_at) THEN
      RAISE EXCEPTION 'A published plan version can''t be changed; create a new version' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD.status = NEW.status OR (OLD.status = 'PUBLISHED' AND NEW.status = 'ARCHIVED')) THEN
      RAISE EXCEPTION 'Plan version status can''t move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION commercial_plan_version_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commercial_plan_version_guard() TO studyhub_app;
CREATE TRIGGER commercial_plan_version_guard BEFORE UPDATE ON "commercial_plan_version"
    FOR EACH ROW EXECUTE FUNCTION commercial_plan_version_guard();

-- ---------------------------------------------------------------------------------------------
-- Contracts: a school's plan version with negotiated terms. Terms freeze once the contract is active;
-- a change is a new contract (the old one ends).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_contract" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_ref" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "kind" "ContractKind" NOT NULL DEFAULT 'STANDARD',
    "overrides" JSONB NOT NULL DEFAULT '[]',
    "enabled_addons" TEXT[] NOT NULL DEFAULT '{}',
    "discounts" JSONB NOT NULL DEFAULT '[]',
    "billing_anchor_day" SMALLINT NOT NULL DEFAULT 1,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT NOT NULL DEFAULT '',
    "activated_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_contract_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_contract_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_contract_version_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "commercial_plan_version"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_contract_anchor" CHECK ("billing_anchor_day" BETWEEN 1 AND 28),
    CONSTRAINT "tenant_contract_dates" CHECK ("ends_on" IS NULL OR "ends_on" > "starts_on"),
    CONSTRAINT "tenant_contract_json" CHECK (jsonb_typeof("overrides") = 'array' AND jsonb_typeof("discounts") = 'array')
);
CREATE INDEX "tenant_contract_tenant_idx" ON "tenant_contract"("tenant_ref", "created_at" DESC);
CREATE UNIQUE INDEX "tenant_contract_one_active" ON "tenant_contract"("tenant_ref") WHERE "status" = 'ACTIVE';

CREATE FUNCTION tenant_contract_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
    IF (NEW.tenant_ref, NEW.plan_version_id, NEW.kind, NEW.overrides, NEW.enabled_addons, NEW.discounts,
        NEW.billing_anchor_day, NEW.starts_on)
       IS DISTINCT FROM
       (OLD.tenant_ref, OLD.plan_version_id, OLD.kind, OLD.overrides, OLD.enabled_addons, OLD.discounts,
        OLD.billing_anchor_day, OLD.starts_on) THEN
      RAISE EXCEPTION 'An active contract''s terms can''t be changed; end it and start a new one' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.ends_on IS DISTINCT FROM OLD.ends_on AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'ENDED') THEN
      RAISE EXCEPTION 'A contract''s end date is set when it ends' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD.status = NEW.status OR (OLD.status = 'ACTIVE' AND NEW.status = 'ENDED')) THEN
      RAISE EXCEPTION 'Contract status can''t move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION tenant_contract_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_contract_guard() TO studyhub_app;
CREATE TRIGGER tenant_contract_guard BEFORE UPDATE ON "tenant_contract"
    FOR EACH ROW EXECUTE FUNCTION tenant_contract_guard();

-- ---------------------------------------------------------------------------------------------
-- Usage snapshots: the counts an invoice was priced from, frozen when taken (insert only).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "usage_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_ref" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "students" JSONB NOT NULL,
    "revenue" JSONB NOT NULL,
    "rules" JSONB NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_snapshot_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "usage_snapshot_period" CHECK ("period_end" > "period_start")
);
CREATE UNIQUE INDEX "usage_snapshot_tenant_period_key" ON "usage_snapshot"("tenant_ref", "period_start", "period_end");

-- ---------------------------------------------------------------------------------------------
-- SaaS invoices and lines. Amounts freeze when issued; corrections are a void (with a reversing
-- journal) and a new invoice. Lines can only be added while the invoice is a draft.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "saas_invoice_sequence" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "saas_invoice_sequence_pkey" PRIMARY KEY ("year"),
    CONSTRAINT "saas_invoice_sequence_last" CHECK ("last" >= 0)
);

CREATE TABLE "saas_invoice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_ref" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "snapshot_id" UUID,
    "number" TEXT,
    "invoice_index" INTEGER NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "SaasInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "issued_at" TIMESTAMPTZ(3),
    "due_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saas_invoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saas_invoice_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_invoice_contract_fkey" FOREIGN KEY ("contract_id") REFERENCES "tenant_contract"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_invoice_version_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "commercial_plan_version"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_invoice_snapshot_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "usage_snapshot"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_invoice_period" CHECK ("period_end" > "period_start"),
    CONSTRAINT "saas_invoice_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "saas_invoice_amounts" CHECK (
        "subtotal_minor" >= 0 AND "discount_minor" >= 0 AND "tax_minor" >= 0
        AND "discount_minor" <= "subtotal_minor"
        AND "total_minor" = "subtotal_minor" - "discount_minor" + "tax_minor"),
    CONSTRAINT "saas_invoice_numbered" CHECK (("status" = 'DRAFT' OR "status" = 'VOID') OR "number" IS NOT NULL),
    CONSTRAINT "saas_invoice_void" CHECK (("status" = 'VOID') = ("voided_at" IS NOT NULL AND "void_reason" IS NOT NULL))
);
CREATE UNIQUE INDEX "saas_invoice_number_key" ON "saas_invoice"("number");
-- One live invoice per contract and period.
CREATE UNIQUE INDEX "saas_invoice_one_per_period" ON "saas_invoice"("contract_id", "period_start")
    WHERE "status" <> 'VOID';
CREATE INDEX "saas_invoice_tenant_idx" ON "saas_invoice"("tenant_ref", "period_start" DESC);
CREATE INDEX "saas_invoice_status_due_idx" ON "saas_invoice"("status", "due_at");

CREATE TABLE "saas_invoice_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "tenant_ref" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "unit_amount_minor" BIGINT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "revenue_account" TEXT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "calculation" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "saas_invoice_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saas_invoice_line_invoice_fkey" FOREIGN KEY ("invoice_id") REFERENCES "saas_invoice"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_invoice_line_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_invoice_line_kind" CHECK ("kind" IN ('LICENCE', 'HOSTING', 'MAINTENANCE', 'SERVICE', 'PER_STUDENT',
        'OVERAGE', 'REVENUE_SHARE', 'TRANSACTION_FEE', 'MINIMUM_TOPUP', 'ONE_TIME', 'DISCOUNT')),
    CONSTRAINT "saas_invoice_line_sign" CHECK (("kind" = 'DISCOUNT') = ("amount_minor" < 0) AND "amount_minor" <> 0),
    CONSTRAINT "saas_invoice_line_tax" CHECK ("tax_rate_bps" BETWEEN 0 AND 10000 AND "tax_minor" >= 0)
);
CREATE UNIQUE INDEX "saas_invoice_line_position_key" ON "saas_invoice_line"("invoice_id", "position");

CREATE FUNCTION saas_invoice_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  sums record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'DRAFT' AND (
         NEW.tenant_ref, NEW.contract_id, NEW.plan_version_id, NEW.snapshot_id, NEW.number, NEW.invoice_index,
         NEW.period_start, NEW.period_end, NEW.currency, NEW.subtotal_minor, NEW.discount_minor, NEW.tax_minor,
         NEW.total_minor, NEW.issued_at, NEW.due_at)
       IS DISTINCT FROM (
         OLD.tenant_ref, OLD.contract_id, OLD.plan_version_id, OLD.snapshot_id, OLD.number, OLD.invoice_index,
         OLD.period_start, OLD.period_end, OLD.currency, OLD.subtotal_minor, OLD.discount_minor, OLD.tax_minor,
         OLD.total_minor, OLD.issued_at, OLD.due_at) THEN
      RAISE EXCEPTION 'An issued invoice can''t be changed; void it and issue a new one' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD.status = NEW.status
            OR (OLD.status = 'DRAFT' AND NEW.status IN ('ISSUED', 'VOID'))
            OR (OLD.status = 'ISSUED' AND NEW.status IN ('PAID', 'VOID'))) THEN
      RAISE EXCEPTION 'Invoice status can''t move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    -- Issuing checks the totals against the lines.
    IF OLD.status = 'DRAFT' AND NEW.status = 'ISSUED' THEN
      SELECT coalesce(sum(amount_minor) FILTER (WHERE kind <> 'DISCOUNT'), 0) AS subtotal,
             coalesce(-sum(amount_minor) FILTER (WHERE kind = 'DISCOUNT'), 0) AS discount,
             coalesce(sum(tax_minor), 0) AS tax
        INTO sums FROM saas_invoice_line WHERE invoice_id = NEW.id;
      IF (sums.subtotal, sums.discount, sums.tax) IS DISTINCT FROM (NEW.subtotal_minor, NEW.discount_minor, NEW.tax_minor) THEN
        RAISE EXCEPTION 'Invoice totals don''t match its lines' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.issued_at IS NULL OR NEW.due_at IS NULL THEN
        RAISE EXCEPTION 'An issued invoice needs its issue and due dates' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION saas_invoice_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas_invoice_guard() TO studyhub_app;
CREATE TRIGGER saas_invoice_guard BEFORE UPDATE ON "saas_invoice"
    FOR EACH ROW EXECUTE FUNCTION saas_invoice_guard();

CREATE FUNCTION saas_invoice_line_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  invoice record;
BEGIN
  SELECT status, tenant_ref INTO invoice FROM saas_invoice WHERE id = NEW.invoice_id;
  IF invoice.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines can only be added to a draft invoice' USING ERRCODE = 'check_violation';
  END IF;
  IF invoice.tenant_ref <> NEW.tenant_ref THEN
    RAISE EXCEPTION 'An invoice line belongs to its invoice''s school' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION saas_invoice_line_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas_invoice_line_guard() TO studyhub_app;
CREATE TRIGGER saas_invoice_line_guard BEFORE INSERT ON "saas_invoice_line"
    FOR EACH ROW EXECUTE FUNCTION saas_invoice_line_guard();

-- ---------------------------------------------------------------------------------------------
-- Platform ledger: double-entry, append-only. Every journal balances per currency (checked at
-- commit) and has at least two lines; nothing is ever updated or deleted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "platform_ledger_account" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "normal_balance" "NormalBalance" NOT NULL,
    "per_tenant" BOOLEAN NOT NULL,

    CONSTRAINT "platform_ledger_account_pkey" PRIMARY KEY ("code")
);
INSERT INTO "platform_ledger_account" ("code", "name", "type", "normal_balance", "per_tenant") VALUES
    ('cash.provider', 'Provider wallet (platform merchant)', 'ASSET', 'DEBIT', false),
    ('receivable.saas', 'SaaS invoices receivable', 'ASSET', 'DEBIT', true),
    ('settlement.in_transit', 'Settlements in transit', 'ASSET', 'DEBIT', true),
    ('unreconciled', 'Unreconciled transactions', 'SUSPENSE', 'DEBIT', false),
    ('payable.tenant_funds', 'School funds payable', 'LIABILITY', 'CREDIT', true),
    ('liability.refunds', 'Refunds owed', 'LIABILITY', 'CREDIT', true),
    ('liability.tax', 'Tax payable', 'LIABILITY', 'CREDIT', false),
    ('revenue.licence', 'Licence revenue', 'REVENUE', 'CREDIT', false),
    ('revenue.hosting', 'Hosting revenue', 'REVENUE', 'CREDIT', false),
    ('revenue.maintenance', 'Maintenance revenue', 'REVENUE', 'CREDIT', false),
    ('revenue.services', 'Other service revenue', 'REVENUE', 'CREDIT', false),
    ('revenue.usage', 'Usage revenue (students)', 'REVENUE', 'CREDIT', false),
    ('revenue.setup', 'Setup and one-time revenue', 'REVENUE', 'CREDIT', false),
    ('revenue.commission', 'Commission revenue', 'REVENUE', 'CREDIT', false),
    ('revenue.discounts', 'Discounts given (contra revenue)', 'REVENUE', 'DEBIT', false),
    ('expense.provider_fees', 'Provider processing fees', 'EXPENSE', 'DEBIT', false);

CREATE TABLE "platform_ledger_journal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "reverses_journal_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_ledger_journal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_ledger_journal_reverses_fkey" FOREIGN KEY ("reverses_journal_id") REFERENCES "platform_ledger_journal"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_ledger_journal_currency" CHECK ("currency" ~ '^[A-Z]{3}$')
);
-- A business event is posted at most once (retries are harmless); a journal is reversed at most once.
CREATE UNIQUE INDEX "platform_ledger_journal_source_key" ON "platform_ledger_journal"("source_type", "source_id", "kind");
CREATE UNIQUE INDEX "platform_ledger_journal_reverses_key" ON "platform_ledger_journal"("reverses_journal_id");

CREATE TABLE "platform_ledger_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "journal_id" UUID NOT NULL,
    "account_code" TEXT NOT NULL,
    "tenant_ref" UUID,
    "debit_minor" BIGINT NOT NULL DEFAULT 0,
    "credit_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "memo" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "platform_ledger_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_ledger_line_journal_fkey" FOREIGN KEY ("journal_id") REFERENCES "platform_ledger_journal"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_ledger_line_account_fkey" FOREIGN KEY ("account_code") REFERENCES "platform_ledger_account"("code") ON DELETE RESTRICT,
    CONSTRAINT "platform_ledger_line_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_ledger_line_one_side" CHECK (
        ("debit_minor" > 0 AND "credit_minor" = 0) OR ("credit_minor" > 0 AND "debit_minor" = 0))
);
CREATE INDEX "platform_ledger_line_journal_idx" ON "platform_ledger_line"("journal_id");
CREATE INDEX "platform_ledger_line_account_tenant_idx" ON "platform_ledger_line"("account_code", "tenant_ref");

CREATE FUNCTION platform_ledger_line_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  journal_currency char(3);
  needs_tenant boolean;
BEGIN
  SELECT currency INTO journal_currency FROM platform_ledger_journal WHERE id = NEW.journal_id;
  IF journal_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'A ledger line is in its journal''s currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT per_tenant INTO needs_tenant FROM platform_ledger_account WHERE code = NEW.account_code;
  IF needs_tenant AND NEW.tenant_ref IS NULL THEN
    RAISE EXCEPTION 'Lines on % must name a school', NEW.account_code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION platform_ledger_line_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ledger_line_guard() TO studyhub_app;
CREATE TRIGGER platform_ledger_line_guard BEFORE INSERT ON "platform_ledger_line"
    FOR EACH ROW EXECUTE FUNCTION platform_ledger_line_guard();

-- Checked at commit, once the journal's lines are all in.
CREATE FUNCTION platform_ledger_journal_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  journal uuid;
  totals record;
BEGIN
  -- Fields are looked up on the row's own table only (a CASE would resolve both).
  IF TG_TABLE_NAME = 'platform_ledger_journal' THEN
    journal := NEW.id;
  ELSE
    journal := NEW.journal_id;
  END IF;
  SELECT count(*) AS lines, coalesce(sum(debit_minor), 0) AS debits, coalesce(sum(credit_minor), 0) AS credits
    INTO totals FROM platform_ledger_line WHERE journal_id = journal;
  IF totals.lines < 2 THEN
    RAISE EXCEPTION 'Ledger journal % needs at least two lines', journal USING ERRCODE = 'check_violation';
  END IF;
  IF totals.debits <> totals.credits THEN
    RAISE EXCEPTION 'Ledger journal % is unbalanced: debits %, credits %', journal, totals.debits, totals.credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION platform_ledger_journal_balanced() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ledger_journal_balanced() TO studyhub_app;
CREATE CONSTRAINT TRIGGER platform_ledger_journal_balanced AFTER INSERT ON "platform_ledger_journal"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_ledger_journal_balanced();
CREATE CONSTRAINT TRIGGER platform_ledger_line_balanced AFTER INSERT ON "platform_ledger_line"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_ledger_journal_balanced();

-- Append-only, even for a role that could update.
CREATE FUNCTION platform_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION 'The ledger is append-only; post a reversing journal instead' USING ERRCODE = 'insufficient_privilege';
END
$fn$;
REVOKE ALL ON FUNCTION platform_ledger_append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ledger_append_only() TO studyhub_app;
CREATE TRIGGER platform_ledger_journal_append_only BEFORE UPDATE OR DELETE ON "platform_ledger_journal"
    FOR EACH ROW EXECUTE FUNCTION platform_ledger_append_only();
CREATE TRIGGER platform_ledger_line_append_only BEFORE UPDATE OR DELETE ON "platform_ledger_line"
    FOR EACH ROW EXECUTE FUNCTION platform_ledger_append_only();

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
DO $do$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['commercial_plan', 'commercial_plan_version', 'tenant_contract', 'usage_snapshot',
                             'saas_invoice_sequence', 'saas_invoice', 'saas_invoice_line', 'platform_ledger_account',
                             'platform_ledger_journal', 'platform_ledger_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY platform_realm ON %I
        USING (current_setting('app.realm', true) = 'platform')
        WITH CHECK (current_setting('app.realm', true) = 'platform')$p$, tbl);
    EXECUTE format('CREATE TRIGGER billing_platform_write BEFORE INSERT OR UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION billing_platform_write()', tbl);
  END LOOP;
  -- Schools read their own contracts, snapshots, invoices and lines.
  FOREACH tbl IN ARRAY ARRAY['tenant_contract', 'usage_snapshot', 'saas_invoice', 'saas_invoice_line'] LOOP
    EXECUTE format($p$CREATE POLICY school_read ON %I FOR SELECT
        USING ("tenant_ref"::text = current_setting('app.tenant_id', true))$p$, tbl);
  END LOOP;
END
$do$;
-- Published plans (and their plans) are readable by schools, for comparing plans.
CREATE POLICY published_read ON "commercial_plan" FOR SELECT USING ("status" = 'ACTIVE');
CREATE POLICY published_read ON "commercial_plan_version" FOR SELECT USING ("status" = 'PUBLISHED');

GRANT SELECT, INSERT, UPDATE ON "commercial_plan", "commercial_plan_version", "tenant_contract", "saas_invoice",
    "saas_invoice_sequence" TO studyhub_app;
GRANT SELECT, INSERT ON "usage_snapshot", "saas_invoice_line", "platform_ledger_journal", "platform_ledger_line"
    TO studyhub_app;
GRANT SELECT ON "platform_ledger_account" TO studyhub_app;
