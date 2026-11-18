import { describe, expect, it } from 'vitest';
import { pruneOrphanRows } from '../views/assets/expiration-rows';

const ORIGIN = 'https://closet.test';
const IMAGES = 'images-v2';
const url = (path: string) => `${ORIGIN}${path}`;

interface Row {
  id: string;
  cacheName: string;
  url: string;
  timestamp: number;
}

/**
 * The `workbox-expiration` database over a Map, with the slice of
 * IndexedDB the sweep uses: requests answer in a microtask, a transaction
 * completes once its requests (and those their handlers made) have.
 */
function fakeExpirationDb(existing = true) {
  const rows = new Map<string, Row>();
  const schema: { store?: string; keyPath?: unknown; indexes: string[] } = {
    indexes: [],
  };
  let closed = 0;

  const transaction = () => {
    let pending = 0;
    const tx = {
      oncomplete: undefined as undefined | (() => void),
      onerror: undefined as undefined | (() => void),
      onabort: undefined as undefined | (() => void),
      error: null,
    };
    const finish = () =>
      setTimeout(() => {
        if (pending === 0) tx.oncomplete?.();
      });
    const request = <T>(result: () => T) => {
      pending += 1;
      const req = { result: undefined as T | undefined, onsuccess: undefined };
      queueMicrotask(() => {
        req.result = result();
        (req.onsuccess as undefined | (() => void))?.();
        pending -= 1;
        finish();
      });
      return req;
    };
    const store = {
      index: (name: string) => ({
        getAll: (value: string) =>
          request(() =>
            [...rows.values()].filter(
              (row) => row[name as keyof Row] === value,
            ),
          ),
      }),
      get: (id: string) => request(() => rows.get(id)),
      delete: (id: string) => request(() => rows.delete(id)),
    };
    finish();
    return Object.assign(tx, { objectStore: () => store });
  };

  const db = {
    transaction,
    close: () => {
      closed += 1;
    },
    createObjectStore: (name: string, options: { keyPath: unknown }) => {
      schema.store = name;
      schema.keyPath = options.keyPath;
      return {
        createIndex: (index: string) => schema.indexes.push(index),
      };
    },
  };

  const factory = {
    open: (name: string, version?: number) => {
      expect([name, version]).toEqual(['workbox-expiration', 1]);
      const req = {
        result: db,
        onupgradeneeded: undefined as undefined | (() => void),
        onsuccess: undefined as undefined | (() => void),
        onerror: undefined,
      };
      queueMicrotask(() => {
        if (!existing) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  };

  /** A row as ExpirationPlugin's cacheDidUpdate writes one. */
  const stamp = (cacheName: string, at: string, timestamp: number) =>
    rows.set(`${cacheName}|${at}`, {
      id: `${cacheName}|${at}`,
      cacheName,
      url: at,
      timestamp,
    });

  return { factory, rows, schema, stamp, closed: () => closed };
}

/** CacheStorage over sets; `onKeys` runs as a cache's keys are read. */
function fakeCaches(onKeys?: () => void) {
  const caches = new Map<string, Set<string>>();
  const opened: string[] = [];
  return {
    caches,
    opened,
    storage: {
      has: (name: string) => Promise.resolve(caches.has(name)),
      open: (name: string) => {
        opened.push(name);
        const cache = caches.get(name) ?? new Set<string>();
        caches.set(name, cache);
        return Promise.resolve({
          keys: () => {
            const keys = [...cache].map((key) => ({ url: key }));
            onKeys?.();
            return Promise.resolve(keys);
          },
        });
      },
    },
  };
}

const NOW = 10_000;

describe('pruneOrphanRows: an expiration row without its entry (#1155)', () => {
  it('deletes the row of a stale image imageStore deleted, so maxEntries counts only real entries', async () => {
    const db = fakeExpirationDb();
    const { caches, storage } = fakeCaches();
    caches.set(IMAGES, new Set([url('/file/a'), url('/file/b')]));
    db.stamp(IMAGES, url('/file/a'), 1);
    db.stamp(IMAGES, url('/file/b'), 2);
    // Stored across a drop: imageStore deleted the entry, the plugin after it wrote the row.
    db.stamp(IMAGES, url('/file/stale'), 3);
    db.stamp('pages-v2', url('/wardrobe'), 4);

    expect(await pruneOrphanRows(db.factory, storage, IMAGES, () => NOW)).toBe(
      1,
    );
    const imageRows = [...db.rows.values()].filter(
      (r) => r.cacheName === IMAGES,
    );
    expect(imageRows.map((r) => r.url).sort()).toEqual(
      [...caches.get(IMAGES)!].sort(),
    );
    // Another cache's rows are not this sweep's.
    expect(db.rows.has(`pages-v2|${url('/wardrobe')}`)).toBe(true);
    expect(db.closed()).toBe(1);
  });

  it('keeps the row a store writes during the sweep, under a URL it found missing', async () => {
    const db = fakeExpirationDb();
    const stale = url('/file/again');
    db.stamp(IMAGES, stale, 1);
    // A current store of the same URL lands after the keys were read: its row is stamped now.
    const { caches, storage } = fakeCaches(() => {
      caches.get(IMAGES)!.add(stale);
      db.stamp(IMAGES, stale, NOW);
    });
    caches.set(IMAGES, new Set());

    expect(await pruneOrphanRows(db.factory, storage, IMAGES, () => NOW)).toBe(
      0,
    );
    expect(db.rows.get(`${IMAGES}|${stale}`)?.timestamp).toBe(NOW);
  });

  it('never creates a cache that is gone; a database it creates gets Workbox’s schema', async () => {
    const gone = fakeExpirationDb();
    const { storage, opened } = fakeCaches();
    gone.stamp(IMAGES, url('/file/a'), 1);
    expect(
      await pruneOrphanRows(gone.factory, storage, IMAGES, () => NOW),
    ).toBe(1);
    expect(opened).toEqual([]);

    const fresh = fakeExpirationDb(false);
    expect(
      await pruneOrphanRows(fresh.factory, storage, IMAGES, () => NOW),
    ).toBe(0);
    expect(fresh.schema).toEqual({
      store: 'cache-entries',
      keyPath: 'id',
      indexes: ['cacheName', 'timestamp'],
    });
  });
});
