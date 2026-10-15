-- 0007_assessment (M7): question bank, quizzes, attempts (assessed and practice) and per-school feature
-- switches. Blueprint 03 F17–F23, F40; 05 §3.5, §8.2 (tenant_feature); BR-16 to BR-23, BR-48.
-- docs/design/m7-assessment-engine.md. Every table is school-owned (tenant_isolation); question banks
-- and attempts never cross schools.

CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER', 'NUMERIC', 'LONG_ANSWER');
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');
CREATE TYPE "QuestionStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "QuizSelectionMode" AS ENUM ('FIXED', 'DRAW');
CREATE TYPE "FeedbackPolicy" AS ENUM ('IMMEDIATE', 'AFTER_CLOSE', 'NEVER');
CREATE TYPE "QuizStatus" AS ENUM ('DRAFT', 'READY');
CREATE TYPE "AttemptMode" AS ENUM ('ASSESSED', 'PRACTICE');
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'NEEDS_REVIEW', 'GRADED', 'ABANDONED');
CREATE TYPE "SubmitKind" AS ENUM ('MANUAL', 'AUTO');
CREATE TYPE "FeatureOverride" AS ENUM ('NONE', 'GRANT', 'REVOKE');

-- ---------------------------------------------------------------------------------------------
-- Question bank (F17): per course. Questions are archived, never deleted (attempts keep snapshots).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "question" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "type" "QuestionType" NOT NULL,
    "stem_json" JSONB NOT NULL,
    "stem_text" TEXT NOT NULL DEFAULT '',
    "explanation_json" JSONB,
    "points" NUMERIC(6,2) NOT NULL DEFAULT 1,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "tags" TEXT[] NOT NULL DEFAULT '{}',
    "practice_eligible" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" "QuestionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "question_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "question_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "question_author_fkey" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "question_points_positive" CHECK ("points" > 0 AND "points" <= 1000),
    -- F22 AC 3: long answers need a person to mark them, so they are never practice questions.
    CONSTRAINT "question_long_answer_not_practice" CHECK ("type" <> 'LONG_ANSWER' OR NOT "practice_eligible"),
    CONSTRAINT "question_tags_count" CHECK (cardinality("tags") <= 10)
);
CREATE UNIQUE INDEX "question_tenant_id_id_key" ON "question"("tenant_id", "id");
CREATE INDEX "question_tenant_course_idx" ON "question"("tenant_id", "course_id", "status", "type");
-- Tag filters run inside one course's bank (the index above); a GIN index on tags could not lead with
-- tenant_id (T-ISO-03), so there is none.

CREATE TABLE "question_option" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "content_json" JSONB NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "feedback_json" JSONB,

    CONSTRAINT "question_option_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "question_option_question_fkey" FOREIGN KEY ("tenant_id", "question_id") REFERENCES "question"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "question_option_position_range" CHECK ("position" BETWEEN 0 AND 9)
);
CREATE UNIQUE INDEX "question_option_tenant_id_id_key" ON "question_option"("tenant_id", "id");
ALTER TABLE "question_option" ADD CONSTRAINT "question_option_position_key"
    UNIQUE ("tenant_id", "question_id", "position") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------------------------
-- Quizzes (F18)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "quiz" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "instructions_json" JSONB,
    "selection_mode" "QuizSelectionMode" NOT NULL DEFAULT 'FIXED',
    "time_limit_seconds" INTEGER,
    "attempts_allowed" INTEGER,
    "pass_mark_percent" INTEGER,
    "shuffle_questions" BOOLEAN NOT NULL DEFAULT false,
    "shuffle_options" BOOLEAN NOT NULL DEFAULT false,
    "opens_at" TIMESTAMPTZ(3),
    "closes_at" TIMESTAMPTZ(3),
    "feedback_policy" "FeedbackPolicy" NOT NULL DEFAULT 'IMMEDIATE',
    "show_correct_answers" BOOLEAN NOT NULL DEFAULT true,
    "status" "QuizStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quiz_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quiz_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "quiz_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "quiz_time_limit_range" CHECK ("time_limit_seconds" IS NULL OR "time_limit_seconds" BETWEEN 60 AND 36000),
    CONSTRAINT "quiz_attempts_allowed_positive" CHECK ("attempts_allowed" IS NULL OR "attempts_allowed" >= 1),
    CONSTRAINT "quiz_pass_mark_range" CHECK ("pass_mark_percent" IS NULL OR "pass_mark_percent" BETWEEN 0 AND 100),
    CONSTRAINT "quiz_window_order" CHECK ("opens_at" IS NULL OR "closes_at" IS NULL OR "opens_at" < "closes_at")
);
CREATE UNIQUE INDEX "quiz_tenant_id_id_key" ON "quiz"("tenant_id", "id");
CREATE INDEX "quiz_tenant_course_idx" ON "quiz"("tenant_id", "course_id");

