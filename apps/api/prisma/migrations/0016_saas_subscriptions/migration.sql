-- SaaS subscriptions (docs/design/saas-billing.md, phase 3): one subscription per school with an explicit
-- lifecycle and an append-only history, manual payments of SaaS invoices, setup invoices that gate a
-- school's go-live, and platform statements archived (not deleted) by the offboarding purge.

CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');
CREATE TYPE "ActivationPolicy" AS ENUM ('IMMEDIATE', 'AFTER_SETUP_PAYMENT');
CREATE TYPE "SaasInvoiceKind" AS ENUM ('RECURRING', 'SETUP');
CREATE TYPE "SaasPaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'OTHER');

-- Manual receipts land in the platform's bank account (provider collections come in phase 4). The
-- chart is written in the platform realm only (row-level security and billing_platform_write).
SELECT set_config('app.realm', 'platform', false);
INSERT INTO "platform_ledger_account" ("code", "name", "type", "normal_balance", "per_tenant")
    VALUES ('cash.bank', 'Platform bank account (manual receipts)', 'ASSET', 'DEBIT', false);
SELECT set_config('app.realm', '', false);

-- ---------------------------------------------------------------------------------------------
-- Contracts: how the school goes live is part of the frozen terms.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "tenant_contract" ADD COLUMN "activation_policy" "ActivationPolicy" NOT NULL DEFAULT 'IMMEDIATE';

CREATE OR REPLACE FUNCTION tenant_contract_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
    IF (NEW.tenant_ref, NEW.plan_version_id, NEW.kind, NEW.overrides, NEW.enabled_addons, NEW.discounts,
        NEW.billing_anchor_day, NEW.starts_on, NEW.activation_policy)
       IS DISTINCT FROM
       (OLD.tenant_ref, OLD.plan_version_id, OLD.kind, OLD.overrides, OLD.enabled_addons, OLD.discounts,
        OLD.billing_anchor_day, OLD.starts_on, OLD.activation_policy) THEN
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

-- ---------------------------------------------------------------------------------------------
-- Invoices: a kind (setup invoices are issued up front, recurring ones in arrears) and the amount paid.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "saas_invoice"
    ADD COLUMN "kind" "SaasInvoiceKind" NOT NULL DEFAULT 'RECURRING',
    ADD COLUMN "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT "saas_invoice_paid_range" CHECK ("amount_paid_minor" BETWEEN 0 AND "total_minor"),
    ADD CONSTRAINT "saas_invoice_paid_status" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL)
        AND ("status" <> 'PAID' OR "amount_paid_minor" = "total_minor"));
DROP INDEX "saas_invoice_one_per_period";
CREATE UNIQUE INDEX "saas_invoice_one_per_period" ON "saas_invoice"("contract_id", "kind", "period_start")
    WHERE "status" <> 'VOID';

CREATE OR REPLACE FUNCTION saas_invoice_guard() RETURNS trigger
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
         NEW.total_minor, NEW.issued_at, NEW.due_at, NEW.kind)
       IS DISTINCT FROM (
         OLD.tenant_ref, OLD.contract_id, OLD.plan_version_id, OLD.snapshot_id, OLD.number, OLD.invoice_index,
         OLD.period_start, OLD.period_end, OLD.currency, OLD.subtotal_minor, OLD.discount_minor, OLD.tax_minor,
         OLD.total_minor, OLD.issued_at, OLD.due_at, OLD.kind) THEN
      RAISE EXCEPTION 'An issued invoice can''t be changed; void it and issue a new one' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD.status = NEW.status
            OR (OLD.status = 'DRAFT' AND NEW.status IN ('ISSUED', 'VOID'))
            OR (OLD.status = 'ISSUED' AND NEW.status IN ('PAID', 'VOID'))) THEN
      RAISE EXCEPTION 'Invoice status can''t move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    -- Payments only add up, only on an issued invoice, and a paid or partly paid invoice is never voided.
    IF NEW.amount_paid_minor <> OLD.amount_paid_minor
       AND (OLD.status <> 'ISSUED' OR NEW.amount_paid_minor < OLD.amount_paid_minor) THEN
      RAISE EXCEPTION 'Payments can only be added to an issued invoice' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'VOID' AND OLD.amount_paid_minor > 0 THEN
      RAISE EXCEPTION 'An invoice with payments can''t be voided' USING ERRCODE = 'check_violation';
    END IF;
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

-- ---------------------------------------------------------------------------------------------
-- Manual payments of SaaS invoices (append-only; a reference is recorded once per method).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "saas_payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "tenant_ref" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" "SaasPaymentMethod" NOT NULL,
    "reference" TEXT NOT NULL,
    "received_on" DATE NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "recorded_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saas_payment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saas_payment_invoice_fkey" FOREIGN KEY ("invoice_id") REFERENCES "saas_invoice"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_payment_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "saas_payment_amount" CHECK ("amount_minor" > 0),
    CONSTRAINT "saas_payment_reference" CHECK (char_length("reference") BETWEEN 3 AND 120)
);
CREATE UNIQUE INDEX "saas_payment_reference_key" ON "saas_payment"("method", "reference");
CREATE INDEX "saas_payment_invoice_idx" ON "saas_payment"("invoice_id");

