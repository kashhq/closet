import { DrizzleQueryError, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { Client } from 'pg';
import { PROJECT_ROOT } from '../project-root';
import type { Logger } from '../logger';
import {
  connectionOptions,
  type Db,
  type DbConfig,
  MAINTENANCE_TIMEOUTS,
} from './client';

/**
 * Brings the database to the schema in drizzle/ at boot, before anything
 * queries it. The only migration authority: MikroORM's migrator no longer
 * runs, and its migration tree left the repository (#1225).
 *
 * - A database built by the legacy MikroORM migrations (it has
 *   `mikro_orm_migrations`, as production does) must have applied the last of
 *   them, LAST_LEGACY_MIGRATION, or the boot is refused. Such a database
 *   already has the baseline's schema, so the baseline (drizzle/0000_*) is
 *   recorded in Drizzle's table exactly as drizzle's migrator would record it,
 *   without running its SQL.
 * - A fresh database runs the baseline like any other migration.
 * - A database whose newest recorded migration this build does not know is
 *   refused before anything is written (SchemaAheadError): an image older
 *   than the database, after a rollback.
 * - Then drizzle's migrate() applies whatever is newer than the last row.
 *
 * Only the server migrates (createApp(), before anything queries). Every
 * step runs on one dedicated connection holding a Postgres advisory lock, so
 * two servers on one database (an overlapping deploy) never migrate at once:
 * the second waits, then finds nothing to do. The CLIs never migrate; they
 * refuse a database that is behind or ahead (requireCurrentSchema).
 */

export const MIGRATIONS_FOLDER = join(PROJECT_ROOT, 'drizzle');

/**
 * The last MikroORM migration, the newest row a MikroORM-era build wrote to
 * `mikro_orm_migrations`. A database lacking it was left behind by an older
 * build and does not match the baseline. migration-runner.spec.ts checks it
 * against test/support/legacy-database.ts's list.
 */
export const LAST_LEGACY_MIGRATION = 'Migration20260926021506';

// drizzle-orm's defaults (pg-core dialect.migrate); drizzle-kit reads the
// same ones. Changing them would orphan every recorded migration.
const DRIZZLE_SCHEMA = 'drizzle';
const DRIZZLE_TABLE = '__drizzle_migrations';
const DRIZZLE_TABLE_REF = `"${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}"`;

// Advisory locks are per database, so this only serializes processes that
// migrate the same one.
export const MIGRATION_LOCK_KEY = 'closet:migrations';

/**
 * A migration statement failed; the batch rolled back. The message is the
 * database's reason (a guard's RAISE EXCEPTION, a violated constraint), which
 * drizzle keeps only as the cause of an error whose own message is the whole
 * failed statement.
 */
class MigrationFailedError extends Error {
  constructor(cause: Error) {
    super(
      `A Drizzle migration failed and nothing was applied: ${cause.message}`,
      {
        cause,
      },
    );
    this.name = 'MigrationFailedError';
  }
}

export class LegacyMigrationsIncompleteError extends Error {
  constructor() {
    super(
      `This database was built by the legacy MikroORM migrations but has not applied ` +
        `${LAST_LEGACY_MIGRATION}, the last of them, so it does not match the Drizzle baseline. ` +
        `Boot a build from before the switch to Drizzle once (it applies the remaining MikroORM ` +
        `migrations), then this one.`,
    );
    this.name = 'LegacyMigrationsIncompleteError';
  }
}

export async function runMigrations(
  config: DbConfig,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  const client = new Client(connectionOptions(config, MAINTENANCE_TIMEOUTS));
  await client.connect();
  try {
    await acquireLock(client, logger);
    // First, so a refusal writes nothing: not the baseline's row, not
    // migrate()'s CREATE SCHEMA.
    const state = schemaState(
      await lastAppliedAt(client),
      buildMigrationTimes(),
    );
    if (state.name === 'ahead') throw new SchemaAheadError(state.newestAt);
    if (await isLegacyDatabase(client)) {
      await requireLastLegacyMigration(client);
      await recordBaseline(client, logger);
    }
    const before = await appliedCount(client);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } catch (error) {
      if (error instanceof DrizzleQueryError && error.cause instanceof Error) {
        throw new MigrationFailedError(error.cause);
      }
      throw error;
    }
    const applied = (await appliedCount(client)) - before;
    logger.info(
      applied === 0
        ? `Schema up to date (${before} Drizzle migrations recorded)`
        : `Applied ${applied} Drizzle migration(s) in ${Date.now() - started} ms`,
    );
  } finally {
    // Ending the session releases the advisory lock, whether or not a step
    // failed (an explicit unlock on a broken connection would only mask the
    // original error).
    await client.end();
  }
}

