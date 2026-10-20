# Recovery verification

The implemented command runs **disposable full-database, single-school content and document-version recovery rehearsals**, not an existing-database restore command:

```powershell
pnpm.cmd test:recovery
```

Docker must be available. The integration harness creates a migrated PostgreSQL 17 source and fixtures for both schools, including every tenant-owned table. `restoreDisposableBackup` uses `pg_dump` in that disposable source and always allocates a fresh target itself. It accepts no target connection URL. Init scripts provision roles separately; `psql -X -v ON_ERROR_STOP=1` restores into the fresh target. Both containers are cleaned up by the test harness.

The check compares counts and content hashes for every public table, verifies RLS/policy and database-role invariants, confirms that the runtime login sees no school data without context and only the selected school with context, and checks that subsequent source changes are absent from the backup snapshot. No developer/production database or existing volume is reset, cleared or restored.

After a successful run, `apps/api/test-results/recovery/latest.json` records backup time, restore time (including fresh target startup) and validated local RTO (backup through verification), plus the table count. These local, tiny-fixture timings do not establish production-size RTO. The report is generated and Git-ignored; record the actual values with the M10 evidence. Restore failures fail the command rather than producing a passing report.

## Reviewed single-school content recovery

`planSchoolContentRecovery` and `applySchoolContentRecovery` in `admin/application/school-recovery.ts` implement the explicit scope `existing-course-content-v1`, using the existing F46 export entries. The dry run returns the exact before/after content diff, blockers and a SHA-256 review digest. No recovery HTTP endpoint or command accepting an existing database URL is exposed in this pass.

The supported replacement fields are course title/subtitle/description (with regenerated plain search text), section title, lesson title, and text-lesson content. Only existing records are updated. No records are inserted or deleted; newer records remain present. Price, ownership, parent ids, publication/access settings, enrolments, memberships, shared identities, credentials, payments/ledger, assets and historical audits are never imported. Missing records, changed parent links or changed lesson types block the entire apply instead of making a partial repair.

Both phases require an active platform owner from the server-owned staff context. Applying requires the reviewed digest, a reason and an owner-review reference. The digest binds the source, target rows, school, operator and scope. The implementation locks target rows and recalculates the digest in the apply transaction, rejecting intervening edits or a substituted archive/operator. Values use parameterized Prisma templates; table and column identifiers come only from the compiled recovery policy. Forced RLS and explicit school predicates remain enabled. Course/lesson versions advance rather than being rolled back.

Content changes and new school/platform audit entries commit atomically. Audit records contain the scope, affected ids/counts, review digest, operator, reason and review reference; they do not duplicate lesson bodies or credential data. The review reference records an external owner review, not a cryptographic owner approval or substitute for an eventual reauthenticated operator flow. A no-op emits no misleading recovery audit.

The disposable integration fixture exports through the real F46 function, then changes teaching content and a shared identity. Tests verify the bounded content repair, unchanged global/protected table hashes and every other-school table hash, newer-record preservation, stale/source/operator denial, foreign/duplicate ids, unsafe source JSON, invalid live JSON repair, blocked missing/parent references, and rollback if platform audit insertion fails. Runtime writes use `studyhub_app`; the fixture's elevated observer is used only to inspect hashes and inject failures in a disposable database. A timing report is written to `apps/api/test-results/recovery/single-school.json`.

For a future staged operational flow: restore the desired backup to scratch, generate F46 entries for the selected school, prepare and review the scoped diff with the owner, obtain a fresh authorized operator session, apply the reviewed digest/reason/reference, and verify the dual audit plus unrelated-school/shared-identity invariants. Do not wire this into a production controller or run it against existing data until the remaining operator approval, pre-restore backup and object/recreation gates below are completed.

## Remaining recovery engineering (outside the verified content scope)

The native-version document recovery library and disposable test are now implemented: see [object recovery scope and compatibility](../design/object-recovery.md). It recovers a READY document of at most 25 MiB and the same size/MIME to a fresh key, after byte checks and scanning, with atomic asset-pointer/dual-audit updates. Original keys and versions are retained. The report is `apps/api/test-results/recovery/objects.json`.

**Selected production direction: R2 plus application-managed backups.** The separate-bucket snapshot adapter and inventory are implemented and locally verified with native versioning disabled; see the design above. Automatic verified-upload capture, credential separation, approved retention/cleanup, trusted inventory and an actual R2 staging rehearsal remain required. Images/derivatives, managed videos, larger/quota-changing files and operational approval remain unverified. No existing database or production bucket was changed.

Blueprint 04 section 17.16 requires a separate single-school procedure: restore the selected PITR target to scratch, use the F46 school export, review the diff with the school owner, re-import within the school's context as an audited platform action, then restore object versions under `t/{tenantId}/`.

The current F46 export is a portability archive, **not a round-trip database backup**. `admin/application/exports.ts` excludes session/outbox/idempotency/archive tables and bytea/search-vector fields. Some excluded binary fields hold required ciphertext. Do not insert these JSON rows blindly, disable RLS, or roll back shared user accounts/other schools to make an import succeed. A safe import needs an explicit supported-table/field plan, reference mapping, preserved credentials and shared identities, conflict/diff review, an audit record and rollback-on-error verification. This is outstanding engineering, not a reason to change retention or legal policy.

The full logical rehearsal itself excludes asset bytes/versions, managed video state, payment-provider state, encryption-key recovery and managed PITR. The separate bounded content/document recoveries satisfy only part of the school import/diff/audit requirement. Extend reviewed missing-record/reference handling and object coverage, preserving the existing unrelated-school/shared-identity checks. Then repeat the documented full/school procedures at representative scale in staging. Only a verified managed PITR setup can substantiate the five-minute RPO target; `pg_dump` alone cannot.
