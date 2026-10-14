-- 0005_catalogue_authoring (M5): categories and subjects, instructor profiles and applications, courses,
-- outline (sections, lessons, attachments), moderation history, media assets and per-school storage
-- usage. Blueprint 03 F06–F13, 05 §3.2–3.3 and §8.2, 04 §17.9. docs/design/m5-catalogue-authoring.md.
-- Every table is school-owned (tenant_isolation); natural keys (slugs) are unique PER SCHOOL (BR-59).

-- Trigram search (typo tolerance, F13 AC 2). A trusted extension the database owner (migrator) may create.
-- It lives in its own schema: functions created here are closed by default (0002), so the runtime role
-- gets EXECUTE on this schema's functions only, never on the definer inventory in public.
CREATE SCHEMA IF NOT EXISTS ext;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA ext;
GRANT USAGE ON SCHEMA ext TO studyhub_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ext TO studyhub_app;

CREATE TYPE "InstructorStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');
CREATE TYPE "CourseLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS');
CREATE TYPE "LessonType" AS ENUM ('TEXT', 'VIDEO', 'FILE', 'QUIZ');
CREATE TYPE "SubmissionDecision" AS ENUM ('APPROVED', 'CHANGES_REQUESTED');
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'DOCUMENT', 'VIDEO');
CREATE TYPE "AssetPurpose" AS ENUM ('COURSE_COVER', 'AVATAR', 'LESSON_FILE', 'LESSON_IMAGE', 'LESSON_VIDEO');
CREATE TYPE "AssetStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'PROCESSING', 'READY', 'REJECTED');

