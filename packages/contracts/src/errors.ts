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

  // Active from M2 (tenancy kernel). TENANT_NOT_FOUND is deliberately generic: it never names a school.
  TENANT_NOT_FOUND: { status: 404, title: 'Site not found', active: true },
  TENANT_CONTEXT_MISSING: { status: 500, title: 'Something went wrong on our side', active: true },

  // Reserved for later milestones
  UNAUTHENTICATED: { status: 401, title: 'Sign-in required', active: true },
  FORBIDDEN: { status: 403, title: 'Not allowed', active: true },
  // Identity (M4). Sign-in failures are always this one generic code (BR-65).
  INVALID_CREDENTIALS: { status: 401, title: 'Email or password is incorrect', active: true },
  TOKEN_INVALID: { status: 400, title: 'This link is invalid or has expired', active: true },
  ORIGIN_REJECTED: { status: 403, title: 'Request origin not allowed', active: true },
  REGISTRATION_CLOSED: { status: 403, title: 'This school does not accept new sign-ups', active: true },
  LAST_OWNER: { status: 409, title: 'A school must keep at least one owner', active: true },
  MFA_REQUIRED: { status: 401, title: 'Two-step verification required', active: true },
  REAUTH_REQUIRED: { status: 403, title: 'Confirm it is you to continue', active: true },
  // Content and media (M5)
  UPLOAD_TYPE_NOT_ALLOWED: { status: 422, title: 'This type of file is not allowed here', active: true },
  UPLOAD_TOO_LARGE: { status: 422, title: 'This file is too large', active: true },
  INVALID_STATE: { status: 409, title: 'This action is not possible in the current state', active: true },
  CHECKLIST_INCOMPLETE: { status: 422, title: 'The course is not ready to publish yet', active: true },
  VERSION_CONFLICT: { status: 409, title: 'This item was changed elsewhere', active: true },
  FEATURE_NOT_ENABLED: { status: 403, title: 'This feature is not enabled', active: false },
  LIMIT_REACHED: { status: 409, title: 'Plan limit reached', active: true },
  SLUG_TAKEN: { status: 409, title: 'That address is already taken', active: true },
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
