# 10 — Implementation Readiness (revision 3, 2026-10-11)

This document closes the planning phase. It records:
1. The final readiness review against the six checks the client requested.
2. Every correction made to the blueprint.
3. The decisions still open, and which milestone each blocks.
4. Development prerequisites.
5. The milestone sequence.
6. The complete specification of Milestone 1: goal, scope, prerequisites, files, tests, acceptance criteria, local commands.
7. Rework risks.
8. How to begin.
9. The payment-provider validation checklist.

**Nothing here is approved unless marked CONFIRMED.** No application code has been written, no credentials configured and nothing deployed.

> **Status update (revision 4, 2026-10-11):** M1 is complete and committed locally (`4c52d4a`, not pushed). The client approved D1-D6 for M2 (shared schema + forced RLS, no RLS-bypassing login role, global accounts with per-school memberships, school-host sign-in with hand-off switching, go/no-go: D5 revised by the client after measurement: exactly one extra statement per transaction and <0.5 ms database time, these amendments). M2 implementation has **not** started and needs explicit approval. Staging remains pending until hosting provider, region, budget and domain are approved.

---

## 1. Final readiness review (revision 3)

Each check was verified against the documents on disk. "Before" is the state after revision 2; "After" is the state after the revision 3 fixes.

### Check 1 — Isolation enforced on the server, in DB access, jobs, storage, caching and APIs (not frontend filtering)

| Layer | Evidence | Before | After |
|---|---|---|---|
| API / server | Tenant from the verified host only (BR-42, 04 §17.2); policies return 404 across tenants (04 §17.6); authorization matrix + cross-tenant API suite for every endpoint (04 §17.13) | ✔ | ✔ |
| Database access | Forced RLS on every tenant table, fail-closed with no context, composite tenant FKs, tenant-scoped unique keys, RLS coverage check in CI (04 §17.4, 05 §8.2) | ⚠ The RLS-bypassing client was allowed for "named system jobs" that were **never named**; payment webhooks used it | ✔ **Exhaustive allowlist** (console, 11 named system jobs that only select ids and then work in tenant context, CLI); webhooks use narrow SECURITY DEFINER resolvers instead (04 §17.4) |
| Background jobs | Envelope requires `tenantId`; handler runs in that tenant's context; sweeps process each item in a separate tenant transaction (04 §17.11) | ✔ | ✔ |
| File storage | `t/{tenantId}/` prefix with a DB CHECK; signed URLs only for assets visible under RLS; per-tenant counters and limits (04 §17.9, 05 §8.2) | ⚠ Video webhooks had **no tenant routing** | ✔ `resolve_video_asset()` → tenant context (04 §17.9, 05 §8.3) |
| Caching | Next.js host rewrite `/_t/[host]` so ISR and fetch caches are keyed per tenant; in-process keys `t:{tenantId}:…`; CDN keyed by host (04 §6, §17.11) | ✔ | ✔ |
| Frontend | Web tier has no DB access and only displays API results | ⚠ Implicit only | ✔ Explicit rule: the browser is never a security boundary (04 §17.9; 09 rule 16) |

**Verdict: PASS after fixes.**

### Check 2 — Separate platform and tenant authentication, permissions and admin areas; exceptional access controlled

| Item | Evidence | Status |
|---|---|---|
| Separate authentication | Platform realm: own tables, `console.` host, `__Host-sh_console` cookie, mandatory TOTP; tenant realm per tenant host (04 §17.5, 05 §8.1) | ✔ |
| Separate permissions | Platform roles OWNER, OPERATOR, SUPPORT vs tenant roles OWNER, ADMIN, INSTRUCTOR, LEARNER; neither realm can enter the other (03 §3, BR-45) | ✔ |
| Separate admin areas | Console S-C01–S-C09 vs tenant admin S-AD01–S-AD21; visually distinct console theme (06 §10.3) | ✔ |
| Exceptional access | Tenant approval (or platform-owner emergency with immediate notice), reason, scope, ≤24 h with a DB CHECK, expiry enforced on the next request, dual audit, banner, hard exclusions (03 F44, BR-47, 04 §17.12, 05 `support_access_grant`) | ✔ |
| Console session policy | — | ⚠ Lifetimes unspecified → ✔ fixed: idle 30 min, absolute 12 h, TOTP re-authentication for lifecycle, plan, staff and emergency actions (04 §17.5) |

