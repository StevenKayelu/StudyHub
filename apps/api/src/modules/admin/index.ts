// Public surface of the admin module (enforced by dependency-cruiser).
export { AdminModule } from './admin.module';
export { colourReport } from './application/branding.service';
export {
  createExportHandler,
  EXPORT_JOB,
  type ExportDeps,
  fullExport,
  reportCsv,
} from './application/exports';
export { dayRange, monthRange, refundsTotal, salesTotal } from './application/report-queries';
export { onboardingState, slugAvailable, toStatement } from './application/school.service';
export { effectiveStatus, supportMaxHours, toGrant } from './application/support-access.service';
export {
  createPurgeHandler,
  createUsageMeterHandler,
  measureTenant,
  PURGE_JOB,
  sweepTenants,
  USAGE_METER_JOB,
  usageDay,
} from './application/usage';
export { buildZip, readZip } from './domain/zip';
