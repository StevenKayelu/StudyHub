import type { Logger } from 'pino';
import sharp from 'sharp';
import { z } from 'zod';

import type { PrismaClient } from '../../../generated/prisma/client';
import {
  AppError,
  type JobEnvelope,
  lockTenantLifecycle,
  type MalwareScanner,
  matchesDeclaredType,
  requireTenantId,
  runInTenantTx,
  type StorageLocations,
} from '../../platform';
import { adjustUsage } from './usage';

const payloadSchema = z.object({ assetId: z.uuid() });

/** Images get one web-friendly derivative (WebP, at most 1280 px wide). */
const DERIVATIVE_WIDTH = 1280;

export interface ProcessAssetDeps {
  prisma: PrismaClient;
  locations: StorageLocations;
  scanner: MalwareScanner;
}

/**
 * Worker job `media.process` (F11): runs inside the asset's school (envelope tenant). Checks the stored
 * object's size and magic bytes against what was declared, scans it for malware, makes the image
 * derivative, and only then marks it READY. Anything that fails is REJECTED and the object deleted, so
 * an unscanned or infected file is never served (F11 AC 2). Idempotent.
 */
export function createProcessAssetHandler(deps: ProcessAssetDeps) {
  return async (envelope: JobEnvelope, logger: Logger): Promise<{ status: string }> => {
    const tenantId = requireTenantId();
    if (envelope.tenantId !== tenantId) throw new AppError('TENANT_CONTEXT_MISSING');
    const { assetId } = payloadSchema.parse(envelope.payload);
    const asset = await runInTenantTx(deps.prisma, async (tx) => {
      // Serialize claims with purge eligibility (same lock): once offboarding is due, an UPLOADED asset
      // never becomes a writer. An asset already SCANNING may finish or retry; the purge waits for it.
      const tenant = await lockTenantLifecycle(tx, tenantId);
      const found = await tx.asset.findUnique({ where: { id: assetId } });
      if (found === null || (found.status !== 'UPLOADED' && found.status !== 'SCANNING')) return null;
      if (tenant === undefined || (tenant.blocked && found.status !== 'SCANNING')) return null;
      await tx.asset.update({ where: { id: assetId }, data: { status: 'SCANNING', updatedAt: new Date() } });
      return found;
    });
    if (asset === null || asset.storageKey === null) return { status: 'skipped' };
    const storage = await deps.locations.at(asset.storageLocationId, tenantId);
    const key = asset.storageKey;
    const size = Number(asset.sizeBytes);

    const reject = async (reason: string) => {
      await storage.delete(key).catch(() => undefined);
      await runInTenantTx(deps.prisma, async (tx) => {
        // Only while this worker still holds the claim (a purge may have retired it).
        const claimed = await tx.asset.updateMany({
          where: { id: assetId, status: 'SCANNING' },
          data: { status: 'REJECTED', rejectReason: reason, updatedAt: new Date() },
        });
        if (claimed.count > 0) await adjustUsage(tx, { reserved: -size });
      });
      logger.warn({ assetId, reason }, 'Upload rejected');
      return { status: 'REJECTED' };
    };

    const head = await storage.head(key);
    if (head === null) return reject('The file never arrived. Upload it again.');
    if (head.size !== size) return reject('The file size does not match what was declared.');
    if (!matchesDeclaredType(asset.mime, await storage.readStart(key, 64))) {
      return reject('The file content does not match its type.');
    }
    const verdict = await deps.scanner.scan(await storage.stream(key));
    if (!verdict.clean) return reject('The file failed the malware check.');

    let width: number | null = null;
    let height: number | null = null;
    let derivativeKey: string | null = null;
    if (asset.kind === 'IMAGE') {
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.stream(key)) chunks.push(Buffer.from(chunk as Buffer));
      const original = Buffer.concat(chunks);
      try {
        const meta = await sharp(original).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
        const derivative = await sharp(original)
          .rotate()
          .resize({ width: DERIVATIVE_WIDTH, withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer();
        derivativeKey = `${key}.webp`;
        await storage.put(derivativeKey, derivative, 'image/webp');
      } catch {
        return reject('The image could not be read.');
      }
    }

    const finished = await runInTenantTx(deps.prisma, async (tx) => {
      // Only while this worker still holds the claim: a purge retires scans abandoned for a day.
      const claimed = await tx.asset.updateMany({
        where: { id: assetId, status: 'SCANNING' },
        data: { status: 'READY', width, height, derivativeKey, updatedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      await adjustUsage(tx, { reserved: -size, storage: size });
      return true;
    });
    if (!finished) {
      // Retired while this worker was stalled: leave nothing behind in a school being purged.
      if (derivativeKey !== null) await storage.delete(derivativeKey).catch(() => undefined);
      logger.warn({ assetId }, 'Upload processing finished after its claim was retired; output removed');
      return { status: 'abandoned' };
    }
    logger.info({ assetId, scanner: deps.scanner.name }, 'Upload ready');
    return { status: 'READY' };
  };
}
