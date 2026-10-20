# Staging preparation and launch gates

This is a preparation checklist, not a deployment record. StudyHub is **not production-ready**. No cloud resources, provider accounts or purchases are created by these steps. Track evidence in [production readiness](../design/production-readiness.md) and [M10](../design/m10-hardening.md).

## Decisions and integration prerequisites

- [ ] Confirm Q-OPS-2 region, hosting topology and budget; Q-TEN-6 platform domain and school subdomains; Q-TEN-7 pilot schools and support owner.
- [ ] Supply written payment-provider approval (Q-PAY-3), the completed capability checklist in blueprint 10 section 11, and sandbox credentials through a secret manager. Validate per-school merchant accounts, ZMW/network support, idempotency, signed events, authoritative status queries, refunds and reconciliation before enabling paid courses.
- [ ] Approve a managed video provider and sandbox account. Implement the existing `VideoProvider` port: issuing-member upload authorization, signed playback, verified events, retry/idempotency and deletion. Confirm storage/minute quota behavior.
- [ ] Preserve the production configuration guard. **The current `VIDEO_PROVIDER` enum supports only `fake`, which production rejects.** Production API startup remains blocked until an approved real adapter and configuration exist. Real payment adapters are also absent. Do not weaken startup validation to launch with simulators.
- [ ] Confirm pricing/commission, refund/payout policy, legal texts, controller/processor responsibilities and retention with the relevant owners. Keep existing configurable provisional values identified as provisional.

## Prepare infrastructure and configuration

- [ ] Separate staging accounts, databases, object buckets and provider credentials from production. Never copy real learner/payment data into local browser fixtures.
- [ ] Provision PostgreSQL with the reviewed migrator/runtime/definer role scripts. Runtime roles must remain non-owner, non-superuser and unable to bypass forced RLS. Run migration tooling with the migrator credential only.
- [ ] Prepare the web, API and separate worker processes from the same reviewed commit. Run repository quality gates first. Run `pnpm build`; API migration CLI requires compiled output. Do not run the demo seed in production. After `pnpm db:migrate`, run `pnpm storage:bootstrap` once per deployment storage origin (add `--capture-existing` only after reviewing that existing objects really live in the configured bucket); until then storage fails closed and the API logs an error at startup.
- [ ] Supply environment secrets: runtime/migrator database URLs, independent identity and payment encryption keys with recovery procedures, approved storage credentials, SMTP and approved provider credentials. Never put credentials in Git, logs, screenshots or readiness reports.
- [ ] Configure HTTPS, wildcard school DNS/TLS, console/platform hosts, HTTPS school-link template, allowed trusted reverse-proxy addresses, object-store CORS and exact CSP upload/image/media/frame origins. API rewrites and host configuration are build-time inputs; build for the intended API endpoint. Verify that incoming forwarded-host/nonce headers cannot select another school or CSP policy.
- [ ] Configure `MALWARE_SCANNER=clamd` with a privately reachable clamd host/port, updated signatures, resource limits and monitoring. Verify clean/EICAR/error/timeout behavior against the actual daemon; TCP protocol tests alone do not prove detection or signature freshness.
- [ ] Implement the selected R2 application-managed backup rollout: separate private live/backup buckets and credentials, verified-upload capture/retries, trusted inventory, owner-approved retention/cleanup and recovery access. See [object recovery](../design/object-recovery.md). Verify on real staging R2 before launch; local S3-compatible tests are not provider certification. Disable runtime bucket creation and verify signed transfers/worker processing with staging origin/CSP.
- [ ] Enable shared request-budget enforcement before multiple API instances, or keep one instance and record that limitation. Calibrate school/NAT/account budgets using the documented load profile. Include provider webhook ingress and bulk-job fairness.
- [ ] Configure redacted structured logs, request ids, health/readiness probes, API error/latency/rate-limit metrics, worker backlog/failure alerts, storage/quota and scanner alerts. Verify that each alert reaches the assigned operator.

## Rehearsal and acceptance evidence

- [ ] Run `pnpm test:e2e:isolated` locally after building API/shared packages. It creates fresh services and a separate `.next-e2e` web build; it is not a staging deployment test. Keep build-time configuration for the regular `.next` build intact.
- [ ] Run staging smoke tests for verification/reset email, owner/instructor/learner roles, author/review/upload/publish, enrol/learn/resume, offline assessment sync, platform TOTP, approved sandbox checkout/refund and cross-school denial. Do not run fake-provider browser scenarios against a live merchant account.
- [ ] Run CSP/header checks against staging HTTPS and error responses; verify edge TLS/redirects, nonce uniqueness, private HTML and immutable versioned theme CSS.
- [ ] Run automated accessibility checks plus keyboard, focus, screen-reader and moderated usability checks. Record pages, browsers, assistive technologies and unresolved issues.
- [ ] Exercise Home/Browse/Course public budgets and learner initial JS (170 KB compressed), plus LCP/INP/CLS. Record device/network methodology; a local desktop measurement is not production p75 field evidence.
- [ ] Run API read/write p95 targets (300/500 ms excluding provider time), 50-school/20k-account/500-concurrent profile, 100 concurrent quiz saves and 20 checkouts/minute; include one school's export/bulk jobs while other schools interact. Obtain measurements on the selected launch-size infrastructure.
- [ ] Configure managed PITR (RPO at most 5 min), daily snapshots, protected off-account dumps and asset versioning per blueprint 04. Record who can restore keys and backups. Exercise full and single-school recovery, including object versions and provider reconciliation, with measured RTO at most four hours. See [recovery verification](recovery-verification.md).
- [ ] Finish full ASVS L2 and complete endpoint/table authorization evidence. Resolve critical/high findings; retain explicit, reviewed dependency exceptions. Decide Q-OPS-4 external penetration-test budget.
- [ ] Record a rollback plan, migration compatibility, maintenance procedure, operator training and sign-off before any launch approval. Deployment remains a separate authorized action.
