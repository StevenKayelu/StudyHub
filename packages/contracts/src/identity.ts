import { z } from 'zod';

/**
 * Identity API contracts (M4; blueprint 05 §3, §8.3). Shared by the API (validation) and the web app.
 * Field rules mirror the server: emails are trimmed and lower-cased; passwords are 10–128 characters
 * (the server also rejects common and breached ones).
 */
export const tenantRoleSchema = z.enum(['LEARNER', 'INSTRUCTOR', 'TENANT_ADMIN', 'TENANT_OWNER']);
export type TenantRoleName = z.infer<typeof tenantRoleSchema>;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter an email address like name@example.com' }));

/** Length only here (counted in code points); policy checks happen on the server. */
export const newPasswordSchema = z
  .string()
  .refine((value) => Array.from(value).length >= 10, { message: 'Use at least 10 characters' })
  .refine((value) => Array.from(value).length <= 128, { message: 'Use at most 128 characters' });

export const displayNameSchema = z.string().trim().min(1, 'Enter your name').max(120);

/** Opaque 256-bit tokens from links and cookies (base64url). */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This link is invalid');

export const registerRequestSchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema,
  password: newPasswordSchema,
  acceptTerms: z.literal(true, { message: 'Accept the terms to continue' }),
});

export const signInRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(1024),
});

/**
 * Sign-in result. JOIN_AVAILABLE: the credentials are valid but the person isn't a member of this
 * school yet and it accepts sign-ups (BR-66); `ticket` (sealed, 10 minutes) confirms the join.
 */
export const signInResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('SIGNED_IN') }),
  z.object({ status: z.literal('JOIN_AVAILABLE'), ticket: z.string().min(1), schoolName: z.string() }),
]);

export const joinRequestSchema = z.object({ ticket: z.string().min(1).max(2048) });

export const tokenRequestSchema = z.object({ token: tokenSchema });

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });

export const resetPasswordRequestSchema = z.object({ token: tokenSchema, password: newPasswordSchema });

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(1024),
  newPassword: newPasswordSchema,
});

export const verifyEmailResponseSchema = z.object({ status: z.literal('VERIFIED'), signedIn: z.boolean() });

/** 202 for register, forgot and resend: always the same, whatever the email (BR-66, BR-65). */
export const acceptedResponseSchema = z.object({ status: z.literal('ACCEPTED') });

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string(),
    emailVerified: z.boolean(),
    locale: z.string(),
  }),
  membership: z.object({ id: z.uuid(), roles: z.array(tenantRoleSchema) }),
  allowedActions: z.array(z.string()),
});

export const sessionListSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.uuid(),
      current: z.boolean(),
      createdAt: z.iso.datetime(),
      lastSeenAt: z.iso.datetime(),
      userAgent: z.string().nullable(),
    }),
  ),
});

export const mySchoolsResponseSchema = z.object({
  schools: z.array(
    z.object({
      tenantId: z.uuid(),
      name: z.string(),
      host: z.string().nullable(),
      roles: z.array(tenantRoleSchema),
      current: z.boolean(),
    }),
  ),
});

/** The target URL carries the one-time token in its fragment (never sent to servers or logs). */
export const handoffResponseSchema = z.object({ url: z.url() });

export const inviteRequestSchema = z.object({ email: emailSchema, role: tenantRoleSchema });

export const teamResponseSchema = z.object({
  members: z.array(
    z.object({
      membershipId: z.uuid(),
      displayName: z.string(),
      email: z.string(),
      roles: z.array(tenantRoleSchema),
      status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']),
      joinedAt: z.iso.datetime().nullable(),
    }),
  ),
  invitations: z.array(
    z.object({
      id: z.uuid(),
      email: z.string(),
      role: tenantRoleSchema,
      expiresAt: z.iso.datetime(),
    }),
  ),
});

export const changeRolesRequestSchema = z.object({ roles: z.array(tenantRoleSchema).min(1).max(4) });

export const invitationPreviewSchema = z.object({
  schoolName: z.string(),
  email: z.string(),
  role: tenantRoleSchema,
  /** Shown to the holder of the invitation link only (who controls that inbox). */
  accountExists: z.boolean(),
});

export const acceptInvitationRequestSchema = z.object({
  token: tokenSchema,
  /** Existing account: its password. New account: the password to create. */
  password: z.string().min(1).max(1024).optional(),
  displayName: displayNameSchema.optional(),
});

// --- Console (platform realm) -------------------------------------------------------------------

export const consoleSignInResponseSchema = z.object({
  next: z.enum(['ENROL_TOTP', 'VERIFY_TOTP']),
});

export const totpCodeRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const totpSetupResponseSchema = z.object({ secret: z.string(), otpauthUri: z.string() });

export const totpEnabledResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });

export const platformRoleSchema = z.enum(['PLATFORM_OWNER', 'PLATFORM_OPERATOR', 'PLATFORM_SUPPORT']);

export const consoleMeResponseSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: platformRoleSchema,
  reauthValidUntil: z.iso.datetime().nullable(),
});

export const staffListResponseSchema = z.object({
  staff: z.array(
    z.object({
      id: z.uuid(),
      email: z.string(),
      displayName: z.string(),
      role: platformRoleSchema,
      status: z.enum(['ACTIVE', 'DISABLED']),
      totpEnabled: z.boolean(),
    }),
  ),
});

export type SignInResponse = z.infer<typeof signInResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type MySchoolsResponse = z.infer<typeof mySchoolsResponseSchema>;
export type TeamResponse = z.infer<typeof teamResponseSchema>;
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;
export type ConsoleMeResponse = z.infer<typeof consoleMeResponseSchema>;
export type StaffListResponse = z.infer<typeof staffListResponseSchema>;
