import { isDeletedClientId } from './errors';

/**
 * The one shape of an idempotent create (the API's `clientId`, a create an
 * offline client retries after losing its answer): the row is stored with
 * its client id, and the table's `(owner, client_id)` unique constraint is
 * the arbiter, never a read before the insert (two twins would both read
 * nothing).
 *
 * `insert` writes with `on conflict (owner, client_id) do nothing` and
 * returns the new row, or undefined when the owner's row of that id exists
 * already; `find` then returns that first row. A concurrent twin waits on
 * the owner lock inside `insert`, so `find` sees the first one's row. The
 * sync triggers raise CL410 for the id of a row deleted since
 * (sync_tombstone, drizzle/0052_sync-triggers.sql): 'gone', never created
 * again. Any other error, a name's unique violation included, is the
 * caller's.
 *
 * Used by garments, brand sizes, capsules and trips. Outfits and calendar
 * entries are idempotent by their own key (a garment set, an outfit on a
 * day) and do not store the id.
 */
export async function createOnce<Row>(
  insert: () => Promise<Row | undefined>,
  find: () => Promise<Row | undefined>,
): Promise<{ row: Row; created: boolean } | 'gone'> {
  try {
    const created = await insert();
    if (created !== undefined) return { row: created, created: true };
    const first = await find();
    return first === undefined ? 'gone' : { row: first, created: false };
  } catch (error) {
    if (isDeletedClientId(error)) return 'gone';
    throw error;
  }
}
