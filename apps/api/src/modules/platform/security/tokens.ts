import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque secrets handed to browsers or emailed (session cookies, verification and reset links,
 * invitations, hand-offs). 256 bits of randomness; only the SHA-256 is ever stored (blueprint 04 §8).
 */
export interface IssuedToken {
  /** The value given to the client (base64url, 43 characters). Never stored or logged. */
  token: string;
  /** SHA-256 of the token: the only form written to the database. */
  hash: Uint8Array<ArrayBuffer>;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function issueToken(): IssuedToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Uint8Array<ArrayBuffer> {
  return toBytes(createHash('sha256').update(token, 'utf8').digest());
}

/** A copy as a plain byte array (the type Prisma uses for BYTEA columns). */
export function toBytes(buffer: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(buffer.length));
  bytes.set(buffer);
  return bytes;
}

/** Rejects anything that can't be one of our tokens before it reaches the database. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
