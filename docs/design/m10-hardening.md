# M10 design note: hardening and isolation verification

- **Status:** IN PROGRESS (reviewed 2026-10-18). Items marked **PROPOSED** are implementation defaults awaiting validation; M10's definition of done is not met.
- **Latest verified gates:** 345 unit tests, 882 integration tests, 59 full-stack isolated browser checks plus one separate learner-JS check, eight CSP/security browser tests, the disposable full database restore and the two-school HTTP smoke pass. Production build, audit and source secret scan pass. See the [requirement/evidence checklist](production-readiness.md) for current versus historical results and the [staging checklist](../runbooks/staging-readiness.md). Single-school/object recovery, complete semantic authorization, full capacity/fairness, ASVS and staging/production certification remain open.
- **Baseline:** M9 commit `c9fde52`; blueprint revision 4 (03 NFR-PERF-1..3, NFR-DR-1, NFR-ISO-2, NFR-CAP-2; 04 §14, §17.11, §17.13, §17.16; 07 §M10, §3).
- **Scope (07 §M10):** ASVS L2; multi-tenant load test (NFR-CAP-2); performance budgets; accessibility audit; restore drill including single-tenant restore (04 §17.16); isolation review (IDOR, host-header spoofing, cache poisoning, webhook confusion, support-grant abuse); noisy-neighbour test; external penetration test if budgeted (Q-OPS-4).
- **DoD:** 1) no open critical or high findings; 2) the isolation suite covers 100% of tables and endpoints; 3) RTO is measured.

## 0. Gates and limits of a local milestone

- **No staging or production exists** (Q-OPS-2, Q-TEN-6 unanswered). Load, restore and performance figures are measured on the development machine against Docker Compose services. They show relative behaviour and find bottlenecks; they are **not** launch-infrastructure numbers. The scripts are written to run unchanged against staging.
- **External penetration test (Q-OPS-4):** not budgeted; not run.
- **Manual screen-reader testing and moderated usability (UX-14, UX-17):** need people; not run. Storybook axe checks cover stories, not every application page; full-page coverage remains to be verified.

## 1. Findings tracked during M10

| #    | Finding                                                                                                                                                                | Severity                     | Resolution                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------- |
| F-01 | No security headers on API or web responses: no CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors`, `Referrer-Policy` (ASVS V14.4)                                 | High                         | §3                                |
| F-02 | Rate limits exist only on authentication; no per-school or per-client limit on the rest of the API (NFR-ISO-2, 04 §17.11)                                              | High                         | §4                                |
| F-03 | The cross-tenant API suite calls every route on two hosts without ids; it does not call every endpoint **with the other school's ids** as each role (04 §17.13 item 3) | High (DoD 2)                 | §2                                |
| F-04 | No single-tenant restore tooling (04 §17.16)                                                                                                                           | Medium (DoD 3)               | §5                                |
| F-05 | No multi-tenant load test, noisy-neighbour test or JS budget check                                                                                                     | Medium                       | §6                                |
| F-06 | API sharp 0.34.4 brought three unexcepted high native-library advisories                                                                                               | High                         | §7; patched to 0.35.5             |
| F-07 | Development video upload signed a completion event without binding the provider id to its issuing school/member                                                        | Development isolation defect | §2; ownership authorization added |

## 2. Isolation suite: every endpoint (T-ISO-22)

Existing staged work is preserved: fixtures were extracted from `tenancy-isolation.int.test.ts` to `tenant-fixtures.ts`, and `cross-tenant-endpoints.int.test.ts` adds real school-A ids, school-B actors, leak markers, row snapshots and route-parameter coverage checks. The fixture extraction and the SQL isolation matrix remain in place. The index has not been changed; additional working-tree changes now strengthen that staged endpoint suite as described below.

**Runtime access recovered during the endpoint-isolation pass (2026-10-18):** Testcontainers can now start disposable PostgreSQL instances even though the Docker CLI is not on PATH. The focused T-ISO-22 matrix passes, as do the three T-ISO-23 video ownership integration tests. Do not equate route enumeration with 100% semantic isolation coverage: seventeen mutation routes now have schema-valid targeted bodies; the rest still need route-specific input/foreign-reference review, including mixed local-parent/foreign-child cases.

The matrix now includes anonymous, learner, instructor, administrator and owner actors, and actually checks console exclusion both without a cookie and with an owner session. A real pending foreign provider video id replaces the invented unknown id. HTTP failures (5xx), throttling and unexpected `VALIDATION_FAILED` responses to schema-valid probes are failures, not evidence of isolation. The documented Studio subject lookup's field-level `subjectId/not_found` is accepted as an explicit foreign-reference denial; arbitrary invalid fields are not.

Execution exposed test defects that are now fixed: short numeric sequence ids (such as `3`) matched ordinary HTTP errors/request ids as apparent leaks; a self-leave call removed the actor before subsequent probes; all actors shared a password-reset address and hit the real email rate limit; the policy fixture's intentionally invalid payment ciphertext failed before signature verification. Scanning now uses UUIDs/distinctive text while full table snapshots still protect writes, self-leave runs once at the end, probe addresses differ per actor, and the HTTP payment account uses real envelope encryption. The original SQL fixture remains unchanged. Empty/HTML responses are not parsed as JSON.

**Development video authorization defect fixed:** the fake upload controller formerly accepted a signed-in member and signed a provider event for a client-supplied id after clearing the tenant context. It now calls `MediaService.authorizeVideoUpload` before signing: a tenant-scoped query requires the resolved tenant id, issuing membership, provider, video kind and lesson-video purpose. No match returns NOT_FOUND. Production still rejects this development endpoint. A regression test failed on the old implementation (unauthorized request returned `uploaded`); controller/service tests now pass, and PostgreSQL tests verify foreign roles and same-school nonowners cannot change the asset/usage while the issuer can complete/retry idempotently.

OpenAPI generation currently documents only 35 paths (operations and identity); it is not a complete M5–M9 route inventory. Isolation enumeration uses the application's registered routes instead. Completing OpenAPI coverage is a documentation/verification gap, not a reason to report 100% endpoint assurance.

**Further endpoint coverage (2026-10-18):** targeted schema-valid mutation bodies now cover 24 routes, adding order creation, provider-refund requests, payment-exception acceptance, question creation/replacement, manual grading and practice startup. These probes run for all five existing school actor variants and reject unexpected validation errors, throttling and server failures. A separate mixed-parent regression creates an instructor-owned local course, proves the actor can add a local section, then requires 404 for PATCH/DELETE of foreign sections and lessons under that local course. Foreign-school snapshots and the local course row remain unchanged. This is a focused mixed-parent check, not exhaustive nested-resource coverage.

The shared functional-test harness uses explicitly generous API-wide budgets so large isolation matrices reach their target handlers instead of obtaining false reassurance from generic 429 responses. Tests may override these values; production defaults remain enabled.

## 3. Security headers (F-01)

**Implemented locally; full authoring/provider and staging verification still pending.** Web responses now enforce a CSP with a fresh random 256-bit script nonce and `strict-dynamic`. The proxy replaces incoming nonce/CSP headers before rendering. The root layout is explicitly dynamic; nonce-bearing responses are private/no-store, so HTML must not be served through ISR or shared CDN caching. This follows [Next.js's nonce guidance](https://nextjs.org/docs/app/guides/content-security-policy).

Common API/web headers are `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a Permissions Policy disabling camera/microphone/geolocation/Payment Request API. Production sends one-year HSTS without includeSubDomains or preload. Non-loopback production web CSP upgrades insecure subresources. HTTPS listener/redirect configuration remains a staging/edge responsibility; it was not deployed or tested here.

