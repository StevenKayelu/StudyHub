import { z } from 'zod';

/**
 * Stable, machine-readable error codes (blueprint 04 §9, 09 §8).
 * Codes are part of the public API contract: never rename or reuse one.
 * `active` codes are emitted by the API today; `reserved` codes are claimed for later milestones.
 */
export const ERROR_DEFINITIONS = {
  // Active in M1
  VALIDATION_FAILED: { status: 422, title: 'Some fields need attention', active: true },
  NOT_FOUND: { status: 404, title: 'Not found', active: true },
  INTERNAL: { status: 500, title: 'Something went wrong on our side', active: true },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service temporarily unavailable', active: true },
  RATE_LIMITED: { status: 429, title: 'Too many requests', active: true },

  // Reserved for later milestones
  UNAUTHENTICATED: { status: 401, title: 'Sign-in required', active: false },
  FORBIDDEN: { status: 403, title: 'Not allowed', active: false },
  VERSION_CONFLICT: { status: 409, title: 'This item was changed elsewhere', active: false },
  FEATURE_NOT_ENABLED: { status: 403, title: 'This feature is not enabled', active: false },
  LIMIT_REACHED: { status: 409, title: 'Plan limit reached', active: false },
  TENANT_NOT_FOUND: { status: 404, title: 'Site not found', active: false },
  TENANT_CONTEXT_MISSING: { status: 500, title: 'Something went wrong on our side', active: false },
  SLUG_TAKEN: { status: 409, title: 'That address is already taken', active: false },
  SLUG_RESERVED: { status: 422, title: 'That address is reserved', active: false },
  ENROLMENT_INACTIVE: { status: 403, title: 'Your access to this course is not active', active: false },
  ALREADY_ENROLLED: { status: 409, title: 'You are already enrolled', active: false },
  ATTEMPT_CLOSED: { status: 409, title: 'This attempt is closed', active: false },
  ATTEMPT_LIMIT_REACHED: { status: 409, title: 'No attempts left', active: false },
  PAYMENT_PROVIDER_UNAVAILABLE: { status: 503, title: 'Payments are temporarily unavailable', active: false },
  PAYMENT_METHOD_NOT_SUPPORTED: { status: 422, title: 'Payment method not supported', active: false },
} as const satisfies Record<string, { status: number; title: string; active: boolean }>;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export const ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as [ErrorCode, ...ErrorCode[]];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** RFC 9457 `type` URI for a code. A URN keeps it independent of the (undecided) platform domain. */
export function problemTypeFor(code: ErrorCode): string {
  return `urn:studyhub:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}
