import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminOrderDetail,
  adminOrdersQuerySchema,
  LedgerLine,
  RefundRequest,
} from '@studyhub/contracts';
import type { z } from 'zod';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, ConfigService, PrismaService, SecretBox, TenantDb, type TenantTx } from '../../platform';
import { readCommerceSettings } from '../../tenancy';
import { refundModeFor } from '../domain/capability-rules';
import { refundWithinGuidance } from '../domain/money-rules';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../infra/payment-gateway';
import { accountById } from './accounts';
import { idempotent, type Outcome } from './idempotency';
import { type RefundOutcome, refundOrder } from './refunds';
import { type CommerceDeps, grantPurchase, lockPayment, refreshPayment } from './settlement';

/** School administration of orders and payments (05 §4.9; S-AD02, S-AD04; F26 exceptions, F28). */
@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly box: SecretBox,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private deps(): CommerceDeps {
    return {
      prisma: this.prisma,
      gateway: this.gateway,
      box: this.box,
      schoolUrlTemplate: this.config.get('SCHOOL_URL_TEMPLATE'),
      audit: this.audit,
    };
  }

  /** GET /admin/orders: filterable, newest first (up to 500). */
  async list(actor: TenantActor, query: z.infer<typeof adminOrdersQuerySchema>) {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const search = query.q?.trim();
      const orders = await tx.order.findMany({
        where: {
          ...(query.status !== undefined && { status: query.status }),
          ...(query.method !== undefined && { payments: { some: { method: query.method } } }),
          ...((query.from !== undefined || query.to !== undefined) && {
            createdAt: {
              ...(query.from !== undefined && { gte: new Date(`${query.from}T00:00:00Z`) }),
              ...(query.to !== undefined && {
                lt: new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000),
              }),
            },
          }),
          ...(search !== undefined &&
            search !== '' && {
              items: { some: { titleSnapshot: { contains: search, mode: 'insensitive' } } },
            }),
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: {
          items: { take: 1 },
          receipt: { select: { number: true } },
          payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      const buyers = await buyersById(
        tx,
        orders.map((o) => o.membershipId),
      );
      return {
        orders: orders.map((order) => row(order, buyers.get(order.membershipId))),
      };
    });
  }

  /** GET /admin/orders/{id}: payments, events, refunds, ledger lines and refund guidance. */
  async detail(actor: TenantActor, orderId: string): Promise<AdminOrderDetail> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: { take: 1 },
          receipt: { select: { number: true } },
          payments: {
            orderBy: { createdAt: 'asc' },
            include: { events: { orderBy: { receivedAt: 'asc' } } },
          },
          refunds: { orderBy: { createdAt: 'asc' } },
        },
      });
      if (order === null) throw new AppError('NOT_FOUND');
      const item = order.items[0];
      const buyers = await buyersById(tx, [order.membershipId]);
      const enrollment =
        item === undefined
          ? null
          : await tx.enrollment.findFirst({
              where: { orderItemId: item.id },
              orderBy: { startedAt: 'desc' },
              select: { status: true, progressPercent: true },
            });
      const ledger = item === undefined ? [] : await ledgerLines(tx, { orderItemId: item.id });
      const settings = await readCommerceSettings(tx);
      const settled = order.payments.find((p) => p.status === 'SUCCEEDED');
      const account = settled === undefined ? null : await accountById(tx, settled.paymentAccountId);
      const progress = enrollment?.progressPercent ?? null;
      const refundable = order.status === 'PAID' && settled !== undefined;
      const exception = order.payments.some((p) => p.status === 'NEEDS_REVIEW');
      const latest = order.payments.at(-1);
      return {
        order: {
          ...row(
            { ...order, payments: latest === undefined ? [] : [latest] },
            buyers.get(order.membershipId),
          ),
          expiresAt: order.expiresAt.toISOString(),
          paidAt: order.paidAt?.toISOString() ?? null,
          courseId: item?.courseId ?? '',
          enrollmentStatus: enrollment?.status ?? null,
          progressPercent: progress,
        },
        payments: order.payments.map((p) => ({
          id: p.id,
          reference: p.reference,
          method: p.method,
          network: p.network,
          maskedMsisdn: p.msisdnMasked,
          status: p.status,
          amount: { amountMinor: Number(p.amountMinor), currency: p.currency },
          providerAmount:
            p.providerAmountMinor === null
              ? null
              : { amountMinor: Number(p.providerAmountMinor), currency: p.providerCurrency ?? p.currency },
          failureCode: p.failureCode,
          reviewReason: p.reviewReason,
          createdAt: p.createdAt.toISOString(),
          confirmedAt: p.confirmedAt?.toISOString() ?? null,
        })),
        events: order.payments.flatMap((p) =>
          p.events.map((e) => ({
            id: e.id,
            type: e.type,
            receivedAt: e.receivedAt.toISOString(),
            processedAt: e.processedAt?.toISOString() ?? null,
            payload: e.payload,
          })),
        ),
        refunds: order.refunds.map((r) => ({
          id: r.id,
          mode: r.mode,
          status: r.status,
          amount: { amountMinor: Number(r.amountMinor), currency: r.currency },
          reason: r.reason,
          reference: r.manualReference ?? r.providerRefundId,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
        })),
        ledger,
        refundGuidance: {
          withinWindow: refundWithinGuidance(order.paidAt, progress, settings.refundWindowDays, new Date()),
          windowDays: settings.refundWindowDays,
          progressPercent: progress,
          refundApi: account?.capabilities?.refundApi ?? 'NONE',
          defaultMode: refundModeFor(settings.refundMode, account?.capabilities ?? null),
        },
        allowedActions: [
          ...(refundable || exception ? (['refund'] as const) : []),
          ...(order.payments.some((p) =>
            ['INITIATED', 'PENDING', 'CANCELLED', 'NEEDS_REVIEW', 'FAILED', 'EXPIRED'].includes(p.status),
          )
            ? (['recheck'] as const)
            : []),
          ...(exception && order.status !== 'PAID' && order.status !== 'REFUNDED'
            ? (['accept'] as const)
            : []),
        ],
      };
    });
  }

  /** GET /admin/payment-exceptions (S-AD02): payments waiting for a decision (BR-10, BR-11). */
  async exceptions(actor: TenantActor) {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { status: 'NEEDS_REVIEW' },
        orderBy: { createdAt: 'asc' },
        take: 200,
        include: { order: { include: { items: { take: 1 } } } },
      });
      const buyers = await buyersById(
        tx,
        payments.map((p) => p.order.membershipId),
      );
      return {
        exceptions: payments.map((p) => ({
          paymentId: p.id,
          orderId: p.orderId,
          createdAt: p.createdAt.toISOString(),
          buyerName: buyers.get(p.order.membershipId)?.name ?? '',
          courseTitle: p.order.items[0]?.titleSnapshot ?? '',
          amount: { amountMinor: Number(p.amountMinor), currency: p.currency },
          providerAmount:
            p.providerAmountMinor === null
              ? null
              : { amountMinor: Number(p.providerAmountMinor), currency: p.providerCurrency ?? p.currency },
          reviewReason: p.reviewReason ?? '',
        })),
      };
    });
  }

  /** POST /admin/payments/{id}/recheck: ask the provider again (S-AD02, S-AD04). */
  async recheck(actor: TenantActor, paymentId: string) {
    requireAdmin(actor);
    const exists = await this.db.run((tx) =>
      tx.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } }),
    );
    if (exists === null) throw new AppError('NOT_FOUND');
    const status = await refreshPayment(this.deps(), paymentId);
    return { paymentId, status };
  }

  /** POST /admin/payments/{id}/resolve {decision: ACCEPT}: grants access as paid (audited). */
  async accept(actor: TenantActor, paymentId: string, note: string) {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      await lockPayment(tx, paymentId);
      const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { order: true } });
      if (payment === null) throw new AppError('NOT_FOUND');
      if (
        payment.status !== 'NEEDS_REVIEW' ||
        payment.order.status === 'PAID' ||
        payment.order.status === 'REFUNDED'
      ) {
        throw new AppError('INVALID_STATE', {
          detail: 'Only a payment in review on an unpaid order can be accepted; refund duplicates instead.',
        });
      }
      const result = await grantPurchase(this.deps(), tx, paymentId, {
        acceptedBy: { membershipId: actor.membershipId, userId: actor.userId, note },
      });
      return { paymentId, status: 'SUCCEEDED' as const, receiptNumber: result.receiptNumber };
    });
  }

  /** POST /admin/orders/{id}/refunds (Idempotency-Key): W4. `paymentId` refunds an exception. */
  refund(
    actor: TenantActor,
    orderId: string,
    input: RefundRequest,
    paymentId: string | undefined,
    key: string | undefined,
  ): Promise<Outcome<RefundOutcome>> {
    requireAdmin(actor);
    const route = `POST /admin/orders/${orderId}/refunds`;
    return idempotent(this.db, actor, key, route, { ...input, paymentId }, async () => {
      const outcome = await refundOrder(this.deps(), actor, orderId, input, paymentId);
      return { status: outcome.status === 'SUCCEEDED' ? 201 : 409, body: outcome };
    });
  }
}

