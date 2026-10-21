# Design note: SaaS billing, education payments and Lipila

- **Status:** PHASE 2 DONE (financial foundation), 2026-10-21. Decisions 1–6 in §11 were confirmed by the product owner on 2026-10-21. Phases 3–7 are not started.
- **Brief:** "Configurable multi-tenant SaaS billing, education payments and Lipila integration" (product owner, 2026-10-21), in seven phases.
- **Baseline:** branch `saas-billing-wip` from `m10-hardening-wip` (`69db621`). Blueprint revision 4; this brief answers Q-BIZ-8, Q-BIZ-9 and Q-TEN-4/Q-BIZ-1/Q-PAY-1 ("how money flows": now **configurable per tenant** instead of option (a) only).
- **Gates that stay closed:** live Lipila credentials and real payouts (Q-PAY-3 production approval, M11 pilot); central collection in production until the legal and contractual checks in §6 are done.

## 1. Architecture and repository summary (verified in this checkout)

- **Workspace:** pnpm 12 + Turborepo; `apps/api` (NestJS 11 on Fastify, Prisma 7 with raw SQL migrations in `apps/api/prisma/migrations`, PostgreSQL 17, pg-boss workers), `apps/web` (Next.js 16 App Router, next-intl, server components that call the API), `packages/contracts` (Zod schemas shared by both, OpenAPI generated from them), `packages/ui` (Copperline design system, Storybook with axe). Strict TypeScript; dependency-cruiser module boundaries; `pnpm verify` runs lint, typecheck, boundaries, unit, integration (Testcontainers), build, security and isolated e2e browser tests, Storybook, OpenAPI and a secret scan.
- **Tenancy:** every school table has `tenant_id` and forced row-level security (`tenancy_apply_isolation`); the runtime role `studyhub_app` sees one school per transaction (`app.tenant_id`). Platform tables (plans, platform users, statements, storage locations) are written only in the platform realm (`app.realm = 'platform'`). Cross-school isolation is proven by T-ISO-03 (tables), T-ISO-12 (route inventory) and T-ISO-22 (every endpoint with another school's ids).
- **Roles:** school realm: `LEARNER`, `INSTRUCTOR`, `TENANT_ADMIN`, `TENANT_OWNER` (no parent or finance role yet). Platform realm (console, TOTP): `PLATFORM_OWNER`, `PLATFORM_OPERATOR`, `PLATFORM_SUPPORT` under `/console`. "Super Admin" in the brief maps to `PLATFORM_OWNER` (financial configuration) and `PLATFORM_OPERATOR` (day-to-day billing).
- **Jobs:** pg-boss queues defined in `platform/jobs/boss.ts` (emails, media, commerce events and checks, exports, usage meter, purge); an outbox table feeds them transactionally.
- **Secrets:** payment credentials are envelope-encrypted per row (AES-256-GCM data key sealed by `PAYMENT_ENCRYPTION_KEY`, school and row id as AAD; `payment-vault.ts`). Never returned by any API; masked hint only.

## 2. Existing payment and subscription inventory

| Area                   | What exists                                                                                                                                                                                                                                             | Where                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Education payments     | Orders (one item), payments, payment events, full refunds, receipts (gap-free numbers), idempotency keys, deposit plans (deposit + balance)                                                                                                             | `commerce`, migrations 0008, 0011                      |
| Provider port          | `PaymentProvider` per **school-owned** account: `parseCredentials`, `testConnection` (records capabilities), `startPayment`, `getStatus`, `refund`, `verifyWebhook`, optional `listTransactions`; capability model (BR-62); per-account circuit breaker | `commerce/infra/payment-provider.ts`                   |
| Providers              | Fake adapter (dev/test only, refused in production). **Lipila sandbox client** and Standard-Webhooks verifier exist with 12 mocked tests but are **not registered** in the gateway                                                                      | `fake-payment-provider.ts`, `lipila-sandbox-client.ts` |
| Money flow             | Option (a) only: each school connects its own merchant account; the platform never holds school money                                                                                                                                                   | `payment_account`                                      |
| School-internal ledger | `ledger_entry` (instructor revenue share inside a school: SALE / REFUND / ADJUSTMENT, gross − fee − commission = net, immutable amounts), recorded `payout`s, daily `ledger_check`                                                                      | migration 0008                                         |
| Reconciliation         | W5 status re-checks of pending payments; W7 settlement reports (provider CSV upload or `listTransactions`) matched against payments                                                                                                                     | `reconciliation.service.ts`, `settlement.ts`           |
| Plans                  | Global `plan`: features, limits, `pricing` jsonb (`subscriptionFeeMinor`, `platformCommissionBps`), `ACTIVE/RETIRED`; `tenant.plan_id`; feature overrides                                                                                               | migration 0009, console                                |
| Platform charges       | Monthly `platform_statement` per school: plan fee + commission × (sales − refunds), `DRAFT → ISSUED → PAID / VOID`, frozen once issued; **paid outside StudyHub** (marked paid by staff)                                                                | `console-billing.service.ts`, `statements.ts`          |
| Usage                  | Daily usage meter (learners, instructors, admins, storage, video minutes, emails, payments); limits enforced per plan                                                                                                                                   | `admin/application/usage.ts`                           |
| Tenant lifecycle       | `PROVISIONING → ACTIVE → SUSPENDED / OFFBOARDING → DELETED`; suspended schools are read-only (BR-52); onboarding checklist; purge after grace                                                                                                           | `tenancy`, `console`                                   |

## 3. Gap analysis

| Brief                | Gap                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3 commercial models | One flat `pricing` jsonb per plan: no versions, cycles (quarterly/annual), trials, discounts/coupons, per-student pricing, minimums, allowances, overage, hybrid lines, one-time charges, enterprise contracts                                                                                   |
| §4 separate domains  | Statements mix plan fee and commission; no hosting/maintenance/add-on lines; no invoice lines; SaaS revenue isn't in any ledger                                                                                                                                                                  |
| §5 payment modes     | Only Mode B exists (and only with the fake provider). No central merchant (Mode A), no central collection with settlement (Mode C), no per-tenant mode configuration or migration process                                                                                                        |
| §6 Lipila            | Collection and status client exists, not wired. No disbursement client. No platform-level (non-school) merchant account                                                                                                                                                                          |
| §7 ledger            | No platform double-entry ledger; school ledger covers instructor shares only; no settlement-in-transit, payable, revenue or fee accounts                                                                                                                                                         |
| §8 model             | Missing: plan versions, entitlements per version, tenant subscriptions, service subscriptions, payment configuration, provider transactions at platform level, SaaS invoices and lines, allocations, journals, settlements and items, usage snapshots, billing attempts, platform webhook events |
| §9 dashboards        | Console has plans and statements; school Billing shows statements. No plan builder, invoice preview, analytics, plan comparison or settlement views                                                                                                                                              |
| §10 lifecycle        | Activation and suspension are manual console actions; nothing ties them to payment, renewal, grace or dunning                                                                                                                                                                                    |
| §11 controls         | Approvals for high-risk money operations, finance role, payout limits: missing                                                                                                                                                                                                                   |

Not gaps (reuse, don't duplicate): school education checkout, receipts, refunds, deposit plans, envelope encryption, capability model, circuit breaker, webhook pipeline, idempotency keys, audit logs (school and platform), usage meter, plans and feature overrides, lifecycle states.

## 4. Lipila capability assessment (official docs, re-read 2026-10-21)

Sources: `docs.lipila.io` pages Overview, Secrets and API keys, Transaction types, Collections, MoMo collections, Collection status, Disbursements, MoMo disbursements, Bank disbursements, Disbursement status, Wallet balance, Charges, Settlements, Webhook (now `/docs/billing/webhook.html`; the brief's `/docs/gettingstarted/webhook.html` shows the docs home page) and Webhook security.

### 4.1 Verified from the documentation

- **Environments:** sandbox API `https://api.lipila.dev` and dashboard `dashboard.lipila.dev`; production API `https://blz.lipila.io` and dashboard `dashboard.lipila.io`. Test and live keys are separate; the wrong key gives 401.
- **Authentication:** `x-api-key` header with a secret key (`Lsk…`) found under the wallet's details in the merchant dashboard. The key "identifies which merchant account the request belongs to".
- **Collections:** `POST /api/v1/collections/mobile-money` with `referenceId`, `amount` (number, major units), `narration`, `accountNumber`, `currency`, optional `email`, `referenceData`; optional `callbackUrl` **header**. Response `status: Pending`, `identifier`. Card collections are a hosted redirect (`cardRedirectionUrl`) and need customer identity and address fields.
- **Collection status:** `GET /api/v1/collections/check-status?referenceId=…`; 404 when unknown.
- **Disbursements:** `POST /api/v1/disbursements/mobile-money` (`referenceId`, `amount`, `accountNumber`, `currency`, optional `narration`, `referenceData`) and `POST /api/v1/disbursements/bank` (adds `swiftCode`, names, account holder, phone). Response `status: Pending`. Requires an **activated account with documents** and the server's outbound **IP whitelisted** per wallet.
- **Disbursement status:** `GET /api/v1/disbursements/check-status?referenceId=…`.
- **Wallet balance:** `GET /api/v1/merchants/balance` (one wallet, the key's).
- **Callbacks:** sent only for final states (`Successful`, `Failed`), for both `Collection` and `Disbursement`; fields include `referenceId`, `identifier`, `amount`, `currency`, `status`, `type`, `externalId` (network transaction id).
- **Webhook security:** Standard Webhooks: `webhook-id` (stable across retries; the idempotency key), `webhook-timestamp`, `webhook-signature` (`v1,` base64 HMAC-SHA256 of `id.timestamp.rawBody`), one 32-byte secret **per merchant** from Settings → Webhooks, 5-minute tolerance, 24-hour dual signing during rotation. (The existing verifier implements exactly this.)
- **Settlement:** Lipila settles the merchant's wallet to **the merchant's own bank account**, automatically on a schedule, with a published fee table (K5 to K200 by amount).

### 4.2 Not supported by anything documented

| Capability                                          | Finding                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1. Multiple merchant accounts under one integration | No partner or platform API. Each key belongs to one merchant/wallet; a platform can hold several merchants' keys, one per request |
| 2. Third-party authorization / account linking      | **None** (no OAuth, connect flow or delegated keys). The only way is a school pasting its own API key and webhook secret          |
| 3. Collect into a tenant-owned wallet               | Yes, but only by calling with **that tenant's** key (Mode B)                                                                      |
| 4. Transfers between wallets                        | "Transfer" and "Allocation" are named as transaction types; **no endpoint is documented**                                         |
| 5. Automatic split payments                         | **Not documented**                                                                                                                |
| 6. MoMo disbursement to tenant beneficiaries        | **Documented** (to any mobile-money number or bank account); no beneficiary-ownership check is offered                            |
| 7. Settlement schedules                             | Merchant's own bank only; configured outside the API (dashboard/support); no settlement to third parties                          |
| 8. Webhook authentication                           | Documented (above); **retry schedule and expected response not documented**                                                       |
| 9. Status and reconciliation                        | Per-transaction status checks only; **no transaction list or report API**; **no refund API**                                      |

### 4.3 Needs written confirmation from Lipila

1. Whether a platform may store and use schools' API keys (Mode B) under Lipila's terms, and whether a "platform/partner" arrangement exists.
2. Transfer/allocation API between merchant wallets (would enable Mode C without disbursement fees and beneficiary risk).
3. `referenceId` uniqueness and duplicate-POST behaviour (idempotency), and the full status vocabulary.
4. The callback field semantics: the webhook page calls `referenceId` "Lipila's transaction ID" and `identifier` "your system's ID"; the collection pages show the opposite. Must be settled in sandbox before correlating callbacks.
5. Webhook retry schedule, required response code and whether callbacks are per request (`callbackUrl` header) only or also configured in the dashboard.
6. Disbursement limits, fees, IP whitelisting for multiple outbound addresses, and whether provider fees are returned per transaction.
7. Refund support (none documented) and a statement/report export for reconciliation.
8. Licensing: whether holding schools' funds (Modes A/C) requires the platform to be authorised (e.g. as a payment aggregator under Bank of Zambia rules). **Legal question, not answered here.**

## 5. Proposed domain model

### 5.1 Accounting approach (PROPOSED)

A **platform ledger** in the platform realm, **double-entry, append-only**: `ledger_journal` (one business event) with ≥ 2 `ledger_line`s whose debits equal credits per currency (deferred constraint trigger). Integer minor units (`BIGINT`), explicit `CHAR(3)` currency, half-up rounding to the minor unit at each line (documented per calculation). Corrections are reversing journals, never updates. The existing school `ledger_entry` (instructor shares inside a school) stays as it is.

Chart of accounts (system accounts, some per tenant via `tenant_ref`):

| Account                                                                                                                                 | Type      | Per tenant                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------- |
| `cash.provider:{merchant}` (platform Lipila wallet)                                                                                     | asset     | no                            |
| `receivable.saas`                                                                                                                       | asset     | yes                           |
| `settlement.in_transit`                                                                                                                 | asset     | yes                           |
| `unreconciled`                                                                                                                          | suspense  | no                            |
| `payable.tenant_funds`                                                                                                                  | liability | yes                           |
| `liability.refunds`                                                                                                                     | liability | yes                           |
| `revenue.licence`, `revenue.hosting`, `revenue.maintenance`, `revenue.services`, `revenue.usage`, `revenue.setup`, `revenue.commission` | revenue   | no (lines carry `tenant_ref`) |
| `expense.provider_fees`                                                                                                                 | expense   | no                            |

Key postings: SaaS invoice issued (Dr receivable / Cr revenue.* by line); SaaS payment (Dr cash / Cr receivable; fee Dr expense / Cr cash). Central education collection (Dr cash gross / Cr payable.tenant_funds net-of-commission / Cr revenue.commission; fee per contract to tenant or platform). Settlement sent (Dr payable / Cr in_transit); settlement confirmed (Dr in_transit / Cr cash); failed (reverse). Tenant-owned (Mode B) education payments never touch platform cash: the platform only accrues its commission (Dr receivable / Cr revenue.commission) and invoices it.

### 5.2 Tables (adapting the brief's list; platform realm unless marked "school")

- `commercial_plan` (replaces nothing; `plan` remains the **feature/limit** catalogue and gains `commercial_plan_id`): code, name, audience (tenant kinds), visibility (public / contract-only), status.
- `commercial_plan_version`: immutable once referenced by an issued invoice; currency, cycle (`MONTH`/`QUARTER`/`YEAR`), trial days, grace days, and `components` (typed jsonb validated by a shared Zod schema): `FIXED` (licence, hosting, maintenance, service), `PER_STUDENT` (unit price, billable-student rule, included allowance, minimum, overage tiers), `REVENUE_SHARE` (bps, fixed fee per transaction, minimum, eligible payment types, refund and fee treatment), `ONE_TIME` (setup, branding, custom development, licence with `licenceType` and explicit obligations), `ADDON`. Allowed payment modes.
- `plan_entitlement` folds into the version (feature keys and limits), mapped onto the existing feature/limit engine.
- `tenant_contract` (enterprise or standard): tenant, plan version, negotiated overrides (component-level, audited), discounts and coupons, billing anchor, start/end, status.
- `tenant_subscription`: state machine `TRIALING → ACTIVE → PAST_DUE → SUSPENDED → CANCELLED` (+ `PENDING_PAYMENT`), current period, next invoice date, cancel-at-period-end.
- `tenant_service_subscription`: hosting, maintenance, domain, SMS/email/video, premium features; each with its own component and suspension behaviour.
- `usage_snapshot`: per tenant per billing period, frozen counts (billable students by rule, storage, video minutes, messages) with the rule version used.
- `saas_invoice` and `saas_invoice_line` (immutable after issue; number sequence per platform per year; void + credit note for corrections). Existing `platform_statement` rows stay readable; new periods use invoices.
- `tenant_payment_configuration` (school): mode `TENANT_MERCHANT` (B) / `PLATFORM_MERCHANT` (A) / `PLATFORM_COLLECT_SETTLE` (C), status, verification, effective from, pending-change record; the allowed set comes from the contract.
- `platform_merchant_account`: the platform's own Lipila account(s) (same envelope encryption, platform realm).
- `provider_transaction` (platform): every collection and disbursement against a platform merchant, unique `(merchant, provider_reference)`; purpose (`SAAS_INVOICE`, `EDUCATION`, `SETTLEMENT`), tenant, linked invoice/order.
- `platform_webhook_event`: unique `(merchant, webhook_id)`.
- `payment_allocation`: how a central collection splits (gross, provider fee, platform fee, tenant entitlement) with the rule version.
- `settlement` and `settlement_item` (platform): payout to a tenant beneficiary built from allocations; statuses `DRAFT → APPROVED → SENT → SUCCEEDED / FAILED / REVERSED`; dual approval above a limit; one provider reference per attempt; never resent without a status check.
- `tenant_beneficiary` (school, encrypted): mobile-money or bank details, verification state (owner confirmation + test micro-disbursement, **PROPOSED**), cooling-off period after changes.
- `billing_attempt`: each charge attempt of an invoice (dunning).

Constraints: tenant isolation (RLS for school tables; `tenant_ref` + platform realm for platform tables), unique provider references, idempotent webhook rows, no `DELETE` grants on financial tables, immutability triggers on issued invoices, used plan versions and ledger lines.

## 6. Payment modes (how they map onto Lipila)

| Mode                                   | Money path                                                            | Lipila basis                                                                    | Enable when                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **B: tenant-owned merchant**           | Learner → school's Lipila wallet; Lipila settles to the school's bank | Collections + status + webhooks with the **school's** key and secret (verified) | Lipila confirms a platform may hold merchants' keys (4.3 #1); sandbox certification                                                |
| **A: central platform merchant**       | Learner → platform wallet; the school's share is paid out             | Collections with the **platform's** key (verified); payout needs a disbursement | Same as C (in Lipila, A and C use the same mechanism)                                                                              |
| **C: central collection + settlement** | Learner → platform wallet → disbursement to the school's beneficiary  | MoMo/bank disbursements + status (verified); no transfer or split API           | Legal authorisation (4.3 #8), contract, disbursement activation + IP whitelisting, beneficiary verification, sandbox certification |

Because Lipila has no split or wallet-transfer API, **Modes A and C are one implementation** ("central collection"); they differ only in settlement policy (automatic schedule vs manual approval). Capability flags keep them **off** until each gate is recorded by a platform admin.

SaaS invoices are always collected with the **platform's** merchant (the school pays the platform), whatever the school's education mode.

Switching mode: a `payment_mode_change` with checks (no pending payments, deposit balances, unsettled funds, open refunds), an effective date, and an audit trail; never silent.

## 7. APIs and UI (summary)

- **Console (platform staff):** commercial plans and versions (draft → publish → archive) with an invoice preview; tenant billing (contract, subscription, invoices, payments, balance, adjustments with reason, approved discounts); payment modes per tenant; platform merchant accounts; settlements (approve, send, status, failures); reconciliation exceptions; revenue analytics (§9 metrics, cash vs accrual clearly separated).
- **School (owners, a new `FINANCE` permission for admins, PROPOSED):** plan and services, compare and request change, invoices and receipts, pay an invoice, payment mode and merchant connection (Mode B), beneficiary details (Modes A/C), settlements and statements, usage and extra charges, CSV exports.
- All writes server-validated (Zod contracts), tenant from the host/session only, never from the body.

## 8. Security and financial controls

Server-side tenant authorization everywhere (existing T-ISO suites extended to every new route and table); webhook verification per merchant with replay window and stored `webhook-id`; database-unique provider references and idempotency keys; amounts, currency, reference, tenant and purpose re-checked against an authoritative status call before posting; envelope-encrypted credentials and beneficiaries, redacted logs; rate limits (existing); audit entries (school and platform) for plan, commission, discount, refund, settlement and override changes; dual approval for settlements and manual adjustments above configurable limits; serializable or row-locked postings; reconciliation jobs (pending collections, uncertain payouts, wallet balance vs ledger); alerts on webhook failures and mismatches; no PIN collection anywhere.

## 9. Phased plan

| Phase                      | Deliverable                                                                                                                                                                                                                               | Depends on Lipila / legal      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 2 Financial foundation     | Migrations for plans/versions/contracts/subscriptions/usage snapshots/invoices/lines and the platform double-entry ledger; pure pricing engine (all models, rounding, proration, discounts); invoice generation from versions + snapshots | No                             |
| 3 Subscriptions            | Subscription state machine, recurring invoice job, entitlements onto the existing feature/limit engine, activation/suspension via the existing lifecycle, grace and dunning                                                               | No                             |
| 4 Lipila collections       | Register the Lipila adapter (collections, status, webhooks) for school accounts (Mode B) and platform merchant accounts (SaaS invoices); sandbox test suite gated by env                                                                  | Sandbox credentials            |
| 5 Payment modes            | Payment configuration, mode change process, central collection with allocations (behind flags)                                                                                                                                            | Gates in §6 to enable          |
| 6 Dashboards               | Console plan builder, billing and analytics; school billing, plan comparison, payment mode and beneficiary pages                                                                                                                          | No                             |
| 7 Settlement and hardening | Disbursement adapter, settlement batches, approvals, reconciliation jobs, alerts, runbooks                                                                                                                                                | Disbursement activation, legal |

## 10. Acceptance and testing strategy

Pure unit tests for the pricing engine (every model, cycle, proration, discounts, rounding, currency) and ledger balancing; integration tests (Testcontainers) for invoices, subscriptions, idempotent webhooks (duplicate, forged, late, out of order), allocations, settlements (failed, duplicate, uncertain), refunds, isolation (T-ISO-03/12/22) and immutability triggers; mocked-HTTP adapter tests; **sandbox** tests only when `LIPILA_SANDBOX_*` variables are set (skipped otherwise, never live keys); browser tests with axe for each new screen. The acceptance criteria are the brief's §15; each phase reports `pnpm verify` results.

## 11. PROPOSED decisions (need product-owner confirmation)

1. Platform ledger is double-entry and separate from the school instructor ledger.
2. Modes A and C share one implementation on Lipila (no split or transfer API).
3. SaaS invoices are paid to the platform's own Lipila merchant; statements before this change stay as they are.
4. A new school-side `FINANCE` permission for admins who handle billing (owners always have it).
5. Beneficiary verification: owner confirmation plus a small test disbursement, and a cooling-off period after changes.
6. No VAT is computed yet; invoice lines carry an optional tax rate and the platform's tax details once Q-LEG-3 is answered.

## 12. Phase 2: what was built (2026-10-21)

**Migration `0015_saas_billing_foundation`** (no change to existing data):

- `commercial_plan`, `commercial_plan_version` (status `DRAFT → PUBLISHED → ARCHIVED`; a trigger refuses any change to a published version except archiving), `tenant_contract` (terms freeze once `ACTIVE`; one active contract per school), `usage_snapshot` (insert only), `saas_invoice` + `saas_invoice_line` (amounts and lines freeze once issued; issuing checks the totals against the lines; one live invoice per contract period), `saas_invoice_sequence` (gap-free `SAAS-{year}-{000001}` numbers), and the platform ledger `platform_ledger_account` (16 seeded accounts), `platform_ledger_journal`, `platform_ledger_line` (one-sided positive lines, journal currency, per-school accounts must name the school, **balanced at commit** by deferred constraint triggers, **append-only** by trigger, at most one journal per business event and one reversal per journal).
- All are **platform records named by `tenant_ref`**, so a school's offboarding purge keeps them. Row-level security is forced on every table: the platform realm writes; schools read their own contracts, snapshots, invoices and lines (`school_read`); published plans are readable for comparison. No table is granted `DELETE`.
- The structural isolation checks (T-ISO-03, T-ISO-21) list each new table with its reason, and now also verify that the four school-readable tables keep a SELECT-only policy keyed on `tenant_ref = app.tenant_id` and no personal columns.

**Pricing engine** (`billing/domain`, pure): fixed components (licence, hosting, maintenance, services, add-ons), per-student (two counting rules, allowance, overage threshold and rate, minimum), revenue share (bps on eligible parts, refunds and optional provider fees deducted, per-transaction fee, minimum), one-time charges with explicit licence terms (source code, hosting and maintenance never implied), hybrid plans, contract overrides (enterprise contracts may add components), discounts (percentage or amount, by component, for N invoices, capped, never below zero), monthly/quarterly/yearly cycles on an anchor day, day-based proration, half-up rounding in integer minor units.

**Services and console API** (`/console/billing/...`, owners set prices, owners and operators run billing, money-changing actions need a fresh TOTP re-authentication, everything audited in the platform log and, for contracts and issued invoices, in the school's): plans and versions (create, edit draft, publish, archive, invoice preview), contracts (create with validation of audience, currency, overrides, add-ons and discounts; activate, ending the previous one), invoices (draft in arrears from a frozen usage snapshot, issue with number, due date and ledger journal, void with a reversing journal), trial balance (all or one school).

**PROPOSED in phase 2:** billing in arrears (an invoice is drawn up after its period ends, including fixed fees); a trial ending inside a period prorates fixed fees from that day but charges per-student usage in full; invoice number prefix `SAAS`; `ACTIVE_LEARNERS` counts current membership status at snapshot time (snapshots are taken when a period closes).

**Not yet (later phases):** subscriptions and their lifecycle, automatic period-end invoicing, payment of invoices, school-facing billing screens, console screens (the API exists), payment modes, Lipila. `platform_statement` rows are still deleted by a school purge (not archived): changing `purge_tenant` needs the definer role and is left for phase 3.

**Tests:** 23 unit tests (`periods.test.ts`, `pricing.test.ts`: every model, proration, rounding, discounts, ledger posting and reversal) and 8 integration scenarios (`billing.int.test.ts`: role and re-authentication gates, version immutability in the API and the database, contract rules and frozen terms, an invoice from real learners, enrolments, payments and a refund priced to the ngwee, issue with balanced postings, append-only and balance-at-commit ledger, void with reversal and re-invoicing, school read-only access and isolation).
