# Design note: course periods (terms, semesters, seminars) and open courses

- **Status:** DONE (2026-10-21). Scope addition requested by the product owner before M10 is finished. Decisions 1–5 in §4 were confirmed by the product owner on 2026-10-21; items 6–9 are **PROPOSED** implementation details.
- **Changes the blueprint:** not in 03 (F08 has categories and subjects only). Periods are a second, independent way to arrange courses; categories and subjects are unchanged.
- **Baseline:** `payment-plans-wip` commit `f0eb535`, branch `course-terms-wip`.

## 1. What the product owner asked for

Schools, universities and tutors who teach term by term arrange courses into **terms, semesters or seminars**. An administrator decides when each one opens, and can lock or open single courses. Other courses (skills, short courses) stay **open**: they belong to no period and are never locked by one.

Decisions taken with the product owner (2026-10-21):

| Question                         | Decision                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What a locked course allows      | Learners **see it and can enrol or pay in advance**; lessons, quizzes and practice stay locked until it opens                                                 |
| How a period opens               | **Dates plus a manual switch**: it opens on its start date; an administrator can open it early or keep it locked, and can override single courses             |
| When a period ends               | **Courses stay open**: learners keep what they had (as with unpublishing, M6)                                                                                 |
| Who assigns a course to a period | The **tutor picks** a period (or "Open") in Studio; **administrators** create periods, lock and open them, and can reassign or override any course            |
| What a period is called          | Each period is a **Term, Semester or Seminar**, chosen when it is created; "Open" means no period. The catalogue can be filtered by period or by open courses |

## 2. Model

- **Period** (`academic_period`, per school): `name` ("Term 1 2027"), `kind` (`TERM`, `SEMESTER`, `SEMINAR`), `starts_at`, optional `ends_at` (after the start), `mode` (`AUTO`, `OPEN`, `LOCKED`), `position`, `archived_at`. Archived periods are hidden from pickers and the catalogue filter; their courses keep their period and its state.
- **Course:** `period_id` (null = open course) and `access_override` (null, `OPEN` or `LOCKED`), set by administrators only.
- **Is the course open now?** (`courseLock`, pure, in `learning/domain/period-access.ts`), first match wins:
  1. administrator override on the course: `OPEN` → open, `LOCKED` → locked (this applies even to a course with no period, so a tutor cannot move a course out of a locked period to open it);
  2. no period → open;
  3. period `mode` `OPEN` → open, `LOCKED` → locked;
  4. `AUTO`: open from `starts_at`; before it, locked with "opens on `starts_at`".
     `ends_at` never locks anything (decision 3); it is shown with the period.
- **Who is locked out:** only enrolled learners. The course owner and administrators always open the content (as with deposits). Preview lessons stay open to everyone, as before.

## 3. Behaviour

- **Catalogue:** cards and the landing page show the period ("Term 1 2027") and, while locked, "Opens 13 Jan 2027" (or "Not open yet" when locked by hand). Filter `period=<id>` or `period=open`. `GET /periods` lists the school's current periods for the filter.
- **Enrolment and purchase:** allowed while locked (decision 1). Deposits are unchanged: the balance is due from the deposit date.
- **Player:** the outline is shown with every non-preview lesson locked and a banner. Lessons, videos, files, progress, lesson quizzes and practice return **`COURSE_NOT_OPEN` (403)** with the period name and `opensAt` (null when locked by hand). A lock takes precedence over a deposit limit.
- **My learning:** a locked course shows "Opens …" instead of "Continue".
- **Studio (S-T07):** a "Term / semester" select with the school's periods and "Open course (no term)". It shows the administrator's override when one is set.
- **Administration:** Admin → Terms (`/admin/periods`): create, rename, dates, kind, archive; "Open now", "Keep locked", "Follow dates". Admin → Courses: period and override per course (`PATCH /admin/courses/{id}/period`).

## 4. Decisions

Confirmed by the product owner (2026-10-21):

1. A locked course is visible and can be enrolled in or bought; its content is locked.
2. Periods open on their start date; administrators can open early, keep locked, and override single courses.
3. The end date never locks content.
4. Tutors pick the period in Studio; administrators control locking and can change any course.
5. A period is a Term, Semester or Seminar; courses without one are open.

Still **PROPOSED** (implementation details):

6. A course override applies even to a course with no period (stops a tutor bypassing a lock by choosing "Open").
7. Dates are stored as instants; the admin form sends midnight in the administrator's browser time zone (schools have no time zone setting yet).
8. HTTP 403 `COURSE_NOT_OPEN` with `courseId`, `periodName` and `opensAt` in the problem.
9. No email when a period opens (can be added with the notification preferences later).

## 5. What was built

- Migration `0012_course_periods`: `academic_period` (school-owned, RLS), `course.period_id` and `course.access_override`, with a CHECK that a period ends after it starts.
- API: `GET /periods`; `GET|POST /admin/periods`, `PATCH /admin/periods/{id}`; `PATCH /admin/courses/{id}/period`; `periodId` in Studio; the period and lock on catalogue cards, the landing page, the admin course list, the player and My learning; catalogue filter `period=<id>|open`; `COURSE_NOT_OPEN` (403) on locked lessons, their videos, files and progress, lesson quizzes and practice. The rule is `courseLock` in `learning/domain/period-access.ts`; every grant carries it.
- Web: Admin → Terms & semesters (add, edit, Follow dates / Open now / Keep locked, archive); term and access selects per course in Admin → Courses; the term picker in Studio → Details; the term filter on Browse; "Opens …" on cards, the course page and My learning; the player banner, locked lessons, and locked quiz and practice pages.
- Seed: Acme has "Term 1" (open, with Biology foundations) and "Semester 2" (opens in 90 days, with the new free course "Chemistry for semester two").

## 6. Tests

- Unit: `period-access.test.ts` (5 cases: no period, by date, manual switch, course override, locked open course).
- Integration: `course-periods.int.test.ts` (5 scenarios: admin-only periods and validation, Studio assignment and catalogue filters, enrolment in advance with locked lessons, progress, quizzes and practice, opening by date with the end date ignored, manual lock/open, course overrides, the tutor bypass and archiving). The cross-school sweep (T-ISO-22) covers the new routes with an `academic_period` fixture.
- Browser: `course-periods.spec.ts` (Terms page, catalogue filter, enrol before the semester, locked lesson, opening early), with axe.

`pnpm verify` passed on 2026-10-21: lint/format, typecheck, boundaries, 424 unit tests (API 377, contracts 35, UI 12), 929 integration tests in 23 files, production build, 8 security browser tests, 67 isolated e2e checks, 198 Storybook checks, OpenAPI and the secret scan. The full run found two gaps that are fixed: the new table needed the purge grant for school offboarding (F46), and the new routes needed registering in the cross-school route list (T-ISO-12).
