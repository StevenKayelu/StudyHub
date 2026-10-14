# StudyHub

StudyHub is a multi-tenant, white-label learning platform for schools, colleges, tutors and education businesses. The full product, architecture and design specification is in [`docs/blueprint/`](docs/blueprint/README.md).

**Current state: Milestone 5, instructors, catalogue and authoring** (on top of M1–M4).

- A TypeScript monorepo with an API, a background worker and a web app; shared contracts; a PostgreSQL migration pipeline; automated quality gates (M1).
- **Multi-school isolation enforced by the database** (M2): every school-owned table has forced row-level security; the school is resolved only from the request host; background jobs and the outbox run in their school's context; no database login can bypass RLS. Design: [`docs/design/m2-tenancy-kernel.md`](docs/design/m2-tenancy-kernel.md), ADR-0016 to ADR-0018.
- **Copperline design system and white-label theming** (M3): tokens, components and Storybook in `packages/ui`; each school's accent colour is compiled into an accessible light and dark theme (BR-51); 3 self-hosted font presets; per-school languages and terminology; Public, Learn, Studio, Admin and Console shells; system screens. Design: [`docs/design/m3-design-system.md`](docs/design/m3-design-system.md), ADR-0010.
- **Accounts and access** (M4): one account per person with per-school memberships and roles; sign-in on each school's host, school switching by one-time hand-off, invitations, email verification and password reset; a separate platform console with mandatory two-step verification; a policy layer and an authorization matrix tested in CI. Design: [`docs/design/m4-identity-realms.md`](docs/design/m4-identity-realms.md); ASVS checklist: [`docs/security/asvs-v2-v3.md`](docs/security/asvs-v2-v3.md).
- **Instructors, catalogue and authoring** (M5): instructor applications or invitations; categories and subjects; Studio for building courses (outline, rich text, video and file lessons, details, pricing, publish checklist) with administrator review; uploads straight from the browser to object storage, verified and scanned by the worker; a searchable per-school catalogue with course and instructor pages. Design: [`docs/design/m5-catalogue-authoring.md`](docs/design/m5-catalogue-authoring.md).

Enrolment and learning, quizzes and payments arrive in later milestones (see `docs/blueprint/07-implementation-roadmap.md`). Video and payment providers are development fakes until the client approves one.

## Repository layout

```
apps/
  api/            NestJS on Fastify: HTTP API (src/main.ts) and background worker (src/worker.ts)
  web/            Next.js (App Router): school sites (shells, theming), console host, status page
packages/
  config/         shared TypeScript and ESLint presets
  contracts/      error codes, problem+json, health, tenant and i18n schemas, OpenAPI generation (Zod)
  ui/             Copperline tokens, theme compiler, React components, Storybook
infra/
  compose/        local Docker Compose (PostgreSQL 17, Mailpit, SeaweedFS object storage)
  postgres/init/  database roles (migrator, app)
  seaweedfs/      local object-store credentials (development only)
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
pnpm db:seed
pnpm --filter @studyhub/web exec playwright install --only-shell chromium
```

- **Upgrading a database volume created before M2:** run `pnpm db:provision-roles` once (after `pnpm db:up`, before `pnpm db:migrate`). PostgreSQL only runs the role scripts when a volume is first created.
- `pnpm db:seed` creates four demo schools: **Acme Academy** (`acme.localhost`, Copperline default), **Beta College** (`beta.localhost`, teal accent, Humanist fonts, "Lecturer"/"Module"), **Gamma Tutors** (`gamma.localhost`, still provisioning: "Coming soon") and **Delta Institute** (`delta.localhost`, suspended: read-only, where `learner@example.test` can still sign in and read their course). It is idempotent and refreshes the demo branding. It also creates demo accounts (password `studyhub-demo-pass`, development only): `owner@acme.test`, `tutor@acme.test`, `owner@beta.test`, `learner@example.test` (a member of both Acme and Beta) and the platform owner `staff@studyhub.test`, and a small demo catalogue at Acme (two published free courses by `tutor@acme.test`; Algebra essentials has a video lesson played by the development video provider's simulated player). See the runbook.
- Create another school: `pnpm tenant:create --slug demo --name "Demo School" --status ACTIVE` (host defaults to `demo.localhost`).

- `.env` holds **local-only placeholder values**. It is git-ignored; never commit it.
- `pnpm db:migrate` runs the compiled migration CLI, so build first.
- If the Playwright browser download fails (slow or filtered networks), use the installed Microsoft Edge instead: `$env:PLAYWRIGHT_CHANNEL = 'msedge'` before `pnpm test:e2e` or `pnpm verify`.

## Run

```powershell
pnpm dev
```

| Service                  | URL                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Web (status page)        | http://localhost:3000                                                                           |
| API liveness             | http://127.0.0.1:4000/healthz                                                                   |
| API readiness (database) | http://127.0.0.1:4000/readyz                                                                    |
| Worker                   | runs alongside the API; outbox, emails, and upload checks (type, malware scan, image sizes)     |
| School site (demo)       | http://acme.localhost:3000 and http://beta.localhost:3000 (`/`, `/browse`, `/studio`, `/admin`) |
| Object storage (S3 API)  | http://127.0.0.1:8333 (SeaweedFS, local only)                                                   |
| Platform console (shell) | http://console.localhost:3000                                                                   |
| Storybook                | `pnpm storybook` → http://localhost:6006                                                        |
| School bootstrap API     | `GET /api/v1/tenant`, resolved from the host                                                    |

## Verify

```powershell
pnpm verify
```

`pnpm verify` runs every gate in order: lint, typecheck, boundaries, unit tests, integration tests (including the tenant-isolation suite), build, migrate, seed, e2e (including the Lighthouse budget), story tests (axe and visual regression), OpenAPI, secret scan. The database must be up (`pnpm db:up`). Individual gates:

| Command             | What it checks                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `pnpm lint`         | ESLint (zero warnings) and Prettier formatting                                  |
| `pnpm typecheck`    | TypeScript strict mode across all packages                                      |
| `pnpm boundaries`   | module-boundary rules, and proof that violations are detected                   |
| `pnpm test`         | unit tests (Vitest)                                                             |
| `pnpm test:int`     | integration tests against throwaway PostgreSQL 17 containers (Testcontainers)   |
| `pnpm build`        | production builds of contracts, API and web                                     |
| `pnpm test:e2e`     | Playwright e2e (starts the built API and web), then the Lighthouse budget       |
| `pnpm test:stories` | builds Storybook; axe on every story in 3 themes, visual regression at 5 widths |
| `pnpm openapi`      | regenerates `apps/api/openapi.json` from the contracts                          |
| `pnpm secrets:scan` | gitleaks secret scan of the working tree (via Docker)                           |

Stop the database with `pnpm db:down`. Data persists in a Docker volume; see the runbook to reset it.

## Conventions

- **Errors** are RFC 9457 `application/problem+json` with a stable `code` and a `requestId` (ADR-0014).
- **Logs** are JSON with `requestId`; passwords, tokens, cookies and phone numbers are redacted.
- **Configuration** is validated at startup. The API and worker refuse to start on invalid or missing variables, or on development placeholder credentials in production.
- **Database roles:** migrations run as `studyhub_migrator`; the API and worker run as `studyhub_app`, which can't change the schema (ADR-0003).
- **Module boundaries** are enforced by dependency-cruiser (ADR-0001).

More detail: [`docs/runbooks/local-development.md`](docs/runbooks/local-development.md).
