import { Inject, Injectable } from '@nestjs/common';
import type { ExportView } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import type { TenantActor } from '../../identity';
import {
  AppError,
  lockTenantLifecycle,
  STORAGE_LOCATIONS,
  type StorageLocations,
  requireTenantId,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { readFeatures } from '../../tenancy';
import { queueExport, type ReportExportType } from './exports';
import { requireAdmin, requireMember, requireOwner } from './guards';

type ExportRow = {
  id: string;
  type: ExportView['type'];
  status: ExportView['status'];
  params: unknown;
  rowCount: number | null;
  sizeBytes: bigint | null;
  storageKey: string | null;
  storageLocationId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
};

/** Report exports (F32) and the owner's full export (F46), both produced by the worker. */
@Injectable()
export class ExportsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    @Inject(STORAGE_LOCATIONS) private readonly locations: StorageLocations,
  ) {}

  async createReport(
    actor: TenantActor,
    input: { type: ReportExportType; from: string; to: string },
  ): Promise<{ id: string }> {
    requireAdmin(actor);
    requireMember(actor);
    return this.create(actor, input.type, { from: input.from, to: input.to });
  }

  /** F46: owners only; allowed during the offboarding window (BR-53). */
  async createFull(actor: TenantActor): Promise<{ id: string }> {
    requireOwner(actor);
    const enabled = await this.db.run(async (tx) => (await readFeatures(tx)).dataExport);
    if (!enabled) throw new AppError('FEATURE_NOT_ENABLED', { extensions: { feature: 'dataExport' } });
    return this.create(actor, 'TENANT_FULL', {});
  }

  async list(actor: TenantActor): Promise<{ exports: ExportView[] }> {
    requireAdmin(actor);
    const rows = await this.db.run((tx) =>
      tx.dataExport.findMany({
        where:
          actor.roles.includes('TENANT_OWNER') && actor.support === undefined
            ? {}
            : { type: { not: 'TENANT_FULL' } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
    return { exports: await Promise.all(rows.map((row) => this.view(row, false))) };
  }

  async get(actor: TenantActor, id: string): Promise<ExportView> {
    requireAdmin(actor);
    const row = await this.db.run((tx) => tx.dataExport.findFirst({ where: { id } }));
    if (row === null) throw new AppError('NOT_FOUND');
    // The full export holds every member's data: owners only (and never a support session).
    if (row.type === 'TENANT_FULL') requireOwner(actor);
    return this.view(row, true);
  }

  private async create(actor: TenantActor, type: ExportView['type'], params: Record<string, string>) {
    return this.db.run(async (tx: TenantTx) => {
      const tenantId = requireTenantId();
      // The purge worker takes this same row lock before checking for in-flight exports. Once the
      // grace period ends, no new export may enter the queue while retained objects are cleaned.
      const tenant = await lockTenantLifecycle(tx, tenantId);
      if (tenant === undefined) throw new AppError('NOT_FOUND');
      if (tenant.blocked) throw new AppError('SCHOOL_READ_ONLY');
      const { locationId } = await this.locations.active(tx, tenantId);
      const created = await tx.dataExport.create({
        data: { tenantId, type, params, storageLocationId: locationId, requestedBy: actor.membershipId },
        select: { id: true },
      });
      await queueExport(tx, created.id);
      await this.audit.record(tx, {
        action: type === 'TENANT_FULL' ? 'export.tenant_requested' : 'export.requested',
        entityType: 'data_export',
        entityId: created.id,
        actorId: actor.userId,
        after: { type, ...params },
      });
      return created;
    });
  }

  private async view(row: ExportRow, withLink: boolean): Promise<ExportView> {
    const expired = row.expiresAt !== null && row.expiresAt.getTime() < Date.now();
    const status = expired ? 'EXPIRED' : row.status;
    const params = (row.params ?? {}) as { from?: string; to?: string };
    const downloadUrl =
      withLink && status === 'READY' && row.storageKey !== null
        ? await (
            await this.locations.at(row.storageLocationId, requireTenantId())
          ).presignGet(row.storageKey, {
            expiresSeconds: 300,
            downloadName: `${row.type.toLowerCase()}-${row.createdAt.toISOString().slice(0, 10)}.${row.type === 'TENANT_FULL' ? 'zip' : 'csv'}`,
          })
        : null;
    return {
      id: row.id,
      type: row.type,
      status,
      params: {
        ...(params.from !== undefined && { from: params.from }),
        ...(params.to !== undefined && { to: params.to }),
      },
      rowCount: row.rowCount,
      sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      downloadUrl,
    };
  }
}
