-- 0004_identity_realms (M4): global accounts with per-school memberships (D3), school-host sessions and
-- hand-offs (D4), invitations, and the separate platform (console) realm. Blueprint 04 §8, §17.5–17.6;
-- 05 §8.2; docs/design/m4-identity-realms.md. Runs as studyhub_migrator.
--
-- Context settings used by the policies below (all transaction-local, set by the API):
--   app.tenant_id  the school resolved from the host (M2)
--   app.user_id    the signed-in (or being-created) global account, tenant realm only
--   app.realm      'platform' inside console transactions only; never set on school hosts

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'LOCKED', 'DELETION_REQUESTED', 'DELETED');
CREATE TYPE "TokenPurpose" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD', 'CHANGE_EMAIL');
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE "TenantRole" AS ENUM ('LEARNER', 'INSTRUCTOR', 'TENANT_ADMIN', 'TENANT_OWNER');
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_OWNER', 'PLATFORM_OPERATOR', 'PLATFORM_SUPPORT');
CREATE TYPE "PlatformUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- =============================================================================================
-- TENANT REALM: global identity (no tenant_id; RLS on the caller's own identity)
-- =============================================================================================

-- user_account: one per person (D3). Visible as yourself, or as a member of the CURRENT school
-- (the EXISTS runs under tenant_membership's own RLS). Writable only as yourself (BR-70).
CREATE TABLE "user_account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "display_name" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletion_requested_at" TIMESTAMPTZ(3),
    "anonymised_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id"),
    -- Stored lower-case; uniqueness is case-insensitive by construction.
    CONSTRAINT "user_account_email_format" CHECK (
        "email" = lower("email") AND char_length("email") <= 254 AND "email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),
    CONSTRAINT "user_account_display_name_length" CHECK (char_length("display_name") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");

-- credential: password hash, lockout, TOTP. Yourself only; sign-in reads it through auth_lookup().
CREATE TABLE "credential" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "totp_secret_enc" BYTEA,
    "totp_enabled_at" TIMESTAMPTZ(3),
    "recovery_codes_hash" TEXT[] NOT NULL DEFAULT '{}',

    CONSTRAINT "credential_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE,
    CONSTRAINT "credential_failed_count_nonnegative" CHECK ("failed_count" >= 0)
);

-- one_time_token: email verification, password reset, email change. Stored hashed; redeemed only
-- through redeem_one_time_token() (the person redeeming is not signed in).
CREATE TABLE "one_time_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    -- The school whose host requested it (branding of the email and the landing page).
    "context_tenant_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "one_time_token_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "one_time_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE,
    CONSTRAINT "one_time_token_context_tenant_id_fkey" FOREIGN KEY ("context_tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL,
    CONSTRAINT "one_time_token_hash_length" CHECK (octet_length("token_hash") = 32),
    CONSTRAINT "one_time_token_lifetime" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '7 days')
);
CREATE UNIQUE INDEX "one_time_token_token_hash_key" ON "one_time_token"("token_hash");
CREATE INDEX "one_time_token_user_purpose_idx" ON "one_time_token"("user_id", "purpose");

-- tenant_handoff: one-time school switch (BR-68). Created for yourself on the source host; redeemed
-- only through exchange_handoff() on the target host.
CREATE TABLE "tenant_handoff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "target_tenant_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_handoff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_handoff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE,
    CONSTRAINT "tenant_handoff_target_tenant_id_fkey" FOREIGN KEY ("target_tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "tenant_handoff_hash_length" CHECK (octet_length("token_hash") = 32),
    CONSTRAINT "tenant_handoff_lifetime" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '60 seconds')
);
CREATE UNIQUE INDEX "tenant_handoff_token_hash_key" ON "tenant_handoff"("token_hash");
CREATE INDEX "tenant_handoff_user_idx" ON "tenant_handoff"("user_id");

-- =============================================================================================
-- TENANT REALM: school-owned identity rows (standard tenant_isolation)
-- =============================================================================================

-- tenant_membership: a person's membership of one school (D3, BR-43).
CREATE TABLE "tenant_membership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "display_name_override" TEXT,
    "student_number" TEXT,
    "joined_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_membership_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "tenant_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "tenant_membership_tenant_user_key" ON "tenant_membership"("tenant_id", "user_id");
CREATE UNIQUE INDEX "tenant_membership_tenant_id_id_key" ON "tenant_membership"("tenant_id", "id");
CREATE INDEX "tenant_membership_tenant_status_idx" ON "tenant_membership"("tenant_id", "status");

