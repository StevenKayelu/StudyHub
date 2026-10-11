// Generates apps/api/openapi.json (OpenAPI 3.1) from the Zod contracts.
// Run with `pnpm openapi` (builds the package first; Node runs this file with type stripping).
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import SwaggerParser from '@apidevtools/swagger-parser';
import { z } from 'zod';

import {
  healthzResponseSchema,
  PROBLEM_CONTENT_TYPE,
  problemSchema,
  readinessChecksSchema,
  readyzResponseSchema,
  tenantBootstrapSchema,
} from '../dist/index.js';

type JsonObject = Record<string, unknown>;

function toSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as JsonObject;
  delete json.$schema;
  return json;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const document = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'StudyHub API',
    version: '0.1.0',
    description:
      'Operational probes (root) and tenant-scoped endpoints (/api/v1). The school is resolved only from the request host. Every error response is RFC 9457 problem+json.',
  },
  tags: [
    { name: 'operations', description: 'Liveness and readiness probes' },
    { name: 'tenancy', description: 'School context resolved from the request host' },
  ],
  paths: {
    '/healthz': {
      get: {
        operationId: 'getHealthz',
        tags: ['operations'],
        summary: 'Liveness: the API process is running',
        responses: {
          '200': {
            description: 'The process is alive.',
            content: { 'application/json': { schema: ref('Healthz') } },
          },
        },
      },
    },
    '/readyz': {
      get: {
        operationId: 'getReadyz',
        tags: ['operations'],
        summary: 'Readiness: required dependencies (database) are reachable',
        responses: {
          '200': {
            description: 'Ready to serve traffic.',
            content: { 'application/json': { schema: ref('Readyz') } },
          },
          '503': {
            description: 'A dependency is unavailable. The problem carries a `checks` extension member.',
            content: { [PROBLEM_CONTENT_TYPE]: { schema: ref('Problem') } },
          },
        },
      },
    },
    '/api/v1/tenant': {
      get: {
        operationId: 'getTenantBootstrap',
        tags: ['tenancy'],
        summary: 'The school resolved from the request host (never from a client-supplied id)',
        responses: {
          '200': {
            description: 'The current school.',
            content: { 'application/json': { schema: ref('TenantBootstrap') } },
          },
          '404': {
            description:
              'Unknown, unverified or deleted host. Generic: never names a school (TENANT_NOT_FOUND).',
            content: { [PROBLEM_CONTENT_TYPE]: { schema: ref('Problem') } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Healthz: toSchema(healthzResponseSchema),
      Readyz: toSchema(readyzResponseSchema),
      ReadinessChecks: toSchema(readinessChecksSchema),
      Problem: toSchema(problemSchema),
      TenantBootstrap: toSchema(tenantBootstrapSchema),
    },
  },
};

// Structural self-check: every $ref must resolve and the probes must be documented.
const serialized = JSON.stringify(document, null, 2);
const schemaNames = new Set(Object.keys(document.components.schemas));
for (const match of serialized.matchAll(/"#\/components\/schemas\/([^"]+)"/g)) {
  const name = match[1];
  if (name === undefined || !schemaNames.has(name)) {
    throw new Error(`OpenAPI self-check failed: unresolved $ref ${String(name)}`);
  }
}
for (const required of ['/healthz', '/readyz', '/api/v1/tenant']) {
  if (!(required in document.paths)) {
    throw new Error(`OpenAPI self-check failed: missing path ${required}`);
  }
}

// Independent validation against the OpenAPI 3.1 specification (throws with details if invalid).
// A deep copy is passed because the validator dereferences in place.
await SwaggerParser.validate(JSON.parse(serialized) as Parameters<typeof SwaggerParser.validate>[0]);

const outputPath = path.resolve(process.cwd(), '..', '..', 'apps', 'api', 'openapi.json');
writeFileSync(outputPath, `${serialized}\n`, 'utf8');
console.log(`OpenAPI 3.1 document validated and written to ${outputPath}`);
