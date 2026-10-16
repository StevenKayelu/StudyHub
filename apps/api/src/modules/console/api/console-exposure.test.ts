import {
  consoleAuditPageSchema,
  consoleDomainRequestListSchema,
  consoleMetricsSchema,
  consoleOverviewSchema,
  consolePlanListSchema,
  consoleSettingsSchema,
  consoleStatementListSchema,
  consoleSupportGrantListSchema,
  consoleTenantDetailSchema,
  consoleTenantListSchema,
  createTenantResponseSchema,
  generateStatementsResponseSchema,
  paymentProviderListSchema,
  providerHealthSchema,
  slugAvailabilitySchema,
  supportOpenResponseSchema,
} from '@studyhub/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * F43 AC 1 (04 §17.13 item 5): no console response schema carries school personal data. Every field
 * name in every console response is walked; names that mean personal data fail the test unless they are
 * on the documented allowlist. (`/console/me` and `/console/staff` describe platform staff, not schools.)
 */
const CONSOLE_RESPONSES: Record<string, z.ZodType> = {
  'GET /console/overview': consoleOverviewSchema,
  'GET /console/metrics': consoleMetricsSchema,
  'GET /console/providers/health': providerHealthSchema,
  'GET /console/payment-providers': paymentProviderListSchema,
  'GET /console/tenants': consoleTenantListSchema,
  'GET /console/tenants/slug-availability': slugAvailabilitySchema,
  'POST /console/tenants': createTenantResponseSchema,
  'GET /console/tenants/:id': consoleTenantDetailSchema,
  'GET /console/plans': consolePlanListSchema,
  'GET /console/settings': consoleSettingsSchema,
  'GET /console/audit-log': consoleAuditPageSchema,
  'GET /console/domain-change-requests': consoleDomainRequestListSchema,
  'GET /console/statements': consoleStatementListSchema,
  'POST /console/statements/generate': generateStatementsResponseSchema,
  'GET /console/support-access': consoleSupportGrantListSchema,
  'POST /console/support-access/:id/open': supportOpenResponseSchema,
};

const PERSONAL =
  /(email|phone|msisdn|displayname|firstname|lastname|fullname|address|birth|answer|learner|buyer|student)/i;

/** Field paths allowed despite matching: what staff typed at provisioning, and staff's own names. */
const ALLOWED = new Set([
  'GET /console/tenants/:id tenant.ownerContactEmail',
  'POST /console/tenants ownerInvitation.email',
  'GET /console/tenants/:id supportGrants[].staffName',
  'GET /console/support-access grants[].staffName',
  'GET /console/audit-log entries[].actorName',
  // Aggregates (counts), not people.
  'GET /console/tenants tenants[].activeLearners',
  'GET /console/tenants/:id usage[].activeLearners',
  'GET /console/metrics activeLearners',
  'GET /console/metrics emailsLast30Days',
  'GET /console/tenants/:id usage[].emailsSent',
  'GET /console/plans plans[].limits.maxActiveLearners',
]);

function fieldPaths(schema: z.ZodType, prefix = ''): string[] {
  const def = (schema as unknown as { def: { type: string } }).def;
  switch (def.type) {
    case 'object': {
      const shape = (schema as z.ZodObject).shape as Record<string, z.ZodType>;
      return Object.entries(shape).flatMap(([key, value]) => {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        return [path, ...fieldPaths(value, path)];
      });
    }
    case 'array':
      return fieldPaths((schema as z.ZodArray<z.ZodType>).element, `${prefix}[]`);
    case 'optional':
    case 'nullable':
    case 'default':
      return fieldPaths((schema as unknown as { unwrap(): z.ZodType }).unwrap(), prefix);
    case 'record':
      return fieldPaths((def as unknown as { valueType: z.ZodType }).valueType, `${prefix}{}`);
    case 'pipe':
      return fieldPaths((def as unknown as { out: z.ZodType }).out, prefix);
    default:
      return [];
  }
}

describe('console responses expose no school personal data (F43 AC 1)', () => {
  it('walks every field of every console response', () => {
    const offending: string[] = [];
    for (const [route, schema] of Object.entries(CONSOLE_RESPONSES)) {
      const paths = fieldPaths(schema);
      expect(paths.length, route).toBeGreaterThan(0);
      for (const path of paths) {
        const last = path
          .split('.')
          .pop()!
          .replace(/\[\]|\{\}/g, '');
        if (PERSONAL.test(last) && !ALLOWED.has(`${route} ${path}`)) offending.push(`${route} ${path}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it('the check is not vacuous: a personal field is caught', () => {
    const leaky = z.object({ members: z.array(z.object({ email: z.string(), displayName: z.string() })) });
    const paths = fieldPaths(leaky).filter((path) => PERSONAL.test(path.split('.').pop()!));
    expect(paths).toEqual(['members[].email', 'members[].displayName']);
  });
});
