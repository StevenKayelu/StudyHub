import type { Client } from 'pg';

/**
 * Structural tenancy rules, checked against the live PostgreSQL catalog (design §3.2, blueprint 04 §17.4).
 * Every exception is listed here with its reason; anything else is a violation.
 */

/** Tables without tenant_id, and why they are allowed. */
export const GLOBAL_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations: 'migration bookkeeping (migrator only)',
  platform_setting: 'global platform settings, no tenant data',
  tenant: 'school identity; RLS policy tenant_self limits it to its own context',
};

/** Tables that carry RLS with a non-standard policy instead of tenant_isolation. */
export const SPECIAL_POLICY_TABLES: Readonly<Record<string, string>> = {
  tenant: 'tenant_self',
};

/** The complete SECURITY DEFINER inventory (blueprint 04 §17.4). */
export const DEFINER_INVENTORY: ReadonlySet<string> = new Set(['resolve_tenant', 'claim_due_outbox']);

/** Indexes on tenant tables that may not lead with tenant_id, and why. */
export const INDEX_EXCEPTIONS: Readonly<Record<string, string>> = {
  tenant_domain_hostname_key: 'a host maps to exactly one school platform-wide',
  outbox_due_idx: 'cross-tenant claim sweep via claim_due_outbox()',
};

export const DEFINER_OWNER = 'studyhub_rls_definer';
export const REQUIRED_SEARCH_PATH = 'search_path=pg_catalog, public';

export async function tenantOwnedTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY 1`,
  );
  return rows.map((row) => row.table_name);
}

/** Returns human-readable violations; an empty list means the schema follows the rules. */
export async function findTenancyViolations(client: Client): Promise<string[]> {
  const violations: string[] = [];

  // Tables: RLS enabled + forced + the right policy; or on the global allowlist.
  const tables = await client.query<{
    table_name: string;
    rls: boolean;
    forced: boolean;
    has_tenant_id: boolean;
    policies: string[] | null;
  }>(
    `SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND NOT a.attisdropped) AS has_tenant_id,
            (SELECT array_agg(p.policyname::text ORDER BY p.policyname) FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.cmd = 'ALL'
                AND p.qual LIKE '%app.tenant_id%' AND p.with_check LIKE '%app.tenant_id%') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  );
  for (const table of tables.rows) {
    const policies = table.policies ?? [];
    const expectedPolicy = SPECIAL_POLICY_TABLES[table.table_name] ?? 'tenant_isolation';
    const mustBeIsolated = table.has_tenant_id || table.table_name in SPECIAL_POLICY_TABLES;
    if (mustBeIsolated) {
      if (!table.rls) violations.push(`${table.table_name}: row-level security is not enabled`);
      if (!table.forced) violations.push(`${table.table_name}: row-level security is not forced`);
      if (!policies.includes(expectedPolicy)) {
        violations.push(
          `${table.table_name}: missing ${expectedPolicy} policy (USING + WITH CHECK on app.tenant_id)`,
        );
      }
    } else if (!(table.table_name in GLOBAL_TABLES)) {
      violations.push(`${table.table_name}: no tenant_id and not on the global-table allowlist`);
    }
  }

  // Views must use the caller's permissions; materialised views are not allowed.
  const views = await client.query<{ name: string; kind: string; options: string[] | null }>(
    `SELECT c.relname AS name, c.relkind::text AS kind, c.reloptions AS options
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')`,
  );
  for (const view of views.rows) {
    if (view.kind === 'm') violations.push(`${view.name}: materialised views bypass RLS and are not allowed`);
    const invoker = (view.options ?? []).some((option) => /^security_invoker=(true|on|1)$/i.test(option));
    if (view.kind === 'v' && !invoker) violations.push(`${view.name}: view is not security_invoker`);
  }

  // SECURITY DEFINER functions: inventory only, right owner, fixed search_path, no PUBLIC execute.
  const definers = await client.query<{
    name: string;
    owner: string;
    config: string[] | null;
    acl: string | null;
  }>(
    `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.proacl::text AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef`,
  );
  for (const fn of definers.rows) {
    if (!DEFINER_INVENTORY.has(fn.name))
      violations.push(`${fn.name}: SECURITY DEFINER function not on the inventory`);
    if (fn.owner !== DEFINER_OWNER)
      violations.push(`${fn.name}: owned by ${fn.owner}, expected ${DEFINER_OWNER}`);
    if (!(fn.config ?? []).includes(REQUIRED_SEARCH_PATH))
      violations.push(`${fn.name}: search_path is not fixed`);
    // ACL entries look like `grantee=privileges/grantor`; an empty grantee means PUBLIC. A NULL ACL
    // means the built-in default, which includes EXECUTE for PUBLIC.
    const grantees =
      fn.acl === null
        ? ['']
        : fn.acl
            .replace(/^\{|\}$/g, '')
            .split(',')
            .map((entry) => entry.split('=')[0] ?? '');
    for (const grantee of grantees) {
      if (grantee === '') violations.push(`${fn.name}: executable by PUBLIC`);
      else if (grantee !== DEFINER_OWNER && grantee !== 'studyhub_app') {
        violations.push(`${fn.name}: executable by ${grantee} (only studyhub_app may execute it)`);
      }
    }
    if (!grantees.includes('studyhub_app')) violations.push(`${fn.name}: not executable by studyhub_app`);
  }

  // Indexes on tenant tables lead with tenant_id (primary keys and documented exceptions aside).
  const indexes = await client.query<{
    table_name: string;
    index_name: string;
    primary: boolean;
    first_column: string | null;
  }>(
    `SELECT t.relname AS table_name, i.relname AS index_name, ix.indisprimary AS primary, a.attname AS first_column
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ix.indkey[0]
      WHERE n.nspname = 'public'
        AND EXISTS (SELECT 1 FROM pg_attribute ta WHERE ta.attrelid = t.oid AND ta.attname = 'tenant_id'
                    AND NOT ta.attisdropped)`,
  );
  for (const index of indexes.rows) {
    if (index.primary || index.index_name in INDEX_EXCEPTIONS) continue;
    if (index.first_column !== 'tenant_id') {
      violations.push(`${index.index_name} on ${index.table_name}: does not lead with tenant_id`);
    }
  }
  return violations;
}

