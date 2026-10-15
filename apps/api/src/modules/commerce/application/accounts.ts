import type { PaymentCapabilities } from '@studyhub/contracts';

import { AppError, type TenantTx } from '../../platform';

/** A payment's own account (any status: refunds and late events still go through it). */
export async function accountById(tx: TenantTx, accountId: string) {
  const account = await tx.paymentAccount.findUnique({ where: { id: accountId } });
  if (account === null) throw new AppError('NOT_FOUND');
  return { ...account, capabilities: account.capabilities as unknown as PaymentCapabilities | null };
}
