# StudyHub

StudyHub is a multi-tenant, white-label learning platform for schools, colleges, tutors and education businesses. The full product, architecture and design specification is in [`docs/blueprint/`](docs/blueprint/README.md).

**Current state: Milestone 1, the engineering foundation.**

- A TypeScript monorepo with an API, a background worker and a web skeleton.
- Shared contracts and a PostgreSQL migration pipeline.
- Automated quality gates.

There is no tenancy, authentication or product feature yet; those arrive in later milestones (see `docs/blueprint/07-implementation-roadmap.md`).

## Repository layout

```
apps/
  api/            NestJS on Fastify: HTTP API (src/main.ts) and background worker (src/worker.ts)
  web/            Next.js (App Router): system status page for now
packages/
  config/         shared TypeScript and ESLint presets
  contracts/      error codes, problem+json, health schemas, OpenAPI generation (Zod)
infra/
  compose/        local Docker Compose (PostgreSQL 17)
  postgres/init/  database roles (migrator, app)
tools/            boundary meta-check fixtures, secret-scan wrapper
docs/
  blueprint/      approved specification (do not edit here; it is a verbatim copy)
  adr/            architecture decision records
  runbooks/       operational how-tos
```

## Prerequisites (Windows 11, PowerShell)

| Tool           | Version                            | Check            |
| -------------- | ---------------------------------- | ---------------- |
| Node.js        | 24 LTS                             | `node --version` |
| pnpm           | 12.11.2 (pinned in `package.json`) | `pnpm --version` |
| Docker Desktop | engine running                     | `docker info`    |
| Git            | any recent                         | `git --version`  |

Enable pnpm through Corepack. On Windows without administrator rights, `corepack enable` fails with `EPERM` because it writes to `C:\Program Files\nodejs`. Install the shim into your user folder instead:

```powershell
corepack enable pnpm --install-directory "$env:APPDATA\npm"
```

Keep the repository **outside OneDrive** (recommended: `C:\dev\StudyHub`).

## Setup (about 15 minutes on a normal connection, mostly downloads)

From the repository root, in PowerShell:

```powershell
pnpm install
Copy-Item .env.example .env
pnpm db:up
pnpm build
pnpm db:migrate
pnpm --filter @studyhub/web exec playwright install --only-shell chromium
```

- `.env` holds **local-only placeholder values**. It is git-ignored; never commit it.
- `pnpm db:migrate` runs the compiled migration CLI, so build first.
- If the Playwright browser download fails (slow or filtered networks), use the installed Microsoft Edge instead: `$env:PLAYWRIGHT_CHANNEL = 'msedge'` before `pnpm test:e2e` or `pnpm verify`.

## Run

```powershell
pnpm dev
```

| Service                  | URL                                          |
| ------------------------ | -------------------------------------------- |
| Web (status page)        | http://localhost:3000                        |
| API liveness             | http://127.0.0.1:4000/healthz                |
| API readiness (database) | http://127.0.0.1:4000/readyz                 |
| Worker                   | runs alongside the API; logs a heartbeat job |

## Verify

```powershell
pnpm verify
```

`pnpm verify` runs every gate in order: lint, typecheck, boundaries, unit tests, integration tests, build, e2e, OpenAPI, secret scan. The database must be up and migrated for the e2e step. Individual gates:

| Command             | What it checks                                                                |
| ------------------- | ----------------------------------------------------------------------------- |
| `pnpm lint`         | ESLint (zero warnings) and Prettier formatting                                |
| `pnpm typecheck`    | TypeScript strict mode across all packages                                    |
| `pnpm boundaries`   | module-boundary rules, and proof that violations are detected                 |
| `pnpm test`         | unit tests (Vitest)                                                           |
| `pnpm test:int`     | integration tests against throwaway PostgreSQL 17 containers (Testcontainers) |
| `pnpm build`        | production builds of contracts, API and web                                   |
| `pnpm test:e2e`     | Playwright smoke test (starts the built API and web)                          |
| `pnpm openapi`      | regenerates `apps/api/openapi.json` from the contracts                        |
| `pnpm secrets:scan` | gitleaks secret scan of the working tree (via Docker)                         |

Stop the database with `pnpm db:down`. Data persists in a Docker volume; see the runbook to reset it.

## Conventions

- **Errors** are RFC 9457 `application/problem+json` with a stable `code` and a `requestId` (ADR-0014).
- **Logs** are JSON with `requestId`; passwords, tokens, cookies and phone numbers are redacted.
- **Configuration** is validated at startup. The API and worker refuse to start on invalid or missing variables, or on development placeholder credentials in production.
- **Database roles:** migrations run as `studyhub_migrator`; the API and worker run as `studyhub_app`, which can't change the schema (ADR-0003).
- **Module boundaries** are enforced by dependency-cruiser (ADR-0001).

More detail: [`docs/runbooks/local-development.md`](docs/runbooks/local-development.md).
