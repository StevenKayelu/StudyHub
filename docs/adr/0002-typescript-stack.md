# ADR-0002: TypeScript end-to-end stack

- **Status:** Accepted for implementation (client approved Milestone 1 on 2026-10-11)
- **Date:** 2026-10-11
- **Blueprint reference:** `docs/blueprint/04-target-architecture.md` §3; `08-open-questions-and-decisions.md` ADR-002

## Context

The developer's prior projects use Node.js, React and Prisma (VERIFIED in blueprint 02 §2). One language across web, API, worker and shared contracts lets validation schemas and error codes be shared instead of duplicated.

## Decision

| Concern                    | Choice and pinned version (M1)                                                     |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Runtime                    | Node.js 24 LTS (`.nvmrc`, `engines`)                                               |
| Package manager / monorepo | pnpm 12.11.2 (via `packageManager`), Turborepo 2.11.7                              |
| Language                   | TypeScript 6.0.3, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| API                        | NestJS 12.1.2 on the Fastify adapter (Fastify 5)                                   |
| Contracts and validation   | Zod 4 in `packages/contracts`; OpenAPI 3.1 generated from it                       |
| Web                        | Next.js 16.4 (App Router) + React 19                                               |
| Jobs                       | pg-boss (PostgreSQL-backed queue)                                                  |
| Logging                    | pino (JSON, redaction)                                                             |
| Tests                      | Vitest 5 (unit and integration), Testcontainers (PostgreSQL), Playwright (e2e)     |
| Quality                    | ESLint 10 + typescript-eslint, Prettier, dependency-cruiser, gitleaks              |

**Version notes.** The blueprint lists _minimum_ majors and says to pin the current stable versions at project start:

- **NestJS 12** is current stable; the blueprint minimum was 11.
- **TypeScript 6.0** is used instead of 7.0 (the current `latest`), because typescript-eslint 8.71 supports only `>=4.8.4 <6.1.0`. Revisit when typescript-eslint supports TypeScript 7.
- **Prisma 7.10** is the newest stable release; the `latest` npm tag pointed at a release candidate (8.0.0-rc.22) at project start, and release candidates are not used.

## Consequences

- Shared types and schemas between API and web; one toolchain to maintain.
- NestJS decorators need decorator metadata: the API is compiled with `tsc`, and Vitest uses SWC (`unplugin-swc`) so dependency injection works in tests.

## Alternatives considered

- Express (familiar, but leaves structure to discipline).
- Fastify without NestJS (lighter, but no declarative guards or module system).
- A Vite SPA instead of Next.js (simpler, but weak SEO; blueprint Q-PRD-5).

## Revisit when

typescript-eslint supports TypeScript 7; or a major version of any pinned tool reaches end of support.
