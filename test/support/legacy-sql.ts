import { Migration } from '@mikro-orm/migrations';

/**
 * One frozen MikroORM migration as its statements: each file in
 * legacy-migrations/ exports one, named as production's
 * `mikro_orm_migrations` row records it. Only `up` exists: the migration
 * specs build a database forward and never roll one back.
 * `transactional: false` is for the CONCURRENTLY index builds, which
 * Postgres refuses inside a transaction block.
 */
export function legacySql(
  statements: readonly string[],
  options: { transactional?: boolean } = {},
): new (...args: ConstructorParameters<typeof Migration>) => Migration {
  const transactional = options.transactional ?? true;
  return class extends Migration {
    override isTransactional(): boolean {
      return transactional;
    }

    override up(): void {
      for (const statement of statements) this.addSql(statement);
    }
  };
}