-- ---------------------------------------------------------------------------------------------
-- Subscriptions and their history
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_ref" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "trial_ends_on" DATE,
    -- Invoiced up to this day (exclusive end of the last billed period).
    "billed_through" DATE NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "past_due_since" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    -- Billing suspended the school, so billing may lift it (never a suspension made by staff).
    "suspended_for_billing" BOOLEAN NOT NULL DEFAULT false,
    "setup_paid_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_subscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_subscription_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_subscription_contract_fkey" FOREIGN KEY ("contract_id") REFERENCES "tenant_contract"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_subscription_cancelled" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
    CONSTRAINT "tenant_subscription_suspended" CHECK (("status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL)),
    CONSTRAINT "tenant_subscription_past_due" CHECK ("status" NOT IN ('PAST_DUE', 'SUSPENDED') OR "past_due_since" IS NOT NULL)
);
CREATE UNIQUE INDEX "tenant_subscription_one_live" ON "tenant_subscription"("tenant_ref") WHERE "status" <> 'CANCELLED';
CREATE INDEX "tenant_subscription_status_idx" ON "tenant_subscription"("status");

-- Explicit transitions only (the state machine of docs/design/saas-billing.md §10).
CREATE FUNCTION tenant_subscription_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_ref <> OLD.tenant_ref THEN
      RAISE EXCEPTION 'A subscription belongs to one school' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.billed_through < OLD.billed_through THEN
      RAISE EXCEPTION 'Billing never goes back in time' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD.status = NEW.status
            OR (OLD.status = 'TRIALING' AND NEW.status IN ('ACTIVE', 'PAST_DUE', 'CANCELLED'))
            OR (OLD.status = 'ACTIVE' AND NEW.status IN ('PAST_DUE', 'CANCELLED'))
            OR (OLD.status = 'PAST_DUE' AND NEW.status IN ('ACTIVE', 'SUSPENDED', 'CANCELLED'))
            OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'Subscription status can''t move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION tenant_subscription_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_subscription_guard() TO studyhub_app;
CREATE TRIGGER tenant_subscription_guard BEFORE UPDATE ON "tenant_subscription"
    FOR EACH ROW EXECUTE FUNCTION tenant_subscription_guard();

CREATE TABLE "subscription_event" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "subscription_id" UUID NOT NULL,
    "tenant_ref" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "from_status" "SubscriptionStatus",
    "to_status" "SubscriptionStatus",
    "detail" JSONB NOT NULL DEFAULT '{}',
    "actor_id" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_event_subscription_fkey" FOREIGN KEY ("subscription_id") REFERENCES "tenant_subscription"("id") ON DELETE RESTRICT,
    CONSTRAINT "subscription_event_tenant_fkey" FOREIGN KEY ("tenant_ref") REFERENCES "tenant"("id") ON DELETE RESTRICT
);
CREATE INDEX "subscription_event_subscription_idx" ON "subscription_event"("subscription_id", "at");

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants (as migration 0015)
-- ---------------------------------------------------------------------------------------------
DO $do$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['saas_payment', 'tenant_subscription', 'subscription_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY platform_realm ON %I
        USING (current_setting('app.realm', true) = 'platform')
        WITH CHECK (current_setting('app.realm', true) = 'platform')$p$, tbl);
    EXECUTE format($p$CREATE POLICY school_read ON %I FOR SELECT
        USING ("tenant_ref"::text = current_setting('app.tenant_id', true))$p$, tbl);
    EXECUTE format('CREATE TRIGGER billing_platform_write BEFORE INSERT OR UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION billing_platform_write()', tbl);
  END LOOP;
END
$do$;
CREATE TRIGGER subscription_event_append_only BEFORE UPDATE OR DELETE ON "subscription_event"
    FOR EACH ROW EXECUTE FUNCTION platform_ledger_append_only();
CREATE TRIGGER saas_payment_append_only BEFORE UPDATE OR DELETE ON "saas_payment"
    FOR EACH ROW EXECUTE FUNCTION platform_ledger_append_only();

GRANT SELECT, INSERT, UPDATE ON "tenant_subscription" TO studyhub_app;
GRANT SELECT, INSERT ON "subscription_event", "saas_payment" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- The offboarding purge archives platform statements too (they were deleted before; M9 gap).
-- Same function as migration 0009 otherwise; it keeps its owner (studyhub_rls_definer) and grants. The
-- migrator may act as the owner only explicitly (membership WITH INHERIT FALSE, SET TRUE; 02-tenancy-roles).
-- ---------------------------------------------------------------------------------------------
SET ROLE studyhub_rls_definer;
CREATE OR REPLACE FUNCTION purge_tenant(p_tenant uuid)
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
                             'ledger_entry', 'payout', 'audit_log', 'platform_statement'] LOOP
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
RESET ROLE;
