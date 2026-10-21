import { describe, expect, it } from 'vitest';

import { deviceLabel, replacesOtherSessions } from './single-device';

describe('one device at a time for learners', () => {
  it('applies to learner-only accounts while the school setting is on', () => {
    expect(replacesOtherSessions(['LEARNER'], true)).toBe(true);
    expect(replacesOtherSessions([], true)).toBe(true);
    expect(replacesOtherSessions(['LEARNER'], false)).toBe(false);
  });

  it('leaves staff with several devices', () => {
    expect(replacesOtherSessions(['LEARNER', 'INSTRUCTOR'], true)).toBe(false);
    expect(replacesOtherSessions(['TENANT_ADMIN'], true)).toBe(false);
    expect(replacesOtherSessions(['TENANT_OWNER'], true)).toBe(false);
  });

  it('names the device in plain words', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (Linux; Android 14; SM-A146P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      ),
    ).toBe('Edge on Windows');
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(deviceLabel(null)).toBe('another device');
    expect(deviceLabel('curl/8.0')).toBe('another device');
  });
});
