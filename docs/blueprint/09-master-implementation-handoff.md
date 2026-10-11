# 09 — Master Implementation Handoff (for ChatGPT) — Revision 2

**Purpose:** a self-contained brief from which ChatGPT writes the implementation prompts that direct Claude to build StudyHub. It condenses documents 01–08 and 10. Where more detail is needed, it names the section to attach (e.g. "05 §8").

**Revision 4 (2026-10-11):** the client approved D1-D6 (see 08 rev. 4): shared schema + forced RLS; no RLS-bypassing login role (NOLOGIN definer role + audited function inventory); one global account per person with per-school memberships; sign-in on the school host and switching by one-time hand-off; Prisma + RLS go/no-go at 3 ms p95.

**Revision 3 (2026-10-11):**
- Milestone 1 is now a **decision-free engineering foundation**; the tenancy kernel is M2; milestones run M0–M11.
- Added tenant languages, domain settings, course and material settings, and provider-capability-limited payment settings.
- Defined the money-flow workflows W1–W8 (03 §9.5).
- Added an exhaustive privileged-DB-client allowlist and webhook resolvers.
- Added a provider approval gate (Q-PAY-3).

**Revision 2:** StudyHub is **multi-tenant and white-label** per the client's second brief. Tenancy precedes every product feature.

