# Dashboard configuration runbook

This runbook covers the first managed configuration phase and the existing school feature controls. The [architecture note](../design/dashboard-configuration.md) records the repository gaps, implementation phases and future integration design. Dashboard provider activation and secret import are not available in this phase.

## Managed settings

The managed content editor covers these existing settings:

| Setting                    | Accepted values          | Effect after activation                                                   |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Catalogue visibility       | `PUBLIC`, `MEMBERS_ONLY` | Next catalogue request; members-only access is checked by the API.        |
| Course review required     | `true`, `false`          | Next eligible course submission. Existing courses are not unpublished.    |
| Allow downloads by default | `true`, `false`          | New lessons only. Existing lesson download permissions are not rewritten. |

The platform editor sets inherited defaults and controls whether schools may override them. The school editor shows the inherited value, saved override, lock status and effective value. A school administrator changes only the school selected by the current school host; there is no tenant-id field to switch scope.

Use the platform console as a `PLATFORM_OWNER`. Policy activation requires the console's recent TOTP reauthentication. Use the school administration area as a school owner or administrator with the existing `admin.access` permission; support-session writes follow the existing support-access rules. Support access must not grant secret management privileges.

1. Open the managed content configuration editor for the intended scope.
2. Check the displayed effective and inherited values before editing.
3. Save a draft. Live behavior stays unchanged until activation.
4. Review the changed values, override/reset choices and the effect descriptions above.
5. Enter a reason and activate the reviewed draft. If the review is stale, reload and review again.
6. Refresh the relevant school page or make a new request to verify the result.

Resetting an override restores inheritance; it does not freeze today's inherited value. A future platform-default change can then affect that school. A platform lock can make a saved school override ineffective. Reverting an eligible historical revision creates a new configuration change under current policy. Neither reset nor revert undoes emails, payments, uploaded objects, published courses or other completed actions.

These three settings take effect on the next relevant request or new-content operation. They do not require an API restart, worker refresh or deployment. Changing deployment/bootstrap variables is a separate operator procedure and usually requires a restart.

## Import a small settings file

Only these three nonsecret setting aliases are accepted. The input is `.env`-style key/value data; the parser does not execute it or expand variables. Use a dedicated file containing only the intended settings:

```dotenv
SCHOOL_CATALOG_VISIBILITY=MEMBERS_ONLY
SCHOOL_COURSE_REVIEW_REQUIRED=true
SCHOOL_DOWNLOADS_ALLOWED_DEFAULT=false
```

The same allowlist is used for platform defaults and school overrides; ownership comes from the authenticated editor scope, not the `SCHOOL_` prefix. The text is limited to 32,768 UTF-8 bytes. Files cannot set platform locks. Use exactly the catalogue values and lowercase booleans shown above; duplicate keys are rejected. Blank lines, comments, a leading BOM, optional `export ` prefixes and single-line quoted values are accepted. Values are not expanded or interpreted as shell expressions. Inline comments after unquoted values need whitespace before `#`.

1. Select the dedicated settings file in the intended platform or school editor.
2. Preview the parsed settings and validation errors.
3. Remove unsupported, invalid or wrong-scope keys and preview again.
4. Choose **Use preview in draft** to merge its values into current local edits. Settings omitted from the file stay as currently edited; school-locked entries are shown as excluded.
5. Save the complete draft, review its changes and activate it.

Do not upload the deployment's real `.env`. Database URLs, encryption keys, SMTP/storage credentials, proxy trust, host names and process configuration are unsupported bootstrap or integration settings. The import never overwrites `.env`, retains the raw file or applies unsupported values. Errors should identify keys and the reason for rejection without repeating their values. Credential imports and credential entry will be added with the integration vault and are not supported here.