SELECT tenancy_apply_isolation('"tenant_membership"');
GRANT SELECT, INSERT, UPDATE ON "tenant_membership" TO studyhub_app;
GRANT SELECT ON "tenant_membership" TO studyhub_rls_definer;

-- membership_role: roles per membership (LEARNER, INSTRUCTOR, TENANT_ADMIN, TENANT_OWNER).
CREATE TABLE "membership_role" (
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role" "TenantRole" NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_role_pkey" PRIMARY KEY ("tenant_id", "membership_id", "role"),
    -- Composite: a role can only point at a membership of the same school (T-ISO-06).
    CONSTRAINT "membership_role_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id")
        REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE CASCADE
);

SELECT tenancy_apply_isolation('"membership_role"');
GRANT SELECT, INSERT, DELETE ON "membership_role" TO studyhub_app;
GRANT SELECT ON "membership_role" TO studyhub_rls_definer;

-- session: a signed-in browser on ONE school host (D4, BR-44). The cookie holds a random token;
-- only its SHA-256 is stored. Invisible (hence invalid) on any other school's host.
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip" INET,
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE,
    CONSTRAINT "session_membership_fkey" FOREIGN KEY ("tenant_id", "membership_id")
        REFERENCES "tenant_membership"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "session_hash_length" CHECK (octet_length("token_hash") = 32),
    CONSTRAINT "session_expiry_order" CHECK ("idle_expires_at" <= "absolute_expires_at")
);
CREATE UNIQUE INDEX "session_tenant_token_key" ON "session"("tenant_id", "token_hash");
CREATE INDEX "session_tenant_user_idx" ON "session"("tenant_id", "user_id");

SELECT tenancy_apply_isolation('"session"');
GRANT SELECT, INSERT, DELETE ON "session" TO studyhub_app;
GRANT UPDATE ("last_seen_at", "idle_expires_at") ON "session" TO studyhub_app;
GRANT SELECT, DELETE ON "session" TO studyhub_rls_definer;

-- invitation: join a school with a given role (BR-67). Single use, 7 days.
CREATE TABLE "invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "invited_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invitation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
    CONSTRAINT "invitation_email_format" CHECK ("email" = lower("email") AND "email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT "invitation_hash_length" CHECK (octet_length("token_hash") = 32),
    CONSTRAINT "invitation_lifetime" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '7 days')
);
CREATE UNIQUE INDEX "invitation_tenant_token_key" ON "invitation"("tenant_id", "token_hash");
CREATE UNIQUE INDEX "invitation_open_key" ON "invitation"("tenant_id", "email", "role")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

SELECT tenancy_apply_isolation('"invitation"');
GRANT SELECT, INSERT ON "invitation" TO studyhub_app;
GRANT UPDATE ("accepted_at", "revoked_at") ON "invitation" TO studyhub_app;

-- BR-69: suspending or revoking a membership deletes that person's sessions in that school in the same
-- transaction. Enforced in the database so no code path can forget it. Runs as the caller (no definer):
-- the delete stays inside the caller's tenant under RLS.
CREATE FUNCTION membership_end_sessions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  DELETE FROM session WHERE tenant_id = NEW.tenant_id AND membership_id = NEW.id;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION membership_end_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION membership_end_sessions() TO studyhub_app;

CREATE TRIGGER "tenant_membership_end_sessions"
    AFTER UPDATE OF "status" ON "tenant_membership"
    FOR EACH ROW
    WHEN (NEW."status" IN ('SUSPENDED', 'REVOKED') AND OLD."status" IS DISTINCT FROM NEW."status")
    EXECUTE FUNCTION membership_end_sessions();