**Instructions to ChatGPT:**
1. Write the implementation prompt **one milestone at a time** (§9). Attach this handoff's relevant sections and the referenced detail sections. Tell Claude to stop at that milestone's Definition of Done and report.
2. Keep the labels: **CONFIRMED** (client stated), **ASSUMED** (provisional; keep configurable), **UNKNOWN** (don't hard-code; use a setting or a TODO with the question id).
3. **Don't present any decision as approved by the client** unless 08 says so. As of revision 4, **Q-TEN-3 and Q-TEN-1 are answered** (CONFIRMED) and **ADR-016/017 are Accepted**; every other ADR is *Proposed*. M1 is complete (commit `4c52d4a`). The M2 prompt must cite D1, D2 and D5.
4. Include §12 ("Non-negotiable build rules") in **every** milestone prompt.

---

## 1. Product scope

**StudyHub** is a professional, mobile-first, multi-tenant learning platform (responsive web + installable PWA).
- **Tenants:** schools, colleges, education businesses and independent tutors. Each has its own branded site at `{slug}.<platform-domain>`, with its own learners, instructors, courses, quizzes, settings, enabled features, payment account and data. **Strictly isolated.**
- **Inside a tenant:** instructors build courses (sections → lessons: rich text, video, files, quizzes), question banks and quizzes. Learners enrol free or pay (mobile money or card), study with resume-exactly progress, take timed server-authoritative quizzes, and practise with instant feedback. Tenant owners and admins brand the site, configure features and policies, manage the team, courses, orders and refunds, and see reports, usage and audit logs.
- **Platform owner:** a separate console for tenants, plans, staff, global settings, provider health and aggregated metrics. **No standing access to tenant data**, only time-limited, tenant-approved, dual-audited support access.

**There is no existing system** (VERIFIED). Nothing to migrate or copy.

**Client statements (CONFIRMED):**
- A1–A4: students + tutors; courses & materials + quizzes & practice; responsive web with payments; hosting "recommend".
- B1–B4 (second brief): many independent schools, colleges, tutors and education businesses on one platform, customising branding, settings, content and features; strict tenant isolation; separate platform-owner and tenant-admin permissions; professional and mobile-first.

**Out of scope for the first release:** planner, groups, Q&A and messaging, native apps, subscriptions and coupons, certificates, ratings, live classes, cross-tenant marketplace or search, custom tenant domains (model ready, feature later), self-service tenant sign-up, automated tenant billing, SSO and LTI, platform-collected settlement for third-party tenants, per-tenant email domains, local-language UI.

## 2. Realms and roles (03 §3)

| Realm | Roles | Where |
|---|---|---|
| Platform | PLATFORM_OWNER, PLATFORM_OPERATOR, PLATFORM_SUPPORT (separate accounts, mandatory TOTP) | `console.<platform-domain>` only |
| Tenant | Visitor, LEARNER, INSTRUCTOR (label configurable), TENANT_ADMIN, TENANT_OWNER (≥1 per tenant) | the tenant's host only |

Authorization = **realm → tenant (from the host only) → role → ownership → entitlement**. Another tenant's resources always return **404**. Support sessions are a special tenant-host session tied to an active grant, with hard exclusions: no owner, payment-account or domain changes.

## 3. Features to deliver (03 §4 and §9; MUST unless marked)

| Area | Features |
|---|---|
| Identity | F01–F04 per tenant (register and verify, sessions, reset, account, deletion); F05 two-realm roles and policy layer |
| Instructors | F06 application (only in `APPLICATION` mode), F07 instructor page, F42 team, invitations and roles |
| Content | F08 per-tenant categories; F09 outline authoring; F10 lesson types; F11 uploads and video; F12 publish checklist + tenant review setting; F13 per-tenant catalogue (public or members-only), SSR |
| Learning | F14 enrolment and entitlements; F15 player, progress, resume; F16 My learning |
| Assessment | F17 question bank (6 types); F18 quiz builder; F19 attempt engine; F20 grading; F21 results; F22 practice (feature-gated); F23 analytics (SHOULD, gated) |
| Commerce | F24 pricing; F25 checkout (mobile money push, hosted card page); F26 webhooks, re-query, reconciliation; F27 receipts (per-tenant numbering); F28 refunds; F29 instructor ledger and payouts (only with `instructorRevenueShare`); **F45 tenant payment accounts** |
| Tenant admin | F30–F32 users, queues, reports, exports; F33 notifications; **F39 branding and white-label**; **F40 features and plans**; **F41 tenant settings**; **F46 export and offboarding**; **F47 usage and quotas**; **F48 branded communications**; **F49 separate audit logs** |
| Platform | **F37 tenant provisioning and lifecycle**; **F38 host resolution** (subdomains; custom domains later); **F43 console**; **F44 break-glass support access** |
| Legal | F36 per-tenant legal pages and consent capture |

## 4. Business rules that must be exact (03 §5, §9.3)

- **Payments:** BR-09 access only after server-side provider confirmation; BR-10/11 mismatch or duplicate → `NEEDS_REVIEW`; BR-07/08/35/36 order rules; BR-13 atomic refunds; BR-14/15 fees and earnings (tenant settings); **BR-54** paid courses need the tenant's active payment account; **BR-55** per-tenant receipt numbering.
- **Quizzes:** BR-16 one in-progress attempt; BR-18 server deadline + 30 s grace + auto-submit; BR-19 snapshots; BR-20 no answer leakage; BR-21 scoring formulas; BR-22 completion.
- **Content access:** BR-25/26 preview and locked content, unpublished courses.
- **Tenancy:**
  - BR-41 one tenant per record, no cross-tenant access.
  - **BR-42 tenant from the host only.**
  - BR-43 one global account per person + per-school memberships (CONFIRMED, D3); BR-65 to BR-71 sign-in, join, invitation, hand-off, revocation, privacy and wording rules.
  - BR-44 host-bound sessions.
  - BR-45/46 separate realms, no standing platform access.
  - BR-47 support-grant rules.
  - BR-48 feature evaluation.
  - BR-49 limits.
  - BR-50 slug rules.
  - **BR-51 enforced brand-colour contrast.**
  - BR-52 suspension behaviour.
  - BR-53 offboarding.
  - BR-56/57 onboarding and registration modes.
  - BR-58 last owner.
  - BR-59 per-tenant slugs.
  - BR-60 generic unknown-host page.

- **Money flows (03 §9.5, rev. 3):** W1 student payment → W2 instructor commission (`instructorCommissionBps`, tenant keeps it) → W3 instructor payout (recorded, paid outside StudyHub) → W4 refund (provider API if supported, else manual recorded) → W5 payment-status reconciliation → W6 ledger integrity → W7 provider settlement reconciliation (SHOULD) → W8 monthly platform statement (subscription + `platformCommissionBps`, default 0, invoiced outside). The platform never deducts money in transit (BR-63).
- **Tenant configuration (rev. 3):** languages (BR-61), domain page and subdomain requests (custom domains LATER), course and material defaults (BR-64), and payment settings limited to the provider's detected capabilities (BR-62).

## 5. Quality differentiators that must be visible

1. Mobile-money-native checkout with explicit approval status and recovery.
2. Focus-mode quizzes that survive connection drops and device switches.
3. Resume-exactly learning and data-saver mode.
4. Outline-first authoring with a live publish checklist.
5. Queue-first tenant admin.
6. **True white-label:** each tenant's site, PWA, emails and receipts carry only its brand (when `whiteLabel` is enabled), with accessibility guaranteed by the theme compiler.
7. **Provable isolation:** RLS coverage and cross-tenant suites in CI.
8. Append-only ledger with daily reconciliation.

## 6. Technology stack (04 §3; ADRs Proposed)

| Layer | Choice |
|---|---|
| Language and runtime | TypeScript strict; Node.js 24 LTS |
| Monorepo | pnpm workspaces + Turborepo: `apps/web`, `apps/api` (HTTP + worker), `packages/contracts`, `packages/ui`, `packages/config`, `infra/`, `docs/` |
| API | NestJS 11 on Fastify; Zod contracts → validation + OpenAPI 3.1; problem+json |
| Database | PostgreSQL 17+ (managed, PITR); Prisma + raw SQL migrations for RLS policies, partial uniques, CHECKs, triggers; DB roles `studyhub_migrator` (DDL), `studyhub_app` (NOBYPASSRLS, DML only), NOLOGIN `studyhub_rls_definer` (owns the SECURITY DEFINER inventory); **no RLS-bypassing login role** |
| Tenancy kernel | Host → `resolve_tenant()` (SECURITY DEFINER) → AsyncLocalStorage context → Prisma extension `set_config('app.tenant_id', …, true)` per transaction → forced RLS |
| Jobs | pg-boss + transactional outbox; every job payload carries `tenantId` |
| Web | Next.js App Router + React 19; middleware rewrite to `/_t/[host]` (host-keyed caches); TanStack Query; RHF + Zod; no DB access |
| UI | Radix primitives + Tailwind 4 with Copperline CSS-variable tokens; theme compiler (OKLCH, contrast-enforced) in `packages/ui`; Lucide; Tiptap; KaTeX; pdf.js (lazy) |
| Media | Cloudflare R2 (`t/{tenantId}/…` keys, presigned PUT/GET); ClamAV; managed video (Bunny Stream recommended) with per-tenant collections |
| Payments | Aggregator (TBD, Q-PAY-1) behind `PaymentProvider`; **per-tenant `payment_account`** with envelope-encrypted credentials; fake adapter |
| Email | Transactional API behind `Mailer`; tenant display name and reply-to; Mailpit locally |
| Infra | One VM: Docker Compose (Caddy with wildcard subdomain, web, api, worker, clamd); managed Postgres; Cloudflare; GitHub Actions; GHCR |
| Observability | pino, OpenTelemetry, Sentry or GlitchTip, uptime checks; `tenantId` on every log line and span |
| Testing | Vitest, Testcontainers, Fastify inject, fast-check, Playwright + axe, Lighthouse CI, k6 |

## 7. Architecture and module boundaries (04 §5, §17)

- **Modules:** `platform` (kernel), `tenancy`, `console`, `identity`, `profiles`, `catalog`, `media`, `learning`, `assessment`, `commerce` (incl. payment accounts), `ledger`, `notifications`, `admin` (tenant), `audit`, `settings`.
- **Layering inside each module:** `api/` → `application/` → `domain/` (pure) → `infra/`; `index.ts` is the only export.
- **CI-enforced rules:**
  - No cross-module table access.
  - Explicit `tx` for atomic cross-module work.
  - Outbox for async side effects.
  - Providers behind ports with fake adapters.
  - **Cross-tenant access only through the SECURITY DEFINER inventory in 04 §17.4**; there is no privileged DB client in application code.
  - Every tenant-owned table has RLS (coverage check).
- **Request flow:** Caddy overwrites `X-Forwarded-Host` → Next middleware rewrites by host → API trusts forwarded headers only from Caddy and web → tenant resolved → context → RLS. Unknown host → generic 404.
- **Key flows:**
  - Purchase: idempotent order → payment on the tenant's account → webhook to `/webhooks/payments/{provider}/{paymentAccountId}` verified with that account's secret → job re-queries provider → one transaction: paid + enrolment + ledger + receipt + outbox.
  - Quiz attempt: start with snapshot and deadline → autosave with `clientSeq` → submit or auto-submit.
  - Upload: presign → direct PUT → scan → READY.
  - Support access: request → tenant approval → one-time hand-off → support session with banner and dual audit.

## 8. Data model and API (05 §3–§8)

- **Global tables** (no RLS): `tenant`, `tenant_domain`, `plan`, `platform_user`, `platform_credential`, `platform_session`, `platform_audit_log`, `platform_setting`. **Global identity tables with self/member RLS (rev. 4):** `user_account`, `credential`, `one_time_token`, `tenant_handoff`. **Tenant-owned identity:** `tenant_membership`, `membership_role`, `session`, `invitation`.
- **Tenant-owned tables** (`tenant_id NOT NULL`, forced RLS, composite tenant FKs, tenant-leading indexes): every revision 1 entity, plus `tenant_branding` (+ versions), `tenant_setting`, `tenant_feature`, `invitation`, `payment_account` (with detected `capabilities`), `support_access_grant`, `tenant_usage_daily`, `tenant_export`, `domain_change_request`, `settlement_report`, `platform_statement` (rev. 3). Tenant-authored texts are stored per locale. `tenant_setting` keys are grouped as languages, learners and catalogue, instructors and review, course and material defaults, commerce (capability-limited) and legal (05 §8.2).
- **Must-have constraints:**
  - `unique(email)` on the global `user_account`; `unique(tenant_id, user_id)` on `tenant_membership`; `unique(tenant_id, slug)` for courses, categories, subjects and instructors.
  - Active-enrolment partial unique; one in-progress attempt partial unique; one pending payment per order.
  - `unique(payment_account_id, provider_event_id)`; `unique(payment_account_id, provider_transaction_id)`.
  - Ledger arithmetic CHECK and immutability trigger.
  - Per-tenant `receipt_sequence(tenant_id, year)`.
  - One active payment account per tenant.
  - Last-owner protection (application + test).
  - `storage_key` prefix CHECK.
  - Support-grant duration CHECK.
- **State machines:** tenant, tenant profile and instructor, course, enrolment, attempt, payment, order (05 §3, §8.1).
- **API:**
  - Tenant host: `/api/v1/...` (revision 1 inventory, 05 §4) + `/tenant` bootstrap + `/admin/branding|features|settings|team|invitations|payment-accounts|support-access|usage|exports/tenant|offboarding` (05 §8.3).
  - Console host: `/api/v1/console/...` (05 §8.4).
  - Conventions: camelCase, UUIDv7, cursor pagination, `If-Match`, `Idempotency-Key`, `{amountMinor, currency}`, RFC 9457 with stable codes (add `FEATURE_NOT_ENABLED`, `TENANT_CONTEXT_MISSING`, `TENANT_NOT_FOUND`, `LIMIT_REACHED`, `SLUG_TAKEN`, `SLUG_RESERVED`, `PAYMENT_METHOD_NOT_SUPPORTED`), `allowedActions`, `serverNow`.

## 9. Implementation phases (07; DoD per milestone; readiness in 10)

| Milestone | Scope | Depends on | Weeks |
|---|---|---|---|
| M0 | Q-REPO-1, Q-TEN-3; long-lead items started (provider evaluation, KYC, legal, domain); dev machine | — | 1 |
| **M1** | **Engineering foundation (decision-free):** monorepo, CI, API skeleton (config, logging, problem+json, health), Prisma pipeline with one global table, worker skeleton, contracts, Next skeleton, compose with Postgres, test harnesses | M0 (Q-REPO-1) | 1.5 |
| M2 | **Tenancy kernel:** DB roles + allowlist, tenant tables, host resolution, tenant context, RLS + coverage check, tenant-owned audit and outbox, job envelope, Next host middleware, Caddy `*.localhost`, seed of two tenants, staging (if decided), RLS benchmark | M1 + Q-TEN-3 | 1.5 |
| M3 | Copperline + **theme compiler**, per-tenant theme, manifest and icons, **i18n with tenant locales**, shells incl. console, system screens | M2 | 2 |
| M4 | Global accounts + per-school memberships, sign-in on the school host, join school, invitations, school switching by hand-off, revocation; platform realm auth; policy and authorization matrix; two audit logs | M2, M3 | 2 |
| M5 | Instructors, catalogue, authoring, uploads, video (+ webhook resolver), publishing; **course and material settings** | M4 | 2.5 |
| M6 | Enrolment, player, progress, signed media | M5 | 1.5 |
| M7 | Question bank, quizzes, attempts, grading, practice, analytics | M6 | 2.5 |
| M8 | Pricing, orders, **tenant payment accounts + capability model**, W1–W6 (payments, commission, payouts, refunds, reconciliation, ledger check) — real adapter only for an **approved** provider | M6 + Q-PAY-3 | 3 |
| M9 | Tenant admin (branding, features, settings, **languages, domain**, team, usage, **reconciliation W7, billing W8**, export, offboarding, support access) + **platform console** | M7, M8 | 3.5 |
| M10 | ASVS L2, **isolation review**, multi-tenant load, accessibility, restore drill incl. single-tenant restore | M9 | 2 |
| M11 | Production, monitoring, runbooks, pilot tenants | M10 | 1 |

Total ≈24 effort-weeks (range 20–28, ASSUMED). M7 and M8 are interchangeable.

## 10. Design system and screens (06)

- **Copperline** is the default theme and the fixed structure:
  - Warm paper canvas and slate ink; one accent used only for primary action, current position and progress.
  - Signature "line" motif: progress rail, current-lesson marker, quiz timer line, checkout steps.
  - Flat bordered surfaces.
  - Atkinson Hyperlegible Next + Literata; tabular numbers.
  - Tokens and verified contrast ratios in 06 §2.2.
  - Breakpoints <600 / 600–1023 / 1024–1439 / ≥1440; 44 px learner targets.
- **White-label (06 §10.1):**
  - Tenants change logos, accent (compiled and contrast-enforced), font preset (3 curated), home sections, terminology, footer, contacts and email sender.
  - They never change layout, components, semantic colours or the focus ring.
  - Tenant theme is served as an immutable versioned CSS file plus inline critical variables.
- **Spaces:** Public, Learn (bottom nav on compact), Studio (instructor), Tenant admin (queue-first + Organisation section), **Console** (separate host, fixed console theme with a blue accent, "Platform console" strip).
- **Screens:** S-P01–05, S-A01–05, S-L01–13, S-T01–12, S-AD01–18 (incl. onboarding checklist, branding editor with live preview, features, team, payment account, support access, usage, export and offboarding), S-C01–09 (console), S-X01–08 (incl. site not found, tenant unavailable, coming soon), plus the support-session banner.
- **Mandatory states** on every screen (06 §2.6). Flows in 06 §4. UX criteria UX-01–UX-17.

## 11. Security and quality requirements

- OWASP ASVS 4.0 L2.
- Argon2id, breached-password check, lockout, rate limits per IP, account **and tenant**.
- Host-only `__Host-` cookies bound to the tenant; separate console cookie and realm; TOTP mandatory for platform staff, and for tenant owners and admins before the first external tenant.
- CSP with nonces, HSTS, strict headers.
- Sanitised rich text; hardened uploads (allowlist, magic bytes, ClamAV, re-encode, private bucket, signed URLs, tenant prefix).
- Payments: hosted card page (SAQ-A), per-account webhook signatures, re-query, amount check, idempotency, reconciliation, per-account circuit breakers, **envelope-encrypted per-tenant credentials, never readable through the API**.
- **Isolation:** forced RLS on 100% of tenant tables; composite tenant FKs; tenant from host only; trusted-proxy header handling; host-keyed caches; tenant-aware jobs; platform DB client confined to console.
- Audit: tenant and platform audit logs; support actions in both.
- Privacy: per-tenant export and deletion, retention schedule (05 §6, §8.5), data processing agreements with tenants (Q-LEG-4), no ad trackers.
- NFRs: LCP ≤2.5 s (p75, Slow 4G, mid-range Android); learner JS ≤170 KB; API p95 ≤300/500 ms; 99.5% availability; RPO ≤5 min, RTO ≤4 h; WCAG 2.2 AA; NFR-ISO-1/2; NFR-CAP-2.

## 12. Non-negotiable build rules (include in every implementation prompt)

1. **Build from this specification, not from templates.** No generic LMS starters, admin templates or unmodified UI-kit themes (MUI, Bootstrap, default shadcn). Every component uses Copperline tokens and patterns.
2. **Don't copy code or visual design from the developer's other projects** (e.g. the Quora "Study Desk" design).
3. **No business logic in controllers or React components.** Prices, scores, permissions, transitions, fees, feature evaluation and contrast rules are computed in domain and application code (and the shared theme compiler).
4. **Never trust the client** for access, payment state, quiz timing **or tenant identity**. The tenant comes only from the verified host.
5. **Every tenant-owned table ships, in the same migration, with** `tenant_id`, forced RLS policy, composite tenant FKs and tenant-leading indexes. The RLS coverage check must pass.
6. **No application code may bypass RLS.** There is no RLS-bypassing login role; cross-tenant work goes only through the SECURITY DEFINER inventory in 04 §17.4 (each function reviewed, fixed `search_path`, minimal columns, CI-checked). Never read tenant personal data in the console without an active support grant.
7. **Money is integers** in minor units with a currency.
8. **Cross-module writes are one transaction**; side effects go through the outbox; job payloads carry `tenantId`.
9. **Every endpoint is in the authorization matrix and the cross-tenant suite** before merge.
10. **Providers behind ports with fake adapters**; the app runs fully without third parties in dev and CI. **No real payment credentials** in code, seeds or CI.
11. **ASSUMED values are settings or plan values in one place**; UNKNOWN items get a TODO with their question id.
12. **Every screen implements loading, empty, error, permission-denied and offline states** and passes axe in the default theme **and** in a sample tenant theme.
13. **Stop at each milestone's Definition of Done** for review.
14. **Report honestly:** skipped tests, failing checks, deviations and assumptions in each milestone summary.
15. **Never select, integrate or configure a real payment provider** until its current capabilities have been validated against 10 §11 **and the client has approved it in writing** (Q-PAY-3). Until then only the fake adapter exists.
16. **The browser is never a security boundary.** No tenant filtering, permission decision or price calculation may rely on frontend code.

## 13. Testing and acceptance

- Pyramid and gates: 07 §3–§4. Isolation verification: 04 §17.13.
- Acceptance = all MUST ACs in 03 §4 and §9 pass as automated tests + UX-01–UX-17 (usability items by moderated tests) + NFRs.
- Write the high-risk suites first in their milestones:
  - RLS coverage and SQL isolation (M2)
  - Host and session binding (M4)
  - Cross-tenant API suite (from M4, extended every milestone)
  - Theme contrast property test (M3)
  - Payment state machine and webhook idempotency + per-account signature confusion (M8)
  - Refund atomicity (M8)
  - Quiz scoring table, answer leakage and attempt concurrency (M7)
  - Upload security (M5)
  - Console data-exposure test (M9)

## 14. Open decisions and assumptions (08)

**Tier A (decide before the milestone named in 08 §1; recommendations are not approvals):**
- Q-REPO-1 repository location [recommend `C:\dev\StudyHub`] — **the only input M1 needs**
- Q-PAY-3 provider approval gate: no real provider until capabilities are validated (10 §11) and the client approves
- ~~Q-TEN-1 identity model~~ **CONFIRMED (D3):** global account + per-school memberships
- ~~Q-TEN-3 isolation~~ **CONFIRMED (D1, D2, D5):** shared schema + forced RLS; no RLS-bypassing login role; 3 ms p95 go/no-go
- Q-TEN-6 platform brand and domain
- Q-TEN-4/Q-BIZ-1/Q-PAY-1 money flow and aggregator [recommend tenant-owned merchant accounts]
- Q-LEG-1/Q-LEG-4 jurisdiction and data-protection roles [recommend platform = processor; counsel to confirm]
- Q-OPS-2 region and budget

**Tier B defaults:** instructor commission 20% (revenue-share tenants only), platform commission 0% + subscription (Q-BIZ-9), only `en` language enabled (Q-L10N-2), refund 7 days, order expiry 30 min, `INVITE_ONLY` instructors, first publish reviewed, `OPEN` registration, `PUBLIC` catalogue, lifetime access, staff-provisioned tenants, manual invoicing, suspended tenants → read-only purchased content, no SVG logos, ZMW only.

**Assumptions in force:** Zambia/ZMW/`en-ZM`/`Africa/Lusaka`; Android-first learners on prepaid data; ≤50 tenants and 20k accounts at launch; one developer; self-paced courses; one course per order.

## 15. First implementation prompt

The complete M1 brief is in **10 §6** (goal, scope, prerequisites), **10 §7** (exact files and modules), **10 §8** (tests, acceptance criteria and local commands). Use the prompt in 10 §10.
