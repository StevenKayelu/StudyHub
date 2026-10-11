# ADR-0001: Modular monolith

- **Status:** Accepted for implementation (client approved Milestone 1 on 2026-10-11)
- **Date:** 2026-10-11
- **Blueprint reference:** `docs/blueprint/04-target-architecture.md` §2, §5; `08-open-questions-and-decisions.md` ADR-001

## Context

One developer with AI assistance (ASSUMED, Q-OPS-3) is building a platform where several business operations must be atomic across modules: a confirmed payment must create an enrolment, ledger entries and a receipt in one transaction. Expected launch scale is small (≤50 tenants, ≤20k accounts; ASSUMED).

## Decision

Build one TypeScript codebase with three processes: `web` (Next.js), `api` (NestJS on Fastify) and `worker` (the same API code, a different entry point). Inside the API, code is organised into **modules** (`apps/api/src/modules/<name>/`) with a single public surface (`index.ts`) and layers `api/ → application/ → domain/ → infra/`.

Boundaries are enforced mechanically by dependency-cruiser (`.dependency-cruiser.cjs`):

- no imports of another module except through its `index.ts`
- `domain/` code imports no framework (NestJS, Prisma, Fastify, pg, pg-boss)
- no circular dependencies
- the web app never imports the API
- shared packages never import apps

`pnpm boundaries` also proves the rules fire, using the deliberately broken files in `tools/boundary-fixtures`.

## Consequences

- One deployable unit to operate; cross-module transactions are plain database transactions.
- Discipline is enforced by CI rather than by network boundaries, so the boundary check is a required gate.
- A module can later be extracted into a service because it already has a single public surface.

## Alternatives considered

- **Microservices:** distributed transactions for payment → enrolment, many deployables and network failure modes, with no team-scaling need. Rejected.
- **Next.js only, with database access in route handlers:** fewest deployables, but weak module boundaries, and webhooks and workers fit poorly. Rejected as the primary design.
- **Backend-as-a-service:** business rules would be scattered across policies and functions, with lock-in. Rejected.

## Revisit when

A module needs independent scaling, or a second team owns part of the system.
