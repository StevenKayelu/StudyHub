import type { RefundRequest } from '@studyhub/contracts';

import type { TenantActor } from '../../identity';
import { AppError, queueEmail, requireTenantId, runInTenantTx, type TenantTx } from '../../platform';
import { refundModeFor } from '../domain/capability-rules';
import { formatAmount, reversalOf, reversalPlacement } from '../domain/money-rules';
import { accountById } from './accounts';
import {
  buyerOf,
  type CommerceDeps,
  lockPayment,
  scheduleRelease,
  schoolLink,
  schoolName,
} from './settlement';

export interface RefundOutcome {
  refundId: string;
  status: 'SUCCEEDED' | 'FAILED';
  mode: 'PROVIDER' | 'MANUAL';
  message: string | null;
}

/**
 * W4 (F28, BR-13): an administrator refunds a paid order in full, or a payment from the exceptions
 * queue. Through the provider when the school chose it and the account has a refund API (the provider
 * is called between two transactions), otherwise recorded as a manual refund with the reference of the
 * money returned (07 M8 AC 6). The effects commit together in completeRefund (F28 AC).
 */
export async function refundOrder(
  deps: CommerceDeps,
  actor: TenantActor,
  orderId: string,
  input: RefundRequest,
  paymentId?: string,
): Promise<RefundOutcome> {
  const prepared = await runInTenantTx(deps.prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (order === null) throw new AppError('NOT_FOUND');
    const payment = await tx.payment.findFirst({
      where: {
        orderId,
        ...(paymentId !== undefined
          ? { id: paymentId, status: { in: ['NEEDS_REVIEW', 'SUCCEEDED'] } }
          : { status: 'SUCCEEDED' }),
      },
      include: { account: true },
    });
    if (payment === null || (paymentId === undefined && order.status !== 'PAID')) {
      throw new AppError('INVALID_STATE', { detail: 'There is no settled payment to refund on this order.' });
    }
    const inFlight = await tx.refund.findFirst({
      where: { paymentId: payment.id, status: { in: ['PROCESSING', 'SUCCEEDED'] } },
      select: { id: true },
    });
    if (inFlight !== null)
      throw new AppError('INVALID_STATE', { detail: 'This payment is already refunded.' });
    if (paymentId === undefined) await requireDepositRefundable(tx, orderId);

    const account = await accountById(tx, payment.paymentAccountId);
    if (input.mode === 'PROVIDER' && refundModeFor('PROVIDER_API', account.capabilities) !== 'PROVIDER') {
      throw new AppError('PAYMENT_METHOD_NOT_SUPPORTED', {
        detail: 'This payment account has no refund API: record a manual refund instead.',
      });
    }
    const amountMinor = Number(payment.providerAmountMinor ?? payment.amountMinor);
    const refund = await tx.refund.create({
      data: {
        tenantId: requireTenantId(),
        orderId,
        paymentId: payment.id,
        amountMinor: BigInt(amountMinor),
        currency: payment.providerCurrency ?? payment.currency,
        reason: input.reason,
        mode: input.mode,
        status: 'PROCESSING',
        manualReference: input.mode === 'MANUAL' ? input.reference : null,
        requestedBy: actor.membershipId,
      },
      select: { id: true },
    });
    if (input.mode === 'MANUAL') {
      await completeRefund(deps, tx, refund.id, actor);
      return { refundId: refund.id, done: true as const };
    }
    return {
      refundId: refund.id,
      done: false as const,
      account: payment.account,
      reference: payment.reference,
      provider: payment.provider,
      amountMinor,
    };
  });

  if (prepared.done)
    return { refundId: prepared.refundId, status: 'SUCCEEDED', mode: 'MANUAL', message: null };

  const provider = deps.gateway.requireProvider(prepared.provider);
  let result: { ok: true; providerRefundId: string } | { ok: false; message: string };
  try {
    result = await deps.gateway.call(prepared.account.id, () =>
      provider.refund(deps.gateway.open(requireTenantId(), prepared.account), {
        reference: prepared.reference,
        amountMinor: prepared.amountMinor,
        reason: input.reason,
      }),
    );
  } catch (error) {
    await runInTenantTx(deps.prisma, (tx) =>
      tx.refund.update({
        where: { id: prepared.refundId },
        data: {
          status: 'FAILED',
          failureMessage: 'The provider could not be reached.',
          completedAt: new Date(),
        },
      }),
    );
    throw error;
  }

  return runInTenantTx(deps.prisma, async (tx) => {
    if (!result.ok) {
      await tx.refund.update({
        where: { id: prepared.refundId },
        data: { status: 'FAILED', failureMessage: result.message.slice(0, 300), completedAt: new Date() },
      });
      return {
        refundId: prepared.refundId,
        status: 'FAILED' as const,
        mode: 'PROVIDER' as const,
        message: result.message,
      };
    }
    await tx.refund.update({
      where: { id: prepared.refundId },
      data: { providerRefundId: result.providerRefundId },
    });
    await completeRefund(deps, tx, prepared.refundId, actor);
    return {
      refundId: prepared.refundId,
      status: 'SUCCEEDED' as const,
      mode: 'PROVIDER' as const,
      message: null,
    };
  });
}

/**
 * The refund's effects, atomically (F28 AC, BR-13): refund SUCCEEDED, payment REFUNDED and, when this
 * payment paid the order, order REFUNDED, enrolment REVOKED and the instructor's REFUND_REVERSAL entry.
 * A refunded exception (a duplicate or a mismatched payment) leaves the order and its access alone.
 */
