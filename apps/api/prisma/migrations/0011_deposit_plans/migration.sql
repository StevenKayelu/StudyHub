-- Deposit payment plans (docs/design/payment-plans.md): a course may be bought in two parts. The
-- deposit opens a share of the lessons; the balance, paid later, opens the rest.

CREATE TYPE "OrderItemPart" AS ENUM ('FULL', 'DEPOSIT', 'BALANCE');

-- The tutor's plan on the course: all three set, or none.
ALTER TABLE "course"
    ADD COLUMN "deposit_minor" BIGINT,
    ADD COLUMN "deposit_lesson_pct" SMALLINT,
    ADD COLUMN "balance_due_days" INTEGER,
    ADD CONSTRAINT "course_deposit_plan_complete" CHECK (
        ("deposit_minor" IS NULL AND "deposit_lesson_pct" IS NULL AND "balance_due_days" IS NULL)
        OR ("deposit_minor" IS NOT NULL AND "deposit_lesson_pct" IS NOT NULL AND "balance_due_days" IS NOT NULL)
    ),
    ADD CONSTRAINT "course_deposit_plan_range" CHECK (
        "deposit_minor" IS NULL OR (
            "deposit_minor" > 0 AND "deposit_minor" < "price_minor"
            AND "deposit_lesson_pct" BETWEEN 1 AND 99
            AND "balance_due_days" BETWEEN 1 AND 3650
        )
    );

-- Which part of the price an order item charges. Existing items are full purchases. A deposit item
-- snapshots the plan the learner was shown at checkout; the enrolment copies it when the deposit is paid.
ALTER TABLE "order_item"
    ADD COLUMN "part" "OrderItemPart" NOT NULL DEFAULT 'FULL',
    ADD COLUMN "plan_lesson_pct" SMALLINT,
    ADD COLUMN "plan_balance_minor" BIGINT,
    ADD COLUMN "plan_balance_due_days" INTEGER,
    ADD CONSTRAINT "order_item_deposit_plan" CHECK (
        ("part" = 'DEPOSIT' AND "plan_lesson_pct" BETWEEN 1 AND 99 AND "plan_balance_minor" > 0
            AND "plan_balance_due_days" BETWEEN 1 AND 3650)
        OR ("part" <> 'DEPOSIT' AND "plan_lesson_pct" IS NULL AND "plan_balance_minor" IS NULL
            AND "plan_balance_due_days" IS NULL)
    );

-- What the learner agreed when paying the deposit (snapshots), and the balance once paid.
ALTER TABLE "enrollment"
    ADD COLUMN "access_limit_pct" SMALLINT,
    ADD COLUMN "plan_lesson_pct" SMALLINT,
    ADD COLUMN "balance_minor" BIGINT,
    ADD COLUMN "balance_due_at" TIMESTAMPTZ(3),
    ADD COLUMN "balance_order_item_id" UUID,
    ADD CONSTRAINT "enrollment_balance_order_item_fkey" FOREIGN KEY ("tenant_id", "balance_order_item_id")
        REFERENCES "order_item"("tenant_id", "id") ON DELETE RESTRICT,
    ADD CONSTRAINT "enrollment_deposit_plan_complete" CHECK (
        ("plan_lesson_pct" IS NULL AND "balance_minor" IS NULL AND "balance_due_at" IS NULL
            AND "access_limit_pct" IS NULL AND "balance_order_item_id" IS NULL)
        OR ("plan_lesson_pct" BETWEEN 1 AND 99 AND "balance_minor" > 0 AND "balance_due_at" IS NOT NULL)
    ),
    -- Limited exactly while the balance is unpaid.
    ADD CONSTRAINT "enrollment_access_limit_matches_balance" CHECK (
        "plan_lesson_pct" IS NULL
        OR ("balance_order_item_id" IS NULL AND "access_limit_pct" = "plan_lesson_pct")
        OR ("balance_order_item_id" IS NOT NULL AND "access_limit_pct" IS NULL)
    );

-- Balance reminders look up unpaid plans by due date.
CREATE INDEX "enrollment_tenant_balance_due_idx" ON "enrollment"("tenant_id", "balance_due_at")
    WHERE "balance_due_at" IS NOT NULL AND "balance_order_item_id" IS NULL;