**Verdict: PASS after fix.**

### Check 3 — Tenant configuration of branding, languages, domain, features, course and material settings, and payment settings

| Setting | Before | After |
|---|---|---|
| Branding | ✔ F39, S-AD12, theme compiler | ✔ Text fields now per language |
| **Supported languages** | ✗ Only one `locale` field; no per-tenant language choice | ✔ `defaultLocale` + `enabledLocales` from the platform's shipped languages (only English at launch, Q-L10N-2); per-locale tenant texts; learner switcher; fallback rule (F41, BR-61, 04 §17.8, 05 §8.2–8.3, 06 S-AD09) |
| **Domain settings** | ⚠ Console-only; no tenant-facing page or API | ✔ Domain page S-AD19, subdomain change requests approved in the console; custom-domain API specified now, behind the LATER `customDomain` feature (F38, 05 §8.3–8.4) |
| Enabled features | ✔ F40, S-AD13 | ✔ |
| **Course and material settings** | ⚠ Only "course review required" and default access were per tenant | ✔ Upload types and sizes (within plan and platform caps), downloads default, video completion threshold, quiz defaults, practice defaults (F41, BR-64) |
| **Payment settings where the provider supports them** | ⚠ No capability model; nothing tied settings to provider support | ✔ Adapter capability model; the connection test records actual capabilities; only supported methods and refund modes can be enabled, with defined fallbacks (F41, BR-62, 04 §17.10, 05 `payment_account.capabilities`, 06 S-AD09) |

**Verdict: was PARTIAL; PASS after fixes.**

### Check 4 — Payments, payouts, commissions, refunds and reconciliation workflows; no unapproved provider

| Item | Before | After |
|---|---|---|
| Student payments | ✔ F25/F26, 04 §7.1 | ✔ W1 |
| Instructor payouts | ✔ Recorded manual payouts (F29) | ✔ W3, incl. negative balance after a refund of paid-out earnings |
| **Commissions** | ⚠ "Platform fee" actually meant the *tenant's* cut of instructor sales; the **platform's** revenue from tenants was undefined | ✔ Renamed **instructor commission** (`instructorCommissionBps`, ledger `commission_minor`); new **platform commission** (`plan.platformCommissionBps`, default 0) invoiced monthly via `platform_statement` and never deducted in transit (BR-63, W2, W8, Q-BIZ-9) |
| Refunds | ✔ F28 | ✔ W4 with provider-API or manual mode by capability |
| **Reconciliation** | ⚠ Payment-status and internal ledger checks only; no reconciliation against the provider's settlement records | ✔ W5 status, W6 ledger, **W7 provider settlement reconciliation** (list API or CSV import), `settlement_report`, S-AD20 |
| No unapproved provider | ✔ Provider unselected (Q-PAY-1) | ✔ Strengthened: **approval gate Q-PAY-3**, validation checklist (§11), build rule 15; only the fake adapter until approval |

**Verdict: was PARTIAL; PASS after fixes.**

### Check 5 — Schema, API, requirements, UI/UX and roadmap agree

Inconsistencies found and fixed:
1. Fee naming differed across 03, 05, 06 and 08.
2. Milestone references were inconsistent after the M1 split; all docs renumbered and the remaining M1 and M2 mentions checked by hand.
3. The payment webhook route in 05 §4.8 is superseded by the per-account route (stated in 05 §8.3).
4. 04's module table called `console` "the only module" allowed the privileged client, contradicting the system jobs.
5. The onboarding checklist screen (S-AD11) had no endpoint; `GET /admin/onboarding` added.
6. Revision-3 entities and endpoints were added to 05, 06 screens, 07 milestones and 09.

Cross-reference check: every Q-/ADR- id resolves in 08; F01–F49 and BR-01–BR-64 are defined once in 03; every screen id referenced is defined in 06. All of this was checked by script on 2026-10-11.

Known, accepted wording debt: revision-1 sections of 03 §4 and 05 §3–§4 still say "Admin" and show pre-tenancy keys. The revision notes at the top of each document and 03 §9.2 / 05 §8 govern their reading.

