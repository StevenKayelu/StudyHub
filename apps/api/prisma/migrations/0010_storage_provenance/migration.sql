-- Storage provenance: each object keeps the immutable deployment location where it was written.
-- This migration intentionally creates no location rows and captures no deployment credentials.
-- Existing keys remain unresolved until an operator runs storage:bootstrap --capture-existing
-- with the original deployment storage settings. Runtime access must fail closed until then.

CREATE TABLE "platform_storage_location" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "credentials_enc" BYTEA NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_storage_location_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_storage_location_provider" CHECK ("provider" IN ('S3', 'R2')),
    CONSTRAINT "platform_storage_location_credentials" CHECK (octet_length("credentials_enc") >= 29),
    CONSTRAINT "platform_storage_location_fingerprint" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "platform_storage_location_config" CHECK (
        jsonb_typeof("config") = 'object'
        AND "config" ?& ARRAY['version', 'endpoint', 'region', 'bucket', 'forcePathStyle', 'createBucket']
        AND "config" - ARRAY['version', 'endpoint', 'region', 'bucket', 'forcePathStyle', 'createBucket'] = '{}'::jsonb
        AND "config"->'version' = '1'::jsonb
        AND ("config"->'endpoint' = 'null'::jsonb OR (
            jsonb_typeof("config"->'endpoint') = 'string'
            AND "config"->>'endpoint' ~ '^https?://'
        ))
        AND jsonb_typeof("config"->'region') = 'string'
        AND length("config"->>'region') > 0
        AND jsonb_typeof("config"->'bucket') = 'string'
        AND length("config"->>'bucket') >= 3
        AND jsonb_typeof("config"->'forcePathStyle') = 'boolean'
        AND jsonb_typeof("config"->'createBucket') = 'boolean'
    )
);
-- Multiple immutable credential versions may address the same public descriptor.
CREATE INDEX "platform_storage_location_fingerprint_idx" ON "platform_storage_location"("fingerprint");

ALTER TABLE "platform_storage_location" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_storage_location" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_realm ON "platform_storage_location"
    USING (current_setting('app.realm', true) = 'platform')
    WITH CHECK (current_setting('app.realm', true) = 'platform');
GRANT SELECT, INSERT ON "platform_storage_location" TO studyhub_app;

-- Credential rotation captures a new retained location; descriptors and ciphertext never mutate.
CREATE FUNCTION storage_location_is_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
    RAISE EXCEPTION 'Storage locations are immutable; capture a new location instead'
        USING ERRCODE = 'check_violation';
END
$fn$;
REVOKE ALL ON FUNCTION storage_location_is_immutable() FROM PUBLIC;
CREATE TRIGGER storage_location_is_immutable
    BEFORE UPDATE OR DELETE ON "platform_storage_location"
    FOR EACH ROW EXECUTE FUNCTION storage_location_is_immutable();

ALTER TABLE "asset" ADD COLUMN "storage_location_id" UUID;
ALTER TABLE "asset" ADD CONSTRAINT "asset_storage_location_id_fkey"
    FOREIGN KEY ("storage_location_id") REFERENCES "platform_storage_location"("id") ON DELETE RESTRICT;

-- Originals and their derivatives share one origin. New workers write both to that pinned location.
-- Do not enforce a NOT NULL pairing yet: preexisting objects need the explicit bootstrap capture.
ALTER TABLE "data_export" ADD COLUMN "storage_location_id" UUID;
ALTER TABLE "data_export" ADD CONSTRAINT "data_export_storage_location_id_fkey"
    FOREIGN KEY ("storage_location_id") REFERENCES "platform_storage_location"("id") ON DELETE RESTRICT;