CREATE TABLE "quiz_item" (
    "tenant_id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "points_override" NUMERIC(6,2),

    CONSTRAINT "quiz_item_pkey" PRIMARY KEY ("tenant_id", "quiz_id", "question_id"),
    CONSTRAINT "quiz_item_quiz_fkey" FOREIGN KEY ("tenant_id", "quiz_id") REFERENCES "quiz"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "quiz_item_question_fkey" FOREIGN KEY ("tenant_id", "question_id") REFERENCES "question"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "quiz_item_points_positive" CHECK ("points_override" IS NULL OR ("points_override" > 0 AND "points_override" <= 1000))
);
ALTER TABLE "quiz_item" ADD CONSTRAINT "quiz_item_position_key"
    UNIQUE ("tenant_id", "quiz_id", "position") DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "quiz_draw_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT '{}',
    "difficulty" "Difficulty",
    "types" "QuestionType"[] NOT NULL DEFAULT '{}',

    CONSTRAINT "quiz_draw_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quiz_draw_rule_quiz_fkey" FOREIGN KEY ("tenant_id", "quiz_id") REFERENCES "quiz"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "quiz_draw_rule_count_range" CHECK ("count" BETWEEN 1 AND 200)
);

-- Quiz lessons (M5 left lesson.quiz_id without a key until quizzes existed).
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_quiz_fkey"
    FOREIGN KEY ("tenant_id", "quiz_id") REFERENCES "quiz"("tenant_id", "id") ON DELETE SET NULL ("quiz_id");

-- ---------------------------------------------------------------------------------------------
-- Attempts (F19–F22)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "quiz_id" UUID,
    "mode" "AttemptMode" NOT NULL,
    "attempt_number" INTEGER,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "submit_kind" "SubmitKind",
    "score" NUMERIC(8,2) NOT NULL DEFAULT 0,
    "max_score" NUMERIC(8,2) NOT NULL DEFAULT 0,
    "percent" NUMERIC(5,2),
    "passed" BOOLEAN,
    "settings_snapshot" JSONB NOT NULL DEFAULT '{}',
    "graded_at" TIMESTAMPTZ(3),
    "graded_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attempt_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "attempt_course_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "attempt_quiz_fkey" FOREIGN KEY ("tenant_id", "quiz_id") REFERENCES "quiz"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "attempt_graded_by_fkey" FOREIGN KEY ("tenant_id", "graded_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE SET NULL ("graded_by"),
    -- Assessed attempts belong to a quiz and are numbered; practice has neither (05 §3.5).
    CONSTRAINT "attempt_mode_fields" CHECK (("mode" = 'ASSESSED') = ("quiz_id" IS NOT NULL AND "attempt_number" IS NOT NULL)),
    CONSTRAINT "attempt_abandoned_is_practice" CHECK ("status" <> 'ABANDONED' OR "mode" = 'PRACTICE'),
    CONSTRAINT "attempt_scores_nonnegative" CHECK ("score" >= 0 AND "max_score" >= 0)
);
CREATE UNIQUE INDEX "attempt_tenant_id_id_key" ON "attempt"("tenant_id", "id");
CREATE UNIQUE INDEX "attempt_number_key" ON "attempt"("tenant_id", "membership_id", "quiz_id", "attempt_number");
-- BR-16: at most one assessed attempt in progress per learner and quiz (F19 AC 5).
CREATE UNIQUE INDEX "attempt_one_in_progress_key" ON "attempt"("tenant_id", "membership_id", "quiz_id")
    WHERE "status" = 'IN_PROGRESS' AND "mode" = 'ASSESSED';
