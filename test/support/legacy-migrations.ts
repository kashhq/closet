import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The frozen MikroORM migration tree that built every database before
 * Drizzle took over (production included), kept beside this helper since
 * MikroORM left the app. Nothing at runtime runs it: src/db/migrate.ts only
 * checks that a legacy database recorded its last entry. This helper is the
 * one place MikroORM (a devDependency now) still runs, so the migration
 * specs can build a database exactly the way production's was built and
 * boot the app on it.
 */
const LEGACY_MIGRATIONS_PATH = join(__dirname, 'legacy-migrations');

/** Migration names in the order MikroORM applies them (timestamped names). */
export function legacyMigrationNames(): string[] {
  return readdirSync(LEGACY_MIGRATIONS_PATH)
    .filter((file) => /^Migration\d+\.ts$/.test(file))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

/**
 * Applies the legacy tree to the database named by `env` (DATABASE_* values,
 * as ScratchDatabase.env), with the options the app's migrator used: one
 * transaction per migration (the CONCURRENTLY index migrations opt out and
 * would not see tables created earlier in a batch-wide transaction). `to`
 * stops after that migration, for a database left behind by an older build.
 */
export async function applyLegacyMigrations(
  env: Record<string, string>,
  options: { to?: string } = {},
): Promise<void> {
  const orm = await MikroORM.init(
    defineConfig({
      host: env.DATABASE_HOST,
      port: Number(env.DATABASE_PORT),
      user: env.DATABASE_USER,
      password: env.DATABASE_PASS,
      dbName: env.DATABASE_NAME,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      allowGlobalContext: true,
      extensions: [Migrator],
      migrations: {
        path: LEGACY_MIGRATIONS_PATH,
        pathTs: LEGACY_MIGRATIONS_PATH,
        transactional: true,
        allOrNothing: false,
        snapshot: false,
      },
      // MikroORM's own import() lives in node_modules, which Vitest does not
      // transform: Node would load the .ts migrations itself (type stripping)
      // and fail on their extensionless imports. An import() in this file goes
      // through Vitest's module runner.
      dynamicImportProvider: (id: string) => import(id),
      // One "Processing/Applied" line per migration otherwise, in every run.
      logger: () => undefined,
    }),
  );
  try {
    await orm.migrator.up(options.to ? { to: options.to } : undefined);
  } finally {
    await orm.close();
  }
}
