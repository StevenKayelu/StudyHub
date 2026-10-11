# StudyHub — Product, Architecture & Design Blueprint

StudyHub is a **new (greenfield), multi-tenant, white-label learning platform**. Schools, colleges, education businesses and independent tutors each run their own branded site, with their own instructors, learners, courses, quizzes and practice, settings, enabled features and payment account, and with strict data isolation. The platform owner provisions and governs tenants from a separate console.

There is **no existing codebase**. On 2026-10-11, `StudyPlatform/` was empty and `github.com/StevenKayelu/StudyHub` had no commits.

| # | Document | For |
|---|---|---|
| 01 | [Executive Assessment](01-executive-assessment.md) | decision makers |
| 02 | [Baseline Assessment (greenfield)](02-baseline-assessment.md) | what exists, what was checked, risks a new build must avoid |
| 03 | [Functional Requirements](03-functional-requirements.md) | realms and roles, features F01–F49, rules BR-01–BR-64, money-flow workflows W1–W8, acceptance criteria |
| 04 | [Target Architecture](04-target-architecture.md) | stack, modules, flows, security, operations; **§17 multi-tenancy** |
| 05 | [Database & API](05-database-and-api.md) | entities, constraints, state machines, API; **§8 tenancy model and API** |
| 06 | [UI/UX Blueprint](06-ui-ux-blueprint.md) | "Copperline" design system, screens, flows; **§10 white-label, tenant admin, console** |
| 07 | [Implementation Roadmap](07-implementation-roadmap.md) | milestones M0–M11, testing pyramid, delivery practices |
| 08 | [Open Questions & ADRs](08-open-questions-and-decisions.md) | Tier A/B/C decisions, assumptions, ADR-001–ADR-022 |
| 09 | [Master Implementation Handoff](09-master-implementation-handoff.md) | self-contained brief for ChatGPT to write implementation prompts |
| 10 | [Implementation Readiness](10-implementation-readiness.md) | final readiness review (6 checks), corrections log, decisions by milestone, prerequisites, **M1 goal, files, tests, acceptance criteria and local commands**, rework risks, payment-provider validation checklist |

## Labels used throughout

- **CONFIRMED**: the client stated it (see below).
- **VERIFIED**: checked directly by a tool.
- **ASSUMED**: a provisional decision so work can continue. It needs approval (08).
- **UNKNOWN**: needs a client, legal or provider answer.
- **PROPOSED**: a design recommendation from this blueprint. **No ADR or recommendation has been approved yet.**

## Client statements this blueprint is built on (CONFIRMED)

**First brief answers (2026-10-11):**
- A1 Primary users: students and tutors.
- A2 First-release capabilities: courses and materials; quizzes and practice.
- A3 Platform: responsive web app (mobile-friendly), with payments.
- A4 Hosting and scale: "not sure, recommend".

**Second brief (2026-10-11):**
- B1 Many independent schools, colleges, tutors and education businesses on the same platform, each customising branding, settings, content and enabled features.
- B2 Strict tenant data isolation.
- B3 Separate platform-owner and tenant-administrator permissions.
- B4 A professional, mobile-first learning platform with courses, materials, practice quizzes, payments and administration.

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-10-11 | Initial greenfield blueprint (single-marketplace model) |
| 2 | 2026-10-11 | Validated against the second brief; added multi-tenancy and white-label throughout; restructured decisions into tiers; fixed the roadmap arithmetic; added document 10 (corrections listed in 10 §2) |
| 3 | 2026-10-11 | Final readiness review: privileged-DB allowlist and webhook resolvers; tenant languages, domain, course and material, and capability-limited payment settings; money-flow workflows W1–W8 and commission terminology; settlement reconciliation and platform statements; provider approval gate; M1 split into a decision-free engineering foundation (milestones now M0–M11) (C-13–C-28 in 10 §2) |
