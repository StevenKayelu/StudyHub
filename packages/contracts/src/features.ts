import { z } from 'zod';

/** Feature modules a school can have (F40). Plans and the platform decide which are granted (BR-48). */
export const FEATURE_KEYS = [
  'paidCourses',
  'practiceMode',
  'quizAnalytics',
  'instructorApplications',
  'instructorRevenueShare',
  'publicCatalog',
  'whiteLabel',
  'customDomain',
  'dataExport',
  'certificates',
] as const;

export const featureKeySchema = z.enum(FEATURE_KEYS);
export type FeatureKey = z.infer<typeof featureKeySchema>;

/** The school's effective features, as the bootstrap reports them. */
export const featureMapSchema = z.record(featureKeySchema, z.boolean());
export type FeatureMap = Record<FeatureKey, boolean>;
