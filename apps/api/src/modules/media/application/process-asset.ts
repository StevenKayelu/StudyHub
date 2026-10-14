import type { Logger } from 'pino';
import sharp from 'sharp';
import { z } from 'zod';

import type { PrismaClient } from '../../../generated/prisma/client';
import {
  type JobEnvelope,
  type MalwareScanner,
  matchesDeclaredType,
  type ObjectStorage,
  runInTenantTx,
} from '../../platform';
import { adjustUsage } from './usage';

const payloadSchema = z.object({ assetId: z.uuid() });

/** Images get one web-friendly derivative (WebP, at most 1280 px wide). */
const DERIVATIVE_WIDTH = 1280;

export interface ProcessAssetDeps {
  prisma: PrismaClient;
  storage: ObjectStorage;
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
    const { assetId } = payloadSchema.parse(envelope.payload);
    const asset = await runInTenantTx(deps.prisma, async (tx) => {
      const found = await tx.asset.findUnique({ where: { id: assetId } });
      if (found === null || (found.status !== 'UPLOADED' && found.status !== 'SCANNING')) return null;
      await tx.asset.update({ where: { id: assetId }, data: { status: 'SCANNING', updatedAt: new Date() } });
      return found;
    });
    if (asset === null || asset.storageKey === null) return { status: 'skipped' };
    const key = asset.storageKey;
    const size = Number(asset.sizeBytes);

    const reject = async (reason: string) => {
      await deps.storage.delete(key).catch(() => undefined);
      await runInTenantTx(deps.prisma, async (tx) => {
        await tx.asset.update({
          where: { id: assetId },
          data: { status: 'REJECTED', rejectReason: reason, updatedAt: new Date() },
        });
        await adjustUsage(tx, { reserved: -size });
      });
      logger.warn({ assetId, reason }, 'Upload rejected');
      return { status: 'REJECTED' };
    };

    const head = await deps.storage.head(key);
    if (head === null) return reject('The file never arrived. Upload it again.');
    if (head.size !== size) return reject('The file size does not match what was declared.');
    if (!matchesDeclaredType(asset.mime, await deps.storage.readStart(key, 64))) {
      return reject('The file content does not match its type.');
    }
    const verdict = await deps.scanner.scan(await deps.storage.stream(key));
    if (!verdict.clean) return reject('The file failed the malware check.');

    let width: number | null = null;
    let height: number | null = null;
    let derivativeKey: string | null = null;
    if (asset.kind === 'IMAGE') {
      const chunks: Buffer[] = [];
      for await (const chunk of await deps.storage.stream(key)) chunks.push(Buffer.from(chunk as Buffer));
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
        await deps.storage.put(derivativeKey, derivative, 'image/webp');
      } catch {
        return reject('The image could not be read.');
      }
    }

    await runInTenantTx(deps.prisma, async (tx) => {
      await tx.asset.update({
        where: { id: assetId },
        data: { status: 'READY', width, height, derivativeKey, updatedAt: new Date() },
      });
      await adjustUsage(tx, { reserved: -size, storage: size });
    });
    logger.info({ assetId, scanner: deps.scanner.name }, 'Upload ready');
    return { status: 'READY' };
  };
}
