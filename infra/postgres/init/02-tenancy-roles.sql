-- StudyHub tenancy roles (M2; decision D2, blueprint 04 §17.4).
-- Idempotent: runs automatically for new data volumes (docker-entrypoint-initdb.d) and can be re-run
-- against an existing local database with `pnpm db:provision-roles`. Must run as a superuser.
--
--   studyhub_rls_definer  NOLOGIN + BYPASSRLS. Owns ONLY the reviewed SECURITY DEFINER functions that
--                         perform narrow cross-tenant lookups (resolve_tenant, claim_due_outbox, ...).
--                         Nobody can log in as it, and studyhub_app is never a member of it.
--
-- There is deliberately NO login role that can bypass row-level security.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'studyhub_rls_definer') THEN
    CREATE ROLE studyhub_rls_definer NOLOGIN NOINHERIT BYPASSRLS
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- The migrator hands ownership of definer functions to this role (ALTER FUNCTION ... OWNER TO), which
-- requires SET permission on it. INHERIT FALSE: the migrator never gains its privileges implicitly.
GRANT studyhub_rls_definer TO studyhub_migrator WITH INHERIT FALSE, SET TRUE;