The web policy blocks object embedding, external base URLs, cross-origin form actions and framing of StudyHub. Provider frames default to none. External connection/image/media/frame sources use separately configured `WEB_CSP_*_ORIGINS` exact-origin allowlists; wildcard hosts, injected directives, credentials and non-origin paths are rejected. HTTP is allowed only for loopback services; local hosts allow SeaweedFS at `127.0.0.1:8333`. Production has no unsafe-eval; development permits it and local HMR WebSockets.

Inline **styles** remain allowed for dynamic branding, React/Radix positioning and Tiptap editor CSS. This exception does not allow inline scripts. Styling compatibility is not a claim of a strict style-nonce policy. The API has its own script-denying CSP; its development hosted-card HTML can retain CSS and same-origin POST forms. Web API rewrites leave that policy to the upstream API.

Security headers also cover proxy early errors, API malformed bodies/404/429/500, maintenance responses and Next static assets. Browser testing found a pre-existing maintenance failure: Next's loopback hostname canonicalization turned the maintenance rewrite into an external HTTP request, which the internal-route guard rejected. `skipProxyUrlNormalize` plus a native URL preserves the server origin; the guard remains unchanged.

`pnpm test:security` runs the production standalone web app on ports 3300/3301 against a contract-validated fixture API on 4400 and upload fixture on 4401. Browser API submissions are intercepted and forwarded only to the fixture, since the build-time API rewrite may target a running developer service. Servers are never reused. This suite tests CSP, nonce freshness/spoof resistance, parser-injected script/frame blocking, school/console form hydration, client navigation, upload allowlists, maintenance/error responses and static headers. It does **not** test real account authentication, full authoring, real object storage or provider integration. It is included in `pnpm verify` and CI.

## 4. Per-school and per-client API limits (F-02)

**Implemented for one API process; load calibration and application integration verification remain pending.** `api-rate-limit.hook.ts` registers:

- A trusted-client-IP budget before host resolution, including unknown hosts/routes and provider webhooks. Uses Fastify's `request.ip` and the existing `TRUSTED_PROXIES` configuration, not a raw forwarded header.
- A school budget immediately after host resolution and before session lookup, keyed by the resolved tenant id so aliases share a budget.
- An authenticated-account budget in `preHandler`, keyed by school and account, or by platform realm and staff account. Existing stricter authentication limits continue to apply.

Exhaustion returns uncached RFC 9457 `RATE_LIMITED` (429), `Retry-After`, and the request id. Exact GET/HEAD `/healthz` and `/readyz` paths are exempt so monitoring stays available. Webhooks receive the IP budget; their school is resolved later by their handler, so they do not yet have a per-account/tenant ingress budget.

