import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from 'pino';

import { can, type TenantActor } from '../../identity';
import {
  APP_LOGGER,
  addToOutbox,
  AppError,
  ConfigService,
  requireTenantId,
  STORAGE_LOCATIONS,
  type StorageLocations,
  TenantDb,
  type TenantTx,
  VIDEO_PROVIDER,
  type VideoEvent,
  type VideoProvider,
} from '../../platform';
import { capUploadSettings, limitOf, readContentSettings, readPlan } from '../../tenancy';
import { type AssetPurpose, cleanFileName, uploadProblem, uploadRule } from '../domain/upload-policy';
import { adjustUsage } from './usage';

/** Queue that verifies, scans and finishes an uploaded file (fed by the outbox). */
export const MEDIA_PROCESS_JOB = 'media.process';

/** Upload slots expire after this long if the browser never finishes (F11). */
const SLOT_TTL_MS = 60 * 60_000;
const PRESIGN_SECONDS = 15 * 60;
const DOWNLOAD_SECONDS = 10 * 60;
/** View-only links (no download) last one minute: enough to open, too short to pass around. */
const VIEW_SECONDS = 60;

export interface UploadSlot {
  assetId: string;
  uploadUrl: string;
  /** Headers the browser must send with its PUT (the URL is signed for them). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface AssetStatusView {
  id: string;
  kind: string;
  purpose: string;
  status: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  rejectReason: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/** Who may upload for which purpose: course media is for instructors; avatars for any member. */
function mayUpload(actor: TenantActor, purpose: AssetPurpose): boolean {
  if (purpose === 'AVATAR') return can(actor, 'learn.access');
  if (purpose === 'BRANDING') return can(actor, 'admin.access');
  return can(actor, 'studio.access');
}

/**
 * Uploads and videos (F11, ADR-008/009). Files go straight from the browser to object storage under
 * t/{tenantId}/; the API only issues presigned URLs and records state. Storage is reserved when a slot
 * is created (BR-49) and settled when the asset is READY or rejected.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly db: TenantDb,
    private readonly config: ConfigService,
    @Inject(STORAGE_LOCATIONS) private readonly locations: StorageLocations,
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider,
    @Optional() @Inject(APP_LOGGER) private readonly logger?: Logger,
  ) {}

  async createUpload(
    actor: TenantActor,
    input: { purpose: AssetPurpose; fileName: string; mime: string; sizeBytes: number },
  ): Promise<UploadSlot> {
    if (input.purpose === 'LESSON_VIDEO') {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'purpose', code: 'use_videos', message: 'Videos are uploaded with POST /videos' }],
      });
    }
    if (!mayUpload(actor, input.purpose)) throw new AppError('FORBIDDEN');
    const tenantId = requireTenantId();
    const { assetId, key, storage } = await this.db.run(async (tx) => {
      const rule = uploadRule(
        input.purpose,
        capUploadSettings(await readContentSettings(tx), (await readPlan(tx)).limits),
      );
      this.assertAllowed(rule, input.mime, input.sizeBytes);
      const location = await this.locations.active(tx, tenantId);
      await this.reserve(tx, input.sizeBytes);
      const asset = await tx.asset.create({
        data: {
          tenantId,
          ownerMembershipId: actor.membershipId,
          kind: rule.kind,
          purpose: input.purpose,
          storageLocationId: location.locationId,
          originalName: cleanFileName(input.fileName),
          mime: input.mime,
          sizeBytes: BigInt(input.sizeBytes),
          expiresAt: new Date(Date.now() + SLOT_TTL_MS),
        },
        select: { id: true },
      });
      const key = `t/${tenantId}/${input.purpose.toLowerCase()}/${asset.id}`;
      await tx.asset.update({ where: { id: asset.id }, data: { storageKey: key } });
      return { assetId: asset.id, key, storage: location.storage };
    });
    const uploadUrl = await storage.presignPut(key, {
      contentType: input.mime,
      contentLength: input.sizeBytes,
      expiresSeconds: PRESIGN_SECONDS,
    });
    return {
      assetId,
      uploadUrl,
      headers: { 'content-type': input.mime },
      expiresAt: new Date(Date.now() + PRESIGN_SECONDS * 1000).toISOString(),
    };
  }

  /** The browser finished its PUT: queue verification and scanning. Idempotent. */
  async completeUpload(actor: TenantActor, assetId: string): Promise<AssetStatusView> {
    return this.db.run(async (tx) => {
      const asset = await this.ownAsset(tx, actor, assetId);
      if (asset.status === 'PENDING_UPLOAD') {
        await tx.asset.update({
          where: { id: assetId },
          data: { status: 'UPLOADED', expiresAt: null, updatedAt: new Date() },
        });
        await addToOutbox(tx, MEDIA_PROCESS_JOB, { assetId });
      }
      return this.view(await tx.asset.findUniqueOrThrow({ where: { id: assetId } }));
    });
  }

