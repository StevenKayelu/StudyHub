import { Inject, Injectable } from '@nestjs/common';
import {
  detectNetwork,
  maskMsisdn,
  type MobileNetwork,
  normalizeMsisdn,
  type OrderPart,
  type OrderView,
  type PaymentCapabilities,
  type PaymentFailureCode,
  type PaymentStarted,
  type ReceiptView,
  type StartPayment,
} from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { activeEnrollment } from '../../learning';
import {
  addToOutbox,
  AppError,
  ConfigService,
  PrismaService,
  requireTenantId,
  SecretBox,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { readCommerceSettings, requireFeature } from '../../tenancy';
import { offeredMethods } from '../domain/capability-rules';
import { planOffered } from '../domain/deposit-rules';
import { isOrderPayable } from '../domain/money-rules';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../infra/payment-gateway';
import { idempotent, type Outcome } from './idempotency';
import { type CommerceDeps, ORDER_EXPIRE_JOB, refreshPayment, scheduleCheck, schoolLink } from './settlement';

const POLL_AFTER_MS = 3000;
const FIRST_CHECK_MS = 2 * 60_000;

/** Learner checkout (F25, F27; 05 §4.8, §5; S-L08–S-L11). */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly box: SecretBox,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  deps(): CommerceDeps {
    return {
      prisma: this.prisma,
      gateway: this.gateway,
      box: this.box,
      schoolUrlTemplate: this.config.get('SCHOOL_URL_TEMPLATE'),
      audit: this.audit,
    };
  }

  /**
   * POST /orders: create, or reuse the learner's pending order for the course and part (BR-35). `part`
   * is FULL (the price), DEPOSIT (the course's deposit plan) or BALANCE (what a deposit enrolment owes).
   */
  createOrder(
    actor: TenantActor,
    input: { courseId: string; part: OrderPart },
    key: string | undefined,
  ): Promise<Outcome<OrderView>> {
    const { courseId, part } = input;
    return idempotent(this.db, actor, key, 'POST /orders', { courseId, part }, () =>
      this.db.run(async (tx) => {
        const created = await this.orderFor(tx, actor, courseId, part);
        return { status: created.created ? 201 : 200, body: await this.view(tx, created.orderId) };
      }),
    );
  }

  private async orderFor(
    tx: TenantTx,
    actor: TenantActor,
    courseId: string,
    part: OrderPart,
  ): Promise<{ orderId: string; created: boolean }> {
    const account = await tx.userAccount.findUnique({
      where: { id: actor.userId },
      select: { emailVerifiedAt: true },
    });
    if (account?.emailVerifiedAt === null || account === null) throw new AppError('EMAIL_NOT_VERIFIED');
    await requireFeature(tx, 'paidCourses');
    const course = await tx.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        title: true,
        status: true,
        priceMinor: true,
        currency: true,
        accessDays: true,
        ownerMembershipId: true,
        depositMinor: true,
        depositLessonPct: true,
        balanceDueDays: true,
      },
    });
    if (course === null) throw new AppError('NOT_FOUND');
    const notPurchasable = (detail: string) => new AppError('COURSE_NOT_PURCHASABLE', { detail });
    // BR-31: instructors don't buy their own courses.
    if (course.ownerMembershipId === actor.membershipId) throw notPurchasable('You teach this course.');
    const enrollment = await activeEnrollment(tx, actor.membershipId, courseId);

    let amountMinor: bigint;
    let plan: { planLessonPct: number; planBalanceMinor: bigint; planBalanceDueDays: number } | null = null;
    if (part === 'BALANCE') {
      // Payable after the deadline too, and even if the course was unpublished since (learners keep it).
      if (enrollment?.accessLimitPct === null || enrollment === null || enrollment.balanceMinor === null) {
        throw new AppError('INVALID_STATE', { detail: 'Nothing is owed on this course.' });
      }
      amountMinor = enrollment.balanceMinor;
    } else {
      if (course.status !== 'PUBLISHED') throw notPurchasable('This course is not on sale.');
      if (course.priceMinor <= 0n) throw notPurchasable('This course is free: enrol instead.');
      if (enrollment !== null) throw new AppError('ALREADY_ENROLLED');
      amountMinor = course.priceMinor;
      if (part === 'DEPOSIT') {
        const offered =
          course.depositMinor === null || course.depositLessonPct === null || course.balanceDueDays === null
            ? null
            : {
                depositMinor: Number(course.depositMinor),
                lessonPct: course.depositLessonPct,
                balanceDueDays: course.balanceDueDays,
              };
        const { depositPlans } = await readCommerceSettings(tx);
        if (!planOffered(Number(course.priceMinor), offered, depositPlans)) {
          throw notPurchasable('This course does not offer a deposit.');
        }
        amountMinor = BigInt(offered.depositMinor);
        plan = {
          planLessonPct: offered.lessonPct,
          planBalanceMinor: course.priceMinor - amountMinor,
          planBalanceDueDays: offered.balanceDueDays,
        };
      }
    }
    if ((await activeAccount(tx)) === null)
      throw notPurchasable('This school is not taking payments right now.');

    const now = new Date();
    const pending = await tx.order.findFirst({
      where: {
        membershipId: actor.membershipId,
        status: 'PENDING',
        expiresAt: { gt: now },
        items: { some: { courseId, part } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (pending !== null) return { orderId: pending.id, created: false };

    const settings = await readCommerceSettings(tx);
    const expiresAt = new Date(now.getTime() + settings.orderExpiryMinutes * 60_000);
    const instructor = await tx.instructorProfile.findUnique({
      where: { membershipId: course.ownerMembershipId },
      select: { displayName: true },
    });
    const order = await tx.order.create({
      data: {
        tenantId: requireTenantId(),
        membershipId: actor.membershipId,
        currency: course.currency,
        totalMinor: amountMinor,
        expiresAt,
        items: {
          // tenant_id comes from the order through the composite key.
          create: {
            courseId,
            instructorMembershipId: course.ownerMembershipId,
            titleSnapshot: course.title,
            instructorNameSnapshot: instructor?.displayName ?? '',
            unitPriceMinor: amountMinor,
            currency: course.currency,
            accessDays: course.accessDays,
            part,
            ...plan,
          },
        },
      },
      select: { id: true },
    });
    const outboxId = await addToOutbox(tx, ORDER_EXPIRE_JOB, { orderId: order.id });
    await tx.outbox.update({ where: { id: outboxId }, data: { availableAt: expiresAt } });
    return { orderId: order.id, created: true };
  }

  /** GET /orders/{id}: the order owner (polling) or an administrator. */
  async order(actor: TenantActor, orderId: string): Promise<OrderView> {
    return this.db.run(async (tx) => {
      await this.requireOrderAccess(tx, actor, orderId, { adminToo: true });
      return this.view(tx, orderId);
    });
  }

  /**
   * POST /orders/{id}/payments: one payment in flight per order (BR-36): a new one cancels the previous
   * pending payment locally (a late success is still honoured). The provider is called outside the
   * transaction; the first reconciliation check is scheduled 2 min later (W5).
   */
  startPayment(
    actor: TenantActor,
    orderId: string,
    input: StartPayment,
    key: string | undefined,
  ): Promise<Outcome<PaymentStarted>> {
    return idempotent(this.db, actor, key, `POST /orders/${orderId}/payments`, input, async () => {
      const prepared = await this.db.run(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
        const order = await this.requireOrderAccess(tx, actor, orderId, { adminToo: false });
        if (!isOrderPayable(order, new Date())) throw new AppError('ORDER_NOT_PAYABLE');
        const account = await activeAccount(tx);
        if (account === null) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE');
        const settings = await readCommerceSettings(tx);
        const offered = offeredMethods(settings.enabledPaymentMethods, account.capabilities);
        if (!offered.methods.includes(input.method)) throw new AppError('PAYMENT_METHOD_NOT_SUPPORTED');

        let mobile: { msisdn: string; network: MobileNetwork } | null = null;
        if (input.method === 'MOBILE_MONEY') {
          const msisdn = normalizeMsisdn(input.msisdn);
          const network = input.network ?? (msisdn === null ? null : detectNetwork(msisdn));
          if (msisdn === null || network === null) {
            throw new AppError('VALIDATION_FAILED', {
              errors: [
                {
                  field: 'msisdn',
                  code: 'INVALID_PHONE',
                  message: 'Enter a Zambian mobile number, e.g. 097 123 4567.',
                },
              ],
            });
          }
          if (!offered.networks.includes(network)) throw new AppError('PAYMENT_METHOD_NOT_SUPPORTED');
          mobile = { msisdn, network };
        }

        await tx.payment.updateMany({
          where: { orderId, status: { in: ['INITIATED', 'PENDING'] } },
          data: { status: 'CANCELLED', updatedAt: new Date() },
        });
        const tenantId = requireTenantId();
        const payment = await tx.payment.create({
          data: {
            tenantId,
            orderId,
            paymentAccountId: account.id,
            provider: account.provider,
            method: input.method,
            ...(mobile !== null && {
              network: mobile.network,
              msisdnEnc: this.gateway.vault.sealValue(tenantId, 'msisdn', mobile.msisdn),
              msisdnMasked: maskMsisdn(mobile.msisdn),
            }),
            amountMinor: order.totalMinor,
            currency: order.currency,
          },
          select: { id: true, reference: true },
        });
        return {
          payment,
          account,
          mobile,
          amountMinor: Number(order.totalMinor),
          currency: order.currency,
          returnUrl: await schoolLink(tx, this.config.get('SCHOOL_URL_TEMPLATE'), `/learn/orders/${orderId}`),
          title: (await tx.orderItem.findFirst({ where: { orderId }, select: { titleSnapshot: true } }))
            ?.titleSnapshot,
        };
      });

      const provider = this.gateway.requireProvider(prepared.account.provider);
      const providerAccount = this.gateway.open(requireTenantId(), prepared.account);
      let result;
      try {
        result = await this.gateway.call(prepared.account.id, () =>
          provider.startPayment(providerAccount, {
            reference: prepared.payment.reference,
            amountMinor: prepared.amountMinor,
            currency: prepared.currency,
            method: input.method,
            ...(prepared.mobile !== null && {
              msisdn: prepared.mobile.msisdn,
              network: prepared.mobile.network,
            }),
            returnUrl: prepared.returnUrl,
            description: prepared.title ?? 'Course',
          }),
        );
      } catch (error) {
        // We can't know whether the request reached the provider: fail it locally and let reconciliation
        // find out (a success there is still honoured, W5).
        await this.db.run(async (tx) => {
          await tx.payment.update({
            where: { id: prepared.payment.id },
            data: { status: 'FAILED', failureCode: 'PROVIDER_ERROR', updatedAt: new Date() },
          });
          await scheduleCheck(tx, prepared.payment.id, new Date(Date.now() + FIRST_CHECK_MS));
        });
        throw error;
      }

      const started = await this.db.run(async (tx) => {
        if (result.kind === 'FAILED') {
          await tx.payment.update({
            where: { id: prepared.payment.id },
            data: {
              status: 'FAILED',
              failureCode: result.failureCode,
              failureMessage: result.message.slice(0, 300),
              providerTransactionId: result.providerTransactionId,
              updatedAt: new Date(),
            },
          });
          return { status: 'FAILED' as const, redirectUrl: null, failureCode: result.failureCode };
        }
        await tx.payment.updateMany({
          where: { id: prepared.payment.id, status: 'INITIATED' },
          data: {
            status: 'PENDING',
            providerTransactionId: result.providerTransactionId,
            updatedAt: new Date(),
          },
        });
        await scheduleCheck(tx, prepared.payment.id, new Date(Date.now() + FIRST_CHECK_MS));
        return { status: 'PENDING' as const, redirectUrl: result.redirectUrl, failureCode: null };
      });

      const amount = (prepared.amountMinor / 100).toFixed(2);
      const body: PaymentStarted = {
        paymentId: prepared.payment.id,
        status: started.status,
        failureCode: started.failureCode as PaymentFailureCode | null,
        pollAfterMs: POLL_AFTER_MS,
        nextAction:
          started.status === 'FAILED'
            ? { type: 'NONE' }
            : started.redirectUrl !== null
              ? { type: 'REDIRECT', url: started.redirectUrl }
              : {
                  type: 'APPROVE_ON_PHONE',
                  network: prepared.mobile?.network ?? 'MTN',
                  maskedMsisdn: maskMsisdn(prepared.mobile?.msisdn ?? ''),
                  message: `Check your phone and enter your PIN to approve K${amount}.`,
                },
      };
      return { status: 202, body };
    });
  }

  /**
   * POST /orders/{id}/refresh (and the provider's return URL): asks the provider about the order's latest
   * open payment. Never trusts what the browser says (F25 AC 1).
   */
  async refresh(actor: TenantActor, orderId: string): Promise<OrderView> {
    const paymentId = await this.db.run(async (tx) => {
      await this.requireOrderAccess(tx, actor, orderId, { adminToo: false });
      const payment = await tx.payment.findFirst({
        where: { orderId, status: { in: ['INITIATED', 'PENDING', 'CANCELLED', 'FAILED', 'EXPIRED'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      return payment?.id ?? null;
    });
    if (paymentId !== null) await refreshPayment(this.deps(), paymentId);
    return this.order(actor, orderId);
  }

  /** GET /payments/return?ref=: the order the reference belongs to, after a status check. */
  async returnFromProvider(actor: TenantActor, reference: string): Promise<string | null> {
    const payment = await this.db.run((tx) =>
      tx.payment.findFirst({
        where: { reference, order: { membershipId: actor.membershipId } },
        select: { id: true, orderId: true },
      }),
    );
    if (payment === null) return null;
    await refreshPayment(this.deps(), payment.id).catch(() => undefined);
    return payment.orderId;
  }

  /** POST /orders/{id}/cancel: no money taken; a late success on its payment is still honoured. */
  async cancel(actor: TenantActor, orderId: string): Promise<OrderView> {
    return this.db.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await this.requireOrderAccess(tx, actor, orderId, { adminToo: false });
      if (order.status !== 'PENDING') throw new AppError('ORDER_NOT_PAYABLE');
      const now = new Date();
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED', cancelledAt: now, updatedAt: now, version: { increment: 1 } },
      });
      await tx.payment.updateMany({
        where: { orderId, status: { in: ['INITIATED', 'PENDING'] } },
        data: { status: 'CANCELLED', updatedAt: now },
      });
      return this.view(tx, orderId);
    });
  }

  /** GET /me/orders (S-L11). */
  async myOrders(actor: TenantActor) {
    return this.db.run(async (tx) => {
      const orders = await tx.order.findMany({
        where: { membershipId: actor.membershipId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { items: { take: 1 }, receipt: { select: { number: true } } },
      });
      return {
        orders: orders.map((order) => ({
          id: order.id,
          createdAt: order.createdAt.toISOString(),
          status: order.status,
          courseId: order.items[0]?.courseId ?? '',
          courseTitle: order.items[0]?.titleSnapshot ?? '',
          part: order.items[0]?.part ?? 'FULL',
          total: { amountMinor: Number(order.totalMinor), currency: order.currency },
          receiptNumber: order.receipt?.number ?? null,
        })),
      };
    });
  }

  /** GET /me/orders/{id}/receipt (F27, F48: the school is the seller). */
  async receipt(actor: TenantActor, orderId: string): Promise<ReceiptView> {
    return this.db.run(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: true,
          receipt: true,
          payments: { where: { status: { in: ['SUCCEEDED', 'REFUNDED'] } }, take: 1 },
        },
      });
      if (order === null || (order.membershipId !== actor.membershipId && !can(actor, 'admin.access'))) {
        throw new AppError('NOT_FOUND');
      }
      const payment = order.payments[0];
      if (order.receipt === null || payment === undefined) throw new AppError('NOT_FOUND');
      const commerce = await readCommerceSettings(tx);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: requireTenantId() },
        select: { name: true, branding: { select: { displayName: true, status: true } } },
      });
      const buyer = await tx.tenantMembership.findUniqueOrThrow({
        where: { id: order.membershipId },
        select: { displayNameOverride: true, user: { select: { email: true, displayName: true } } },
      });
      return {
        number: order.receipt.number,
        issuedAt: order.receipt.issuedAt.toISOString(),
        seller: {
          name: tenant.branding?.status === 'PUBLISHED' ? tenant.branding.displayName : tenant.name,
          legalName: commerce.receiptSeller.legalName,
          address: commerce.receiptSeller.address,
          taxId: commerce.receiptSeller.taxId,
        },
        buyer: { name: buyer.displayNameOverride ?? buyer.user.displayName, email: buyer.user.email },
        items: order.items.map((item) => ({
          title: item.titleSnapshot,
          unitPrice: { amountMinor: Number(item.unitPriceMinor), currency: item.currency },
          part: item.part,
        })),
        total: { amountMinor: Number(order.totalMinor), currency: order.currency },
        payment: {
          method: payment.method,
          network: payment.network,
          maskedMsisdn: payment.msisdnMasked,
          reference: payment.reference,
        },
        refunded: order.status === 'REFUNDED',
      };
    });
  }

  // ---------------------------------------------------------------------------------------------

  private async requireOrderAccess(
    tx: TenantTx,
    actor: TenantActor,
    orderId: string,
    options: { adminToo: boolean },
  ) {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    const allowed =
      order !== null &&
      (order.membershipId === actor.membershipId || (options.adminToo && can(actor, 'admin.access')));
    if (!allowed) throw new AppError('NOT_FOUND');
    return order;
  }

  async view(tx: TenantTx, orderId: string): Promise<OrderView> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { include: { course: { select: { slug: true } } } },
        receipt: { select: { number: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const account = await activeAccount(tx);
    const settings = await readCommerceSettings(tx);
    const offered = offeredMethods(settings.enabledPaymentMethods, account?.capabilities ?? null);
    const payment = order.payments[0];
    const payable = isOrderPayable(order, new Date());
    return {
      id: order.id,
      status: order.status,
      expiresAt: order.expiresAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
      total: { amountMinor: Number(order.totalMinor), currency: order.currency },
      items: order.items.map((item) => ({
        courseId: item.courseId,
        courseSlug: item.course.slug,
        title: item.titleSnapshot,
        instructorName: item.instructorNameSnapshot,
        accessDays: item.accessDays,
        unitPrice: { amountMinor: Number(item.unitPriceMinor), currency: item.currency },
        part: item.part,
      })),
      payment:
        payment === undefined
          ? null
          : {
              id: payment.id,
              method: payment.method,
              network: payment.network,
              maskedMsisdn: payment.msisdnMasked,
              status: payment.status,
              failureCode: (payment.failureCode as PaymentFailureCode | null) ?? null,
              createdAt: payment.createdAt.toISOString(),
              simulatedPhone:
                payment.method === 'MOBILE_MONEY' &&
                (this.gateway.provider(payment.provider)?.simulated ?? false),
            },
      receiptNumber: order.receipt?.number ?? null,
      methods: payable ? offered.methods : [],
      networks: payable ? offered.networks : [],
      allowedActions: payable ? ['pay', 'cancel'] : [],
    };
  }
}

/** The school's active payment account with its capabilities (BR-54), or null. */
export async function activeAccount(tx: TenantTx) {
  const account = await tx.paymentAccount.findFirst({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      provider: true,
      capabilities: true,
      credentialsEnc: true,
      webhookSecretEnc: true,
      dataKeyEnc: true,
    },
  });
  return account === null
    ? null
    : { ...account, capabilities: account.capabilities as unknown as PaymentCapabilities | null };
}
