# M6 design note: learning experience

- **Status:** IMPLEMENTED (2026-10-14). Items marked **PROPOSED** were decided during implementation and need client confirmation.
- **Baseline:** M5 commit; blueprint revision 4 (03 F14–F16, §9.2; 04 §5.1 `learning` module; 05 §3.4, §4.3, §4.6, §8.2; 06 S-P03, S-L01–S-L03, S-T09, S-X07; BR-07, BR-12, BR-22, BR-52).
- **Scope (07 §M6):** F14–F16 per school; the video completion threshold comes from the school's settings (`videoCompletionThresholdPct`).

## 1. Data model (migration 0006)

| Table             | Notes                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enrollment`      | Belongs to a **membership** of the school (composite FK `(tenant_id, membership_id)`), so an entitlement can't point at another school even by mistake. `source FREE / PURCHASE / ADMIN_GRANT`, `status ACTIVE / EXPIRED / REVOKED`, `expires_at`, revocation fields, resume point, `progress_percent`, `completed_at`. |
| `lesson_progress` | PK `(tenant_id, enrollment_id, lesson_id)`; status, `position_seconds`, `completed_at`. Deleting a lesson deletes its progress.                                                                                                                                                                                         |

- **At most one ACTIVE enrolment** per (membership, course): partial unique index (F14 AC 1). A new enrolment after expiry or revocation is a new row; history is kept (05 §3.4).
- A course with enrolments can't be deleted (FK `RESTRICT`), matching "hard delete only if never published and no enrolments".
- The runtime role may insert and update enrolments and progress, never delete them.

## 2. Access rules

| Who                                         | Course bootstrap, lesson content, files, playback                                                             | Progress     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------ |
| Course owner, school administrator          | Every lesson, any status (F14 AC 3; "Preview as learner")                                                     | Not recorded |
| Learner with an ACTIVE, unexpired enrolment | Every lesson while the course is PUBLISHED, UNPUBLISHED or ARCHIVED                                           | Recorded     |
| Anyone who can see the catalogue (BR-57)    | Lessons marked **Preview** of a PUBLISHED course                                                              | —            |
| Everyone else                               | `403 ENROLMENT_INACTIVE` (the page shows the Enrol/Buy CTA, never content, F15 AC 2); a draft course is `404` | —            |

- Every request evaluates the enrolment again, so a revocation or expiry takes effect on the **next request** (F14 AC 2, BR-12). An enrolment found past its `expires_at` is marked EXPIRED in the same transaction.
- Another school's course or lesson is never found (RLS), so its entitlements can't be used or seen there (07 M6 AC 1).

## 3. Flows

| Flow                     | Behaviour                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free enrolment (F14)     | `POST /courses/{slug}/enrol` by a signed-in member: PUBLISHED, free, not the caller's own course. Access lasts `course.accessDays`, else the school's `defaultAccessDays`, else for life. `enrollment_count` goes up in the same transaction.                                                        |
| Admin grant and revoke   | `POST /admin/courses/{id}/enrollments {email, reason}` (works for paid courses too) and `POST /admin/enrollments/{id}/revoke {reason}`; both are audited.                                                                                                                                            |
| Player (F15, S-L02)      | Bootstrap gives the outline with each lesson's state, the progress % and the resume point. Text lessons have "Mark complete"; video lessons complete themselves at the school's threshold; file lessons list signed downloads. Previous/next, `←`/`→`, outline as a rail (wide) or a sheet (narrow). |
| Progress                 | `PUT /learn/lessons/{id}/progress {status?, positionSeconds?}`. The player saves the video position every 15 s of playback and also on pause, seek, leaving the page and switching lessons, so the resume point is within a few seconds (07 M6 AC 2). COMPLETED never goes back.                     |
| Progress % and BR-22     | Completed required lessons ÷ required lessons (all lessons when none is marked required). The course is complete when every required lesson is complete (required quizzes join in M7); S-L03 shows the completion screen.                                                                            |
| My learning (F16, S-L01) | Continue card (last lesson and position, opens exactly there), courses with progress, filters In progress / Completed on "Learning". Open quizzes and recent results arrive with M7.                                                                                                                 |
| Studio learners (S-T09)  | `GET /studio/courses/{id}/learners`: display name, enrolled, progress, last active. No email (Q-PRIV-2 still open).                                                                                                                                                                                  |
| Suspended school (BR-52) | See §4.                                                                                                                                                                                                                                                                                              |

## 4. Suspended and offboarding schools (BR-52, 07 M6 AC 3)

- The API keeps the school's status from host resolution. While a school is SUSPENDED or OFFBOARDING, every write is refused with `403 SCHOOL_READ_ONLY`, except signing in and out. Reads follow the normal rules, so enrolled learners keep their content; nobody can enrol, register, author or save progress.
- The web shows the neutral S-X07 page for everything except sign-in and the learner space. The school layout checks the first load; each space's layout (public, Studio, administration, account) checks again, because a client-side navigation into a space doesn't re-render the school layout. S-X07 offers "Sign in to your courses"; the player shows a read-only notice and doesn't save progress.

## 5. PROPOSED decisions

1. **Enrolments belong to the membership**, not the global account (stronger isolation; the blueprint's `user_id` predates D3).
2. **Free enrolment is idempotent:** enrolling again returns the existing enrolment (200) instead of `409 ALREADY_ENROLLED`, so a double click or a retry is harmless. `ALREADY_ENROLLED` is used by the admin grant.
3. **Enrolled learners keep access** when a course is unpublished or archived, or its instructor is suspended (BR-28 removes it from the catalogue, not from learners who have it). The player shows a notice.
4. **Video completion is decided by the server:** a video lesson completes when the saved position reaches `videoCompletionThresholdPct` (default 90) of its duration. "Mark complete" is offered only when the duration is unknown.
5. **Course completion is permanent:** lessons added later lower the percentage but don't undo `completed_at`.
6. **Suspended schools are fully read-only**, including progress (strict reading of BR-52). Sign-in stays open so learners can reach their courses.
7. **Expiry is checked on every access**; the daily job of BR-12 only tidies statuses and is deferred to operations (M10), because access never depends on it.
8. **Admin grant uses the member's email** on the course's learner page rather than the per-user screen (S-AD user management arrives later). Revoke is `POST …/revoke` with a reason instead of `DELETE` with a body.
9. **The fake video provider plays a simulated video** (a timer with the lesson's duration and normal controls), clearly labelled, because the fake provider keeps no video bytes. Real providers return a signed HLS or MP4 URL through the same port.
10. **Not yet:** offline downloads (F15 SHOULD), remembered scroll position in text lessons, recommended courses (F16 LATER), "time spent" on the completion screen.

## 6. Tests

| AC                                        | Test                                                                                                                                                              | Result |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1 Entitlements never cross schools        | `learning.int.test.ts` (same person in two schools; course, lesson, progress and My learning on the other host), T-ISO fixtures and forgeries for both new tables | Pass   |
| 2 Resume within ±5 s                      | `learning.int.test.ts` (saved position comes back exactly, also on another session) and `learning.spec.ts` (browser: play, leave, come back on a new page)        | Pass   |
| 3 Suspended-school read-only access works | `learning.int.test.ts` (content readable, every write refused, sign-in allowed) and `learning.spec.ts` (delta.localhost: S-X07, sign in, open a lesson)           | Pass   |

Also covered: F14 AC 1–3 (unique ACTIVE enrolment in the database, revoke and expiry on the next request, owner and admin access without enrolment), F15 AC 2 (locked lessons), BR-22 completion, video threshold, authorization-matrix rows and T-ISO-12 route coverage for the new endpoints, axe checks on My learning and the player.

## 7. Fixed along the way

- **Credentials in the URL (M4 forms):** a sign-in submitted before the page finished loading fell back to a native GET, putting the email and password in the address bar and server logs. Every form that carries credentials or tokens (sign-in, sign-up, reset, invitation, console, password change) now declares `method="post"`, so a native submit can only send them in the body.
