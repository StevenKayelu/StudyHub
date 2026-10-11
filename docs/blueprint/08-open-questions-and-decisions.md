# 08 — Open Questions and Architecture Decision Register

> **Revision 2 (2026-10-11).** Reorganised into three tiers and extended with tenancy decisions (Q-TEN-*). **Nothing in this register has been approved by the client.** The client has stated only: the four answers in the README (A1–A4), and the second brief's direction (multi-tenant, white-label, strict isolation, separate platform and tenant administration, professional and mobile-first; 03 §1 B1–B4). Every "recommended option" and "default" below is a proposal. Every ADR has status **Proposed**.

> **Revision 3 (2026-10-11).** Milestone 1 was split so it depends on **no** open business or architecture decision: M1 is now the engineering foundation, M2 the tenancy kernel, and all later milestones moved up by one (M0–M11). Added Q-REPO-1, Q-PAY-3, Q-BIZ-9 and Q-L10N-2. Still **nothing here is approved**.

**Tiers**
- **Tier A — Decide before the milestone named in "Needed by".** These shape the schema or infrastructure built from M2 (tenancy kernel) onward, or have long external lead times that would stall a near milestone. **M1 needs only Q-REPO-1.**
- **Tier B — Build with a safe, configurable provisional default.** The default is a setting, a plan value or an adapter, so changing it later costs configuration, not rework. Each still needs a real answer before the milestone named.
- **Tier C — Postpone to a later milestone or a post-launch phase.** The design leaves room; nothing in the first build depends on the answer.

## 1. Tier A — must be decided before implementation (M0)

| ID | Decision | Options | Recommended (not approved) | Why it can't wait | Needed by |
|---|---|---|---|---|---|
| Q-REPO-1 | **Where the code repository lives** on the development machine | (a) `C:\dev\StudyHub` (outside OneDrive), pushed to `github.com/StevenKayelu/StudyHub`. (b) Inside `StudyPlatform/` (OneDrive) | **(a)**: OneDrive sync of `node_modules`, build output and Docker data causes locks, conflicts and slow installs (10 §4.2). If (b) is chosen, pause OneDrive sync while developing | M1 creates the repository | **M1** |
| Q-PAY-3 | **Provider approval gate**: no payment provider is selected or integrated until its current capabilities are validated against the checklist in 10 §11 **and the client approves it in writing** | — | Evaluate 2–3 candidates in M0–M7; integrate only the approved one in M8 | Prevents building on unverified provider claims | Before M8 |
| Q-TEN-1 | **Identity model across tenants** | (a) Tenant-scoped accounts: the same email in two tenants means two accounts. (b) Global identity with per-tenant memberships | **(a)**: strictest isolation, per-tenant branding of every auth email, simple export and deletion per tenant (04 §17.5) | Changes the `user`, `session` and `role_assignment` schema and every auth flow, so it is shaped in M2 and built in M4 | M2 (kernel design); M4 (identity schema) |
| Q-TEN-3 | **Isolation strategy**, and whether any expected customer contractually requires a dedicated database or region | (a) Shared schema + RLS. (b) Schema per tenant. (c) Database per tenant | **(a)**, with "dedicated deployment" (04 §17.14) as the answer for any customer that requires (c) | Determines the DB roles, migrations and data-access layer built in M2 | M2 |
| Q-TEN-6 / Q-BRAND-1 | **Platform brand and domain** (is the platform called StudyHub? which domain?) | Register `<name>.<tld>` with wildcard DNS | Pick a short domain you control; wildcard `*.domain` via Cloudflare | Tenant hosts, cookies, certificates and staging all depend on it | M2 (staging) |
| Q-TEN-4 / Q-BIZ-1 / Q-PAY-1 | **How money flows** and **which payment aggregator** | (a) Each selling tenant connects **its own** merchant account (the platform never holds tenant money). (b) The platform collects for all tenants and settles to them. (c) Both | **(a)** for third-party tenants, plus the platform's own account for a platform-run marketplace tenant if Q-TEN-2 is yes. Shortlist 2–3 aggregators that support MTN, Airtel, Zamtel and cards in ZMW, with per-merchant API credentials, webhooks, status query and refunds | Option (b) may need payment-services authorisation and changes the ledger; merchant KYC has weeks of lead time | Decision: M0. Provider sandbox: M8 |
| Q-LEG-1 / Q-LEG-4 | **Jurisdiction and data-protection roles**: country (ASSUMED Zambia, Data Protection Act No. 3 of 2021, verify with counsel); whether the platform is a *processor* for tenants (the controllers); the platform–tenant agreement and data processing agreement; minimum learner age and consent; statutory retention | — | Platform = processor for tenant learner data and controller for platform staff and tenant-admin contact data; data processing agreement with every tenant; learners 16+ unless a tenant obtains guardian consent (counsel to confirm); 7-year financial retention | Legal lead time; consent texts are needed in M4 and contracts before the first external tenant | Start M0; consent M4; contracts M11 |
| Q-OPS-2 | **Hosting region and monthly budget ceiling** | South Africa region vs Western Europe | Run a 1-week latency test from MTN and Airtel connections; budget ≤US$150/month plus video (ASSUMED estimate, get quotes) | Staging is first deployed in M2 | M2 (staging) |