**Verdict: PASS after fixes.**

### Check 6 — First milestone is small, testable and independent of unresolved critical decisions

Before: M1 (2.5 weeks) contained the tenancy kernel, so it depended on **Q-TEN-3**, and its staging step depended on **Q-TEN-6 and Q-OPS-2**. All three are unanswered. After: **M1 = Engineering foundation** (1.5 weeks, no tenancy, no users, no features, no deployment). It needs only Q-REPO-1 (where the repository lives). The tenancy kernel is M2. **Verdict: PASS after restructuring.**

---

## 2. Corrections log

### Revision 2 (multi-tenancy)

| # | Correction |
|---|---|
| C-01 | 03: second-brief traceability (B1–B4); multi-tenant purpose; two-realm roles |
| C-02 | 03 §9: F37–F49, BR-41–BR-60, the F01–F36 change table, NFR-ISO-1/2, NFR-CAP-2 |
| C-03 | 03 §6: tenancy out-of-scope items |
| C-04 | 04 §17 multi-tenancy architecture; drivers, same-origin, modules, rendering and sessions updated |
| C-05 | 05 §8 tenancy model and API |
| C-06 | 05: tenant-scoped keys (emails, slugs, receipts, payment events) |
| C-07 | 06: Copperline as default theme; §10 white-label, tenant admin and console screens |
| C-08 | 06: console accent corrected (info blue, not "slate") |
| C-09 | 07: tenancy in every milestone; arithmetic fix (stated 18 vs actual 19 weeks) |
| C-10 | 08: Tier A/B/C; Q-TEN-*; ADR-015 revised; ADR-016–022 |
| C-11 | 01, 09 rewritten |
| C-12 | README: document 10, revision log |

### Revision 3 (this review)

| # | Correction | Where |
|---|---|---|
| C-13 | **M1 split**: M1 Engineering foundation (decision-free), M2 Tenancy kernel; milestones renumbered M0–M11; 24 effort-weeks (range 20–28) | 01, 03, 04, 07, 08, 09, 10 |
| C-14 | Exhaustive privileged-client allowlist; SECURITY DEFINER resolvers; payment webhooks no longer use the privileged client | 04 §17.4, §17.10; 09 rule 6 |
| C-15 | Video webhook tenant routing | 04 §17.9; 05 §8.3 |
| C-16 | Tenant languages | 03 F41, BR-61; 04 §17.8; 05 §8.2–8.3; 06 S-AD09, S-AD12, switcher; 08 Q-L10N-2 |
| C-17 | Tenant domain settings and subdomain change requests; custom-domain API specified for later | 03 F38; 05 `domain_change_request`, §8.3–8.4; 06 S-AD19 |
| C-18 | Course and material settings | 03 F41, BR-64; 04 §17.8; 05 `tenant_setting`; 06 S-AD09 |
| C-19 | Payment settings limited by provider capabilities | 03 F41, BR-62; 04 §17.10; 05 `payment_account.capabilities`; 06 S-AD09 |
| C-20 | Money-flow workflows W1–W8; instructor vs platform commission; ledger column `commission_minor` | 03 §9.5, BR-14, BR-63; 05 §3.7, `plan.pricing`; 06 S-T07; 08 Q-BIZ-2, Q-BIZ-9 |
| C-21 | Provider settlement reconciliation and platform statements | 05 `settlement_report`, `platform_statement`, endpoints; 06 S-AD20, S-AD21 |
| C-22 | Provider approval gate and validation checklist | 08 Q-PAY-3; 04 §17.10; 09 rule 15; §11 below |
| C-23 | Console session lifetimes and re-authentication | 04 §17.5 |
| C-24 | Single-tenant restore runbook (tested in M10) | 04 §17.16; 07 M10 |
| C-25 | Browser is never a security boundary | 04 §17.9; 09 rule 16 |
| C-26 | Repository location decision (OneDrive risk) | 08 Q-REPO-1 |
| C-27 | Missing endpoint for the onboarding checklist | 05 §8.3 |
| C-28 | New error codes (`TENANT_NOT_FOUND`, `PAYMENT_METHOD_NOT_SUPPORTED`) | 09 §8 |

---

## 3. Decisions: what blocks which milestone

