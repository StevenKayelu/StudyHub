import { Injectable } from '@nestjs/common';

import { currentContext, requireTenantId, type TenantTx } from '../../platform';

export interface AuditEntry {
  /** Dotted lower-case verb, e.g. `tenant.created` (CHECK-constrained in the database). */
  action: string;
  entityType: string;
  entityId?: string;
  actorId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/**
 * Writes the tenant audit trail (blueprint F49). Always inside the caller's tenant transaction, so
 * the entry commits or rolls back with the change it describes. The runtime role can only INSERT
 * and SELECT audit rows; it can never update or delete them.
 */
@Injectable()
export class AuditService {
  async record(tx: TenantTx, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: requireTenantId(),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        actorId: entry.actorId ?? null,
        requestId: currentContext()?.requestId ?? null,
        ...(entry.before !== undefined && { before: entry.before as object }),
        ...(entry.after !== undefined && { after: entry.after as object }),
      },
    });
  }
}
