# 01 — Executive Assessment

> **Revision 4 (2026-10-11): client-approved tenancy decisions D1-D6** (`docs/design/m2-tenancy-kernel.md` in the code repository). D1 shared schema + forced RLS (dedicated deployments as the exception path); D2 no RLS-bypassing login role (NOLOGIN `studyhub_rls_definer` owns an audited inventory of SECURITY DEFINER functions); D3 one global account per person with explicit per-school memberships and roles; D4 sign-in on the school host, school switching by one-time hand-off, neutral account wording; D5 Prisma + RLS go/no-go (D5 revised by the client after measurement: exactly one extra statement per transaction and <0.5 ms database time); D6 these amendments. D7 (legal controller role) remains open.
>
> **Revision 3 (2026-10-11):** M1 split into a decision-free engineering foundation (M1) and the tenancy kernel (M2); money-flow workflows, tenant languages, domain, course and material, and payment-capability settings added; provider approval gate (Q-PAY-3).
>
> **Revision 2 (2026-10-11):** updated for the client's second brief. StudyHub is a **multi-tenant, white-label** platform for many schools, colleges, tutors and education businesses (03 §9, 04 §17).

## 1. What the product does

StudyHub is a professional, mobile-first learning platform that many education organisations share. Each organisation is a **tenant** with its own branded site, learners, instructors, courses, settings, enabled features and payment account.

- **Tenant owners and admins** (a school's or business's staff) brand their site, choose features and policies, invite instructors, review courses, handle orders and refunds, and read reports.
- **Instructors** (called Tutor, Teacher or Lecturer as each tenant prefers) build courses: sections and lessons with rich text, video, files and quizzes. They write question banks, grade long answers and follow learner progress.
- **Learners** browse their tenant's catalogue, enrol free or pay by mobile money or card, study with resume-exactly progress, take timed quizzes and practise with instant feedback.
- **The platform owner** provisions and governs tenants, plans and global settings from a separate console. Platform staff have **no standing access** to tenant data; they need time-limited, tenant-approved and audited support access.

## 2. Current maturity

There is **no existing system** (VERIFIED: an empty folder and an empty GitHub repository on 2026-10-11). This blueprint is the only artefact. Tenancy was missing from revision 1 (VERIFIED: 0 mentions) and has been added throughout.

## 3. Strengths and risks of the starting position

| Strengths | Risks |
|---|---|
| Clean slate: tenancy can be built into the foundations instead of retrofitted | Cross-tenant data leaks would be catastrophic for trust, so isolation needs defence in depth and dedicated tests |
| Tight functional scope (courses, materials, quizzes, practice, payments, admin) | Payments per tenant need each selling tenant to have a merchant account (KYC lead time) |
| Team knows TypeScript, React and Prisma (02 §2) | Legal roles (platform as processor, tenants as controllers) need counsel |
| PWA avoids app-store overhead | Solo developer: the tenancy, payments and quiz engine together make ≈24 effort-weeks |

## 4. Key design decisions (all Proposed; see 08 §5)

1. **Modular monolith in TypeScript**: web (Next.js), API (NestJS/Fastify) and worker from one codebase (ADR-001/002).
2. **Shared-schema multi-tenancy with forced PostgreSQL row-level security**, composite tenant foreign keys, host-based tenant resolution and host-only sessions (ADR-016/018/005).
3. **Two identity realms**: one global learner/staff account per person with **per-school memberships and roles** (CONFIRMED, D3), and separate platform staff accounts (console, mandatory 2FA), plus **break-glass support access** (ADR-017/022).
4. **Tenant-owned payment accounts**, so the platform never holds tenant money. Server-verified, idempotent and reconciled per account (ADR-019/007).
5. **Server-authoritative quiz engine** with per-attempt snapshots (ADR-013).
6. **Media outside the API**: object storage with tenant prefixes, managed video, signed URLs (ADR-008/009).
7. **Copperline design system with runtime white-label theming**: tenants change logo, accent, font preset and terminology, and the compiler enforces WCAG contrast. Layout and quality stay fixed (ADR-020).
8. **Feature modules per tenant** = plan entitlement AND tenant toggle (ADR-021).

## 5. Recommended direction

| Area | Recommendation |
|---|---|
| Architecture | Modular monolith; tenancy kernel in M2, immediately after the decision-free engineering foundation (M1) |
| Data | PostgreSQL 17+ (managed, PITR), RLS on every tenant table, Prisma with a tenant-context extension, pg-boss |
| Payments | Aggregator supporting MTN, Airtel, Zamtel and cards in ZMW, behind a port; credentials per tenant |
| Media | Cloudflare R2 + managed video (e.g. Bunny Stream) with per-tenant collections |
| Hosting at launch | One VM (Caddy with a wildcard subdomain, web, api, worker, ClamAV) + managed Postgres + Cloudflare; ≈US$60–150/month before video (ASSUMED estimate, get quotes) |
| Growth path | Resize → more app VMs → read replica → Redis/BullMQ and a search engine only when metrics require; dedicated deployments for customers needing physical isolation |

## 6. Decisions needed before implementation (Tier A, 08 §1)

- ~~Identity model across tenants (Q-TEN-1)~~ CONFIRMED: global account + per-school memberships (D3)
- ~~Isolation strategy (Q-TEN-3)~~ CONFIRMED: shared schema + forced RLS (D1); dedicated deployments only for contractual exceptions
- Platform brand and domain (Q-TEN-6)
- Money flow and payment aggregator (Q-TEN-4, Q-PAY-1)
- Jurisdiction and data-protection roles (Q-LEG-1, Q-LEG-4)
- Hosting region and budget (Q-OPS-2)

## 7. Delivery outlook

Twelve milestones (M0–M11), ≈**24 effort-weeks** (range 20–28) for one experienced developer with AI assistance (ASSUMED). The first implementation milestone is **M1: Engineering foundation**. It depends on no open business or architecture decision. The tenancy kernel follows as M2 once Q-TEN-3 is answered (10 §6).