/** Role posture (T-ISO-01, T-ISO-02). */
export async function findRoleViolations(client: Client): Promise<string[]> {
  const violations: string[] = [];

  const bypassLogins = await client.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolbypassrls AND NOT rolsuper`,
  );
  for (const role of bypassLogins.rows) violations.push(`${role.rolname}: a LOGIN role that bypasses RLS`);

  const app = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    owned: string;
    memberships: string;
  }>(
    `SELECT r.rolsuper, r.rolbypassrls,
            (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)::text AS owned,
            (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::text AS memberships
       FROM pg_roles r WHERE r.rolname = 'studyhub_app'`,
  );
  const appRole = app.rows[0];
  if (appRole === undefined) {
    violations.push('studyhub_app does not exist');
  } else {
    if (appRole.rolsuper) violations.push('studyhub_app is a superuser');
    if (appRole.rolbypassrls) violations.push('studyhub_app can bypass RLS');
    if (appRole.owned !== '0') violations.push(`studyhub_app owns ${appRole.owned} relations`);
    if (appRole.memberships !== '0') violations.push('studyhub_app is a member of another role');
  }

  const definer = await client.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
    `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'studyhub_rls_definer'`,
  );
  const definerRole = definer.rows[0];
  if (definerRole === undefined) violations.push('studyhub_rls_definer does not exist');
  else if (definerRole.rolcanlogin) violations.push('studyhub_rls_definer can log in');

  const dangerous = await client.query<{ table_name: string; privilege_type: string }>(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'studyhub_app' AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')`,
  );
  for (const grant of dangerous.rows)
    violations.push(`studyhub_app has ${grant.privilege_type} on ${grant.table_name}`);

  const schemaCreate = await client.query<{ can_create: boolean }>(
    `SELECT has_schema_privilege('studyhub_app', 'public', 'CREATE') AS can_create`,
  );
  if (schemaCreate.rows[0]?.can_create === true) violations.push('studyhub_app can CREATE in schema public');

  const helper = await client.query<{ can_execute: boolean }>(
    `SELECT has_function_privilege('studyhub_app', 'tenancy_apply_isolation(regclass)', 'EXECUTE') AS can_execute`,
  );
  if (helper.rows[0]?.can_execute === true) violations.push('studyhub_app can execute the migration helper');

  return violations;
}
