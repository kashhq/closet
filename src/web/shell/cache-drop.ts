/**
 * Deleting a whole cache together with Workbox's expiration rows for it
 * (views/assets/src-sw.ts bundles this file: keep it free of Node and DOM;
 * src/web/shell/session-caches.md, Generations). Every whole-cache delete in
 * the worker goes through here, the session drop's above all.
 */

/** The slice of CacheStorage a drop uses, so a spec can hand it a stand-in. */
export interface DroppableCaches {
  delete(name: string): Promise<boolean>;
  has(name: string): Promise<boolean>;
  open(name: string): Promise<{ keys(): Promise<readonly { url: string }[]> }>;
}

/**
 * A cache's rows in the `workbox-expiration` IndexedDB: Workbox's
 * `CacheExpiration` for that cache satisfies it as it is.
 */
export interface ExpirationRows {
  /** Forgets every row of the cache. */
  delete(): Promise<void>;
  /** Gives a URL its row, stamped now (or restamps it). */
  updateTimestamp(url: string): Promise<void>;
}

/**
 * Deletes the cache `name` and its expiration rows (#731: `caches.delete`
 * alone leaves every URL the account loaded in the rows, still counted
 * toward maxEntries). The two stores cannot change in one step, and stores
 * keep landing (no gate holds them off: one was tried in #1023 and broke
 * the first page after a sign-in), so:
 *
 * 1. rows, then the cache, then the rows again: a row written between the
 *    first two steps has lost its entry and the second pass sweeps it
 *    (#1019);
 * 2. then every entry the recreated cache holds gets its row (#1025): a
 *    store between the cache delete and the second pass kept its entry but
 *    lost its row to that pass, and would otherwise escape maxEntries until
 *    the next drop. Restamping a store that kept its row is harmless (it is
 *    seconds old), and a store whose own row lands after ours writes the
 *    same row. `rowless` names the entries that must get none: those no
 *    ExpirationPlugin governs (the worker's records, the offline page),
 *    and those a store of an ended generation is about to delete
 *    (`createStoreFlights`), whose row would outlive its entry.
 *
 * Which stores may happen at all is the generation and owner checks'
 * business (pageStore's claim, imageStore), not this delete's. Whether the
 * cache existed, and how many entries step 2 gave a row.
 */
export async function dropCacheAndRows(
  caches: DroppableCaches,
  name: string,
  rows: ExpirationRows,
  rowless: (url: string) => boolean,
): Promise<{ deleted: boolean; adopted: number }> {
  await rows.delete();
  const deleted = await caches.delete(name);
  await rows.delete();
  // Never open a cache nothing recreated: open() would create it.
  if (!(await caches.has(name))) return { deleted, adopted: 0 };
  const keys = await (await caches.open(name)).keys();
  const ruled = keys
    .map((request) => request.url)
    .filter((url) => !rowless(url));
  for (const url of ruled) await rows.updateTimestamp(url);
  return { deleted, adopted: ruled.length };
}

/**
 * The stores in flight and the generation each started in (src-sw.ts,
 * imageStore): one begun in handlerWillStart, ended in handlerDidComplete,
 * which Workbox runs after the store's cacheDidUpdate. A store of an ended
 * generation deletes its entry in cacheDidUpdate, so a drop's restamp
 * (`dropCacheAndRows`) must give that entry no row (`endedStore`, the same
 * test imageStore's cacheDidUpdate makes). `token` is the plugin's
 * per-request state object.
 */
export function createStoreFlights() {
  const flights = new Map<object, { url: string; generation: number }>();
  return {
    begin(token: object, url: string, generation: number): void {
      flights.set(token, { url, generation });
    },
    end(token: object): void {
      flights.delete(token);
    },
    endedStore(url: string, current: number): boolean {
      for (const flight of flights.values()) {
        if (flight.url === url && flight.generation !== current) return true;
      }
      return false;
    },
  };
}
