import { describe, expect, it } from 'vitest';

import {
  CommonPasswordChecker,
  decoyPasswordHash,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from './passwords';
import { SecretBox } from './secret-box';
import { hashToken, issueToken, isWellFormedToken } from './tokens';
import { base32Decode, base32Encode, otpauthUri, timeStep, totpCode, verifyTotp } from './totp';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('tokens', () => {
  it('issues 256-bit base64url tokens whose SHA-256 is the stored form', () => {
    const { token, hash } = issueToken();
    expect(isWellFormedToken(token)).toBe(true);
    expect(hash.length).toBe(32);
    expect(Buffer.from(hashToken(token)).equals(Buffer.from(hash))).toBe(true);
    expect(issueToken().token).not.toBe(token);
  });

  it('rejects malformed tokens before any lookup', () => {
    for (const value of ['', 'short', 'x'.repeat(44), `${'a'.repeat(42)}=`, 42, null]) {
      expect(isWellFormedToken(value)).toBe(false);
    }
  });
});

describe('passwords (ASVS V2.1, V2.4)', () => {
  it('hashes with Argon2id at the OWASP minimum and verifies', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(stored, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse batterY')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword(await decoyPasswordHash(), 'anything')).toBe(false);
  });

  it('applies length, email and common-password rules only (no composition rules)', async () => {
    const checker = new CommonPasswordChecker();
    expect(await passwordProblem('short', {}, checker)).toBe('TOO_SHORT');
    expect(await passwordProblem('x'.repeat(129), {}, checker)).toBe('TOO_LONG');
    expect(await passwordProblem('Password123', {}, checker)).toBe('COMMON_OR_BREACHED');
    expect(await passwordProblem('chanda-mulenga-2026', { email: 'chanda@example.com' }, checker)).toBe(
      'CONTAINS_EMAIL',
    );
    expect(await passwordProblem('all lower case words', {}, checker)).toBeNull();
    // Counted in code points: 10 emoji are 10 characters.
    expect(await passwordProblem('🔑'.repeat(10), {}, checker)).toBeNull();
  });
});

describe('secret box (AES-256-GCM)', () => {
  it('round-trips and binds the context', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('totp secret', 'totp:user-1');
    expect(box.open(sealed, 'totp:user-1').toString()).toBe('totp secret');
    expect(() => box.open(sealed, 'totp:user-2')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.open(tampered, 'totp:user-1')).toThrow();
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1 secret "12345678901234567890" (8-digit values, last 6 digits here).
  const secret = Buffer.from('12345678901234567890');
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC test vector at T=%i', (seconds, code) => {
    expect(totpCode(secret, Math.floor(seconds / 30))).toBe(code);
  });

  it('accepts the current step ±1 and refuses replays', () => {
    const at = new Date(1_234_567_890_000);
    const step = timeStep(at);
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code, { at })).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), { at })).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), { at })).toBeNull();
    expect(verifyTotp(secret, code, { at, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { at })).toBeNull();
  });

  it('encodes secrets as base32 for authenticator apps', () => {
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString()).toBe('12345678901234567890');
    expect(otpauthUri(secret, 'StudyHub', 'staff@example.com')).toMatch(
      /^otpauth:\/\/totp\/StudyHub%3Astaff%40example\.com\?secret=GEZDGNBV.*&issuer=StudyHub/,
    );
  });
});
