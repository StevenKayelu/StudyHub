import { Injectable } from '@nestjs/common';
import type { TenantBootstrap } from '@studyhub/contracts';

import { PrismaService, type TenantTx } from '../../platform';
import type { ResolvedTenant, ResolvedTenantStatus, TenantLookup } from '../application/tenant-resolver';

interface ResolveRow {
  tenant_id: string;
  status: ResolvedTenantStatus;
  primary_host: string | null;
}

@Injectable()
export class TenantRepository implements TenantLookup {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Host lookup through the SECURITY DEFINER function resolve_tenant() (inventory, 04 §17.4).
   * The runtime role has no access to tenant_domain itself.
   */
  async lookup(host: string): Promise<ResolvedTenant | null> {
    const rows = await this.prisma.$queryRaw<ResolveRow[]>`
      SELECT tenant_id, status::text AS status, primary_host FROM resolve_tenant(${host})`;
    const row = rows[0];
    return row === undefined
      ? null
      : { tenantId: row.tenant_id, status: row.status, primaryHost: row.primary_host };
  }

  /** The current school, read under RLS (policy tenant_self) inside a tenant transaction. */
  findBootstrap(tx: TenantTx, tenantId: string): Promise<TenantBootstrap | null> {
    return tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, status: true },
    });
  }
}
