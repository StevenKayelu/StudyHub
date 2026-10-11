# M2 design: tenancy kernel, isolation and account model

- **Status:** **D1–D6 APPROVED by the client (2026-10-11)**; blueprint amended to revision 4 (03–10). D7 (legal controller role for global accounts) remains OPEN. M2 implementation has not started and needs explicit go-ahead. Hosting and domain are still undecided, so staging stays pending.
- **Date:** 2026-10-11
- **Baseline:** M1 commit `4c52d4a`; blueprint `docs/blueprint/` (revision 3)
- **Client direction received (2026-10-11):**
  - **Isolation:** preference for PostgreSQL row-level security (RLS) enforced by the database, backed by application-level authorization and automated cross-tenant tests.
  - **Roles:** a separate migration role and a restricted runtime role that can't bypass RLS.
  - **School context:** resolved only from a trusted, validated domain or subdomain, never from a client-supplied school id. Enforced on every query, mutation, job and relevant cache operation.
  - **Accounts:** one user may belong to **multiple schools through explicit memberships** with school-specific roles.
  - **Hosting:** none decided; the test-server step stays pending.

Labels: **CONFIRMED** (client direction above), **VERIFIED** (checked with a tool), **PROPOSED** (this design, needs approval), **OPEN** (decision still needed).

---

## 1. Threat model (tenant isolation)

**Assets:** each school's learners' personal data, course content, assessment results, orders and payment records, settings and branding.

**Adversaries:**

1. A user of school A trying to read or change school B's data.
2. A school admin trying to see other schools or users' memberships elsewhere.
3. An external attacker tampering with hosts, headers, URLs and ids.
4. A **developer mistake**, such as a missing tenant filter, a new table without a policy, or a job without context. This is the most likely cause of a leak.
5. A compromised runtime credential (SQL injection or leaked DB password).

| #   | Threat                                            | Vector                                                                  | Controls (layered)                                                                                                                                                                       | Verified by                     |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| T1  | Missing tenant filter in a query                  | Developer error                                                         | RLS on every tenant table, **forced** (owners included); fail-closed when no context is set; repositories also filter by tenant                                                          | T-ISO-03, 04, 05                |
| T2  | Client chooses the tenant                         | `tenantId` in a header, query or body                                   | Tenant is derived **only** from the verified host; client-supplied tenant ids are ignored and never used for authorization                                                               | T-ISO-12, 13                    |
| T3  | Host-header spoofing                              | Forged `Host` / `X-Forwarded-Host`                                      | Forwarded headers trusted only from the reverse proxy and web container addresses; Caddy overwrites the header; host normalised and looked up in `tenant_domain`                         | T-ISO-10, 11                    |
| T4  | Session replay on another school                  | A cookie or token from school A used on school B                        | Host-only `__Host-` cookie; session rows are tenant-owned and RLS-filtered, so B's context can't even see A's session row                                                                | T-ISO-14 (M4)                   |
| T5  | IDOR by guessing ids                              | `/courses/<B's uuid>` while on A                                        | RLS makes B's rows invisible, so the API returns 404, not 403                                                                                                                            | T-ISO-12 (grows each milestone) |
| T6  | Cross-tenant references                           | Insert a row pointing at B's parent row                                 | Composite foreign keys `(tenant_id, parent_id)`. PostgreSQL FK checks **bypass RLS**, so a single-column FK would let a row reference another tenant's row                               | T-ISO-06                        |
| T7  | Existence side channel through unique constraints | "Slug already taken" reveals B's data                                   | Tenant-scoped unique keys `(tenant_id, slug)`; the only global unique keys are on global tables (hosts, account email), and those flows return generic responses                         | T-ISO-07                        |
| T8  | Views or definer functions bypassing RLS          | A view runs as its owner; a SECURITY DEFINER function runs as its owner | All views `security_invoker = true`; SECURITY DEFINER functions are on an inventory allowlist with a fixed `search_path`, return minimal columns and are executable only by the app role | T-ISO-08, 09                    |
| T9  | Context leaking between pooled connections        | A setting persists on a reused connection                               | Context is set with `set_config(..., is_local => true)` inside every transaction, so it ends with the transaction                                                                        | T-ISO-15                        |
| T10 | Runtime credential bypasses RLS                   | Compromised app password                                                | Runtime role is `NOBYPASSRLS`, owns no tables, isn't a member of any bypass role, has DML only (no TRUNCATE or DDL). **No login role with BYPASSRLS exists at all** (§3.3)               | T-ISO-01, 02                    |
| T11 | Statistics leakage                                | Reading `pg_stats` sample values                                        | PostgreSQL 17 hides statistics for RLS-enabled tables (VERIFIED in `system_views.sql`: `relrowsecurity = false OR NOT row_security_active(oid)`)                                         | T-ISO-16                        |
| T12 | Background job writes into the wrong school       | A job runs without or with the wrong context                            | The envelope **requires** `tenantId`; the worker sets context per job; sweeps get `(id, tenant_id)` from a definer function, then process each item in its own tenant transaction        | T-ISO-17, 18                    |
| T13 | Cache serves A's page to B                        | ISR, fetch or in-process caches keyed by path only                      | Next middleware rewrites to `/_t/<host>/…` so caches are keyed by host; in-process keys are built by one helper that requires `tenantId`                                                 | T-ISO-19, 20                    |
| T14 | Files of A readable from B                        | Guessed object keys or signed URLs                                      | Keys are `t/<tenantId>/…`; signed URLs are issued only for assets visible under RLS (M5)                                                                                                 | M5 tests                        |
| T15 | Platform staff browsing school data               | Console access                                                          | Separate realm; no standing access; tenant-approved, time-limited support sessions run **inside** the tenant context (blueprint F44)                                                     | M9 tests                        |
| T16 | TRUNCATE or COPY around RLS                       | TRUNCATE ignores RLS                                                    | The app role is never granted TRUNCATE; it is DML-only                                                                                                                                   | T-ISO-02                        |

