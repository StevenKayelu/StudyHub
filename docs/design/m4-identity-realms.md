# M4 design note: identity realms and access control

- **Status:** IMPLEMENTED (2026-10-13). Builds on the approved D3 (global accounts with per-school memberships) and D4 (school-host sign-in, hand-off switching). Items marked **PROPOSED** were decided during implementation and need client confirmation. **D7 (legal: controller role for global accounts) remains OPEN**; consent texts are placeholders.
- **Baseline:** M3 commit `e136153`; blueprint revision 4 (04 §8, §17.5–17.6; 05 §3, §8; 06 S-A01–S-A06, S-AD14, S-C01, S-C07).
- **Scope (07 §M4):** global accounts, memberships and roles; sign-in on the school host (BR-65); join (BR-66); invitations (BR-67); switching by hand-off (BR-68); revocation and global session revocation (BR-69); the definer functions; registration modes; the platform realm with TOTP and console session lifetimes; the policy layer and authorization matrix; audit logs; rate limits.

## 1. Data model (migration 0004)

| Table                                                                            | Scope                  | RLS policy                                                                                                   | Runtime role                                 |
| -------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `user_account`                                                                   | global                 | `account_self_or_member`: yourself, or a member of the **current** school; writable only as yourself (BR-70) | SELECT, INSERT, UPDATE                       |
| `credential`                                                                     | global                 | `credential_self`                                                                                            | SELECT, INSERT, UPDATE                       |
| `one_time_token`                                                                 | global                 | `one_time_token_self`; redeemed only via `redeem_one_time_token()`                                           | SELECT, INSERT, UPDATE                       |
| `tenant_handoff`                                                                 | global (target school) | `tenant_handoff_self`; redeemed only via `exchange_handoff()`                                                | SELECT, INSERT                               |
| `tenant_membership`, `membership_role`, `session`, `invitation`                  | school-owned           | `tenant_isolation`; composite FKs to the membership                                                          | DML as needed (session: column-level UPDATE) |
| `platform_user`, `platform_credential`, `platform_session`, `platform_audit_log` | platform               | `platform_realm`: visible only when `app.realm = 'platform'` (console transactions)                          | as needed; audit append-only                 |

**Context:** `runInTenantTx` now sets `app.tenant_id` **and** `app.user_id` in one statement. T-PERF-01 still measures exactly one extra statement (3 → 4) and 0.017 ms database time, so D5 holds. Console requests use `runInPlatformTx` (`app.realm = 'platform'`, no tenant), so school-owned tables are empty there.

**Definer inventory additions** (owned by NOLOGIN `studyhub_rls_definer`, executable only by the runtime role, fixed `search_path`, CI-checked):

| Function                                | Returns                                                     | Why it must bypass RLS                                            |
| --------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `auth_lookup(email)`                    | id, status, verified flag, password hash, lockout state     | Sign-in, registration and reset happen before anyone is signed in |
| `redeem_one_time_token(hash, purpose)`  | user id, payload, context school; marks it used             | The person redeeming isn't signed in                              |
| `my_memberships()`                      | the **caller's** active schools (name, primary host, roles) | Lists memberships across schools for the switcher                 |
| `revoke_user_sessions_everywhere(keep)` | count                                                       | Ends the caller's sessions in every school (BR-69)                |
| `exchange_handoff(hash)`                | user id, only if minted for the current school              | Redeemed on the target host before a session exists               |

**Rules enforced in the database (defence in depth):**

- BR-69: a trigger deletes a membership's sessions when it becomes SUSPENDED or REVOKED.
- BR-58: a deferred constraint trigger refuses a school with no active owner.

## 2. Flows

| Flow                  | Behaviour                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register (S-A02)      | Password rules first (answers that reveal nothing). New email: account, credential, ACTIVE membership with LEARNER, verification email; existing email: an "account exists, sign in to join" email. **Same 202 either way** (BR-66).                                                                                                                                                     |
| Verify (S-A04)        | Single-use 24 h link; signs the person in if the link came from this school.                                                                                                                                                                                                                                                                                                             |
| Sign in (S-A01)       | Generic `INVALID_CREDENTIALS` for unknown email, wrong password, inactive account and missing/suspended/revoked membership (BR-65), with equal Argon2 work. Valid credentials without membership on a school that accepts sign-ups → `JOIN_AVAILABLE` with a sealed 10-minute ticket → "Join _School_" (BR-66).                                                                          |
| Reset (S-A05)         | Generic 202; single-use 1 h link; a rejected password doesn't burn it; sets the new password, confirms the email, ends all sessions everywhere, notifies.                                                                                                                                                                                                                                |
| Change password       | Requires the current one; ends every other session in every school; notifies.                                                                                                                                                                                                                                                                                                            |
| Switch school (BR-68) | 60 s single-use hand-off minted for a school in `my_memberships()`; the target host exchanges it and re-checks the ACTIVE membership.                                                                                                                                                                                                                                                    |
| Invitations (BR-67)   | Admins invite learners and instructors; only owners invite admins and owners. 7-day single-use link; acceptance creates the account if needed, the membership and the role **in one transaction**, verifies the email, and signs in. An existing account proves itself with its password (or an existing session on that host).                                                          |
| Leave / remove        | Status REVOKED (sessions end via trigger); last owner refused (BR-58). Role changes end the member's sessions in that school so new rights apply at next sign-in.                                                                                                                                                                                                                        |
| Console (S-C01)       | Password → partial session (10 min) that can only enrol or verify TOTP → full session (idle 30 min, absolute 12 h). Enrolment shows the key once and 8 single-use recovery codes. Codes can't be replayed (`totp_last_step`). Sensitive actions require a TOTP re-authentication within 5 minutes (implemented for "disable staff"; tenant lifecycle and plans will use the same guard). |

