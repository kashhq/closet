/**
 * Workbox's expiration rows without their cache entry, swept once per
 * activate (#1155, src/web/shell/session-caches.md, Generations). The
 * service worker's only direct reader of the `workbox-expiration` database.
 *
 * Why it exists: imageStore deletes an image stored across a drop in its
 * cacheDidUpdate, and the ExpirationPlugin after it in the list then writes
 * that URL's row. Workbox 7 has no per-URL row delete (CacheExpiration only
 * expires by age or count, or forgets a whole cache), so the row outlived
 * its entry and counted toward maxEntries, evicting real entries early.
 */

import type { DroppableCaches } from '../../src/web/shell/cache-drop';

// workbox-expiration 7's own definition (models/CacheTimestampsModel.ts):
// rows keyed `id` (`<cacheName>|<url>`), indexed by cacheName and timestamp.
// Opened at its version with its upgrade, so whichever of the two opens the
// database first creates the same schema. A later Workbox that bumps the
// version makes this open fail (VersionError): logged, nothing swept.
const DB_NAME = 'workbox-expiration';
const DB_VERSION = 1;
const STORE = 'cache-entries';

interface ExpirationRow {
  id: string;
  cacheName: string;
  url: string;
  timestamp: number;
}

/** The slice of IDBFactory the sweep uses, so a spec can hand it a stand-in. */
export type ExpirationFactory = Pick<IDBFactory, 'open'>;

function openRows(factory: ExpirationFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('cacheName', 'cacheName', { unique: false });
      store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

/** Runs `work` in a transaction over the rows; settled when it commits. */
function transact(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    work(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('transaction failed'));
  });
}

/**
 * Deletes `cacheName`'s rows whose URL the cache does not hold. How many.
 *
 * Stores keep landing meanwhile (Workbox puts the entry, then writes its
 * row), so the order is what makes it safe: the moment `now()`, then the
 * rows, then the cache's keys; a row goes only if its URL was missing from
 * those keys and it is still stamped before that moment when its delete
 * runs. A row stamped before the moment had its entry put before the keys
 * were read, so its absence there is real; a store landing during the sweep
 * stamps its row later and keeps it, even under a URL just found missing.
 */
export async function pruneOrphanRows(
  factory: ExpirationFactory,
  caches: Pick<DroppableCaches, 'has' | 'open'>,
  cacheName: string,
  now: () => number,
): Promise<number> {
  const before = now();
  const db = await openRows(factory);
  try {
    let rows: ExpirationRow[] = [];
    await transact(db, 'readonly', (store) => {
      const request = store.index('cacheName').getAll(cacheName);
      request.onsuccess = () => {
        rows = request.result as ExpirationRow[];
      };
    });
    if (rows.length === 0) return 0;
    // Never open a cache nothing created: open() would create it.
    const cached = (await caches.has(cacheName))
      ? new Set(
          (await (await caches.open(cacheName)).keys()).map((key) => key.url),
        )
      : new Set<string>();
    const orphans = rows.filter(
      (row) => row.timestamp < before && !cached.has(row.url),
    );
    if (orphans.length === 0) return 0;
    let pruned = 0;
    await transact(db, 'readwrite', (store) => {
      for (const orphan of orphans) {
        const request = store.get(orphan.id);
        request.onsuccess = () => {
          const row = request.result as ExpirationRow | undefined;
          if (!row || row.timestamp >= before) return;
          store.delete(orphan.id);
          pruned += 1;
        };
      }
    });
    return pruned;
  } finally {
    db.close();
  }
}
