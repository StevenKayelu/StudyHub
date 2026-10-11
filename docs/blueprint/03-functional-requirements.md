# 03 — Functional Requirements Specification

Labels: **CONFIRMED** (client), **ASSUMED** (provisional, see 08), **UNKNOWN**, **PROPOSED**.
Priority: **MUST** (first release), **SHOULD** (first release if time allows, otherwise next), **LATER** (out of first release).

Greenfield note: the brief's "existing implementation location" field is not applicable for every feature. Each feature instead lists its **source**: the client answer or assumption it traces to.

> **Revision 4 (2026-10-11): client-approved tenancy decisions D1-D6** (`docs/design/m2-tenancy-kernel.md` in the code repository). D1 shared schema + forced RLS (dedicated deployments as the exception path); D2 no RLS-bypassing login role (NOLOGIN `studyhub_rls_definer` owns an audited inventory of SECURITY DEFINER functions); D3 one global account per person with explicit per-school memberships and roles; D4 sign-in on the school host, school switching by one-time hand-off, neutral account wording; D5 Prisma + RLS go/no-go (D5 revised by the client after measurement: exactly one extra statement per transaction and <0.5 ms database time); D6 these amendments. D7 (legal controller role) remains open.
>
> **Revision 3 (2026-10-11):** F38 tenant-facing domain settings; F41 languages, course and material settings, and provider-dependent payment settings; BR-61–BR-64; **§9.5 money-flow workflows W1–W8** (student payment, instructor commission, payouts, refunds, reconciliation, platform commission). The fee previously called "platform fee" is now **instructor commission** (`instructorCommissionBps`).
>
> **Revision 2 (2026-10-11): multi-tenancy.** The client's second brief says the platform must serve **many independent schools, colleges, tutors and education businesses**, each with its own branding, settings, content and enabled features, with **strict tenant data isolation** and **separate platform-owner and tenant-administrator permissions**. Revision 1 had no tenancy at all (VERIFIED: 0 mentions). §3 (roles) has been rewritten, and **§9 adds the tenancy features F37–F49, the rules BR-41–BR-60, and a table showing how F01–F36 change under tenancy. Where §4 says "admin" or "platform setting", read it through §9.2.** The specific tenancy mechanics are recommendations (ASSUMED / PROPOSED) until the decisions in 08 §1 are made.

---

## 1. Traceability to client answers

| Client answer (CONFIRMED, 2026-10-11) | Features it produces |
|---|---|
| A1 Users are students + tutors | F01–F07 (identity, tutor onboarding), F30–F35 (an operator must run the platform: ASSUMED admin role) |
| A2 Courses & materials | F08–F16 |
| A2 Quizzes & practice | F17–F23 |
| A3 Responsive web, with payments | F24–F29, NFR-PERF, NFR-PWA |
| A4 Hosting: recommend | 04 §11 |
| Not selected: planner, groups/Q&A, native apps | Excluded; see §6 |
| B1 (second brief) Many independent schools, colleges, tutors and education businesses on one platform, each customising branding, settings, content and enabled features | F37–F43, F45–F49 (§9) |
| B2 (second brief) Strict tenant data isolation | BR-41–BR-46, BR-60, NFR-ISO-1, 04 §17 |
| B3 (second brief) Separate platform-owner and tenant-administrator permissions | §3, F43, F44, BR-45–BR-47 |
| B4 (second brief) Professional, mobile-first platform with courses, materials, practice quizzes, payments, administration | Matches F08–F36 (no change) |

## 2. Product purpose

A **multi-tenant, white-label learning platform**. Each **tenant** (a school, college, education business or independent tutor) runs its own branded learning site, with its own courses, assessments, learners, instructors, settings and payment account. Learners access courses free or by payment, primarily on mobile phones. The **platform owner** provisions and governs tenants but doesn't see inside their data by default.

The open marketplace from revision 1 (independent tutors applying to sell under the StudyHub brand) still works: it becomes **one tenant** run by the platform owner. Whether to operate it is a decision (Q-TEN-2), not a confirmed requirement.

## 3. User roles and permissions

There are **two separate realms**, and an account belongs to exactly one of them (B3; realm separation CONFIRMED in D3, ADR-017):

**Platform realm.** Platform-owner staff only. They sign in at a dedicated console host (e.g. `console.<platform-domain>`) with separate accounts and mandatory 2FA. Platform accounts can't sign in on tenant sites.

| Role | Can | Cannot | Source |
|---|---|---|---|
| **Platform owner** | Everything in the console: manage platform staff, plans, global settings and the full tenant lifecycle; see platform-wide usage and health; emergency support access (BR-47) | Read tenant learner data, content or finances outside an active support-access grant | B3 |
| **Platform operator** | Provision, activate, suspend and offboard tenants; assign plans and feature overrides; see tenant metadata and usage; request support access | Manage platform staff, plans or global settings; emergency access | PROPOSED |
| **Platform support** | Read tenant metadata, plan, status, usage and health; request support access (needs tenant approval) | Change tenants; emergency access | PROPOSED (replaces revision 1's Q-ROLE-2) |

**Tenant realm.** Everything below is scoped to **one tenant** and its host. A person has **one global account** (email, password, 2FA) and an explicit **membership** in each school they belong to, with roles per school (CONFIRMED, D3; BR-43, BR-65 to BR-71). A school sees only its own members and never a member's other schools.

| Role | Who | Can | Cannot | Source |
|---|---|---|---|---|
| **Visitor** | Not signed in on the tenant's site | Browse the tenant catalogue (if public), course pages, preview lessons, instructor pages; register (if the tenant allows) | Enrol, buy, take quizzes | A1, A3 |
| **Learner** | Default role of every tenant account | Enrol, buy, study, take quizzes, practise, see own results and receipts, manage account | See other learners' data; access unenrolled non-preview content; anything in another tenant | A1 |
| **Instructor** (UI label configurable per tenant: Tutor / Teacher / Lecturer) | Invited by a tenant admin, or approved through an application if the tenant uses application mode (BR-56) | Everything a learner can; create and manage **own** courses, question banks and quizzes; see own courses' learners and results; grade; see own earnings if revenue share is enabled | Edit other instructors' courses; tenant settings; payments beyond own earnings | A1 |
| **Tenant admin** | Staff of the school or business | Manage the tenant's users and roles (up to Tenant admin), instructors, courses (review, unpublish), categories, orders, refunds, payouts, reports, branding, enabled features (within the plan), settings, tenant audit log; approve or deny support-access requests | Change the plan or limits; manage owners; change the payment account; delete the tenant | B1, B3 |
| **Tenant owner** | The accountable person for the tenant (at least one, BR-58) | Everything a tenant admin can, plus: manage owners and admins, connect the payment account, manage domains, export tenant data, request offboarding | Anything outside the tenant | B1, B3 |

Permission model: **realm → tenant → RBAC → ownership → entitlement.** The tenant comes only from the verified request host (BR-42). Roles grant capabilities within that tenant. Ownership (`course.ownerId`) and entitlement (`enrollment`) narrow them to records. The database's row-level security enforces the tenant boundary a second time (04 §17). Course co-instructors are LATER (Q-ROLE-1). In the rest of this document, **"Admin" means Tenant admin** and **"Tutor" means Instructor** unless stated otherwise.

## 4. Feature catalogue

Each feature lists: purpose · roles · source · workflow · API (05 §4) / entities (05 §3) · risks and limitations · required capability · acceptance criteria (AC).

### Identity and access

#### F01 Registration and email verification — MUST
- **Purpose:** create a learner account. **Roles:** Visitor. **Source:** A1.
- **Workflow:** enter name, email, password and consent to terms → account created as `PENDING_VERIFICATION` → verification email with a single-use token (valid 24 h) → link opens → account `ACTIVE`. The user can resend the email (rate-limited).
- **API/entities:** `POST /auth/register`, `POST /auth/verify-email`, `POST /auth/verify-email/resend` · `user`, `one_time_token`.
- **Risks:** account enumeration. Mitigation: register and resend always return the same generic response.
- **Capability:** password policy of at least 10 characters, checked against a breached-password list (k-anonymity API or bundled top list); email normalised to lower case; consent version stored.
- **AC:**
  1. Registering with an existing email returns the same 202 response and sends an "account exists" email instead.
  2. The token works once and expires after 24 h.
  3. An unverified user can sign in and browse, but is blocked from purchase and tutor application with a clear prompt to verify (BR-02).

#### F02 Sign in, sessions, sign out — MUST
- **Roles:** all registered. **Source:** A1.
- **Workflow:** email + password → server session created → httpOnly, Secure, SameSite=Lax cookie. Sessions are listed in Settings and can be revoked individually or all at once. Idle timeout 30 days with rolling renewal; absolute lifetime 90 days (ASSUMED).
- **API/entities:** `POST /auth/sign-in`, `POST /auth/sign-out`, `GET /me/sessions`, `DELETE /me/sessions/{id}` · `session`.
- **Risks:** credential stuffing. Mitigation: per-IP and per-account rate limits, progressive delay, lockout notification email.
- **AC:**
  1. 10 failed attempts in 15 min on one account trigger a 15-minute cooldown and a notification email.
  2. Revoking a session invalidates it on the next request (≤1 s).
  3. Changing the password revokes all other sessions.
- **LATER:** Google sign-in (Q-AUTH-1); two-factor auth for admins (SHOULD, see F30).

#### F03 Password reset — MUST
- **Workflow:** request with email → generic response → email with a single-use token (valid 1 h) → set new password → all sessions revoked.
- **AC:** 1) The same response whether or not the email exists. 2) The token is single-use and expires after 1 h. 3) Old sessions are invalid after reset.