export async function completeRefund(
  deps: CommerceDeps,
  tx: TenantTx,
  refundId: string,
  actor: TenantActor,
): Promise<void> {
  const now = new Date();
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  await lockPayment(tx, refund.paymentId);
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: refund.paymentId },
    include: { order: { include: { items: true } } },
  });
  const paidTheOrder = payment.status === 'SUCCEEDED' && payment.order.status === 'PAID';
  const item = payment.order.items[0];

  await tx.refund.update({ where: { id: refundId }, data: { status: 'SUCCEEDED', completedAt: now } });
  await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED', updatedAt: now } });

  let reversedNet: number | null = null;
  if (paidTheOrder && item !== undefined) {
    await tx.order.update({
      where: { id: payment.orderId },
      data: { status: 'REFUNDED', refundedAt: now, updatedAt: now, version: { increment: 1 } },
    });
    if (item.part === 'BALANCE') {
      // A refunded balance locks the rest again: the deposit's lessons stay open and the balance is owed.
      await tx.$executeRaw`
        UPDATE enrollment SET access_limit_pct = plan_lesson_pct, balance_order_item_id = NULL, updated_at = ${now}
         WHERE balance_order_item_id = ${item.id}::uuid AND status = 'ACTIVE'`;
    } else {
      await tx.enrollment.updateMany({
        where: { orderItemId: item.id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokeReason: 'Refunded', updatedAt: now },
      });
    }
    const sale = await tx.ledgerEntry.findFirst({ where: { orderItemId: item.id, type: 'SALE' } });
    if (sale !== null) {
      const amounts = reversalOf({
        grossMinor: Number(sale.grossMinor),
        providerFeeMinor: Number(sale.providerFeeMinor),
        commissionMinor: Number(sale.commissionMinor),
        netMinor: Number(sale.netMinor),
      });
      const placement = reversalPlacement({ status: sale.status, availableAt: sale.availableAt }, now);
      const reversal = await tx.ledgerEntry.create({
        data: {
          tenantId: requireTenantId(),
          instructorMembershipId: sale.instructorMembershipId,
          orderItemId: item.id,
          refundId,
          type: 'REFUND_REVERSAL',
          grossMinor: BigInt(amounts.grossMinor),
          providerFeeMinor: BigInt(amounts.providerFeeMinor),
          commissionMinor: BigInt(amounts.commissionMinor),
          netMinor: BigInt(amounts.netMinor),
          currency: sale.currency,
          status: placement.status,
          availableAt: placement.availableAt,
          createdBy: actor.membershipId,
        },
        select: { id: true },
      });
      if (placement.status === 'PENDING' && placement.availableAt > now) {
        await scheduleRelease(tx, reversal.id, placement.availableAt);
      }
      reversedNet = amounts.netMinor;
    }
  }

  const school = await schoolName(tx);
  const buyer = await buyerOf(tx, payment.order.membershipId);
  const title = item?.titleSnapshot ?? 'your course';
  if (buyer !== null) {
    await queueEmail(tx, deps.box, {
      template: 'refund-learner',
      to: buyer.email,
      vars: {
        schoolName: school,
        displayName: buyer.name,
        courseTitle: title,
        amount: formatAmount(Number(refund.amountMinor), refund.currency),
        ...(refund.manualReference !== null && { reference: refund.manualReference }),
        ...(paidTheOrder && item?.part === 'BALANCE' && { part: 'BALANCE' }),
      },
    });
  }
  if (reversedNet !== null && item !== undefined) {
    const instructor = await buyerOf(tx, item.instructorMembershipId);
    if (instructor !== null) {
      await queueEmail(tx, deps.box, {
        template: 'refund-instructor',
        to: instructor.email,
        vars: {
          schoolName: school,
          displayName: instructor.name,
          courseTitle: title,
          amount: formatAmount(reversedNet, refund.currency),
          link: await schoolLink(tx, deps.schoolUrlTemplate, '/studio/earnings'),
        },
      });
    }
  }
  await deps.audit.record(tx, {
    action: paidTheOrder ? 'order.refunded' : 'payment.refunded',
    entityType: 'order',
    entityId: payment.orderId,
    actorId: actor.userId,
    after: {
      refundId,
      paymentId: payment.id,
      mode: refund.mode,
      amountMinor: Number(refund.amountMinor),
      reason: refund.reason,
      ...(refund.manualReference !== null && { reference: refund.manualReference }),
    },
  });
}

/**
 * PROPOSED 4 (docs/design/payment-plans.md): a deposit is refunded only while its balance is unpaid, so a
 * learner is never left with a paid balance and no access. Refund the balance first.
 */
async function requireDepositRefundable(tx: TenantTx, orderId: string): Promise<void> {
  const item = await tx.orderItem.findFirst({ where: { orderId }, select: { id: true, part: true } });
  if (item?.part !== 'DEPOSIT') return;
  const paidBalance = await tx.enrollment.findFirst({
    where: { orderItemId: item.id, status: 'ACTIVE', balanceOrderItemId: { not: null } },
    select: { id: true },
  });
  if (paidBalance !== null) {
    throw new AppError('INVALID_STATE', {
      detail: 'The balance of this course is paid. Refund the balance order first, then the deposit.',
    });
  }
}
