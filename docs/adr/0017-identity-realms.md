# ADR-0017: Identity realms and the account model

- **Status:** Accepted (client decisions D3, D4 — 2026-10-11). Implementation: M4.
- **Date:** 2026-10-11
- **Blueprint reference:** `docs/blueprint/03-functional-requirements.md` §3, BR-43, BR-65–BR-71; `04-target-architecture.md` §17.5; `docs/design/m2-tenancy-kernel.md` §4

## Context

People belong to more than one school (a learner at a college who also takes a tutoring course; an instructor who teaches at two schools). Platform staff must stay separate from school users.

## Decision

- **Two realms.** Platform staff use separate tables, a separate console host and mandatory 2FA; they can't sign in on school sites and school users can't sign in to the console.
- **One global account per person** (email, password, 2FA) with an explicit **membership** in each school and **roles per membership** (LEARNER, INSTRUCTOR, TENANT_ADMIN, TENANT_OWNER).
- Global identity tables are protected by RLS too: an account is visible only to itself or to the schools it belongs to; credentials only to itself. Sign-in reads credentials only through a SECURITY DEFINER function.
- Sessions are school-owned rows behind host-only cookies, so a session from one school is invalid on another.
- Sign-in happens on the school's own host and requires an active membership there; failures are generic. Switching schools uses a one-time, 60-second, single-use hand-off bound to the target school. Revoking a membership ends that school's sessions immediately.
- User-facing wording is neutral ("your account"); the privacy notice discloses that the account works with other schools on the platform.

## Consequences

- Users manage one password; schools manage memberships and roles, never the global account.
- The platform is likely a data controller for the account record (open legal question D7 / Q-LEG-4).
- Email is the one platform-wide unique value; every flow must avoid revealing whether an email has an account.

## Alternatives considered

Separate accounts per school (stricter separation, but two passwords for the same person and no switching) — rejected by the client in favour of memberships.
