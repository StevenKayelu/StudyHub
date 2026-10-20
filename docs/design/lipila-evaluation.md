# Lipila payment integration preparation

Reviewed 2026-10-18. The client selected **Lipila** in this session. This records that choice; it does not claim sandbox certification, all Q-PAY-3 conditions, or production approval have been completed. No payment requests or account creation were performed.

## Official API mapping

- [Collections environments](https://docs.lipila.io/docs/collections/collections.html): sandbox `https://api.lipila.dev`; production `https://blz.lipila.io`. `LipilaSandboxClient` fixes its origin to sandbox and cannot be redirected to a live or arbitrary host.
- [Mobile-money collection](https://docs.lipila.io/docs/collections/momocollections.html): map the StudyHub payment reference to `referenceId`, integer ngwee to numeric ZMW units, normalized payer number to `accountNumber`, and description to narration. Authenticate each request with that merchant's `x-api-key`. The returned collection remains a provider observation, not an enrolment instruction.
- [Collection status](https://docs.lipila.io/docs/collections/collection-status.html): query by the original reference. Validate the returned reference, identifier, currency, status and cent precision. A 404 is distinct from provider/authentication/transport failure. Do not automatically retry uncertain POSTs; reference collision/timeout acceptance needs an actual sandbox trial.
- [Webhook security](https://docs.lipila.io/docs/security/webhook-security.html): the helper verifies raw bytes with the decoded 32-byte merchant secret, signed event id and timestamp, HMAC-SHA256, versioned base64 signatures, constant-time comparison and a five-minute past/future window. Multiple rotation signatures are supported. Persist stable event ids for idempotency through the existing payment-event pipeline when the adapter is connected.
- [Callbacks](https://docs.lipila.io/docs/billing/webhook.html): accept only authenticated final collection notifications; disregard disbursements for course access. After authentication, re-query the merchant's collection and compare stored reference, currency and amount before applying the existing order/ledger/access transaction. Callback field descriptions are inconsistent about reference ownership; verify reference correlation in sandbox.
- [Hosted card collections](https://docs.lipila.io/docs/collections/bankcollections.html): the documented request includes customer identity/contact/address fields absent from `StartPaymentInput`. Do not fabricate customer values or collect card details in StudyHub. Confirm required fields/hosted checkout and 3DS flow before extending the shared checkout contract and implementing card support.

## Implementation and verification

The new sandbox client and signature helper live under the existing commerce infrastructure layer. Twelve mocked-HTTP/security tests pass: request mapping, amount precision, per-account authentication, status/reference validation, failure sanitization, no POST retry, unsupported cards, raw-body tampering, wrong secrets, rotation, expired/future timestamps and malformed/irrelevant events. Tests send no requests to Lipila.

The client is **not yet registered in `PaymentGateway` or exposed in account connection forms**. It is preparation for the real adapter, not a completed merchant integration. Existing fake-provider demo flows are preserved. No production guard was weakened and no migration was needed.

## Exact remaining blockers and checklist evidence

| Q-PAY-3 item                     | Current evidence                                             | Remaining work                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider choice                  | Client selected Lipila                                       | Selection recorded; complete capability trial before enabling                                                                                   |
| Merchant credentials             | API key described in official docs                           | Sandbox merchant API key and webhook signing secret, stored through existing encrypted per-school vault; never paste into chat/Git              |
| MoMo / ZMW / networks            | Official collection examples describe network payments       | Test MTN/Airtel/Zamtel success, failure, timeout, late/duplicate notifications, echoed references and duplicate-POST behavior                   |
| Hosted card / 3DS / SAQ-A        | Hosted redirect and extra customer fields documented         | Confirm merchant-required fields, redirect origins and 3DS behavior; decide the minimum additional customer data based on provider requirements |
| Signed events / status           | Implemented helpers match published scheme                   | Verify real sandbox signatures, callback provisioning, retries and authoritative merchant binding; wire full adapter and payment-event tests    |
| Refunds / reconciliation         | No refund endpoint verified in the reviewed collection pages | Obtain provider refund/report documentation or certify existing manual refund and CSV reconciliation fallbacks; do not invent an API            |
| Credentials / settlement / legal | Per-merchant API authentication documented                   | Confirm licensing/education eligibility, KYC lead time, fees and settlement terms, support/SLA and processing locations/DPA in writing          |
| Pilot                            | Not attempted                                                | Later separately authorized M11 production test; live payments are prohibited in current work                                                   |

Next implementation: finish the `PaymentProvider` adapter and connection-test capability gating after credentialed sandbox evidence. Preserve merchant-scoped credentials, host-independent signed routing, server-only status confirmation, idempotency and manual fallback behavior from M8.
