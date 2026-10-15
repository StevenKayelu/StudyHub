# M7 design note: assessment engine

- **Status:** IMPLEMENTED (2026-10-15). Items marked **PROPOSED** were decided during implementation and need client confirmation.
- **Baseline:** M6 commit; blueprint revision 4 (03 F17–F23, F40, §9.2; 05 §3.5, §4.4, §4.7, §8.2 `tenant_feature`; 06 S-L04–S-L07, S-T05, S-T06, S-T10; BR-16 to BR-23, BR-48).
- **Scope (07 §M7):** F17–F23 per school; quiz and practice defaults from the school's settings (`quizDefaults`, `practiceDefaults`); feature switches (`practiceMode`, `quizAnalytics`).

## 1. Data model (migration 0007)

| Table                                       | Notes                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question`, `question_option`               | Per course. Archived, never deleted. `practice_eligible` is forced off for long answers (CHECK, F22 AC 3). Options keep their ids by position across edits, so analytics can follow them. |
| `quiz`, `quiz_item`, `quiz_draw_rule`       | Settings per F18 (time limit 60 s–10 h, attempts, pass mark, window, feedback policy). A fixed, ordered list or draw rules (tags, difficulty, types). `lesson.quiz_id` now has its key.   |
| `attempt`, `attempt_item`, `attempt_answer` | Assessed (numbered, per quiz) or practice. Each item freezes its question as a snapshot (BR-19). Partial unique index: one assessed attempt in progress per learner and quiz (BR-16).     |
| `tenant_feature`                            | The school's switch and the platform's override per feature (F40). Read-only for the runtime role until the settings screens (M9).                                                        |

## 2. Rules

| Rule                            | Behaviour                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoring (BR-21, AC 1)           | Pure functions with a table-driven test suite: single choice, true/false and numeric all-or-nothing; multiple choice all-or-nothing or partial credit `points × max(0, (right − wrong) / correct)` to 2 dp; short answers normalised.                                                                                                               |
| No answer leakage (BR-20, AC 2) | Learners receive a public projection of each question (no correctness, accepted answers, values, tolerances or explanations) until the result, and then only what the feedback policy allows. Checked in unit, integration and browser tests.                                                                                                       |
| Time (BR-18)                    | `deadlineAt = min(start + limit, closesAt)`. Answers are accepted until 30 s after it; later ones get `409 ATTEMPT_CLOSED` (F19 AC 4). The browser's countdown uses the server's clock.                                                                                                                                                             |
| Auto-submit (F19 AC 3, AC 4)    | Starting a timed attempt writes an outbox row, in the same transaction, due 31 s after the deadline. The outbox sweep (every 2 s) sends it as a job whose envelope carries the attempt's school; the worker runs it in that school's context, so a job naming another school's attempt finds nothing. Any visit after the deadline also submits it. |
| Races (AC 3)                    | Two Starts → one attempt (partial unique index; the loser returns it). Submit and auto-submit lock the attempt row and grade once. Saves take a shared lock and carry a client sequence number, so retries and late duplicates are harmless.                                                                                                        |
| Grading (F20)                   | Auto-gradable answers at submit; long answers go to the tutor's queue (`NEEDS_REVIEW`). The last mark recomputes the total from per-answer points and grades the attempt.                                                                                                                                                                           |
| Completion (BR-22)              | A quiz lesson completes when its quiz is passed (or graded, without a pass mark); course progress and completion update in the same transaction.                                                                                                                                                                                                    |
| Features (F40, AC 6)            | Practice and quiz analytics answer `403 FEATURE_NOT_ENABLED` while switched off; their data stays and comes back when switched on. The school bootstrap reports effective features, so navigation hides what is off.                                                                                                                                |

## 3. Screens

- **Studio:** Questions (bank with URL filters, editor per type, archive, duplicate), Quizzes (list, builder with settings, fixed list or draw rules, checklist, "Make available"), Results (attempts, grading queue one answer at a time, analytics with distribution and per-question rates), attempt view. Quiz lessons choose a quiz in the lesson editor.
- **Learner:** quiz intro (S-L04), Focus mode runner (S-L05: navigator, flags, review & submit, timer line, offline queue with "n not synced", time's-up submit), result and review (S-L06), practice setup, session with "Check" and summary with weak topics (S-L07), open quizzes and recent results on My learning (F16), "Practise" in the player.

## 4. PROPOSED decisions

1. **Auto-submit through the outbox** (one delayed row per timed attempt) instead of a cross-school safety sweep, plus submit-on-visit. No new definer function is needed.
2. **Until plans exist (M9) every feature counts as granted by the plan;** a school's own switch defaults to on. Switching features is done in the console/settings later (M9); tests and seed write `tenant_feature` directly.
3. **A blank long answer scores 0 without marking.**
4. **"Results after closing" needs a closing time** (quiz checklist); with **"Never"** learners see neither score nor review.
5. **"Review my mistakes"** draws from questions answered wrong in the last 30 days, in quizzes or practice.
6. **Practice:** the first "Check" of each question counts; idle practice sessions simply stay open (no 24 h abandon job yet).
7. **Answer options are plain text;** stems and explanations are rich text (maths notation later).
8. **Saving answers is limited to 5 per second per attempt** (05 §4.7); the runner sends them one at a time and waits when told to.
9. **Owners and administrators can't take assessed attempts.** Studio's "Preview" of a quiz in Focus mode, CSV import of questions, CSV export of analytics, average time per question and the "marked" notification to learners come later (notifications with F33).
10. **No GIN index on question tags:** every index must start with `tenant_id` (T-ISO-03), and tag filters run inside one course's bank.

## 5. Tests

| AC                                                   | Test                                                                                                                                                                            | Result |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1 Scoring table suite                                | `scoring.test.ts` (33 rows: every type, partial credit, rounding, tolerance edges, normalisation) and totals                                                                    | Pass   |
| 2 No answer leakage                                  | `scoring.test.ts` (public projection), `assessment.int.test.ts` (start, resume, intro, NEVER/AFTER_CLOSE), `assessment.spec.ts` (page and every API response before submitting) | Pass   |
| 3 Concurrency races                                  | `assessment.int.test.ts`: two simultaneous starts, two simultaneous submits, stale and repeated saves, save after submit                                                        | Pass   |
| 4 Auto-submit in the right school                    | `assessment.int.test.ts`: outbox row with the attempt's school and due time, dispatch, a forged job in another school does nothing, the real job submits once                   | Pass   |
| 5 Offline e2e                                        | `assessment.spec.ts`: answer offline ("2 answers not synced"), reconnect, all saved, submit, result                                                                             | Pass   |
| 6 Disabled feature: `FEATURE_NOT_ENABLED`, data kept | `assessment.int.test.ts`: practice and analytics refused, bootstrap reports it, rows kept, switching back on restores                                                           | Pass   |

Also covered: F17 AC 1–3, F18 AC 1–2, F19 AC 1/4/5, F20 AC 1–2, F21 AC, F22 AC 1–3, F23 (numbers match the suite's attempts), BR-22 quiz-lesson completion, T-ISO fixtures for the nine new tables, matrix rows and T-ISO-12 route coverage for 29 new routes, axe checks on the runner, result, practice and quiz builder.
