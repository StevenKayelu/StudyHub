import type { Logger } from 'pino';

import type { PrismaClient } from '../../../generated/prisma/client';
import type { AuditService } from '../../audit';
import { activeEnrollment } from '../../learning';
import {
  addToOutbox,
  AppError,
  type JobEnvelope,
  queueEmail,
  requireTenantId,
  runInTenantTx,
  type SecretBox,
  type TenantTx,
} from '../../platform';
import { readCommerceSettings, readContentSettings, readFeatures } from '../../tenancy';
import {
  availableAtFor,
  formatAmount,
  isPaymentOpen,
  prefixFromSlug,
  receiptNumber,
  saleSplit,
  successProblem,
  type PaymentState,
} from '../domain/money-rules';
import { balanceDueAt, balanceReminderTimes } from '../domain/deposit-rules';
import type { PaymentGateway } from '../infra/payment-gateway';
import type { ProviderStatus } from '../infra/payment-provider';

/** Queues of the commerce module (created by `pnpm db:migrate`, see platform QUEUE_DEFINITIONS). */
export const PAYMENT_EVENT_JOB = 'commerce.payment-event';
export const PAYMENT_CHECK_JOB = 'commerce.payment-check';
export const ORDER_EXPIRE_JOB = 'commerce.order-expire';
export const LEDGER_RELEASE_JOB = 'commerce.ledger-release';
export const LEDGER_CHECK_JOB = 'commerce.ledger-check';
export const BALANCE_REMINDER_JOB = 'commerce.balance-reminder';

/** What the money workflows need, in the API and in the worker alike. */
export interface CommerceDeps {
  prisma: PrismaClient;
  gateway: PaymentGateway;
  /** The identity box: emails are sealed in the queue with it. */
  box: SecretBox;
  schoolUrlTemplate: string;
  audit: AuditService;
}

/** Receipts and calendar years follow the school's time zone (BR-39 default until settings exist). */
const SCHOOL_TIME_ZONE = 'Africa/Lusaka';
/** A payment the provider has never heard of after this long is failed (lost before it reached them). */
const UNKNOWN_AT_PROVIDER_MS = 30 * 60_000;