/**
 * Where a database's schema stands against this build. A migration is
 * identified by its `created_at`, not its `hash`: drizzle's migrator writes
 * it from the journal's `when` and keys every decision on it (it applies the
 * files newer than the newest row and never reads `hash` again), so it is
 * what "applied" means to drizzle; the baseline's adoption matches on it
 * too. Each journal entry's `when` is a distinct generation time, so a value
 * the journal lacks is a migration this build has never seen.
 *
 * - `ahead`: the newest recorded migration is not in this build's journal.
 *   Usually an image older than the database (a rollback); also a database
 *   a branch build migrated. Older code must not write to it, and drizzle
 *   alone would boot it (nothing in the journal is newer than its last row).
 * - `behind`: this build has `pending` migrations newer than the newest row,
 *   which the next boot applies (none recorded: all of them).
 * - `current`: the newest row is this build's newest migration.
 *
 * The one rule runMigrations (the boot), requireCurrentSchema (the CLIs) and
 * /health/ready's `migrations` check (src/web/health/checks.ts) apply.
 */
export type SchemaState =
  | { name: 'current' }
  | { name: 'behind'; pending: number }
  | { name: 'ahead'; newestAt: number };

export function schemaState(
  lastAppliedAt: number | undefined,
  buildMigrations: readonly number[],
): SchemaState {
  if (lastAppliedAt !== undefined && !buildMigrations.includes(lastAppliedAt)) {
    return { name: 'ahead', newestAt: lastAppliedAt };
  }
  const pending = buildMigrations.filter(
    (at) => lastAppliedAt === undefined || at > lastAppliedAt,
  ).length;
  return pending === 0 ? { name: 'current' } : { name: 'behind', pending };
}

export class SchemaBehindError extends Error {
  constructor(readonly pending: number) {
    super(
      `The database is ${pending} migration(s) behind this build. Start the ` +
        `server (it migrates at boot), then run this again.`,
    );
    this.name = 'SchemaBehindError';
  }
}

/**
 * The database records a migration this build does not have: the image is
 * older than the database. The boot and the CLIs refuse it before writing
 * anything. The `when` is greppable in the newer build's
 * drizzle/meta/_journal.json, which names its tag.
 */
export class SchemaAheadError extends Error {
  constructor(readonly newestAt: number) {
    super(schemaAheadRefusal(newestAt));
    this.name = 'SchemaAheadError';
  }
}

/** The refusal's text, from its fields: main.ts logs it as the boot's fatal line. */
export function schemaAheadRefusal(newestAt: number): string {
  return (
    `The database's newest migration (journal when ${newestAt}, generated ` +
    `${new Date(newestAt).toISOString()}) is not in this build: the image ` +
    `is older than the database. Deploy the newer image, or roll the ` +
    `schema back first (docs/operations.md#migrations-and-rollback).`
  );
}

/**
 * Refuses a database whose schema is not exactly this build's (schemaState):
 * behind is what the next server boot would apply; ahead, a newer build
 * migrated it. The CLIs call it instead of migrating: a recovery tool run
 * beside a server must not change the schema under it, and a schema it does
 * not know is not one it should write to.
 */
export async function requireCurrentSchema(config: DbConfig): Promise<void> {
  const client = new Client(connectionOptions(config, MAINTENANCE_TIMEOUTS));
  await client.connect();
  try {
    const state = schemaState(
      await lastAppliedAt(client),
      buildMigrationTimes(),
    );
    if (state.name === 'behind') throw new SchemaBehindError(state.pending);
    if (state.name === 'ahead') throw new SchemaAheadError(state.newestAt);
  } finally {
    await client.end();
  }
}

