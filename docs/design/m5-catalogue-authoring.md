# M5 design note: instructors, catalogue and authoring

- **Status:** IMPLEMENTED (2026-10-13). Items marked **PROPOSED** were decided during implementation and need client confirmation.
- **Baseline:** M4 commit; blueprint revision 4 (04 §17.9; 05 §3.3, §4.2–4.5, §4.9, §8.2; 06 S-P01–S-P05, S-T01–S-T08, S-T12, S-AD03–S-AD06; BR-04, BR-05, BR-28, BR-49, BR-56, BR-57, BR-64).
- **Scope (07 §M5):** F06–F13 per school; instructor onboarding modes; course and material settings as defaults and limits; uploads under `t/{tenantId}/`; video through a provider with the webhook resolved by `resolve_video_asset`; a per-school catalogue (public or members-only).

## 1. Data model (migration 0005)

| Table                                    | Notes                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `category`, `subject`                    | Two levels (F08). Archived ones leave the catalogue but keep their courses.                                                                                            |
| `instructor_profile`                     | One per membership; application status, decision note, re-apply date (F06). Its slug gives the public page `/t/{slug}`.                                                |
| `course`                                 | Status machine (05 §3.3), optimistic `version`, `search_vector` (generated, weighted title > subtitle and tags > description), `enrollment_count` for "most popular".  |
| `course_submission`                      | Review history with the checklist snapshot at submission and the decision notes (F12).                                                                                 |
| `section`, `lesson`, `lesson_attachment` | Positions are unique per parent with **deferrable** constraints, so a whole reorder is one transaction. `lesson.quiz_id` waits for M7.                                 |
| `asset`                                  | Every upload: purpose, kind, status (`PENDING_UPLOAD → UPLOADED → SCANNING → READY / REJECTED`), storage key under `t/{tenantId}/`, derivative key, provider video id. |
| `tenant_usage`                           | Stored and reserved bytes per school (BR-49). Slots reserve their declared size under `FOR UPDATE`; expired reservations are released.                                 |

All tables are school-owned with forced RLS and composite foreign keys (`tenant_id`, id), checked by the structural T-ISO tests.

**Search:** `pg_trgm` lives in its own schema `ext` (the M2 rule "no EXECUTE for PUBLIC on new functions" would otherwise block it); the runtime role gets EXECUTE on that schema only. Full-text (`simple` configuration, so it works in every language) plus trigram similarity on the title for typos.

**Definer inventory addition:** `resolve_video_asset(provider, provider_video_id)` → asset and school id. A provider webhook arrives before any school context exists; this is the only way to find the school, and it returns nothing for unknown ids.

## 2. Flows

| Flow                  | Behaviour                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructor onboarding | `INVITE_ONLY` (default) or `APPLICATION` (BR-56). Applicants need a verified email; they save a draft, submit, and see the decision. Administrators approve (adds the INSTRUCTOR role), request changes or reject (with a reason; re-apply after 30 days). Suspension removes Studio and takes the instructor's courses out of the catalogue (BR-28).           |
| Authoring             | Create with a title → outline (sections and lessons; move up/down, also across sections) → lesson content (TEXT rich text, VIDEO upload, FILE attachments) → details (description, outcomes, subject, tags, cover) → pricing → publish checklist (BR-04). Every write carries the version; a stale one is `409 VERSION_CONFLICT` and the UI reloads the latest. |
| Review (BR-05)        | With `courseReviewRequired` (default on) the first submission goes to IN_REVIEW; an administrator approves (published) or requests changes with notes. A course that was published once is republished without review.                                                                                                                                          |
| Rich text (F10)       | ProseMirror JSON validated against an **allowlist** (node types, marks, attributes, `http(s)`/`mailto` links, size and depth limits) and normalised before storage. The web renders it to React elements; no HTML string exists anywhere. The editor (Tiptap) offers only allowed formatting.                                                                   |
| Uploads (F11)         | The API issues a presigned PUT bound to type and size; the browser uploads straight to storage; "complete" queues `media.process`. The worker checks the real bytes (magic numbers), scans for malware, makes a web-sized derivative for images, then marks READY or REJECTED with a reason. Effective limit: `min(platform, plan, school)`.                    |
| Video                 | A provider port. The provider calls `POST /api/v1/webhooks/video/{provider}` (HMAC-signed); the API resolves the asset with `resolve_video_asset` and updates it inside that school's context.                                                                                                                                                                  |
| Catalogue (F13)       | Home (search first, newest), browse (search, subject, level, price, sort; all in the URL and usable without JavaScript), course landing (outline, instructor, price), instructor page. Members-only schools send visitors to sign in (BR-57). Enrolment arrives with M6, so the landing shows "Enrolment opens soon".                                           |

