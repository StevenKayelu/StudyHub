import { Injectable } from '@nestjs/common';

import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { requireTenantId } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { PrismaService } from './prisma.service';

/** A Prisma client bound to one transaction whose tenant context is already set. */
export type TenantTx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in ONE database transaction whose first statement sets `app.tenant_id` for the current
 * context. The setting is transaction-local (`is_local = true`), so it can never leak to another
 * request through a pooled connection. Row-level security then limits every statement in `fn` to
 * this tenant's rows. Without a tenant context this throws TENANT_CONTEXT_MISSING before touching
 * the database.
 *
 * Keep external calls (payment, video, email providers) OUTSIDE `fn`.
 */
export async function runInTenantTx<T>(prisma: PrismaClient, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const tenantId = requireTenantId();
  if (!UUID.test(tenantId)) {
    throw new AppError('TENANT_CONTEXT_MISSING', { detail: 'Tenant context is malformed.' });
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Nest-injectable access to tenant-scoped transactions. */
@Injectable()
export class TenantDb {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runInTenantTx(this.prisma, fn);
  }
}
