import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';

import type { TenantActor } from '../../identity';
import {
  AppError,
  type ConfigService,
  FakeVideoProvider,
  runWithContext,
  type StorageLocations,
  type TenantDb,
  type TenantTx,
} from '../../platform';
import { MediaService } from './media.service';

const actor: TenantActor = {
  userId: 'user-b',
  membershipId: 'member-b',
  sessionId: 'session-b',
  roles: ['INSTRUCTOR'],
};

function setup(found: { id: string } | null) {
  const findFirst = vi.fn().mockResolvedValue(found);
  const run = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ asset: { findFirst } }));
  const service = new MediaService(
    { run } as unknown as TenantDb,
    {} as ConfigService,
    {} as StorageLocations,
    new FakeVideoProvider('test-secret', '/video'),
  );
  return { service, run, findFirst };
}

describe('video upload ownership (M10 F-03)', () => {
  it('requires the host school, issuing membership and provider when authorizing an upload', async () => {
    const { service, findFirst } = setup({ id: 'asset-b' });
    await runWithContext({ requestId: 'test', tenantId: 'school-b' }, () =>
      service.authorizeVideoUpload(actor, 'video-b'),
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'school-b',
        ownerMembershipId: 'member-b',
        provider: 'fake',
        providerVideoId: 'video-b',
        kind: 'VIDEO',
        purpose: 'LESSON_VIDEO',
      },
      select: { id: true },
    });
  });

  it('returns not found when the scoped lookup cannot find the requested upload', async () => {
    const { service } = setup(null);
    await expect(
      runWithContext({ requestId: 'test', tenantId: 'school-b' }, () =>
        service.authorizeVideoUpload(actor, 'foreign-video'),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to query without a school context', async () => {
    const { service, run } = setup({ id: 'asset' });
    await expect(service.authorizeVideoUpload(actor, 'any-video')).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('stored media locations', () => {
  const tenantId = '23000000-0000-4000-8000-000000000001';
  const originalLocation = '24000000-0000-4000-8000-000000000001';
  const nextLocation = '24000000-0000-4000-8000-000000000002';

  it('pins the selected upload location before commit and signs outside the transaction after a default change', async () => {
    let transactionOpen = false;
    let activeLocation = originalLocation;
    const firstPut = vi.fn(async () => {
      expect(transactionOpen).toBe(false);
      expect(activeLocation).toBe(nextLocation);
      return 'https://original.example/upload';
    });
    const secondPut = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: 'asset' });
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      tenantSetting: { findMany: vi.fn().mockResolvedValue([]) },
      platformSetting: { findUnique: vi.fn().mockResolvedValue(null) },
      tenant: { findFirst: vi.fn().mockResolvedValue(null) },
      asset: { create, update, findMany: vi.fn().mockResolvedValue([]) },
      tenantUsage: { update: vi.fn().mockResolvedValue({}) },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ storage_bytes: 0n, reserved_bytes: 0n }]),
    } as unknown as TenantTx;
    const run = vi.fn(async (work: (value: TenantTx) => Promise<unknown>) => {
      transactionOpen = true;
      const result = await work(tx);
      transactionOpen = false;
      activeLocation = nextLocation;
      return result;
    });
    const active = vi.fn(async () => ({
      locationId: activeLocation,
      storage: { presignPut: activeLocation === originalLocation ? firstPut : secondPut },
    }));
    const service = new MediaService(
      { run } as unknown as TenantDb,
      { get: () => 100 } as unknown as ConfigService,
      { active } as unknown as StorageLocations,
      new FakeVideoProvider('test-secret', '/video'),
    );
    const result = await runWithContext({ requestId: 'test', tenantId }, () =>
      service.createUpload(actor, {
        purpose: 'COURSE_COVER',
        fileName: 'cover.png',
        mime: 'image/png',
        sizeBytes: 128,
      }),
    );
    expect(result.uploadUrl).toBe('https://original.example/upload');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageLocationId: originalLocation }),
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'asset' },
      data: { storageKey: `t/${tenantId}/course_cover/asset` },
    });
    expect(active).toHaveBeenCalledOnce();
    expect(firstPut).toHaveBeenCalledOnce();
    expect(secondPut).not.toHaveBeenCalled();
  });

  it('signs each original or derivative using its recorded location without consulting the active default', async () => {
    const firstGet = vi.fn().mockResolvedValue('https://original.example/image.webp');
    const secondGet = vi.fn().mockResolvedValue('https://next.example/image');
    const assets = [
      {
        id: 'first',
        storageKey: `t/${tenantId}/first`,
        derivativeKey: `t/${tenantId}/first.webp`,
        storageLocationId: originalLocation,
      },
      {
        id: 'second',
        storageKey: `t/${tenantId}/second`,
        derivativeKey: null,
        storageLocationId: nextLocation,
      },
    ];
    const tx = { asset: { findMany: vi.fn().mockResolvedValue(assets) } };
    const active = vi.fn();
    const at = vi.fn(async (locationId: string) => ({
      presignGet: locationId === originalLocation ? firstGet : secondGet,
    }));
    const service = new MediaService(
      { run: (work: (value: unknown) => Promise<unknown>) => work(tx) } as unknown as TenantDb,
      {} as ConfigService,
      { active, at } as unknown as StorageLocations,
      new FakeVideoProvider('test-secret', '/video'),
    );
    const urls = await runWithContext({ requestId: 'test', tenantId }, () =>
      service.readUrls(['first', 'second']),
    );
    expect([...urls]).toEqual([
      ['first', 'https://original.example/image.webp'],
      ['second', 'https://next.example/image'],
    ]);
    expect(at).toHaveBeenCalledWith(originalLocation, tenantId);
    expect(at).toHaveBeenCalledWith(nextLocation, tenantId);
    expect(firstGet).toHaveBeenCalledWith(assets[0]!.derivativeKey, { expiresSeconds: 600 });
    expect(secondGet).toHaveBeenCalledWith(assets[1]!.storageKey, { expiresSeconds: 600 });
    expect(active).not.toHaveBeenCalled();
  });

  it('refuses a lesson download when its recorded location is unavailable', async () => {
    const active = vi.fn();
    const at = vi.fn().mockRejectedValue(new AppError('SERVICE_UNAVAILABLE'));
    const service = new MediaService(
      {} as TenantDb,
      {} as ConfigService,
      { active, at } as unknown as StorageLocations,
      new FakeVideoProvider('test-secret', '/video'),
    );
    await expect(
      runWithContext({ requestId: 'test', tenantId }, () =>
        service.fileUrl({
          status: 'READY',
          storageKey: `t/${tenantId}/document`,
          storageLocationId: null,
          originalName: 'document.pdf',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(at).toHaveBeenCalledWith(null, tenantId);
    expect(active).not.toHaveBeenCalled();
  });
});
