import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { type ProviderEvent, ProviderUnavailableError, type StartPaymentInput } from './payment-provider';

/** Client-selected provider, sandbox preparation only. Not registered in PaymentGateway until
 * merchant capability/callback certification is complete. No configurable/live API origin.
 * Sources and remaining approval evidence: docs/design/lipila-evaluation.md.
 */
const ORIGIN = 'https://api.lipila.dev';
const collectionSchema = z.object({
  referenceId: z.string().min(1),
  identifier: z.string().min(1),
  status: z.enum(['Pending', 'Successful', 'Failed']),
  currency: z.literal('ZMW'),
  amount: z.number().finite().nonnegative(),
});

export interface LipilaCollection {
  referenceId: string;
  identifier: string;
  status: 'Pending' | 'Successful' | 'Failed';
  amountMinor: number;
  currency: 'ZMW';
}

function collection(value: unknown, reference: string): LipilaCollection {
  const parsed = collectionSchema.safeParse(value);
  if (!parsed.success || parsed.data.referenceId !== reference) {
    throw new ProviderUnavailableError('Lipila returned an invalid collection response');
  }
  const { amount, ...data } = parsed.data;
  const amountMinor = Math.round(amount * 100);
  if (!Number.isSafeInteger(amountMinor) || Math.abs(amount * 100 - amountMinor) > 0.000001) {
    throw new ProviderUnavailableError('Lipila returned an invalid ZMW amount');
  }
  return { ...data, amountMinor };
}

export class LipilaSandboxClient {
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('A sandbox API key is required');
  }

  private async request(path: string, body?: unknown): Promise<Response> {
    try {
      const response = await this.transport(`${ORIGIN}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': this.apiKey },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok && response.status !== 404) throw new Error('provider refused request');
      return response;
    } catch {
      // Do not leak keys, payer details or raw provider errors. Never automatically retry a POST:
      // timeout acceptance and duplicate-reference behavior still require sandbox certification.
      throw new ProviderUnavailableError('Lipila sandbox request unavailable');
    }
  }

  async startMobileMoney(input: StartPaymentInput): Promise<LipilaCollection> {
    const number = input.msisdn?.replace(/^\+/, '');
    if (
      input.method !== 'MOBILE_MONEY' ||
      input.currency !== 'ZMW' ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      !/^260\d{9}$/.test(number ?? '') ||
      !input.reference
    ) {
      throw new Error('Invalid Lipila mobile-money collection input');
    }
    const response = await this.request('/api/v1/collections/mobile-money', {
      referenceId: input.reference,
      amount: input.amountMinor / 100,
      accountNumber: number,
      currency: 'ZMW',
      narration: input.description,
    });
    return this.decode(response, input.reference);
  }

  async getCollection(reference: string): Promise<LipilaCollection | null> {
    if (!reference) throw new Error('Collection reference is required');
    const response = await this.request(
      `/api/v1/collections/check-status?${new URLSearchParams({ referenceId: reference })}`,
    );
    if (response.status === 404) return null;
    return this.decode(response, reference);
  }

  private async decode(response: Response, reference: string): Promise<LipilaCollection> {
    try {
      return collection(await response.json(), reference);
    } catch {
      throw new ProviderUnavailableError('Lipila returned an invalid collection response');
    }
  }
}

/** Lipila Standard Webhooks scheme, with a bounded past/future window and raw-byte verification.
 * This only authenticates a notification; callers must query status and validate stored amount,
 * currency, reference and merchant binding before changing access or ledger state.
 */
export function verifyLipilaWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secretBase64: string,
  nowMs = Date.now(),
): ProviderEvent | null {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
    typeof timestamp !== 'string' ||
    !/^\d{1,12}$/.test(timestamp) ||
    typeof signatures !== 'string' ||
    signatures.length > 4096 ||
    !/^[A-Za-z0-9+/]{43}=$/.test(secretBase64)
  )
    return null;
  const key = Buffer.from(secretBase64, 'base64');
  if (
    key.length !== 32 ||
    key.toString('base64') !== secretBase64 ||
    Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > 300
  )
    return null;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();
  const verified = signatures.split(/\s+/).some((entry) => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(entry)) return false;
    const received = Buffer.from(entry.slice(3), 'base64');
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
  if (!verified) return null;
  try {
    const event = z
      .object({
        referenceId: z.string().min(1),
        type: z.literal('Collection'),
        status: z.enum(['Successful', 'Failed']),
      })
      .passthrough()
      .parse(JSON.parse(rawBody.toString('utf8')));
    return {
      eventId: id,
      type: `collection.${event.status.toLowerCase()}`,
      reference: event.referenceId,
      payload: event,
    };
  } catch {
    return null;
  }
}
