# Design note: one device at a time for learners

- **Status:** DONE (2026-10-21). Scope addition requested by the product owner before M10 is finished. Decisions 1–4 in §4 were confirmed by the product owner on 2026-10-21; items 5–8 are **PROPOSED** implementation details.
- **Changes the blueprint:** 04 §8 allows any number of sessions per account (D4). Learners now have one per school while the school's setting is on.
- **Baseline:** `course-terms-wip` commit `afabeb3`, branch `single-session-wip`.

## 1. What the product owner asked for

Two students must not share one account. Before this change an account could be signed in on any number of devices at once.

| Question                                   | Decision                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| A second sign-in while signed in elsewhere | **The new sign-in wins.** The other device is signed out on its next request and told why                                          |
| Who it applies to                          | **Learners only** (accounts whose only role in the school is learner). Instructors, administrators and owners keep several devices |
| Can a school switch it                     | **A school setting, on by default** (Admin → Settings → Learners), changed with a reason and audited                               |
| Telling the account owner                  | **An email and an audit entry** each time another device is signed out                                                             |

## 2. Model

- `session.replaced_at`: set on a learner's other live sessions in the school when they sign in again. A replaced session no longer authenticates, but the row is kept until it would have expired, so the device can be told why. Sign-out, password change and admin sign-out still delete sessions as before.
- School setting `singleDeviceLearners` (general settings, default `true`).
- Rule (`identity/domain/single-device.ts`): replace other sessions when the setting is on and every role of the membership is `LEARNER`.
- Every way of signing in creates its session through `SessionService.create`: password, joining a school, email verification, switching schools and accepting an invitation. The rule is applied there, in the same transaction.

## 3. Behaviour

- **Signed-out device:** the API answers as anonymous, clears the cookie and sets `x-studyhub-session-ended: replaced`. The web app sends the person to sign in, which shows "You were signed out. Your account was signed in on another device…".
- **Email** `signed-in-elsewhere` to the account, naming the new device in plain words ("Chrome on Android", never the IP or the raw user agent), with advice to change the password if it wasn't them. It also appears in the notification centre (F33, not optional: it is a security email).
- **Audit:** `auth.sessions_replaced` with the number of sessions and the device.
- **Session lists** (Account → Devices, Admin → Users) leave out replaced sessions.
- Each school is separate: signing in at one school doesn't sign the person out at another (sessions are per school, BR-44).

## 4. Decisions

Confirmed by the product owner (2026-10-21):

1. The newest sign-in wins; the other device is signed out.
2. Learners only.
3. A school setting, on by default.
4. An email and an audit entry when a device is signed out.

Still **PROPOSED** (implementation details):

5. A member who is both learner and instructor counts as staff (several devices).
6. Turning the setting on doesn't sign anyone out by itself; it applies from each learner's next sign-in.
7. Replaced sessions are kept until their normal expiry (then they are like any expired session).
8. Platform support sessions (F44) are separate and unaffected.

## 5. Tests

- Unit: `single-device.test.ts` (who the rule applies to; device names).
- Integration: `single-device.int.test.ts` (the old device is refused with `x-studyhub-session-ended: replaced` and stays out; the new one carries on and lists one device; email and audit; ordinary sign-out isn't "replaced"; instructors and owners keep several devices; turning the setting off, audited). Two older tests that use several devices on purpose (resume on another device, BR-69 password change) now turn the setting off for their school.
- Browser: `single-device.spec.ts` (a second browser signs in; the first is sent to sign-in with the message), with axe.

`pnpm verify` passed on 2026-10-21: 427 unit (API 380, contracts 35, UI 12), 932 integration in 24 files, build, 8 security, 68 isolated e2e, 198 Storybook, OpenAPI, secret scan.