The existing in-process `RateLimiter` no longer clears all live counters at capacity. It removes expired entries, preserves live budgets, and rejects new keys until space expires. This bounds memory without allowing high-cardinality traffic to reset active limits. At capacity, new legitimate keys can also be denied: monitor and size this protection against staging traffic.

Fastify HTTP-injection tests (no database mocks required for the HTTP server) cover 429 bodies/headers, expiry, forwarded-IP spoofing and trust, school aliases/isolation, member and staff accounts across IPs, webhook/unknown-route limits, health exceptions and capacity churn. Configuration tests verify defaults and reject zero, negative, fractional, nonnumeric and excessive limits.

## 5. Restore drill and single-tenant restore (F-04)

**PARTIAL.** A full logical database rehearsal restores only into a newly allocated disposable target and checks all 67 public-table hashes plus forced RLS/roles. The earlier validated local RTO was 6.388 s with tiny synthetic fixtures. A subsequent reviewed single-school content importer now passes eight database-backed checks (see latest pass below); it deliberately supports only existing course/section/text-lesson content, not whole-school rollback. No existing database was restored or cleared. Deleted-record recreation, broader school data and object-version recovery remain open; the F46 export is not round-trip backup data. See [recovery verification](../runbooks/recovery-verification.md). Managed PITR/RPO and staging RTO remain unverified.

## 6. Load, noisy neighbour and budgets (F-05)

**PARTIAL.** A two-school real TCP/PostgreSQL read-only smoke passes: 300 noisy requests, 200 throttled; 60 other-school reads all succeed with 38.6 ms p95 (12.1 ms baseline). This is not export/worker fairness or the 50-school/20k-account/500-concurrent profile. Homepage Lighthouse passes at 2310 ms LCP and 148 KB JS; a separate cold learner-course check measures 150438 encoded JS bytes (146.9 KB), below 170 KB. Browse/Course coverage, write p95 and representative staging capacity remain open.

## 7. ASVS L2 and isolation review

The existing `docs/security/asvs-v2-v3.md` is an M4 evidence checklist, not a complete L2 audit. Keep its password-policy, breach-check, TOTP-notification, recovery and scaling gaps visible. Business/legal defaults and security-policy decisions were not changed. The earlier network-blocked audit is superseded by the completed check below.

**Dependency audit update (2026-10-18):** network access recovered. The audit reported three unexcepted high findings against the API's `sharp@0.34.4` native image dependencies. The direct dependency is now pinned to **0.35.5**, already present elsewhere in the lockfile; obsolete 0.34.4 binaries are removed. The audit passes with the one existing documented development-only exception unchanged. Native PNG decode → resize → WebP encode passed on sharp 0.35.5/libvips 8.18.7. See `docs/security/dependency-audit.md` for advisory references and final validation.

## 8. PROPOSED decisions

Operational starting budgets per minute: IP **600**, school **6000**, authenticated account **300**. They are positive, startup-validated environment settings (`API_RATE_*_PER_MINUTE`), documented in `.env.example`; tune with staging load including shared school NAT and quiz autosave. No business/pricing/retention/legal decision is required to implement these controls.

Counters are process-local, matching the existing architecture. A shared limiter store or equivalent gateway enforcement is required before multiple API instances; these counters do not establish distributed protection. Hosting/domain/region, real provider approval, legal responsibilities and retained-data policy remain separate launch decisions.

## 9. Tests

### Initial checks, 2026-10-18

