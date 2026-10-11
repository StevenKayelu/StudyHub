# ADR-0003: PostgreSQL as the single system of record

- **Status:** Accepted for implementation (client approved Milestone 1 on 2026-10-11)
- **Date:** 2026-10-11
- **Blueprint reference:** `docs/blueprint/04-target-architecture.md` §3, §15, §17.4; `08-open-questions-and-decisions.md` ADR-003

## Context

Business rules must be enforced by the database, not only by application code: one active enrolment, one in-progress quiz attempt, payment idempotency, an immutable ledger, and (from M2) tenant isolation through row-level security. Migrations must be safe to re-run and fail atomically.

## Decision

- **PostgreSQL 17** (`postgres:17` locally; a managed service with point-in-time recovery later).
- **Prisma 7** for the schema, the typed client (with the `pg` driver adapter) and migrations (`prisma migrate deploy`). Constraints Prisma can't express (partial unique indexes, CHECKs, RLS policies, triggers) are written as SQL inside the migration files.
- **Least-privilege roles** (`infra/postgres/init/01-roles.sql`):
  - `studyhub_migrator` owns the database and the `public` schema and runs migrations.
  - `studyhub_app` is used at runtime, with DML only. An integration test proves it can't create or drop tables.
  - A third, RLS-bypassing role arrives in M2 with the tenancy kernel.
- **Job queue in the same database** (pg-boss). Its schema and queues are created by the migrator during `pnpm db:migrate`; the worker connects as `studyhub_app`.

## Consequences

- Transactional DDL: a failed migration rolls back completely.
- Migrations and queue installation run as an explicit step (`pnpm db:migrate`), never implicitly at application start.

## Alternatives considered

- MySQL 8.4: weaker constraint support (no partial unique indexes or RLS).
- Drizzle or Kysely instead of Prisma: lighter and closer to SQL; kept as the fallback if Prisma + RLS underperforms (blueprint RW-03).

## Revisit when

The M2 RLS benchmark shows unacceptable overhead (then reconsider the data-access library); or read load requires replicas.
