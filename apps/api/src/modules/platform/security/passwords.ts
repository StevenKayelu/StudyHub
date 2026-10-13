import { createHash } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';

/**
 * Passwords (blueprint 04 §8, ASVS V2.1, V2.4): Argon2id with the OWASP minimum (m = 19 MiB, t = 2,
 * p = 1; to be tuned to ~250 ms on production hardware); length 10–128; no composition rules;
 * rejected if common, if it contains the email's local part, or if known breached.
 */
const ARGON2 = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * A hash of a random password, verified when an account doesn't exist, so a sign-in for an unknown
 * email takes as long as one for a known email (no timing oracle, BR-65).
 */
let decoyHash: Promise<string> | null = null;
export function decoyPasswordHash(): Promise<string> {
  decoyHash ??= hashPassword(`decoy-${Date.now()}-${Math.random()}`);
  return decoyHash;
}

/** Checks a password against a breach corpus. Implementations must never send the password itself. */
export interface BreachedPasswordChecker {
  isBreached(password: string): Promise<boolean>;
}

/**
 * Offline check against the most common passwords (always on). A k-anonymity check against a breach
 * service can be added behind this interface once the client approves the outbound call.
 */
const COMMON = new Set([
  '1234567890',
  '12345678910',
  '0123456789',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'qwertyuiop',
  'asdfghjkl;',
  'iloveyou12',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'welcome123',
  'qwerty12345',
  'qwerty123456',
  'abc1234567',
  'abcdefghij',
  'football123',
  'princess123',
  'sunshine123',
  'letmein123',
  'monkey12345',
  'dragon12345',
  'admin12345',
  'administrator',
  'changeme123',
  'studyhub123',
  'zambia1234',
  'lusaka1234',
  '11111111111',
  '00000000000',
  '1111111111',
  '0000000000',
  '9876543210',
  'aaaaaaaaaa',
]);

export class CommonPasswordChecker implements BreachedPasswordChecker {
  isBreached(password: string): Promise<boolean> {
    return Promise.resolve(COMMON.has(password.toLowerCase()));
  }
}

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'CONTAINS_EMAIL' | 'COMMON_OR_BREACHED';

export async function passwordProblem(
  password: string,
  context: { email?: string },
  checker: BreachedPasswordChecker,
): Promise<PasswordProblem | null> {
  // Count code points, not UTF-16 units (ASVS 2.1.1: spaces and Unicode allowed).
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (length > PASSWORD_MAX_LENGTH) return 'TOO_LONG';
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local !== undefined && local.length >= 4 && password.toLowerCase().includes(local))
    return 'CONTAINS_EMAIL';
  if (await checker.isBreached(password)) return 'COMMON_OR_BREACHED';
  return null;
}

/** Recovery codes are random, single use, and stored as SHA-256 like other tokens. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
}
