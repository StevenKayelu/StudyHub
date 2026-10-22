import { hashPassword, timeStep, totpCode } from '../../src/modules/platform';
import { cookieFrom, type Harness, PASSWORD } from './school-harness';

export const CONSOLE = 'console.localhost';
const CONSOLE_COOKIE = '__Host-sh_console';

/** Runs SQL in the platform realm as the migrator (fixtures and direct database checks). */
export async function platformSql(h: Harness, text: string, params: unknown[] = []) {
  await h.migrator.query('BEGIN');
  try {
    await h.migrator.query(`SELECT set_config('app.realm', 'platform', true)`);
    const result = await h.migrator.query(text, params);
    await h.migrator.query('COMMIT');
    return result;
  } catch (error) {
    await h.migrator.query('ROLLBACK');
    throw error;
  }
}

/** Creates a staff member with a role, signs in and enrols TOTP; returns the console session cookie. */
export async function consoleSession(h: Harness, email: string, role: string): Promise<string> {
  const { rows } = await platformSql(
    h,
    `INSERT INTO platform_user (email, display_name, role) VALUES ($1, $2, $3::"PlatformRole") RETURNING id`,
    [email, `Staff ${role}`, role],
  );
  await platformSql(h, `INSERT INTO platform_credential (user_id, password_hash) VALUES ($1, $2)`, [
    rows[0].id,
    await hashPassword(PASSWORD),
  ]);
  const signedIn = await h.call('POST', '/console/auth/sign-in', {
    host: CONSOLE,
    body: { email, password: PASSWORD },
  });
  const cookie = cookieFrom(signedIn.headers['set-cookie'], CONSOLE_COOKIE)!;
  const setup = await h.call('POST', '/console/auth/totp/setup', { host: CONSOLE, cookie });
  const secret = base32Decode((setup.json() as { secret: string }).secret);
  const enabled = await h.call('POST', '/console/auth/totp/enable', {
    host: CONSOLE,
    cookie,
    body: { code: totpCode(secret, timeStep()) },
  });
  if (enabled.statusCode >= 300) throw new Error(`TOTP enrolment failed: ${enabled.body}`);
  return cookie;
}

/** Sensitive console actions need a fresh re-authentication (04 §17.5); tests renew it directly. */
export const freshReauth = (h: Harness) => platformSql(h, `UPDATE platform_session SET reauth_at = now()`);

export function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