-- BR-58: a school always keeps at least one ACTIVE owner. Checked at commit, so a transfer can add the
-- new owner and remove the old one in either order.
CREATE FUNCTION tenant_keeps_an_owner() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  affected uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  IF EXISTS (SELECT 1 FROM membership_role r WHERE r.tenant_id = affected AND r.role = 'TENANT_OWNER')
     AND NOT EXISTS (
       SELECT 1 FROM membership_role r JOIN tenant_membership m ON m.tenant_id = r.tenant_id AND m.id = r.membership_id
        WHERE r.tenant_id = affected AND r.role = 'TENANT_OWNER' AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'A school must keep at least one active owner (BR-58)' USING ERRCODE = 'check_violation';
  END IF;
  -- A school that had an owner and now has no owner role at all. (Nested: PL/pgSQL doesn't
  -- short-circuit, and OLD has no "role" field when this fires for tenant_membership.)
  IF TG_TABLE_NAME = 'membership_role' AND TG_OP = 'DELETE' THEN
    IF OLD.role = 'TENANT_OWNER'
       AND NOT EXISTS (SELECT 1 FROM membership_role r WHERE r.tenant_id = affected AND r.role = 'TENANT_OWNER') THEN
      RAISE EXCEPTION 'A school must keep at least one active owner (BR-58)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION tenant_keeps_an_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_keeps_an_owner() TO studyhub_app;

CREATE CONSTRAINT TRIGGER "membership_role_keeps_owner"
    AFTER DELETE ON "membership_role" DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION tenant_keeps_an_owner();
CREATE CONSTRAINT TRIGGER "tenant_membership_keeps_owner"
    AFTER UPDATE OF "status" ON "tenant_membership" DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION tenant_keeps_an_owner();

-- ---------------------------------------------------------------------------------------------
-- RLS on the global identity tables (after tenant_membership exists, which user_account references).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "user_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_self_or_member ON "user_account"
    USING (
        "id" = nullif(current_setting('app.user_id', true), '')::uuid
        OR EXISTS (SELECT 1 FROM tenant_membership m WHERE m.user_id = "user_account"."id")
    )
    WITH CHECK ("id" = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "user_account" TO studyhub_app;
GRANT SELECT ON "user_account" TO studyhub_rls_definer;

ALTER TABLE "credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credential" FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_self ON "credential"
    USING ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid)
    WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "credential" TO studyhub_app;
GRANT SELECT ON "credential" TO studyhub_rls_definer;

ALTER TABLE "one_time_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "one_time_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY one_time_token_self ON "one_time_token"
    USING ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid)
    WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "one_time_token" TO studyhub_app;
GRANT SELECT, UPDATE ON "one_time_token" TO studyhub_rls_definer;

ALTER TABLE "tenant_handoff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_handoff" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_handoff_self ON "tenant_handoff"
    USING ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid)
    WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT ON "tenant_handoff" TO studyhub_app;
GRANT SELECT, UPDATE ON "tenant_handoff" TO studyhub_rls_definer;

-- =============================================================================================
-- PLATFORM REALM (console). No tenant_id. Visible only inside console transactions
-- (app.realm = 'platform'), so no school-host request can ever read staff accounts or sessions.
-- =============================================================================================
CREATE TABLE "platform_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "status" "PlatformUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_user_email_format" CHECK ("email" = lower("email") AND "email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"("email");

CREATE TABLE "platform_credential" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "totp_secret_enc" BYTEA,
    "totp_enabled_at" TIMESTAMPTZ(3),
    -- Last accepted TOTP time step: a code can't be replayed (RFC 6238 §5.2).
    "totp_last_step" BIGINT,
    "recovery_codes_hash" TEXT[] NOT NULL DEFAULT '{}',

    CONSTRAINT "platform_credential_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "platform_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE
);

CREATE TABLE "platform_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    -- NULL until the second factor (TOTP) is verified: such a session can only enrol or verify.
    "mfa_verified_at" TIMESTAMPTZ(3),
    -- Last re-authentication (TOTP) for sensitive actions.
    "reauth_at" TIMESTAMPTZ(3),
    "ip" INET,
    "user_agent" TEXT,

    CONSTRAINT "platform_session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE,
    CONSTRAINT "platform_session_hash_length" CHECK (octet_length("token_hash") = 32),
    CONSTRAINT "platform_session_expiry_order" CHECK ("idle_expires_at" <= "absolute_expires_at")
);
CREATE UNIQUE INDEX "platform_session_token_hash_key" ON "platform_session"("token_hash");
CREATE INDEX "platform_session_user_idx" ON "platform_session"("user_id");

-- platform_audit_log: console actions (append-only for the runtime role).
CREATE TABLE "platform_audit_log" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "actor_id" UUID,
    "tenant_ref" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_audit_log_action_format" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
CREATE INDEX "platform_audit_log_created_idx" ON "platform_audit_log"("created_at" DESC);

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_user', 'platform_credential', 'platform_session', 'platform_audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY platform_realm ON %I '
      'USING (current_setting(''app.realm'', true) = ''platform'') '
      'WITH CHECK (current_setting(''app.realm'', true) = ''platform'')', t);
  END LOOP;
END
$do$;
GRANT SELECT, INSERT, UPDATE ON "platform_user" TO studyhub_app;
GRANT SELECT, INSERT, UPDATE ON "platform_credential" TO studyhub_app;
GRANT SELECT, INSERT, DELETE ON "platform_session" TO studyhub_app;
GRANT UPDATE ("last_seen_at", "idle_expires_at", "mfa_verified_at", "reauth_at") ON "platform_session" TO studyhub_app;
GRANT SELECT, INSERT ON "platform_audit_log" TO studyhub_app;

