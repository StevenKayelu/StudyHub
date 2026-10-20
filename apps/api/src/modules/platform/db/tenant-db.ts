import { Injectable } from '@nestjs/common';

import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { currentContext, requireTenantId, runWithContext } from '../context/request-context';
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
export async function runInTenantTx<T>(
  prisma: PrismaClient,
  fn: (tx: TenantTx) => Promise<T>,
  options: { userId?: string } = {},
): Promise<T> {
  const tenantId = requireTenantId();
  if (!UUID.test(tenantId)) {
    throw new AppError('TENANT_CONTEXT_MISSING', { detail: 'Tenant context is malformed.' });
  }
  // The signed-in account (or, while registering, the account being created) for the identity RLS
  // policies. Still ONE statement, so the D5 budget (exactly one extra statement) holds.
  const userId = options.userId ?? currentContext()?.userId ?? '';
  if (userId !== '' && !UUID.test(userId)) {
    throw new AppError('TENANT_CONTEXT_MISSING', { detail: 'User context is malformed.' });
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}

/**
 * Runs `fn` in ONE transaction of the platform (console) realm: `app.realm = 'platform'` makes the
 * platform_* tables visible, and no tenant context is set, so every school-owned table stays empty.
 */
export async function runInPlatformTx<T>(prisma: PrismaClient, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.realm', 'platform', true)`;
    return fn(tx);
  });
}

/**
 * A console transaction that also enters ONE school's context (M9, design §1): used only for console
 * actions that must write inside that school (provisioning, owner invitations, lifecycle emails,
 * statement totals). Callers return ids, counts and sums, never the school's personal data.
 */
export async function runInPlatformTenantTx<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new AppError('TENANT_CONTEXT_MISSING', { detail: 'Tenant context is malformed.' });
  }
  // The school also enters the request context, so helpers that read it (outbox rows, emails, audit)
  // write for this school; the caller's own context is untouched outside.
  const context = { ...(currentContext() ?? { requestId: 'console' }), tenantId };
  return runWithContext(context, () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.realm', 'platform', true), set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }),
  );
}

export interface TenantLifecycle {
  /** DELETED, or OFFBOARDING past (or without) its deadline: no new object writers may start. */
  blocked: boolean;
  /** OFFBOARDING and past its deadline: the purge may run once in-flight writers have finished. */
  purgeDue: boolean;
}

/**
 * Locks the school's tenant row (FOR UPDATE) and reads its lifecycle. The purge and every writer of
 * school objects (export requests and claims, media processing) take this one lock, so no new object
 * can appear once the purge has checked for in-flight writers. Returns undefined for an unknown school.
 */
export async function lockTenantLifecycle(
  tx: TenantTx,
  tenantId: string,
): Promise<TenantLifecycle | undefined> {
  const [row] = await tx.$queryRaw<TenantLifecycle[]>`
    SELECT (status = 'DELETED' OR (status = 'OFFBOARDING' AND
            (delete_after IS NULL OR delete_after <= clock_timestamp()))) AS blocked,
           (status = 'OFFBOARDING' AND delete_after IS NOT NULL
            AND delete_after <= clock_timestamp()) AS "purgeDue"
      FROM tenant WHERE id = ${tenantId}::uuid FOR UPDATE`;
  return row;
}

/** Nest-injectable access to tenant-scoped transactions. */
@Injectable()
export class TenantDb {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runInTenantTx(this.prisma, fn);
  }

  /** As run(), acting as a specific account (sign-in, registration, token redemption). */
  runAs<T>(userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runInTenantTx(this.prisma, fn, { userId });
  }

  /** A console-realm transaction (platform tables only). */
  runPlatform<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runInPlatformTx(this.prisma, fn);
  }

  /** A console transaction inside one school (see runInPlatformTenantTx). */
  runPlatformIn<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runInPlatformTenantTx(this.prisma, tenantId, fn);
  }
}