#### F04 Profile and account settings — MUST
- **Capability:** edit display name and avatar; change email (re-verification of the new address; the old address is notified); change password; phone number for mobile money (optional, validated E.164); notification preferences; data-saver preference; theme (system, light, dark); **download my data** (SHOULD); **delete account** (MUST, BR-27).
- **AC:** 1) An email change takes effect only after verifying the new address. 2) Account deletion anonymises personal data within 30 days and keeps financial records (BR-27). 3) The data export arrives as a ZIP of JSON files within 24 h (SHOULD).

#### F05 Roles and permissions — MUST
- **Capability:** role assignments (`LEARNER` always; `TUTOR` via F06; `ADMIN` granted only by an admin). Every role change is audited. Authorization is enforced server-side in a policy layer (04 §8).
- **AC:** 1) An automated authorization matrix test covers every endpoint × role × ownership case (07 §3). 2) A non-admin can't reach any `/admin/*` endpoint (403), and the UI hides admin navigation.

### Tutor onboarding

#### F06 Tutor application and approval — MUST
- **Roles:** Learner (applies), Admin (decides). **Source:** A1 + ASSUMED approval gate (Q-BIZ-3).
- **Workflow:** a verified learner fills in an application (headline, bio, subjects, qualifications, optional sample material, payout details: mobile money number or bank) → `SUBMITTED` → admin reviews in a queue → `APPROVED` (TUTOR role granted, email sent) / `REJECTED` (reason, may reapply after 30 days, ASSUMED) / `CHANGES_REQUESTED`.
- **Entities:** `tutor_profile` (status), `payout_method`.
- **AC:** 1) Only approved tutors can create courses (BR-03). 2) Every decision records the admin, time and reason in the audit log. 3) The applicant sees their status and the reason.

#### F07 Tutor public profile — MUST
- **Capability:** public page with name, photo, headline, bio, subjects and published courses. SEO-rendered.
- **AC:** a suspended tutor's profile returns 404 to the public.

### Catalogue and content

#### F08 Categories / subjects — MUST
- Two levels (Category → Subject), managed by admins. Courses have one subject and up to 5 free-form tags (ASSUMED).
- **AC:** a category can't be deleted while courses reference it (it is archived instead).

#### F09 Course authoring (outline) — MUST
- **Roles:** Tutor (owner). **Source:** A2.
- **Workflow:** create course (title, subject) → `DRAFT` → build outline: sections (ordered) → lessons (ordered, drag-and-drop or keyboard reorder) → fill course details (subtitle, description, learning outcomes, requirements, level, language, cover image, price) → publish (F12).
- **Capability:** autosave drafts; per-lesson `isPreview` flag; per-lesson `isRequired` flag (counts toward completion); duplicate a lesson; move a lesson between sections.
- **AC:** 1) Reordering survives reload, and concurrent edits are detected through a `version` column (409 on stale write). 2) A tutor can't see or edit another tutor's draft (404).

#### F10 Lesson types — MUST
| Type | Content | Completion rule (BR-30) |
|---|---|---|
| `TEXT` | Rich text (headings, lists, images, code, maths via KaTeX, callouts, tables) stored as ProseMirror JSON | Learner taps "Mark complete" |
| `VIDEO` | Managed video asset + optional notes (rich text) + attachments | ≥90% watched (player reports progress) or "Mark complete" |
| `FILE` | One or more downloadable or viewable files (PDF viewed in-browser) | Opened or downloaded |
| `QUIZ` | Links a quiz (F18) | Passed (or submitted, if the quiz has no pass mark) |
- **AC:** 1) Rich text is sanitised server-side against an allowlist schema; script and inline event handlers are impossible. 2) The PDF viewer works on Android Chrome without a download.

#### F11 Media upload and processing — MUST
- **Workflow (file):** client asks the API for an upload slot (type and size validated) → presigned PUT to object storage → client confirms → worker verifies size and magic bytes, scans for malware (ClamAV) and creates thumbnails for images → asset `READY` (or `REJECTED`).
- **Workflow (video):** API creates a video at the provider and returns a direct-upload URL (resumable, e.g. tus) → provider transcodes → webhook → asset `READY` with duration and thumbnail.
- **Limits (ASSUMED, configurable):** images 5 MB (JPEG, PNG, WebP); documents 50 MB (PDF, DOCX, PPTX, XLSX, ZIP); video 4 GB per file; per-tutor storage quota (Q-CNT-1).
- **AC:** 1) A file whose magic bytes don't match its declared type is rejected. 2) An unscanned or infected file is never served. 3) A dropped upload can be resumed (video) or retried (file) without duplicating assets.

#### F12 Publishing and review workflow — MUST
- **States:** `DRAFT → IN_REVIEW → PUBLISHED ⇄ UNPUBLISHED → ARCHIVED`, plus `IN_REVIEW → CHANGES_REQUESTED → IN_REVIEW`. Diagram in 05 §3.3.
- **Workflow:** tutor clicks Publish → **publish checklist** (BR-04) must pass → if the `courseReviewRequired` setting is on (default on, Q-BIZ-3) the course goes to the admin queue, otherwise straight to `PUBLISHED`. Edits to a published course go live immediately (no re-review, ASSUMED). A price change applies to new orders only.
- **AC:** 1) A course failing the checklist can't be submitted, and every failing item is listed with a link to fix it. 2) Unpublishing removes the course from the catalogue within 60 s (cache revalidation), while enrolled learners keep access (BR-26).

