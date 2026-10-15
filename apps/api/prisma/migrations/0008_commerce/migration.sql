-- 0008_commerce (M8): school payment accounts, orders, payments, webhook events, refunds, receipts,
-- idempotency keys, the instructor earnings ledger, payouts and payout methods, and ledger checks.
-- Blueprint 03 F24–F29, F45, §9.5 W1–W6; 04 §7.1, §7.2, §17.10; 05 §3.6, §3.7, §8.2; BR-07 to BR-15,
-- BR-33, BR-35, BR-36, BR-54, BR-55, BR-62. docs/design/m8-commerce-ledger.md.
-- Every table is school-owned (tenant_isolation). Money is bigint minor units with a currency (BR-06).

CREATE TYPE "PaymentAccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'FAILED_TEST');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED');
CREATE TYPE "PaymentMethod" AS ENUM ('MOBILE_MONEY', 'CARD');
CREATE TYPE "MobileNetwork" AS ENUM ('MTN', 'AIRTEL', 'ZAMTEL');
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'NEEDS_REVIEW', 'REFUNDED');
CREATE TYPE "RefundMode" AS ENUM ('PROVIDER', 'MANUAL');
CREATE TYPE "RefundStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "LedgerType" AS ENUM ('SALE', 'REFUND_REVERSAL', 'ADJUSTMENT');
CREATE TYPE "LedgerStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PAID', 'FROZEN');
CREATE TYPE "PayoutMethodType" AS ENUM ('MOBILE_MONEY', 'BANK');

-- Receipt numbers are {PREFIX}-{year}-{seq} per school (BR-55). Optional: receipts fall back to a prefix
-- derived from the slug (the console can set one later).
ALTER TABLE "tenant" ADD COLUMN "receipt_prefix" TEXT;
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_receipt_prefix_format" CHECK ("receipt_prefix" IS NULL OR "receipt_prefix" ~ '^[A-Z0-9]{2,8}$');

-- ---------------------------------------------------------------------------------------------
-- Payment accounts (F45, ADR-019). Credentials and the webhook secret are envelope-encrypted by the
-- application (a data key per row, sealed by the key-encryption key); only a masked hint is readable.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "payment_account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "PaymentAccountStatus" NOT NULL DEFAULT 'PENDING',
    "credentials_enc" BYTEA NOT NULL,
    "webhook_secret_enc" BYTEA NOT NULL,
    "data_key_enc" BYTEA NOT NULL,
    "masked_hint" TEXT NOT NULL,
    "capabilities" JSONB,
    "last_tested_at" TIMESTAMPTZ(3),
    "last_test_result" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "payment_account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_account_created_by_fkey" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "payment_account_provider_format" CHECK ("provider" ~ '^[a-z][a-z0-9_]{1,30}$'),
    CONSTRAINT "payment_account_label_length" CHECK (char_length("label") BETWEEN 1 AND 80),
    CONSTRAINT "payment_account_active_tested" CHECK ("status" <> 'ACTIVE' OR "capabilities" IS NOT NULL)
);
CREATE UNIQUE INDEX "payment_account_tenant_id_id_key" ON "payment_account"("tenant_id", "id");
-- One active account per school at launch (05 §8.2).
CREATE UNIQUE INDEX "payment_account_one_active" ON "payment_account"("tenant_id") WHERE "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------------------------
-- Orders (BR-08: snapshot at creation) and their items. One item per order in the first release.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "currency" CHAR(3) NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "order_total_positive" CHECK ("total_minor" > 0),
    CONSTRAINT "order_paid_at" CHECK ("status" NOT IN ('PAID', 'REFUNDED') OR "paid_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "order_tenant_id_id_key" ON "order"("tenant_id", "id");
CREATE INDEX "order_tenant_member_created_idx" ON "order"("tenant_id", "membership_id", "created_at" DESC);
CREATE INDEX "order_tenant_status_idx" ON "order"("tenant_id", "status", "expires_at");
CREATE INDEX "order_tenant_created_idx" ON "order"("tenant_id", "created_at" DESC);

CREATE TABLE "order_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "instructor_membership_id" UUID NOT NULL,
    "title_snapshot" TEXT NOT NULL,
    "instructor_name_snapshot" TEXT NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "access_days" INTEGER,
    -- Set when the sale is confirmed with revenue share on (W2): the ledger check expects a SALE entry.
    "commission_bps" INTEGER,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_item_order_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "order_item_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "order_item_instructor_fkey" FOREIGN KEY ("tenant_id", "instructor_membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "order_item_price_positive" CHECK ("unit_price_minor" > 0),
    CONSTRAINT "order_item_commission_range" CHECK ("commission_bps" IS NULL OR "commission_bps" BETWEEN 0 AND 10000)
);
CREATE UNIQUE INDEX "order_item_tenant_id_id_key" ON "order_item"("tenant_id", "id");
CREATE INDEX "order_item_tenant_order_idx" ON "order_item"("tenant_id", "order_id");
CREATE INDEX "order_item_tenant_course_idx" ON "order_item"("tenant_id", "course_id");

