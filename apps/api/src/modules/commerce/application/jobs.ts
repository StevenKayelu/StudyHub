import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

import type { PrismaClient } from '../../../generated/prisma/client';
import {
  AppError,
  enqueue,
  type JobEnvelope,
  queueEmail,
  requireTenantId,
  runInTenantTx,
} from '../../platform';
import { isPaymentOpen, nextCheckDelayMs, type PaymentState } from '../domain/money-rules';
import {
  type CommerceDeps,
  LEDGER_CHECK_JOB,
  lockPayment,
  refreshPayment,
  scheduleCheck,
  schoolLink,
  schoolName,
} from './settlement';

/**
 * Worker handlers of the commerce module. The worker runs each inside its envelope's school context
 * (threat T12): every record is looked up under that school's RLS, so a job naming another school's
 * payment, order or entry finds nothing and does nothing.
 */

/** A stored webhook event: ask the provider and apply (F26). Retried by the queue while it is down. */
export function createPaymentEventHandler(deps: CommerceDeps) {
  return async (envelope: JobEnvelope, logger: Logger): Promise<void> => {
    const eventId = envelope.payload.eventId;
    if (typeof eventId !== 'string') return;
    const event = await runInTenantTx(deps.prisma, (tx) =>
      tx.paymentEvent.findUnique({ where: { id: eventId }, select: { paymentId: true, processedAt: true } }),
    );
    if (event === null || event.processedAt !== null) return;
    if (event.paymentId === null) {
      await markEvent(deps.prisma, eventId, 'UNKNOWN_REFERENCE');
      logger.warn({ eventId }, 'Payment event for an unknown reference; stored and ignored');
      return;
    }
    try {
      const status = await refreshPayment(deps, event.paymentId);
      await markEvent(deps.prisma, eventId, null);
      logger.info({ eventId, paymentId: event.paymentId, status }, 'Payment event processed');
    } catch (error) {
      await markEvent(
        deps.prisma,
        eventId,
        error instanceof AppError ? error.code : 'PROCESSING_FAILED',
        false,
      );
      throw error;
    }
  };
}

async function markEvent(prisma: PrismaClient, eventId: string, error: string | null, processed = true) {
  await runInTenantTx(prisma, (tx) =>
    tx.paymentEvent.update({
      where: { id: eventId },
      data: { processingError: error, ...(processed && { processedAt: new Date() }) },
    }),
  );
}

/**
 * W5: reconciliation of one open payment. Asks the provider; while still open, schedules the next check
 * with backoff; after 24 h without a final status the payment expires.
 */
export function createPaymentCheckHandler(deps: CommerceDeps) {
  return async (envelope: JobEnvelope, logger: Logger): Promise<void> => {
    const paymentId = envelope.payload.paymentId;
    if (typeof paymentId !== 'string') return;
    const payment = await runInTenantTx(deps.prisma, (tx) =>
      tx.payment.findUnique({ where: { id: paymentId }, select: { status: true } }),
    );
    if (payment === null) return;
    // Payments failed locally because the provider was unreachable are checked too (a success is honoured).
    if (!isPaymentOpen(payment.status as PaymentState) && payment.status !== 'FAILED') return;
    try {
      await refreshPayment(deps, paymentId);
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE')) throw error;
      logger.warn({ paymentId }, 'Provider unavailable during reconciliation; will retry');
    }
    await runInTenantTx(deps.prisma, async (tx) => {
      await lockPayment(tx, paymentId);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const open = isPaymentOpen(current.status as PaymentState);
      const retryFailed = current.status === 'FAILED' && current.failureCode === 'PROVIDER_ERROR';
      if (!open && !retryFailed) return;
      const now = new Date();
      // checkCount checks are done, this one included: the next waits twice as long (2, 4, 8 … min).
      const delay = nextCheckDelayMs(current.checkCount + 1, current.createdAt, now);
      if (delay === null) {
        if (open) {
          await tx.payment.update({
            where: { id: paymentId },
            data: {
              status: 'EXPIRED',
              failureCode: current.failureCode ?? 'TIMEOUT',
              nextCheckAt: null,
              updatedAt: now,
            },
          });
          logger.info({ paymentId }, 'Payment expired without a final status (24 h)');
        }
        return;
      }
      const at = new Date(now.getTime() + delay);
      await tx.payment.update({
        where: { id: paymentId },
        data: { checkCount: { increment: 1 }, nextCheckAt: at, updatedAt: now },
      });
      await scheduleCheck(tx, paymentId, at);
    });
  };
}

