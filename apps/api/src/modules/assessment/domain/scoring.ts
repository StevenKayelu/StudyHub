/**
 * Scoring (F20, BR-21) and the question snapshot an attempt is graded against (BR-19). Framework-free
 * and covered by a table-driven test suite (07 M7 AC 1).
 */
export type QuestionType =
  'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'NUMERIC' | 'LONG_ANSWER';

export interface SnapshotOption {
  id: string;
  content: unknown;
  isCorrect: boolean;
  feedback: unknown;
}

export interface QuestionSettings {
  /** MULTIPLE_CHOICE: partial credit per BR-21. */
  partialCredit?: boolean;
  /** SHORT_ANSWER */
  acceptedAnswers?: string[];
  caseSensitive?: boolean;
  /** NUMERIC: correct value ± absolute tolerance; `unit` is a hint shown to learners. */
  value?: number;
  tolerance?: number;
  unit?: string;
}

/** Everything needed to show and grade a question, frozen when the attempt starts (BR-19). */
export interface QuestionSnapshot {
  type: QuestionType;
  stem: unknown;
  options: SnapshotOption[];
  settings: QuestionSettings;
  explanation: unknown;
  tags: string[];
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
}

export type AnswerResponse = { optionIds: string[] } | { text: string } | { number: number };

export interface Score {
  /** null: waits for a person (LONG_ANSWER). */
  isCorrect: boolean | null;
  awarded: number;
  needsManual: boolean;
}

/** Rounded to the cent of a point (numeric(6,2)), half away from zero. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** BR-21 short answers: trimmed, whitespace collapsed, case-folded unless case-sensitive. */
export function normaliseText(text: string, caseSensitive = false): string {
  const collapsed = text.normalize('NFC').trim().replace(/\s+/g, ' ');
  return caseSensitive ? collapsed : collapsed.toLocaleLowerCase('en');
}

const none: Score = { isCorrect: false, awarded: 0, needsManual: false };

/** Scores one response against its snapshot (no response: 0 points, wrong). */
export function scoreAnswer(
  snapshot: QuestionSnapshot,
  points: number,
  response: AnswerResponse | null,
): Score {
  switch (snapshot.type) {
    case 'SINGLE_CHOICE':
    case 'TRUE_FALSE': {
      if (response === null || !('optionIds' in response) || response.optionIds.length !== 1) return none;
      const option = snapshot.options.find((o) => o.id === response.optionIds[0]);
      return option?.isCorrect === true ? { isCorrect: true, awarded: points, needsManual: false } : none;
    }
    case 'MULTIPLE_CHOICE': {
      if (response === null || !('optionIds' in response)) return none;
      const chosen = new Set(response.optionIds.filter((id) => snapshot.options.some((o) => o.id === id)));
      const correct = snapshot.options.filter((o) => o.isCorrect);
      const correctSelected = correct.filter((o) => chosen.has(o.id)).length;
      const wrongSelected = chosen.size - correctSelected;
      const exact = correctSelected === correct.length && wrongSelected === 0;
      if (exact) return { isCorrect: true, awarded: points, needsManual: false };
      if (snapshot.settings.partialCredit !== true || correct.length === 0) return none;
      const share = Math.max(0, (correctSelected - wrongSelected) / correct.length);
      return { isCorrect: false, awarded: round2(points * share), needsManual: false };
    }
    case 'SHORT_ANSWER': {
      if (response === null || !('text' in response)) return none;
      const caseSensitive = snapshot.settings.caseSensitive === true;
      const given = normaliseText(response.text, caseSensitive);
      if (given === '') return none;
      const match = (snapshot.settings.acceptedAnswers ?? []).some(
        (accepted) => normaliseText(accepted, caseSensitive) === given,
      );
      return match ? { isCorrect: true, awarded: points, needsManual: false } : none;
    }
    case 'NUMERIC': {
      if (response === null || !('number' in response) || !Number.isFinite(response.number)) return none;
      const { value, tolerance = 0 } = snapshot.settings;
      if (value === undefined) return none;
      // A tiny epsilon so 0.1 + 0.2 style float noise never fails an exact-tolerance answer.
      const ok = Math.abs(response.number - value) <= Math.abs(tolerance) + 1e-9;
      return ok ? { isCorrect: true, awarded: points, needsManual: false } : none;
    }
    case 'LONG_ANSWER': {
      // A blank long answer needs no marking: it scores 0 (PROPOSED).
      if (response === null || !('text' in response) || response.text.trim() === '') return none;
      return { isCorrect: null, awarded: 0, needsManual: true };
    }
  }
}

export interface AttemptTotals {
  score: number;
  maxScore: number;
  percent: number;
  passed: boolean | null;
}

/** F20 AC 1: the total is the sum of per-answer points; pass/fail only with a pass mark. */
export function attemptTotals(
  items: readonly { points: number; awarded: number }[],
  passMarkPercent: number | null,
): AttemptTotals {
  const score = round2(items.reduce((sum, item) => sum + item.awarded, 0));
  const maxScore = round2(items.reduce((sum, item) => sum + item.points, 0));
  const percent = maxScore === 0 ? 0 : round2((score / maxScore) * 100);
  return { score, maxScore, percent, passed: passMarkPercent === null ? null : percent >= passMarkPercent };
}

/** The response shape each type accepts; anything else is refused before saving. */
export function responseFits(snapshot: QuestionSnapshot, response: AnswerResponse): boolean {
  switch (snapshot.type) {
    case 'SINGLE_CHOICE':
    case 'TRUE_FALSE':
    case 'MULTIPLE_CHOICE': {
      if (!('optionIds' in response)) return false;
      const ids = new Set(snapshot.options.map((o) => o.id));
      const unique = new Set(response.optionIds);
      if (unique.size !== response.optionIds.length) return false;
      if (snapshot.type !== 'MULTIPLE_CHOICE' && response.optionIds.length > 1) return false;
      return response.optionIds.every((id) => ids.has(id));
    }
    case 'SHORT_ANSWER':
      return 'text' in response && response.text.length <= 500;
    case 'LONG_ANSWER':
      return 'text' in response && response.text.length <= 20_000;
    case 'NUMERIC':
      return 'number' in response && Number.isFinite(response.number);
  }
}

/** What a learner may see before submitting (BR-20): no correct answers, no explanations. */
export function publicQuestion(snapshot: QuestionSnapshot) {
  return {
    type: snapshot.type,
    stem: snapshot.stem,
    options: snapshot.options.map((o) => ({ id: o.id, content: o.content })),
    ...(snapshot.type === 'NUMERIC' &&
      snapshot.settings.unit !== undefined && { unit: snapshot.settings.unit }),
  };
}

/** The correct answer, for reviews and practice feedback that the policy allows. */
export function correctAnswer(snapshot: QuestionSnapshot) {
  switch (snapshot.type) {
    case 'SINGLE_CHOICE':
    case 'TRUE_FALSE':
    case 'MULTIPLE_CHOICE':
      return { optionIds: snapshot.options.filter((o) => o.isCorrect).map((o) => o.id) };
    case 'SHORT_ANSWER':
      return { acceptedAnswers: snapshot.settings.acceptedAnswers ?? [] };
    case 'NUMERIC':
      return { value: snapshot.settings.value ?? null, tolerance: snapshot.settings.tolerance ?? 0 };
    case 'LONG_ANSWER':
      return null;
  }
}