## 2. Tier B — proceed with configurable provisional defaults

All of these are implemented as **tenant settings, plan values, global settings or adapters**. The default is a recommendation only.

| ID | Decision | Provisional default | Where configured | Real answer needed by |
|---|---|---|---|---|
| Q-TEN-2 | Will the platform run its **own public marketplace tenant** for independent tutors? | Supported, not assumed: build instructor applications (F06) and revenue share (F29) as tenant features; decide before launch whether to operate one | Tenant + features | M11 |
| Q-BIZ-9 | **Platform revenue from tenants:** subscription only, a per-sale platform commission (billed monthly from recorded sales, since money goes to tenant accounts), or both | Plan-level subscription fee + `platformCommissionBps` per plan (default **0**); monthly platform statement per tenant (03 §9.5) | `plan` (console) | Before the first paying tenant (M11) |
| Q-L10N-2 | **Which UI languages to offer at launch**, and which tenants need which | Mechanism built (tenant `enabledLocales`, per-locale tenant texts); only English (`en`) catalog available at launch | Tenant settings + platform locale list | M3 (mechanism); translations Q-L10N-1 |
| Q-BIZ-8 | **Tenant pricing:** plans, limits, invoicing | 2–3 plans with limits (learners, instructors, storage, video minutes); manual invoicing outside the system | `plan` table (console) | Before the first paying tenant (M11) |
| Q-TEN-10 | Tenant provisioning: staff-provisioned or self-service sign-up; who activates | Staff-provisioned; operator activates after the onboarding checklist | Console workflow | M9 |
| Q-TEN-7 | Pilot tenants (who, when) | 1 school + 1 independent tutor in M11 | — | M10 |
| Q-TEN-8 | Learner access when a tenant is **suspended** | Read-only access to purchased content; no new sales or sign-ups (BR-52) | Global setting | M9 |
| Q-TEN-13 | SVG logos allowed? | No: PNG, JPEG or WebP only (SVG can carry scripts) | Upload allowlist | M9 |
| Q-BIZ-2 | Instructor commission, refund window, payout schedule (**per tenant**) | Instructor commission `instructorCommissionBps` 20% (only with `instructorRevenueShare`), refund window 7 days and ≤30% progress (guidance), monthly payouts, minimum K100 | Tenant settings | M8 |
| Q-BIZ-3 | Instructor admission and course review (**per tenant**) | `INVITE_ONLY`; first publication reviewed | Tenant settings | M5 |
| Q-BIZ-4 | Lifetime or time-limited access | Lifetime; optional `accessDays` per course | Course field | M6 |
| Q-BIZ-6 | Access after a course is unpublished | Enrolled learners keep access | Behaviour (BR-26) | M5 |
| Q-AUTH-2 | Can unverified users enrol in free courses? | Yes | Tenant setting | M4 |
| Q-CNT-1 | Video volume and protection | Managed video, signed playback, no DRM, downloads off; storage and minutes per plan | Plan limits, provider adapter | M5 (provider account) |
| Q-PAY-2 | Mobile-number prefixes and formats per network | MTN 096/076, Airtel 097/077, Zamtel 095/075 (**verify**) | Validation table in contracts | M8 |
| Q-LEG-2 | Legal page content | Templates per tenant; client and counsel supply the platform's own terms | Tenant settings | M11 |
| Q-LEG-3 | Tax lines on receipts (TPIN, VAT) | Optional per-tenant seller fields; no tax computation | Tenant settings | M8 |
| Q-PRIV-1 | Product analytics | Self-hosted, cookieless (Plausible or Umami), per tenant site, no ad trackers | Global setting | M10 |
| Q-PRIV-2 | Can instructors see learners' email addresses? | No, display names only | Tenant setting (later) | M6 |
| Q-ROLE-1 | Co-instructors per course | Not in the first release | — | M5 |
| Q-OPS-1 | Expected scale | 50 tenants, 20k accounts, 500 concurrent (NFR-CAP-2) | Load-test parameters | M10 |
| Q-OPS-3 | Team size and post-launch support | One developer; business-hours support | — | M0 (affects plan only) |
| Q-UX-1 | Usability participants (learners, instructors, school admins) | Recruit 5–8 learners, 3–5 instructors, 3 tenant admins | — | M7 |

