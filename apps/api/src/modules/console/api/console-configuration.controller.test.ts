import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';

import type { ConfigurationService } from '../../configuration';
import { currentContext, runWithContext } from '../../platform';
import { type ConsoleActor, REAUTH_VALID_MS } from '../application/console-auth.service';
import { ConsoleConfigurationController } from './console-configuration.controller';
import { actors } from './console-guards';

const revision = 'a'.repeat(64);
const draft = {
  expectedRevision: revision,
  values: { courseReviewRequired: true },
  lockedKeys: ['courseReviewRequired'],
  reason: 'Platform course policy',
};
const activation = { draftId: '52bf0707-c6dd-4f5b-a0ca-c4d8d1586d81', expectedRevision: revision };

function staff(overrides: Partial<ConsoleActor> = {}): ConsoleActor {
  return {
    userId: 'platform-owner',
    sessionId: 'platform-session',
    role: 'PLATFORM_OWNER',
    email: 'owner@platform.test',
    displayName: 'Platform Owner',
    mfaVerified: true,
    totpEnabled: true,
    reauthAt: new Date(),
    ...overrides,
  };
}

function asStaff<T>(actor: ConsoleActor | null, fn: () => T): T {
  return runWithContext({ requestId: 'configuration-permission-test' }, () => {
    const context = currentContext();
    if (context === undefined) throw new Error('Test request context was not created');
    if (actor !== null) actors.set(context, actor);
    return fn();
  });
}

function setup() {
  const service = {
    get: vi.fn().mockResolvedValue({ scope: 'PLATFORM' }),
    saveDraft: vi.fn().mockResolvedValue({ scope: 'PLATFORM' }),
    activate: vi.fn().mockResolvedValue({ scope: 'PLATFORM' }),
    importPreview: vi.fn().mockReturnValue({ values: { courseReviewRequired: true } }),
  };
  const controller = new ConsoleConfigurationController(service as unknown as ConfigurationService);
  return { controller, service };
}

describe('platform configuration controller permissions', () => {
  it('requires a console actor in the current request before validating input', () => {
    const { controller, service } = setup();
    for (const invoke of [
      () => controller.get(),
      () => controller.save({ credentials: 'never forwarded' }),
      () => controller.activate({}),
      () => controller.preview({ text: 'DATABASE_URL=never forwarded' }),
    ]) {
      expect(invoke).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
      asStaff(null, () => {
        expect(invoke).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
      });
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it('denies password-only sessions even when the actor is a platform owner', () => {
    const { controller, service } = setup();
    asStaff(staff({ mfaVerified: false }), () => {
      for (const invoke of [
        () => controller.get(),
        () => controller.save(draft),
        () => controller.activate(activation),
        () => controller.preview({ text: 'SCHOOL_COURSE_REVIEW_REQUIRED=true' }),
      ]) {
        expect(invoke).toThrowError(expect.objectContaining({ code: 'MFA_REQUIRED' }));
      }
    });
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it.each(['PLATFORM_OPERATOR', 'PLATFORM_SUPPORT'] as const)(
    'denies %s for every configuration operation even after fresh reauthentication',
    (role) => {
      const { controller, service } = setup();
      asStaff(staff({ role }), () => {
        for (const invoke of [
          () => controller.get(),
          () => controller.save(draft),
          () => controller.activate(activation),
          () => controller.preview({ text: 'SCHOOL_COURSE_REVIEW_REQUIRED=true' }),
        ]) {
          expect(invoke).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
        }
      });
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
    },
  );

  it.each([null, new Date(Date.now() - REAUTH_VALID_MS - 1_000)])(
    'allows an MFA owner to prepare changes but rejects activation without recent reauthentication (%s)',
    async (reauthAt) => {
      const { controller, service } = setup();
      const actor = staff({ reauthAt });
      await asStaff(actor, async () => {
        await controller.get();
        await controller.save(draft);
        controller.preview({ text: 'SCHOOL_COURSE_REVIEW_REQUIRED=true' });
        expect(() => controller.activate(activation)).toThrowError(
          expect.objectContaining({ code: 'REAUTH_REQUIRED' }),
        );
      });
      expect(service.get).toHaveBeenCalledWith('PLATFORM');
      expect(service.saveDraft).toHaveBeenCalledWith('PLATFORM', actor, draft);
      expect(service.importPreview).toHaveBeenCalledWith('SCHOOL_COURSE_REVIEW_REQUIRED=true');
      expect(service.activate).not.toHaveBeenCalled();
    },
  );

  it('allows an MFA owner with fresh reauthentication to activate only the platform scope', async () => {
    const { controller, service } = setup();
    const actor = staff();
    await asStaff(actor, () => controller.activate(activation));
    expect(service.activate).toHaveBeenCalledExactlyOnceWith('PLATFORM', actor, activation);
  });

  it('does not reuse another request’s privileged actor', async () => {
    const { controller, service } = setup();
    await asStaff(staff(), () => controller.get());
    asStaff(null, () => {
      expect(() => controller.get()).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    });
    expect(service.get).toHaveBeenCalledExactlyOnceWith('PLATFORM');
  });

  it('rejects scope and credential injection and malformed payloads before the service is reached', () => {
    const { controller, service } = setup();
    asStaff(staff(), () => {
      for (const invoke of [
        () => controller.save({ ...draft, scope: 'SCHOOL' }),
        () => controller.save({ ...draft, values: { secretAccessKey: 'not accepted' } }),
        () => controller.activate({ ...activation, expectedRevision: 'stale' }),
        () => controller.activate({ ...activation, tenantId: 'another-school' }),
        () => controller.preview({ text: 'SCHOOL_COURSE_REVIEW_REQUIRED=true', credentials: 'not accepted' }),
      ]) {
        expect(invoke).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
      }
    });
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });
});
