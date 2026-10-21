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
  FEATURE_NOT_ENABLED: { status: 403, title: 'This feature is not enabled', active: true },
  LIMIT_REACHED: { status: 409, title: 'Plan limit reached', active: true },
  SLUG_TAKEN: { status: 409, title: 'That address is already taken', active: true },
  SLUG_RESERVED: { status: 422, title: 'That address is reserved', active: true },
  // Learning (M6)
  ENROLMENT_INACTIVE: { status: 403, title: 'Your access to this course is not active', active: true },
  ALREADY_ENROLLED: { status: 409, title: 'Already enrolled', active: true },
  SCHOOL_READ_ONLY: { status: 403, title: 'This school is read-only for now', active: true },
  // Assessment (M7)
  ATTEMPT_CLOSED: { status: 409, title: 'This attempt is closed', active: true },
  ATTEMPT_LIMIT_REACHED: { status: 409, title: 'No attempts left', active: true },
  QUIZ_NOT_OPEN: { status: 409, title: 'This quiz is not open', active: true },
  // Commerce (M8)
  PAYMENT_PROVIDER_UNAVAILABLE: { status: 503, title: 'Payments are temporarily unavailable', active: true },
  PAYMENT_METHOD_NOT_SUPPORTED: { status: 422, title: 'Payment method not supported', active: true },
  EMAIL_NOT_VERIFIED: { status: 403, title: 'Verify your email address first', active: true },
  COURSE_NOT_PURCHASABLE: { status: 422, title: 'This course cannot be bought', active: true },
  ORDER_NOT_PAYABLE: { status: 409, title: 'This order can no longer be paid', active: true },
  // Deposit plans (docs/design/payment-plans.md): a lesson beyond what the deposit opened.
  BALANCE_REQUIRED: { status: 402, title: 'Pay the balance to open this lesson', active: true },
  // Course periods (docs/design/course-periods.md): the course's term hasn't opened yet.
  COURSE_NOT_OPEN: { status: 403, title: 'This course is not open yet', active: true },
  // Content protection (docs/design/content-protection.md): this lesson is stream and view only.
  DOWNLOAD_NOT_ALLOWED: { status: 403, title: 'This file can be viewed but not downloaded', active: true },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    title: 'This request key was already used for another request',
    active: true,
  },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, title: 'The same request is still being processed', active: true },
  // Tenant administration and console (M9)
  SUPPORT_READ_ONLY: { status: 403, title: 'This support session is read-only', active: true },
  SUPPORT_ACTION_EXCLUDED: { status: 403, title: 'Support sessions cannot do this', active: true },
  COLOUR_NOT_COMPLIANT: { status: 422, title: 'This colour does not have enough contrast', active: true },
  ONBOARDING_INCOMPLETE: { status: 422, title: 'Finish the required setup steps first', active: true },
  CONFIRMATION_MISMATCH: { status: 422, title: 'The confirmation does not match', active: true },
  TENANT_MOVED: { status: 421, title: 'This school has a new address', active: true },
} as const satisfies Record<string, { status: number; title: string; active: boolean }>;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export const ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as [ErrorCode, ...ErrorCode[]];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** RFC 9457 `type` URI for a code. A URN keeps it independent of the (undecided) platform domain. */
export function problemTypeFor(code: ErrorCode): string {
  return `urn:studyhub:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}
