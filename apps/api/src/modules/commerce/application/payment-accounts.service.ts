import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { PaymentAccountView, PaymentCapabilities } from '@studyhub/contracts';

import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../infra/payment-gateway';

const TEST_OK = 'OK';

interface AccountRow {
  id: string;
  provider: string;
  label: string;
  status: PaymentAccountView['status'];
  maskedHint: string;
  capabilities: unknown;
  lastTestedAt: Date | null;
  lastTestResult: string | null;
  createdAt: Date;
}

const VIEW_FIELDS = {
  id: true,
  provider: true,
  label: true,
  status: true,
  maskedHint: true,
  capabilities: true,
  lastTestedAt: true,
  lastTestResult: true,
  createdAt: true,
} as const;

/**
 * School payment accounts (F45, S-AD15; 05 §8.3). Owners only, except reading capabilities. Credentials
 * are write-only: no response ever contains them, only a masked hint (F45 AC 3, 07 M8 AC 4). An account
 * must pass a connection test before it can be activated; one account is active at a time.
 */
@Injectable()
export class PaymentAccountsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly audit: AuditService,
  ) {}

  /** Providers this deployment can connect (only the fake until one is approved, Q-PAY-3). */
  providers(actor: TenantActor): { providers: string[] } {
    requireOwner(actor);
    return { providers: this.gateway.names() };
  }

  async list(actor: TenantActor): Promise<{ accounts: PaymentAccountView[] }> {
    requireOwner(actor);
    return this.db.run(async (tx) => {
      const rows = await tx.paymentAccount.findMany({ orderBy: { createdAt: 'desc' }, select: VIEW_FIELDS });
      return { accounts: rows.map(view) };
    });
  }

  async create(
    actor: TenantActor,
    input: { provider: string; label: string; credentials: Record<string, unknown> },
  ): Promise<PaymentAccountView> {
    requireOwner(actor);
    const provider = this.gateway.provider(input.provider);
    if (provider === null) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'provider', code: 'unknown', message: 'This provider is not available.' }],
      });
    }
    const parsed = provider.parseCredentials(input.credentials);
    if (!parsed.ok) {
      throw new AppError('VALIDATION_FAILED', {
        errors: parsed.errors.map((e) => ({ field: e.field, code: 'invalid', message: e.message })),
      });
    }
    return this.db.run(async (tx) => {
      const tenantId = requireTenantId();
      const id = randomUUID();
      const sealed = this.gateway.vault.sealAccount(
        tenantId,
        id,
        parsed.value.credentials,
        parsed.value.webhookSecret,
      );
      const row = await tx.paymentAccount.create({
        data: {
          id,
          tenantId,
          provider: input.provider,
          label: input.label,
          maskedHint: parsed.value.maskedHint,
          createdBy: actor.membershipId,
          ...sealed,
        },
        select: VIEW_FIELDS,
      });
      await this.audit.record(tx, {
        action: 'payment_account.created',
        entityType: 'payment_account',
        entityId: id,
        actorId: actor.userId,
        after: { provider: input.provider, label: input.label, maskedHint: parsed.value.maskedHint },
      });
      return view(row);
    });
  }

  /** New credentials replace the old ones (never shown); the account must be tested and activated again. */
  async replaceCredentials(
    actor: TenantActor,
    id: string,
    credentials: Record<string, unknown>,
  ): Promise<PaymentAccountView> {
    requireOwner(actor);
    return this.db.run(async (tx) => {
      const account = await findAccount(tx, id);
      const parsed = this.gateway.requireProvider(account.provider).parseCredentials(credentials);
      if (!parsed.ok) {
        throw new AppError('VALIDATION_FAILED', {
          errors: parsed.errors.map((e) => ({ field: e.field, code: 'invalid', message: e.message })),
        });
      }
      const sealed = this.gateway.vault.sealAccount(
        requireTenantId(),
        id,
        parsed.value.credentials,
        parsed.value.webhookSecret,
      );
      const row = await tx.paymentAccount.update({
        where: { id },
        data: {
          ...sealed,
          maskedHint: parsed.value.maskedHint,
          status: 'PENDING',
          capabilities: Prisma.DbNull,
          lastTestResult: null,
          lastTestedAt: null,
          updatedAt: new Date(),
          version: { increment: 1 },
        },
        select: VIEW_FIELDS,
      });
      await this.audit.record(tx, {
        action: 'payment_account.credentials_replaced',
        entityType: 'payment_account',
        entityId: id,
        actorId: actor.userId,
        before: { status: account.status },
        after: { status: 'PENDING', maskedHint: parsed.value.maskedHint },
      });
      return view(row);
    });
  }

  /** F45: a sandbox call that records the result and the detected capabilities (BR-62). */
  async test(actor: TenantActor, id: string): Promise<PaymentAccountView> {
    requireOwner(actor);
    const account = await this.db.run((tx) => findAccount(tx, id));
    const provider = this.gateway.requireProvider(account.provider);
    let result: { ok: true; capabilities: PaymentCapabilities } | { ok: false; message: string };
    try {
      result = await provider.testConnection(this.gateway.open(requireTenantId(), account));
    } catch {
      result = { ok: false, message: 'The provider could not be reached. Try again in a few minutes.' };
    }
    return this.db.run(async (tx) => {
      const now = new Date();
      const keepActive = account.status === 'ACTIVE';
      const row = await tx.paymentAccount.update({
        where: { id },
        data: result.ok
          ? {
              capabilities: result.capabilities as object,
              lastTestedAt: now,
              lastTestResult: TEST_OK,
              ...(account.status === 'FAILED_TEST' && { status: 'PENDING' }),
              updatedAt: now,
            }
          : {
              lastTestedAt: now,
              lastTestResult: result.message.slice(0, 300),
              ...(!keepActive && { status: 'FAILED_TEST' }),
              updatedAt: now,
            },
        select: VIEW_FIELDS,
      });
      await this.audit.record(tx, {
        action: 'payment_account.tested',
        entityType: 'payment_account',
        entityId: id,
        actorId: actor.userId,
        after: { ok: result.ok },
      });
      return view(row);
    });
  }

  /** Activate a tested account; the previously active one (if any) is disabled in the same transaction. */
  async activate(actor: TenantActor, id: string): Promise<PaymentAccountView> {
    requireOwner(actor);
    return this.db.run(async (tx) => {
      const account = await findAccount(tx, id);
      if (account.status === 'ACTIVE')
        return view(await tx.paymentAccount.findUniqueOrThrow({ where: { id }, select: VIEW_FIELDS }));
      if (account.lastTestResult !== TEST_OK || account.capabilities === null) {
        throw new AppError('INVALID_STATE', {
          detail: 'Test the connection successfully before activating.',
        });
      }
      const previous = await tx.paymentAccount.findFirst({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });
      if (previous !== null) {
        await tx.paymentAccount.update({
          where: { id: previous.id },
          data: { status: 'DISABLED', updatedAt: new Date(), version: { increment: 1 } },
        });
      }
      const row = await tx.paymentAccount.update({
        where: { id },
        data: { status: 'ACTIVE', updatedAt: new Date(), version: { increment: 1 } },
        select: VIEW_FIELDS,
      });
      await this.audit.record(tx, {
        action: 'payment_account.activated',
        entityType: 'payment_account',
        entityId: id,
        actorId: actor.userId,
        after: { previousActiveId: previous?.id ?? null },
      });
      return view(row);
    });
  }

  /** DELETE: disables (records stay; late webhooks for its payments are still processed). */
  async disable(actor: TenantActor, id: string): Promise<PaymentAccountView> {
    requireOwner(actor);
    return this.db.run(async (tx) => {
      const account = await findAccount(tx, id);
      const row = await tx.paymentAccount.update({
        where: { id },
        data: { status: 'DISABLED', updatedAt: new Date(), version: { increment: 1 } },
        select: VIEW_FIELDS,
      });
      await this.audit.record(tx, {
        action: 'payment_account.disabled',
        entityType: 'payment_account',
        entityId: id,
        actorId: actor.userId,
        before: { status: account.status },
        after: { status: 'DISABLED' },
      });
      return view(row);
    });
  }

  /** GET …/capabilities: administrators may read what the account supports (for the settings form). */
  async capabilities(actor: TenantActor, id: string): Promise<{ capabilities: PaymentCapabilities | null }> {
    if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
    return this.db.run(async (tx) => {
      const account = await findAccount(tx, id);
      return { capabilities: account.capabilities as PaymentCapabilities | null };
    });
  }
}

function requireOwner(actor: TenantActor): void {
  // Payment accounts are the owner's (05 §8.3); support access never reaches them (BR-47).
  if (!actor.roles.includes('TENANT_OWNER')) throw new AppError('FORBIDDEN');
}

async function findAccount(tx: TenantTx, id: string) {
  const account = await tx.paymentAccount.findUnique({ where: { id } });
  if (account === null) throw new AppError('NOT_FOUND');
  return account;
}

function view(row: AccountRow): PaymentAccountView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    maskedHint: row.maskedHint,
    capabilities: (row.capabilities as PaymentCapabilities | null) ?? null,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestResult: row.lastTestResult,
    webhookPath: `/api/v1/webhooks/payments/${row.provider}/${row.id}`,
    createdAt: row.createdAt.toISOString(),
  };
}
