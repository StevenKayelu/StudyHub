import type { Logger } from 'pino';
import { z } from 'zod';

import type { PrismaClient } from '../../../generated/prisma/client';
import {
  type JobEnvelope,
  queueEmail,
  requireTenantId,
  runInPlatformTenantTx,
  type SecretBox,
  type TenantTx,
} from '../../platform';
import { ownerContacts } from '../../tenancy';
import { formatMinor } from '../domain/money';

/** What a billing email to a school's owners is about (template `saas-invoice`). */
export type BillingNotice =
  'ISSUED' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'PAID' | 'SETUP_PAID' | 'SUSPENDED' | 'REACTIVATED';

const date = (value: Date) => value.toISOString().slice(0, 10);

/** Emails (and notifies) every owner of the school, in the caller's transaction. */
export async function notifyOwners(
  tx: TenantTx,
  box: SecretBox,
  tenantId: string,
  status: BillingNotice,
  invoice: { number: string | null; amountMinor: bigint; currency: string; dueAt: Date | null },
): Promise<void> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  for (const owner of await ownerContacts(tx)) {
    await queueEmail(tx, box, {
      template: 'saas-invoice',
      to: owner.email,
      vars: {
        schoolName: tenant?.name ?? '',
        displayName: owner.displayName,
        status,
        number: invoice.number ?? '',
        amount: formatMinor(invoice.amountMinor, invoice.currency),
        ...(invoice.dueAt !== null && { dueDate: date(invoice.dueAt) }),
      },
    });
  }
}

const payloadSchema = z.object({ invoiceId: z.uuid(), kind: z.enum(['DUE_SOON', 'DUE_TODAY', 'OVERDUE']) });

/**
 * Worker job `billing.notice`: a scheduled reminder for one invoice. Sent only if the invoice is still
 * issued and unpaid when it comes due, so a paid or voided invoice is never chased.
 */
export function createBillingNoticeHandler(deps: { prisma: PrismaClient; box: SecretBox }) {
  return async (envelope: JobEnvelope, logger: Logger): Promise<{ sent: boolean }> => {
    const { invoiceId, kind } = payloadSchema.parse(envelope.payload);
    const tenantId = requireTenantId();
    const sent = await runInPlatformTenantTx(deps.prisma, tenantId, async (tx) => {
      const invoice = await tx.saasInvoice.findFirst({
        where: { id: invoiceId, tenantRef: tenantId },
        select: {
          status: true,
          number: true,
          totalMinor: true,
          amountPaidMinor: true,
          currency: true,
          dueAt: true,
        },
      });
      if (invoice === null || invoice.status !== 'ISSUED') return false;
      await notifyOwners(tx, deps.box, tenantId, kind, {
        number: invoice.number,
        amountMinor: invoice.totalMinor - invoice.amountPaidMinor,
        currency: invoice.currency,
        dueAt: invoice.dueAt,
      });
      return true;
    });
    logger.info({ invoiceId, kind, sent }, 'Billing reminder');
    return { sent };
  };
}
