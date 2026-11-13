-- Terms and semesters belong to individual topics (lessons), not to whole courses.
-- Preserve each existing course assignment by copying it onto all of its lessons.
ALTER TABLE "lesson"
    ADD COLUMN "period_id" UUID;

UPDATE "lesson" AS l
   SET "period_id" = c."period_id"
  FROM "course" AS c
 WHERE c."tenant_id" = l."tenant_id"
   AND c."id" = l."course_id"
   AND c."period_id" IS NOT NULL;

ALTER TABLE "lesson"
    ADD CONSTRAINT "lesson_period_fkey" FOREIGN KEY ("tenant_id", "period_id")
        REFERENCES "academic_period"("tenant_id", "id") ON DELETE RESTRICT;
CREATE INDEX "lesson_tenant_period_idx" ON "lesson"("tenant_id", "period_id");

DROP INDEX "course_tenant_period_idx";
ALTER TABLE "course"
    DROP CONSTRAINT "course_period_fkey",
    DROP COLUMN "period_id",
    DROP COLUMN "access_override";
DROP TYPE "CourseAccessOverride";

GRANT SELECT, INSERT, UPDATE ON "lesson" TO studyhub_app;