## 3. Tier C — postpone (design leaves room)

| ID | Topic | Default until decided | Revisit |
|---|---|---|---|
| Q-TEN-5 | Custom tenant domains (Cloudflare for SaaS vs Caddy on-demand TLS) | Subdomains only; `tenant_domain` model ready | After launch (first tenant request) |
| Q-TEN-9 | Cross-tenant marketplace or search | None; strict isolation | Product phase 2 |
| Q-TEN-11 | Institutional SSO (SAML/OIDC), LTI | Email and password per tenant | When a college requires it |
| Q-TEN-12 | Per-tenant custom email sending domains | Platform mail domain, tenant display name and reply-to | After launch |
| Q-BIZ-5 | Subscriptions, bundles, coupons | One-time purchases | Phase 2 |
| Q-BIZ-7 | Multi-currency or multi-country tenants | ZMW only; `currency` columns exist | When a non-ZMW tenant appears |
| Q-AUTH-1 | Google sign-in, phone OTP | Off | Phase 2 |
| Q-OPS-4 | External penetration test budget | Recommended before the first external tenant | M10 |
| Q-PRD-1 | Certificates | Later | Phase 2 |
| Q-PRD-2 | Ratings and reviews | Later | Phase 2 |
| Q-PRD-3 | Flashcards and spaced repetition | Later | Phase 2 |
| Q-PRD-4 | Planner, groups, Q&A | Later | Phase 2 |
| Q-PRD-5 | Is catalogue SEO important? (Next.js vs SPA) | Yes → Next.js (ADR-004) | Only if the answer is a firm "no" before M3 |
| Q-PRD-6 | Real-time notifications | Polling | Phase 2 |
| Q-L10N-1 | Local-language UI | English; catalogs ready | Phase 2 |
| Q-ROLE-2 | Limited support role inside tenants | Superseded by platform support + support access (03 §3) | — |

## 4. Assumptions in force (until answered)

1. The market is Zambia: ZMW, `en-ZM`, `Africa/Lusaka`, mobile money is the dominant payment method (Q-LEG-1).
2. Learners mainly use mid or low-end Android phones on prepaid data.
3. Tenants that sell use their own merchant accounts (Q-TEN-4).
4. Accounts are tenant-scoped (Q-TEN-1).
5. One developer builds it; launch scale ≤50 tenants and 20k accounts (Q-OPS-1, Q-OPS-3).
6. Courses are self-paced; one course per order; quiz content is text, images and maths.
7. Tenants are provisioned by platform staff and invoiced manually (Q-TEN-10, Q-BIZ-8).

## 5. Architecture Decision Records (all **Proposed**)

Full ADRs go into `docs/adr/` in the code repository (Context → Decision → Consequences → Alternatives → Status).

