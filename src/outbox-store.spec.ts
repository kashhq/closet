import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOutboxConnection,
  dropQueuedWrites,
  type DroppableRecord,
} from '../views/assets/outbox-store';
import { DISCARD_TOMBSTONE_MS } from './offline-writes';

/**
 * A minimal IndexedDB: one store shared by every handle of the "database"
 * (records survive a handle's closing, as on disk), with the transaction
 * surface the store uses. A closed handle throws at transaction().
 */
class FakeDatabase extends EventTarget {
  closed = false;
  constructor(
    private readonly records: string[],
    private readonly failStarts: { name: string[] },
  ) {
    super();
  }

  close(): void {
    this.closed = true;
  }

  /** The browser closing the connection: the flag, then the event. */
  browserClose(): void {
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }

  transaction(): IDBTransaction {
    const failure = this.failStarts.name.shift();
    if (failure) throw new DOMException('start failed', failure);
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    const records = this.records;
    const transaction = {
      oncomplete: undefined as undefined | (() => void),
      objectStore: () => ({
        put: (value: string) => {
          records.push(value);
          queueMicrotask(() => transaction.oncomplete?.());
        },
        getAll: () => {
          const request = {
            result: [...records],
            onsuccess: undefined as undefined | (() => void),
          };
          queueMicrotask(() => {
            request.onsuccess?.();
            transaction.oncomplete?.();
          });
          return request;
        },
      }),
    };
    return transaction as unknown as IDBTransaction;
  }
}

function fakeFactory() {
  const records: string[] = [];
  const failStarts = { name: [] as string[] };
  const handles: FakeDatabase[] = [];
  const opens = { failNext: 0 };
  const factory = {
    open: () => {
      const db = new FakeDatabase(records, failStarts);
      handles.push(db);
      const request = {
        result: db,
        error: new Error('open failed'),
        onsuccess: undefined as undefined | (() => void),
        onerror: undefined as undefined | (() => void),
      };
      const fails = opens.failNext > 0;
      if (fails) opens.failNext -= 1;
      queueMicrotask(() => (fails ? request.onerror : request.onsuccess)?.());
      return request as unknown as IDBOpenDBRequest;
    },
  };
  return { factory, records, failStarts, handles, opens };
}

async function read(connection: ReturnType<typeof createOutboxConnection>) {
  let found: string[] = [];
  await connection.transact('readonly', (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      found = request.result as string[];
    };
  });
  return found;
}

const put = (
  connection: ReturnType<typeof createOutboxConnection>,
  value: string,
) =>
  connection.transact('readwrite', (store) => {
    store.put(value);
  });

