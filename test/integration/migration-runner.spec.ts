import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectionOptions,
  createDb,
  type DbConfig,
} from '../../src/db/client';
import {
  LAST_LEGACY_MIGRATION,
  LegacyMigrationsIncompleteError,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_FOLDER,
  requireCurrentSchema,
  runMigrations,
  SchemaAheadError,
  SchemaBehindError,
} from '../../src/db/migrate';
import {
  createLegacyDatabase,
  LEGACY_MIGRATION_STAMPS,
} from '../support/legacy-database';
import { captureLogs } from '../support/log-capture';
import { schemaDrift } from '../support/schema-drift';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { createTestApp, TestApp } from './harness';
import { silentLogger } from './logger';

/**
 * src/db/migrate.ts on the three kinds of database it meets: one built by the
 * legacy MikroORM migrations (production's, as legacy-database.ts rebuilds it), one that stopped short of them,
 * and a fresh one; one ahead of the build (a rollback, #651); plus two
 * runners racing on the same database. The app
 * boots once, on the legacy database (one app per spec file); the other
 * cases call the runner directly, which is all the boot does with it.
 */

function configOf(env: Record<string, string>): DbConfig {
  return {
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT),
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASS,
    ssl: false,
  };
}

async function withClient<T>(
  env: Record<string, string>,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(connectionOptions(configOf(env)));
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

const drizzleRows = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ hash: string; created_at: string }>(
      'select hash, created_at from drizzle.__drizzle_migrations order by id',
    );
    return rows.map((row) => ({
      hash: row.hash,
      createdAt: Number(row.created_at),
    }));
  });

const tableExists = (env: Record<string, string>, name: string) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      'select to_regclass($1) is not null as exists',
      [name],
    );
    return rows[0].exists;
  });

const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
const [baseline] = migrations;
/** Every migration in drizzle/, as drizzle records them once applied. */
const allRecorded = migrations.map((migration) => ({
  hash: migration.hash,
  createdAt: migration.folderMillis,
}));

/** A migration no file in drizzle/ is: what a newer build would record. */
const UNKNOWN_AT = migrations[migrations.length - 1].folderMillis + 1;

async function recordUnknownMigration(env: Record<string, string>) {
  await withClient(env, (client) =>
    client.query(
      'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
      ['unknown', UNKNOWN_AT],
    ),
  );
}

// The operator's rollback (docs/operations.md#migrations-and-rollback):
// after the down script, the newer build's rows go.
async function forgetUnknownMigration(env: Record<string, string>) {
  await withClient(env, (client) =>
    client.query(
      'delete from drizzle.__drizzle_migrations where created_at = $1',
      [UNKNOWN_AT],
    ),
  );
}

it('knows the newest legacy migration', () => {
  expect(LEGACY_MIGRATION_STAMPS.at(-1)).toBe(LAST_LEGACY_MIGRATION);
});

describe('a database built by the legacy MikroORM migrations', () => {
  let t: TestApp;
  let databaseEnv: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp(
      {},
      {
        beforeBoot: async (env) => {
          databaseEnv = env;
          await createLegacyDatabase(env);
          // Production has rows; the boot must leave them alone.
          await withClient(env, (client) =>
            client.query(
              `insert into "user" (shareable_id, email, password) values ('legacy-share-id', 'legacy@example.com', 'x')`,
            ),
          );
        },
      },
    );
  });

  afterAll(() => t?.cleanup());

  it('records the baseline exactly as drizzle would, without running it, then applies the rest', async () => {
    // Running it would have failed the boot: its CREATE TABLEs exist.
    expect(await drizzleRows(databaseEnv)).toEqual(allRecorded);
    expect(allRecorded[0]).toEqual({
      hash: baseline.hash,
      createdAt: baseline.folderMillis,
    });
    expect(await tableExists(databaseEnv, 'mikro_orm_migrations')).toBe(true);
  });

  it('matches src/db/schema.ts', async () => {
    expect(await schemaDrift(t.db)).toEqual([]);
  });

  it('keeps the existing rows and serves requests', async () => {
    const legacy = await t.db.query.user.findFirst({
      where: (user, { eq }) => eq(user.email, 'legacy@example.com'),
    });
    expect(legacy?.password).toBe('x');
    // Ready: the baseline recorded without running counts as applied.
    const res = await t.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.migrations.status).toBe('up');
  });

  it('is current for the CLIs once booted', async () => {
    await expect(
      requireCurrentSchema(configOf(databaseEnv)),
    ).resolves.toBeUndefined();
  });

  it('does nothing on the next boot', async () => {
    const { logger, logs } = captureLogs();
    await runMigrations(configOf(databaseEnv), logger);
    expect(await drizzleRows(databaseEnv)).toEqual(allRecorded);
    expect(logs.messages('info')).toEqual([
      `Schema up to date (${migrations.length} Drizzle migrations recorded)`,
    ]);
  });

  // A newer build migrating the database under this running one.
  it('is not ready once the database is ahead of it', async () => {
    await recordUnknownMigration(databaseEnv);
    try {
      const res = await t.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks.migrations).toEqual({
        status: 'down',
        required: true,
        schema: 'ahead',
        fix: 'see docs/operations.md#migrations-and-rollback',
      });
    } finally {
      await forgetUnknownMigration(databaseEnv);
    }
  });
});

