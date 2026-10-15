// Public surface of the assessment module (enforced by dependency-cruiser).
export { AssessmentModule } from './assessment.module';
export { AUTO_SUBMIT_JOB, createAutoSubmitHandler, finalizeAttempt } from './application/grading-core';
export { attemptTotals, normaliseText, scoreAnswer } from './domain/scoring';