describe('createOutboxConnection', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('reopens after the browser closes the connection and returns the stored records', async () => {
    const { factory, handles } = fakeFactory();
    const connection = createOutboxConnection(factory);
    await put(connection, 'a');
    handles[0].browserClose();
    expect(await read(connection)).toEqual(['a']);
    expect(handles).toHaveLength(2);
  });

  it('forgets an open that failed, so the next call retries', async () => {
    const { factory, opens, handles } = fakeFactory();
    const connection = createOutboxConnection(factory);
    opens.failNext = 1;
    await expect(put(connection, 'a')).rejects.toThrow('open failed');
    await put(connection, 'b');
    expect(await read(connection)).toEqual(['b']);
    expect(handles).toHaveLength(2);
  });

  it('shares one open between concurrent callers', async () => {
    const { factory, handles } = fakeFactory();
    const connection = createOutboxConnection(factory);
    await Promise.all([put(connection, 'a'), put(connection, 'b')]);
    expect(handles).toHaveLength(1);
  });

  it.each(['InvalidStateError', 'UnknownError'])(
    'retries a %s at transaction start once on a fresh handle',
    async (name) => {
      const { factory, failStarts, handles, records } = fakeFactory();
      const connection = createOutboxConnection(factory);
      await put(connection, 'a');
      failStarts.name.push(name);
      await put(connection, 'b');
      expect(records).toEqual(['a', 'b']);
      expect(handles).toHaveLength(2);
      expect(handles[0].closed).toBe(true);
    },
  );

  it('surfaces a second failure', async () => {
    const { factory, failStarts } = fakeFactory();
    const connection = createOutboxConnection(factory);
    await put(connection, 'a');
    failStarts.name.push('InvalidStateError', 'InvalidStateError');
    await expect(put(connection, 'b')).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('does not retry another error', async () => {
    const { factory, failStarts, handles } = fakeFactory();
    const connection = createOutboxConnection(factory);
    await put(connection, 'a');
    failStarts.name.push('NotFoundError');
    await expect(put(connection, 'b')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    expect(handles).toHaveLength(1);
  });

  it('closes and forgets the handle on versionchange', async () => {
    const { factory, handles } = fakeFactory();
    const connection = createOutboxConnection(factory);
    await put(connection, 'a');
    handles[0].dispatchEvent(new Event('versionchange'));
    expect(handles[0].closed).toBe(true);
    expect(await read(connection)).toEqual(['a']);
    expect(handles).toHaveLength(2);
  });
});

describe('dropQueuedWrites', () => {
  const record = (
    id: string,
    account: string,
    extra: Partial<DroppableRecord> = {},
  ): DroppableRecord => ({
    id,
    account,
    key: `wash:${id}`,
    state: 'pending',
    attempts: 0,
    label: 'Navy chinos',
    ...extra,
  });

  /** The store's rows behind getAll and a cursor, with every transaction's mode. */
  function fakeTransact(initial: DroppableRecord[]) {
    let rows = [...initial];
    const modes: IDBTransactionMode[] = [];
    const transact = (
      mode: IDBTransactionMode,
      work: (store: IDBObjectStore) => void,
    ) => {
      modes.push(mode);
      const store = {
        getAll: () => {
          const request = {
            result: [...rows],
            onsuccess: undefined as undefined | (() => void),
          };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
        openCursor: () => {
          const snapshot = [...rows];
          let at = 0;
          const request = {
            result: undefined as unknown,
            onsuccess: undefined as undefined | (() => void),
          };
          const step = () => {
            const value = snapshot[at];
            request.result = value && {
              value,
              update: (next: DroppableRecord) => {
                rows = rows.map((r) => (r.id === value.id ? next : r));
              },
              delete: () => {
                rows = rows.filter((r) => r.id !== value.id);
              },
              continue: () => {
                at += 1;
                queueMicrotask(step);
              },
            };
            request.onsuccess?.();
          };
          queueMicrotask(step);
          return request;
        },
      };
      work(store as unknown as IDBObjectStore);
      // Settles after the microtasks the work queued (the cursor's steps).
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    return { transact, modes, rows: () => rows };
  }

  it('a claim with nothing to drop or prune opens no readwrite transaction', async () => {
    const own = record('a', '1');
    const fresh = record('b', '2', { state: 'discarded', discardedAt: 1_000 });
    const { transact, modes, rows } = fakeTransact([own, fresh]);
    // Account 1's claim: 2's only record is a tombstone too fresh to prune.
    const counts = await dropQueuedWrites(
      transact,
      (r) => r.account !== '1',
      2_000,
    );
    expect(counts).toEqual({ dropped: 0, pruned: 0 });
    expect(modes).toEqual(['readonly']);
    expect(rows()).toEqual([own, fresh]);
  });

  it('tombstones what it names and prunes expired tombstones in one readwrite', async () => {
    const own = record('a', '1');
    const other = record('b', '2');
    const expired = record('c', '3', { state: 'discarded', discardedAt: 0 });
    const { transact, modes, rows } = fakeTransact([own, other, expired]);
    const counts = await dropQueuedWrites(
      transact,
      (r) => r.account !== '1',
      DISCARD_TOMBSTONE_MS,
    );
    expect(counts).toEqual({ dropped: 1, pruned: 1 });
    expect(modes).toEqual(['readonly', 'readwrite']);
    expect(rows()).toMatchObject([
      own,
      { id: 'b', state: 'discarded', label: '' },
    ]);
  });
});
