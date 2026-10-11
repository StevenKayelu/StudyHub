// Prisma 7 CLI configuration. Migrations always run as the migrator role (DATABASE_URL_MIGRATOR);
// the runtime client connects as studyhub_app through the pg driver adapter (src/modules/platform/db).
// `prisma generate` needs no database URL.
import { defineConfig } from 'prisma/config';

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(migratorUrl !== undefined && migratorUrl !== '' ? { datasource: { url: migratorUrl } } : {}),
});
