import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238, SHA-1, 30-second steps, 6 digits): the parameters every authenticator app supports.
 * Mandatory for platform staff (04 §17.5).
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new 160-bit secret. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function timeStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

/** The code for a time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: Buffer, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, '0');
}

/**
 * Checks a code against the current step ±1 (clock drift). Returns the matched step, or null.
 * Steps at or before `lastUsedStep` are refused, so an observed code can't be replayed.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  options: { at?: Date; lastUsedStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = timeStep(options.at);
  for (const step of [current, current - 1, current + 1]) {
    if (options.lastUsedStep !== undefined && options.lastUsedStep !== null && step <= options.lastUsedStep)
      continue;
    if (totpCode(secret, step) === code) return step;
  }
  return null;
}

/** otpauth:// URI for authenticator apps (issuer and label are display-only). */
export function otpauthUri(secret: Buffer, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