#### F13 Public catalogue and course landing page — MUST
- **Capability:** browse by category; full-text search (title, subtitle, tags, tutor name) with typo tolerance (Postgres trigram); filters (subject, level, price free/paid, language, duration band); sort (relevance, newest, popularity = enrolments in the last 30 days); cursor pagination. Course landing page: outcomes, outline (lesson titles and durations, preview lessons playable), tutor card, price, "includes" summary (n lessons, n quizzes, video hours), primary CTA (Enrol / Buy / Continue learning).
- **AC:** 1) Landing pages are server-rendered with title, description and Open Graph tags (verified by fetching without JavaScript). 2) Search returns results for one-letter typos ("biolgy" → "biology"). 3) Catalogue first page loads in LCP ≤2.5 s on a "Slow 4G" Moto G Power profile (NFR-PERF).
- **LATER:** ratings and reviews (Q-PRD-2).

### Learning

#### F14 Enrolment and entitlements — MUST
- **Sources of enrolment:** `FREE` (free course), `PURCHASE` (paid order), `ADMIN_GRANT` (with reason). **Access duration:** lifetime by default; a course may set `accessDays` (ASSUMED, Q-BIZ-4).
- **AC:** 1) A database constraint allows at most one `ACTIVE` enrolment per (user, course). 2) Revoking (refund or admin) removes access on the next request. 3) The course owner and admins can open the content without enrolling.

#### F15 Course player and progress — MUST
- **Capability:** lesson view with a collapsible outline; previous and next; completion state per lesson; resume from the last lesson and video position; progress % = completed required lessons ÷ required lessons; course completion (BR-22) shows a completion screen.
- **AC:** 1) Progress is saved on lesson completion and every 15 s of video playback (debounced), and survives a device switch. 2) Locked lessons (not enrolled) show the Buy/Enrol CTA, never the content. 3) Works one-handed on a 360 px wide screen.
- **SHOULD:** downloadable files available offline via the PWA cache (only where the tutor allows downloads).
- **LATER:** completion certificates (Q-PRD-1).

#### F16 Learner home ("My learning") — MUST
- **Capability:** continue-learning card (last course and lesson); enrolled courses with progress; quizzes due or open (if a quiz has a closing time); recent results; recommended courses (simple: same subjects, LATER).
- **AC:** the "continue" card opens the exact lesson and position last used.

### Assessment

#### F17 Question bank — MUST
- **Roles:** Tutor (owner). **Scope:** per course (ASSUMED; a shared bank across a tutor's courses is LATER).
- **Question types:** `SINGLE_CHOICE`, `MULTIPLE_CHOICE`, `TRUE_FALSE`, `SHORT_ANSWER` (accepted answers, normalised match), `NUMERIC` (value ± tolerance), `LONG_ANSWER` (manual grading).
- **Fields:** stem (rich text with images and maths), options, correct answer(s), points (default 1), explanation (shown per feedback policy), difficulty (easy, medium, hard), tags.
- **Capability:** create, edit, duplicate, archive; filter by tag, type and difficulty; CSV import (SHOULD) with a validation report.
- **AC:** 1) A choice question can't be saved without at least one correct option (single choice: exactly one). 2) Editing a question never changes existing attempts (BR-19). 3) Archived questions disappear from pickers but remain in historical attempts.

#### F18 Quiz builder and settings — MUST
- **Capability:** title and instructions; choose questions from the bank (fixed list, ordered) **or** draw rules ("5 random from tag *cells*, medium", SHOULD); settings: time limit (none or minutes), attempts allowed (none = unlimited), pass mark %, shuffle questions, shuffle options, availability window (opens and closes, optional), feedback policy (`IMMEDIATE`, `AFTER_CLOSE`, `NEVER`; score always shown unless `NEVER`), show correct answers (yes/no); `isPractice` flag defaults off.
- **AC:** 1) A quiz with 0 questions or a draw rule that can't be satisfied fails the publish checklist. 2) Total points shown to the tutor equal the sum of question points.

#### F19 Quiz attempt engine — MUST
- **Workflow:** intro screen (rules, time limit, attempts left) → Start → server creates an attempt, snapshots questions (shuffled if configured), sets `deadlineAt` → runner shows one question at a time with a navigator grid → answers autosave per question (debounced, retried with backoff while offline) → Submit (with a confirmation that lists unanswered questions) → grading → results.
- **Rules:** BR-16 to BR-21.
- **AC:**
  1) Refreshing the page or switching devices resumes the same attempt, answers and remaining time.
  2) The browser never receives correct answers or explanations before submission (verified by inspecting API responses in an e2e test).
  3) An attempt not submitted by the deadline is auto-submitted by the worker within 60 s, using the answers saved so far.
  4) An answer saved after `deadlineAt + 30 s grace` is rejected with `ATTEMPT_CLOSED`.
  5) Two simultaneous "Start" requests create one attempt.

#### F20 Grading — MUST
- **Auto:** all types except `LONG_ANSWER`, at submission. **Manual:** tutor grading queue per course (attempts in `NEEDS_REVIEW`), with points and a comment per long answer. The attempt becomes `GRADED` once every manual item is scored, and the learner is notified.
- **AC:** 1) Scores are stored per answer and in total; totals equal the sum of per-answer points. 2) Partial credit for multiple choice follows BR-21 exactly (unit-tested table).

#### F21 Results and review — MUST
- **Learner:** score, percentage, pass or fail, time taken, per-question review respecting the feedback policy; attempt history.
- **Tutor:** per-attempt view (any learner in their course).
- **AC:** with policy `AFTER_CLOSE`, review details are hidden until `closesAt`, then shown without any action from the tutor.

#### F22 Practice mode — MUST
- **Source:** A2 ("practice").
- **Capability:** untimed, unlimited practice sets drawn from a course's question bank, filtered by tag and difficulty (only questions the tutor marks `practiceEligible`, default on for auto-gradable types); immediate per-question feedback with explanation; does **not** count toward completion or grades; "review my mistakes" set built from questions answered wrong in the last 30 days (SHOULD).
- **AC:** 1) Practice is available only to enrolled learners. 2) Practice results never appear in tutor gradebooks (they do appear in aggregate question analytics, SHOULD). 3) `LONG_ANSWER` questions are excluded.
- **LATER:** flashcards and spaced repetition (Q-PRD-3).

#### F23 Tutor assessment analytics — SHOULD
- Per quiz: attempts, average and median score, pass rate, score distribution. Per question: % correct, option pick rates (spotting misleading options), average time. CSV export.
- **AC:** numbers match a fixture dataset in an integration test.

### Commerce

#### F24 Course pricing — MUST
- Price in ZMW minor units (ngwee, ASSUMED Q-LEG-1); 0 = free; minimum paid price configurable (default K20, ASSUMED); one-time purchase only (subscriptions LATER, Q-BIZ-5). Promotional sale price with end date: SHOULD. Coupons: LATER.
- **AC:** a price change leaves existing pending orders at their snapshot price.

#### F25 Checkout and payment — MUST
- **Workflow:** "Buy" → sign in if needed → email must be verified → checkout page (course, price, method: **mobile money** [network auto-detected from the number, editable] or **card**) → `POST /orders` (Idempotency-Key) → `POST /orders/{id}/payments`:
  - *Mobile money:* the provider pushes a PIN prompt to the phone; the page shows "Approve on your phone", polls status and offers "I didn't get a prompt" (retry or change number) after 60 s.
  - *Card:* redirect to the provider's hosted checkout (no card data touches StudyHub, keeping PCI scope to SAQ-A) → return URL shows "Confirming…" until the server confirms.
- → on server-confirmed success: enrolment created, receipt emailed, "Start learning" CTA.
- **Rules:** BR-07 to BR-11.
- **AC:**
  1) Visiting the return URL with fabricated success parameters never grants access.
  2) Double-clicking Buy creates one order (idempotency).
  3) A learner who closes the browser mid-payment still gets access once the payment confirms (webhook or reconciliation), and sees it on next visit.
  4) Failed or expired payments show a clear reason and a retry path that reuses the same order until it expires.