-- The enrolment a purchase created (M6 left order_item_id without its key).
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_order_item_fkey" FOREIGN KEY ("tenant_id", "order_item_id") REFERENCES "order_item"("tenant_id", "id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------------------------
-- Payments (05 §3.6 state machine). `reference` is our UUID sent to the provider.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_account_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "network" "MobileNetwork",
    "msisdn_enc" BYTEA,
    "msisdn_masked" TEXT,
    "reference" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_transaction_id" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    -- What the provider reported (authoritative), for BR-10 and the exceptions queue.
    "provider_amount_minor" BIGINT,
    "provider_currency" CHAR(3),
    "provider_fee_minor" BIGINT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "failure_code" TEXT,
    "failure_message" TEXT,
    "review_reason" TEXT,
    "next_check_at" TIMESTAMPTZ(3),
    "check_count" INTEGER NOT NULL DEFAULT 0,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_order_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "payment_account_fkey" FOREIGN KEY ("tenant_id", "payment_account_id") REFERENCES "payment_account"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "payment_amount_positive" CHECK ("amount_minor" > 0),
    CONSTRAINT "payment_mobile_fields" CHECK ("method" <> 'MOBILE_MONEY' OR ("network" IS NOT NULL AND "msisdn_enc" IS NOT NULL))
);
CREATE UNIQUE INDEX "payment_tenant_id_id_key" ON "payment"("tenant_id", "id");
-- Random UUIDs; unique per school is enough (every index starts with tenant_id, T-ISO-03).
CREATE UNIQUE INDEX "payment_tenant_reference_key" ON "payment"("tenant_id", "reference");
CREATE UNIQUE INDEX "payment_account_provider_tx_key" ON "payment"("tenant_id", "payment_account_id", "provider_transaction_id");
-- BR-36: one payment in flight per order.
CREATE UNIQUE INDEX "payment_one_in_flight" ON "payment"("tenant_id", "order_id") WHERE "status" IN ('INITIATED', 'PENDING');
CREATE INDEX "payment_tenant_order_idx" ON "payment"("tenant_id", "order_id", "created_at" DESC);
CREATE INDEX "payment_tenant_status_idx" ON "payment"("tenant_id", "status", "created_at");

-- Verified provider events, stored raw before processing (F26). Retained 2 years, then purged (05 §3.6).
CREATE TABLE "payment_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "payment_account_id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "payment_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "processing_error" TEXT,

    CONSTRAINT "payment_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_event_account_fkey" FOREIGN KEY ("tenant_id", "payment_account_id") REFERENCES "payment_account"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "payment_event_payment_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "payment"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "payment_event_tenant_id_id_key" ON "payment_event"("tenant_id", "id");
CREATE UNIQUE INDEX "payment_event_provider_event_key" ON "payment_event"("tenant_id", "payment_account_id", "provider_event_id");
CREATE INDEX "payment_event_tenant_payment_idx" ON "payment_event"("tenant_id", "payment_id", "received_at");

