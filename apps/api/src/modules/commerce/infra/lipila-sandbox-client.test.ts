import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { LipilaSandboxClient, verifyLipilaWebhook } from './lipila-sandbox-client';
import type { StartPaymentInput } from './payment-provider';

const input: StartPaymentInput = {
  reference: 'payment-123',
  amountMinor: 12345,
  currency: 'ZMW',
  method: 'MOBILE_MONEY',
  msisdn: '+260971234567',
  network: 'AIRTEL',
  returnUrl: 'https://school.test/return',
  description: 'Course order',
};
const response = {
  referenceId: input.reference,
  identifier: 'lipila-123',
  amount: 123.45,
  currency: 'ZMW',
  status: 'Pending',
};
const key = Buffer.alloc(32, 7).toString('base64');
const now = 1_800_000_000_000;
const body = Buffer.from(
  JSON.stringify({ referenceId: input.reference, type: 'Collection', status: 'Successful' }),
);
function signed(raw = body, timestamp = String(now / 1000)) {
  const id = 'event-123';
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature':
      'v1,' +
      createHmac('sha256', Buffer.from(key, 'base64'))
        .update(`${id}.${timestamp}.`)
        .update(raw)
        .digest('base64'),
  };
}

describe('Lipila sandbox preparation (no network or live keys)', () => {
  it('uses sandbox collections, per-account API credentials and exact major/minor conversion', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    const client = new LipilaSandboxClient('sandbox-fixture', transport);
    expect(await client.startMobileMoney(input)).toMatchObject({ amountMinor: 12345, status: 'Pending' });
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.lipila.dev/api/v1/collections/mobile-money');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ 'x-api-key': 'sandbox-fixture' });
    expect(JSON.parse(init?.body as string)).toEqual({
      referenceId: input.reference,
      amount: 123.45,
      accountNumber: '260971234567',
      currency: 'ZMW',
      narration: 'Course order',
    });
  });
  it('queries by reference and distinguishes not-found from unavailability', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('secret provider detail', { status: 401 }));
    const client = new LipilaSandboxClient('sandbox-fixture', transport);
    expect(await client.getCollection('a&b')).toBeNull();
    expect(transport.mock.calls[0]![0]).toContain('referenceId=a%26b');
    await expect(client.getCollection('a')).rejects.toThrow('unavailable');
  });
  it.each([
    { ...response, referenceId: 'other-payment' },
    { ...response, amount: 1.001 },
    { ...response, status: 'Unknown' },
    { ...response, currency: 'USD' },
  ])('rejects inconsistent status responses %j', async (invalid) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(invalid));
    await expect(
      new LipilaSandboxClient('sandbox-fixture', transport).getCollection(input.reference),
    ).rejects.toThrow('invalid');
  });
  it('does not retry uncertain collection creation or leak raw errors', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-key-and-payer'));
    await expect(
      new LipilaSandboxClient('sandbox-fixture', transport).startMobileMoney(input),
    ).rejects.toThrow('Lipila sandbox request unavailable');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not invent customer details for card collections', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      new LipilaSandboxClient('sandbox-fixture', transport).startMobileMoney({ ...input, method: 'CARD' }),
    ).rejects.toThrow('Invalid');
    expect(transport).not.toHaveBeenCalled();
  });
  it('authenticates raw bytes, stable event identity and key-rotation signatures', () => {
    const headers = signed();
    expect(verifyLipilaWebhook(body, headers, key, now)).toMatchObject({
      eventId: 'event-123',
      reference: input.reference,
    });
    expect(
      verifyLipilaWebhook(
        body,
        {
          ...headers,
          'webhook-signature': `v1,${Buffer.alloc(32).toString('base64')} ${headers['webhook-signature']}`,
        },
        key,
        now,
      ),
    ).not.toBeNull();
    expect(verifyLipilaWebhook(Buffer.concat([body, Buffer.from(' ')]), headers, key, now)).toBeNull();
    expect(verifyLipilaWebhook(body, headers, Buffer.alloc(32, 8).toString('base64'), now)).toBeNull();
  });
  it.each([-301, 301])('rejects signed events outside the time window (%i seconds)', (offset) => {
    expect(verifyLipilaWebhook(body, signed(body, String(now / 1000 + offset)), key, now)).toBeNull();
  });
  it('rejects missing/duplicate headers, malformed signatures, secrets and irrelevant event types', () => {
    expect(verifyLipilaWebhook(body, {}, key, now)).toBeNull();
    expect(verifyLipilaWebhook(body, { ...signed(), 'webhook-id': ['event-123'] }, key, now)).toBeNull();
    expect(verifyLipilaWebhook(body, { ...signed(), 'webhook-signature': 'v1,short' }, key, now)).toBeNull();
    expect(verifyLipilaWebhook(body, signed(), 'bad', now)).toBeNull();
    const irrelevant = Buffer.from(
      '{"referenceId":"payment-123","type":"Disbursement","status":"Successful"}',
    );
    expect(verifyLipilaWebhook(irrelevant, signed(irrelevant), key, now)).toBeNull();
  });
});
