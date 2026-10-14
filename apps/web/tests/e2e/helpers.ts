import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { expect, type Page } from '@playwright/test';

/** Demo accounts from `pnpm db:seed` (development only). */
export const DEMO_PASSWORD = 'studyhub-demo-pass';
export const DEMO = {
  acmeOwner: 'owner@acme.test',
  acmeTutor: 'tutor@acme.test',
  betaOwner: 'owner@beta.test',
  learner: 'learner@example.test',
  staff: 'staff@studyhub.test',
} as const;

export const school = (host: string, path = '/') => `http://${host}:3000${path}`;

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

/** A unique address per test run, so reruns never read an older email. */
export const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** Waits for an email to `to` (sent by the worker through Mailpit) and returns the first link in it. */
export async function linkFromEmail(to: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        const { messages } = (await search.json()) as { messages: { ID: string }[] };
        const id = messages[0]?.ID;
        if (id === undefined) return false;
        const message = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string };
        link = /(https?:\/\/\S+)/.exec(message.Text)?.[1];
        return link !== undefined;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBe(true);
  return link!;
}

/** RFC 6238 code for a base32 secret (what an authenticator app would show). */
export function totp(secretBase32: string, offsetSteps = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secretBase32.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Signs in on a school host through the real form and waits for the landing page. */
export async function signIn(page: Page, host: string, email: string, returnTo = '/learn'): Promise<void> {
  await page.context().clearCookies(); // the sign-in page redirects anyone already signed in
  await page.goto(school(host, `/sign-in?returnTo=${encodeURIComponent(returnTo)}`));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(school(host, returnTo));
}

/** A valid PNG of the given size (solid colour), for upload tests; no image library needed. */
export function pngBuffer(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9a)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
