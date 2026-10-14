-- 0006_learning (M6): enrolments (entitlements) and lesson progress. Blueprint 03 F14–F16, 05 §3.4,
-- BR-07, BR-12, BR-22. docs/design/m6-learning-experience.md.
-- Both tables are school-owned (tenant_isolation). An enrolment belongs to a MEMBERSHIP of the school
-- (composite FK), so an entitlement can never point into another school.

CREATE TYPE "EnrollmentSource" AS ENUM ('FREE', 'PURCHASE', 'ADMIN_GRANT');
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');
CREATE TYPE "LessonProgressStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

CREATE TABLE "enrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "source" "EnrollmentSource" NOT NULL,
    -- Orders arrive in M8; the foreign key is added with the order_item table.
    "order_item_id" UUID,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    "granted_by" UUID,
    "grant_reason" TEXT,
    "progress_percent" SMALLINT NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(3),
    "last_lesson_id" UUID,
    "last_accessed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "enrollment_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    -- A course with enrolments can't be deleted (05 §3.3: hard delete only without enrolments).
    CONSTRAINT "enrollment_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "enrollment_last_lesson_fkey" FOREIGN KEY ("tenant_id", "last_lesson_id") REFERENCES "lesson"("tenant_id", "id") ON DELETE SET NULL ("last_lesson_id"),
    CONSTRAINT "enrollment_granted_by_fkey" FOREIGN KEY ("tenant_id", "granted_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE SET NULL ("granted_by"),
    CONSTRAINT "enrollment_purchase_has_order" CHECK ("source" <> 'PURCHASE' OR "order_item_id" IS NOT NULL),
    CONSTRAINT "enrollment_grant_has_reason" CHECK ("source" <> 'ADMIN_GRANT' OR ("granted_by" IS NOT NULL AND "grant_reason" IS NOT NULL)),
    CONSTRAINT "enrollment_revoked_fields" CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL)),
    CONSTRAINT "enrollment_progress_range" CHECK ("progress_percent" BETWEEN 0 AND 100),
    CONSTRAINT "enrollment_reason_length" CHECK (char_length(coalesce("revoke_reason", '')) <= 2000 AND char_length(coalesce("grant_reason", '')) <= 2000)
);
CREATE UNIQUE INDEX "enrollment_tenant_id_id_key" ON "enrollment"("tenant_id", "id");
-- F14 AC 1 / BR-07: at most one ACTIVE enrolment per person and course.
CREATE UNIQUE INDEX "enrollment_one_active_key" ON "enrollment"("tenant_id", "membership_id", "course_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "enrollment_tenant_course_status_idx" ON "enrollment"("tenant_id", "course_id", "status");
CREATE INDEX "enrollment_tenant_member_recent_idx" ON "enrollment"("tenant_id", "membership_id", "last_accessed_at" DESC NULLS LAST);

CREATE TABLE "lesson_progress" (
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "status" "LessonProgressStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "position_seconds" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("tenant_id", "enrollment_id", "lesson_id"),
    CONSTRAINT "lesson_progress_enrollment_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "enrollment"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "lesson_progress_lesson_fkey" FOREIGN KEY ("tenant_id", "lesson_id") REFERENCES "lesson"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "lesson_progress_position_range" CHECK ("position_seconds" BETWEEN 0 AND 86400),
    CONSTRAINT "lesson_progress_completed_fields" CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL))
);
CREATE INDEX "lesson_progress_tenant_lesson_idx" ON "lesson_progress"("tenant_id", "lesson_id");

-- ---------------------------------------------------------------------------------------------
-- RLS and grants: the runtime role inserts and updates, never deletes (history is kept).
-- ---------------------------------------------------------------------------------------------
SELECT tenancy_apply_isolation('"enrollment"');
SELECT tenancy_apply_isolation('"lesson_progress"');

GRANT SELECT, INSERT, UPDATE ON "enrollment", "lesson_progress" TO studyhub_app;