For API clients, the editor bases are `/api/v1/admin/configuration` for a school and `/console/configuration` for the console backend (`/api/console/configuration` through the web proxy). Read the current view, save the complete desired values with `PUT /draft`, and activate using `POST /activate` with the returned draft id and current revision. `POST /import-preview` accepts `{ "text": "..." }` and returns validated entries only. A draft's missing keys mean reset to inheritance, so clients must not send a partial patch as a full draft. The revision is a content digest, not a counter. A new draft gets its own id; replacing a saved draft requires reviewing that new id before activation. History shows snapshots from the latest 20 activation records plus the baseline before the earliest retained activation. Reviewing the baseline as a new draft allows the first activation to be reverted. Older settings PATCH events are not included.

## Change a feature for one school

An administrator can enable only an implemented feature the school is allowed to use. A missing capability still needs development; a switch cannot add a new provider or workflow.

1. In the platform console, select the intended school and inspect its plan and feature override.
2. Grant the completed feature if it is a pilot outside the assigned plan, or remove a platform revoke according to the intended entitlement.
3. In that school's feature editor, turn its available switch on.
4. Verify the relevant API operation as well as navigation. Check a second school's independent state.

The effective feature needs a plan grant or platform `GRANT`, a school switch that is on, and no platform `REVOKE`. The platform revoke takes precedence. `customDomain` and `certificates` remain unimplemented, and the console refuses grants for them. Most unset school switches default on; instructor revenue share defaults off. A school with no assigned plan currently retains legacy access to built capabilities. Usage and upload limits still apply when a feature is on.

The backend now enforces application drafts/submission through `instructorApplications`; approved instructors keep their profile access. Revoking `publicCatalog` blocks anonymous catalogue and lesson previews while retaining normal enrolled/member access. Revoking `whiteLabel` restores the powered-by badge in current bootstrap branding without erasing the saved preference. A queued full export rechecks `dataExport` before it starts; a revoked export fails with `FEATURE_NOT_ENABLED` and must be addressed by an administrator. It is not a continuous cancellation mechanism for work already running.

Instructor revenue sharing requires paid courses. For school switches and console overrides, enable paid courses before enabling or granting sharing, and disable sharing before removing paid-course access. These requests return dependency errors for an invalid transition and retain their normal audit records. Plan edits and reassignment do not yet enforce this transition policy, so review those changes manually. Payment confirmation currently uses the sharing feature and commission/refund settings effective at confirmation rather than a complete immutable checkout snapshot; do not change those terms during pending sales expecting all sale terms to stay frozen. Resolving that financial snapshot behavior is remaining development work.

Turning a feature off preserves its data. Existing accepted work may need to complete for integrity or financial reasons; the architecture note describes the required per-job policy. A full rollout/dependency scheduler is future work.

## Verify with two local schools

Use isolated local fixtures or a disposable test database. Do not change production or an unrelated developer database to demonstrate this workflow.

1. Open the two seeded school hosts independently and record their catalogue settings.
2. Keep the platform default public with overrides permitted.
3. Save and activate `MEMBERS_ONLY` for school A while leaving school B inherited or with its existing public override.
4. As an anonymous visitor, verify school A's catalogue API requires authentication and school B's remains accessible.
5. Check that school A's draft/history is unavailable from school B's authenticated session.
6. Reset school A to inheritance and confirm its public catalogue behavior returns.

For new-lesson defaults, change school A's downloads default, create a lesson in each school, and verify only A's new lesson uses the changed value. Existing lessons keep their original permission. Automated integration evidence and the exact local school names belong in the final implementation handoff.

The automated fixtures use **Acme Academy** and **Beta College**. Run `pnpm.cmd --filter @studyhub/api exec vitest run --config vitest.integration.config.mts test/integration/configuration.int.test.ts` for HTTP/runtime isolation, draft/activation/reset, restrictions, reauthentication and import checks against a new disposable database. Run `pnpm.cmd test:e2e:isolated admin.spec.ts --project=chromium-msedge` with `PLAYWRIGHT_CHANNEL=msedge` for the administrator browser journeys, including an Acme-only activation and reset. The isolated runner builds its own web output, uses dedicated ports and seeds only fresh test services.

## Recover from invalid settings

If a draft is invalid, correct or discard it; live configuration is unaffected. If another administrator changed the live revision or a platform restriction changed, refresh the review and save a compatible draft. Do not bypass the validation by editing JSON directly.