CREATE INDEX "attempt_tenant_quiz_status_idx" ON "attempt"("tenant_id", "quiz_id", "status");
CREATE INDEX "attempt_tenant_member_idx" ON "attempt"("tenant_id", "membership_id", "course_id", "started_at" DESC);

CREATE TABLE "attempt_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    -- Reference only: the snapshot is what the attempt is graded against (BR-19).
    "question_id" UUID NOT NULL,
    "question_snapshot" JSONB NOT NULL,
    "points" NUMERIC(6,2) NOT NULL,

    CONSTRAINT "attempt_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attempt_item_attempt_fkey" FOREIGN KEY ("tenant_id", "attempt_id") REFERENCES "attempt"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "attempt_item_question_fkey" FOREIGN KEY ("tenant_id", "question_id") REFERENCES "question"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "attempt_item_points_positive" CHECK ("points" > 0)
);
CREATE UNIQUE INDEX "attempt_item_tenant_id_id_key" ON "attempt_item"("tenant_id", "id");
CREATE UNIQUE INDEX "attempt_item_position_key" ON "attempt_item"("tenant_id", "attempt_id", "position");
CREATE INDEX "attempt_item_question_idx" ON "attempt_item"("tenant_id", "question_id");

CREATE TABLE "attempt_answer" (
    "tenant_id" UUID NOT NULL,
    "attempt_item_id" UUID NOT NULL,
    "response" JSONB NOT NULL,
    "client_seq" INTEGER NOT NULL DEFAULT 0,
    "saved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_correct" BOOLEAN,
    "awarded_points" NUMERIC(6,2),
    "grader_comment" TEXT,
    "graded_by" UUID,
    "graded_at" TIMESTAMPTZ(3),

    CONSTRAINT "attempt_answer_pkey" PRIMARY KEY ("tenant_id", "attempt_item_id"),
    CONSTRAINT "attempt_answer_item_fkey" FOREIGN KEY ("tenant_id", "attempt_item_id") REFERENCES "attempt_item"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "attempt_answer_graded_by_fkey" FOREIGN KEY ("tenant_id", "graded_by") REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE SET NULL ("graded_by"),
    CONSTRAINT "attempt_answer_points_nonnegative" CHECK ("awarded_points" IS NULL OR "awarded_points" >= 0),
    CONSTRAINT "attempt_answer_comment_length" CHECK (char_length(coalesce("grader_comment", '')) <= 4000)
);

-- ---------------------------------------------------------------------------------------------
-- Feature switches (F40, BR-48): the school's own switch and the platform's override. Plans arrive
-- with M9; until then every feature counts as granted by the plan.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_feature" (
    "tenant_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled_by_tenant" BOOLEAN NOT NULL DEFAULT true,
    "platform_override" "FeatureOverride" NOT NULL DEFAULT 'NONE',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_feature_pkey" PRIMARY KEY ("tenant_id", "feature_key"),
    CONSTRAINT "tenant_feature_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_feature_key_known" CHECK ("feature_key" IN ('paidCourses', 'practiceMode', 'quizAnalytics',
        'instructorApplications', 'instructorRevenueShare', 'publicCatalog', 'whiteLabel', 'customDomain',
        'dataExport', 'certificates'))
);

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
SELECT tenancy_apply_isolation('"question"');
SELECT tenancy_apply_isolation('"question_option"');
SELECT tenancy_apply_isolation('"quiz"');
SELECT tenancy_apply_isolation('"quiz_item"');
SELECT tenancy_apply_isolation('"quiz_draw_rule"');
SELECT tenancy_apply_isolation('"attempt"');
SELECT tenancy_apply_isolation('"attempt_item"');
SELECT tenancy_apply_isolation('"attempt_answer"');
SELECT tenancy_apply_isolation('"tenant_feature"');

GRANT SELECT, INSERT, UPDATE ON "question" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "question_option", "quiz", "quiz_item", "quiz_draw_rule" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE ON "attempt", "attempt_item", "attempt_answer" TO studyhub_app;
-- Read-only for the runtime role until the settings screens (M9); the console and seed write it.
GRANT SELECT ON "tenant_feature" TO studyhub_app;