-- =============================================================================================
-- SECURITY DEFINER inventory additions (04 §17.4). Owned by NOLOGIN studyhub_rls_definer; executable
-- only by studyhub_app; fixed search_path. Each returns the minimum the caller needs.
-- ORDER MATTERS: privileges first, then the ownership transfer (see 0002).
-- =============================================================================================

-- auth_lookup: sign-in, registration and password reset look an email up without being signed in.
-- Returns the account's id, status, lockout state and password hash (verified in the API).
CREATE FUNCTION auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, status "AccountStatus", email_verified boolean, password_hash text,
               failed_count integer, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT a.id, a.status, a.email_verified_at IS NOT NULL, c.password_hash, c.failed_count, c.locked_until
      FROM user_account a
      LEFT JOIN credential c ON c.user_id = a.id
     WHERE a.email = lower(trim(p_email))
$fn$;
REVOKE ALL ON FUNCTION auth_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup(text) TO studyhub_app;
ALTER FUNCTION auth_lookup(text) OWNER TO studyhub_rls_definer;

-- redeem_one_time_token: consumes a valid, unexpired token of the given purpose exactly once.
CREATE FUNCTION redeem_one_time_token(p_token_hash bytea, p_purpose "TokenPurpose")
RETURNS TABLE (user_id uuid, payload jsonb, context_tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    UPDATE one_time_token t
       SET used_at = now()
     WHERE t.token_hash = p_token_hash
       AND t.purpose = p_purpose
       AND t.used_at IS NULL
       AND t.expires_at > now()
    RETURNING t.user_id, t.payload, t.context_tenant_id
$fn$;
REVOKE ALL ON FUNCTION redeem_one_time_token(bytea, "TokenPurpose") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_one_time_token(bytea, "TokenPurpose") TO studyhub_app;
ALTER FUNCTION redeem_one_time_token(bytea, "TokenPurpose") OWNER TO studyhub_rls_definer;

-- my_memberships: the CALLER's own active schools (for the school switcher). Never anyone else's.
CREATE FUNCTION my_memberships()
RETURNS TABLE (tenant_id uuid, tenant_name text, primary_host text, roles "TenantRole"[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT t.id,
           t.name,
           (SELECT d.hostname FROM tenant_domain d
             WHERE d.tenant_id = t.id AND d.is_primary AND d.status = 'ACTIVE' LIMIT 1),
           COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM membership_role r
                      WHERE r.tenant_id = m.tenant_id AND r.membership_id = m.id), '{}')
      FROM tenant_membership m
      JOIN tenant t ON t.id = m.tenant_id
     WHERE m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
       AND m.status = 'ACTIVE'
       AND t.status = 'ACTIVE'
     ORDER BY t.name
$fn$;
REVOKE ALL ON FUNCTION my_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_memberships() TO studyhub_app;
GRANT SELECT ON "tenant", "tenant_domain" TO studyhub_rls_definer;
ALTER FUNCTION my_memberships() OWNER TO studyhub_rls_definer;

-- revoke_user_sessions_everywhere: password change, reset or "sign out everywhere" ends the CALLER's
-- sessions in every school (BR-69), optionally keeping the current one. Returns how many ended.
CREATE FUNCTION revoke_user_sessions_everywhere(p_keep_session uuid DEFAULT NULL)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    WITH ended AS (
      DELETE FROM session s
       WHERE s.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND (p_keep_session IS NULL OR s.id <> p_keep_session)
      RETURNING 1)
    SELECT count(*)::integer FROM ended
$fn$;
REVOKE ALL ON FUNCTION revoke_user_sessions_everywhere(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_user_sessions_everywhere(uuid) TO studyhub_app;
ALTER FUNCTION revoke_user_sessions_everywhere(uuid) OWNER TO studyhub_rls_definer;

-- exchange_handoff: on the TARGET host, consumes a hand-off minted for this school. Returns the user id;
-- the API then re-checks the ACTIVE membership under RLS before creating a session (BR-68).
CREATE FUNCTION exchange_handoff(p_token_hash bytea)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    UPDATE tenant_handoff h
       SET used_at = now()
     WHERE h.token_hash = p_token_hash
       AND h.used_at IS NULL
       AND h.expires_at > now()
       AND h.target_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    RETURNING h.user_id
$fn$;
REVOKE ALL ON FUNCTION exchange_handoff(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exchange_handoff(bytea) TO studyhub_app;
ALTER FUNCTION exchange_handoff(bytea) OWNER TO studyhub_rls_definer;