-- ---------------------------------------------------------------------------------------------
-- Refunds (F28): full refunds only; one in progress or done per order.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "refund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "mode" "RefundMode" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PROCESSING',
    "provider_refund_id" TEXT,
    "manual_reference" TEXT,
    "failure_message" TEXT,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refund_order_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "refund_payment_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "payment"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "refund_requested_by_fkey" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "refund_amount_positive" CHECK ("amount_minor" > 0),
    CONSTRAINT "refund_manual_reference" CHECK ("mode" <> 'MANUAL' OR "manual_reference" IS NOT NULL)
);
CREATE UNIQUE INDEX "refund_tenant_id_id_key" ON "refund"("tenant_id", "id");
CREATE UNIQUE INDEX "refund_one_per_order" ON "refund"("tenant_id", "order_id") WHERE "status" IN ('PROCESSING', 'SUCCEEDED');

-- ---------------------------------------------------------------------------------------------
-- Receipts (F27, BR-33, BR-55): numbers allocated in the confirmation transaction, gap-free per year.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "receipt_sequence" (
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_sequence_pkey" PRIMARY KEY ("tenant_id", "year")
);

CREATE TABLE "receipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "receipt_order_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "receipt_tenant_order_key" ON "receipt"("tenant_id", "order_id");
CREATE UNIQUE INDEX "receipt_tenant_number_key" ON "receipt"("tenant_id", "number");
CREATE UNIQUE INDEX "receipt_tenant_year_seq_key" ON "receipt"("tenant_id", "year", "seq");

-- ---------------------------------------------------------------------------------------------
-- Idempotency keys (04 §7.2): same key + same body returns the stored response for 24 h.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "idempotency_key" (
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("tenant_id", "membership_id", "key"),
    CONSTRAINT "idempotency_key_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "idempotency_key_format" CHECK ("key" ~ '^[A-Za-z0-9_-]{8,128}$')
);
CREATE INDEX "idempotency_key_tenant_created_idx" ON "idempotency_key"("tenant_id", "created_at");

-- ---------------------------------------------------------------------------------------------
-- Payout methods (S-T12) and payouts (W3, recorded only).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "payout_method" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "type" "PayoutMethodType" NOT NULL,
    "details_enc" BYTEA NOT NULL,
    "display_hint" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_method_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payout_method_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "payout_method_tenant_id_id_key" ON "payout_method"("tenant_id", "id");
CREATE UNIQUE INDEX "payout_method_one_default" ON "payout_method"("tenant_id", "membership_id") WHERE "is_default";

CREATE TABLE "payout" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "instructor_membership_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method_snapshot" JSONB,
    "external_reference" TEXT NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payout_instructor_fkey" FOREIGN KEY ("tenant_id", "instructor_membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "payout_recorded_by_fkey" FOREIGN KEY ("tenant_id", "recorded_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "payout_amount_positive" CHECK ("amount_minor" > 0)
);
CREATE UNIQUE INDEX "payout_tenant_id_id_key" ON "payout"("tenant_id", "id");
CREATE INDEX "payout_tenant_instructor_idx" ON "payout"("tenant_id", "instructor_membership_id", "paid_at" DESC);