| ADR | Decision | Rationale | Revisit when |
|---|---|---|---|
| ADR-001 | Modular monolith (web + api + worker) | One team; atomic cross-module transactions; minimal ops | A module needs independent scaling or a separate team |
| ADR-002 | TypeScript end-to-end (Node 24 LTS, NestJS/Fastify, Next.js, Zod contracts) | Team skills; shared validation | — |
| ADR-003 | PostgreSQL 17+, managed with PITR; Prisma + raw SQL constraints | Integrity features, **RLS**, search, JSONB | — |
| ADR-004 | Next.js web: SSR/ISR public pages, client app spaces, no DB access; **host-keyed caching** | SEO and first paint per tenant | Q-PRD-5 = no → SPA |
| ADR-005 | Server-side sessions in **host-only** `__Host-` cookies, bound to tenant | Revocable, XSS-resistant, tenant-bound | Native apps → bearer variant |
| ADR-006 | pg-boss + transactional outbox; tenant-aware job envelopes | No extra infra | Job lag > 1 min sustained |
| ADR-007 | Payment aggregator behind a `PaymentProvider` port; server-verified, idempotent, reconciled | Swappable provider | Provider performance or fees |
| ADR-008 | Direct-to-storage uploads (R2), worker scanning, signed URLs, `t/{tenantId}/` prefixes | API never streams files | — |
| ADR-009 | Managed video behind a `VideoProvider` port; per-tenant collections | No transcoding ops | Costs at scale |
| ADR-010 | Radix primitives + Tailwind tokens (Copperline) | Small bundles; own identity; themeable | — |
| ADR-011 | Single VM (Compose + Caddy, wildcard host) + managed DB + Cloudflare | Lowest cost at expected scale | Scale triggers (04 §13) |
| ADR-012 | Money as integer minor units + currency | No rounding errors | — |
| ADR-013 | Quiz attempt snapshots; server deadlines; answers withheld | Fairness and integrity | — |
| ADR-014 | REST `/api/v1` + OpenAPI 3.1 + RFC 9457 + cursor pagination | Simple, typed, client-agnostic | — |
| ADR-015 | *(revised)* Merchant-of-record and recorded payouts apply **only inside a platform-run marketplace tenant** (if Q-TEN-2 = yes); other tenants follow ADR-019 | Revision 1 assumed a single marketplace | Q-TEN-2, Q-TEN-4 |
| **ADR-016** | **Shared database + shared schema + `tenant_id` + forced RLS + composite tenant FKs + app-layer scoping**; dedicated deployments for exceptional customers | Strong isolation at the lowest ops cost | A customer requires physical isolation → dedicated deployment |
| **ADR-017** | **Two identity realms** (tenant and platform); **tenant-scoped accounts** | Separate platform and tenant permissions; strict isolation | Q-TEN-1 answered (b) |
| **ADR-018** | **Host-based tenant resolution** (subdomains now, custom domains later); trusted-proxy forwarding only | No client-controlled tenant selection; cookie isolation | Custom domains (Q-TEN-5) |
| **ADR-019** | **Tenant-owned payment accounts**, envelope-encrypted credentials, per-account webhooks and reconciliation | Platform never holds tenant money; failure isolation | Q-TEN-4 answered (b) or (c) |
| **ADR-020** | **Runtime theming by compiled tokens** with enforced contrast; structure not customisable | White-label without breaking accessibility or quality | — |
| **ADR-021** | **Feature modules = (plan or override) AND tenant toggle**; platform-level release flags kept separate | Per-tenant capability control without code forks | — |
| **ADR-022** | **Break-glass support access**: time-limited, tenant-approved (except owner emergency), dual-audited, with hard exclusions | Platform can help tenants without standing access to their data | — |

## 6. Client approval checklist

- [ ] Tier A answered: Q-REPO-1 (for M1), Q-PAY-3 gate acknowledged, Q-TEN-1, Q-TEN-3, Q-TEN-6/Q-BRAND-1, Q-TEN-4/Q-BIZ-1/Q-PAY-1, Q-LEG-1/Q-LEG-4 (started), Q-OPS-2
- [ ] Tier B defaults accepted as starting values (each can change later)
- [ ] Tier C postponements accepted
- [ ] ADR-001 to ADR-022 accepted or alternatives chosen
- [ ] First-release scope (03 §4, §9) and out-of-scope list (03 §6) accepted