describe('a database ahead of this build (an older image rolled back onto it)', () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase('closet_it', { migrated: true });
    await recordUnknownMigration(database.env);
  });

  afterAll(() => database?.drop());

  it('refuses the boot, naming the newest migration', async () => {
    const boot = createTestApp(
      {},
      { migrated: true, beforeBoot: recordUnknownMigration },
    );
    await expect(boot).rejects.toBeInstanceOf(SchemaAheadError);
    await expect(boot).rejects.toThrow(
      `The database's newest migration (journal when ${UNKNOWN_AT}, generated ${new Date(UNKNOWN_AT).toISOString()}) is not in this build`,
    );
  });

  it('writes nothing when it refuses', async () => {
    const run = runMigrations(configOf(database.env), silentLogger);
    await expect(run).rejects.toMatchObject({
      name: 'SchemaAheadError',
      newestAt: UNKNOWN_AT,
    });
    expect(await drizzleRows(database.env)).toEqual([
      ...allRecorded,
      { hash: 'unknown', createdAt: UNKNOWN_AT },
    ]);
  });

  it('is refused by the CLIs until the rollback forgets the newer rows', async () => {
    await expect(
      requireCurrentSchema(configOf(database.env)),
    ).rejects.toBeInstanceOf(SchemaAheadError);
    await forgetUnknownMigration(database.env);
    await expect(
      requireCurrentSchema(configOf(database.env)),
    ).resolves.toBeUndefined();
  });
});

describe('a legacy database without the last MikroORM migration', () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase('closet_it');
    await createLegacyDatabase(database.env, { complete: false });
  });

  afterAll(() => database?.drop());

  it('refuses to migrate, naming the missing migration', async () => {
    const run = runMigrations(configOf(database.env), silentLogger);
    await expect(run).rejects.toBeInstanceOf(LegacyMigrationsIncompleteError);
    await expect(run).rejects.toThrow(LAST_LEGACY_MIGRATION);
    expect(
      await tableExists(database.env, 'drizzle.__drizzle_migrations'),
    ).toBe(false);
  });

  it('is behind by every Drizzle migration for the CLIs', async () => {
    await expect(
      requireCurrentSchema(configOf(database.env)),
    ).rejects.toMatchObject({
      name: 'SchemaBehindError',
      pending: migrations.length,
    });
  });
});

describe('a fresh database', () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase('closet_it');
  });

  afterAll(() => database?.drop());

  it('runs the baseline and every later migration', async () => {
    const behind = requireCurrentSchema(configOf(database.env));
    await expect(behind).rejects.toBeInstanceOf(SchemaBehindError);
    await expect(behind).rejects.toThrow(
      `The database is ${migrations.length} migration(s) behind this build.`,
    );
    const { logger, logs } = captureLogs();
    await runMigrations(configOf(database.env), logger);
    expect(await drizzleRows(database.env)).toEqual(allRecorded);
    expect(logs.messages('info')).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Applied ${migrations.length} Drizzle migration\\(s\\) in \\d+ ms$`,
        ),
      ),
    ]);
    await expect(
      requireCurrentSchema(configOf(database.env)),
    ).resolves.toBeUndefined();
    const db = createDb(configOf(database.env), silentLogger);
    try {
      expect(await schemaDrift(db)).toEqual([]);
    } finally {
      await db.$client.end();
    }
  });
});

describe('two runners on one fresh database', () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase('closet_it');
  });

  afterAll(() => database?.drop());

  // Without the lock both would read an empty history and run the baseline;
  // the second would fail on tables the first created.
  it('migrate one after the other', async () => {
    const first = captureLogs();
    const second = captureLogs();
    // Hold the lock so both runners are provably waiting on it, then let go.
    await withClient(database.env, async (holder) => {
      await holder.query('select pg_advisory_lock(hashtext($1))', [
        MIGRATION_LOCK_KEY,
      ]);
      const runs = Promise.all([
        runMigrations(configOf(database.env), first.logger),
        runMigrations(configOf(database.env), second.logger),
      ]);
      await expect
        .poll(() => [
          ...first.logs.messages('info'),
          ...second.logs.messages('info'),
        ])
        .toEqual([
          'Another process is migrating this database; waiting for it',
          'Another process is migrating this database; waiting for it',
        ]);
      await holder.query('select pg_advisory_unlock(hashtext($1))', [
        MIGRATION_LOCK_KEY,
      ]);
      await runs;
    });
    expect(await drizzleRows(database.env)).toEqual(allRecorded);
    const outcomes = [
      first.logs.messages('info').at(-1),
      second.logs.messages('info').at(-1),
    ].sort();
    expect(outcomes).toEqual([
      expect.stringMatching(
        new RegExp(`^Applied ${migrations.length} Drizzle migration\\(s\\)`),
      ),
      `Schema up to date (${migrations.length} Drizzle migrations recorded)`,
    ]);
  });
});