-- ---------------------------------------------------------------------------------------------
-- Categories and subjects (F08): two levels, archived instead of deleted while referenced.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "category" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "category_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "category_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 80),
    CONSTRAINT "category_name_length" CHECK (char_length("name") BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX "category_tenant_slug_key" ON "category"("tenant_id", "slug");
CREATE UNIQUE INDEX "category_tenant_id_id_key" ON "category"("tenant_id", "id");

CREATE TABLE "subject" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subject_category_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "category"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "subject_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 80),
    CONSTRAINT "subject_name_length" CHECK (char_length("name") BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX "subject_tenant_slug_key" ON "subject"("tenant_id", "slug");
CREATE UNIQUE INDEX "subject_tenant_id_id_key" ON "subject"("tenant_id", "id");
CREATE INDEX "subject_tenant_category_idx" ON "subject"("tenant_id", "category_id", "position");

-- ---------------------------------------------------------------------------------------------
-- Assets (F11): an upload slot is an asset in PENDING_UPLOAD. Object keys live under t/{tenant_id}/.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "asset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "owner_membership_id" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "purpose" "AssetPurpose" NOT NULL,
    "storage_key" TEXT,
    "derivative_key" TEXT,
    "provider" TEXT,
    "provider_video_id" TEXT,
    "original_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "reject_reason" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_seconds" INTEGER,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_owner_fkey" FOREIGN KEY ("tenant_id", "owner_membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    -- 04 §17.9: every object of a school lives under its own prefix.
    CONSTRAINT "asset_storage_key_prefix" CHECK ("storage_key" IS NULL OR "storage_key" LIKE 't/' || "tenant_id"::text || '/%'),
    CONSTRAINT "asset_derivative_key_prefix" CHECK ("derivative_key" IS NULL OR "derivative_key" LIKE 't/' || "tenant_id"::text || '/%'),
    CONSTRAINT "asset_size_positive" CHECK ("size_bytes" > 0),
    CONSTRAINT "asset_video_has_provider" CHECK ("kind" <> 'VIDEO' OR "provider" IS NOT NULL),
    CONSTRAINT "asset_ready_is_stored" CHECK ("status" <> 'READY' OR "storage_key" IS NOT NULL OR "provider_video_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "asset_tenant_id_id_key" ON "asset"("tenant_id", "id");
CREATE INDEX "asset_tenant_owner_status_idx" ON "asset"("tenant_id", "owner_membership_id", "status");
CREATE INDEX "asset_tenant_status_created_idx" ON "asset"("tenant_id", "status", "created_at");
-- Video webhooks route by provider id across schools (resolve_video_asset); documented index exception.
CREATE UNIQUE INDEX "asset_provider_video_key" ON "asset"("provider", "provider_video_id") WHERE "provider_video_id" IS NOT NULL;

-- Per-school storage usage (BR-49): READY bytes plus bytes reserved by open upload slots. One row per
-- school, locked (SELECT … FOR UPDATE) when a slot is created so concurrent uploads can't overshoot.
CREATE TABLE "tenant_usage" (
    "tenant_id" UUID NOT NULL,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "reserved_bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_usage_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "tenant_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_usage_nonnegative" CHECK ("storage_bytes" >= 0 AND "reserved_bytes" >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Instructor profiles and applications (F06, F07, BR-56). One per membership; the public slug is
-- unique per school. INVITE_ONLY schools create it APPROVED on first use of Studio.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "instructor_profile" (
    "membership_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "headline" TEXT,
    "bio" TEXT,
    "subjects" TEXT[] NOT NULL DEFAULT '{}',
    "qualifications" TEXT,
    "avatar_asset_id" UUID,
    "status" "InstructorStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "reapply_after" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "instructor_profile_pkey" PRIMARY KEY ("membership_id"),
    CONSTRAINT "instructor_profile_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "instructor_profile_avatar_fkey" FOREIGN KEY ("tenant_id", "avatar_asset_id") REFERENCES "asset"("tenant_id", "id") ON DELETE SET NULL ("avatar_asset_id"),
    CONSTRAINT "instructor_profile_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 80),
    CONSTRAINT "instructor_profile_headline_length" CHECK ("headline" IS NULL OR char_length("headline") <= 120),
    CONSTRAINT "instructor_profile_bio_length" CHECK ("bio" IS NULL OR char_length("bio") <= 4000),
    CONSTRAINT "instructor_profile_subjects_count" CHECK (cardinality("subjects") <= 10)
);
CREATE UNIQUE INDEX "instructor_profile_tenant_slug_key" ON "instructor_profile"("tenant_id", "slug");
CREATE UNIQUE INDEX "instructor_profile_tenant_membership_key" ON "instructor_profile"("tenant_id", "membership_id");
CREATE INDEX "instructor_profile_tenant_status_idx" ON "instructor_profile"("tenant_id", "status", "submitted_at");

-- ---------------------------------------------------------------------------------------------
-- Courses (F09, F12, F13)
-- ---------------------------------------------------------------------------------------------
-- Tags as one string for the search vector (array_to_string itself is only STABLE).
CREATE FUNCTION course_tags_text(p_tags text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$ SELECT coalesce(array_to_string(p_tags, ' '), '') $fn$;
REVOKE ALL ON FUNCTION course_tags_text(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION course_tags_text(text[]) TO studyhub_app;

CREATE TABLE "course" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "owner_membership_id" UUID NOT NULL,
    "subject_id" UUID,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description_json" JSONB,
    "description_text" TEXT NOT NULL DEFAULT '',
    "outcomes" TEXT[] NOT NULL DEFAULT '{}',
    "requirements" TEXT[] NOT NULL DEFAULT '{}',
    "level" "CourseLevel" NOT NULL DEFAULT 'ALL_LEVELS',
    "language" TEXT NOT NULL DEFAULT 'en',
    "tags" TEXT[] NOT NULL DEFAULT '{}',
    "cover_asset_id" UUID,
    "price_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'ZMW',
    "access_days" INTEGER,
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "first_published_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "enrollment_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    -- Search (F13): weighted title (A), subtitle and tags (B), description (C).
    "search_vector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, coalesce("title", '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce("subtitle", '')), 'B') ||
        setweight(to_tsvector('simple'::regconfig, course_tags_text("tags")), 'B') ||
        setweight(to_tsvector('simple'::regconfig, coalesce("description_text", '')), 'C')
    ) STORED,

    CONSTRAINT "course_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "course_owner_fkey" FOREIGN KEY ("tenant_id", "owner_membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "course_subject_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subject"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "course_cover_fkey" FOREIGN KEY ("tenant_id", "cover_asset_id") REFERENCES "asset"("tenant_id", "id") ON DELETE SET NULL ("cover_asset_id"),
    CONSTRAINT "course_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 100),
    CONSTRAINT "course_title_length" CHECK (char_length("title") BETWEEN 5 AND 120),
    CONSTRAINT "course_subtitle_length" CHECK ("subtitle" IS NULL OR char_length("subtitle") <= 200),
    CONSTRAINT "course_outcomes_count" CHECK (cardinality("outcomes") <= 12),
    CONSTRAINT "course_requirements_count" CHECK (cardinality("requirements") <= 12),
    CONSTRAINT "course_tags_count" CHECK (cardinality("tags") <= 5),
    CONSTRAINT "course_price_nonnegative" CHECK ("price_minor" >= 0),
    CONSTRAINT "course_access_days_positive" CHECK ("access_days" IS NULL OR "access_days" > 0)
);
CREATE UNIQUE INDEX "course_tenant_slug_key" ON "course"("tenant_id", "slug");
CREATE UNIQUE INDEX "course_tenant_id_id_key" ON "course"("tenant_id", "id");
CREATE INDEX "course_tenant_owner_status_idx" ON "course"("tenant_id", "owner_membership_id", "status");
CREATE INDEX "course_tenant_catalogue_idx" ON "course"("tenant_id", "status", "subject_id", "published_at" DESC);
-- GIN indexes can't lead with tenant_id (documented exceptions); queries always filter by tenant (RLS).
CREATE INDEX "course_search_idx" ON "course" USING GIN ("search_vector");
CREATE INDEX "course_title_trgm_idx" ON "course" USING GIN ("title" ext.gin_trgm_ops);

CREATE TABLE "course_submission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checklist_snapshot" JSONB NOT NULL,
    "decision" "SubmissionDecision",
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "notes" TEXT,

    CONSTRAINT "course_submission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "course_submission_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE
);
CREATE INDEX "course_submission_tenant_course_idx" ON "course_submission"("tenant_id", "course_id", "submitted_at" DESC);
CREATE INDEX "course_submission_tenant_open_idx" ON "course_submission"("tenant_id", "submitted_at") WHERE "decision" IS NULL;

CREATE TABLE "section" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "section_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "section_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "section_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "section_position_nonnegative" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX "section_tenant_id_id_key" ON "section"("tenant_id", "id");
-- Reordering moves several rows in one statement or transaction: checked at commit.
ALTER TABLE "section" ADD CONSTRAINT "section_course_position_key"
    UNIQUE ("tenant_id", "course_id", "position") DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "lesson" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "type" "LessonType" NOT NULL,
    "position" INTEGER NOT NULL,
    "content_json" JSONB,
    "video_asset_id" UUID,
    -- Quizzes arrive in M7; the foreign key is added with the quiz table.
    "quiz_id" UUID,
    "is_preview" BOOLEAN NOT NULL DEFAULT false,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "downloadable" BOOLEAN NOT NULL DEFAULT false,
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "lesson_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lesson_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "lesson_section_fkey" FOREIGN KEY ("tenant_id", "section_id") REFERENCES "section"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "lesson_video_fkey" FOREIGN KEY ("tenant_id", "video_asset_id") REFERENCES "asset"("tenant_id", "id") ON DELETE SET NULL ("video_asset_id"),
    CONSTRAINT "lesson_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "lesson_position_nonnegative" CHECK ("position" >= 0),
    CONSTRAINT "lesson_duration_nonnegative" CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0)
);
CREATE UNIQUE INDEX "lesson_tenant_id_id_key" ON "lesson"("tenant_id", "id");
CREATE INDEX "lesson_tenant_course_idx" ON "lesson"("tenant_id", "course_id");
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_section_position_key"
    UNIQUE ("tenant_id", "section_id", "position") DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "lesson_attachment" (
    "tenant_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lesson_attachment_pkey" PRIMARY KEY ("tenant_id", "lesson_id", "asset_id"),
    CONSTRAINT "lesson_attachment_lesson_fkey" FOREIGN KEY ("tenant_id", "lesson_id") REFERENCES "lesson"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "lesson_attachment_asset_fkey" FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "asset"("tenant_id", "id") ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
SELECT tenancy_apply_isolation('"category"');
SELECT tenancy_apply_isolation('"subject"');
SELECT tenancy_apply_isolation('"asset"');
SELECT tenancy_apply_isolation('"tenant_usage"');
SELECT tenancy_apply_isolation('"instructor_profile"');
SELECT tenancy_apply_isolation('"course"');
SELECT tenancy_apply_isolation('"course_submission"');
SELECT tenancy_apply_isolation('"section"');
SELECT tenancy_apply_isolation('"lesson"');
SELECT tenancy_apply_isolation('"lesson_attachment"');

GRANT SELECT, INSERT, UPDATE ON "category", "subject" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "asset" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE ON "tenant_usage" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE ON "instructor_profile" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "course" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE ON "course_submission" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "section", "lesson", "lesson_attachment" TO studyhub_app;
GRANT SELECT, UPDATE ON "asset" TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER: video webhooks (04 §17.9). The provider calls a shared endpoint with its own id;
-- this returns ONLY the routing data (asset id, school) so the API can continue inside that school's
-- context. An unknown id returns nothing and no school data is touched (M5 AC 5).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION resolve_video_asset(p_provider text, p_provider_video_id text)
RETURNS TABLE (asset_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT a.id, a.tenant_id
      FROM asset a
     WHERE a.provider = p_provider
       AND a.provider_video_id = p_provider_video_id
       AND a.kind = 'VIDEO'
$fn$;
REVOKE ALL ON FUNCTION resolve_video_asset(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_video_asset(text, text) TO studyhub_app;
ALTER FUNCTION resolve_video_asset(text, text) OWNER TO studyhub_rls_definer;
