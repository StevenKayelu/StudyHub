import { z } from 'zod';

/** GET /healthz — liveness: the process is up. Never touches dependencies. */
export const healthzResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('studyhub-api'),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
});

export const dependencyStatusSchema = z.enum(['ok', 'unavailable']);

/** GET /readyz — readiness: dependencies needed to serve traffic are reachable. */
export const readyzResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string().min(1),
  checks: z.object({
    database: z.literal('ok'),
  }),
});

/** Extension member carried by the 503 problem when readiness fails. */
export const readinessChecksSchema = z.object({
  database: dependencyStatusSchema,
});

export type HealthzResponse = z.infer<typeof healthzResponseSchema>;
export type ReadyzResponse = z.infer<typeof readyzResponseSchema>;
export type ReadinessChecks = z.infer<typeof readinessChecksSchema>;
