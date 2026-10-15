import type { TenantTx } from '../../platform';
import { readFeatures } from '../../tenancy';

/**
 * Why a paid course can't be published or sold yet, or null (BR-04, BR-54): paid courses must be on,
 * the school needs an ACTIVE payment account and, with revenue share, the instructor a payout method.
 */
export async function paymentsProblem(tx: TenantTx, ownerMembershipId: string): Promise<string | null> {
  const features = await readFeatures(tx);
  if (!features.paidCourses) return 'Paid courses are switched off at this school';
  const account = await tx.paymentAccount.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } });
  if (account === null) return 'The school has no active payment account yet';
  if (features.instructorRevenueShare) {
    const method = await tx.payoutMethod.findFirst({
      where: { membershipId: ownerMembershipId, isDefault: true },
      select: { id: true },
    });
    if (method === null) return 'Add a payout method to sell this course';
  }
  return null;
}
