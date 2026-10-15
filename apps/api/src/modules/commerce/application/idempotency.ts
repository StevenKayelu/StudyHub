import { createHash } from 'node:crypto';

import type { TenantActor } from '../../identity';
import { AppError, requireTenantId, type TenantDb } from '../../platform';

/** Stored responses are replayed for 24 h (04 §7.2), then the key may be used again. */
const KEY_LIFETIME_MS = 24 * 3600_000;
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

export interface Outcome<T> {
  status: number;
  body: T;
}

/**
 * `Idempotency-Key` handling (04 §7.2) for POST /orders, POST /orders/{id}/payments and admin refunds:
 * the same key with the same body returns the stored response; the same key with another body is
 * 422 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_IN_PROGRESS.
 * The key is claimed in its own short transaction first, so `run` may call the payment provider
 * outside any transaction. A failed request releases its key, so a retry runs again.
 * Without a key the request simply runs (pending-order reuse, BR-35, still prevents duplicates).
 */
export async function idempotent<T>(
  db: TenantDb,
  actor: TenantActor,
  key: string | undefined,
  route: string,
  body: unknown,
  run: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  if (key === undefined || key === '') return run();
  if (!KEY_FORMAT.test(key)) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ field: 'Idempotency-Key', code: 'format', message: 'Use 8–128 letters, digits, - or _.' }],
    });
  }
  const tenantId = requireTenantId();
  const requestHash = createHash('sha256')
    .update(`${route}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
  const where = { tenantId_membershipId_key: { tenantId, membershipId: actor.membershipId, key } };

  const claim = await db.run(async (tx) => {
    const existing = await tx.idempotencyKey.findUnique({ where });
    if (existing !== null && Date.now() - existing.createdAt.getTime() > KEY_LIFETIME_MS) {
      await tx.idempotencyKey.delete({ where });
    } else if (existing !== null) {
      return existing;
    }
    const inserted = await tx.$executeRaw`
      INSERT INTO idempotency_key (tenant_id, membership_id, key, route, request_hash)
      VALUES (${tenantId}::uuid, ${actor.membershipId}::uuid, ${key}, ${route}, ${requestHash})
      ON CONFLICT DO NOTHING`;
    return inserted === 1 ? null : tx.idempotencyKey.findUnique({ where });
  });

  if (claim !== null) {
    if (claim.requestHash !== requestHash || claim.route !== route)
      throw new AppError('IDEMPOTENCY_KEY_REUSED');
    if (claim.responseStatus === null) throw new AppError('IDEMPOTENCY_IN_PROGRESS');
    return { status: claim.responseStatus, body: claim.responseBody as T };
  }

  try {
    const outcome = await run();
    await db.run((tx) =>
      tx.idempotencyKey.update({
        where,
        data: { responseStatus: outcome.status, responseBody: outcome.body as object },
      }),
    );
    return outcome;
  } catch (error) {
    await db.run((tx) => tx.idempotencyKey.delete({ where })).catch(() => undefined);
    throw error;
  }
}
