# ADR-0014: REST API conventions and error contract

- **Status:** Accepted for implementation (client approved Milestone 1 on 2026-10-11)
- **Date:** 2026-10-11
- **Blueprint reference:** `docs/blueprint/04-target-architecture.md` §9; `08-open-questions-and-decisions.md` ADR-014

## Context

The web app, a possible future mobile app and integrations need one predictable contract. Errors must be machine-readable and never leak internals.

## Decision

- JSON over HTTPS; `camelCase` fields.
- Business endpoints will live under `/api/v1` (from M2 onward).
- Operational probes `/healthz` and `/readyz` sit at the root.
- **Errors are RFC 9457 problem details** (`application/problem+json`). Each carries:
  - `type`: a URN, `urn:studyhub:problem:<code>`, independent of the undecided platform domain
  - `title` and `status`
  - a stable `code` from `packages/contracts/src/errors.ts`
  - `requestId`
  - optional `detail`
  - `errors[]` with `{field, code, message}` for validation failures
- Unexpected errors return `500 INTERNAL` with a generic message; stack traces go only to the logs.
- **Request ids:** a valid incoming `X-Request-Id` (8–128 characters from `[A-Za-z0-9._-]`) is reused; otherwise the API generates `req_<uuid>`. It is echoed in the `X-Request-Id` response header, included in every problem document and attached to every log line as `requestId`.
- **OpenAPI 3.1** is generated from the Zod contracts (`pnpm openapi` → `apps/api/openapi.json`).
- Later milestones add cursor pagination, `If-Match` optimistic locking, `Idempotency-Key` and money as `{amountMinor, currency}`, as specified in the blueprint.

## Consequences

- Clients handle every error the same way; support can trace any error by `requestId`.
- Error codes are part of the public contract and must never be renamed or reused.

## Alternatives considered

- GraphQL: flexible, but caching, error semantics and rate limiting are harder for a small team.
- Ad-hoc error bodies: rejected (inconsistent).

## Revisit when

A client needs a fundamentally different interaction model (e.g. real-time subscriptions).
