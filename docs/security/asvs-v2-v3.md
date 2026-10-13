# ASVS 4.0.3 checklist: V2 Authentication and V3 Session Management (M4)

Target level: **L2** (blueprint 04 §14). Status as of M4 (2026-10-13). "Evidence" points at the code or test that shows it; "Gap" items are tracked in `docs/design/m4-identity-realms.md` §7.

Legend: ✅ done · 🟡 partial · ⏳ deferred (planned milestone) · — not applicable.

## V2.1 Password security

| #      | Requirement (short)                                | Status | Evidence / note                                                                                                                                                              |
| ------ | -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.1  | Passwords ≥ 12 characters (after combining spaces) | 🟡     | Minimum is **10** per blueprint 04 §8 (ASVS asks 12). Decision for the client: raise to 12 (one constant, `PASSWORD_MIN_LENGTH`).                                            |
| 2.1.2  | At least 64 characters allowed                     | ✅     | Max 128 (`passwords.ts`)                                                                                                                                                     |
| 2.1.3  | No truncation                                      | ✅     | Argon2id hashes the full string                                                                                                                                              |
| 2.1.4  | Any printable Unicode, incl. spaces and emoji      | ✅     | Length counted in code points; unit test with emoji                                                                                                                          |
| 2.1.5  | Users can change their password                    | ✅     | `POST /me/password`; account page                                                                                                                                            |
| 2.1.6  | Change requires current and new password           | ✅     | `changePassword` verifies the current password                                                                                                                               |
| 2.1.7  | Checked against breached passwords                 | 🟡     | Offline common-password list (always on). A k-anonymity breach-service check is ready behind `BreachedPasswordChecker`; it is an outbound call, so it needs client approval. |
| 2.1.8  | Password strength meter                            | ⏳     | S-A02 calls for a meter; M4 shows the rule as a hint. UI polish item.                                                                                                        |
| 2.1.9  | No composition rules                               | ✅     | Length, email and common/breached only                                                                                                                                       |
| 2.1.10 | No periodic rotation                               | ✅     | None                                                                                                                                                                         |
| 2.1.11 | Paste and password managers allowed                | ✅     | Plain inputs with `autocomplete`                                                                                                                                             |
| 2.1.12 | Show/hide password                                 | ⏳     | UI polish item                                                                                                                                                               |

## V2.2 General authenticator security

| #     | Requirement                                       | Status | Evidence / note                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.2.1 | Anti-automation (rate limits, lockout)            | ✅     | Per IP, per account and per school buckets (`RATE_RULES`); persistent lock after 10 failures (15 min; console: 5 → 30 min). Integration test "locks sign-in after repeated failures". Single-instance limiter: shared store needed before scaling out. |
| 2.2.2 | Weak authenticators (SMS/email) only as secondary | ✅     | Email only for verification and reset links                                                                                                                                                                                                            |
| 2.2.3 | Notify after authenticator changes                | 🟡     | Password change and reset send an email. TOTP enrolment for staff: audit only.                                                                                                                                                                         |

## V2.4 Credential storage

| #           | Requirement                     | Status | Evidence / note                                                         |
| ----------- | ------------------------------- | ------ | ----------------------------------------------------------------------- |
| 2.4.1       | Approved one-way KDF with salt  | ✅     | Argon2id (m = 19 MiB, t = 2, p = 1), per-hash salt                      |
| 2.4.4/2.4.5 | Work factor tuned; extra pepper | 🟡     | OWASP minimum; tune to ~250 ms on production hardware (M11). No pepper. |

## V2.5 Credential recovery

| #     | Requirement                                         | Status | Evidence / note                                                                            |
| ----- | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| 2.5.1 | Recovery secret not sent in clear                   | ✅     | Random 256-bit link token, stored hashed; links sealed (AES-256-GCM) in the email queue    |
| 2.5.2 | No password hints or knowledge questions            | ✅     | None                                                                                       |
| 2.5.3 | Recovery does not reveal the current password       | ✅     | Reset sets a new one                                                                       |
| 2.5.4 | No shared or default accounts                       | ✅     | Demo accounts exist only via `db:seed`, which refuses production                           |
| 2.5.5 | Notify when a credential is changed                 | ✅     | "Password changed" email                                                                   |
| 2.5.6 | Forgotten password uses a secure recovery mechanism | ✅     | Single use, 1 h, generic responses, signs out everywhere (BR-69); tests                    |
| 2.5.7 | Lost OTP: identity proofing                         | 🟡     | Staff have 8 single-use recovery codes; owner-assisted reset is an operations runbook item |