-- ---------------------------------------------------------------------------------------------
-- Earnings ledger (F29, 05 §3.7): append-only amounts; status moves forward only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "instructor_membership_id" UUID NOT NULL,
    "order_item_id" UUID,
    "refund_id" UUID,
    "type" "LedgerType" NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "provider_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "commission_minor" BIGINT NOT NULL DEFAULT 0,
    "net_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "LedgerStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "payout_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_entry_instructor_fkey" FOREIGN KEY ("tenant_id", "instructor_membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "ledger_entry_order_item_fkey" FOREIGN KEY ("tenant_id", "order_item_id") REFERENCES "order_item"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "ledger_entry_refund_fkey" FOREIGN KEY ("tenant_id", "refund_id") REFERENCES "refund"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "ledger_entry_payout_fkey" FOREIGN KEY ("tenant_id", "payout_id") REFERENCES "payout"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "ledger_entry_balanced" CHECK ("gross_minor" - "provider_fee_minor" - "commission_minor" = "net_minor"),
    CONSTRAINT "ledger_entry_sale_item" CHECK ("type" <> 'SALE' OR ("order_item_id" IS NOT NULL AND "gross_minor" > 0)),
    CONSTRAINT "ledger_entry_reversal_refund" CHECK ("type" <> 'REFUND_REVERSAL' OR ("refund_id" IS NOT NULL AND "gross_minor" < 0)),
    CONSTRAINT "ledger_entry_adjustment_note" CHECK ("type" <> 'ADJUSTMENT' OR char_length(coalesce("note", '')) >= 5),
    CONSTRAINT "ledger_entry_paid_payout" CHECK (("status" = 'PAID') = ("payout_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "ledger_entry_tenant_id_id_key" ON "ledger_entry"("tenant_id", "id");
CREATE UNIQUE INDEX "ledger_entry_one_sale" ON "ledger_entry"("tenant_id", "order_item_id") WHERE "type" = 'SALE';
CREATE UNIQUE INDEX "ledger_entry_one_reversal" ON "ledger_entry"("tenant_id", "refund_id") WHERE "type" = 'REFUND_REVERSAL';
CREATE INDEX "ledger_entry_tenant_instructor_idx" ON "ledger_entry"("tenant_id", "instructor_membership_id", "status");
CREATE INDEX "ledger_entry_tenant_payout_idx" ON "ledger_entry"("tenant_id", "payout_id");

-- F29 AC 2: amounts, type and links never change; status only moves forward; payout is set once.
CREATE FUNCTION ledger_entry_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.instructor_membership_id <> OLD.instructor_membership_id
     OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
     OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
     OR NEW.type <> OLD.type
     OR NEW.gross_minor <> OLD.gross_minor OR NEW.provider_fee_minor <> OLD.provider_fee_minor
     OR NEW.commission_minor <> OLD.commission_minor OR NEW.net_minor <> OLD.net_minor
     OR NEW.currency <> OLD.currency OR NEW.available_at <> OLD.available_at
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'ledger entries are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.payout_id IS NOT NULL AND NEW.payout_id IS DISTINCT FROM OLD.payout_id THEN
    RAISE EXCEPTION 'a paid ledger entry stays with its payout' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('AVAILABLE', 'FROZEN'))
    OR (OLD.status = 'AVAILABLE' AND NEW.status IN ('PAID', 'FROZEN'))
    OR (OLD.status = 'FROZEN' AND NEW.status = 'AVAILABLE')) THEN
    RAISE EXCEPTION 'ledger status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_entry_guard BEFORE UPDATE ON "ledger_entry" FOR EACH ROW EXECUTE FUNCTION ledger_entry_guard();

-- The daily ledger check (W6): its findings, for the owners' alert and the audit of the check itself.
CREATE TABLE "ledger_check" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "sales_expected_minor" BIGINT NOT NULL,
    "sales_recorded_minor" BIGINT NOT NULL,
    "reversals_expected_minor" BIGINT NOT NULL,
    "reversals_recorded_minor" BIGINT NOT NULL,
    "mismatches" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ledger_check_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ledger_check_tenant_checked_idx" ON "ledger_check"("tenant_id", "checked_at" DESC);

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
SELECT tenancy_apply_isolation('"payment_account"');
SELECT tenancy_apply_isolation('"order"');
SELECT tenancy_apply_isolation('"order_item"');
SELECT tenancy_apply_isolation('"payment"');
SELECT tenancy_apply_isolation('"payment_event"');
SELECT tenancy_apply_isolation('"refund"');
SELECT tenancy_apply_isolation('"receipt_sequence"');
SELECT tenancy_apply_isolation('"receipt"');
SELECT tenancy_apply_isolation('"idempotency_key"');
SELECT tenancy_apply_isolation('"payout_method"');
SELECT tenancy_apply_isolation('"payout"');
SELECT tenancy_apply_isolation('"ledger_entry"');
SELECT tenancy_apply_isolation('"ledger_check"');

GRANT SELECT, INSERT, UPDATE ON "payment_account", "order", "payment", "payment_event", "refund", "receipt_sequence" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE ON "order_item" TO studyhub_app;
GRANT SELECT, INSERT ON "receipt", "payout", "ledger_check" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_key", "payout_method" TO studyhub_app;
-- Ledger rows are never deleted by the application (F29 AC 2); updates pass ledger_entry_guard.
GRANT SELECT, INSERT, UPDATE ON "ledger_entry" TO studyhub_app;
-- Commerce settings are edited by school administrators from M8 (S-AD09 payments group).
GRANT INSERT, UPDATE ON "tenant_setting" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- Definer functions (04 §17.4: routing data only)
-- ---------------------------------------------------------------------------------------------

GRANT SELECT ON "payment_account", "order", "ledger_check" TO studyhub_rls_definer;

-- Per-account webhooks (04 §17.10): the account's school and provider, nothing else. The handler then
-- enters that school's context and verifies the signature with that account's own secret.
CREATE FUNCTION resolve_payment_account(p_id uuid)
RETURNS TABLE (tenant_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT a.tenant_id, a.provider FROM payment_account a WHERE a.id = p_id
$fn$;
REVOKE ALL ON FUNCTION resolve_payment_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_payment_account(uuid) TO studyhub_app;
ALTER FUNCTION resolve_payment_account(uuid) OWNER TO studyhub_rls_definer;

-- W6: schools with sales whose ledger was not checked in the last 24 hours (ids only).
CREATE FUNCTION due_ledger_checks(p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT t.id
      FROM tenant t
     WHERE t.status IN ('ACTIVE', 'SUSPENDED', 'OFFBOARDING')
       AND EXISTS (SELECT 1 FROM "order" o WHERE o.tenant_id = t.id AND o.status IN ('PAID', 'REFUNDED'))
       AND NOT EXISTS (SELECT 1 FROM ledger_check c
                        WHERE c.tenant_id = t.id AND c.checked_at > now() - interval '24 hours')
     ORDER BY t.id
     LIMIT least(greatest(p_limit, 1), 500)
$fn$;
REVOKE ALL ON FUNCTION due_ledger_checks(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_ledger_checks(integer) TO studyhub_app;
ALTER FUNCTION due_ledger_checks(integer) OWNER TO studyhub_rls_definer;

-- Links in emails sent by the worker (receipts, refunds, payouts): the CURRENT school's primary host
-- only (runtime code never reads tenant_domain itself). Null without a school context.
CREATE FUNCTION current_school_host()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT d.hostname FROM tenant_domain d
     WHERE d.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
       AND d.is_primary AND d.status = 'ACTIVE'
     LIMIT 1
$fn$;
REVOKE ALL ON FUNCTION current_school_host() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_school_host() TO studyhub_app;
ALTER FUNCTION current_school_host() OWNER TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- The fake payment provider's own records (DEVELOPMENT AND TESTS ONLY; the API refuses the fake adapter
-- in production). This is the simulated provider's "database": merchants and transactions, no school
-- data. It lives outside the public schema because it is not part of StudyHub's data model.
-- ---------------------------------------------------------------------------------------------
CREATE SCHEMA fake_provider;
CREATE TABLE fake_provider.merchant (
    "merchant_id" TEXT NOT NULL PRIMARY KEY,
    "webhook_secret" TEXT NOT NULL,
    "callback_account_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE fake_provider.transaction (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL REFERENCES fake_provider.merchant("merchant_id"),
    "reference" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "msisdn" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "failure_code" TEXT,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "return_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("merchant_id", "reference")
);
GRANT USAGE ON SCHEMA fake_provider TO studyhub_app;
GRANT SELECT, INSERT, UPDATE ON fake_provider.merchant, fake_provider.transaction TO studyhub_app;
