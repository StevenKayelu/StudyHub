# ADR-0016: Shared schema with forced row-level security; no RLS-bypassing login role

- **Status:** Accepted (client decisions D1, D2, D5 — 2026-10-11; D5 revised by the client the same day after measurement, see below).
- **Date:** 2026-10-11
- **Blueprint reference:** `docs/blueprint/04-target-architecture.md` §17.1–17.4; `docs/design/m2-tenancy-kernel.md` §2–3

## Context

Many schools share one platform, and a cross-school leak would be catastrophic. The most likely cause of a leak is a developer mistake (a missing filter, a new table without protection, a job without context), not an attacker. A small team must be able to operate the result.

## Decision

1. **One database, one schema.** Every school-owned table has `tenant_id uuid NOT NULL`, row-level security **enabled and forced** (owners included), and a `tenant_isolation` policy with USING and WITH CHECK on `current_setting('app.tenant_id', true)`. With no context set, queries match nothing (fail-closed). New tables get the policy from the migration helper `tenancy_apply_isolation()`.
2. **Context per transaction.** `runInTenantTx()` starts every tenant transaction with `set_config('app.tenant_id', $1, true)` (transaction-local), so pooled connections can't carry context between requests. Without a context it throws `TENANT_CONTEXT_MISSING` before touching the database.
3. **Composite tenant foreign keys** and **tenant-scoped unique keys**, because PostgreSQL checks FKs and unique constraints without RLS.
4. **Roles:**
   - `studyhub_migrator` (owner, DDL, migrations only)
   - `studyhub_app` (runtime: NOBYPASSRLS, owns nothing, DML only, closed-by-default grants)
   - NOLOGIN `studyhub_rls_definer` (BYPASSRLS) owning only the SECURITY DEFINER inventory: `resolve_tenant`, `claim_due_outbox`
   - **No login role can bypass RLS.**
5. **CI-enforced catalog checks** (`apps/api/test/setup/tenancy-checks.ts`): RLS coverage, global-table allowlist, `security_invoker` views, definer inventory (owner, fixed `search_path`, grantees), tenant-leading indexes, role posture. Meta-tests prove each check fires.
6. **Dedicated deployments** (same code, own stack) for a customer that contractually needs physical separation. No per-tenant database routing in code.

## Consequences

- A forgotten `WHERE tenant_id = …` returns no rows instead of another school's data.
- One extra statement per transaction (measured below).
- Cross-tenant work is only possible through reviewed definer functions; adding one requires an ADR amendment and an inventory update.
- **Lesson recorded during M2:** permissions on a SECURITY DEFINER function must be set _before_ ownership moves to the definer role (afterwards the migrator's REVOKE/GRANT are silently ignored), and PUBLIC's default EXECUTE on functions can only be revoked with the _global_ `ALTER DEFAULT PRIVILEGES`. The catalog check caught this before any commit.

## D5 performance gate (revised by the client after measurement)

The original threshold (context overhead ≤ 3 ms p95, else Kysely) failed on the development machine. Measurements (Windows 11, Docker Desktop, 300 iterations, repeated runs):

| Measurement                                       | p50           | p95        |
| ------------------------------------------------- | ------------- | ---------- |
| One network round trip (`SELECT 1`)               | 2.7–3.5 ms    | 4.2–5.2 ms |
| Overhead of the tenant transaction vs a plain one | 2.8–3.8 ms    | 4.1–5.6 ms |
| Server-side execution of `set_config`             | 0.015–0.05 ms | —          |

The overhead is exactly one extra network round trip, made expensive by Docker Desktop's port forwarding on Windows. Kysely would not remove it. The client therefore replaced the criterion with what the design controls:

- **Exactly one extra statement per transaction**, counted at the PostgreSQL driver level (measured: 3 statements for a plain transaction, 4 for a tenant-scoped one).
- **Under 0.5 ms of database time** for the context statement (measured median 0.015 ms).
- A timing sanity check that the overhead is about one round trip (p50 overhead ≤ 1.5 × round-trip p50 + 0.5 ms).

Test `T-PERF-01` asserts all three. Production latency depends on the network distance to the managed database; re-measure on staging.

## Alternatives considered

Application filtering only (one missed filter leaks a school); schema per tenant and database per tenant (migrations and operations multiply with every school). See design §2.