## V2.7–2.8 Out-of-band and one-time verifiers (TOTP)

| #     | Requirement                             | Status | Evidence / note                                                                    |
| ----- | --------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| 2.8.1 | Time-based OTPs have a defined lifetime | ✅     | 30 s steps, ±1 step                                                                |
| 2.8.3 | Approved algorithms                     | ✅     | RFC 6238 HMAC-SHA-1 (authenticator-app compatible); RFC test vectors in unit tests |
| 2.8.4 | OTP usable once                         | ✅     | `totp_last_step` refuses replays; test "the same code can't be replayed"           |
| 2.8.5 | Alert on reused OTP                     | ⏳     | Refused and rate-limited; no alert yet (observability, M10)                        |
| 2.8.6 | Lost device revocation                  | 🟡     | Owner can disable staff (re-auth required); reset of TOTP is a runbook step        |
| 2.8.7 | Biometric                               | —      |                                                                                    |

## V2.9–2.10 Cryptographic verifiers, service authentication

| #      | Requirement                                | Status | Evidence / note                                                                                               |
| ------ | ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| 2.9.x  | Hardware keys                              | —      | Not used                                                                                                      |
| 2.10.4 | Secrets not in source; from a secret store | 🟡     | `IDENTITY_ENCRYPTION_KEY` from the environment; production refuses the public dev key. KMS later (04 §17.10). |

## V3 Session management

| #           | Requirement                                            | Status | Evidence / note                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1       | No session tokens in URLs                              | ✅     | Cookies only. One-time tokens (verify, reset, invitation, hand-off) travel in the URL **fragment**, which is never sent to servers or logs, and are removed from history on load.                          |
| 3.2.1       | New token at authentication                            | ✅     | Every sign-in, join, verification, hand-off and invitation acceptance creates a new session                                                                                                                |
| 3.2.2       | ≥ 64 bits entropy                                      | ✅     | 256 bits                                                                                                                                                                                                   |
| 3.2.3       | Stored securely in the browser                         | ✅     | `__Host-` cookie: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; test asserts the attributes                                                                                                           |
| 3.2.4       | Approved generation                                    | ✅     | `crypto.randomBytes`                                                                                                                                                                                       |
| 3.3.1       | Logout invalidates server-side                         | ✅     | Session row deleted                                                                                                                                                                                        |
| 3.3.2       | Idle and absolute timeouts                             | ✅     | Learners 30 d idle / 90 d absolute; school admins 12 h / 7 d; console 30 min / 12 h                                                                                                                        |
| 3.3.3       | Option to end all other sessions after password change | ✅     | Automatic (BR-69)                                                                                                                                                                                          |
| 3.3.4       | Users can see and end active sessions                  | ✅     | Account page (this school); "Sign out everywhere" (all schools)                                                                                                                                            |
| 3.4.1–3.4.5 | Cookie attributes, `__Host-` prefix, path              | ✅     | See 3.2.3                                                                                                                                                                                                  |
| 3.5.x       | Token-based sessions                                   | —      | Not used (cookies)                                                                                                                                                                                         |
| 3.7.1       | Re-authentication before sensitive actions             | 🟡     | Console: TOTP re-auth within 5 min for sensitive actions (staff disable now; tenant lifecycle and plans when built). Tenant realm: ownership transfer and payment-account changes will require it (M8/M9). |

## Related controls verified in M4

- **CSRF** (V4.2.2 / V13): SameSite=Lax plus an Origin check on every state-changing API call; test "refuses state-changing requests from another origin".
- **Enumeration** (V2/V3 guidance, BR-65/66): identical responses for wrong password, unknown email and non-member; registration and reset responses are generic; tests assert byte-identical bodies (excluding the request id).
- **Tenant binding** (BR-44): a school's session is invisible on another school's host (RLS); tests at API and browser level.
- **Realm separation** (ADR-0017): console API answers only on console hosts; platform tables are visible only in console transactions; tests.
