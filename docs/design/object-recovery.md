# School-scoped document version recovery

Status: local engineering verification passed; production rollout remains incomplete. This is a bounded recovery library and disposable rehearsal, not an enabled production operation. Normal storage configuration, provider selection and bucket settings are unchanged.

## Selected R2 backup design

The blueprint assumes asset versions on Cloudflare R2. Cloudflare's [current S3 compatibility reference](https://developers.cloudflare.com/r2/api/s3/api/) lists `GetBucketVersioning` and `PutBucketVersioning` as unsupported (reviewed 2026-10-18). The native-version adapter implemented here must not be described as an R2 recovery solution. It positively checks enabled versioning and the exact returned version id and refuses a bucket/provider that cannot supply them.

The client selected **keep R2 and add application-managed version backups** on 2026-10-18. `S3DocumentBackupStorage` uses separate live and backup buckets, without native versioning. `capture` reads a bounded document and writes a fresh UUID snapshot plus a strict manifest binding school, source key, size, MIME and SHA-256. Conditional creates prevent accidental replacement. `list` discovers manifests for that school/source with bounded pagination. Recovery verifies the manifest and content checksum, then uses the existing reviewed pointer/audit workflow. The native adapter remains an alternate disposable test backend.

**Not enabled automatically:** upload/worker capture, retry/outbox integration, backup credentials and inventory monitoring still need implementation/configuration. Existing documents have no guaranteed backup until captured. Local tests use disposable SeaweedFS, not an actual R2 account; no production bucket or provider setting was changed.

Application-enforced conditional creates are not WORM or protection against a compromised backup administrator. Use separate backup credentials/accounts and restrict ordinary runtime access; approve an independently trusted inventory/checksum record and access procedure. Retention duration and orphan cleanup require owner policy, not an invented default.

## Supported operation

`planDocumentObjectRecovery` / `applyDocumentObjectRecovery` operate on an existing READY school document, without derivatives, at most 25 MiB. The selected historical version must have the same size and MIME as the current asset. Images, managed video, larger files, size/quota-changing restoration, deleted database rows and whole-school rollback remain outside this scope.

1. Authenticate the active platform owner from server-owned context and read/lock the selected asset within its school's forced-RLS transaction. Refuse foreign or unsupported assets before provider access.
2. Outside the database transaction, identify the selected immutable snapshot or native object version. Never substitute latest bytes or a null/missing version.
3. Bind source metadata, the current asset row, school, operator and scope in the review digest. Require an owner-review reference and reason, as with content recovery.
4. Re-review before apply. Read only the selected immutable version with strict metadata/length bounds; validate magic bytes and run the configured malware scanner. Scanner failure/rejection blocks recovery.
5. Write the validated bytes to a fresh `t/{tenantId}/recovery/{uuid}` key using conditional create. No existing key/version is overwritten or deleted. The recovery adapter must use the same bucket as the normal application storage adapter.
6. In a fresh school-scoped transaction, lock/recheck the asset row and active operator. A concurrent database edit invalidates the review. Update the storage pointer/checksum and append school/platform audit records atomically. Do not change shared identities, ownership, usage counters or other-school records.
7. Verify the recovered bytes through the normal application storage port, and verify the old/damaged versions, other-school object and database hashes remain intact.

All storage/scanner I/O is outside DB transactions. Version ids/keys are identifiers, not credentials. Audit metadata records source/target keys, source version, checksum, scope, operator, reason and review reference; no file bytes or credentials are copied into audit payloads. No HTTP write route or existing-database CLI is exposed.

## Failure and operational limits

- An audit/DB failure rolls back the pointer and both audit records. The unreferenced candidate object is retained; automatic cleanup/retention has not been invented. Retained candidates and native versions consume physical storage and need an approved operational budget and cleanup policy before production.
- Database and object storage do not form one distributed transaction. The code guarantees atomic pointer/audit changes and preserves originals; it does not atomically roll back independent writes to an old storage key. Production operation needs a coordinated maintenance/write-control procedure, reviewed candidates and a pre-operation backup.
- An owner-review reference is an external review record, not proof of actual school-owner approval. A reauthenticated operator/owner approval workflow remains a launch gate.
- Rescanning uses the injected scanner. Tests use the development EICAR scanner and a rejecting fixture; they do not certify real ClamAV signatures or malware coverage.
- Snapshot capture or native version retention must already be provisioned. The recovery adapter cannot enable versioning, modify lifecycle rules or delete versions. It cannot recover history that was never retained.

## Verification command

`pnpm.cmd test:recovery` runs full logical database recovery, single-school content recovery, native-version document recovery and application-managed document backup recovery against disposable resources. The document fixture uploads original/damaged versions and another school's file, then verifies selected-byte recovery, normal storage reads, other-school preservation, invalid versions/metadata, malware/type/size denial, audit rollback and concurrent database edits. Storage protocol unit tests separately cover unsupported versioning, ignored version selection, key boundaries, incomplete/oversized streams and conditional staging.

Latest run: **20 checks passed across four files**, including six application-backup cases with native versioning disabled. These cover snapshot inventory, retained copies, tamper denial, school/source binding, missing live-file recovery and shared-bucket refusal. The 2048-byte application-backup recovery took **594 ms**, including local verification; other-school data and shared tables were unchanged. Generated evidence: `apps/api/test-results/recovery/objects.json` and `application-backups.json` in the same directory. Actual results and historical versus current checks are recorded in the M10 note after execution. These tiny local timings do not establish production recovery time or RPO.
