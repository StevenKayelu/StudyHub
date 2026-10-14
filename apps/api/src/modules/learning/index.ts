// Public surface of the learning module (enforced by dependency-cruiser).
export { EnrollmentsService } from './application/enrollments.service';
export { courseProgress, nextLessonState, reachesThreshold } from './domain/progress-rules';
export { LearningModule } from './learning.module';
