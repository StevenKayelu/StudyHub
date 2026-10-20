import 'reflect-metadata';

import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantActor } from '../../identity';
import {
  AppError,
  type ConfigService,
  currentContext,
  FakeVideoProvider,
  runWithContext,
} from '../../platform';
import type { MediaService } from '../application/media.service';
import type { VideoWebhookService } from '../application/video-webhook.service';
import { MediaController } from './media.controller';

const auth = vi.hoisted(() => ({ actor: null as TenantActor | null }));
vi.mock('../../identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../identity')>()),
  currentActor: () => auth.actor,
}));

const actor: TenantActor = {
  userId: 'user-b',
  membershipId: 'member-b',
  sessionId: 'session-b',
  roles: ['INSTRUCTOR'],
};
const request = { id: 'video-security-test' } as FastifyRequest;

function setup(production = false) {
  const authorize = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const handle = vi.fn().mockResolvedValue(undefined);
  const video = new FakeVideoProvider('test-secret', '/api/v1/dev/fake-video');
  const sign = vi.spyOn(video, 'sign');
  const controller = new MediaController(
    { authorizeVideoUpload: authorize } as unknown as MediaService,
    { handle } as unknown as VideoWebhookService,
    { get: () => (production ? 'production' : 'test') } as unknown as ConfigService,
    video,
  );
  return { controller, authorize, handle, sign };
}

beforeEach(() => {
  auth.actor = actor;
});

describe('development video upload authorization (M10 F-03)', () => {
  it('does not sign or deliver an event for an unauthorized provider video id', async () => {
    const { controller, authorize, sign, handle } = setup();
    authorize.mockRejectedValue(new AppError('NOT_FOUND'));
    await expect(controller.fakeVideoUpload('school-a-video', request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(sign).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('authorizes in the caller school before delivering without a school context', async () => {
    const { controller, authorize, handle } = setup();
    authorize.mockImplementation(async () => {
      expect(currentContext()?.tenantId).toBe('school-b');
    });
    handle.mockImplementation(async () => {
      expect(currentContext()?.tenantId).toBeUndefined();
    });
    await runWithContext({ requestId: request.id, tenantId: 'school-b' }, () =>
      controller.fakeVideoUpload('own-video', request),
    );
    expect(authorize).toHaveBeenCalledWith(actor, 'own-video');
    expect(handle).toHaveBeenCalledOnce();
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(handle.mock.invocationCallOrder[0]!);
  });

  it('remains unavailable in production', async () => {
    const { controller, authorize, handle } = setup(true);
    await expect(controller.fakeVideoUpload('any-video', request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('requires a signed-in member', async () => {
    auth.actor = null;
    const { controller, authorize, handle } = setup();
    await expect(controller.fakeVideoUpload('any-video', request)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });
});