/** BR-08: an unpaid order expires at its time. A late success is still honoured (EXPIRED → PAID). */
export function createOrderExpireHandler(deps: Pick<CommerceDeps, 'prisma'>) {
  return async (envelope: JobEnvelope): Promise<void> => {
    const orderId = envelope.payload.orderId;
    if (typeof orderId !== 'string') return;
    await runInTenantTx(deps.prisma, (tx) =>
      tx.order.updateMany({
        where: { id: orderId, status: 'PENDING', expiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED', updatedAt: new Date() },
      }),
    );
  };
}

/** BR-15: a PENDING ledger entry becomes AVAILABLE at the end of the refund window. */
export function createLedgerReleaseHandler(deps: Pick<CommerceDeps, 'prisma'>) {
  return async (envelope: JobEnvelope): Promise<void> => {
    const entryId = envelope.payload.entryId;
    if (typeof entryId !== 'string') return;
    await runInTenantTx(deps.prisma, (tx) =>
      tx.ledgerEntry.updateMany({
        where: { id: entryId, status: 'PENDING', availableAt: { lte: new Date() } },
        data: { status: 'AVAILABLE', updatedAt: new Date() },
      }),
    );
  };
}

export interface LedgerCheckResult {
  ok: boolean;
  salesExpected: number;
  salesRecorded: number;
  reversalsExpected: number;
  reversalsRecorded: number;
  mismatches: { kind: string; id: string }[];
}

/**
 * W6 (F29 AC 1): the school's ledger against its orders and refunds. Every revenue-share item of a paid
 * or refunded order has exactly one SALE of its price; every refunded order with a sale has exactly one
 * reversal that cancels it, backed by a successful refund; nothing else is in the ledger; payouts equal
 * their entries. Runs under RLS in
 * the school's context.
 */
export async function checkLedger(deps: Pick<CommerceDeps, 'prisma'>): Promise<LedgerCheckResult> {
  return runInTenantTx(deps.prisma, async (tx) => {
    const totals = await tx.$queryRaw<
      {
        sales_expected: bigint;
        sales_recorded: bigint;
        reversals_expected: bigint;
        reversals_recorded: bigint;
      }[]
    >`
      SELECT
        (SELECT coalesce(sum(oi.unit_price_minor), 0) FROM order_item oi JOIN "order" o ON o.id = oi.order_id
          WHERE oi.commission_bps IS NOT NULL AND o.status IN ('PAID', 'REFUNDED')) AS sales_expected,
        (SELECT coalesce(sum(gross_minor), 0) FROM ledger_entry WHERE type = 'SALE') AS sales_recorded,
        (SELECT coalesce(sum(-s.gross_minor), 0) FROM ledger_entry s
           JOIN order_item oi ON oi.id = s.order_item_id JOIN "order" o ON o.id = oi.order_id
          WHERE s.type = 'SALE' AND o.status = 'REFUNDED') AS reversals_expected,
        (SELECT coalesce(sum(gross_minor), 0) FROM ledger_entry WHERE type = 'REFUND_REVERSAL') AS reversals_recorded`;
    const mismatches = await tx.$queryRaw<{ kind: string; id: string }[]>`
      SELECT 'SALE_MISSING_OR_WRONG' AS kind, oi.id::text AS id
        FROM order_item oi JOIN "order" o ON o.id = oi.order_id
       WHERE oi.commission_bps IS NOT NULL AND o.status IN ('PAID', 'REFUNDED')
         AND (SELECT count(*) FROM ledger_entry s
               WHERE s.order_item_id = oi.id AND s.type = 'SALE' AND s.gross_minor = oi.unit_price_minor) <> 1
      UNION ALL
      SELECT 'SALE_WITHOUT_PAID_ORDER', s.id::text
        FROM ledger_entry s JOIN order_item oi ON oi.id = s.order_item_id JOIN "order" o ON o.id = oi.order_id
       WHERE s.type = 'SALE' AND (o.status NOT IN ('PAID', 'REFUNDED') OR oi.commission_bps IS NULL)
      UNION ALL
      SELECT 'REVERSAL_MISSING_OR_WRONG', s.id::text
        FROM ledger_entry s JOIN order_item oi ON oi.id = s.order_item_id JOIN "order" o ON o.id = oi.order_id
       WHERE s.type = 'SALE' AND o.status = 'REFUNDED'
         AND (SELECT count(*) FROM ledger_entry v
               WHERE v.order_item_id = s.order_item_id AND v.type = 'REFUND_REVERSAL'
                 AND v.gross_minor = -s.gross_minor AND v.net_minor = -s.net_minor) <> 1
      UNION ALL
      SELECT 'REVERSAL_WITHOUT_REFUND', v.id::text
        FROM ledger_entry v JOIN refund r ON r.id = v.refund_id JOIN "order" o ON o.id = r.order_id
       WHERE v.type = 'REFUND_REVERSAL' AND (r.status <> 'SUCCEEDED' OR o.status <> 'REFUNDED')
      UNION ALL
      SELECT 'PAYOUT_TOTAL', p.id::text
        FROM payout p
       WHERE p.amount_minor <> (SELECT coalesce(sum(net_minor), 0) FROM ledger_entry e WHERE e.payout_id = p.id)
       LIMIT 200`;
    const t = totals[0];
    const result: LedgerCheckResult = {
      salesExpected: Number(t?.sales_expected ?? 0n),
      salesRecorded: Number(t?.sales_recorded ?? 0n),
      reversalsExpected: Number(t?.reversals_expected ?? 0n),
      reversalsRecorded: Number(t?.reversals_recorded ?? 0n),
      mismatches,
      ok: false,
    };
    result.ok =
      mismatches.length === 0 &&
      result.salesExpected === result.salesRecorded &&
      result.reversalsExpected === result.reversalsRecorded;
    return result;
  });
}

/** W6 job: run the check, store it and, on a mismatch, alert the school's owners and the platform. */
export function createLedgerCheckHandler(deps: CommerceDeps) {
  return async (_envelope: JobEnvelope, logger: Logger): Promise<LedgerCheckResult> => {
    const result = await checkLedger(deps);
    await runInTenantTx(deps.prisma, async (tx) => {
      await tx.ledgerCheck.create({
        data: {
          tenantId: requireTenantId(),
          ok: result.ok,
          salesExpectedMinor: BigInt(result.salesExpected),
          salesRecordedMinor: BigInt(result.salesRecorded),
          reversalsExpectedMinor: BigInt(result.reversalsExpected),
          reversalsRecordedMinor: BigInt(result.reversalsRecorded),
          mismatches: result.mismatches as object,
        },
      });
      if (result.ok) return;
      const owners = await tx.tenantMembership.findMany({
        where: { status: 'ACTIVE', roles: { some: { role: 'TENANT_OWNER' } } },
        select: { displayNameOverride: true, user: { select: { email: true, displayName: true } } },
      });
      const school = await schoolName(tx);
      const link = await schoolLink(tx, deps.schoolUrlTemplate, '/admin/orders');
      for (const owner of owners) {
        await queueEmail(tx, deps.box, {
          template: 'ledger-mismatch',
          to: owner.user.email,
          vars: {
            schoolName: school,
            displayName: owner.displayNameOverride ?? owner.user.displayName,
            reference: `${result.mismatches.length} item(s) to review.`,
            link,
          },
        });
      }
    });
    if (!result.ok) {
      // The platform's alert carries metadata only: the school id and counts (W6).
      logger.warn(
        { tenantId: requireTenantId(), mismatches: result.mismatches.length, alert: 'ledger-mismatch' },
        'Ledger check found a mismatch',
      );
    }
    return result;
  };
}

/**
 * The system side of W6: schools due a check come from due_ledger_checks() (ids only); each gets a
 * LEDGER_CHECK_JOB in its own context.
 */
export async function enqueueDueLedgerChecks(deps: { prisma: PrismaClient; boss: PgBoss }): Promise<number> {
  const due = await deps.prisma.$queryRaw<
    { tenant_id: string }[]
  >`SELECT tenant_id FROM due_ledger_checks(100)`;
  for (const { tenant_id: tenantId } of due) {
    await enqueue(deps.boss, LEDGER_CHECK_JOB, {}, { tenantId, requestId: `ledger_check_${tenantId}` });
  }
  return due.length;
}