Out of scope for M2 (covered later): authentication brute force (M4), upload content attacks (M5), payment webhook confusion (M8).

---

## 2. Isolation approaches compared

| Criterion                                           | A. Shared schema, app filtering only           | **B. Shared schema + forced RLS + app filtering**                                                                                  | C. Schema per school                             | D. Database per school                         |
| --------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| What stops a leak when a developer forgets a filter | Nothing                                        | **The database returns zero rows**                                                                                                 | search_path mistakes can still cross schemas     | Strongest: separate connection strings         |
| Blast radius of one bug                             | All schools                                    | One query returns empty or errors                                                                                                  | One school, if the search_path is right          | One school                                     |
| Migrations                                          | Once                                           | **Once**                                                                                                                           | N times (one per school); partial-failure states | N databases; slow, fragile rollouts            |
| Connection pooling                                  | Simple                                         | **Simple** (transaction-local setting)                                                                                             | Pool per schema, or search_path juggling         | Pool per database; connection limits hit early |
| Ops cost at 50 / 500 / 5,000 schools                | Low                                            | **Low**                                                                                                                            | Medium → high                                    | High → very high (cost per database)           |
| Prisma 7 fit                                        | Good                                           | **Good** (transaction wrapper; benchmark in M2)                                                                                    | Poor (dynamic schemas)                           | Poor (dynamic clients)                         |
| Cross-school platform ops (usage, metrics, sweeps)  | Easy (dangerously easy)                        | **Controlled** (narrow definer functions)                                                                                          | Hard                                             | Hardest                                        |
| Per-school restore                                  | Scratch-restore and copy (blueprint 04 §17.16) | Same                                                                                                                               | Easier (dump one schema)                         | Easiest                                        |
| Per-school export and deletion                      | By tenant_id                                   | **By tenant_id under RLS**                                                                                                         | Drop schema                                      | Drop database                                  |
| "Physically separate data" contracts                | No                                             | No (logical isolation) → offer **E**                                                                                               | Partly                                           | Yes                                            |
| Known PostgreSQL pitfalls                           | —                                              | FK checks and unique constraints bypass RLS; owner bypass without FORCE; definer and view owner semantics. **All addressed in §1** | search_path injection                            | —                                              |

**E. Hybrid:** B for everyone, plus a **dedicated deployment** (same code, its own database and stack) for a school that contractually needs physical separation. No per-school database routing in the codebase (blueprint 04 §17.14).

