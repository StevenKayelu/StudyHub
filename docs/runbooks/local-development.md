# Runbook: local development

For managed platform defaults and school overrides, see [dashboard configuration](dashboard-configuration.md). This first phase needs no new database migration or environment key. Rebuild/restart the updated application once; subsequent managed-setting activations are read on the next relevant API/worker operation. Infrastructure credentials remain deployment settings.

## Start and stop

```powershell
pnpm db:up        # PostgreSQL 17 (:5432), Mailpit (:8025) and SeaweedFS object storage (:8333); waits until healthy
pnpm build        # needed once before db:migrate (the migration CLI is compiled)
pnpm db:migrate   # Prisma migrations + job-queue schema, as studyhub_migrator
pnpm db:seed      # demo schools, accounts and Acme's demo catalogue (idempotent)
pnpm dev          # API :4000, worker, web :3000
pnpm db:down      # stop PostgreSQL (data is kept in the studyhub-pgdata volume)
```

The API and worker run compiled JavaScript. In development, Node watches each process's entry point and imported files, rather than the whole `dist` directory, so unrelated compiler output does not repeatedly restart them.

## Database roles

The roles are created by `infra/postgres/init/01-roles.sql` **only when the data volume is first created**. Passwords come from `.env`:

| Role                   | Used by              | Rights                                                                              |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `postgres`             | the container itself | superuser; never used by the apps                                                   |
| `studyhub_migrator`    | `pnpm db:migrate`    | owns the database and schema; runs DDL                                              |
| `studyhub_app`         | API and worker       | data access only (no CREATE/ALTER/DROP); always under row-level security            |
| `studyhub_rls_definer` | nobody (NOLOGIN)     | owns the reviewed SECURITY DEFINER functions (`resolve_tenant`, `claim_due_outbox`) |

Role scripts: `infra/postgres/init/01-roles.sql` (M1) and `02-tenancy-roles.sql` (M2). For a volume created before M2, run `pnpm db:provision-roles` once after `pnpm db:up`.

## Schools (tenants) locally

- Each school is reached through its own host. Browsers resolve `*.localhost` to your machine: `http://acme.localhost:3000`, `http://beta.localhost:3000`.
- `http://localhost:3000` is the platform host and shows the system status page; `http://console.localhost:3000` is the platform console shell (`CONSOLE_HOSTS`).
- A school's look comes from its published branding (`tenant_branding`) and its languages from `tenant_setting`; no row means the defaults. `pnpm db:seed` refreshes the demo schools' branding.
- Maintenance page: set `MAINTENANCE_MODE=on` in `.env` and restart the web server; every page returns 503 with the maintenance screen (the API keeps running).
- Visual-regression baselines live in `packages/ui/tests/stories.spec.ts-snapshots/`. After an intended visual change, review the diff and update them with `pnpm --filter @studyhub/ui exec playwright test --grep visual --update-snapshots`.
- Create a school: `pnpm tenant:create --slug demo --name "Demo School" --status ACTIVE`.
- Inspect a school's rows in psql: tenant tables return **nothing** until you set the context: `BEGIN; SELECT set_config('app.tenant_id', '<tenant uuid>', true); SELECT * FROM audit_log; COMMIT;`. This is row-level security working, not missing data.

If you change the passwords in `.env` after the volume exists, the roles keep their old passwords. Reset the database (below) or change them with `ALTER ROLE` as `postgres`.

## Accounts and email locally (M4)