  /** A video slot at the provider (direct upload); finished by the provider's webhook. */
  async createVideo(
    actor: TenantActor,
    input: { fileName: string; mime: string; sizeBytes: number },
  ): Promise<UploadSlot> {
    if (!mayUpload(actor, 'LESSON_VIDEO')) throw new AppError('FORBIDDEN');
    const tenantId = requireTenantId();
    return this.db.run(async (tx) => {
      const rule = uploadRule(
        'LESSON_VIDEO',
        capUploadSettings(await readContentSettings(tx), (await readPlan(tx)).limits),
      );
      this.assertAllowed(rule, input.mime, input.sizeBytes);
      await this.reserve(tx, input.sizeBytes);
      const asset = await tx.asset.create({
        data: {
          tenantId,
          ownerMembershipId: actor.membershipId,
          kind: 'VIDEO',
          purpose: 'LESSON_VIDEO',
          provider: this.video.name,
          originalName: cleanFileName(input.fileName),
          mime: input.mime,
          sizeBytes: BigInt(input.sizeBytes),
          expiresAt: new Date(Date.now() + 24 * SLOT_TTL_MS),
        },
        select: { id: true },
      });
      const upload = await this.video.createUpload({
        tenantId,
        assetId: asset.id,
        maxBytes: input.sizeBytes,
      });
      await tx.asset.update({ where: { id: asset.id }, data: { providerVideoId: upload.providerVideoId } });
      return {
        assetId: asset.id,
        uploadUrl: upload.uploadUrl,
        headers: { 'content-type': input.mime },
        expiresAt: new Date(Date.now() + 24 * SLOT_TTL_MS).toISOString(),
      };
    });
  }

  /** Before a development upload can simulate a provider callback, bind it to its issuing member
   * and school. A provider id is a lookup key, not an authorization credential. */
  async authorizeVideoUpload(actor: TenantActor, providerVideoId: string): Promise<void> {
    const tenantId = requireTenantId();
    await this.db.run(async (tx) => {
      const asset = await tx.asset.findFirst({
        where: {
          tenantId,
          ownerMembershipId: actor.membershipId,
          provider: this.video.name,
          providerVideoId,
          kind: 'VIDEO',
          purpose: 'LESSON_VIDEO',
        },
        select: { id: true },
      });
      if (asset === null) throw new AppError('NOT_FOUND');
    });
  }

  async status(actor: TenantActor, assetId: string): Promise<AssetStatusView> {
    return this.db.run(async (tx) => this.view(await this.visibleAsset(tx, actor, assetId)));
  }

