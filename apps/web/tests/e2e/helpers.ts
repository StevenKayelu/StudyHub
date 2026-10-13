import { createHmac } from 'node:crypto';

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