- No `AGENTS.md` was found in the repository or its checked ancestor locations (`C:\`, `C:\dev`). Read the M10 note, local-development runbook, ASVS V2/V3 checklist, dependency-audit note, and relevant blueprint security/isolation requirements.
- Node 24.18.0 and pnpm 12.11.2 are available. Use `pnpm.cmd`: PowerShell blocks the `pnpm.ps1` shim. Docker CLI was not found, including the usual Docker Desktop install path.
- `pnpm.cmd typecheck`, `pnpm.cmd boundaries`, and `pnpm.cmd build`: passed (some Turbo dependencies/web tasks replayed cached results).
- `pnpm.cmd lint`: ESLint passed; Prettier initially failed on three staged files. Formatting has been corrected in the working tree.
- `pnpm.cmd test`: sandbox startup failed on SWC native-cache owner validation; retry outside the sandbox passed 232 API tests (UI/contracts tests were cached). After the first implementation, API tests passed 240/240, including eight new budget tests.
- `pnpm.cmd test:int`: retry outside the sandbox reached Testcontainers; 7 tests passed, 870 skipped, 14 files failed during setup because no working container runtime was available. The staged T-ISO-22 suite is unverified.
- `pnpm.cmd test:e2e`: blocked during worker startup by `ECONNREFUSED 127.0.0.1:5432`; no functional browser/Lighthouse result.
- `pnpm.cmd test:stories`: Storybook built; 197/198 browser checks passed. One dark button contrast check failed while theme colours were transitioning. The helper now waits for the requested theme and finite animations before auditing; all axe rules and visual baselines remain unchanged. Recheck recorded below.
- `pnpm.cmd openapi`: generated and validated OpenAPI 3.1 successfully; no document diff.
- `pnpm.cmd secrets:scan`: blocked (`docker ENOENT`).
- `pnpm.cmd audit --audit-level high`: blocked by network access; escalated retry also failed (TLS connection closed by peer). No advisory verdict.

### Rate-limit pass verification

- `pnpm.cmd exec turbo run test --force`: **passed, 287 tests**, no cached tasks. API: 243 (25 files); contracts: 32 (4 files); UI: 12 (2 files). This includes eight new HTTP/budget tests and three new configuration-validation cases.
- `pnpm.cmd typecheck`: **passed**, 7 tasks (2 cached prerequisites).
- `pnpm.cmd boundaries`: **passed**, 498 modules / 1466 dependencies, including boundary meta-checks.
- `pnpm.cmd lint`: **passed**, ESLint zero warnings and repository Prettier check.
- `pnpm.cmd build`: fresh web build initially hit the SWC cache-owner restriction; retry outside the sandbox **passed**, including API compilation, Next.js compilation/typechecking and standalone preparation (3 prerequisite tasks cached).
- `pnpm.cmd --filter @studyhub/ui test:stories`: after the theme-wait correction, **197 passed / 1 environmental failure** (`ERR_NO_BUFFER_SPACE` during navigation). The original dark-button contrast check passed. `pnpm.cmd --filter @studyhub/ui exec playwright test --last-failed --workers=1`: **1 passed**. Thus every story check passed across this run and the targeted retry, rather than a single clean 198-test run. No axe rules were disabled and no visual baseline was regenerated.
- OpenAPI remains unchanged after successful generation/validation. Working-tree and staged `git diff --check` passed; staged diff statistics remain the original four files (972 insertions, 637 deletions).
- Integration/e2e/Lighthouse/secret scan and dependency audit retain the environment blocks above. No claim is made that `pnpm verify` passes end to end.

**Next priority after the rate-limit pass:** F-01 was taken up in the subsequent pass below. F-02 still needs staging calibration, application-level regression checks with Docker, webhook-specific tenant/account budgeting and shared enforcement before horizontal scaling. M10 remains IN PROGRESS.

No migrations, seeding, deployment or destructive database commands were run. Existing staged content remains staged; new implementation and documentation changes remain unstaged for review. No business, pricing, retention or legal defaults were changed.

### Security-header pass, 2026-10-18

- `pnpm.cmd --filter @studyhub/api test`: **245 passed in 26 files**, fresh execution. Two parameterized header cases exercise development/production responses across 200, 400, 404, 429 and 500, including script-free hosted-card-style HTML.
- `pnpm.cmd test:security`: **8 passed**, zero retries, Chromium against the final production build. Covers the F-01 browser cases in section 3, including client navigation and maintenance's 503/Retry-After response. Initial test setup encountered an occupied normal API port and maintenance readiness detection; dedicated ports and stdout readiness corrected those test harness issues without stopping/reusing the existing service.
- Browser testing reproduced and fixed the maintenance origin-normalization defect. Early attempts at restoring the hostname were insufficient because Next's adapter normalized it again; the final supported `skipProxyUrlNormalize` configuration preserves the rewrite origin. Direct requests to internal routes remain 404.
- Initial new-test tuple/regex errors were corrected. Subsequent repository typecheck, lint/format and boundary checks passed; the final production build passed, including Next.js type validation and standalone preparation (three prerequisite tasks cached).
- The new security gate runs in CI and `pnpm verify`. Its API is a read-only fixture, with no database connections or worker; browser form calls are routed to the fixture, not the build's configured API. Full real-API authoring, signed storage, fake/real payment, and approved video/media regressions still need the full E2E environment.
- Existing Docker/PostgreSQL and npm-advisory network blocks from the first pass remain unresolved; integration/E2E/Lighthouse, secret scanning and dependency audit were not rerun in this pass. No staging/production HTTPS, edge redirects or recovery/load claim is made.

**Next priority:** F-03 endpoint isolation coverage, including valid route-specific mutation bodies and complete actor coverage; runtime verification requires Docker. F-01 still needs full authoring/provider regressions and staging transport validation. Restore/RTO, load/noisy-neighbour budgets, and complete ASVS L2 evidence remain open. No business/legal decision blocked the header implementation.

### Endpoint-isolation and dependency patch pass, 2026-10-18

- **Regression demonstrated:** the new controller test initially failed in two cases because the old development video endpoint returned `uploaded` without authorizing the provider id. All seven new controller/service ownership tests now pass after the fix.
- `pnpm.cmd test`: **317 passed** (API 273, contracts 32, UI 12), with all three test tasks executed fresh; two prerequisite build tasks were cached. The API suite now includes `test/setup/**/*.test.ts`, so 21 payload/marker/denial checks run without a database.
- `pnpm.cmd test:int`: **880 passed in 16 files**, no skipped tests, against disposable PostgreSQL and object-store containers. Includes the strengthened T-ISO-22 matrix, all three new T-ISO-23 video upload regressions, the existing SQL role/table isolation checks, identity matrix, commerce, authoring/uploads, learning, assessment, worker and administration tests. Total duration about 4m13s. Integration tasks are uncached.
- Earlier focused runs exposed and corrected the matrix's self-leave ordering, numeric leak markers, shared reset address and invalid payment fixture. The final focused matrix passed, followed by the full suite above; server failures and throttling were not ignored to obtain a pass.
- `pnpm.cmd typecheck`, `pnpm.cmd lint`, `pnpm.cmd boundaries`: **passed**. Boundaries checked 509 modules / 1487 dependencies, including meta-checks.
- `pnpm.cmd build`: **passed**; API generation/compilation ran fresh, while web/shared builds reused valid cached artifacts. No web source changed during this pass.
- `pnpm.cmd audit --audit-level high`: initially **failed** with three unexcepted high `sharp@0.34.4` advisories. After pinning 0.35.5 and updating the lockfile, **passed**, with only the existing documented development `braces` exception. No new advisory was ignored.
- Native image smoke test: **passed**, PNG decode → resize → WebP encode (32×24); sharp 0.35.5, libvips 8.18.7. Real image-upload/worker checks also passed in the full integration suite.
- T-PERF-01 still passes: 3 baseline statements versus 4 scoped, one extra statement and median 0.015 ms database time for context setup. This is the existing tenancy benchmark, not an M10 capacity/noisy-neighbour measurement.
- `pnpm.cmd secrets:scan`: **blocked**, `spawnSync docker ENOENT`. Testcontainers' engine access does not make a Docker executable available to the scan wrapper. Full browser E2E/Lighthouse and Storybook were not rerun in this pass; the previous security-browser results remain separate evidence.
- The original four staged files remain staged with unchanged index statistics (972 insertions, 637 deletions). New implementation, tests, lockfile and documentation changes remain unstaged. All database changes/cleanup were inside disposable test containers; no existing local database was migrated/seeded and no production resources were changed.

**Remaining M10 work:** extend schema-valid mutation, query and mixed-parent/reference coverage beyond the 17 targeted routes; complete support/platform actor variants and OpenAPI inventory; finish full browser regressions with an isolated seeded stack; implement restore tooling and measure full/single-tenant RTO; run capacity/noisy-neighbour/worker-fairness and JS budgets; complete the ASVS L2 review. Staging transport validation, real provider approvals, and the already documented business/legal/hosting decisions remain launch prerequisites. M10 is not complete.

### Additional mutation and mixed-parent isolation pass, 2026-10-18

- Expanded targeted valid mutation coverage from 17 to **24 routes**; every added body is parsed through its shared controller contract. No application behavior or business policy changed in this pass.
- `pnpm.cmd --filter @studyhub/api test`: **280 passed in 29 files**, including all **28** payload/marker/denial checks.
- Focused integration command: `pnpm.cmd --filter @studyhub/api exec vitest run --config vitest.integration.config.mts test/integration/cross-tenant-endpoints.int.test.ts`: **4 passed**, against disposable PostgreSQL, including the new local-parent/foreign-child regression. The earlier full 880-test integration run was not repeated; do not interpret this focused result as a new full-suite count. PostgreSQL's existing concurrent-query deprecation warning remains visible.
- API typecheck and targeted ESLint for the three changed test/helper files: **passed**. Working-tree and index whitespace checks: **passed**; the original four staged files still total 972 insertions / 637 deletions.
- `pnpm.cmd secrets:scan`: **passed**, no leaks found across approximately 3.90 MB. Docker CLI is now accessible outside the sandbox at `C:\Users\Staff\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`; the earlier CLI block is superseded for this check. This is a working-tree scan, not a claim that the CI full-history scan ran.
- Full browser E2E/Lighthouse, build, full integration, capacity/restore and staging checks were not rerun in this pass. The browser test configuration currently reuses local servers outside CI; use an isolated seeded stack before running mutation-heavy browser tests so ongoing demo accounts and edits remain intact.

Next isolation work includes further valid query/body and mixed-reference cases, support/platform actor coverage and complete route documentation. Restore/RTO, capacity/fairness, accessibility and full ASVS evidence remain open. No deployment or migration/seed of the existing demo database was performed during this pass.

### Production-readiness execution pass, 2026-10-18

- Re-read the M10 requirements, security notes, local runbook, recovery specification and provider gate. No applicable `AGENTS.md` was found. Preserved all pre-existing working changes and the original four-file index (972 insertions / 637 deletions).
- Added the [requirement/evidence/blocker checklist](production-readiness.md), [staging preparation](../runbooks/staging-readiness.md), [recovery verification](../runbooks/recovery-verification.md), and [Lipila evaluation](lipila-evaluation.md). README now points at verified status and these operational gates.
- Implemented `test:e2e:isolated`: fresh PostgreSQL/Mailpit/SeaweedFS, explicit test ports, unique console TOTP state, separate `.next-e2e` production build, and refusal to reuse servers. It migrates/seeds only its freshly allocated database. CI and `verify` use this path; `verify` no longer migrates/reseeds the developer database. CI itself was not executed here.
- Initial full browser execution exposed an overbroad private cache header on versioned theme CSS and insufficient disposable object-store volume capacity. Fixed both; two targeted regressions passed, then **59 tests passed in a clean full run**, including author/review/cover upload/publish, learning/resume, offline assessments, fake checkout/refund, accounts/email/TOTP, administration/console, school-host isolation and built-in application axe gates. No axe rule was disabled. The existing non-instructor Studio denial still emits an API-403 server-render diagnostic while the layout serves its permission page; keep that diagnostic visible for future cleanup.
- Added the learner-course cold encoded-JS budget: **1 separate browser test passed**, 150438 bytes / 146.9 KB versus 170 KB. The existing homepage Lighthouse check passed (performance 0.98, accessibility 1.00, LCP 2310 ms, total scripts 148 KB, one font / 34 KB). These are local samples, not field p75/INP/CLS or full public-route coverage.
- Added a real TCP/PostgreSQL two-school request-budget smoke: **1 passed**. Ten noisy clients made 300 requests, 200 were throttled; the other school's 60 reads all returned 200, with p95 38.6 ms (baseline 12.1 ms). Only read-budget isolation at tiny local scale is verified; export/bulk-job fairness, authenticated writes and launch profile remain open.
- Added a logical full-database backup/recovery rehearsal with a target that is always newly allocated. **1 passed**, also in full integration; all **67 public tables** match counts/content hashes, RLS/role checks pass, and the recovered runtime login is still school-scoped. Latest local timings: backup 0.299 s, fresh-target restore 5.902 s, validated RTO 6.388 s. No existing volume/database is cleared or restored. Object/key/provider/PITR recovery and single-school audited import remain open; F46 portability data is not a complete round-trip backup.
- Hardened production clamd TCP streaming: bounded response, backpressure, strict clean response, error/timeout/disconnect cleanup. **Nine protocol tests passed**, using a local test daemon. A real ClamAV signature/detection/availability result is not claimed.
- Client selected **Lipila** during this pass. Reviewed official collection, status, hosted-card, webhook and signing documentation. Added a sandbox-only request client and signature helper with **12 mocked tests passing**; no provider requests, accounts or live payments were made. This is deliberately not registered in the gateway/UI until merchant capability trials and full wiring are complete. Hosted card fields, refunds/reports and commercial/legal evidence remain explicitly tracked. Video-provider selection remains outstanding.
- Fresh forced unit suite: **345 passed** (API 301, contracts 32, UI 12), zero cached tasks. Full integration: **882 passed in 17 files**, zero skips, about 4m37s. The subsequently added Lipila helpers are unregistered and affect no integration runtime paths; their new unit checks pass. Existing PostgreSQL concurrent-query deprecation warnings remain visible.
- Final `pnpm.cmd build`: **passed**, API/web fresh, three cached prerequisites. The first regular web build hit Windows `EBUSY` because the demo process held the standalone directory; stopped only that confirmed StudyHub web process, rebuilt, restarted, and verified Acme HTTP 200 and API readiness/database HTTP 200.
- `pnpm.cmd test:security`: **8 passed** against the final regular production build. `pnpm.cmd lint`, `pnpm.cmd typecheck` and `pnpm.cmd boundaries`: **passed**; final typecheck executed API/web with five cached prerequisites, boundaries checked 517 modules / 1511 dependencies plus violation-detection meta-checks. Final document formatting and both index/working whitespace checks pass.
- Audit: **passed**, unchanged one documented development-only high exception. Working-tree secret scan: **passed**, no leaks / approximately 3.97 MB. Its first attempt included the new generated `.next-e2e` tree and found 13 generated matches; added the same build-only exclusion already applied to `.next`, then reran successfully. No source-secret allowlist, advisory exception or production guard was weakened.
- No new full Storybook, manual screen-reader/usability, external penetration, staging transport or CI/full-history scan result is claimed. `pnpm verify` was not run as one combined chain; individual results above are the evidence. No deployment, real purchase, production-resource change or destructive existing-database operation occurred.

**Next concrete engineering task:** safe single-school recovery/import planning and disposable verification, preserving shared identities/credentials and unrelated-school snapshots. In parallel with independent work, obtain Lipila sandbox merchant credentials and required capability evidence through the approved secret channel; select the managed video provider. M10 and launch remain incomplete until semantic authorization, ASVS, full capacity/fairness, recovery and staging requirements are verified.

### Reviewed single-school content recovery pass, 2026-10-18

- Added `planSchoolContentRecovery` / `applySchoolContentRecovery` in the admin application layer. Explicit scope `existing-course-content-v1` imports supported teaching-content fields from the real F46 export. No inserts/deletes, parent/owner changes, money/access/permissions, shared identities, credentials or historical audit rollback are supported or inferred from archive keys. Missing rows and parent/type mismatches block all writes.
- Dry-run diffs are read-only. A SHA-256 review digest binds the source, target rows, school, scope and platform owner. Apply requires a reason and external owner-review reference, re-locks/reviews the rows, rejects stale/substituted reviews, validates replacement rich text, repairs invalid live content/search text, advances versions, and appends school/platform audit records atomically. It uses the runtime role, parameterized Prisma SQL, explicit school predicates and existing forced RLS. No production write endpoint or existing-database CLI was exposed.
- `pnpm.cmd test:recovery`: **9 passed in two files**, 8 school-content cases plus the full logical recovery drill. Repeated focused runs exposed no application failures; targeted lint initially rejected raw SQL APIs and they were replaced with tagged parameterized templates before the final passing database run.
- The single-school test exports through F46, changes source-school content and a shared global identity, restores three reviewed records, checks all **62 protected/global table hashes**, and compares **every other-school table hash**. The newer shared identity, credentials, other schools and newer records remain unchanged. Tests also cover missing references, other-school/duplicate ids, unsafe archived content, staff-role denial, source/operator/stale review substitution and rollback of both content and school audit when platform-audit insertion fails.
- Latest generated `apps/api/test-results/recovery/single-school.json`: three content records, **597 ms** for apply plus local verification/no-op check. This is a tiny local content-repair measurement, not a complete single-school RTO, asset restore or staging recovery claim.
- Fresh API unit suite: **301 passed in 31 files**. API build, API typecheck, repository lint/format and boundaries passed (519 modules / 1521 dependencies, including violation-detection meta-checks). Earlier full integration/browser/audit results were not rerun for this bounded change; no new full-suite total is claimed. Working-tree and staged whitespace checks are recorded at completion.
- Updated the recovery runbook, readiness checklist and README with the scope, evidence and operational limits. No existing demo database, production resource or original staged content was changed. Database failure injection and all imports were confined to disposable containers.

**Remaining recovery work:** safe reviewed recreation/reference mapping for missing records, supported non-content school state, object-version recovery, operational owner approval/reauthentication, pre-restore backup/rollback flow, and representative staging PITR/RTO verification. The review-reference field is an audit reference, not proof that a real owner signed off. M10 remains partial; the next concrete task is disposable object-version recovery and extending missing-record/reference coverage without weakening the preservation checks.

### R2 application-managed backup pass, 2026-10-18

- Client chose to keep R2 and add version backups. Added separate-bucket document snapshot capture, bounded manifest inventory, strict school/source binding and SHA-256 verification, without native versioning APIs. Conditional creates retain earlier snapshots. This is a recovery library, not automatically enabled upload backup.
- Added reviewed document recovery to fresh live keys with malware/type/size checks, stale-review rejection and atomic pointer/dual-audit updates. Originals remain intact; failed database commits retain unreferenced staged candidates pending approved cleanup.
- **20 recovery tests passed in four files**: six application-backup, five native-version, eight school-content and one full database rehearsal. The application-backup fixture disables native versioning; recovery plus local verification took **594 ms** for 2048 bytes, preserving shared tables and the other school. No existing database or production resource was modified.
- API build/typecheck and boundaries passed (525 modules / 1549 dependencies plus meta-check). Initial repository lint failed only on documentation formatting; final verification is recorded below. Earlier full integration/browser evidence remains historical.
- Remaining: automatic verified-upload capture with durable retries, trusted inventory and monitoring, separated backup access, approved retention/cleanup, actual R2 staging tests, broader file/missing-record coverage and reauthenticated operational approval. Conditional writes do not provide WORM protection against privileged backup compromise.

Final scoped checks: **308 API unit tests passed** in 32 files; API build/typecheck, repository lint/format and architecture boundaries passed. Full logical recovery in the current 20-test run compared all **67 tables**, with backup 0.621 s, fresh-target restore 9.136 s and validated local RTO **10.153 s**. These disposable fixture timings do not establish production RPO/RTO. Full integration/browser suites were not rerun for this change.

Final working-tree secret scan passed: no leaks across 4.07 MB. Original four-file index remains 972 insertions / 637 deletions; staged and working whitespace checks passed.

### Dashboard configuration first phase, 2026-10-19

The [repository assessment and phased plan](dashboard-configuration.md) explains the existing feature, settings, permission, secret and storage boundaries. The [administrator/developer runbook](../runbooks/dashboard-configuration.md) covers editing, import, feature grants, extension, recovery and the future storage lifecycle.

- Added version 1 managed content configuration using existing tables/contracts: platform defaults and enforced values, school overrides, effective/inherited/source display, persisted drafts, reviewed activation, scoped history including the previous baseline, eligible restoration through a new draft, and reset to inheritance. The three implemented controls are catalogue visibility, course review and downloads on new lessons. Legacy settings PATCH respects platform restrictions and preserves explicit overrides equal to inherited defaults.
- Added bounded non-executable `.env` data import for three recognized nonsecret aliases. Unsupported/bootstrap/credential keys are rejected without echoing values or storing uploaded text. Activation binds a scoped content digest and saved draft UUID under transaction locks. School permissions and console owner/MFA/recent reauthentication are enforced; audit entries commit with changes. Broadened structured-log redaction for credentials and raw import text. No new credential store or root key was introduced.
- Reused existing plans and school feature overrides. Added backend enforcement for instructor applications, anonymous catalogue/lesson previews, queued full exports and white-label revocation. Added revenue-sharing dependency validation for school switches and console overrides. Plan-change/reassignment dependency transitions and immutable financial checkout terms remain open; historical settlement/refund workers were not rewritten.
- Verified **355 API unit tests in 37 files**, **35 contract tests**, and **71 affected integration tests in four files** against disposable services. A subsequent configuration-only run passed **8 tests**, including the added legacy-override regression. The integration and workflow fixtures demonstrate Acme overrides while Beta retains inherited values; school drafts/history and credentials cannot cross scopes.
- Repository typecheck, lint/format, architecture boundaries (542 modules / 1594 dependencies plus meta-checks), production build, generated OpenAPI validation and redacted working-tree secret scan passed. The sandbox's SWC cache ownership check required running native-compiler checks outside the sandbox; Docker Desktop was started for disposable tests. No existing database was migrated/seeded and no production resources were changed.

Browser validation passed across focused isolated Edge runs: **six distinct school-administrator checks** (including ten school screens with axe checks, draft validation, import/conflict handling, and real Acme-only activation/reload/Beta isolation/reset), plus **ten identity/console checks**. The final two-school journey used separate authenticated browser contexts and browser-side reads so Windows wildcard-localhost DNS and the sign-in helper's cookie reset did not invalidate the fixture. Initial test-only failures were corrected; no application check was skipped or accessibility rule disabled in the isolated runs. Full browser/Lighthouse/Storybook and the full integration suite were not rerun for this phase.

Storage credentials, safe connection tests/activation, persisted per-asset storage locations, object migration and further provider adapters remain **unimplemented**. Storage continues to use deployment configuration. Existing asset access after a real provider switch has not been tested because switching is not enabled. M10 and the overall dashboard/provider programme are not complete.

### Review fixes and full verification, 2026-10-20

A high-effort review of the working tree found ten issues; these were fixed:

- **Per-IP budget and server rendering:** server-side API calls (`getTenantBootstrap`, `apiGet`) now forward the visitor's `X-Forwarded-For` chain (Next.js adds the socket address when absent), so school page renders no longer share the web server's single 600/min budget. The API still honours it only from `TRUSTED_PROXIES`.
- **Limiter under key churn:** a full limiter now evicts the oldest inserted key (expired keys first, swept at most once a second) instead of refusing every new key. A live budget is reset only after 50,000 newer keys; tenant and account budgets still apply. **PROPOSED:** the trade-off favours availability over exact per-IP counts during IPv6 churn.
- **Purge versus media processing:** `lockTenantLifecycle()` (platform) is now the one tenant-row lock taken by export requests, export claims, media claims and the purge. A due purge refuses new media claims; SCANNING assets may finish, and the purge waits for them. The purge now logs when in-flight writers delay it.
- **Uncaptured storage:** the API logs an error at startup when the active storage location has not been captured; `pnpm storage:bootstrap` is a root script and a staging-readiness step. Capture remains explicit (no automatic adoption of existing objects).
- **Local CSP:** loopback hosts allow the local object store for images and media as well as uploads.

Still open from the review: one stuck SCANNING asset or RUNNING export still delays a purge (now logged, not auto-recovered); purge cleanup visits superseded storage locations whose credentials may have been revoked; one unresolvable cover fails a whole course-list presign batch; document recovery does not check that the recovery storage matches the asset's recorded location.

Verification also fixed WIP test gaps: an incomplete transaction mock, unused imports, eight unformatted files, a missing storage capture in the identity suite and the four configuration routes missing from the T-ISO-12 route list.

`pnpm verify` **passed end to end** with Docker Desktop running: lint/format, typecheck, boundaries, **406 unit tests** (API 359, contracts 35, UI 12), **918 integration tests in 21 files**, production build, **8 security browser tests**, **62 isolated e2e checks**, **198 Storybook checks**, OpenAPI and the secret scan (no leaks). M10 remains IN PROGRESS: the DoD items above (load/noisy-neighbour, RTO on real infrastructure, ASVS L2 evidence) are not met.

### Review leftovers closed, 2026-10-21

The four items left open by the 2026-10-20 review are fixed (branch `m10-hardening-wip`, on top of the 2026-10-21 scope additions):

- **One unresolvable image failed a whole page:** `MediaService.readUrls` signs each image on its own; one whose storage location can't be opened is left out and logged, and the rest of the page renders. Studio's covers now use the same path (one signing implementation instead of two).
- **Document recovery storage vs recorded location:** a `VersionRecoveryStorage` carries the `locationId` its credentials open, and recovery refuses a document recorded at another location (it would have pointed the restored key into a bucket the document isn't read from).
- **Stuck writers delayed a purge forever:** the purge retires scans and exports with no progress for 24 hours (**PROPOSED** threshold: jobs expire after minutes and retries back off over hours), logging how many. Workers now finish only while they still hold their claim; one that resumes after being retired deletes what it wrote, so nothing is left in a purged school's storage.
- **Revoked superseded locations blocked purges:** locations holding the school's recorded objects stay required; other retained locations are cleaned when they can be opened, and one that can't is logged and skipped. **PROPOSED:** stray, unrecorded objects in a revoked old location may then outlive the purge; they're under the deleted school's prefix and unreachable.

Tests: unit (a failing location leaves one image out), recovery (wrong location refused), admin AC 5 (a fresh scan holds the purge; a 2-day-old scan and export are retired; a revoked superseded location is skipped).

`pnpm verify` passed on 2026-10-21: 431 unit (API 384, contracts 35, UI 12), 937 integration in 25 files, build, 8 security, 70 isolated e2e, 198 Storybook, OpenAPI, secret scan. M10 stays IN PROGRESS: load/noisy-neighbour at the target profile, RTO on real infrastructure and ASVS L2 evidence still need staging or people.
