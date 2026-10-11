# Runbook: local development

## Start and stop

```powershell
pnpm db:up        # PostgreSQL 17 on 127.0.0.1:5432 (waits until healthy)
pnpm build        # needed once before db:migrate (the migration CLI is compiled)
pnpm db:migrate   # Prisma migrations + job-queue schema, as studyhub_migrator
pnpm db:seed      # demo schools acme.localhost and beta.localhost (idempotent)
pnpm dev          # API :4000, worker, web :3000
pnpm db:down      # stop PostgreSQL (data is kept in the studyhub-pgdata volume)
```

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
- `http://localhost:3000` is the platform host and shows the system status page.
- Create a school: `pnpm tenant:create --slug demo --name "Demo School" --status ACTIVE`.
- Inspect a school's rows in psql: tenant tables return **nothing** until you set the context: `BEGIN; SELECT set_config('app.tenant_id', '<tenant uuid>', true); SELECT * FROM audit_log; COMMIT;`. This is row-level security working, not missing data.

If you change the passwords in `.env` after the volume exists, the roles keep their old passwords. Reset the database (below) or change them with `ALTER ROLE` as `postgres`.

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

| Symptom                                                               | Cause                                           | Fix                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `corepack enable` fails with `EPERM … C:\Program Files\nodejs`        | Corepack needs admin rights to write there      | `corepack enable pnpm --install-directory "$env:APPDATA\npm"`                            |
| `pnpm db:up` fails: `Set POSTGRES_SUPERUSER_PASSWORD in .env`         | No `.env` file                                  | `Copy-Item .env.example .env`                                                            |
| `pnpm db:up` fails: port 5432 already allocated                       | Another PostgreSQL is running                   | Stop it, or set `POSTGRES_PORT` in `.env` and update both `DATABASE_URL_*` values        |
| `/readyz` returns 503                                                 | Database down or not migrated                   | `pnpm db:up`, then `pnpm db:migrate`                                                     |
| API exits with `Invalid configuration`                                | A variable in `.env` is missing or malformed    | The message names each variable; compare with `.env.example`                             |
| `pnpm test:int` fails to start containers                             | Docker Desktop not running                      | Start Docker Desktop; the first run downloads `postgres:17`                              |
| `pnpm test:e2e` cannot find a browser                                 | Playwright browser not installed                | `pnpm --filter @studyhub/web exec playwright install --only-shell chromium`              |
| `pnpm db:migrate` fails: `role "studyhub_rls_definer" does not exist` | The volume predates M2                          | `pnpm db:provision-roles`, then `pnpm db:migrate`                                        |
| A school host shows "Site not found"                                  | The school isn't seeded or its host is misspelt | `pnpm db:seed`; use `http://acme.localhost:3000`                                         |
| Playwright browser download times out                                 | Slow or filtered connection to the browser CDN  | `$env:PLAYWRIGHT_CHANNEL = 'msedge'` (uses the installed Edge), then rerun the e2e tests |
| `pnpm db:migrate` fails: `Cannot find module …dist/cli/migrate.js`    | The API has not been built                      | `pnpm build`, then `pnpm db:migrate`                                                     |
| `pnpm secrets:scan` cannot start                                      | Docker not running                              | Start Docker Desktop                                                                     |

## Security notes

- `.env` is git-ignored. Never commit real credentials. `pnpm secrets:scan` scans the working tree; CI scans the full git history.
- Logs redact passwords, tokens, cookies, authorization headers and phone numbers. Don't log request bodies.
- No payment, video, email or cloud credentials are used in Milestone 1.
