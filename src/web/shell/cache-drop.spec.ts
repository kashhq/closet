import { describe, expect, it } from 'vitest';
import {
  dropCacheAndRows,
  type DroppableCaches,
  type ExpirationRows,
} from './cache-drop';

const ORIGIN = 'https://closet.test';
const RECORD = 'https://page-cache.invalid/owner';
const OFFLINE = `${ORIGIN}/offline.html`;
const outsideExpiration = (url: string) =>
  !url.startsWith(ORIGIN) || url === OFFLINE;

type Step = 'rows' | 'cache';

/**
 * CacheStorage and the cache's expiration rows over plain sets. `during`
 * runs a store (an entry, then its row, as ExpirationPlugin's
 * cacheDidUpdate follows the put) right after the nth delete of a kind:
 * the windows the drop's steps leave open.
 */
class FakeStorage implements DroppableCaches {
  readonly caches = new Map<string, Set<string>>();
  readonly rows = new Set<string>();
  private readonly seen: Record<Step, number> = { rows: 0, cache: 0 };

  constructor(
    private readonly during?: { after: Step; nth: number; url: string },
  ) {}

  /** A store as Workbox makes one: the entry, then its row. */
  store(name: string, url: string, ruled = true): void {
    const cache = this.caches.get(name) ?? new Set<string>();
    cache.add(url);
    this.caches.set(name, cache);
    if (ruled) this.rows.add(url);
  }

  private stepped(step: Step): void {
    this.seen[step] += 1;
    const store = this.during;
    if (store?.after === step && store.nth === this.seen[step]) {
      this.store('pages-v2', store.url);
    }
  }

  readonly expiration: ExpirationRows = {
    delete: () => {
      this.rows.clear();
      this.stepped('rows');
      return Promise.resolve();
    },
    updateTimestamp: (url) => {
      this.rows.add(url);
      return Promise.resolve();
    },
  };

  delete(name: string): Promise<boolean> {
    const deleted = this.caches.delete(name);
    this.stepped('cache');
    return Promise.resolve(deleted);
  }

  has(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.has(name));
  }

  open(name: string) {
    const cache = this.caches.get(name) ?? new Set<string>();
    this.caches.set(name, cache);
    return Promise.resolve({
      keys: () => Promise.resolve([...cache].map((url) => ({ url }))),
    });
  }
}

const drop = (storage: FakeStorage) =>
  dropCacheAndRows(storage, 'pages-v2', storage.expiration, outsideExpiration);

/** Every entry of the cache has its row, and every row its entry (the records and offline page aside). */
function consistent(storage: FakeStorage): void {
  const ruled = [...(storage.caches.get('pages-v2') ?? [])].filter(
    (url) => !outsideExpiration(url),
  );
  expect([...storage.rows].sort()).toEqual(ruled.sort());
}

describe('dropCacheAndRows', () => {
  it('deletes the cache and its rows, creating no empty cache', async () => {
    const storage = new FakeStorage();
    storage.store('pages-v2', `${ORIGIN}/wardrobe`);
    expect(await drop(storage)).toEqual({ deleted: true, adopted: 0 });
    expect(storage.caches.has('pages-v2')).toBe(false);
    expect(storage.rows.size).toBe(0);
  });

  it('a store between the rows and the cache delete leaves no lone row (#1019)', async () => {
    const storage = new FakeStorage({
      after: 'rows',
      nth: 1,
      url: `${ORIGIN}/a`,
    });
    await drop(storage);
    expect(storage.caches.has('pages-v2')).toBe(false);
    expect(storage.rows.size).toBe(0);
  });

  it('a store between the cache delete and the second sweep keeps its entry and gets its row back (#1025)', async () => {
    const storage = new FakeStorage({
      after: 'cache',
      nth: 1,
      url: `${ORIGIN}/b`,
    });
    expect(await drop(storage)).toEqual({ deleted: false, adopted: 1 });
    expect([...(storage.caches.get('pages-v2') ?? [])]).toEqual([
      `${ORIGIN}/b`,
    ]);
    consistent(storage);
  });

  it('never gives a row to an entry no ExpirationPlugin governs', async () => {
    const storage = new FakeStorage({
      after: 'cache',
      nth: 1,
      url: `${ORIGIN}/c`,
    });
    storage.store('pages-v2', `${ORIGIN}/old`);
    // The claim's records and the offline page land in the same window.
    const stored = storage.delete.bind(storage);
    storage.delete = async (name) => {
      const deleted = await stored(name);
      storage.store('pages-v2', RECORD, false);
      storage.store('pages-v2', OFFLINE, false);
      return deleted;
    };
    expect(await drop(storage)).toEqual({ deleted: true, adopted: 1 });
    expect(storage.rows).toEqual(new Set([`${ORIGIN}/c`]));
    consistent(storage);
  });
});