#### F26 Payment confirmation, webhooks and reconciliation — MUST
- Webhook endpoint verifies the signature, stores the raw event (unique per provider event id), enqueues processing, and returns 200 fast. The processor **re-queries the provider** for the transaction's authoritative status and amount before acting. The reconciliation job queries the provider for every payment `PENDING` longer than 2 min (then with backoff up to 24 h); after that, payments are marked `EXPIRED` or flagged.
- **AC:** 1) Replaying the same webhook 5 times yields one enrolment and one ledger entry. 2) A webhook with a bad signature is rejected (401) and logged. 3) An amount or currency mismatch puts the payment in the admin exceptions queue and grants no access.

#### F27 Receipts and purchase history — MUST
- Receipt number (sequential per year, e.g. `SH-2026-000123`), PDF and HTML receipt, emailed and downloadable; purchase list in Account.
- **AC:** receipt numbers are gap-free per year (allocated in the payment-confirmation transaction). Tax fields are UNKNOWN (Q-LEG-3).

#### F28 Refunds — MUST (admin-initiated)
- Learner requests a refund via a form (SHOULD) or by contacting support. Admin issues a full refund through the provider API where supported, or records a manual refund → enrolment `REVOKED`, earnings reversal entry, email to the learner and tutor.
- **Policy (UNKNOWN, Q-BIZ-2):** default ASSUMED window of 7 days and ≤30% progress, shown as guidance to the admin, not enforced.
- **AC:** a refund is atomic: refund record, enrolment revocation and ledger reversal commit together or not at all.

#### F29 Tutor earnings ledger and payouts — MUST
- **Model (ASSUMED, Q-BIZ-1):** the platform collects all money; tutors are paid periodically by the admin outside the system (mobile money or bank) and the payout is **recorded** in StudyHub.
- **Ledger:** an append-only `ledger_entry` per order item: gross, provider fee (if known), instructor commission kept by the tenant (`instructorCommissionBps`), instructor net; status `PENDING` (inside the refund window) → `AVAILABLE` → `PAID` (linked to a payout). Refunds create reversing entries, never edits.
- **Tutor view:** balances (pending, available, paid), statement by month, CSV export. **Admin:** payout run per tutor (select available entries → record a payout with reference) and payout history.
- **AC:** 1) The sum of entries reconciles to orders and refunds in an automated check (daily job; any mismatch alerts the admin). 2) Ledger rows can't be updated or deleted (DB permissions + no API).

### Platform administration

