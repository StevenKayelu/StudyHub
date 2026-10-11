# Dependency audit: overrides and exceptions

`pnpm audit --audit-level high` runs in CI and must pass. Every override or exception is recorded here with its package, advisory, impact on StudyHub, rationale and review trigger.

Last reviewed: 2026-10-11 (Milestone 1).

## Overrides (patched versions forced)

Configured in `pnpm-workspace.yaml` → `overrides`.

### `deepmerge-ts` → `>=8.0.0` (resolved 8.0.2)

- **Advisory:** [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). High. Stack exhaustion when merging recursive object graphs. Affects `<8.0.0`.
- **Path:** `prisma` (dev dependency) → `@prisma/config` → `deepmerge-ts` 7.1.5.
- **Impact on StudyHub:** low. It is only used by the Prisma CLI to merge its own configuration at development and migration time; it is not in the API, worker or web runtime, and it never receives user input.
- **Rationale:** a patched version exists, so we force it rather than accept the risk.
- **Verification:** `prisma generate`, `prisma validate`, `prisma migrate deploy` and the full integration suite (25 tests) pass with 8.0.2.
- **Remove when:** Prisma depends on `deepmerge-ts` ≥8 itself.

### `mysql2` → `>=3.23.1` (resolved 3.24.5)

- **Advisories:**
  - [GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr). High. Auth-plugin downgrade to `mysql_clear_password` leaks plaintext credentials. Affects `<3.22.0`.
  - [GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3). Moderate. Unbounded zlib inflate (decompression bomb). Affects `<=3.23.0`.
- **Path:** `prisma` (dev dependency) → `mysql2` 3.15.3.
- **Impact on StudyHub:** none in practice. This is the Prisma CLI's MySQL driver. StudyHub uses PostgreSQL only, so the code is never loaded, and it is not in any runtime bundle.
- **Rationale:** a patched version exists; forcing it removes the finding at no cost.
- **Verification:** same as above.
- **Remove when:** Prisma depends on `mysql2` ≥3.23.1 itself.

## Exceptions (no fix available)

Configured in `pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`, one advisory id at a time. Never ignore by package name or by severity.

### `braces` ≤3.0.3 — no patched release exists

- **Advisory:** [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). High. Stack-exhaustion denial of service through deeply nested brace patterns.
- **Path:** `@next/eslint-plugin-next` (dev dependency) → `fast-glob` → `micromatch` → `braces` 3.0.3.
- **Impact on StudyHub:** negligible. It runs only inside ESLint on developer machines and in CI, expanding glob patterns written in our own lint configuration. No untrusted input reaches it, and it is not part of the API, worker or web runtime. The worst case is a lint run crashing on a pathological pattern we wrote ourselves.
- **Rationale:** there is no fixed version to upgrade or override to. Removing the Next.js lint rules would lose framework-specific checks (e.g. Core Web Vitals rules) for no real security gain.
- **Review when:** a patched `braces` or an updated `@next/eslint-plugin-next` is released. Re-check at every milestone.

## Process

1. CI fails on any new high or critical advisory.
2. Prefer upgrading the direct dependency. Otherwise use an override with the narrowest range that includes the fix, and run the full test suite.
3. If no fix exists, add an exception **only** for development-time paths unreachable by untrusted input, documented in this file with impact, rationale and a review trigger.
