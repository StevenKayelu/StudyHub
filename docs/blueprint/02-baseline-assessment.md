# 02 — Baseline Assessment (Greenfield)

The brief asked for an audit of an existing system. This section records what was actually checked, why no code audit was possible, and what replaces it.

## 1. What was inspected

| Check | Result | Status |
|---|---|---|
| `C:\Users\Staff\OneDrive\Documents\StudyPlatform` (recursive, including hidden files) | 0 files, 0 subfolders. Not an OneDrive cloud-placeholder problem: the folder is genuinely empty | VERIFIED |
| `https://github.com/StevenKayelu/StudyHub` | Public; created 2026-10-11 06:38 UTC; size 0; no branches; cloning gives "cloned an empty repository" | VERIFIED |
| Client confirmation | "There is actually no code yet. You are starting from scratch." | CONFIRMED |

**Consequence:** Phases 3 (code-quality audit) and the "existing implementation location" fields in Phase 4 of the brief do not apply. No file or symbol references exist. Nothing in this blueprint claims to describe existing behaviour.

## 2. Inventory: what exists instead

| Item | Description |
|---|---|
| Product intent | Client answers (README) |
| Team capability evidence | Dependencies in the developer's other local projects (VERIFIED by reading their `package.json` files): Express 4, Prisma 5, Zod, bcrypt/JWT, multer, S3 SDK, React 18, MUI 5/6, TanStack Query 5, react-pdf, Tiptap. One project uses MySQL; others use Prisma (database not checked). |
| Market context | ASSUMED: Zambia. The developer's other projects use ZMW, `Africa/Lusaka` and mobile money. This must be confirmed (Q-LEG-1). |
| Related prior work | A separate blueprint for a different product ("Quora System", a tutorial-centre portal) exists in the same Documents folder. StudyHub is a **different product**. It deliberately uses a different design direction (Copperline, not "Study Desk") so the two products are not visually confusable. Whether internal code is reused is the developer's call, but no requirement depends on it. |

## 3. Risks a new build of this type commonly hits

These are not findings about existing code (there is none). They are the failure modes that course and assessment marketplaces typically suffer, so the architecture addresses each one explicitly.

| # | Risk | Typical consequence | Where addressed |
|---|---|---|---|
| R-01 | Unlocking content from the payment *redirect* instead of a server-verified confirmation | Free access by faking a success URL; disputes | BR-09, 04 §7.2 |
| R-02 | Webhooks processed twice or out of order | Double enrolment, double tutor earnings | `payment_event` unique key, idempotent state machine (05 §3.6) |
| R-03 | Money stored as floating point | Rounding errors in ledgers | Integer minor units (ngwee), ADR-012 |
| R-04 | Quiz timer kept in the browser; answers shipped to the client | Trivial cheating; unfair results | Server deadline, answers withheld (BR-18, BR-20) |
| R-05 | Editing a question changes historical scores | Disputed grades | Per-attempt question snapshots (BR-19, ADR-013) |
| R-06 | Large files streamed through the API server | Memory exhaustion, slow API, high egress | Direct-to-storage presigned uploads, CDN, managed video |
| R-07 | Authorization checks only on role, not ownership | Tutor A edits tutor B's course (IDOR) | Policy layer with resource ownership checks, authorization test matrix (04 §8) |
| R-08 | Media URLs that never expire | Paid content shared publicly | Short-lived signed URLs after entitlement check |
| R-09 | Backups on the same host as the database | Total data loss | Managed Postgres with PITR + off-site dumps, quarterly restore drill |
| R-10 | Heavy UI frameworks on low-end phones | Slow first load, bounce | Performance budgets (06 §9), server rendering, data-saver mode |
| R-11 | Unbounded lists and N+1 queries in catalogue and reports | Slow pages as data grows | Cursor pagination, indexes in 05, query review in CI |
| R-12 | Secrets in repo or logs | Credential leak | Env-only secrets, log redaction, secret scanning in CI |

## 4. What should be "kept, improved, replaced"

No existing system means nothing to keep or replace. From the team-capability evidence:

| Familiar technology | Recommendation | Why |
|---|---|---|
| Express | **Replace with NestJS (on Fastify)** | Enforced module boundaries, declarative guards for authorization, built-in OpenAPI. Express leaves structure to discipline, which is risky for AI-assisted code at this size |
| Prisma | **Keep** | Known, readable schema, solid migrations |
| Zod | **Keep and expand**: shared contract package between API and web | One source of truth for validation |
| React + TanStack Query | **Keep** | Proven; Query covers server state well |
| MUI | **Replace with Radix primitives + Tailwind tokens** | Smaller bundles on low-end phones, and a visual identity that doesn't look like default Material (06 §2) |
| JWT in local storage (common pattern) | **Replace with server-side sessions in httpOnly cookies** | Revocable, not exposed to XSS, simpler for a same-origin web app (ADR-005) |
| MySQL (one project) | **Use PostgreSQL** | Transactional DDL, partial unique indexes, CHECK and exclusion constraints, built-in full-text search (ADR-003) |

## 5. Limitations of this baseline

- No business rules could be extracted from code. All rules in 03 come from client answers (CONFIRMED) or are ASSUMED.
- No real traffic, catalogue or video data, so capacity figures in 04 are estimates.
- No payment provider has been selected, so the integration details in 04 and 05 are written against a generic aggregator contract and must be checked against the chosen provider's documentation.
