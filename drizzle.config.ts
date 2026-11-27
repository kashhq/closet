import { defineConfig } from 'drizzle-kit';
import { readFileSync } from 'node:fs';
import { databaseSslMode } from './src/config';
import { sslOption } from './src/db/client';

// drizzle-kit only (`npx drizzle-kit generate`, `pull`, `studio`); the app
// never reads this file. `generate` diffs src/db/schema.ts against the last
// snapshot in drizzle/meta and needs no database. Commands that do connect
// default to closet_db on a local Postgres (localhost:5432, trust auth); the
// DATABASE_* env vars point them elsewhere, as they do for the app (TLS with
// the app's own modes; DATABASE_SCHEMA is the app's deprecated alias).
const sslMode = databaseSslMode(process.env.DATABASE_SSL ?? 'off');
if (sslMode === undefined) {
  throw new Error('DATABASE_SSL: must be one of verify, no-verify, off');
}
// Read only under verify, as the app (src/config.ts refuses it elsewhere).
const sslCa =
  sslMode === 'verify' ? process.env.DATABASE_SSL_CA || undefined : undefined;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASS,
    database:
      process.env.DATABASE_NAME ?? process.env.DATABASE_SCHEMA ?? 'closet_db',
    ssl: sslOption(sslMode, sslCa ? readFileSync(sslCa, 'utf8') : undefined),
  },
  // The legacy MikroORM bookkeeping table stays in databases built before
  // Drizzle (production); it is not part of the schema. Keep in step with
  // the drift test (test/integration/migrations.spec.ts).
  tablesFilter: ['!mikro_orm_migrations'],
  strict: true,
  verbose: true,
});