## 3. PROPOSED decisions

1. **Local object storage is SeaweedFS** (S3 API, `chrislusf/seaweedfs:4.48`, port 8333). MinIO images are no longer published on Docker Hub. Production remains Cloudflare R2 (04); the code only uses the S3 API.
2. **Video provider is a fake** until one is approved (like payments). It accepts the upload at `/api/v1/dev/fake-video/{id}` and sends a signed READY webhook. The API refuses `VIDEO_PROVIDER=fake` in production.
3. **Malware scanning:** ClamAV (`clamd` INSTREAM) in production; locally and in tests an `eicar-only` scanner that flags only the EICAR test file. Production refuses `eicar-only`.
4. **Paid courses are blocked** at the checklist ("payments available soon") until M8 brings payment accounts and payouts. Prices can already be prepared.
5. **Quiz lessons** can't be created until M7.
6. **Catalogue paging** uses an offset cursor (opaque to clients). Simple and good enough at catalogue sizes; the contract stays the same if it becomes keyset-based.
7. **Default storage quota** of 10 GB per school (`DEFAULT_STORAGE_QUOTA_MB`) until plans exist (M9).
8. **Sharing previews** use the school's own image (`/og.png`); cover URLs are short-lived signed links and can't be used by social networks.
9. **Inline images in rich text** are accepted by the schema (`asset:{id}`, checked to belong to the school) but the editor doesn't insert them yet; the course player (M6) will render them with signed URLs.

## 4. Configuration

| Variable                                      | Default (local)                                        | Production                   |
| --------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`       | `http://127.0.0.1:8333`, `us-east-1`, `studyhub-local` | R2 endpoint and bucket       |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`    | local placeholders (`infra/seaweedfs/s3.json`)         | real keys; local key refused |
| `S3_CREATE_BUCKET`                            | `true`                                                 | must be `false`              |
| `MALWARE_SCANNER`, `CLAMD_HOST`, `CLAMD_PORT` | `eicar-only`                                           | `clamd`                      |
| `VIDEO_PROVIDER`, `FAKE_VIDEO_SECRET`         | `fake`                                                 | a real provider (open)       |
| `DEFAULT_STORAGE_QUOTA_MB`                    | `10240`                                                | per plan (M9)                |

## 5. Tests

| AC                                                                    | Test                                                                                                                                                                                                                           | Result |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1 Revision 1 authoring ACs (F06–F13)                                  | `catalogue.int.test.ts` (full review flow, checklist, reorder + 409, private drafts, unsafe rich text, typo search, applications, BR-28) and `catalogue.spec.ts` (browser: author → upload cover → submit → approve → visible) | Pass   |
| 2 Slugs reusable across schools                                       | `catalogue.int.test.ts` AC 2                                                                                                                                                                                                   | Pass   |
| 3 The catalogue never lists another school's courses                  | `catalogue.int.test.ts` AC 3, plus T-ISO fixtures for all ten new tables                                                                                                                                                       | Pass   |
| 4 Upload-type restriction enforced; storage limit blocks upload slots | `catalogue.int.test.ts` AC 4 (both)                                                                                                                                                                                            | Pass   |
| 5 A video webhook for an unknown id touches no school data            | `catalogue.int.test.ts` AC 5, plus signature and right-school tests                                                                                                                                                            | Pass   |

Also covered: F11 type sniffing and EICAR rejection, files under the school prefix, BR-57 members-only catalogue, authorization-matrix rows for every new endpoint, T-ISO-12 route coverage for the new routes, and axe checks on the catalogue, Studio and publish pages.
