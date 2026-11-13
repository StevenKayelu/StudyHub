# Topic periods (terms, semesters and seminars)

Periods organize the individual topics (lessons) inside a course. A course remains the unit a learner
enrols in or purchases; its topics can belong to different periods or be open without a period.

## Model

- **Period** (`academic_period`, per school): `name`, `kind` (`TERM`, `SEMESTER`, `SEMINAR`),
  `starts_at`, optional `ends_at`, `mode` (`AUTO`, `OPEN`, `LOCKED`), and `archived_at`.
- **Topic** (`lesson`): `period_id` (null means that topic is open). Topics in the same course can
  have different periods.
- A topic with no period or an `OPEN` period is open. A `LOCKED` period keeps its topics closed.
  `AUTO` opens topics at `starts_at`; the end date never locks them again.
- Only enrolled learners are locked out. Course owners and school administrators can always open
  content. Preview topics remain available to catalogue visitors, as before.
- There is no course-level period assignment or course-wide access override.

## Configuration and editing

1. An administrator creates and maintains periods in **Admin → Terms & semesters**. The admin can
   choose the kind, dates, and whether it follows dates, is open now, or stays locked.
2. A tutor assigns a period to each topic in **Studio → Course → Outline → Edit lesson → Term or
   semester**. Choose **Open topic (no term)** for content that should always be available. The
   assignment can be changed later from the same lesson editor.
3. Assigning a period to a topic does not change enrolment or purchase access to its course.

Archived periods disappear from pickers and period filters, but existing topic assignments and
period access behavior are retained. The API rejects assigning an archived period to another topic.

## Learner access

- The course catalogue and landing page show the periods represented by its topics. A period filter
  includes courses with at least one topic in that period; the open filter includes courses with at
  least one unassigned topic.
- The learner's course outline marks individually locked topics and shows their period names.
  Unassigned topics and topics in open periods remain available even while another topic in the same
  course is locked.
- A closed period blocks access to that topic's content, files, video, progress, and attached quiz.
  `COURSE_NOT_OPEN` identifies the course and lesson and includes the period name and `opensAt`.
- Course-wide practice uses the whole question bank and is not tied to a topic period; deposit-plan
  restrictions still apply to it.
- Enrolment, purchase, and deposit rules remain course-level and are unchanged.

## Migration and implementation

Migration `0017_lesson_periods` adds `lesson.period_id` and copies each existing course period to all
of its lessons so that the previous lock applies to the same content. It then removes
`course.period_id` and the course-wide `access_override`. Periods remain school-owned, tenant
isolated, and protected against deletion while topics reference them.

`periodLock` in `learning/domain/period-access.ts` decides whether an assigned topic is open.
`lockedLessons` combines topic-period locks with deposit limits; period locks take precedence for a
topic assigned to a closed period.

## Validation coverage

- Unit tests cover unassigned topics, start dates, and automatic and manual period modes.
- Integration tests cover per-topic assignment, mixed open and locked topics within one course,
  learner access and quiz gating, period management, and archiving.
- Browser tests cover the terms page, period filters, locked topics, and opening a period early.