### Recommendation (PROPOSED; matches the client's stated preference)

**B, with E as the exception path.** It is the only option where a forgotten filter fails _closed_ at the database while staying operable by a small team. A alone is rejected: one missed `WHERE` leaks a school. C and D multiply migrations and operations by the number of schools without stopping the in-app mistakes that cause most real leaks.

---

## 3. Database design for B

### 3.1 How tenant context reaches the database

```
request → host → resolve_tenant(host) → AsyncLocalStorage {tenantId, userId?}
       → every DB transaction starts with:
         SELECT set_config('app.tenant_id', $tenantId, true),   -- true = transaction-local
                set_config('app.user_id',   $userId,   true)    -- from M4
       → RLS policies read current_setting(...)
```

- **Transaction-local** (`is_local = true`) settings vanish at commit or rollback, so a pooled connection can never carry one school's context into another request (T9).
- **Policy pattern** (every tenant-owned table, generated by a migration helper):
  ```sql
  ALTER TABLE x ENABLE ROW LEVEL SECURITY;
  ALTER TABLE x FORCE ROW LEVEL SECURITY;          -- owner (migrator) is subject too
  CREATE POLICY tenant_isolation ON x
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  ```
  `nullif(…, '')` makes "unset" and "reset to empty" both NULL, so a query matches no rows (fail-closed).
- **Prisma 7:** a tenant client extension wraps each operation, or each use-case transaction, in a transaction whose first statement sets the context. Use-case code calls `runInTenantTx(fn)`. Calling a repository without a context throws `TENANT_CONTEXT_MISSING` before reaching the database.
- **No external calls inside these transactions** (payment and video providers are called outside).

### 3.2 Structural rules (enforced in CI)

1. Every tenant-owned table has `tenant_id uuid NOT NULL`, RLS **enabled and forced**, and a `tenant_isolation` policy with both USING and WITH CHECK.
2. `UNIQUE (tenant_id, id)` on referenced tables; children use **composite FKs** `(tenant_id, parent_id)` (T6).
3. Natural keys are unique per tenant: `(tenant_id, slug)` (T7).
4. Every index on a tenant table leads with `tenant_id`.
5. Views must be `WITH (security_invoker = true)` (T8).
6. Tables without `tenant_id` must be on the **global allowlist** with a reason. M2's list: `tenant`, `tenant_domain`, `platform_setting`, pg-boss tables, `_prisma_migrations`; identity tables from M4 (§4).

### 3.3 Database roles

| Role                                       | Login                 | Rights                                                                                               | Purpose                                        |
| ------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `postgres` (superuser)                     | yes (infra only)      | everything                                                                                           | Creates roles; never used by the apps          |
| `studyhub_migrator`                        | yes (migrations only) | Owns database, schema and tables; DDL                                                                | `pnpm db:migrate`. FORCE RLS applies to it too |
| `studyhub_app`                             | yes (API and worker)  | DML only on granted tables; `NOBYPASSRLS`; owns nothing; no TRUNCATE; not a member of any other role | All runtime queries, always under RLS          |
| `studyhub_rls_definer` **(new, PROPOSED)** | **no (NOLOGIN)**      | `BYPASSRLS`; owns only the SECURITY DEFINER functions in §3.4                                        | Narrow, audited cross-tenant lookups           |

**Proposed change to the blueprint (needs approval):** blueprint 04 §17.4 specified a _login_ role `studyhub_platform` with BYPASSRLS for the console and system jobs. This design removes it: **no credential that can bypass RLS exists at runtime.**

- Cross-tenant needs go through a small, reviewed set of definer functions owned by the NOLOGIN role.
- The console (M9) reads only global tables (tenants, plans, usage aggregates via definer functions).
- Support access works inside the tenant context.

This closes threat T10 more completely.

### 3.4 SECURITY DEFINER function inventory (initial, PROPOSED)

All functions use `SET search_path = pg_catalog, public`, are owned by `studyhub_rls_definer`, have `EXECUTE` revoked from PUBLIC and granted only to `studyhub_app`, and return minimal columns.

