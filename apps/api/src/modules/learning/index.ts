// Public surface of the learning module (enforced by dependency-cruiser).
export { activeEnrollment, grantFor } from './application/access';
export { EnrollmentsService } from './application/enrollments.service';
export { recordQuizPassed } from './application/quiz-progress';
export { courseProgress, nextLessonState, reachesThreshold } from './domain/progress-rules';
export { LearningModule } from './learning.module';
