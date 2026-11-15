/**
 * The outbox's IndexedDB store and its change channel (#178,
 * src/web/shell/outbox.md), shared by the page's outbox (outbox.ts) and the
 * service worker (src-sw.ts), which only deletes records at session
 * boundaries. One definition on purpose: whichever opens the database first
 * creates it, and an open without the schema's upgrade would leave version 1
 * with no store, which the other could then never add.
 */

const DB_NAME = 'closet-outbox';
const DB_VERSION = 1;
export const OUTBOX_STORE = 'writes';
const CHANNEL = 'closet-outbox';

/** What every write announces on the channel. */
export interface OutboxChange {
  /** A put: a tab that can reach the server should drain it. */
  drain: boolean;
  /** The paths a drain saved: a tab showing one takes the server's copy (#900). */
  synced?: string[];
}

/** The slice of IDBFactory the store uses, so a spec can hand it a stub. */
export type OutboxFactory = Pick<IDBFactory, 'open'>;

/** What a connection the browser closed (or evicted) throws at a transaction's start. */
const STALE_HANDLE_ERRORS = new Set(['InvalidStateError', 'UnknownError']);

function openDatabase(
  factory: OutboxFactory,
  onBlocked: () => void,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(OUTBOX_STORE, {
        keyPath: 'id',
      });
      store.createIndex('key', 'key');
      store.createIndex('account', 'account');
    };
    request.onblocked = onBlocked;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

/** Runs `work` in a started transaction; settled when it commits. */
function settle(
  transaction: IDBTransaction,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    work(transaction.objectStore(OUTBOX_STORE));
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('transaction failed'));
  });
}

export interface OutboxConnection {
  /**
   * One transaction over the store, settled when it commits. A handle the
   * browser closed under us (WebKit's "Connection to Indexed Database server
   * lost", storage eviction) throws at the transaction's start: it is
   * reopened and the transaction retried once; a second failure rejects.
   */
  transact(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => void,
  ): Promise<void>;
}

/**
 * The one owner of the page's (and the worker's) connection: opened on first
 * use and shared by concurrent callers, forgotten when it fails to open, when
 * the browser closes it (`close`) and when another context wants to upgrade
 * the database (`versionchange`: closed here too, or the upgrade would wait on
 * this tab forever). The next call opens afresh. Tabs of older builds never
 * close on `versionchange`, which is why #871 kept the version at 1: a bump
 * would stay blocked behind them (`onblocked` only logs; the open waits).
 */
export function createOutboxConnection(
  factory: OutboxFactory,
): OutboxConnection {
  let current: IDBDatabase | undefined;
  let shared: Promise<IDBDatabase> | undefined;

  const forget = (db: IDBDatabase) => {
    if (current !== db) return;
    current = undefined;
    shared = undefined;
  };

  const open = (): Promise<IDBDatabase> => {
    if (shared) return shared;
    const attempt = openDatabase(factory, () =>
      console.warn('[outbox] the database open is blocked by another tab'),
    ).then((db) => {
      current = db;
      db.addEventListener('close', () => {
        console.warn('[outbox] the browser closed the database; reopening');
        forget(db);
      });
      db.addEventListener('versionchange', () => {
        console.warn('[outbox] another context upgrades the database');
        forget(db);
        db.close();
      });
      return db;
    });
    shared = attempt;
    attempt.catch(() => {
      if (shared === attempt) shared = undefined;
    });
    return attempt;
  };

  return {
    async transact(mode, work) {
      const db = await open();
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(OUTBOX_STORE, mode);
      } catch (error) {
        if (!(error instanceof Error) || !STALE_HANDLE_ERRORS.has(error.name)) {
          throw error;
        }
        console.warn(`[outbox] ${error.name} at transaction start; reopening`);
        // An UnknownError handle may still be open: close it so two connections
        // never coexist (and a versionchange upgrade is not held up by it).
        try {
          db.close();
        } catch {
          // already closed
        }
        forget(db);
        transaction = (await open()).transaction(OUTBOX_STORE, mode);
      }
      await settle(transaction, work);
    },
  };
}

/** The page's and the worker's connection to the real database. */
export const outbox = createOutboxConnection({
  open: (name, version) => indexedDB.open(name, version),
});

/**
 * The channel every tab of the origin and the worker share; absent where
 * BroadcastChannel is (iOS before 15.4), where tabs catch up at their next
 * visibilitychange.
 */
export function openOutboxChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(CHANNEL)
    : undefined;
}
