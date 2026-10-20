import { describe, expect, it } from 'vitest';

import { featureAvailable, featureChangeProblems, featureEnabled, featureMap, planGrants } from './features';

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

  it('a plan grants only its listed features; a GRANT override adds one, REVOKE removes one (M9)', () => {
    const plan = { practiceMode: true, paidCourses: false };
    const map = featureMap(
      [
        { featureKey: 'quizAnalytics', enabledByTenant: true, platformOverride: 'GRANT' },
        { featureKey: 'practiceMode', enabledByTenant: true, platformOverride: 'REVOKE' },
      ],
      plan,
    );
    expect(map.practiceMode).toBe(false);
    expect(map.paidCourses).toBe(false);
    expect(map.quizAnalytics).toBe(true);
    expect(map.publicCatalog).toBe(false);
    expect(featureAvailable(null, planGrants(plan, 'practiceMode'))).toBe(true);
    expect(featureAvailable(null, planGrants(plan, 'paidCourses'))).toBe(false);
  });

  it('features not built yet are never effective, even when granted', () => {
    const map = featureMap([
      { featureKey: 'customDomain', enabledByTenant: true, platformOverride: 'GRANT' },
    ]);
    expect(map.customDomain).toBe(false);
    expect(map.certificates).toBe(false);
  });

  it('instructor revenue share stays off until the school switches it on (M8)', () => {
    expect(featureMap([]).instructorRevenueShare).toBe(false);
    expect(featureMap([]).paidCourses).toBe(true);
    const on = featureMap([
      { featureKey: 'instructorRevenueShare', enabledByTenant: true, platformOverride: 'NONE' },
    ]);
    expect(on.instructorRevenueShare).toBe(true);
  });

  it('requires paid courses for new revenue-share enables and protects an effective dependent', () => {
    const current = featureMap([
      { featureKey: 'paidCourses', enabledByTenant: false, platformOverride: 'NONE' },
    ]);
    expect(featureChangeProblems(current, 'instructorRevenueShare', true)).toEqual([
      { feature: 'paidCourses', code: 'dependency_disabled' },
    ]);
    const sharing = featureMap([
      { featureKey: 'instructorRevenueShare', enabledByTenant: true, platformOverride: 'NONE' },
    ]);
    expect(featureChangeProblems(sharing, 'paidCourses', false)).toEqual([
      { feature: 'instructorRevenueShare', code: 'dependent_enabled' },
    ]);
    expect(featureChangeProblems(sharing, 'instructorRevenueShare', false)).toEqual([]);
    expect(featureChangeProblems(current, 'paidCourses', true)).toEqual([]);
  });
});