Full register: 08. **Recommendations are not approvals.**

| Decision | Recommended option | Blocks |
|---|---|---|
| **Q-REPO-1** Repository location | `C:\dev\StudyHub`, outside OneDrive | **M1** (the only input M1 needs) |
| **Q-TEN-3** Isolation strategy | **CONFIRMED (D1, D2, D5):** shared schema + forced RLS; no RLS-bypassing login role; go/no-go: D5 revised by the client after measurement: exactly one extra statement per transaction and <0.5 ms database time | **M2** (answered) |
| Q-TEN-6 / Q-BRAND-1 Platform name and domain | Short domain with wildcard DNS | End of M2 (staging); local work unaffected |
| Q-OPS-2 Hosting region and budget | Latency test SA vs EU; ≤US$150/month + video (estimate) | End of M2 (staging) |
| Q-TEN-1 Identity model | **CONFIRMED (D3, D4):** global account + per-school memberships; school-host sign-in; hand-off switching | M4 (answered) |
| Q-TEN-4 / Q-BIZ-1 / Q-PAY-1 / **Q-PAY-3** Money flow, provider shortlist, approval | Tenant-owned merchant accounts; validate 2–3 candidates (§11); approve one | M8 (start evaluation and KYC now) |
| Q-LEG-1 / Q-LEG-4 Jurisdiction and data-protection roles | Platform = processor; data processing agreement per tenant; learners 16+ unless guardian consent (counsel) | M4 (consent texts); M11 (contracts); start now |

Tier B items use configurable defaults; Tier C items are postponed (08 §2–§3).

---

## 4. Development environment and prerequisites

### 4.1 Machine state (VERIFIED 2026-10-11)

| Item | Found | Action |
|---|---|---|
| OS / hardware | Windows 11 Pro, 8 logical CPUs, 15.8 GB RAM | Sufficient |
| Git | 2.55.0 | ✔ |
| Node.js | 24.18.0 | ✔ (Node 24 LTS) |
| npm / corepack | 11.16.0 / 0.35.0 | `corepack enable` provides pnpm |
| pnpm | **not installed** | Provided by corepack (version pinned in `packageManager`) |
| Docker | 29.8.0 installed; **engine not running** at check time | Start Docker Desktop |
| WSL | 2.7.14 (docker-desktop distro only) | No action; apps run natively |
| VS Code | 1.141.0 | Extensions: ESLint, Prettier, Prisma, Playwright, Docker |
| GitHub CLI | **not installed** | Optional (`winget install GitHub.cli`) |

### 4.2 Repository location (Q-REPO-1)
Recommended: `C:\dev\StudyHub`, cloned from `github.com/StevenKayelu/StudyHub` (currently empty). Syncing `node_modules`, build output and Docker data through OneDrive causes file locks, sync conflicts and slow installs. If the code must live in `StudyPlatform/`, pause OneDrive sync while developing. The planning copy of the blueprint stays in `StudyPlatform/blueprint/`; M1 copies it to `docs/blueprint/`.

