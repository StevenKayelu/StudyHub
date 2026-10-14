/**
 * Progress and completion rules (F15, BR-22, BR-64 `videoCompletionThresholdPct`). Framework-free and
 * unit-tested; the learning service applies them inside the progress transaction.
 */
export type LessonProgressStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

export interface OutlineLesson {
  id: string;
  isRequired: boolean;
}

export interface CourseProgress {
  /** Lessons that count: the required ones, or every lesson when none is marked required. */
  required: number;
  completedRequired: number;
  percent: number;
  /** BR-22: every counted lesson is complete (required quizzes join in M7). */
  complete: boolean;
}

/** Progress % = completed required lessons ÷ required lessons, rounded down (100 only when complete). */
export function courseProgress(
  lessons: readonly OutlineLesson[],
  completed: ReadonlySet<string>,
): CourseProgress {
  const anyRequired = lessons.some((lesson) => lesson.isRequired);
  const counted = lessons.filter((lesson) => !anyRequired || lesson.isRequired);
  const completedRequired = counted.filter((lesson) => completed.has(lesson.id)).length;
  const required = counted.length;
  const complete = required > 0 && completedRequired === required;
  const percent = required === 0 ? 0 : Math.floor((completedRequired * 100) / required);
  return { required, completedRequired, percent, complete };
}

/** Whether a video position reaches the school's completion threshold of a known duration. */
export function reachesThreshold(
  positionSeconds: number,
  durationSeconds: number | null,
  thresholdPct: number,
): boolean {
  if (durationSeconds === null || durationSeconds <= 0) return false;
  return positionSeconds * 100 >= durationSeconds * thresholdPct;
}

export interface ProgressInput {
  lessonType: 'TEXT' | 'VIDEO' | 'FILE' | 'QUIZ';
  /** The video's duration when known (lesson or asset). */
  durationSeconds: number | null;
  thresholdPct: number;
  current: { status: LessonProgressStatus; positionSeconds: number } | null;
  requested: { status?: 'IN_PROGRESS' | 'COMPLETED' | undefined; positionSeconds?: number | undefined };
}

/**
 * The lesson's next state. COMPLETED never goes back. A video completes by reaching the threshold;
 * asking for COMPLETED is honoured only when its duration is unknown. Quiz lessons complete through
 * their attempts (M7), never here.
 */
export function nextLessonState(input: ProgressInput): {
  status: LessonProgressStatus;
  positionSeconds: number;
} {
  const position = input.requested.positionSeconds ?? input.current?.positionSeconds ?? 0;
  if (input.current?.status === 'COMPLETED') return { status: 'COMPLETED', positionSeconds: position };
  let completed = false;
  if (input.lessonType === 'VIDEO') {
    completed =
      reachesThreshold(position, input.durationSeconds, input.thresholdPct) ||
      (input.requested.status === 'COMPLETED' &&
        (input.durationSeconds === null || input.durationSeconds <= 0));
  } else if (input.lessonType !== 'QUIZ') {
    completed = input.requested.status === 'COMPLETED';
  }
  return { status: completed ? 'COMPLETED' : 'IN_PROGRESS', positionSeconds: position };
}
