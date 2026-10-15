import { describe, expect, it } from 'vitest';

import { featureEnabled, featureMap } from './features';

describe('features (F40, BR-48)', () => {
  it('on by default; the school can switch it off; the platform can revoke or grant', () => {
    expect(featureEnabled(null)).toBe(true);
    expect(featureEnabled({ enabledByTenant: false, platformOverride: 'NONE' })).toBe(false);
    expect(featureEnabled({ enabledByTenant: true, platformOverride: 'REVOKE' })).toBe(false);
    expect(featureEnabled({ enabledByTenant: true, platformOverride: 'NONE' }, false)).toBe(false);
    expect(featureEnabled({ enabledByTenant: true, platformOverride: 'GRANT' }, false)).toBe(true);
    expect(featureEnabled({ enabledByTenant: false, platformOverride: 'GRANT' }, false)).toBe(false);
  });

  it('maps every known key', () => {
    const map = featureMap([
      { featureKey: 'practiceMode', enabledByTenant: false, platformOverride: 'NONE' },
    ]);
    expect(map.practiceMode).toBe(false);
    expect(map.quizAnalytics).toBe(true);
    expect(Object.keys(map)).toHaveLength(10);
  });

  it('instructor revenue share stays off until the school switches it on (M8)', () => {
    expect(featureMap([]).instructorRevenueShare).toBe(false);
    expect(featureMap([]).paidCourses).toBe(true);
    const on = featureMap([
      { featureKey: 'instructorRevenueShare', enabledByTenant: true, platformOverride: 'NONE' },
    ]);
    expect(on.instructorRevenueShare).toBe(true);
  });
});