export async function lockPayment(tx: TenantTx, paymentId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM payment WHERE id = ${paymentId}::uuid FOR UPDATE`;
}

/**
 * Asks the provider for the payment's authoritative status and applies it (F26: never act on a webhook's
 * or a return URL's claims). Used by the webhook job, reconciliation (W5), the return URL and the admin
 * "Re-check". Runs in the current school's context; the provider is called outside any transaction.
 */
export async function refreshPayment(deps: CommerceDeps, paymentId: string): Promise<PaymentState | null> {
  const loaded = await runInTenantTx(deps.prisma, (tx) =>
    tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        reference: true,
        provider: true,
        status: true,
        account: { select: { id: true, credentialsEnc: true, webhookSecretEnc: true, dataKeyEnc: true } },
      },
    }),
  );
  if (loaded === null) return null;
  if (loaded.status === 'SUCCEEDED' || loaded.status === 'REFUNDED') return loaded.status;
  const provider = deps.gateway.requireProvider(loaded.provider);
  const account = deps.gateway.open(requireTenantId(), loaded.account);
  const status = await deps.gateway.call(loaded.account.id, () =>
    provider.getStatus(account, loaded.reference),
  );
  return runInTenantTx(deps.prisma, (tx) => applyProviderStatus(deps, tx, paymentId, status));
}

/**
 * The payment state machine (05 §3.6) applied to the provider's answer, in ONE transaction with the
 * payment row locked, so concurrent webhooks, checks and re-checks confirm a payment exactly once
 * (F26 AC 1). A success either grants everything (W1) or goes to the exceptions queue (BR-10, BR-11).
 */
export async function applyProviderStatus(
  deps: CommerceDeps,
  tx: TenantTx,
  paymentId: string,
  status: ProviderStatus,
  now = new Date(),
): Promise<PaymentState> {
  await lockPayment(tx, paymentId);
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { order: { include: { items: true } } },
  });
  const current = payment.status as PaymentState;

  if (!status.found) {
    if (isPaymentOpen(current) && now.getTime() - payment.createdAt.getTime() > UNKNOWN_AT_PROVIDER_MS) {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED', failureCode: 'NOT_FOUND', updatedAt: now },
      });
      return 'FAILED';
    }
    return current;
  }

  const providerFields = {
    providerTransactionId: status.providerTransactionId,
    providerAmountMinor: BigInt(status.amountMinor),
    providerCurrency: status.currency,
    ...(status.feeMinor !== null && { providerFeeMinor: BigInt(status.feeMinor) }),
    updatedAt: now,
  };

  if (status.status === 'PENDING') {
    if (current === 'INITIATED') {
      await tx.payment.update({ where: { id: paymentId }, data: { ...providerFields, status: 'PENDING' } });
      return 'PENDING';
    }
    return current;
  }

  if (status.status === 'FAILED') {
    if (!isPaymentOpen(current)) return current;
    await tx.payment.update({
      where: { id: paymentId },
      data: { ...providerFields, status: 'FAILED', failureCode: status.failureCode ?? 'PROVIDER_ERROR' },
    });
    return 'FAILED';
  }

  // SUCCEEDED at the provider.
  if (current === 'SUCCEEDED' || current === 'REFUNDED') return current;
  if (current === 'NEEDS_REVIEW') {
    await tx.payment.update({ where: { id: paymentId }, data: providerFields });
    return current;
  }
  await tx.payment.update({ where: { id: paymentId }, data: providerFields });

  const order = payment.order;
  const item = order.items[0];
  if (item === undefined) throw new Error(`order ${order.id} has no item`);
  const enrollment = await activeEnrollment(tx, order.membershipId, item.courseId);
  const problem = successProblem({
    orderStatus: order.status,
    orderAmountMinor: Number(order.totalMinor),
    orderCurrency: order.currency,
    paidAmountMinor: status.amountMinor,
    paidCurrency: status.currency,
    alreadyEnrolled: enrollment !== null,
    part: item.part,
    owesBalance: enrollment !== null && enrollment.accessLimitPct !== null,
  });
  if (problem !== null) {
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'NEEDS_REVIEW', reviewReason: problem, confirmedAt: now },
    });
    await deps.audit.record(tx, {
      action: 'payment.needs_review',
      entityType: 'payment',
      entityId: paymentId,
      after: {
        reason: problem,
        orderId: order.id,
        expected: { amountMinor: Number(order.totalMinor), currency: order.currency },
        paid: { amountMinor: status.amountMinor, currency: status.currency },
      },
    });
    return 'NEEDS_REVIEW';
  }
  await grantPurchase(deps, tx, paymentId, { now });
  return 'SUCCEEDED';
}

/**
 * W1 / W2 in one transaction: payment SUCCEEDED, order PAID, PURCHASE enrolment (unless the learner
 * already has access), the instructor's SALE entry (revenue share only), the receipt number and the
 * receipt email. Also used when an administrator accepts an exception (`acceptedBy`).
 */
export async function grantPurchase(
  deps: CommerceDeps,
  tx: TenantTx,
  paymentId: string,
  options: { now?: Date; acceptedBy?: { membershipId: string; userId: string; note: string } } = {},
): Promise<{ receiptNumber: string }> {
  const now = options.now ?? new Date();
  const tenantId = requireTenantId();
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { order: { include: { items: true } } },
  });
  const order = payment.order;
  const item = order.items[0];
  if (item === undefined) throw new Error(`order ${order.id} has no item`);
  if (order.status === 'PAID' || order.status === 'REFUNDED') {
    throw new AppError('INVALID_STATE', { detail: 'This order is already paid.' });
  }

  await tx.payment.update({
    where: { id: paymentId },
    data: { status: 'SUCCEEDED', confirmedAt: payment.confirmedAt ?? now, updatedAt: now },
  });
  await tx.order.update({
    where: { id: order.id },
    data: { status: 'PAID', paidAt: now, updatedAt: now, version: { increment: 1 } },
  });

  let enrollmentId: string | null = null;
  let dueAt: Date | null = null;
  const existing = await activeEnrollment(tx, order.membershipId, item.courseId);
  if (item.part === 'BALANCE') {
    // The balance opens the rest of the course; start date and expiry stay as the deposit set them.
    if (existing === null || existing.accessLimitPct === null) {
      throw new AppError('INVALID_STATE', { detail: 'Nothing is owed on this course any more.' });
    }
    await tx.enrollment.update({
      where: { id: existing.id },
      data: { accessLimitPct: null, balanceOrderItemId: item.id, updatedAt: now },
    });
    enrollmentId = existing.id;
  } else if (existing === null) {
    const content = await readContentSettings(tx);
    const days = item.accessDays ?? content.defaultAccessDays;
    const deposit =
      item.part === 'DEPOSIT' &&
      item.planLessonPct !== null &&
      item.planBalanceMinor !== null &&
      item.planBalanceDueDays !== null
        ? {
            accessLimitPct: item.planLessonPct,
            planLessonPct: item.planLessonPct,
            balanceMinor: item.planBalanceMinor,
            balanceDueAt: balanceDueAt(now, item.planBalanceDueDays),
          }
        : null;
    const enrollment = await tx.enrollment.create({
      data: {
        tenantId,
        membershipId: order.membershipId,
        courseId: item.courseId,
        source: 'PURCHASE',
        orderItemId: item.id,
        startedAt: now,
        expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000),
        ...deposit,
      },
      select: { id: true },
    });
    enrollmentId = enrollment.id;
    await tx.course.update({ where: { id: item.courseId }, data: { enrollmentCount: { increment: 1 } } });
    if (deposit !== null) {
      dueAt = deposit.balanceDueAt;
      for (const at of balanceReminderTimes(dueAt, now)) {
        const outboxId = await addToOutbox(tx, BALANCE_REMINDER_JOB, { enrollmentId: enrollment.id });
        await tx.outbox.update({ where: { id: outboxId }, data: { availableAt: at } });
      }
    }
  }

  // W2: the instructor's earnings, only where the school shares revenue (03 §9.2 F29).
  if ((await readFeatures(tx)).instructorRevenueShare) {
    const commerce = await readCommerceSettings(tx);
    const gross = Number(item.unitPriceMinor);
    const fee = Math.min(Number(payment.providerFeeMinor ?? 0n), gross);
    const split = saleSplit(gross, fee, commerce.instructorCommissionBps);
    const availableAt = availableAtFor(now, commerce.refundWindowDays);
    await tx.orderItem.update({
      where: { id: item.id },
      data: { commissionBps: commerce.instructorCommissionBps },
    });
    const entry = await tx.ledgerEntry.create({
      data: {
        tenantId,
        instructorMembershipId: item.instructorMembershipId,
        orderItemId: item.id,
        type: 'SALE',
        grossMinor: BigInt(split.grossMinor),
        providerFeeMinor: BigInt(split.providerFeeMinor),
        commissionMinor: BigInt(split.commissionMinor),
        netMinor: BigInt(split.netMinor),
        currency: item.currency,
        status: availableAt <= now ? 'AVAILABLE' : 'PENDING',
        availableAt,
      },
      select: { id: true },
    });
    if (availableAt > now) await scheduleRelease(tx, entry.id, availableAt);
  }

  const number = await allocateReceipt(tx, order.id, now);
  const buyer = await buyerOf(tx, order.membershipId);
  if (buyer !== null) {
    await queueEmail(tx, deps.box, {
      template: 'receipt',
      to: buyer.email,
      vars: {
        schoolName: await schoolName(tx),
        displayName: buyer.name,
        courseTitle: item.titleSnapshot,
        amount: formatAmount(Number(order.totalMinor), order.currency),
        number,
        link: await schoolLink(tx, deps.schoolUrlTemplate, `/account/purchases/${order.id}`),
        ...(item.part !== 'FULL' && { part: item.part }),
        ...(dueAt !== null && { dueDate: schoolDate(dueAt) }),
      },
    });
  }
  await deps.audit.record(tx, {
    action: options.acceptedBy === undefined ? 'order.paid' : 'payment.accepted',
    entityType: 'order',
    entityId: order.id,
    ...(options.acceptedBy !== undefined && { actorId: options.acceptedBy.userId }),
    after: {
      paymentId,
      receiptNumber: number,
      enrollmentId,
      ...(options.acceptedBy !== undefined && { note: options.acceptedBy.note }),
    },
  });
  return { receiptNumber: number };
}

/** A date as emails show it, in the school's time zone ("31 October 2026"). */
export function schoolDate(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: SCHOOL_TIME_ZONE, dateStyle: 'long' }).format(at);
}

/**
 * `commerce.balance-reminder`: reminds a learner of an unpaid balance (PROPOSED 3). Nothing is sent once
 * the balance is paid or the enrolment has ended.
 */
export function createBalanceReminderHandler(
  deps: Pick<CommerceDeps, 'prisma' | 'box' | 'schoolUrlTemplate'>,
) {
  return async (envelope: JobEnvelope): Promise<{ sent: boolean }> => {
    const enrollmentId = envelope.payload.enrollmentId;
    if (typeof enrollmentId !== 'string') return { sent: false };
    return runInTenantTx(deps.prisma, async (tx) => {
      const enrollment = await tx.enrollment.findUnique({
        where: { id: enrollmentId },
        select: {
          status: true,
          membershipId: true,
          accessLimitPct: true,
          balanceMinor: true,
          balanceDueAt: true,
          expiresAt: true,
          course: { select: { slug: true, title: true, currency: true } },
        },
      });
      if (
        enrollment === null ||
        enrollment.status !== 'ACTIVE' ||
        enrollment.accessLimitPct === null ||
        enrollment.balanceMinor === null ||
        enrollment.balanceDueAt === null ||
        (enrollment.expiresAt !== null && enrollment.expiresAt <= new Date())
      ) {
        return { sent: false };
      }
      const buyer = await buyerOf(tx, enrollment.membershipId);
      if (buyer === null) return { sent: false };
      await queueEmail(tx, deps.box, {
        template: 'balance-reminder',
        to: buyer.email,
        vars: {
          schoolName: await schoolName(tx),
          displayName: buyer.name,
          courseTitle: enrollment.course.title,
          amount: formatAmount(Number(enrollment.balanceMinor), enrollment.course.currency),
          dueDate: schoolDate(enrollment.balanceDueAt),
          link: await schoolLink(tx, deps.schoolUrlTemplate, `/courses/${enrollment.course.slug}`),
        },
      });
      return { sent: true };
    });
  };
}

/** BR-33 / BR-55: the next number of the school's year, taken inside this transaction (gap-free). */
export async function allocateReceipt(tx: TenantTx, orderId: string, now: Date): Promise<string> {
  const tenantId = requireTenantId();
  const year = Number(
    new Intl.DateTimeFormat('en', { timeZone: SCHOOL_TIME_ZONE, year: 'numeric' }).format(now),
  );
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { slug: true, receiptPrefix: true },
  });
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO receipt_sequence (tenant_id, year, last_value) VALUES (${tenantId}::uuid, ${year}, 1)
    ON CONFLICT (tenant_id, year) DO UPDATE SET last_value = receipt_sequence.last_value + 1
    RETURNING last_value`;
  const seq = Number(rows[0]?.last_value);
  const number = receiptNumber(tenant.receiptPrefix ?? prefixFromSlug(tenant.slug), year, seq);
  await tx.receipt.create({ data: { tenantId, orderId, number, year, seq, issuedAt: now } });
  return number;
}