/**
 * The journal `when` of every migration in this build, oldest first: what
 * drizzle records as `created_at` once it has applied each. It reads and
 * hashes every file, so /health/ready (src/web/health) reads it once at
 * registration and compares lastMigrationAt() with it.
 */
export function buildMigrationTimes(): number[] {
  return readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map(
    (migration) => migration.folderMillis,
  );
}

/**
 * created_at of the newest recorded migration, through the server's pool
 * (the boot has created the table): /health/ready's one statement, which is
 * its database round-trip and its migrations check at once. Undefined only
 * for an empty table.
 */
export async function lastMigrationAt(db: Db): Promise<number | undefined> {
  const { rows } = await db.execute<{ last: string | null }>(
    sql`select max(created_at)::text as last from ${sql.raw(DRIZZLE_TABLE_REF)}`,
  );
  return rows[0].last === null ? undefined : Number(rows[0].last);
}

async function acquireLock(client: Client, logger: Logger): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_lock(hashtext($1)) as locked',
    [MIGRATION_LOCK_KEY],
  );
  if (rows[0].locked) return;
  logger.info('Another process is migrating this database; waiting for it');
  await client.query('select pg_advisory_lock(hashtext($1))', [
    MIGRATION_LOCK_KEY,
  ]);
}

async function isLegacyDatabase(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ legacy: boolean }>(
    `select to_regclass('mikro_orm_migrations') is not null as legacy`,
  );
  return rows[0].legacy;
}

async function requireLastLegacyMigration(client: Client): Promise<void> {
  // MikroORM strips a .js/.ts extension when it compares names, and very old
  // builds recorded one; accept either form as it does.
  const { rowCount } = await client.query(
    'select 1 from mikro_orm_migrations where name = any($1::text[])',
    [['', '.js', '.ts'].map((ext) => `${LAST_LEGACY_MIGRATION}${ext}`)],
  );
  if (!rowCount) throw new LegacyMigrationsIncompleteError();
}

/**
 * Inserts the baseline's row as drizzle's migrator would after running it:
 * readMigrationFiles() is the migrator's own reader, so hash (sha256 of the
 * SQL file) and created_at (the journal's `when`) are exactly its values.
 * The table DDL is copied from drizzle-orm's pg-core dialect; migrate()
 * repeats it with IF NOT EXISTS.
 */
async function recordBaseline(client: Client, logger: Logger): Promise<void> {
  const [baseline] = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  });
  await client.query('begin');
  try {
    await client.query(`create schema if not exists "${DRIZZLE_SCHEMA}"`);
    await client.query(
      `create table if not exists ${DRIZZLE_TABLE_REF} (id serial primary key, hash text not null, created_at bigint)`,
    );
    const { rowCount } = await client.query(
      `select 1 from ${DRIZZLE_TABLE_REF} where created_at = $1`,
      [baseline.folderMillis],
    );
    if (rowCount) {
      await client.query('commit');
      return;
    }
    await client.query(
      `insert into ${DRIZZLE_TABLE_REF} (hash, created_at) values ($1, $2)`,
      [baseline.hash, baseline.folderMillis],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  logger.info(
    `Legacy MikroORM database (through ${LAST_LEGACY_MIGRATION}): recorded the Drizzle baseline as applied without running it`,
  );
}

async function appliedCount(client: Client): Promise<number> {
  if (!(await drizzleTableExists(client))) return 0;
  const { rows } = await client.query<{ count: number }>(
    `select count(*)::int as count from ${DRIZZLE_TABLE_REF}`,
  );
  return rows[0].count;
}

// A query of its own: a statement naming a missing table fails at parse
// time, even in a branch that would not run.
async function drizzleTableExists(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    'select to_regclass($1) is not null as exists',
    [DRIZZLE_TABLE_REF],
  );
  return rows[0].exists;
}

/** created_at of the newest recorded migration; undefined before the first. */
async function lastAppliedAt(client: Client): Promise<number | undefined> {
  if (!(await drizzleTableExists(client))) return undefined;
  const { rows } = await client.query<{ createdAt: string | null }>(
    `select max(created_at)::text as "createdAt" from ${DRIZZLE_TABLE_REF}`,
  );
  return rows[0].createdAt === null ? undefined : Number(rows[0].createdAt);
}
