import type { z } from 'zod';

import {
  configurationActivateRequestSchema,
  configurationDraftRequestSchema,
  configurationImportPreviewSchema,
  configurationImportRequestSchema,
  configurationViewSchema,
  PROBLEM_CONTENT_TYPE,
} from '../dist/index.js';

export const CONFIGURATION_SCHEMAS: Record<string, z.ZodType> = {
  ConfigurationView: configurationViewSchema,
  ConfigurationDraftRequest: configurationDraftRequestSchema,
  ConfigurationActivateRequest: configurationActivateRequestSchema,
  ConfigurationImportRequest: configurationImportRequestSchema,
  ConfigurationImportPreview: configurationImportPreviewSchema,
};

/** Both hosts use the same contracts; scope comes only from the authenticated realm. */
export function configurationPaths(ref: (name: string) => object): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const [base, prefix, security, description] of [
    [
      '/api/v1/admin/configuration',
      'school',
      'sessionCookie',
      'School owner/administrator; host resolves the school.',
    ],
    [
      '/console/configuration',
      'platform',
      'consoleCookie',
      'Platform owner with verified MFA; activation also requires recent TOTP reauthentication.',
    ],
  ]) {
    for (const [suffix, method, action, request, response] of [
      ['', 'get', 'get', null, 'ConfigurationView'],
      ['/draft', 'put', 'saveDraft', 'ConfigurationDraftRequest', 'ConfigurationView'],
      ['/activate', 'post', 'activate', 'ConfigurationActivateRequest', 'ConfigurationView'],
      [
        '/import-preview',
        'post',
        'previewImport',
        'ConfigurationImportRequest',
        'ConfigurationImportPreview',
      ],
    ] as const) {
      paths[`${base}${suffix}`] = {
        [method]: {
          operationId: `${prefix}Configuration_${action}`,
          tags: ['configuration'],
          summary: `${action}: managed content configuration`,
          description: `${description} Draft saving and import preview do not alter active settings. Imports accept only three nonsecret aliases; credentials and deployment keys are rejected.`,
          security: [{ [security!]: [] }],
          ...(request === null
            ? {}
            : { requestBody: { required: true, content: { 'application/json': { schema: ref(request) } } } }),
          responses: {
            '200': {
              description: 'Current configuration or validated preview.',
              content: { 'application/json': { schema: ref(response) } },
            },
            ...Object.fromEntries(
              [401, 403, 409, 422, 503].map((status) => [
                String(status),
                {
                  description:
                    'Authentication, permission, version conflict, validation or configuration availability error.',
                  content: { [PROBLEM_CONTENT_TYPE]: { schema: ref('Problem') } },
                },
              ]),
            ),
          },
        },
      };
    }
  }
  return paths;
}
