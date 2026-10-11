import { z } from 'zod';

export const tenantStatusSchema = z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DELETED']);

/**
 * GET /api/v1/tenant — public bootstrap for the school resolved from the request host
 * (blueprint 05 §8.3). M2 returns identity and status only; branding, features and
 * terminology are added in later milestones.
 */
export const tenantBootstrapSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(3).max(30),
  name: z.string().min(2).max(120),
  status: tenantStatusSchema,
});

export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type TenantBootstrap = z.infer<typeof tenantBootstrapSchema>;