#### F30 User management — MUST
- Search by name, email or phone; view profile, roles, enrolments, orders and sessions; suspend or unsuspend (revokes sessions; suspended users can't sign in); grant or revoke admin (needs a second confirmation, audited); resend verification; manually grant course access (F14). **SHOULD:** TOTP two-factor authentication required for admins.
- **AC:** an admin can't remove their own admin role or suspend themselves (prevents lockout).

#### F31 Moderation and work queues — MUST
- Queues: tutor applications, courses in review, payment exceptions, refund requests (SHOULD), reported content (LATER). Each queue item has an age, an assignee (optional) and actions.
- **AC:** each queue shows a count badge in admin navigation, and items older than 72 h are highlighted.

#### F32 Reporting and exports — MUST (basic)
- Admin dashboard: revenue (gross, refunds, net) by day, week and month; new users; enrolments; top courses; payment success rate by method. Exports: orders, payments, ledger, enrolments (CSV, filtered by date range). Exports over 10k rows are generated by the worker and emailed or made downloadable.
- **AC:** dashboard figures match the export totals for the same range.

#### F33 Notifications — MUST
- **Email (transactional):** verification, password reset, receipt, enrolment, quiz graded, tutor application decision, course review decision, refund, payout recorded, security alerts. **In-app:** a notification centre (bell) for the same events. Email preferences for non-essential mail.
- **AC:** emails are sent through the outbox (transaction-safe) and retried; a failure never rolls back the business action.

#### F34 Audit log — MUST
- Records who, what, when, where (IP, user agent), before and after for: role changes, suspensions, approvals and rejections, refunds, payouts, manual access grants, settings changes, price changes, course status changes. Admin-only viewer with filters. Append-only.
- **AC:** every admin mutation endpoint produces exactly one audit entry (asserted in API tests).

#### F35 Platform settings — MUST
- `instructorCommissionBps` (revision 3 name; was `platformFeeBps`), `courseReviewRequired`, `minPaidPriceMinor`, `orderExpiryMinutes`, `refundWindowDays`, upload limits, maintenance banner. Changes are audited.

#### F36 Legal and consent — MUST
- Terms, privacy policy, refund policy and tutor agreement pages (content from the client, Q-LEG-2); consent version captured at registration and at tutor application; cookie notice limited to strictly necessary cookies (no third-party trackers at launch, ASSUMED).

## 5. Business rules register

| ID | Rule | Status |
|---|---|---|
| BR-01 | Email is unique, case-insensitive (normalised lower case) | PROPOSED |
| BR-02 | Unverified users can browse and enrol in **free** courses; email verification is required for purchase and tutor application | ASSUMED (Q-AUTH-2) |
| BR-03 | Only users with an approved tutor profile (not suspended) can create or edit courses | ASSUMED (Q-BIZ-3) |
| BR-04 | Publish checklist: title, subtitle, description ≥200 chars, subject, cover image, ≥1 learning outcome, ≥1 section, ≥1 lesson, every lesson has ready content, every quiz is valid (F18), price is 0 or ≥ minimum, tutor payout method set if price > 0 | PROPOSED |
| BR-05 | First publication needs admin approval when `courseReviewRequired` is on; later content edits don't need it | ASSUMED (Q-BIZ-3) |
| BR-06 | Money is an integer in minor units with an ISO currency code; single currency per deployment (ZMW) | PROPOSED / ASSUMED currency |
| BR-07 | A learner can't create an order for a course in which they hold an active enrolment, or for a course they own | PROPOSED |
| BR-08 | An order snapshots price, currency, course title and tutor at creation and expires after `orderExpiryMinutes` (default 30) if unpaid | PROPOSED |
| BR-09 | Entitlement is granted only after the server confirms a successful payment with the provider (webhook + status re-query or reconciliation), never on the client redirect | PROPOSED |
| BR-10 | Paid amount or currency ≠ order amount or currency → payment `NEEDS_REVIEW`, no entitlement, admin queue | PROPOSED |
| BR-11 | A second successful payment for an already-paid order → flagged for refund; no second enrolment or earning | PROPOSED |
| BR-12 | Access is lifetime unless the course sets `accessDays`; expiry evaluated on each access and by a daily job | ASSUMED (Q-BIZ-4) |
| BR-13 | Refund revokes the enrolment and reverses earnings atomically | PROPOSED |
| BR-14 | Instructor net = gross − provider fee (if attributable) − instructor commission (`instructorCommissionBps` of gross, kept by the tenant); rounding: commission rounded half-up to the ngwee, tutor net gets the remainder | ASSUMED (Q-BIZ-2) |
| BR-15 | Earnings become `AVAILABLE` after `refundWindowDays` (default 7) | ASSUMED |
| BR-16 | At most one `IN_PROGRESS` attempt per (learner, quiz), enforced by a partial unique index | PROPOSED |
| BR-17 | Attempts allowed counts submitted and auto-submitted graded attempts; practice never counts | PROPOSED |
| BR-18 | `deadlineAt = min(startedAt + timeLimit, closesAt)`; server-authoritative; 30 s grace for in-flight saves; worker auto-submits at the deadline | PROPOSED |
| BR-19 | Question content, options, correct answers and points are snapshotted into the attempt at start; edits never alter existing attempts; regrading is an explicit tutor action (LATER) | PROPOSED |
| BR-20 | Correct answers and explanations are never sent before submission; after submission they follow the feedback policy | PROPOSED |
| BR-21 | Scoring: single choice, true/false and numeric are all-or-nothing; multiple choice is all-or-nothing by default, or with `partialCredit` scores `points × max(0, (correctSelected − wrongSelected) / totalCorrect)` rounded to 2 dp; short answer compares trimmed, case-folded, whitespace-collapsed text against accepted answers (optionally case-sensitive); numeric uses absolute tolerance | PROPOSED |
| BR-22 | A course is complete when all required lessons are complete and all required quiz lessons are passed | ASSUMED |
| BR-23 | Quizzes with attempts can still be edited; the tutor is warned that only new attempts are affected | ASSUMED |
| BR-24 | Learners see only their own attempts and progress; tutors see their own courses' learners; admins see all | PROPOSED |
| BR-25 | Non-preview lesson content requires an active enrolment, ownership or admin | PROPOSED |
| BR-26 | Unpublished or archived courses disappear from the catalogue; active enrolments keep access | ASSUMED (Q-BIZ-6) |
| BR-27 | Account deletion anonymises personal data and keeps orders, payments and ledger for the statutory retention period (UNKNOWN length; default 7 years ASSUMED) | ASSUMED (Q-LEG-1) |
| BR-28 | Suspending a tutor unpublishes their courses from the catalogue; enrolled learners keep access; pending earnings are frozen | ASSUMED |
| BR-29 | Uploads: allowlisted types and limits (F11); content-type verified by magic bytes; malware scan before `READY` | PROPOSED |
| BR-30 | Lesson completion rules per type (F10) | PROPOSED |
| BR-31 | A tutor can't enrol in or buy their own course, and doesn't count in its analytics | PROPOSED |
| BR-32 | Quiz availability: before `opensAt`, Start is disabled; after `closesAt`, no new attempts | PROPOSED |
| BR-33 | Receipt numbers are sequential per calendar year with no gaps | PROPOSED |
| BR-34 | A deleted (archived) question bank item can't be added to new quizzes but stays in old attempts | PROPOSED |
| BR-35 | A pending order is reused if the learner returns to buy the same course before it expires | PROPOSED |
| BR-36 | Only one payment `PENDING` at a time per order; starting a new method cancels the previous pending payment locally (a late success is still honoured) | PROPOSED |
| BR-37 | Admins can't change their own roles or suspend themselves | PROPOSED |
| BR-38 | Lesson ordering is dense integers rewritten in one transaction per reorder | PROPOSED |
| BR-39 | All timestamps are stored in UTC and displayed in the user's time zone (default `Africa/Lusaka`, ASSUMED) | PROPOSED |
| BR-40 | Session and token secrets are stored hashed (SHA-256) in the database; raw values exist only in the cookie or email link | PROPOSED |

## 6. Explicitly out of scope for the first release

| Item | Reason | Revisit |
|---|---|---|
| Study planner, reminders, streaks | Not selected (A2) | Q-PRD-4 |
| Study groups, discussions, Q&A, messaging | Not selected (A2) | Q-PRD-4 |
| Native Android/iOS apps | A3: responsive web/PWA; the REST API stays mobile-ready | After launch |
| Subscriptions, bundles, coupons | Payment complexity; one-time purchase covers the core need | Q-BIZ-5 |
| Certificates, reviews and ratings | Not requested; easy to add on the enrolment and completion data | Q-PRD-1, Q-PRD-2 |
| Live classes and video calls | Not requested | — |
| Automatic split payouts to tutors | Needs provider support and KYC per tutor | Q-BIZ-1 |
| Multi-language UI | Strings externalised from day one; English only at launch | Q-L10N-1 |
| Cross-tenant marketplace (one catalogue searching all tenants) | Needs a cross-tenant read model and tenant opt-in; conflicts with strict isolation unless designed carefully | Q-TEN-9 |
| Tenant custom domains (`learn.myschool.ac.zm`) | Data model and host resolution support it from M2 (tenancy kernel); TLS and CDN setup is decided later | Q-TEN-5 |
| Self-service tenant sign-up and automated subscription billing | Tenants are provisioned by platform staff and invoiced outside the system at first | Q-BIZ-8, Q-TEN-10 |
| Single sign-on for institutions (SAML/OIDC), LMS integrations (LTI) | Valuable for colleges; adds identity complexity | Q-TEN-11 |
| Platform collecting money on behalf of third-party tenants (settlement to tenants) | Regulatory exposure; tenants use their own payment accounts | Q-TEN-4 |
| Per-tenant custom email sending domains (DKIM) | Tenant name shown as sender; platform domain sends | Q-TEN-12 |

## 7. Failure states and recovery (cross-cutting)

| Situation | Required behaviour |
|---|---|
| Network drops during a quiz | Banner "Offline — answers will sync"; answers queued in IndexedDB and replayed in order; the timer continues against the server deadline |
| Payment prompt never arrives | After 60 s: "Resend prompt" (new payment attempt on the same order) and "Use a different number/method" |
| Payment succeeds after order expiry | Honour it: re-open the order, grant access and log the event (customer paid; never strand money) |
| Video still processing | Lesson shows "Processing — usually under 10 minutes" to the tutor; the lesson can't be published until ready |
| Upload interrupted | Video resumes (tus); file restarts with the same upload slot until it expires (1 h) |
| Email provider down | Outbox retries with backoff for 24 h; admin alert after 1 h of failures |
| Learner loses access mid-lesson (refund or expiry) | Next request returns 403 `ENROLMENT_INACTIVE`; UI shows an explanation and a support link |
| Concurrent edits in the course builder | 409 `VERSION_CONFLICT` → "This course was changed in another tab. Reload to see the latest." |

## 8. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-PERF-1 | Public pages: LCP / INP / CLS on a mid-range Android, Slow 4G | ≤2.5 s / ≤200 ms / ≤0.1 (p75) |
| NFR-PERF-2 | Initial JS for the learner app route (compressed) | ≤170 KB |
| NFR-PERF-3 | API p95 latency for reads / writes (excluding provider calls) | ≤300 ms / ≤500 ms |
| NFR-CAP-1 | Launch capacity (ASSUMED, Q-OPS-1) | 5,000 registered, 300 concurrent, 100 concurrent quiz attempts |
| NFR-AVAIL-1 | Monthly availability (excluding planned maintenance) | 99.5% |
| NFR-DR-1 | RPO / RTO | ≤5 min (PITR) / ≤4 h |
| NFR-A11Y-1 | Accessibility | WCAG 2.2 AA |
| NFR-SEC-1 | Security baseline | OWASP ASVS 4.0 Level 2 for auth, session, access control, validation, and file handling |
| NFR-PWA-1 | Installable PWA; app shell cached; offline page; data-saver mode | MUST |
| NFR-BROWSER-1 | Support | Last 2 versions of Chrome (Android and desktop), Edge, Firefox, Safari (iOS 16+); Opera Mini not supported (shows a basic notice) |
| NFR-L10N-1 | Locale | `en-ZM` (ASSUMED), ZMW currency "K", `Africa/Lusaka`, all strings in catalogs |
| NFR-PRIV-1 | Privacy | Data minimisation, export, deletion; no third-party ad trackers |

## 9. Multi-tenancy and white-label requirements (revision 2)

Source: second client brief (B1–B3, §1). The requirement for tenancy, isolation and separate permissions is client-stated. **Every mechanism below is PROPOSED or ASSUMED** unless marked otherwise.

**Glossary:** a **tenant** is one customer organisation (school, college, education business, or independent tutor) with its own site, users, content, settings, payment account and data. The **platform owner** is the company operating StudyHub.

### 9.1 New features

#### F37 Tenant provisioning and lifecycle — MUST
- **Roles:** Platform owner or operator (creates, activates, suspends, offboards); Tenant owner (accepts the invitation, completes onboarding).
- **Workflow:** operator creates a tenant (name, kind, slug, plan, country, currency, owner email) → `PROVISIONING` → the owner receives an invitation (single-use, 7 days) → the owner sets a password and runs the **onboarding checklist** (branding, terms and policies, payment account if selling, invite instructors, first course) → owner or operator activates → `ACTIVE`. Suspension: operator, with reason. Offboarding: F46.
- **States:** `PROVISIONING → ACTIVE ⇄ SUSPENDED → OFFBOARDING → DELETED` (05 §8).
- **AC:**
  1. A new tenant is reachable at `{slug}.<platform-domain>` within 60 s of creation, showing a "coming soon" page until active.
  2. Slugs follow BR-50, and reserved words are rejected.
  3. Every lifecycle change writes to the platform audit log and notifies the tenant owners.
  4. A suspended tenant behaves per BR-52.

#### F38 Tenant addressing and resolution — MUST (subdomains); LATER (custom domains)
- Each tenant is served at `{slug}.<platform-domain>`. The API and web resolve the tenant from the **host only** (BR-42).
- Custom domains: the `tenant_domain` model and resolution support them from day one. Verification (DNS TXT), TLS issuance and CDN handling are a later milestone (Q-TEN-5).
- The platform's own marketing site (if any) and the console live on reserved hosts.
- **Tenant-facing domain settings (revision 3):** owners see their current address(es) on a Domain page (S-AD19) and can request a subdomain change, which a platform operator approves under BR-50. When the `customDomain` feature becomes available (LATER), the same page adds a custom domain:
  - DNS instructions and a TXT verification token.
  - Verify, set as primary, remove.
  - The API contract is specified now (05 §8.3) so the model doesn't change later.
- **AC:**
  1. Requests with an unknown host get a generic "site not found" page with no tenant hints (BR-60).
  2. A session cookie issued on tenant A's host is never sent to tenant B, and is rejected if replayed there (BR-44).
  3. Client-supplied tenant ids in headers, query strings or bodies are ignored.

#### F39 Branding and white-label theming — MUST
- **Tenant owner/admin can set:**
  - Display name, logo (light and dark), favicon and app icon (for PWA install).
  - **Accent colour** (validated, BR-51) and a font preset from a curated list of 3 (Copperline default, a humanist sans, a geometric sans; all self-hosted).
  - Home page sections (hero text, featured courses, categories; order and visibility).
  - Footer links, support email and phone, social links.
  - Terminology: what instructors and courses are called (e.g. "Lecturer", "Module").
  - Email sender display name and reply-to.
  - "Powered by StudyHub" badge, removable if the plan allows (`whiteLabel` feature).
- Live preview in light and dark; changes publish atomically (draft → publish) and are versioned so they can be rolled back.
- PWA manifest, favicon, Open Graph images and emails use the tenant brand.
- **AC:**
  1. An accent colour that can't meet contrast in both themes, even after automatic adjustment, is rejected with an explanation and suggested nearby compliant colours.
  2. Branding changes appear on the tenant's public pages within 60 s (cache revalidation) and never on another tenant's pages.
  3. Uploaded logos are re-encoded and size-limited (SVG is sanitised or rejected, Q-TEN-13).

#### F40 Feature modules and plan entitlements — MUST
- **Features (keys):** `paidCourses`, `practiceMode`, `quizAnalytics`, `instructorApplications`, `instructorRevenueShare` (ledger and payouts), `publicCatalog`, `whiteLabel`, `customDomain` (LATER), `dataExport`, `certificates` (LATER).
- **Plans** (platform-defined) grant features and **limits**: active learners, instructors, storage GB, video minutes per month, admins. The platform can add per-tenant overrides.
- **Effective feature = plan grants it (or an override does) AND the tenant has it switched on** (BR-48).
- **AC:**
  1. A disabled feature disappears from navigation, and its API endpoints return 403 `FEATURE_NOT_ENABLED`; its data is kept.
  2. Re-enabling restores the previous data.
  3. Limits are enforced per BR-49, with warnings at 80% and 100% to tenant owners.

#### F41 Tenant settings and policies — MUST
- These revision 1 platform settings become **per-tenant**:
  - Commerce: instructor commission (only with `instructorRevenueShare`), minimum price, order expiry, refund window.
  - Moderation and access: course review required, instructor onboarding mode (BR-56), learner registration mode and catalogue visibility (BR-57), unverified free enrolment (BR-02), default course access.
  - **Languages (revision 3):** `defaultLocale` and `enabledLocales[]`, chosen from the locales the platform has translated (only `en` at launch, Q-L10N-2). Tenant-authored texts (home page hero, terminology, footer, legal pages, email sender name) are stored **per enabled locale**. Learners pick a language only when more than one is enabled. Course content declares its own language (`course.language`) and isn't machine-translated. Time zone and currency (ZMW only at launch) are also set here.
  - **Course and material settings (revision 3):**
    - Allowed upload types: a subset of the platform allowlist.
    - Maximum document and video size, up to the plan and platform limits.
    - Whether file downloads are allowed by default for new lessons.
    - Video completion threshold (default 90%).
    - Default course access (lifetime or n days).
    - Quiz defaults for new quizzes: feedback policy, attempts allowed, pass mark, shuffle.
    - Practice defaults: questions per session, whether "my mistakes" is available.
    - Course review required.
    - Instructor onboarding mode.
  - **Payment settings (revision 3, only where the connected provider supports them, BR-62):**
    - Enabled payment methods: a subset of the account's detected capabilities, e.g. MTN, Airtel, Zamtel mobile money, card.
    - Minimum price, order expiry, refund window, and refund mode (via the provider API when supported, otherwise recorded manual refunds).
    - Instructor commission and payout schedule (only with `instructorRevenueShare`).
    - Receipt seller details.
  - Legal: legal pages content (per locale).
- Global settings (security defaults, reserved slugs, maintenance banner, provider configuration) stay in the console (F43).
- **AC:**
  1. Changing a setting in tenant A has no effect on tenant B (isolation test).
  2. Each change is audited in the tenant audit log with old and new values.

#### F42 Tenant team and roles — MUST
- Owners and admins invite people by email as instructor, admin or owner (owners only invite owners). They can change roles, suspend or revoke memberships (the person's global account is unaffected, BR-69, BR-70) and transfer ownership. Accepting an invitation creates the membership, and the global account if needed (BR-67).
- Instructor onboarding mode: `INVITE_ONLY` (default) or `APPLICATION` (revision 1's F06 queue, per tenant).
- **AC:**
  1. The last owner can't be removed or demoted (BR-58).
  2. Admins can't grant owner.
  3. Invitations are single-use and expire after 7 days.

#### F43 Platform console — MUST
- Separate host and realm.
- **Screens:** tenants (list, search, status, plan, usage, health), tenant detail (metadata, domains, plan and overrides, lifecycle actions, support-access history; **no tenant content or learner data**), plans and limits, platform staff and roles, global settings, platform audit log, provider health (payments, video, email), and a cross-tenant operations view of aggregated, non-personal metrics (counts and sums, no names).
- **AC:**
  1. No console endpoint returns tenant personal data (names, emails, answers, orders with personal details) without an active support grant. This is checked by an automated response-schema test.
  2. 2FA is required for every platform account.

#### F44 Support access (break-glass) — MUST
- Platform staff request time-limited access to one tenant, with a reason and scope (`READ_ONLY` default, or `READ_WRITE`) → tenant owners and admins approve or deny in their admin area → access starts with a visible banner for the staff member. Every action is logged in **both** the platform and tenant audit logs.
- **Emergency access:** platform owner only. It is granted immediately with a mandatory reason, and tenant owners are notified at once.
- Maximum duration: 4 h by default (configurable up to 24 h).
- **AC:**
  1. Expired grants stop working on the next request.
  2. A tenant admin can see every grant and revoke an active one.
  3. Support sessions can't change owners, the payment account or domains, even with `READ_WRITE`.

#### F45 Tenant payment accounts — MUST
- Each tenant that sells connects **its own payment account** (aggregator merchant credentials, stored encrypted per tenant). Money goes to the tenant, and the platform never holds tenant funds (RECOMMENDED, Q-TEN-4).
- Webhooks are addressed per payment account (`/webhooks/payments/{provider}/{paymentAccountId}`) and verified with that account's secret.
- A connection test (sandbox call) is required before activation.
- **AC:**
  1. A tenant without an `ACTIVE` payment account can't publish paid courses (BR-54).
  2. A webhook verified with tenant A's secret can never affect tenant B's orders.
  3. Credentials are never returned by any API after saving (write-only, masked hint only).

#### F46 Tenant data export and offboarding — MUST (export) / SHOULD (self-service offboarding)
- The owner requests a full export (JSON per entity + CSV summaries + media files) produced by the worker, delivered as an expiring signed link.
- Offboarding: request → 30-day read-only grace period → deletion of tenant data and files. Financial records are archived and access-restricted for the retention period (BR-53).
- **AC:**
  1. The export contains every tenant-owned table's rows for that tenant only (verified against a fixture with two tenants).
  2. After deletion, no tenant rows remain except the archived financial records.

#### F47 Usage metering and quotas — MUST (basic)
- Measured daily per tenant: active learners, instructors, storage bytes, video minutes delivered (from the video provider), emails sent, payments processed (count).
- Visible to the tenant owner (Usage page) and the platform (console). Feeds plan-limit enforcement (BR-49) and manual invoicing.
- **AC:** usage figures for a test tenant match the seeded activity within 1%.

#### F48 Tenant-branded communications — MUST
- All emails, receipts and PWA install prompts carry the tenant's name, logo and accent. Sender address is on the platform's mail domain with the tenant name as display name and the tenant's reply-to (custom domains: Q-TEN-12).
- Receipts show the tenant as the seller (legal name, address, tax id if provided: Q-LEG-3).
- **AC:** no tenant email or receipt shows another tenant's name, or the platform brand when `whiteLabel` is on (except legally required lines).

#### F49 Separate audit logs — MUST
- **Tenant audit log:** actions inside the tenant, including support-access actions, visible to tenant owners and admins.
- **Platform audit log:** console actions, visible to the platform owner.
- Both are append-only.
- **AC:** each tenant admin and console mutation produces exactly one entry in the correct log, and support actions produce one in each.

### 9.2 How existing features change under tenancy

| Feature | Change |
|---|---|
| F01–F03 Identity | One **global account** per person; sign-in happens on the school host and requires an ACTIVE membership there (BR-65). Registration on a school host creates the account and/or a LEARNER membership, following that school's registration mode (BR-57, BR-66). Verification and password reset are global; emails use the branding of the school host the request came from. All responses are generic (no account or membership enumeration). |
| F04 Account | Profile fields that belong to a school (display name override, student number) live on the membership. **Leave a school** revokes that membership only; **delete account** ends every membership and anonymises personal data in each school by a named, audited system job, keeping financial records per retention (BR-27, BR-70). Email and password changes are global and user-controlled (BR-69). |
| F05 Roles | Replaced by the two-realm model in §3; tenant roles are attached to the **membership**. The authorization matrix adds the dimensions *same tenant / other tenant / platform realm / user with membership elsewhere only*. |
| F06 Tutor application | Becomes the instructor application. It is available only when the tenant's onboarding mode is `APPLICATION` (BR-56). Payout details are needed only with `instructorRevenueShare`. |
| F07 Tutor page | Instructor page within the tenant site. |
| F08 Categories | Per tenant (each tenant manages its own tree). |
| F09–F12 Authoring and publishing | Per tenant. Review queue goes to the **tenant's** admins. A paid course needs the tenant's active payment account (BR-54). |
| F13 Catalogue | Per tenant. Catalogue may be `PUBLIC` or `MEMBERS_ONLY` (BR-57). There is no cross-tenant search (Q-TEN-9). SEO per tenant host. |
| F14–F16 Learning | Unchanged within the tenant; entitlements never cross tenants. |
| F17–F23 Assessment | Unchanged within the tenant; question banks are never shared across tenants. Practice and analytics are feature-gated (F40). |
| F24–F28 Commerce | Use the **tenant's** payment account and currency. Receipts are numbered per tenant (BR-55). Refunds are handled by the tenant's admins. |
| F29 Earnings ledger | Only when `instructorRevenueShare` is on (marketplace-style tenants). Schools that pay staff salaries leave it off. Fee % is a tenant setting. |
| F30–F32 Admin | Tenant admin scope. Platform-wide views exist only as aggregated metrics in the console (F43). |
| F33 Notifications | Tenant-branded (F48). |
| F34 Audit | Split into tenant and platform logs (F49). |
| F35 Platform settings | Split into tenant settings (F41) and global settings (F43). |
| F36 Legal | Each tenant publishes its own terms, privacy and refund policies (templates provided). Platform terms govern the tenant–platform relationship (Q-LEG-4). |

### 9.3 Business rules (tenancy)

| ID | Rule | Status |
|---|---|---|
| BR-41 | Every tenant-owned record belongs to exactly one tenant. No read or write crosses tenants, except tenant metadata and aggregated metrics in the console and actions under a support grant | PROPOSED (from B2) |
| BR-42 | The tenant is determined **only** from the verified request host. Client-supplied tenant identifiers are ignored | PROPOSED |
| BR-43 | One **global account** per person: `unique(email)` across the platform. Access to a school requires an explicit **membership** in that school; roles are granted per membership. A user may belong to many schools | CONFIRMED (D3, rev. 4; replaces the tenant-scoped account rule) |
| BR-44 | Sessions are host-only cookies. A session is valid only when `session.tenant_id` equals the resolved tenant | PROPOSED |
| BR-45 | Platform accounts live in a separate realm (console host only). Tenant accounts can't access the console | PROPOSED |
| BR-46 | Platform staff can't access tenant personal data, content or financial detail without an active support grant | PROPOSED (from B3) |
| BR-47 | Support grants carry a reason and scope, are time-limited (default 4 h, maximum 24 h), need tenant approval except emergency access by the platform owner, are audited in both logs, and exclude owner, payment-account and domain changes | PROPOSED |
| BR-48 | Effective feature = (plan grant OR platform override) AND tenant-enabled | PROPOSED |
| BR-49 | Limits are enforced at the action that would exceed them: inviting instructors and admins, learner registration (active learners), upload slot creation (storage), video upload (storage). Video delivery minutes are a soft limit (warn at 80% and 100%; blocking is a plan option) | ASSUMED (Q-BIZ-8) |
| BR-50 | Tenant slug: 3–30 chars `[a-z0-9-]`, no leading or trailing hyphen, not reserved (`www, admin, console, api, app, mail, static, assets, cdn, status, help, support, docs, blog, studyhub`…). Changeable only by platform staff; the old host redirects for 90 days | PROPOSED |
| BR-51 | The tenant accent must give ≥4.5:1 with its on-accent text and ≥3:1 against canvas and surface in both themes. The system derives hover, soft and dark-theme variants and rejects colours it can't make compliant | PROPOSED |
| BR-52 | Suspended tenant: public pages show a neutral "temporarily unavailable" page; enrolled learners keep read-only access to content they paid for; no new orders, enrolments or sign-ups | ASSUMED (Q-TEN-8) |
| BR-53 | Offboarding: 30-day read-only export window, then deletion. Financial records are archived for the retention period | ASSUMED (Q-LEG-1) |
| BR-54 | Paid courses need the tenant to have an `ACTIVE` payment account. Payments go to that account | PROPOSED (Q-TEN-4) |
| BR-55 | Receipt numbers are per tenant per year with a tenant prefix (`{PREFIX}-2026-000123`). They replace BR-33's global sequence | PROPOSED |
| BR-56 | Instructor onboarding mode per tenant: `INVITE_ONLY` (default) or `APPLICATION` | PROPOSED |
| BR-57 | Learner registration mode per tenant: `OPEN` (default), `INVITE_ONLY`, or `EMAIL_DOMAIN` (allowlisted email domains). Catalogue visibility: `PUBLIC` (default) or `MEMBERS_ONLY` | PROPOSED |
| BR-58 | Every tenant has at least one active owner. The last owner can't be removed, demoted or deleted | PROPOSED |
| BR-59 | Slugs (courses, categories, instructors) and similar natural keys are unique **per tenant** | PROPOSED |
| BR-60 | Unknown, unverified or deleted hosts get a generic "site not found" page that reveals nothing about tenants | PROPOSED |
| BR-61 | A user's locale must be one of the tenant's `enabledLocales`. Disabling a locale moves its users to `defaultLocale`. Tenant texts fall back to `defaultLocale` when a translation is missing | PROPOSED (rev. 3) |
| BR-62 | A tenant can enable only payment methods and refund modes that its connected payment account **reports as supported** (adapter capability model, 04 §17.10). Unsupported options are shown disabled with the reason | PROPOSED (rev. 3) |
| BR-63 | Commission terms: **instructor commission** is the share of an instructor's sale kept by the tenant (ledger, only with `instructorRevenueShare`); **platform commission** is the share of a tenant's sales owed to the platform (`plan.platformCommissionBps`, default 0), invoiced monthly from recorded sales net of refunds; neither is ever deducted from money in transit | PROPOSED (rev. 3, Q-BIZ-9) |
| BR-64 | Tenant course and material settings are **defaults and limits** for new content. Changing them never silently changes existing lessons or quizzes, except upload limits, which apply to new uploads | PROPOSED (rev. 3) |
| BR-65 | Sign-in on a school host succeeds only with valid global credentials **and** an ACTIVE membership in that school. Unknown email, wrong password and missing or inactive membership return the same generic error | CONFIRMED (D3, D4) |
| BR-66 | Registering with an email that already has an account never reveals it: the response is generic and the email invites the person to sign in and confirm "Join *School*", which creates the membership | CONFIRMED (D3, D4) |
| BR-67 | Accepting an invitation creates the membership with the invited role in one transaction, creating the global account first if none exists. Invitations are single-use and expire after 7 days | CONFIRMED (D3) |
| BR-68 | School switching uses a one-time hand-off token: 256-bit, stored hashed, valid 60 s, single use, bound to the user and the **target** school; exchanged by POST on the target host, which re-checks the membership before creating a session there | CONFIRMED (D4) |
| BR-69 | Suspending or revoking a membership deletes that user's sessions in that school in the same transaction; other schools are unaffected. Password change or reset and "sign out everywhere" end the user's sessions in all schools | CONFIRMED (D3) |
| BR-70 | A school can't change a member's login email or password, can't delete the global account, and can't see the member's other memberships | CONFIRMED (D3) |
| BR-71 | User-facing copy calls the shared identity "your account" (no platform name required on white-label sites); the privacy notice discloses that the account works with other schools on the platform | CONFIRMED (D4); wording subject to Q-LEG-4 |

### 9.5 Money-flow workflows (revision 3)

All workflows run **inside one tenant**, using that tenant's payment account (BR-54). The provider is **not selected** (Q-PAY-1). No real provider is integrated until it passes the capability checklist (10 §11) **and the client approves it** (Q-PAY-3).

| # | Workflow | Trigger → steps → end state | Owner | Spec |
|---|---|---|---|---|
| W1 | **Student payment** | Learner buys → order (price snapshot, idempotency key) → payment on the tenant's account (mobile-money push or hosted card page) → webhook verified with that account's secret → status re-queried → one transaction: payment `SUCCEEDED`, order `PAID`, enrolment, ledger lines (if revenue share), receipt (tenant prefix), outbox emails | System | F25, F26, 04 §7.1 |
| W2 | **Instructor commission** | On W1 success with `instructorRevenueShare`: ledger `SALE` entry = gross − provider fee − instructor commission (`instructorCommissionBps`) = instructor net, status `PENDING` → `AVAILABLE` after the tenant's refund window | System | F29, BR-14, BR-15 |
| W3 | **Instructor payout** | Tenant admin opens payouts → selects `AVAILABLE` entries per instructor → pays the instructor **outside StudyHub** (mobile money or bank from the tenant's own funds) → records the payout (amount = sum of entries, external reference, date) → entries `PAID` → instructor notified. Automated disbursement via provider API: LATER, only if the approved provider supports it | Tenant admin | F29, S-AD05 |
| W4 | **Refund** | Learner requests (SHOULD) or the admin initiates → admin confirms → if the provider supports refunds via API: refund call → `SUCCEEDED`; otherwise the admin refunds outside StudyHub and records a manual refund with a reference → one transaction: enrolment `REVOKED`, `REFUND_REVERSAL` ledger entry, order `REFUNDED` → emails. Already-paid-out instructor earnings produce a negative available balance carried into the next payout | Tenant admin | F28, BR-13 |
| W5 | **Payment-status reconciliation** | Every minute: payments `PENDING` > 2 min are re-queried per payment account (backoff up to 24 h) → confirm, fail or expire; mismatches go to the tenant's payment-exceptions queue | System | F26 |
| W6 | **Ledger integrity check** | Daily per tenant: SALE and REVERSAL sums vs paid orders and refunds → mismatch alerts the tenant owner and the platform (metadata only) | System | F29 |
| W7 | **Provider settlement reconciliation** (SHOULD) | Daily, or when the admin uploads the provider's statement: fetch the provider's transaction list (if the provider has a list API) or import its CSV statement → match by reference and amount → report matched, missing-in-StudyHub, missing-at-provider and amount mismatches → admin resolves each (re-check, accept, refund, note) | Tenant admin | S-AD20, 05 §8.2 `settlement_report` |
| W8 | **Platform commission and subscription statement** | Monthly per tenant: subscription fee (plan) + `platformCommissionBps` × (gross sales − refunds) from recorded payments → `platform_statement` (`DRAFT → ISSUED → PAID`, recorded by a platform operator) → tenant owner sees it on the Billing page (S-AD21). Invoicing and collection happen outside StudyHub at launch | Platform operator | Q-BIZ-8, Q-BIZ-9, BR-63 |

### 9.4 Non-functional additions

| ID | Requirement | Target |
|---|---|---|
| NFR-ISO-1 | Tenant isolation | Row-level security on 100% of tenant-owned tables (checked in CI); the automated cross-tenant suite shows zero leaks for every endpoint |
| NFR-ISO-2 | Noisy-neighbour protection | Per-tenant rate limits and quotas; one tenant's export or bulk job can't delay another tenant's interactive requests beyond NFR-PERF-3 |
| NFR-CAP-2 | Launch tenancy capacity (ASSUMED, Q-OPS-1) | Up to 50 tenants, 20,000 total accounts, 500 concurrent users across tenants on the launch infrastructure |
