// Public surface of the learning module (enforced by dependency-cruiser).
export { activeEnrollment, grantFor, requireFullAccess, requireQuizOpen } from './application/access';
export { EnrollmentsService } from './application/enrollments.service';
export { recordQuizPassed } from './application/quiz-progress';
export { openLessonCount } from './domain/deposit-access';
export { courseProgress, nextLessonState, reachesThreshold } from './domain/progress-rules';
export { LearningModule } from './learning.module';
