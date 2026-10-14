import { requireTenantId, type TenantTx } from '../../platform';

/** Moves bytes between "reserved" (open slots) and "stored" (READY assets) for the current school. */
export async function adjustUsage(
  tx: TenantTx,
  delta: { reserved?: number; storage?: number },
): Promise<void> {
  const tenantId = requireTenantId();
  const reserved = BigInt(Math.round(delta.reserved ?? 0));
  const storage = BigInt(Math.round(delta.storage ?? 0));
  await tx.$executeRaw`
    INSERT INTO tenant_usage (tenant_id, storage_bytes, reserved_bytes)
    VALUES (${tenantId}::uuid, GREATEST(${storage}, 0), GREATEST(${reserved}, 0))
    ON CONFLICT (tenant_id) DO UPDATE SET
      storage_bytes = GREATEST(tenant_usage.storage_bytes + ${storage}, 0),
      reserved_bytes = GREATEST(tenant_usage.reserved_bytes + ${reserved}, 0),
      updated_at = now()`;
}
