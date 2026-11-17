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
 *    same row. `outsideExpiration` names the entries no ExpirationPlugin
 *    governs (the worker's records, the offline page), which never get one.
 *
 * Which stores may happen at all is the generation and owner checks'
 * business (pageStore's claim, imageStore), not this delete's. Whether the
 * cache existed, and how many entries step 2 gave a row.
 */
export async function dropCacheAndRows(
  caches: DroppableCaches,
  name: string,
  rows: ExpirationRows,
  outsideExpiration: (url: string) => boolean,
): Promise<{ deleted: boolean; adopted: number }> {
  await rows.delete();
  const deleted = await caches.delete(name);
  await rows.delete();
  // Never open a cache nothing recreated: open() would create it.
  if (!(await caches.has(name))) return { deleted, adopted: 0 };
  const keys = await (await caches.open(name)).keys();
  const unruled = keys
    .map((request) => request.url)
    .filter((url) => !outsideExpiration(url));
  for (const url of unruled) await rows.updateTimestamp(url);
  return { deleted, adopted: unruled.length };
}