/** A PENDING ledger entry becomes AVAILABLE at its date (BR-15), through a delayed outbox row. */
export async function scheduleRelease(tx: TenantTx, entryId: string, at: Date): Promise<void> {
  const outboxId = await addToOutbox(tx, LEDGER_RELEASE_JOB, { entryId });
  await tx.outbox.update({ where: { id: outboxId }, data: { availableAt: at } });
}

/** Reconciliation (W5): the next provider check of an open payment. */
export async function scheduleCheck(tx: TenantTx, paymentId: string, at: Date): Promise<void> {
  const outboxId = await addToOutbox(tx, PAYMENT_CHECK_JOB, { paymentId });
  await tx.outbox.update({ where: { id: outboxId }, data: { availableAt: at } });
}

export async function buyerOf(
  tx: TenantTx,
  membershipId: string,
): Promise<{ email: string; name: string } | null> {
  const membership = await tx.tenantMembership.findUnique({
    where: { id: membershipId },
    select: { displayNameOverride: true, user: { select: { email: true, displayName: true } } },
  });
  if (membership === null) return null;
  return {
    email: membership.user.email,
    name: membership.displayNameOverride ?? membership.user.displayName,
  };
}

/** The school's display name (published branding, else its name), as emails show it. */
export async function schoolName(tx: TenantTx): Promise<string> {
  const tenant = await tx.tenant.findUnique({
    where: { id: requireTenantId() },
    select: { name: true, branding: { select: { displayName: true, status: true } } },
  });
  return tenant?.branding?.status === 'PUBLISHED'
    ? tenant.branding.displayName
    : (tenant?.name ?? 'StudyHub');
}

/** An absolute link on the current school's primary host (current_school_host(), definer). */
export async function schoolLink(tx: TenantTx, template: string, path: string): Promise<string> {
  const rows = await tx.$queryRaw<{ host: string | null }[]>`SELECT current_school_host() AS host`;
  const host = rows[0]?.host;
  return host === null || host === undefined ? path : `${template.replace('{host}', host)}${path}`;
}

/** For logs: payment workflow outcomes without personal data. */
export function logOutcome(logger: Logger, event: string, fields: Record<string, unknown>): void {
  logger.info({ ...fields, event }, `Commerce: ${event}`);
}
