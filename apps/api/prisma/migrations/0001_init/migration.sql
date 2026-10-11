-- 0001_init: the first migration proves the pipeline end to end.
-- Runs as studyhub_migrator (owner). The app role gets data access only, never DDL.

CREATE TABLE "platform_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_setting_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "platform_setting_key_format" CHECK ("key" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$')
);

COMMENT ON TABLE "platform_setting" IS 'Global platform settings (no tenant data). Blueprint 05 §8.1.';

-- Explicit grants (default privileges in infra/postgres/init/01-roles.sql cover future tables too).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform_setting" TO studyhub_app;
