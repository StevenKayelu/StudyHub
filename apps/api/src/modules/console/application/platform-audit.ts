import { currentContext, type TenantTx } from '../../platform';

export interface PlatformAuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  /** The school the action concerns (F49), if any. */
  tenantRef?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Writes the platform audit log (F49) in the caller's console transaction. Append-only for the runtime role. */
export async function recordPlatform(tx: TenantTx, entry: PlatformAuditEntry): Promise<void> {
  await tx.platformAuditLog.create({
    data: {
      actorId: entry.actorId,
      tenantRef: entry.tenantRef ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      requestId: currentContext()?.requestId ?? null,
      ...(entry.before !== undefined && { before: entry.before as object }),
      ...(entry.after !== undefined && { after: entry.after as object }),
    },
  });
}

/**
 * The same event in the school's own log, so its owners see what the platform did (lifecycle, plan,
 * overrides). Only inside a console transaction that has entered that school (runPlatformIn).
 */
export async function recordInSchool(
  tx: TenantTx,
  tenantId: string,
  entry: PlatformAuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      requestId: currentContext()?.requestId ?? null,
      ...(entry.before !== undefined && { before: entry.before as object }),
      ...(entry.after !== undefined && { after: entry.after as object }),
    },
  });
}