  /** A short-lived download URL for a READY file the actor may see (owner or administrator). */
  async downloadUrl(actor: TenantActor, assetId: string): Promise<{ url: string; expiresAt: string }> {
    const asset = await this.db.run((tx) => this.visibleAsset(tx, actor, assetId));
    if (asset.status !== 'READY' || asset.storageKey === null) throw new AppError('INVALID_STATE');
    const storage = await this.locations.at(asset.storageLocationId, requireTenantId());
    const url = await storage.presignGet(asset.storageKey, {
      expiresSeconds: DOWNLOAD_SECONDS,
      downloadName: asset.originalName,
    });
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() };
  }

  // ----------------------------------------------------------------------------------------------
  // Reads for callers that have already decided the viewer may see the asset (the learning module's
  // entitlement checks). Only READY assets of the current school are ever signed.

  /** Short-lived inline URLs (web-sized derivative when there is one) for READY images. */
  async readUrls(
    assetIds: readonly string[],
    options: { expiresSeconds: number } = { expiresSeconds: DOWNLOAD_SECONDS },
  ): Promise<Map<string, string>> {
    if (assetIds.length === 0) return new Map();
    const assets = await this.db.run((tx) =>
      tx.asset.findMany({
        where: { id: { in: [...assetIds] }, status: 'READY' },
        select: { id: true, storageKey: true, derivativeKey: true, storageLocationId: true },
      }),
    );
    // Each image on its own: one that can't be signed (its storage location unavailable) is left out
    // and logged, instead of failing the whole page that lists it (M10 review).
    const signable = assets.filter((a) => (a.derivativeKey ?? a.storageKey) !== null);
    const results = await Promise.allSettled(
      signable.map(async (a) => {
        const storage = await this.locations.at(a.storageLocationId, requireTenantId());
        return [a.id, await storage.presignGet(a.derivativeKey ?? a.storageKey!, options)] as const;
      }),
    );
    const urls = new Map<string, string>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') urls.set(result.value[0], result.value[1]);
      else this.logger?.warn({ assetId: signable[index]!.id }, 'Image left out: its storage is unavailable');
    });
    return urls;
  }

  /** A short-lived download URL for a READY file, named as uploaded. */
  async fileUrl(asset: {
    status: string;
    storageKey: string | null;
    storageLocationId: string | null;
    originalName: string;
  }): Promise<{ url: string; expiresAt: string }> {
    if (asset.status !== 'READY' || asset.storageKey === null) throw new AppError('NOT_FOUND');
    const storage = await this.locations.at(asset.storageLocationId, requireTenantId());
    const url = await storage.presignGet(asset.storageKey, {
      expiresSeconds: DOWNLOAD_SECONDS,
      downloadName: asset.originalName,
    });
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() };
  }

  /**
   * A short-lived URL that opens a READY file in the browser without saving it, for lessons that are
   * stream and view only (docs/design/content-protection.md). Short, so it isn't worth sharing.
   */
  async fileViewUrl(asset: {
    status: string;
    storageKey: string | null;
    storageLocationId: string | null;
  }): Promise<{ url: string; expiresAt: string }> {
    if (asset.status !== 'READY' || asset.storageKey === null) throw new AppError('NOT_FOUND');
    const storage = await this.locations.at(asset.storageLocationId, requireTenantId());
    const url = await storage.presignGet(asset.storageKey, { expiresSeconds: VIEW_SECONDS });
    return { url, expiresAt: new Date(Date.now() + VIEW_SECONDS * 1000).toISOString() };
  }

  /** Whether the video service offers videos learners can save for offline viewing. */
  get videoDownloads(): boolean {
    return this.video.supportsDownload;
  }

  /** A short-lived URL to save a READY video for offline viewing, or NOT_FOUND when none is offered. */
  async videoDownload(
    asset: { status: string; providerVideoId: string | null },
    name: string,
  ): Promise<{ url: string; expiresAt: string }> {
    if (asset.status !== 'READY' || asset.providerVideoId === null) throw new AppError('INVALID_STATE');
    const url = await this.video.download(asset.providerVideoId, { expiresSeconds: DOWNLOAD_SECONDS, name });
    if (url === null) throw new AppError('NOT_FOUND');
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() };
  }

  /** How to play a READY video, valid for a few minutes. */
  async playback(asset: { status: string; providerVideoId: string | null }) {
    if (asset.status !== 'READY' || asset.providerVideoId === null) throw new AppError('INVALID_STATE');
    const playback = await this.video.playback(asset.providerVideoId, { expiresSeconds: DOWNLOAD_SECONDS });
    return { ...playback, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() };
  }

  /**
   * Applies a verified provider event inside the asset's school (the caller resolved it through
   * resolve_video_asset and set the tenant context). Idempotent: a finished asset isn't changed again.
   */
  async applyVideoEvent(assetId: string, event: VideoEvent): Promise<void> {
    await this.db.run(async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (asset === null || asset.status === 'READY' || asset.status === 'REJECTED') return;
      const size = Number(asset.sizeBytes);
      if (event.status === 'READY') {
        await tx.asset.update({
          where: { id: assetId },
          data: {
            status: 'READY',
            durationSeconds: event.durationSeconds ?? null,
            expiresAt: null,
            updatedAt: new Date(),
          },
        });
        await adjustUsage(tx, { reserved: -size, storage: size });
      } else {
        await tx.asset.update({
          where: { id: assetId },
          data: {
            status: 'REJECTED',
            rejectReason: event.reason ?? 'Processing failed',
            expiresAt: null,
            updatedAt: new Date(),
          },
        });
        await adjustUsage(tx, { reserved: -size });
      }
    });
  }

  // ----------------------------------------------------------------------------------------------

  private assertAllowed(rule: ReturnType<typeof uploadRule>, mime: string, sizeBytes: number): void {
    const problem = uploadProblem(rule, mime, sizeBytes);
    if (problem === 'TYPE_NOT_ALLOWED') throw new AppError('UPLOAD_TYPE_NOT_ALLOWED');
    if (problem === 'TOO_LARGE') {
      throw new AppError('UPLOAD_TOO_LARGE', {
        detail: `The largest file allowed here is ${Math.floor(rule.maxBytes / (1024 * 1024))} MB.`,
        extensions: { maxBytes: rule.maxBytes },
      });
    }
  }

  /**
   * Reserves storage for a new slot (BR-49): the school's usage row is locked, expired slots are
   * released first, and the slot is refused if READY + reserved + this file would exceed the quota.
   */
  private async reserve(tx: TenantTx, sizeBytes: number): Promise<void> {
    const tenantId = requireTenantId();
    await tx.$executeRaw`INSERT INTO tenant_usage (tenant_id) VALUES (${tenantId}::uuid) ON CONFLICT (tenant_id) DO NOTHING`;
    const [usage] = await tx.$queryRaw<{ storage_bytes: bigint; reserved_bytes: bigint }[]>`
      SELECT storage_bytes, reserved_bytes FROM tenant_usage WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const expired = await tx.asset.findMany({
      where: { status: 'PENDING_UPLOAD', expiresAt: { lt: new Date() } },
      select: { id: true, sizeBytes: true },
    });
    let reserved = Number(usage?.reserved_bytes ?? 0);
    if (expired.length > 0) {
      const released = expired.reduce((total, a) => total + Number(a.sizeBytes), 0);
      await tx.asset.updateMany({
        where: { id: { in: expired.map((a) => a.id) } },
        data: { status: 'REJECTED', rejectReason: 'Upload not completed in time', expiresAt: null },
      });
      reserved = Math.max(0, reserved - released);
    }
    // M9: the plan's storage (BR-49); DEFAULT_STORAGE_QUOTA_MB is only the fallback for tests and tools.
    const plan = await readPlan(tx);
    const quota =
      plan.id === null
        ? this.config.get('DEFAULT_STORAGE_QUOTA_MB') * 1024 * 1024
        : (limitOf(plan.limits, 'storage') ?? Number.MAX_SAFE_INTEGER);
    const used = Number(usage?.storage_bytes ?? 0);
    if (used + reserved + sizeBytes > quota) {
      throw new AppError('LIMIT_REACHED', {
        detail: "This school's storage is full. Remove unused files or ask about a larger plan.",
        extensions: { limit: 'storage', quotaBytes: quota, usedBytes: used },
      });
    }
    await tx.tenantUsage.update({
      where: { tenantId },
      data: { reservedBytes: BigInt(reserved + sizeBytes), updatedAt: new Date() },
    });
  }

  private async ownAsset(tx: TenantTx, actor: TenantActor, assetId: string) {
    const asset = await tx.asset.findFirst({ where: { id: assetId, ownerMembershipId: actor.membershipId } });
    if (asset === null) throw new AppError('NOT_FOUND');
    return asset;
  }

  /** Owner, or a school administrator; anything else is not found (another school's: RLS). */
  private async visibleAsset(tx: TenantTx, actor: TenantActor, assetId: string) {
    const asset = await tx.asset.findFirst({ where: { id: assetId } });
    if (asset === null || (asset.ownerMembershipId !== actor.membershipId && !can(actor, 'admin.access'))) {
      throw new AppError('NOT_FOUND');
    }
    return asset;
  }

  private view(asset: {
    id: string;
    kind: string;
    purpose: string;
    status: string;
    originalName: string;
    mime: string;
    sizeBytes: bigint;
    rejectReason: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  }): AssetStatusView {
    return {
      id: asset.id,
      kind: asset.kind,
      purpose: asset.purpose,
      status: asset.status,
      originalName: asset.originalName,
      mime: asset.mime,
      sizeBytes: Number(asset.sizeBytes),
      rejectReason: asset.rejectReason,
      width: asset.width,
      height: asset.height,
      durationSeconds: asset.durationSeconds,
    };
  }
}
