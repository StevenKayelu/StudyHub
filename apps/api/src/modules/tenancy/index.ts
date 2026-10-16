// Public surface of the tenancy module (enforced by dependency-cruiser).
export { registerTenantContextHook, TENANT_SCOPED_PREFIX, WEBHOOK_PREFIX } from './api/tenant-context.hook';
export {
  type ResolvedTenant,
  type ResolvedTenantStatus,
  type TenantLookup,
  TenantResolver,
} from './application/tenant-resolver';
export { normalizeHost, RESERVED_SLUGS, slugProblem } from './domain/host';
export {
  PROVISIONABLE_STATUSES,
  type ProvisionableStatus,
  type ProvisionResult,
  provisionTenant,
  type ProvisionTenantInput,
  TENANT_KINDS,
  type TenantBrandingInput,
  type TenantKind,
  writeTenantProfile,
} from './infra/tenant-provisioning';
export { readCommerceSettings } from './infra/commerce-settings';
export { readContentSettings } from './infra/content-settings';
export {
  featureAvailable,
  featureEnabled,
  featureMap,
  LATER_FEATURES,
  type PlanGrants,
  planGrants,
  TENANT_SWITCH_DEFAULTS,
} from './domain/features';
export {
  capUploadSettings,
  crossedLevel,
  type LimitKind,
  limitOf,
  limitsFrom,
  meterPercent,
  meterState,
} from './domain/limits';
export { readFeatures, requireFeature } from './infra/features';
export {
  countUsage,
  type EffectivePlan,
  enforceLimit,
  noteUsageLevel,
  ownerContacts,
  planFromRow,
  readPlan,
} from './infra/plans';
export { MAINTENANCE_BANNER_KEY, TenantRepository, toBranding } from './infra/tenant.repository';
export { TenancyModule } from './tenancy.module';