| Function                                                   | Returns                                                                         | Milestone |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | --------- |
| `resolve_tenant(host text)`                                | `(tenant_id, status, primary_host)`                                             | M2        |
| `claim_due_outbox(limit int)`                              | `(id, tenant_id)`; the dispatcher then processes each row in its tenant context | M2        |
| `auth_lookup(email citext)`                                | `(user_id, password_hash, account_status)`                                      | M4        |
| `my_memberships()`                                         | for `app.user_id` only: `(tenant_name, primary_host, roles, status)`            | M4        |
| `revoke_user_sessions_everywhere()`                        | for `app.user_id` only (password change, "sign out everywhere")                 | M4        |
| `exchange_handoff(token_hash bytea)`                       | `(user_id)` if valid for the **current** tenant                                 | M4        |
| `due_*` sweep helpers (payments, orders, attempts, ledger) | `(id, tenant_id)`                                                               | M7–M9     |

CI keeps an inventory test: any definer function not on the list, without a fixed `search_path`, or executable by PUBLIC fails the build (T-ISO-09).

### 3.5 Role provisioning and migration strategy

- **Roles are cluster-level**, so the migrator can't create them (it has no CREATEROLE, by design).
  - Local and CI: `infra/postgres/init/02-tenancy-roles.sql` (new volumes).
  - **Existing local volumes:** a new idempotent `pnpm db:provision-roles` runs the same SQL as the superuser from `.env`; `pnpm db:reset` is documented as the alternative.
  - Managed database (later): the same idempotent SQL run once by an administrator, per a runbook.
- **Migration `0002_tenancy_kernel`** (M2): `tenant`, `tenant_domain`, the tenant-owned `audit_log` and `outbox` (forced RLS, composite keys), the `resolve_tenant` and `claim_due_outbox` definer functions, and grants. **No existing data, so no backfill.**
- **Every later tenant table ships its policy in the same migration** (CI rule 1). Adding tenant scope to an existing table follows expand/contract:
  1. Add a nullable `tenant_id`.
  2. Backfill.
  3. `SET NOT NULL`.
  4. Enable and force RLS, and add the policy.
  5. Switch the code.
- **No down-migrations**; rollback means redeploying previous code against the expanded schema (blueprint 04 §15).
- **M1 objects:** `platform_setting` stays global. pg-boss tables stay global; job payloads carry `tenantId` and handlers run under RLS.

### 3.6 Tenant resolution (host → school)

1. Caddy (local and later) overwrites `X-Forwarded-Host` with the real host.
2. The API trusts forwarded headers only from configured proxy addresses (`TRUSTED_PROXIES`); otherwise it uses the socket's Host.
3. Normalise the host: lower-case, strip the port and trailing dot, reject invalid characters.
4. `resolve_tenant(host)` runs against `tenant_domain` (verified, active rows only), with a 60 s in-process cache keyed by host. The cache is invalidated on domain changes, via outbox notification.
5. The outcome:
   - Unknown or unverified host → generic "site not found" (never names a school).
   - `SUSPENDED` → restricted mode.
   - `PROVISIONING` → "coming soon".
6. The tenant id is placed in AsyncLocalStorage. **Nothing else can set it.** Request bodies, query strings and headers carrying `tenantId` are ignored (T2).

Local development: `acme.localhost` and `beta.localhost` via Caddy with internal TLS. **Staging is pending** until you approve provider, region, budget and domain.

---

## 4. Account model: one person, many schools (PROPOSED, per client direction)

### 4.1 Model

```
user_account (GLOBAL)          1 ──< tenant_membership (TENANT-OWNED, RLS) >── 1  tenant
  id, email (unique, citext),          id, tenant_id, user_id,
  email_verified_at, status,           status: INVITED | ACTIVE | SUSPENDED | REVOKED,
  default_locale                       per-school profile (display name, student no.),
credential (GLOBAL, 1:1)               joined_at, revoked_at, revoked_by
  password_hash (Argon2id), TOTP     membership_role (TENANT-OWNED) (tenant_id, membership_id, role)
session (TENANT-OWNED, RLS)            role: LEARNER | INSTRUCTOR | TENANT_ADMIN | TENANT_OWNER
  tenant_id, user_id, membership_id, token_hash, expiry …
```

