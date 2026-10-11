-- 0002_tenancy_kernel (M2): tenants, host resolution, tenant-owned audit log and outbox, forced RLS.
-- Design: docs/design/m2-tenancy-kernel.md; blueprint 04 §17 (revision 4, decisions D1-D2).
-- Runs as studyhub_migrator. Requires infra/postgres/init/02-tenancy-roles.sql (role studyhub_rls_definer).

-- ---------------------------------------------------------------------------------------------
-- Closed by default: objects created from now on grant nothing to the runtime role or to PUBLIC.
-- Every table and function below receives explicit, minimal grants.
-- ---------------------------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM studyhub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM studyhub_app;
-- Functions: PUBLIC's EXECUTE is a *global* default, so only the global form can revoke it
-- (a per-schema ALTER DEFAULT PRIVILEGES cannot remove a global default).
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The definer role must be able to own functions in this schema and read the tables they use.
GRANT USAGE, CREATE ON SCHEMA public TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- Migration helper: applies the standard tenant-isolation policy to a tenant-owned table.
-- Never executable by the runtime role.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION tenancy_apply_isolation(target regclass) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s '
    'USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
    'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
    target
  );
END
$fn$;
REVOKE ALL ON FUNCTION tenancy_apply_isolation(regclass) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------
CREATE TYPE "TenantKind" AS ENUM ('SCHOOL', 'COLLEGE', 'UNIVERSITY', 'TUTORING_BUSINESS', 'INDEPENDENT_TUTOR', 'MARKETPLACE', 'OTHER');
CREATE TYPE "TenantStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DELETED');
CREATE TYPE "DomainType" AS ENUM ('SUBDOMAIN', 'CUSTOM');
CREATE TYPE "DomainStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'FAILED', 'REDIRECT');

-- ---------------------------------------------------------------------------------------------
-- tenant (global identity of a school). RLS: a tenant row is visible only inside its own context.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TenantKind" NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'PROVISIONING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
    CONSTRAINT "tenant_name_length" CHECK (char_length("name") BETWEEN 2 AND 120)
);
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON "tenant"
    USING ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON "tenant" TO studyhub_app;
GRANT SELECT ON "tenant" TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- tenant_domain: hosts that resolve to a school. The runtime role has NO access; resolution goes
-- through resolve_tenant() only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "tenant_domain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "type" "DomainType" NOT NULL DEFAULT 'SUBDOMAIN',
    "status" "DomainStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_domain_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_domain_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_domain_hostname_format" CHECK (
        "hostname" = lower("hostname")
        AND char_length("hostname") <= 253
        AND "hostname" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    )
);
CREATE UNIQUE INDEX "tenant_domain_hostname_key" ON "tenant_domain"("hostname");
CREATE UNIQUE INDEX "tenant_domain_one_primary" ON "tenant_domain"("tenant_id") WHERE "is_primary";
CREATE INDEX "tenant_domain_tenant_id_idx" ON "tenant_domain"("tenant_id", "status");

SELECT tenancy_apply_isolation('"tenant_domain"');
GRANT SELECT ON "tenant_domain" TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- audit_log: tenant audit trail. Append-only for the runtime role (no UPDATE or DELETE).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "audit_log" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "audit_log_action_format" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
CREATE INDEX "audit_log_tenant_created_idx" ON "audit_log"("tenant_id", "created_at" DESC);
CREATE INDEX "audit_log_tenant_entity_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id");

SELECT tenancy_apply_isolation('"audit_log"');
GRANT SELECT, INSERT ON "audit_log" TO studyhub_app;

-- ---------------------------------------------------------------------------------------------
-- outbox: side effects written in the same transaction as business changes, dispatched later.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "outbox" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "tenant_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_until" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "outbox_topic_format" CHECK ("topic" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$')
);
CREATE INDEX "outbox_tenant_created_idx" ON "outbox"("tenant_id", "created_at");
-- Documented exception to "indexes lead with tenant_id": the cross-tenant claim sweep needs this index.
CREATE INDEX "outbox_due_idx" ON "outbox"("available_at", "id") WHERE "dispatched_at" IS NULL;

SELECT tenancy_apply_isolation('"outbox"');
GRANT SELECT, INSERT, UPDATE ON "outbox" TO studyhub_app;
GRANT SELECT, UPDATE ON "outbox" TO studyhub_rls_definer;

-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER inventory (owned by NOLOGIN studyhub_rls_definer; executable only by the app).
-- Each returns routing data only.
-- ORDER MATTERS: privileges are set while the migrator still owns the function, THEN ownership moves.
-- (After the transfer the migrator is no longer the owner, and REVOKE/GRANT would be silently ignored.)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION resolve_tenant(p_host text)
RETURNS TABLE (tenant_id uuid, status "TenantStatus", primary_host text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT t.id,
           t.status,
           (SELECT p.hostname FROM tenant_domain p
             WHERE p.tenant_id = t.id AND p.is_primary AND p.status = 'ACTIVE'
             LIMIT 1)
      FROM tenant_domain d
      JOIN tenant t ON t.id = d.tenant_id
     WHERE d.hostname = lower(p_host)
       AND d.status = 'ACTIVE'
       AND t.status <> 'DELETED'
$fn$;
REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO studyhub_app;
ALTER FUNCTION resolve_tenant(text) OWNER TO studyhub_rls_definer;

CREATE FUNCTION claim_due_outbox(p_limit integer, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (id bigint, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    UPDATE outbox o
       SET claimed_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
           attempts = o.attempts + 1
     WHERE o.id IN (
            SELECT c.id FROM outbox c
             WHERE c.dispatched_at IS NULL
               AND c.available_at <= now()
               AND (c.claimed_until IS NULL OR c.claimed_until < now())
             ORDER BY c.available_at, c.id
             LIMIT least(greatest(p_limit, 1), 100)
             FOR UPDATE SKIP LOCKED)
    RETURNING o.id, o.tenant_id
$fn$;
REVOKE ALL ON FUNCTION claim_due_outbox(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_outbox(integer, integer) TO studyhub_app;
ALTER FUNCTION claim_due_outbox(integer, integer) OWNER TO studyhub_rls_definer;