function requireAdmin(actor: TenantActor): void {
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
}

async function buyersById(tx: TenantTx, ids: string[]) {
  const memberships = await tx.tenantMembership.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, displayNameOverride: true, user: { select: { email: true, displayName: true } } },
  });
  return new Map(
    memberships.map((m) => [
      m.id,
      { name: m.displayNameOverride ?? m.user.displayName, email: m.user.email },
    ]),
  );
}

function row(
  order: {
    id: string;
    createdAt: Date;
    status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
    totalMinor: bigint;
    currency: string;
    items: { titleSnapshot: string; part: 'FULL' | 'DEPOSIT' | 'BALANCE' }[];
    receipt: { number: string } | null;
    payments: {
      method: 'MOBILE_MONEY' | 'CARD';
      network: 'MTN' | 'AIRTEL' | 'ZAMTEL' | null;
      status: string;
    }[];
  },
  buyer: { name: string; email: string } | undefined,
) {
  const payment = order.payments[0];
  return {
    id: order.id,
    createdAt: order.createdAt.toISOString(),
    status: order.status,
    buyerName: buyer?.name ?? '',
    buyerEmail: buyer?.email ?? '',
    courseTitle: order.items[0]?.titleSnapshot ?? '',
    part: order.items[0]?.part ?? 'FULL',
    total: { amountMinor: Number(order.totalMinor), currency: order.currency },
    method: payment?.method ?? null,
    network: payment?.network ?? null,
    paymentStatus: (payment?.status ?? null) as AdminOrderDetail['order']['paymentStatus'],
    receiptNumber: order.receipt?.number ?? null,
  };
}

/** Ledger lines with names and course titles, for order detail, statements and payouts. */
export async function ledgerLines(
  tx: TenantTx,
  where: { orderItemId?: string; instructorMembershipId?: string; payoutId?: string },
): Promise<LedgerLine[]> {
  const entries = await tx.ledgerEntry.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: { orderItem: { select: { titleSnapshot: true, instructorNameSnapshot: true } } },
    take: 5000,
  });
  const names = await buyersById(
    tx,
    entries.map((e) => e.instructorMembershipId),
  );
  return entries.map((e) => ({
    id: e.id,
    type: e.type,
    status: e.status,
    instructorName: e.orderItem?.instructorNameSnapshot || names.get(e.instructorMembershipId)?.name || '',
    gross: Number(e.grossMinor),
    providerFee: Number(e.providerFeeMinor),
    commission: Number(e.commissionMinor),
    net: Number(e.netMinor),
    currency: e.currency,
    availableAt: e.availableAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
    courseTitle: e.orderItem?.titleSnapshot ?? e.note ?? '',
    payoutId: e.payoutId,
  }));
}