- **Identity is global** (one email, one password, one 2FA). **Everything about a school is tenant-owned:** membership, roles, per-school profile, sessions, enrolments, results, orders.
- **Global identity tables are RLS-protected too**, with special policies:
  - `user_account` is visible only as **yourself** (`id = app.user_id`) or as a **member of the current school** (an `EXISTS` subquery on `tenant_membership`, itself under RLS).
  - `credential` is visible only as yourself.
  - Sign-in reads credentials only through `auth_lookup()`.
  - So a school admin can never list the platform's users or see a user's other schools.
- **Tenant data references `user_id`** through the membership. Deleting an account anonymises the person but keeps each school's financial records for their retention period (blueprint BR-27).

### 4.2 Flows

| Flow                                                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign in** (on a school's host, in that school's branding) | Email and password are checked against the global credential via `auth_lookup()`. Success requires an **ACTIVE membership in this school**. A missing or inactive membership, a wrong password and an unknown email all return the **same generic error**. A session is created in this school's context (host-only cookie).                                                                                                                                          |
| **Register** (school allows open registration)              | Unknown email → create the global account + a LEARNER membership, then verify email. Known email → a generic response, plus an email saying "you already have an account; sign in to join _School_". After sign-in, the user confirms "Join _School_" and the membership is created. Nothing reveals whether the email exists.                                                                                                                                        |
| **Invitation** (school admin)                               | Invite email + role → a tenant-owned `invitation`. Accepting signs the person in (or creates the account) and creates the membership with that role, in one transaction. Invitations are single-use and expire after 7 days (blueprint F42).                                                                                                                                                                                                                          |
| **School switching**                                        | The account menu lists _my schools_ via `my_memberships()` (only the caller's own memberships). Choosing one issues a **one-time hand-off token**: 256-bit, hashed, 60 s, bound to the user and the **target** school, single use. The browser is redirected to the target host, which exchanges the token by POST, creating a session there without re-entering the password. The target re-checks the membership. Typing the password on the other host also works. |
| **Membership suspension / revocation**                      | Status changes to `SUSPENDED` or `REVOKED`, and in the **same transaction** that user's sessions in this school are deleted (RLS-scoped). The next request returns 401. Access then follows blueprint rules (e.g. paid-content access on revocation is a school policy decision). Other schools are unaffected.                                                                                                                                                       |
| **Password change / reset, "sign out everywhere"**          | Global: `revoke_user_sessions_everywhere()` deletes the caller's sessions in all schools. Reset emails use the branding of the school whose host the request came from.                                                                                                                                                                                                                                                                                               |
| **Email change**                                            | Global, re-verified by the user. A school can't change a member's login email.                                                                                                                                                                                                                                                                                                                                                                                        |
| **Leave a school / delete account**                         | Leaving revokes your membership (school data retained per policy). Deleting the account ends all memberships and anonymises personal data in every school through a named, audited system job (per-tenant transactions).                                                                                                                                                                                                                                              |
| **Platform staff**                                          | Unchanged: a separate realm and tables (blueprint 04 §17.5).                                                                                                                                                                                                                                                                                                                                                                                                          |

### 4.3 Consequences you should know

- **White-label tension:** a single account across schools means the sign-in is shared. Copy must use a neutral term ("your account") and say, in the privacy notice, that it works with other schools on this platform. A school can't make "its" users invisible to the platform (it never could), but other schools never see them.
- **Legal (OPEN, Q-LEG-4):** with global identity, the platform is likely a **controller** of the account record (email, password, memberships list), while schools stay controllers of their learning data. Counsel should confirm. This changes the platform–school data processing agreement wording.
- **Global email uniqueness** is the one cross-school uniqueness. Registration, invite and reset responses must stay generic (enumeration).

---

## 5. Enforcement beyond queries

| Surface            | Rule                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutations          | The same RLS policies' WITH CHECK reject writing rows for another tenant; composite FKs reject cross-tenant references                                                                                                  |
| Background jobs    | Envelope `tenantId` required (Zod); worker wraps each job in `runInTenantTx(job.tenantId)`; sweeps use definer functions returning `(id, tenant_id)` and process per item; heavy queues get per-tenant concurrency caps |
| Caches             | Next host rewrite (`/_t/<host>`); revalidation tags `t:<tenantId>:…`; in-process cache helper `cacheKey(tenantId, …)` requires a tenant id; CDN keyed by host                                                           |
| Logs and traces    | `tenantId` on every line and span; never personal data                                                                                                                                                                  |
| Files (M5)         | `t/<tenantId>/…` keys with a DB CHECK; signed URLs only for RLS-visible assets                                                                                                                                          |
| Authorization (M4) | RLS is the floor, not the policy. The application still checks role and ownership per action (e.g. instructor owns course); RLS only guarantees the school boundary                                                     |

---

## 6. M2 tests (all automated; M2 can't complete without them)

| ID        | Test                                                                                                                                                                                                                                 | Level       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| T-ISO-01  | Role posture: `studyhub_app` is NOBYPASSRLS, NOSUPERUSER, owns no relations, is a member of no role; no LOGIN role other than `postgres` has BYPASSRLS                                                                               | SQL         |
| T-ISO-02  | `studyhub_app` has no TRUNCATE, DDL or REFERENCES-on-global grants                                                                                                                                                                   | SQL         |
| T-ISO-03  | Coverage: every table with `tenant_id` has RLS enabled **and forced**, and a policy with USING + WITH CHECK; every table without it is on the global allowlist. A meta-test with an unprotected fixture table proves the check fails | SQL / CI    |
| T-ISO-04  | Fail-closed: with no context, every tenant table returns 0 rows and inserts fail                                                                                                                                                     | SQL         |
| T-ISO-05  | Cross-tenant matrix, generated for **every** tenant table: as B, SELECT, UPDATE and DELETE of A's rows affect 0 rows; INSERT with A's id fails                                                                                       | SQL         |
| T-ISO-06  | Composite FK: a child in B referencing A's parent id is rejected                                                                                                                                                                     | SQL         |
| T-ISO-07  | The same slug or natural key is accepted in two tenants                                                                                                                                                                              | SQL         |
| T-ISO-08  | Every view has `security_invoker = true`                                                                                                                                                                                             | SQL / CI    |
| T-ISO-09  | SECURITY DEFINER inventory: only allowlisted functions, fixed `search_path`, no PUBLIC execute                                                                                                                                       | SQL / CI    |
| T-ISO-10  | Host resolution: known host → tenant; unknown → generic 404; port, case and trailing-dot normalisation; invalid characters rejected                                                                                                  | API         |
| T-ISO-11  | `X-Forwarded-Host` from an untrusted address is ignored; from the trusted proxy it is honoured                                                                                                                                       | API         |
| T-ISO-12  | Cross-tenant API harness: every endpoint called on host B with A's ids/slugs → 404 or empty; responses scanned for A's marker strings (grows each milestone)                                                                         | API         |
| T-ISO-13  | Conflicting `tenantId` in a header, query or body has no effect                                                                                                                                                                      | API         |
| T-ISO-15  | Pool hygiene: after a transaction for A, the next statement on the same connection with no context sees 0 rows                                                                                                                       | SQL         |
| T-ISO-16  | `pg_stats` returns no rows for tenant tables as `studyhub_app`                                                                                                                                                                       | SQL         |
| T-ISO-17  | A job without `tenantId` is rejected; a job for A can't read or write B                                                                                                                                                              | Integration |
| T-ISO-18  | The outbox claim returns mixed tenants; each dispatch runs in its own tenant context                                                                                                                                                 | Integration |
| T-ISO-19  | Next.js: the same path on `acme.localhost` and `beta.localhost` renders different tenants; cache entries are separate                                                                                                                | E2E         |
| T-ISO-20  | Cache-key helper refuses a missing tenant id                                                                                                                                                                                         | Unit        |
| T-PERF-01 | Benchmark: p95 overhead of the context wrapper per transaction, reported. **Go/no-go: ≤3 ms p95 locally** (PROPOSED threshold), else switch the data layer to Kysely for tenant queries                                              | Bench       |

(T-ISO-14, session replay across hosts, lands in M4 with sessions.)

---

## 7. Revised M2 scope and acceptance (PROPOSED)

**In scope:**

- Roles (§3.3) with provisioning (`02-tenancy-roles.sql`, `pnpm db:provision-roles`).
- Migration `0002_tenancy_kernel`; RLS helper and CI checks (§3.2).
- Definer functions `resolve_tenant` and `claim_due_outbox`.
- Tenant context (AsyncLocalStorage) and the Prisma tenant extension with `runInTenantTx`.
- Host resolution with trusted proxies; `GET /api/v1/tenant` (bootstrap: name, status).
- Tenant-owned `audit_log` and `outbox`; job envelope with required `tenantId`.
- Next.js host rewrite; Caddy for `*.localhost`; seed of two mirrored schools; `tenant:create` CLI.
- All tests in §6; ADR-0016/0017/0018.

**Out of scope:** user accounts, memberships, sessions and sign-in (designed here, built in M4); staging deployment (**pending your hosting and domain approval**); any product feature.

**Acceptance:**

- Every test in §6 passes.
- `pnpm verify` is green.
- The benchmark is reported against the threshold.
- No login role can bypass RLS.
- The blueprint amendments below are applied only after your approval.

---

## 8. Blueprint amendments this design implies (applied only after approval)

| Blueprint                                             | Current text                                             | Amendment                                                                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 03 §3 (tenant realm note), BR-43, §9.2 (F01–F04, F42) | "Same person in two tenants has two accounts" (ASSUMED)  | Global account + per-school memberships; sign-in, registration, invitation, switching, revocation flows as §4.2. Q-TEN-1 becomes **CONFIRMED (client, 2026-10-11): memberships** |
| 04 §17.4                                              | Login role `studyhub_platform` with BYPASSRLS            | NOLOGIN `studyhub_rls_definer` owning an inventory of definer functions; no RLS-bypassing login role                                                                             |
| 04 §17.5–17.6                                         | Tenant-scoped identity tables                            | `user_account` and `credential` global with self/member RLS; `tenant_membership`, `membership_role`, sessions tenant-owned; hand-off tokens                                      |
| 05 §8.2                                               | `unique(tenant_id, email)`; `role_assignment` per tenant | Global `unique(email)`; new `tenant_membership`, `membership_role`, `tenant_handoff`; session gains `membership_id`                                                              |
| 06                                                    | No school switcher                                       | Account-menu school switcher; "Join _School_" confirmation; neutral "your account" copy                                                                                          |
| 08                                                    | Q-TEN-1 open; ADR-017 "tenant-scoped accounts"; Q-LEG-4  | Q-TEN-1 answered; ADR-017 revised; Q-LEG-4 adds "platform likely controller of account data"                                                                                     |
| 09, 10                                                | Handoff and readiness reference the old identity model   | Updated accordingly                                                                                                                                                              |

---

## 9. Decisions requiring your approval

| #   | Decision                                                         | Recommendation                                                                                                                 | Blocks                             |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| D1  | Isolation approach                                               | **B: shared schema + forced RLS + composite keys + app scoping**, with dedicated deployments as the exception path             | Start of M2                        |
| D2  | Role model                                                       | migrator (owner, DDL) + app (NOBYPASSRLS, DML only) + NOLOGIN definer role; **no RLS-bypassing login role** (amends blueprint) | Start of M2                        |
| D3  | Account model                                                    | Global account + explicit per-school memberships and roles (§4)                                                                | Design is fixed in M2; build in M4 |
| D4  | Sign-in and switching UX                                         | Sign in on the school's host; switch via one-time hand-off; neutral account wording with privacy disclosure                    | M4                                 |
| D5  | Performance threshold for Prisma + RLS                           | ≤3 ms p95 overhead, else Kysely for tenant data access                                                                         | End of M2                          |
| D6  | Apply the blueprint amendments in §8                             | Yes, as listed                                                                                                                 | Before M2 code                     |
| D7  | Legal check of the controller role for global accounts (Q-LEG-4) | Ask counsel; doesn't block M2 code                                                                                             | Before the first external school   |
| —   | Hosting provider, region, budget, domain                         | **Not decided; staging stays pending**                                                                                         | End of M2 (staging only)           |
