import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { z } from 'zod';

import type { PrismaClient } from '../../../generated/prisma/client';
import {
  currentContext,
  matchesDeclaredType,
  type MalwareScanner,
  type RecoveryObjectVersion,
  runInPlatformTenantTx,
  type TenantTx,
  type VersionRecoveryStorage,
} from '../../platform';
import { recoveryDigest, requireRecoveryOwner } from './school-recovery';

const SCOPE = 'existing-document-object-v1';
const MAX_BYTES = 25 * 1024 * 1024;
interface Target extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  storage_key: string;
  derivative_key: string | null;
  kind: string;
  status: string;
  mime: string;
  size_bytes: number;
  storage_location_id: string | null;
}
export interface DocumentRecoveryPlan {
  scope: typeof SCOPE;
  tenantId: string;
  assetId: string;
  sourceKey: string;
  version: RecoveryObjectVersion;
  reviewDigest: string;
}

async function target(
  tx: TenantTx,
  tenantId: string,
  assetId: string,
  locationId: string,
): Promise<{ row: Target; actorId: string }> {
  const actorId = await requireRecoveryOwner(tx);
  const rows = await tx.$queryRaw<Array<{ data: Target }>>`
    SELECT to_jsonb(a) AS data FROM asset a WHERE tenant_id=${tenantId}::uuid AND id=${assetId}::uuid FOR UPDATE`;
  const row = rows[0]?.data;
  if (
    !row ||
    row.kind !== 'DOCUMENT' ||
    row.status !== 'READY' ||
    !row.storage_key ||
    row.derivative_key ||
    !row.storage_key.startsWith(`t/${tenantId}/`) ||
    !Number.isSafeInteger(row.size_bytes) ||
    row.size_bytes < 1 ||
    row.size_bytes > MAX_BYTES
  ) {
    throw new Error('Recovery requires an existing ready school document without derivatives, at most 25 MB');
  }
  // The recovery storage must be the document's recorded location, or the restored key would point
  // into a bucket the document isn't read from.
  if (row.storage_location_id !== locationId)
    throw new Error('Recovery storage is not the storage location recorded for this document');
  return { row, actorId };
}
function stamp(tenantId: string, row: Target, actorId: string, version: RecoveryObjectVersion): string {
  return recoveryDigest({ scope: SCOPE, tenantId, row, actorId, version });
}

export async function planDocumentObjectRecovery(
  prisma: PrismaClient,
  storage: VersionRecoveryStorage,
  tenantId: string,
  assetId: string,
  versionId: string,
): Promise<DocumentRecoveryPlan> {
  z.uuid().parse(tenantId);
  z.uuid().parse(assetId);
  const { row, actorId } = await runInPlatformTenantTx(prisma, tenantId, (tx) =>
    target(tx, tenantId, assetId, storage.locationId),
  );
  // All provider I/O is outside database transactions. Storage must positively identify immutable
  // history; no fallback to latest bytes when the requested version/backup cannot be identified.
  const version = await storage.inspect(tenantId, row.storage_key, versionId);
  if (version.size !== row.size_bytes || version.contentType !== row.mime)
    throw new Error('Recovery version size/type differs; quota-changing restores are outside this scope');
  return {
    scope: SCOPE,
    tenantId,
    assetId,
    sourceKey: row.storage_key,
    version,
    reviewDigest: stamp(tenantId, row, actorId, version),
  };
}

export async function applyDocumentObjectRecovery(
  prisma: PrismaClient,
  storage: VersionRecoveryStorage,
  scanner: MalwareScanner,
  tenantId: string,
  assetId: string,
  versionId: string,
  review: { digest: string; reason: string; ownerReviewReference: string },
): Promise<{ storageKey: string; checksumSha256: string }> {
  const approval = z
    .object({
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(10).max(500),
      ownerReviewReference: z.string().trim().min(3).max(200),
    })
    .parse(review);
  const plan = await planDocumentObjectRecovery(prisma, storage, tenantId, assetId, versionId);
  if (plan.reviewDigest !== approval.digest)
    throw new Error('Object recovery review is stale or substituted');
  const bytes = await storage.read(tenantId, plan.sourceKey, plan.version, MAX_BYTES);
  if (
    bytes.length !== plan.version.size ||
    !matchesDeclaredType(plan.version.contentType, bytes.subarray(0, 64))
  )
    throw new Error('Recovery bytes do not match the reviewed document type/size');
  if (!(await scanner.scan(Readable.from([bytes]))).clean)
    throw new Error('Recovery document failed malware scanning');
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  // Stage to a fresh school-owned key. Never overwrite/delete any live key or historical version.
  // If the DB commit fails, retain the unreferenced candidate for reviewed cleanup, not deletion.
  const storageKey = await storage.stage(tenantId, bytes, plan.version.contentType);
  if (!storageKey.startsWith(`t/${tenantId}/recovery/`) || storageKey === plan.sourceKey)
    throw new Error('Invalid staged recovery key');
  await runInPlatformTenantTx(prisma, tenantId, async (tx) => {
    const { row, actorId } = await target(tx, tenantId, assetId, storage.locationId);
    if (stamp(tenantId, row, actorId, plan.version) !== approval.digest)
      throw new Error('Object recovery target changed while preparing bytes');
    await tx.asset.update({
      where: { id: assetId },
      data: { storageKey, checksumSha256, updatedAt: new Date() },
    });
    const summary = {
      scope: SCOPE,
      assetId,
      sourceKey: plan.sourceKey,
      sourceVersionId: versionId,
      restoredKey: storageKey,
      checksumSha256,
      reviewDigest: approval.digest,
      reason: approval.reason,
      ownerReviewReference: approval.ownerReviewReference,
    };
    await tx.auditLog.create({
      data: {
        tenantId,
        actorId,
        action: 'asset.recovered',
        entityType: 'asset',
        entityId: assetId,
        requestId: currentContext()?.requestId ?? null,
        after: summary,
      },
    });
    await tx.platformAuditLog.create({
      data: {
        actorId,
        tenantRef: tenantId,
        action: 'asset.recovered',
        entityType: 'asset',
        entityId: assetId,
        requestId: currentContext()?.requestId ?? null,
        after: summary,
      },
    });
  });
  return { storageKey, checksumSha256 };
}
