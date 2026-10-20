import 'reflect-metadata';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantActor } from '../../identity';
import type { ConfigurationService } from '../application/configuration.service';
import { SchoolConfigurationController } from './school-configuration.controller';

const auth = vi.hoisted(() => ({ actor: null as TenantActor | null }));
vi.mock('../../identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../identity')>()),
  currentActor: () => auth.actor,
}));

const revision = 'a'.repeat(64);
const draft = {
  expectedRevision: revision,
  values: { courseReviewRequired: false },
  reason: '  School course policy  ',
};
const activation = { draftId: '52bf0707-c6dd-4f5b-a0ca-c4d8d1586d81', expectedRevision: revision };

function member(roles: TenantActor['roles']): TenantActor {
  return { userId: 'school-user', membershipId: 'school-member', sessionId: 'school-session', roles };
}

function setup() {
  const service = {
    get: vi.fn().mockResolvedValue({ scope: 'SCHOOL' }),
    saveDraft: vi.fn().mockResolvedValue({ scope: 'SCHOOL' }),
    activate: vi.fn().mockResolvedValue({ scope: 'SCHOOL' }),
    importPreview: vi.fn().mockReturnValue({ values: { courseReviewRequired: false } }),
  };
  const controller = new SchoolConfigurationController(service as unknown as ConfigurationService);
  return { controller, service };
}

beforeEach(() => {
  auth.actor = null;
});

describe('school configuration controller permissions', () => {
  it('requires authentication before validating or forwarding any request', () => {
    const { controller, service } = setup();
    for (const invoke of [
      () => controller.get(),
      () => controller.save({ credentials: 'never forwarded' }),
      () => controller.activate({}),
      () => controller.preview({ text: 'DATABASE_URL=never forwarded' }),
    ]) {
      expect(invoke).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it.each([{ roles: ['LEARNER'] as const }, { roles: ['LEARNER', 'INSTRUCTOR'] as const }])(
    'denies non-administrator roles $roles before the service is reached',
    ({ roles }) => {
      auth.actor = member(roles);
      const { controller, service } = setup();
      for (const invoke of [
        () => controller.get(),
        () => controller.save(draft),
        () => controller.activate(activation),
        () => controller.preview({ text: 'SCHOOL_COURSE_REVIEW_REQUIRED=false' }),
      ]) {
        expect(invoke).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
      }
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
    },
  );

  it.each(['TENANT_ADMIN', 'TENANT_OWNER'] as const)(
    'allows %s to manage only the school scope with validated inputs',
    async (role) => {
      const actor = member(['LEARNER', role]);
      auth.actor = actor;
      const { controller, service } = setup();
      await controller.get();
      await controller.save(draft);
      await controller.activate(activation);
      controller.preview({ text: 'SCHOOL_COURSE_REVIEW_REQUIRED=false' });
      expect(service.get).toHaveBeenCalledWith('SCHOOL');
      expect(service.saveDraft).toHaveBeenCalledWith('SCHOOL', actor, {
        expectedRevision: revision,
        values: { courseReviewRequired: false },
        lockedKeys: [],
        reason: 'School course policy',
      });
      expect(service.activate).toHaveBeenCalledWith('SCHOOL', actor, activation);
      expect(service.importPreview).toHaveBeenCalledWith('SCHOOL_COURSE_REVIEW_REQUIRED=false');
    },
  );

  it('refuses writes from a read-only support session before persistence', async () => {
    auth.actor = {
      ...member(['TENANT_ADMIN']),
      support: {
        grantId: 'support-grant',
        platformUserId: 'staff-user',
        staffName: 'Support',
        scope: 'READ_ONLY',
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    const { controller, service } = setup();
    await controller.get();
    expect(service.get).toHaveBeenCalledWith('SCHOOL');
    for (const invoke of [() => controller.save(draft), () => controller.activate(activation)]) {
      expect(invoke).toThrowError(expect.objectContaining({ code: 'SUPPORT_READ_ONLY' }));
    }
    expect(service.saveDraft).not.toHaveBeenCalled();
    expect(service.activate).not.toHaveBeenCalled();
  });

  it('permits an approved read-write support session through the same school scope', async () => {
    const actor: TenantActor = {
      ...member(['TENANT_ADMIN']),
      support: {
        grantId: 'support-grant',
        platformUserId: 'staff-user',
        staffName: 'Support',
        scope: 'READ_WRITE',
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    auth.actor = actor;
    const { controller, service } = setup();
    await controller.save(draft);
    await controller.activate(activation);
    expect(service.saveDraft).toHaveBeenCalledWith('SCHOOL', actor, expect.anything());
    expect(service.activate).toHaveBeenCalledWith('SCHOOL', actor, activation);
  });

  it('rejects scope injection, unknown or credential fields and invalid revisions before persistence', () => {
    auth.actor = member(['TENANT_OWNER']);
    const { controller, service } = setup();
    for (const invoke of [
      () => controller.save({ ...draft, scope: 'PLATFORM' }),
      () => controller.save({ ...draft, values: { apiKey: 'not accepted' } }),
      () => controller.save({ ...draft, expectedRevision: 'old' }),
      () => controller.activate({ ...activation, tenantId: 'another-school' }),
      () => controller.activate({ ...activation, draftId: 'invalid' }),
      () => controller.preview({ text: 'SCHOOL_COURSE_REVIEW_REQUIRED=false', credentials: 'not accepted' }),
    ]) {
      expect(invoke).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });
});
