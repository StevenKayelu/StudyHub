# Design note: deposit payment plans (pay part now, the balance later)

- **Status:** IN PROGRESS (2026-10-20). Scope addition requested by the product owner before M10 is finished. Items marked **PROPOSED** are implementation defaults awaiting the client's confirmation.
- **Changes the blueprint:** 03 §F24 says "one-time purchase only (subscriptions LATER, Q-BIZ-5)". A deposit plan is still a one-time price, paid in two parts; subscriptions, coupons and bundles stay LATER.
- **Baseline:** `m10-wip` commit `e53ece9`. Builds on the M8 fake payment provider only (Q-PAY-3 is still open).

## 1. What the product owner asked for

A school or tutor can let a learner start a paid course with an amount lower than the price. The deposit opens part of the course. The learner pays the rest (the balance) by a deadline to open everything.

Decisions taken with the product owner (2026-10-20):

| Question                    | Decision                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| What the deposit opens      | A **percentage of lessons**, in course order                                                                                 |
| After the deadline (unpaid) | The learner **keeps the deposit part**; the rest stays locked and the balance can still be paid                              |
| Who sets it                 | The **tutor sets the plan on the course**, within **rules the school sets** (on/off, minimum deposit %, maximum days to pay) |
| When                        | Now, before M10 is finished, so M10's hardening covers it                                                                    |

## 2. Model

- **School rules** (commerce settings, S-AD09): `depositPlans = { enabled (default false), minDepositPct (default 20), maxBalanceDays (default 90) }`. With the rule off, no course offers a deposit, and existing plans are kept but not offered.
- **Course plan** (studio pricing, S-T07): `depositMinor`, `depositLessonPct` (1–99) and `balanceDueDays`. All three are set or all three are null (database CHECK). The deposit must be less than the price and at least `minDepositPct` of it; the days must not exceed `maxBalanceDays`. Changing the plan affects new buyers only.
- **Orders:** each order still has exactly one item. `order_item.part` is `FULL`, `DEPOSIT` or `BALANCE`, and `unit_price_minor` is the amount that part charges. Each part is its own order, payment, receipt and (with revenue share) its own instructor SALE entry, so the M8 ledger, refunds, reconciliation, statements and settlement reports work unchanged.
- **Enrolment:** a deposit creates the PURCHASE enrolment with:
  - `access_limit_pct`: the share of lessons open now (null = everything);
  - `plan_lesson_pct`, `balance_minor` and `balance_due_at`: what the learner agreed at deposit time (snapshots: later price or plan changes do not change them);
  - `balance_order_item_id`: set once the balance is paid.
- **Access rule:** with a limit, the open lessons are the first `ceil(total × pct / 100)` lessons in reading order (sections by position, then lessons by position), plus every preview lesson. **PROPOSED:** the count follows the course as it is today, so lessons added later count too. Locked lessons, their videos, files and lesson quizzes return `BALANCE_REQUIRED` (402). **PROPOSED:** question-bank practice and quizzes not attached to an open lesson need the full course.
- **Balance:** `POST /orders` with `part: 'BALANCE'` for a learner whose enrolment has an unpaid balance. The amount is the enrolment's `balance_minor` snapshot. When it is paid, the limit is lifted (`access_limit_pct = null`) and the enrolment keeps its start date and expiry.
- **Deadline:** passing it changes nothing in access (decision above). The learner sees the balance as overdue. **PROPOSED:** a reminder email 3 days before the deadline and one on the deadline, queued when the deposit is paid. The balance is still payable after the deadline.

## 3. Refunds

- **Balance refunded:** the enrolment goes back to the deposit limit (`access_limit_pct = plan_lesson_pct`, `balance_order_item_id = null`); the balance becomes payable again.
- **Deposit refunded:** as today, the enrolment is revoked. **PROPOSED:** refused while the balance is paid. Refund the balance first, so a learner is never left with a paid balance and no access.
- Full refunds only, as in M8.

## 4. PROPOSED decisions (to confirm with the client)

1. Lessons added after the deposit count towards the open share (the percentage applies to the course as it is now).
2. Practice and quizzes outside open lessons need the full course.
3. Two reminder emails (3 days before, on the deadline); no reminders after the deadline.
4. Refunding a deposit is refused while the balance is paid.
5. School rule defaults: off, minimum deposit 20 % of the price, at most 90 days to pay.
6. Receipts show the part ("Deposit" or "Balance") after the course title.
7. HTTP 402 `BALANCE_REQUIRED` for locked lessons, with the balance amount and due date in the problem.

## 5. What was built

- Migration `0011_deposit_plans`: the course plan, `order_item.part` with the deposit plan snapshot, the enrolment's limit, balance and due date, and CHECK constraints keeping each set complete and consistent.
- API: school rules in commerce settings; plan validation in Studio; `POST /orders` with `part`; fulfilment for DEPOSIT and BALANCE; `BALANCE_REQUIRED` (402) on locked lessons, their videos, files, progress and quizzes, and on practice; the `commerce.balance-reminder` job and email; part-aware receipt and refund emails; refunds as in §3.
- Web: deposit fields on the Studio pricing form (within the school rules); "Pay a deposit" and "Pay the balance" on the course page; locked lessons and a balance banner in the player; a "pay the balance" panel on locked lessons; deposit rules in Settings → Payments; the part shown on orders, checkout and receipts.

## 6. Tests

`pnpm verify` passed end to end on 2026-10-20: lint/format, typecheck, boundaries, **417 unit tests** (API 370, contracts 35, UI 12; 11 new for plan and access rules), **924 integration tests in 22 files** (6 new in `deposit-plans.int.test.ts`: rules and validation, the 30 % lesson limit with previews, quizzes and progress, reminders, the balance after the deadline, refund order and restoration, plan snapshots and switching plans off), production build, 8 security browser tests, 62 isolated e2e checks, 198 Storybook checks, OpenAPI and the secret scan.

One earlier full run had an intermittent failure in the existing M8 hosted-card test (`commerce.int.test.ts`, F25 AC 4); it passed alone and in the next two full runs.

Not covered yet: browser (e2e) tests of the new screens, admin order screens showing the part, and a learner-facing quiz page that explains a balance lock (a direct quiz link shows the generic locked panel).
