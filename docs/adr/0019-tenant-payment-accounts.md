# ADR-0019: Each school sells through its own payment account

- **Status:** Proposed (built in M8 on the blueprint's recommendation; Q-TEN-4 / Q-BIZ-1 / Q-PAY-1 still need the client's confirmation)
- **Date:** 2026-10-15
- **Blueprint reference:** `docs/blueprint/04-target-architecture.md` §17.10; `docs/blueprint/05-database-and-api.md` §8.2 `payment_account`; `docs/blueprint/08-open-questions-and-decisions.md` Q-TEN-4, Q-PAY-3; `docs/design/m8-commerce-ledger.md`

## Context

Schools sell courses to their own learners. Money can flow (a) straight to each school's own merchant account, (b) through the platform, which then settles to schools, or (c) both. Option (b) may need payment-services authorisation (UNKNOWN) and makes the platform hold school money. No payment provider is approved yet (Q-PAY-3), so only a fake adapter may exist in code.

## Decision

- Each selling school connects **its own** aggregator merchant account (`payment_account`). The platform never holds school money.
- Credentials and the webhook secret are **envelope-encrypted**: a random data key per account (AES-256-GCM) sealed by a key-encryption key (`PAYMENT_ENCRYPTION_KEY`, a KMS later). The school and account ids are bound as additional data. Only a masked hint is ever returned.
- Provider adapters are used **per account**. Webhooks are addressed per account (`/api/v1/webhooks/payments/{provider}/{accountId}`); `resolve_payment_account()` gives only the school, and the signature is verified with that account's own secret inside that school's context.
- A **capability model** records what each account supports (methods, networks, refund API, list and disbursement APIs). Settings and checkout offer only those; missing optional capabilities fall back to manual refunds and recorded payouts.
- Circuit breakers and reconciliation are keyed by account, so one school's failing account never affects another.

## Consequences

- No platform money transmission; each school must complete merchant KYC with the approved provider.
- Instructor earnings (revenue share) are a ledger kept by the school; payouts are recorded, not executed, until a disbursement API is approved.
- A real provider is a new adapter behind the same port, plus its credentials schema; nothing else changes.

## Alternatives considered

- **(b) Platform collects and settles:** simpler onboarding for schools, but the platform holds funds (licensing, liability) and the ledger and reconciliation change.
- **One global provider account with sub-merchants:** depends on provider features not yet validated.

## Revisit when

The client answers Q-TEN-4 with (b) or (c), or the approved provider's capabilities (10 §11) rule out per-merchant credentials.