- `pnpm db:seed` creates demo accounts, all with the password `studyhub-demo-pass` (development only; the seed refuses production):
  - `owner@acme.test` (Acme owner), `tutor@acme.test` (Acme instructor), `owner@beta.test` (Beta owner),
  - `learner@example.test` (a learner at both Acme and Beta: one account, two schools),
  - `staff@studyhub.test` (platform owner; sign in at http://console.localhost:3000).
- The console requires two-step verification. At first sign-in you add the shown key to an authenticator app. Re-running `pnpm db:seed` resets the demo staff member's enrolment.
- Every email (verification, password reset, invitations) is caught by **Mailpit**: http://127.0.0.1:8025. The worker sends them (`pnpm dev` starts it). Links point at the school host, e.g. `http://acme.localhost:3000/verify-email#token=…`.
- Sessions are per school host: signing in at acme.localhost doesn't sign you in at beta.localhost. Use **Account → Your schools** to switch.

## Catalogue, Studio and uploads locally (M5)

- `pnpm db:seed` gives Acme two categories, three subjects and two published free courses by `tutor@acme.test` ("Biology foundations", "Algebra essentials"). Seeded courses are never overwritten, so local edits survive a re-seed.
- Studio: sign in at http://acme.localhost:3000 as `tutor@acme.test` and open **Studio**. Acme reviews new courses first: approve them as `owner@acme.test` under **Administration → Reviews**.
- Uploads go from the browser straight to SeaweedFS (http://127.0.0.1:8333, bucket `studyhub-local`, created on first use). The **worker** checks and scans them, so keep it running (`pnpm dev` starts it); without it uploads stay at "Checking the file…".
- Malware scanning is `eicar-only` locally: upload the EICAR test file to see a rejection. Video uses the development fake provider, which marks a video ready right after upload.
- The local video upload is proxied through Next.js to the API; development raises the proxy body cap to Acme's 2 GB upload limit and the timeout to 15 minutes. Next buffers proxied request bodies up to this cap in memory, so keep this development-only; production retains the small default and uses the managed video provider directly.
- Instructor applications: schools add instructors by invitation by default. To try applications, store the setting `instructorOnboardingMode` = `"APPLICATION"` in `tenant_setting` for the school (with the tenant context set, as in "Schools locally"); `/teach` then shows **Apply to teach**.
- Objects are kept in the `studyhub-objects` volume; `down -v` (below) deletes them too.

## Reset the local database (deletes all local data)

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml down -v
pnpm db:up
pnpm db:migrate
```

## Connect with psql

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml exec postgres psql -U postgres -d studyhub
```

## Troubleshooting

| Symptom                                                                       | Cause                                           | Fix                                                                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `corepack enable` fails with `EPERM … C:\Program Files\nodejs`                | Corepack needs admin rights to write there      | `corepack enable pnpm --install-directory "$env:APPDATA\npm"`                            |
| `pnpm db:up` fails: `Set POSTGRES_SUPERUSER_PASSWORD in .env`                 | No `.env` file                                  | `Copy-Item .env.example .env`                                                            |
| `pnpm db:up` fails: port 5432 already allocated                               | Another PostgreSQL is running                   | Stop it, or set `POSTGRES_PORT` in `.env` and update both `DATABASE_URL_*` values        |
| `/readyz` returns 503                                                         | Database down or not migrated                   | `pnpm db:up`, then `pnpm db:migrate`                                                     |
| API exits with `Invalid configuration`                                        | A variable in `.env` is missing or malformed    | The message names each variable; compare with `.env.example`                             |
| `pnpm test:int` fails to start containers                                     | Docker Desktop not running                      | Start Docker Desktop; the first run downloads `postgres:17`                              |
| `pnpm test:e2e` cannot find a browser                                         | Playwright browser not installed                | `pnpm --filter @studyhub/web exec playwright install --only-shell chromium`              |
| `pnpm db:migrate` fails: `role "studyhub_rls_definer" does not exist`         | The volume predates M2                          | `pnpm db:provision-roles`, then `pnpm db:migrate`                                        |
| A school host shows "Site not found"                                          | The school isn't seeded or its host is misspelt | `pnpm db:seed`; use `http://acme.localhost:3000`                                         |
| Playwright browser download times out                                         | Slow or filtered connection to the browser CDN  | `$env:PLAYWRIGHT_CHANNEL = 'msedge'` (uses the installed Edge), then rerun the e2e tests |
| `pnpm db:migrate` fails: `Cannot find module …dist/cli/migrate.js`            | The API has not been built                      | `pnpm build`, then `pnpm db:migrate`                                                     |
| `pnpm secrets:scan` cannot start                                              | Docker not running                              | Start Docker Desktop                                                                     |
| An upload stays at "Checking the file…"                                       | The worker isn't running                        | `pnpm dev` (or `pnpm --filter @studyhub/api start:worker`)                               |
| An upload fails at once in the browser                                        | Object store not running                        | `pnpm db:up` (starts SeaweedFS on port 8333)                                             |
| Uploads/downloads return 503; API logs "Object storage has not been captured" | Storage origin not captured                     | `pnpm db:seed` (captures it), or `pnpm storage:bootstrap` on a database you don't seed   |

## Security notes

- Use `pnpm.cmd test:e2e:isolated` after building the API/shared packages for browser checks that preserve demo data. It allocates disposable PostgreSQL/Mailpit/SeaweedFS, migrates/seeds only that fresh database, builds `.next-e2e`, and uses web 3400/API 4500. Occupied ports fail rather than reusing a server. All school URLs and email links follow the isolated port, and platform TOTP state is unique to the run. Existing `.env`, `.next`, accounts and volumes are not used for test data. `pnpm verify` and CI now use this runner. The older `test:e2e` intentionally retains its demo-stack behavior.
- `pnpm.cmd test:load:smoke` runs a small real-HTTP two-school budget/latency test on a disposable database and writes `apps/api/test-results/load/latest.json`. Run alone for meaningful timings. It does not cover authenticated writes, export/worker fairness or launch capacity.
- `pnpm.cmd test:recovery` restores a synthetic full logical backup into a newly created database and verifies table hashes/RLS; see [recovery verification](recovery-verification.md). No existing target is accepted. Reports are in `apps/api/test-results/recovery/latest.json`.
- On Windows, a running standalone server can lock `.next/standalone/apps/web`; stop that local web process before rebuilding `.next`, then restart it. Isolated `.next-e2e` builds avoid this lock and do not replace the demo build.

- On Windows where execution policy blocks `pnpm.ps1`, use `pnpm.cmd` for the same commands.
- After `pnpm build`, run `pnpm.cmd test:security` for database-free production CSP/header browser checks. It uses ports 3300, 3301, 4400 and 4401, with fixture API/upload servers; it refuses to reuse existing servers and never submits to the normal development API. Chromium must be installed. This supplements the real database-backed E2E suite.
- Configure browser upload/CDN/embed origins with `WEB_CSP_CONNECT_ORIGINS`, `WEB_CSP_IMAGE_ORIGINS`, `WEB_CSP_MEDIA_ORIGINS` and `WEB_CSP_FRAME_ORIGINS` (comma-separated exact HTTPS origins; HTTP only for loopback). Export these into the web process environment; restart after changes and rebuild if changing build-time configuration. Never add wildcard hosts or CSP directives. Local hosts permit SeaweedFS at `http://127.0.0.1:8333` by default. Inline scripts require per-request nonces; inline styles remain permitted for the existing design system and editor.
- Nonce-based HTML is dynamic and private/no-store; do not enable shared HTML/ISR caching without redesigning the policy. Static assets still use their normal cache rules. Production HSTS/upgrade policy supplements the HTTPS redirect and TLS configuration required at the edge; no edge setup is supplied by this local change.
- API-wide request budgets are `API_RATE_IP_PER_MINUTE=600`, `API_RATE_TENANT_PER_MINUTE=6000` and `API_RATE_ACCOUNT_PER_MINUTE=300`. All must be positive integers. Restart the API after changing them. A rejected request returns 429 with `Retry-After`; health/readiness probes remain available. These are process-local budgets: validate them against staging traffic and provide shared enforcement before running multiple API instances. See `docs/design/m10-hardening.md` for limitations and verification.

- `.env` is git-ignored. Never commit real credentials. `pnpm secrets:scan` scans the working tree; CI scans the full git history.
- Logs redact passwords, tokens, cookies, authorization headers and phone numbers. Don't log request bodies.
- No payment, video, email or cloud credentials are used in Milestone 1.