### 4.3 Accounts and credentials
**M1 needs none** beyond your existing GitHub account (to push and let GitHub Actions run CI; pushing isn't a deployment). Local database passwords are throwaway development values in an uncommitted `.env`. **No payment, video, email, cloud or domain credentials are needed or allowed in M1.**

---

## 5. Milestone sequence

| # | Milestone | Depends on | Weeks |
|---|---|---|---|
| M0 | Decisions and setup | — | 1 |
| **M1** | **Engineering foundation** | Q-REPO-1 | 1.5 |
| M2 | Tenancy kernel | M1 + Q-TEN-3 | 1.5 |
| M3 | Design system, theming, i18n, shells | M2 | 2 |
| M4 | Identity realms and access | M2, M3 | 2 |
| M5 | Instructors, catalogue, authoring | M4 | 2.5 |
| M6 | Learning experience | M5 | 1.5 |
| M7 | Assessment engine | M6 | 2.5 |
| M8 | Commerce, payment accounts, ledger (W1–W6) | M6 + approved provider for the real adapter | 3 |
| M9 | Tenant admin, white-label, console (W7, W8) | M7, M8 | 3.5 |
| M10 | Hardening and isolation verification | M9 | 2 |
| M11 | Launch and handover | M10 | 1 |
| | **Total** | | **24** (20–28) |

Acceptance criteria for M2–M11: 07 §2.

---

## 6. Milestone 1 — goal, scope and prerequisites

**Goal (exact):** create a buildable, testable, CI-verified TypeScript monorepo for StudyHub: an API process, a worker process and a web app skeleton sharing a contracts package, a migration pipeline against PostgreSQL 17, and the test harnesses and quality gates every later milestone will use. It contains **no tenancy, no users or authentication, no product features, no design system and no deployment.**

**In scope:**
1. Monorepo tooling: pnpm workspaces, Turborepo, strict TypeScript presets, ESLint, Prettier, dependency-cruiser module-boundary rules, gitleaks, EditorConfig, LF line endings.
2. `packages/contracts`: stable error-code list, RFC 9457 problem schema (Zod), health and readiness schemas, OpenAPI 3.1 generation.
3. `apps/api` (NestJS on the Fastify adapter):
   - Zod-validated environment config that fails fast.
   - pino JSON logging with redaction, request-id propagation, a global problem+json error filter.
   - `GET /healthz` and `GET /readyz` (DB check).
   - Prisma client service.
4. Database: Docker Compose Postgres 17 with **two** roles (`studyhub_migrator`, `studyhub_app`). The first migration creates one **global** table `platform_setting` and grants the app role DML only. The third, RLS-bypassing role arrives in M2.
5. Worker entry (`src/worker.ts`) with pg-boss, a typed job envelope (Zod) and a no-op `system.heartbeat` job.
6. `apps/web` (Next.js App Router): a minimal root layout and a **system status page** that server-fetches the API's readiness through a development rewrite of `/api/*`.
7. Test harnesses: Vitest (unit), Vitest + Testcontainers (integration), Playwright (e2e smoke).
8. GitHub Actions CI running every gate on push and PR.
9. Documentation: blueprint copy, ADR template + ADR-001, 002, 003, 014, README, local-development runbook.

**Out of scope:** tenants, RLS, host resolution, Caddy, MinIO, Mailpit, users, sessions, any UI design, any course, quiz or payment code, Dockerfiles for deployment, staging or production deployment, real credentials of any kind.

**Prerequisites:**
- Q-REPO-1 answered.
- Docker Desktop running.
- Node 24 (installed).
- `corepack enable` run.
- Git (installed).
- ~5 GB free disk.
- Internet access for package and browser downloads.

---

## 7. Milestone 1 — files and modules to create

Paths are relative to the repository root. If a tool's conventions force a different name, the implementer must report the deviation.

```
StudyHub/
├─ .editorconfig
├─ .gitattributes                         # * text=auto eol=lf
├─ .gitignore                             # node_modules, .next, dist, coverage, .turbo, playwright-report, .env* (except .env.example)
├─ .nvmrc                                 # 24
├─ .npmrc                                 # engine-strict=true
├─ .env.example                           # all variables with local-only placeholder values
├─ .gitleaks.toml
├─ .dependency-cruiser.cjs                # rules: cross-module imports only via modules/*/index.ts;
│                                         #        modules/*/domain/** may not import @nestjs/*, @prisma/*, fastify, pg-boss;
│                                         #        apps/web may not import apps/api
├─ eslint.config.mjs
├─ prettier.config.mjs
├─ package.json                           # "packageManager": "pnpm@<pinned>", engines node 24;
│                                         # scripts: dev, build, lint, typecheck, boundaries, test, test:int, test:e2e,
│                                         #          db:up, db:down, db:migrate, openapi, verify
├─ pnpm-workspace.yaml
├─ turbo.json
├─ README.md                              # purpose, prerequisites, 15-minute setup, scripts, troubleshooting
├─ .github/
│  ├─ pull_request_template.md
│  └─ workflows/ci.yml                    # install → lint → typecheck → boundaries (+ violation meta-check) → unit →
│                                         # integration (Testcontainers) → build → e2e smoke → openapi → gitleaks → audit
├─ docs/
│  ├─ blueprint/                          # copy of README + 01–10
│  ├─ adr/0000-template.md
│  ├─ adr/0001-modular-monolith.md
│  ├─ adr/0002-typescript-stack.md
│  ├─ adr/0003-postgresql.md
│  ├─ adr/0014-rest-api-conventions.md
│  └─ runbooks/local-development.md
├─ infra/
│  ├─ compose/docker-compose.dev.yml      # postgres:17 only, healthcheck, named volume, port 5432
│  └─ postgres/init/01-roles.sql          # studyhub_migrator (owner), studyhub_app (NOBYPASSRLS, DML only)
├─ tools/
│  └─ boundary-fixtures/                  # deliberately violating files used only by the boundaries meta-check (excluded from build)
├─ packages/
│  ├─ config/
│  │  ├─ package.json
│  │  ├─ tsconfig.base.json               # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
│  │  ├─ tsconfig.node.json
│  │  ├─ tsconfig.next.json
│  │  └─ eslint/index.mjs
│  └─ contracts/
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ src/index.ts
│     ├─ src/errors.ts                    # VALIDATION_FAILED, NOT_FOUND, INTERNAL, SERVICE_UNAVAILABLE, RATE_LIMITED (+ reserved list from 09 §8)
│     ├─ src/problem.ts                   # RFC 9457 schema incl. code, requestId, errors[]
│     ├─ src/problem.test.ts
│     ├─ src/health.ts                    # Healthz / Readyz response schemas
│     └─ scripts/generate-openapi.ts      # writes apps/api/openapi.json
├─ apps/
│  ├─ api/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ vitest.config.ts
│  │  ├─ vitest.integration.config.ts
│  │  ├─ prisma/schema.prisma             # PlatformSetting(key PK, value Json, updatedAt)
│  │  ├─ prisma/migrations/0001_init/migration.sql   # platform_setting + GRANTs for studyhub_app
│  │  ├─ src/main.ts                      # Nest + Fastify, problem filter, request-id hook, graceful shutdown
│  │  ├─ src/worker.ts                    # pg-boss start, register system.heartbeat, graceful shutdown
│  │  ├─ src/app.module.ts
│  │  ├─ src/modules/platform/
│  │  │  ├─ index.ts
│  │  │  ├─ platform.module.ts
│  │  │  ├─ config/env.schema.ts
│  │  │  ├─ config/env.schema.test.ts
│  │  │  ├─ config/config.service.ts
│  │  │  ├─ logging/logger.ts             # pino; redact password, token, authorization, cookie, set-cookie, msisdn
│  │  │  ├─ logging/logger.test.ts
│  │  │  ├─ logging/request-id.hook.ts
│  │  │  ├─ errors/app-error.ts
│  │  │  ├─ errors/problem.filter.ts
│  │  │  ├─ db/prisma.service.ts
│  │  │  ├─ health/health.controller.ts
│  │  │  ├─ jobs/boss.ts
│  │  │  ├─ jobs/job-envelope.ts          # Zod {type, payload, requestId}; tenantId is added and made required in M2
│  │  │  └─ jobs/heartbeat.job.ts
│  │  └─ test/
│  │     ├─ setup/postgres-container.ts   # Postgres 17 + roles + migrations
│  │     ├─ integration/migrations.int.test.ts
│  │     ├─ integration/health.int.test.ts
│  │     ├─ integration/problem-json.int.test.ts
│  │     └─ integration/worker-heartbeat.int.test.ts
│  └─ web/
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ next.config.ts                   # dev rewrite /api/* → API; output standalone
│     ├─ playwright.config.ts
│     ├─ src/lib/server-api.ts            # typed server-side fetch of /readyz using contracts
│     ├─ src/app/layout.tsx
│     ├─ src/app/page.tsx                 # "StudyHub — system status": API status, DB status, version
│     └─ tests/e2e/status.spec.ts
```

**Modules created:** `packages/config`, `packages/contracts`, `apps/api` → `modules/platform` (config, logging, errors, db, health, jobs), `apps/web`. No other API modules exist until M2.

---

## 8. Milestone 1 — automated tests, acceptance criteria and local commands

### 8.1 Automated tests

| Test | Type | Proves |
|---|---|---|
| `contracts/src/problem.test.ts` | Unit | Problem schema accepts valid documents and rejects missing `code` or `requestId` |
| `platform/config/env.schema.test.ts` | Unit | Missing or invalid env vars produce a clear startup error naming the variable |
| `platform/logging/logger.test.ts` | Unit | Values under `password`, `token`, `authorization`, `cookie`, `set-cookie`, `msisdn` never appear in output |
| `integration/migrations.int.test.ts` | Integration | Migrations apply to an empty Postgres 17; `studyhub_app` can read and write `platform_setting` but **can't** `CREATE TABLE` or `DROP` |
| `integration/health.int.test.ts` | Integration | `/healthz` 200; `/readyz` 200 with DB; `/readyz` 503 problem+json `SERVICE_UNAVAILABLE` after the container stops; responses match contract schemas |
| `integration/problem-json.int.test.ts` | Integration | Unknown route → 404 problem+json with `NOT_FOUND` and `requestId`; a demo validation failure → 422 `VALIDATION_FAILED` with `errors[]`; unexpected exception → 500 `INTERNAL` without a stack trace in the body; `X-Request-Id` echoed |
| `integration/worker-heartbeat.int.test.ts` | Integration | Enqueued `system.heartbeat` is processed; a malformed envelope is rejected and not retried forever |
| Boundaries meta-check (CI step) | Static | dependency-cruiser passes on the real code and **fails** on `tools/boundary-fixtures` |
| `web/tests/e2e/status.spec.ts` | E2E (Playwright, Chromium) | The status page shows "API: ok" and "Database: ok" with the stack up |

### 8.2 Acceptance criteria (exact)

1. On a clean machine meeting §6 prerequisites, the README setup reaches a running stack in ≤15 minutes.
2. `pnpm verify` passes locally, and the same gates pass in GitHub Actions on a PR.
3. All tests in §8.1 pass; none are skipped without a written reason.
4. `/healthz` and `/readyz` behave as specified, and their responses validate against `packages/contracts`.
5. Every error response is problem+json with a stable `code` and a `requestId`; no stack traces leak.
6. Logs are JSON with a `requestId`; the redaction test passes.
7. The API and worker refuse to start with invalid config, with a clear message.
8. The app DB role can't run DDL (proved by test).
9. Boundary rules are enforced, and the meta-check proves violations are detected.
10. `pnpm openapi` produces a valid OpenAPI 3.1 document that includes the health endpoints.
11. gitleaks reports nothing; `pnpm audit --audit-level high` passes, or each exception is documented.
12. ADR-001, 002, 003 and 014 exist in `docs/adr`; the blueprint is in `docs/blueprint`.
13. The repository contains **no** tenancy, user, auth, course, quiz or payment code, **no** real credentials, and **nothing was deployed**.
14. The final report lists files created, test results, deviations from §7 and open questions.

### 8.3 Commands to run and verify M1 locally (PowerShell, from `C:\dev\StudyHub`)

```powershell
corepack enable
pnpm install
Copy-Item .env.example .env
pnpm db:up
pnpm db:migrate
pnpm exec playwright install chromium
pnpm dev
```

`pnpm dev` starts the API on :4000, the worker, and the web app on :3000. Then, in a second terminal:

```powershell
curl.exe -s http://localhost:4000/healthz
curl.exe -s http://localhost:4000/readyz
Start-Process http://localhost:3000
pnpm verify
pnpm db:down
```

`pnpm verify` runs lint, typecheck, boundaries, unit, integration, e2e, build, openapi and gitleaks in sequence. Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm test:int`, `pnpm test:e2e`, `pnpm build`, `pnpm openapi`.

---

## 9. Risks that could cause expensive architectural rework

| # | Risk | Prevention |
|---|---|---|
| RW-01 | Adding tenancy after features exist | Tenancy kernel is M2, before any feature |
| RW-02 | Wrong identity model (Q-TEN-1) | **Decided (D3): global accounts + memberships**; global identity tables protected by self/member RLS |
| RW-03 | Prisma + RLS underperforms or misbehaves | M2 benchmark and go/no-go; Kysely fallback for the data layer |
| RW-04 | Money flow changes to platform-collected | Decide in M0 with legal input; BR-63 keeps platform revenue as invoices |
| RW-05 | Caches keyed by path only | Host rewrite + cache-isolation e2e in M2 |
| RW-06 | Jobs without tenant context | Envelope requires `tenantId` from M2; sweeps work per tenant |
| RW-07 | Customer demands a dedicated database or in-country hosting | Answer Q-TEN-3 early; dedicated deployments, no per-tenant DB routing |
| RW-08 | Global uniqueness assumptions | Tenant-scoped keys fixed in 05 §8.2 before the first tenant table |
| RW-09 | Free-form tenant CSS | Token-only theming with enforced contrast |
| RW-10 | Custom domains with an incompatible CDN setup | `tenant_domain` model and resolver from M2; choose the TLS option before offering the feature |
| RW-11 | Web framework reversal | Confirm Q-PRD-5 before M3 |
| RW-12 | Developing inside OneDrive | Q-REPO-1 |
| RW-13 | AI-implemented milestones drift from the spec | Milestone-sized prompts, DoD stop points, CI gates, honest reports |
| RW-14 | **Building payments around one provider's assumptions** | Capability model + fake adapter covering all combinations; approval gate Q-PAY-3 |
| RW-15 | **Languages retrofitted** after single-language texts are stored | Per-locale storage for tenant texts from the first tenant-text table (M3) |
| RW-16 | **Commission semantics changed late** | Instructor vs platform commission separated now (BR-63) |
| RW-17 | **Privileged DB access spreading** | No RLS-bypassing login role (D2); SECURITY DEFINER inventory checked in CI from M2 |

---

## 10. How to begin M1 (after you approve)

1. Answer **Q-REPO-1** (recommended: `C:\dev\StudyHub`).
2. Start Docker Desktop.
3. Run in PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\dev | Out-Null; git clone https://github.com/StevenKayelu/StudyHub.git C:\dev\StudyHub; Set-Location C:\dev\StudyHub; corepack enable; claude
```

4. Give Claude this prompt (or have ChatGPT expand it from 09):

> Implement **Milestone 1 — Engineering foundation** for StudyHub. The specification is in `C:\Users\Staff\OneDrive\Documents\StudyPlatform\blueprint\`; read `10-implementation-readiness.md` §6–§8 first, then `09-master-implementation-handoff.md` §6, §7 and §12, and `04-target-architecture.md` §3, §5, §9 and §15. Copy the blueprint folder into `docs/blueprint/`. Create exactly the files in 10 §7, make every test in 10 §8.1 and every criterion in 10 §8.2 pass, and make the commands in 10 §8.3 work on Windows PowerShell. Don't implement tenancy, users, authentication, UI design or any product feature. Don't add real credentials or deploy anything. Stop when M1's acceptance criteria are met, and report files created, test results, deviations and open questions.

---

## 11. Payment-provider validation checklist (Q-PAY-3)

Each candidate is assessed against its **current** documentation and a sandbox trial, recorded in a short evaluation note, and **approved by the client in writing** before any integration code is written.

| # | Capability or condition | Required? |
|---|---|---|
| 1 | Licensed or authorised to process payments in the target country (Zambia, ASSUMED); acceptable terms for education businesses | Required |
| 2 | Mobile-money collection with a push prompt for the networks needed (MTN, Airtel, Zamtel), in ZMW | Required |
| 3 | Card payments via a hosted page or redirect (PCI scope SAQ-A), 3-D Secure | Required |
| 4 | **Per-merchant API credentials**, so each tenant connects its own account (ADR-019) | Required |
| 5 | Signed webhooks, with a documented scheme, retries and event ids | Required |
| 6 | Transaction status query API | Required |
| 7 | Refund API (full; partial is optional) | Preferred (manual fallback exists) |
| 8 | Transaction list or settlement report API, or a downloadable CSV statement | Preferred (W7) |
| 9 | Disbursement or payout API | Optional (W3 is manual by default) |
| 10 | Sandbox that simulates success, failure, timeout and late callbacks | Required |
| 11 | Fees, settlement times and payout schedule to merchants, in writing | Required |
| 12 | Merchant KYC requirements and lead time (for tenants and the platform) | Required |
| 13 | Uptime or SLA history, status page, support channel | Preferred |
| 14 | Data protection: where data is processed; a data processing agreement is available | Required |
| 15 | A small real-money test in production mode before pilot launch (M11) | Required |
