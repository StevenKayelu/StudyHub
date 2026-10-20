// Explicitly captures the deployment's storage origin. Run before changing its storage settings.
import { parseArgs } from 'node:util';

import {
  bootstrapStorageLocations,
  ConfigError,
  createLogger,
  loadApiEnv,
  PrismaService,
} from '../modules/platform';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'capture-existing': { type: 'boolean', default: false } },
    strict: true,
  });
  const env = loadApiEnv();
  const prisma = new PrismaService(env, createLogger({ level: env.LOG_LEVEL }));
  try {
    const result = await bootstrapStorageLocations({
      prisma,
      env,
      allowExisting: values['capture-existing'],
    });
    console.log(
      `Storage origin ${result.locationId} captured; ${result.backfilledAssets} assets and ${result.backfilledExports} exports backfilled.`,
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Storage bootstrap failed.',
    );
    process.exit(1);
  });
}
