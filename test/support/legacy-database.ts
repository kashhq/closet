import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import { connectionOptions } from '../../src/db/client';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate';

/**
 * The rows production's `mikro_orm_migrations` holds: the fifteen MikroORM
 * migrations that built every database before Drizzle took over, oldest
 * first. src/db/migrate.ts judges a legacy database by these rows alone, and
 * its LAST_LEGACY_MIGRATION is the last (migration-runner.spec.ts holds it).
 */
export const LEGACY_MIGRATION_STAMPS = [
  '20260305215234',
  '20260306212749',
  '20260326211224',
  '20260406193304',
  '20260416215256',
  '20260612010041',
  '20260617003819',
  '20260617011648',
  '20260617224534',
  '20260925170251',
  '20260925181256',
  '20260925182919',
  '20260925183958',
  '20260926020918',
  '20260926021506',
].map((stamp) => `Migration${stamp}`);

/**
 * Builds a MikroORM-era database in the one named by `env` (DATABASE_*
 * values, as ScratchDatabase.env), the shape production's first Drizzle boot
 * met. The schema MikroORM left is drizzle/0000_baseline.sql, introspected
 * from it, so the baseline's statements build it; the bookkeeping table holds
 * the applied names, with the serial id MikroORM gave it (schema-drift.ts
 * filters its sequence).
 *
 * `complete: false` leaves out the last row, a database an older build left
 * behind: the runner refuses it from the rows before it reads any table, so
 * the schema is not built then.
 *
 * Replaces the frozen MikroORM tree the migration specs once ran through
 * MikroORM itself (#1225, docs/decisions.md 2026-11-25).
 */
export async function createLegacyDatabase(
  env: Record<string, string>,
  options: { complete?: boolean } = {},
): Promise<void> {
  const complete = options.complete ?? true;
  const applied = complete
    ? LEGACY_MIGRATION_STAMPS
    : LEGACY_MIGRATION_STAMPS.slice(0, -1);

  const client = new Client(
    connectionOptions({
      host: env.DATABASE_HOST,
      port: Number(env.DATABASE_PORT),
      database: env.DATABASE_NAME,
      user: env.DATABASE_USER,
      password: env.DATABASE_PASS,
      ssl: false,
    }),
  );
  await client.connect();
  try {
    await client.query('begin');
    if (complete) {
      const [baseline] = readMigrationFiles({
        migrationsFolder: MIGRATIONS_FOLDER,
      });
      for (const statement of baseline.sql) await client.query(statement);
    }
    await client.query(
      'create table mikro_orm_migrations (id serial primary key, name varchar(255), executed_at timestamptz default current_timestamp)',
    );
    await client.query(
      'insert into mikro_orm_migrations (name) select unnest($1::text[])',
      [applied],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}
