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
export { featureEnabled, featureMap, TENANT_SWITCH_DEFAULTS } from './domain/features';
export { readFeatures, requireFeature } from './infra/features';
export { TenancyModule } from './tenancy.module';