**One-time tokens in links** travel in the URL **fragment** (`/verify-email#token=…`): never sent to servers, proxies or logs, and removed from history on load. In the email queue (outbox and job payloads) the link variables are **sealed** with AES-256-GCM, bound to school and recipient (`IDENTITY_ENCRYPTION_KEY`), so no usable link sits in the database in clear text (tested).

**CSRF:** SameSite=Lax cookies plus an Origin check (or `Sec-Fetch-Site: same-origin`) on every state-changing `/api/v1` and `/console` call.

**Cookies:** `__Host-sh_session` per school host and `__Host-sh_console` on the console host: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Verified in Chromium: browsers accept Secure cookies on `http://*.localhost`, so local development needs no TLS. The Caddy proxy deferred in ADR-0018 is no longer needed locally; staging uses real TLS.

## 3. Authorization

- **Policy layer** (`modules/identity/domain/policy.ts`, framework-free, unit-tested): `can(actor, action)`, `allowedActions` (returned by `GET /me`), `canManageRole`, `canManageMember`, session lifetimes.
- Another school's resources are invisible (RLS), so they are always **404**, never 403.
- **Authorization matrix** (`packages/contracts/src/authz-matrix.ts`): endpoint × {anonymous, learner, instructor, admin, owner, other school, platform staff} and the console rows {anonymous, school session, partial staff, operator, owner}. Each cell is a generated integration test.
- Web guards: `/learn` and `/account` require a member; `/studio` instructors; `/admin` administrators and owners. Visitors are redirected to sign-in and returned afterwards (same-site paths only); members without the role see S-X05.

## 4. Rate limits (PROPOSED values)

In-process fixed windows per IP, per account (email) and per school. Per-IP limits are deliberately generous because a school often shares one public IP (NAT). The real protection is per-account (sign-in 10 / 15 min; email sends 3 / hour) plus a persistent lock after 10 consecutive failures (15 min; console 5 → 30 min). Single instance only: a shared store is needed before running more than one API instance.

## 5. Email

Outbox → `email.send` queue → worker renders (English templates) and sends over SMTP. Locally, **Mailpit** (in docker compose) catches everything at http://127.0.0.1:8025. Sender: `"<School name>" <no-reply@…>` (04 §17.11). Provider selection for production is open (M11).

## 6. Tests

| AC                                                                                                                 | Test                                                                                                                                        | Result                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1 One account, two schools; each sees only its own membership; admins can't list global users or other memberships | `identity.int.test.ts` (API + database level) and `identity.spec.ts` (browser: switcher)                                                    | Pass                           |
| 2 Session replayed on another school host is rejected                                                              | API test and browser test (cookie forced onto the other host)                                                                               | Pass                           |
| 3 Neither realm can use the other's area                                                                           | API tests (console API 404 on school hosts, cookies swapped both ways, platform tables invisible in a school context) and browser test      | Pass                           |
| 4 Console requires TOTP and re-authentication                                                                      | API test (partial session refused, enrolment, replay refused, stale re-auth → `REAUTH_REQUIRED`, fresh re-auth works) and browser enrolment | Pass                           |
| 5 Matrix green; ASVS V2/V3 checklist                                                                               | 61 generated matrix cells; `docs/security/asvs-v2-v3.md`                                                                                    | Pass; checklist lists the gaps |

Also covered: BR-58 (application and database), BR-65 (byte-identical failures), BR-66, BR-67, BR-68 (single use, wrong school), BR-69 (password change and revocation), lockout, CSRF, encrypted email queue, structural RLS checks for every new table, and T-ISO-12 route coverage (now parses Fastify's route tree, so nested routes can't slip through).

## 7. Open items and gaps

1. **D7 (legal)** is still open: the controller role for global accounts, and the consent wording in sign-up (the checkbox text is a placeholder).
2. **PROPOSED, to confirm:** password minimum 10 (ASVS L2 asks 12); rate-limit values; console partial-session and re-auth windows; role-change ends the member's sessions in that school.
3. **Breached-password service** (k-anonymity) needs approval for the outbound call; the offline common-password check is on.
4. **Tenant owner/admin TOTP** (04 §17.5: SHOULD now, MUST before the first external school) is not built; the console has it.
5. **Not in M4:** registration-mode settings UI (the API reads `learnerRegistrationMode` / `allowedEmailDomains`), support access (F44), console staff creation (CLI/seed only), password strength meter and show/hide toggle, email-change flow, account deletion (`accounts.purge`).
6. The rate limiter is in-process (one API instance).
