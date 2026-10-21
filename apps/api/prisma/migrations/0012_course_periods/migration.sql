-- Course periods (docs/design/course-periods.md): a school arranges courses into terms, semesters or
-- seminars, each opening on its start date or when an administrator opens it. A course without a
-- period is open. An administrator can also open or lock a single course.

CREATE TYPE "PeriodKind" AS ENUM ('TERM', 'SEMESTER', 'SEMINAR');
CREATE TYPE "PeriodMode" AS ENUM ('AUTO', 'OPEN', 'LOCKED');
CREATE TYPE "CourseAccessOverride" AS ENUM ('OPEN', 'LOCKED');

CREATE TABLE "academic_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PeriodKind" NOT NULL DEFAULT 'TERM',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "mode" "PeriodMode" NOT NULL DEFAULT 'AUTO',
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "academic_period_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "academic_period_name_length" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "academic_period_dates" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);
CREATE UNIQUE INDEX "academic_period_tenant_id_id_key" ON "academic_period"("tenant_id", "id");
CREATE INDEX "academic_period_tenant_starts_idx" ON "academic_period"("tenant_id", "starts_at");

ALTER TABLE "course"
    ADD COLUMN "period_id" UUID,
    ADD COLUMN "access_override" "CourseAccessOverride",
    ADD CONSTRAINT "course_period_fkey" FOREIGN KEY ("tenant_id", "period_id")
        REFERENCES "academic_period"("tenant_id", "id") ON DELETE RESTRICT;
CREATE INDEX "course_tenant_period_idx" ON "course"("tenant_id", "period_id");

SELECT tenancy_apply_isolation('"academic_period"');
GRANT SELECT, INSERT, UPDATE ON "academic_period" TO studyhub_app;
-- purge_tenant() (0009) deletes every school-owned table as studyhub_rls_definer.
GRANT SELECT, DELETE ON "academic_period" TO studyhub_rls_definer;
