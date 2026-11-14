import { describe, expect, it } from 'vitest';
import { StoreGate } from './store-gate';

// A session cache and its expiration rows, written in the two steps Workbox
// takes (the put, then ExpirationPlugin's row), and dropped as the worker
// does (rows, then the cache).
function sessionCache(gate: StoreGate) {
  const entries = new Set<string>();
  const rows = new Set<string>();
  return {
    entries,
    rows,
    async store(url: string, arrives: Promise<void>): Promise<void> {
      await arrives;
      const release = gate.begin();
      if (!release) return;
      try {
        entries.add(url);
        await Promise.resolve();
        rows.add(url);
      } finally {
        release();
      }
    },
    drop: () =>
      gate.emptying(async () => {
        rows.clear();
        await Promise.resolve();
        entries.clear();
      }),
  };
}

describe('StoreGate', () => {
  it('a store admitted before a drop finishes first, so the drop leaves neither entry nor row', async () => {
    const gate = new StoreGate();
    const cache = sessionCache(gate);
    // Held between admission and its row, as a slow put is.
    let finish!: () => void;
    const held = gate.begin()!;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => {
      cache.entries.add('/file/a');
      cache.rows.add('/file/a');
      held();
    });

    const drop = cache.drop();
    let dropped = false;
    void drop.then(() => {
      dropped = true;
    });
    await Promise.resolve();
    expect(dropped).toBe(false);

    finish();
    await slow;
    await drop;
    expect([...cache.entries, ...cache.rows]).toEqual([]);
  });

  it('a store that arrives while a drop is emptying is refused, not written', async () => {
    const gate = new StoreGate();
    const cache = sessionCache(gate);
    let arrive!: () => void;
    const late = cache.store(
      '/file/b',
      new Promise<void>((resolve) => {
        arrive = resolve;
      }),
    );
    const drop = cache.drop();
    arrive();
    await late;
    await drop;
    expect([...cache.entries, ...cache.rows]).toEqual([]);
    await gate.idle();
    expect(gate.begin()).toBeTypeOf('function');
  });

  it('idle waits for the drop in progress', async () => {
    const gate = new StoreGate();
    let finish!: () => void;
    const drop = gate.emptying(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let idle = false;
    void gate.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    finish();
    await drop;
    await gate.idle();
    expect(idle).toBe(true);
  });

  it('a failed drop still lets stores in again', async () => {
    const gate = new StoreGate();
    await expect(
      gate.emptying(() => Promise.reject(new Error('quota'))),
    ).rejects.toThrow('quota');
    await gate.idle();
    expect(gate.begin()).toBeTypeOf('function');
  });
});
