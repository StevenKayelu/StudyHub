import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

import type { PrismaClient } from '../../../generated/prisma/client';
import { currentContext, requireTenantId, runWithContext } from '../context/request-context';
import { runInTenantTx, type TenantTx } from '../db/tenant-db';
import { createEnvelope } from './job-envelope';

/**
 * Records a side effect in the SAME transaction as the business change (transactional outbox).
 * The row belongs to the current tenant; RLS's WITH CHECK rejects any other tenant id.
 */
export async function addToOutbox(
  tx: TenantTx,
  topic: string,
  payload: Record<string, unknown> = {},
): Promise<bigint> {
  const row = await tx.outbox.create({
    data: {
      tenantId: requireTenantId(),
      topic,
      payload: payload as object,
      requestId: currentContext()?.requestId ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

export interface DispatchOutboxOptions {
  prisma: PrismaClient;
  boss: PgBoss;
  logger: Logger;
  limit?: number;
}

/**
 * Named system job `outbox.claim` (blueprint 04 §17.4). Discovers due rows across tenants ONLY through
 * the SECURITY DEFINER function claim_due_outbox(), which returns (id, tenant_id) and nothing else.
 * Each row is then read, sent and marked inside its OWN tenant context and transaction, under RLS.
 * Delivery is at-least-once: job handlers must be idempotent.
 */
export async function dispatchDueOutbox(options: DispatchOutboxOptions): Promise<number> {
  const claimed = await options.prisma.$queryRaw<Array<{ id: bigint; tenant_id: string }>>`
    SELECT id, tenant_id FROM claim_due_outbox(${options.limit ?? 50}::integer)`;

  let dispatched = 0;
  for (const { id, tenant_id: tenantId } of claimed) {
    await runWithContext({ requestId: `outbox_${id.toString()}`, tenantId }, async () => {
      try {
        await runInTenantTx(options.prisma, async (tx) => {
          const row = await tx.outbox.findUnique({ where: { id } });
          if (row === null || row.dispatchedAt !== null) return;
          const envelope = createEnvelope(row.topic, row.payload as Record<string, unknown>, {
            tenantId: row.tenantId,
            requestId: row.requestId ?? `outbox_${id.toString()}`,
          });
          const jobId = await options.boss.send(row.topic, envelope);
          if (jobId === null) throw new Error(`queue "${row.topic}" rejected the job`);
          await tx.outbox.update({ where: { id }, data: { dispatchedAt: new Date(), claimedUntil: null } });
          dispatched += 1;
        });
      } catch (error) {
        options.logger.error({ err: error, outboxId: id.toString(), tenantId }, 'Outbox dispatch failed');
        await runInTenantTx(options.prisma, (tx) =>
          tx.outbox.update({
            where: { id },
            data: { lastError: error instanceof Error ? error.message.slice(0, 500) : 'dispatch failed' },
          }),
        ).catch(() => undefined);
      }
    });
  }
  return dispatched;
}