For a bad activated nonsecret setting, use an eligible historical revision or reset a permitted school override, review the resulting effective values and activate with a recovery reason. Historical values are validated against today's schema and policy. An incompatible historical revision is not eligible for direct restoration.

If the database or bootstrap environment is invalid, the dashboard cannot repair the infrastructure it needs to start. Operators must correct deployment configuration using the setup/runbook procedure. Root encryption-key loss cannot be fixed by typing a new key in the dashboard: restored keys or a deliberate credential recovery process are required.

Malformed active managed values or an unknown configuration schema version return `SERVICE_UNAVAILABLE`; they are not silently replaced by permissive defaults. This affects all shared content readers, including relevant API operations, media jobs and payment-confirmation enrolment work. Restore valid configuration before retrying affected jobs. There is no dedicated configuration repair CLI or dashboard bypass in this phase. An operator must review the error, preserve the affected row and audit evidence, and use the deployment's controlled database maintenance process to restore a validated version 1 value. Do not delete an unknown document merely to make the page load. Future schema upgrades require an implemented, tested migration and rollback plan before deployment.

## Credentials and providers: current boundary

Object storage currently uses the S3-compatible adapter chosen by `S3_*` deployment configuration. The local provider is SeaweedFS. The repository selects R2 for production planning, but this phase does not add a dashboard R2 connection, test button or safe activation flow. API and worker currently create their media adapters at startup. Do not change the storage bucket or endpoint to simulate a safe switch while retaining existing assets.

Email uses deployment-configured SMTP. Malware scanning uses `clamd` or the development EICAR-only adapter; production rejects the latter. Managed video and payments currently have development fake adapters; production rejects the fakes. Lipila sandbox preparation does not yet constitute a complete runtime payment adapter. Do not describe another service as selectable until its implementation and validation are complete.

Existing school payment accounts keep their specialized encrypted, write-only credential and connection-test flow. Account history is retained when disabled so original payments and late webhooks remain attributable. Changing payment providers must preserve old transaction, refund, webhook, payout and ledger associations. It is independent of storage configuration.

## Future credential rotation procedure

The following is the required design for the integration phase, not an available storage dashboard operation:

1. Create replacement credentials at the provider with the minimum required bucket/account scope. Keep the currently working credentials valid during validation.
2. Enter them into a new encrypted credential version; never read saved secrets back to the browser.
3. Test the exact version with a bounded provider probe and review permissions/errors.
4. Activate only that tested version using recent reauthentication and a recorded reason.
5. Verify API and worker operations and reads of historical locations.
6. Revoke old credentials at the provider only after proving no historical location or in-flight work depends on them.

Root encryption-key rotation is a separate operator task: preserve old decryption capability, rewrap stored data keys in a controlled job, verify and audit completion, then retire the old key. Keep root keys outside dashboard-managed data. There is no general integration-key rotation UI or migration job in this phase.

## Future safe storage switch procedure

Do not execute this as a dashboard procedure until storage-location provenance and routing are implemented and tested.

1. Inventory the current location and backfill every original object, derivative, export and recovery reference to it.
2. Provision the new private bucket, scoped credentials, required school-origin CORS and separate backup protection. See Cloudflare's official [S3 setup](https://developers.cloudflare.com/r2/get-started/s3/) and [presigned URL guidance](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
3. Create and test a candidate configuration. A successful local signature is insufficient; verify the actual required object operations.
4. Review that only new uploads will use the new writer. Keep the old location and credentials available for reads and in-flight uploads.
5. Activate the exact tested revision, then verify old downloads, new uploads, scanning, derivatives, exports and worker behavior.
6. If needed, start a separately reviewed migration with progress tracking, retries, length/checksum verification and resumable checkpoints. Keep source objects; do not automatically delete them.

If the candidate test fails, keep the old writer active. If the new provider is unavailable after activation, show an actionable failure and use a reviewed activation of the previous valid writer for new uploads. Old assets still need their original location. Reverting the active writer neither copies nor restores objects and does not reverse a migration. Never silently substitute development storage.
