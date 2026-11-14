import { describe, expect, it } from 'vitest';
import {
  dayRefusal,
  instantOnDay,
  enqueue,
  goesThroughOutbox,
  isChecklist,
  isReplayRequest,
  offlineNotice,
  packedCount,
  OUTBOX_MAX_PENDING,
  type OutboxStore,
  QUEUEABLE_ROUTES,
  type QueueableKind,
  queueableKindOf,
  queuedTarget,
  queuedWritesGoneAtClaim,
  REPLAY_WINDOW_DAYS,
  reasonTextName,
  replayVerdict,
  type ReplayDriver,
  type ReplayRecord,
  replayQueue,
  type ReplayVerdict,
  STUCK_AFTER_SERVER_ERRORS,
  STUCK_RETRY_FIRST_MS,
  STUCK_RETRY_MS,
  stuckRetryMs,
  actionBusyAttributes,
  createTurns,
  discardStuck,
  retryStuck,
  type StuckActionStore,
  isStuck,
  unstuck,
  retryDelayMs,
  routesThroughOutbox,
  showsQueuedWrite,
  type StoredRecord,
  syncedWritePaths,
  takesDay,
  takesInstant,
  tapInstant,
} from './offline-writes';

describe('dayRefusal', () => {
  const today = '2026-03-02';

  it('accepts today and back to the window’s first day, across a month end', () => {
    expect(REPLAY_WINDOW_DAYS).toBe(7);
    for (const day of ['2026-03-02', '2026-03-01', '2026-02-23']) {
      expect(dayRefusal(day, today), day).toBeUndefined();
    }
  });

  it('refuses a day before the window as too old and one after today as future', () => {
    expect(dayRefusal('2026-02-22', today)).toBe('too-old');
    expect(dayRefusal('2026-03-03', today)).toBe('future');
  });
});

describe('tapInstant and instantOnDay', () => {
  const NY = 'America/New_York';
  const at = (iso: string) => new Date(iso);
  // A live tap's instant on `day`; replays are their own case below.
  const live = (
    posted: Date | undefined,
    day: string,
    now: Date,
    timeZone: string,
  ) => instantOnDay(tapInstant(posted, false, now, timeZone), day);

  it('knows no instant for a replay that posted none (#676: an older outbox)', () => {
    const now = at('2026-11-08T22:00:00Z');
    expect(tapInstant(undefined, true, now, NY)).toBeNull();
    expect(
      instantOnDay(tapInstant(undefined, true, now, NY), '2026-11-08'),
    ).toBeNull();
    // A replay with its tap's instant keeps it.
    expect(tapInstant(at('2026-11-08T13:00:00Z'), true, now, NY)).toEqual({
      at: at('2026-11-08T13:00:00Z'),
      day: '2026-11-08',
    });
  });

  it('keeps a posted instant on its day, however late the replay', () => {
    // Sunday 08:00 in New York, replayed on Wednesday.
    expect(
      live(
        at('2026-11-08T13:00:00Z'),
        '2026-11-08',
        at('2026-11-11T15:00:00Z'),
        NY,
      ),
    ).toEqual(at('2026-11-08T13:00:00Z'));
  });

  it('is now without a posted instant, and never after now', () => {
    const now = at('2026-11-08T23:00:00Z');
    expect(live(undefined, '2026-11-08', now, NY)).toEqual(now);
    expect(live(at('2026-11-09T01:00:00Z'), '2026-11-08', now, NY)).toEqual(
      now,
    );
  });

  it('drops an instant outside the day, never clamps it', () => {
    const now = at('2026-11-10T15:00:00Z');
    // Monday morning for Sunday: a late mark.
    expect(live(at('2026-11-09T14:00:00Z'), '2026-11-08', now, NY)).toBeNull();
    // Saturday evening for Sunday: a wrong clock.
    expect(live(at('2026-11-07T23:00:00Z'), '2026-11-08', now, NY)).toBeNull();
    // No instant and now on a later day: the day rule.
    expect(live(undefined, '2026-11-08', now, NY)).toBeNull();
  });

  it('takes the day from midnight to midnight, on a DST day too', () => {
    const now = at('2026-11-12T12:00:00Z');
    // 2026-11-01 is New York's fall back: 00:00 is 04:00Z, the next
    // midnight 05:00Z (a 25-hour day).
    expect(live(at('2026-11-01T04:00:00Z'), '2026-11-01', now, NY)).toEqual(
      at('2026-11-01T04:00:00Z'),
    );
    expect(live(at('2026-11-02T04:59:59.999Z'), '2026-11-01', now, NY)).toEqual(
      at('2026-11-02T04:59:59.999Z'),
    );
    expect(live(at('2026-11-02T05:00:00Z'), '2026-11-01', now, NY)).toBeNull();
    expect(
      live(at('2026-11-01T03:59:59.999Z'), '2026-11-01', now, NY),
    ).toBeNull();
  });
});

describe('queuedTarget', () => {
  it('keys each kind so that only the same intent collapses', () => {
    expect([
      queuedTarget('wear', 41),
      queuedTarget('wash', 41),
      queuedTarget('entry', 88),
      queuedTarget('packed', 7, 41),
      queuedTarget('item', 7, 3),
    ]).toEqual([
      // The outbox adds the page's day to a wear's (#708).
      { key: 'wear:41', path: '/wardrobe/41/wear' },
      { key: 'wash:41', path: '/wardrobe/41/washed' },
      { key: 'entry:88', path: '/calendar/88/worn' },
      { key: 'packed:7:41', path: '/trips/7/packed' },
      { key: 'item:7:3', path: '/trips/7/items/packed' },
    ]);
    // Another trip's tick of the same garment is another record.
    expect(queuedTarget('packed', 8, 41).key).not.toBe(
      queuedTarget('packed', 7, 41).key,
    );
  });

  it('builds the paths the allowlist takes back, kind for kind', () => {
    for (const kind of Object.keys(QUEUEABLE_ROUTES) as QueueableKind[]) {
      expect(queueableKindOf(queuedTarget(kind, 12, 3).path), kind).toBe(kind);
    }
  });
});

describe('queueableKindOf', () => {
  it('replays only the queueable routes, by their whole path', () => {
    for (const path of [
      '/wardrobe/41/away',
      '/wardrobe/41/wear/x',
      '/x/wardrobe/41/wear',
      '/wardrobe/0/wear',
      '/wardrobe/abc/washed',
      '/wardrobe/41/wear?worn=1',
      '/trips/7/items/3/delete',
      'https://elsewhere.example/wardrobe/41/wear',
      '/auth/logout',
    ]) {
      expect(queueableKindOf(path), path).toBeUndefined();
    }
  });
});

describe('the kinds', () => {
  it('dates the wear and the wash with the tap’s day, times the entry too, and ticks per item', () => {
    const kinds = Object.keys(QUEUEABLE_ROUTES) as QueueableKind[];
    expect(kinds.filter(takesDay)).toEqual(['wear', 'wash']);
    expect(kinds.filter(takesInstant)).toEqual(['wear', 'wash', 'entry']);
    expect(kinds.filter(isChecklist)).toEqual(['packed', 'item']);
  });
});

describe('isReplayRequest', () => {
  it('reads the replay header from Node’s lower-cased headers', () => {
    expect(isReplayRequest({ 'x-closet-queued': '12' })).toBe(true);
    expect(isReplayRequest({ 'sec-fetch-mode': 'cors' })).toBe(false);
  });
});

describe('goesThroughOutbox', () => {
  const pending = new Set(['wear:41:2026-11-12']);

  it('queues every tap offline, and online any tap whose key waits', () => {
    expect(goesThroughOutbox(true, ['wash:41'], new Set())).toBe(true);
    expect(goesThroughOutbox(false, ['wear:41:2026-11-12'], pending)).toBe(
      true,
    );
    // The laundry's batch: one waiting row sends all of them through it.
    expect(
      goesThroughOutbox(false, ['wash:7', 'wear:41:2026-11-12'], pending),
    ).toBe(true);
  });

  it('sends a tap straight on online when none of its keys waits', () => {
    expect(goesThroughOutbox(false, ['wear:41:2026-11-11'], pending)).toBe(
      false,
    );
    expect(goesThroughOutbox(false, [], pending)).toBe(false);
  });
});

describe('the queue over its store', () => {
  interface Row extends StoredRecord {
    id: string;
  }
  const row = (
    id: string,
    key: string,
    { account = '1', state = 'pending' }: Partial<StoredRecord> = {},
  ): Row => ({ id, key, account, state });

  /** An in-memory store, the IndexedDB one's rule; `failPuts` makes every put reject. */
  function memoryStore(initial: Row[] = [], { failPuts = false } = {}) {
    let rows = [...initial];
    const store: OutboxStore<Row> = {
      records: (account) =>
        Promise.resolve(rows.filter((r) => r.account === account)),
      putCollapsed: (incoming) => {
        if (failPuts) return Promise.reject(new Error('QuotaExceededError'));
        const replaced = (r: Row) =>
          incoming.some((n) => n.account === r.account && n.key === r.key);
        rows = [...rows.filter((r) => !replaced(r)), ...incoming];
        return Promise.resolve();
      },
    };
    return { store, rows: () => rows };
  }

  it('a failed put leaves nothing pending: the next online tap goes straight on', async () => {
    const { store, rows } = memoryStore([], { failPuts: true });
    const result = await enqueue(store, '1', [row('a', 'wash:41')]);
    expect(result.outcome).toBe('unavailable');
    expect(rows()).toEqual([]);
    expect(await routesThroughOutbox(store, '1', false, ['wash:41'])).toBe(
      false,
    );
  });

  it('another tab’s committed record routes this tab’s online tap through it', async () => {
    // Written by another tab: this one never queued anything.
    const { store } = memoryStore([
      row('a', 'wear:41:2026-11-12'),
      row('b', 'wash:41', { state: 'failed' }),
      row('c', 'wash:7', { account: '2' }),
    ]);
    expect(
      await routesThroughOutbox(store, '1', false, ['wear:41:2026-11-12']),
    ).toBe(true);
    // A failure waits for Dismiss, not to be replayed; another account's is not this one's.
    expect(await routesThroughOutbox(store, '1', false, ['wash:41'])).toBe(
      false,
    );
    expect(await routesThroughOutbox(store, '1', false, ['wash:7'])).toBe(
      false,
    );
    expect(await routesThroughOutbox(store, '1', true, ['wash:7'])).toBe(true);
  });

  it('replaces the account’s record of the key and keeps another account’s', async () => {
    const { store, rows } = memoryStore([
      row('a', 'wear:41:2026-11-12'),
      row('b', 'wear:41:2026-11-12', { account: '2' }),
    ]);
    expect(await enqueue(store, '1', [row('c', 'wear:41:2026-11-12')])).toEqual(
      { outcome: 'queued' },
    );
    expect(rows().map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('refuses past the cap, counting a replacement as no new record', async () => {
    const full = Array.from({ length: OUTBOX_MAX_PENDING }, (_, i) =>
      row(`r${i}`, `wash:${i + 1}`),
    );
    const { store, rows } = memoryStore(full);
    expect(await enqueue(store, '1', [row('new', 'wash:9999')])).toEqual({
      outcome: 'full',
    });
    expect(await enqueue(store, '1', [row('again', 'wash:1')])).toEqual({
      outcome: 'queued',
    });
    expect(rows()).toHaveLength(OUTBOX_MAX_PENDING);
  });
});

describe('replayVerdict', () => {
  it.each([
    [204, 'changed', { verdict: 'saved', changed: true }],
    [204, 'unchanged', { verdict: 'saved', changed: false }],
    [401, null, { verdict: 'signed-out' }],
    // The login redirect, opaque under `redirect: 'manual'`: kept for the
    // sign-in, never failed.
    [0, null, { verdict: 'signed-out' }],
    [404, null, { verdict: 'failed', reason: 'gone' }],
    // A wear whose client id was saved, then deleted since: done, nothing
    // to bring back.
    [410, null, { verdict: 'saved', changed: false }],
    [409, 'too-old', { verdict: 'failed', reason: 'too-old' }],
    [409, 'future', { verdict: 'failed', reason: 'future' }],
    [409, 'account', { verdict: 'failed', reason: 'account' }],
    // A wishlist item: a 409 with no reason of the contract.
    [409, null, { verdict: 'failed', reason: 'refused' }],
    [409, 'changed', { verdict: 'failed', reason: 'refused' }],
    [400, null, { verdict: 'failed', reason: 'refused' }],
    [403, null, { verdict: 'failed', reason: 'refused' }],
    // A page: an answer that is not the replay contract's is never taken
    // for saved.
    [200, null, { verdict: 'failed', reason: 'refused' }],
    [500, null, { verdict: 'retry', cause: 'server' }],
    [501, null, { verdict: 'retry', cause: 'server' }],
    // The proxy's 502 and 504 (a restart), the busy page (#643), a timeout
    // and a rate limit say nothing about the record: they never count
    // toward stuck.
    [502, null, { verdict: 'retry', cause: 'unreachable' }],
    [503, null, { verdict: 'retry', cause: 'unreachable' }],
    [504, null, { verdict: 'retry', cause: 'unreachable' }],
    [408, null, { verdict: 'retry', cause: 'unreachable' }],
    [429, null, { verdict: 'retry', cause: 'unreachable' }],
  ] as const)('reads %i (%s)', (status, outcome, verdict) => {
    expect(replayVerdict(status, outcome)).toEqual(verdict);
  });
});

describe('replayQueue: a 5xx never fails a record, it makes it stuck', () => {
  type Row = ReplayRecord & { id: string; reason?: string };
  const row = (id: string, key = id): Row => ({
    id,
    account: '1',
    key,
    state: 'pending',
    attempts: 0,
  });
  const OK = { verdict: 'saved', changed: true } as const;
  const SERVER = { verdict: 'retry', cause: 'server' } as const;
  const UNREACHABLE = { verdict: 'retry', cause: 'unreachable' } as const;

  /** A store and a server in one: `answers` says what each id gets. */
  function world(
    rows: Row[],
    answers: (id: string) => ReplayVerdict,
    clock: { now: number } = { now: 0 },
  ) {
    const sent: string[] = [];
    const stored = new Map(rows.map((r) => [r.id, r]));
    const driver: ReplayDriver<Row> = {
      now: () => clock.now,
      skip: () => Promise.resolve(false),
      send(record) {
        sent.push(record.id);
        return Promise.resolve(answers(record.id));
      },
      settle(record, step) {
        if (step.step === 'saved') stored.delete(record.id);
        else stored.set(record.id, step.record);
        return Promise.resolve(true);
      },
    };
    const drain = () =>
      replayQueue(
        [...stored.values()].filter((r) => r.state === 'pending'),
        driver,
      );
    return { stored, sent, drain, clock, driver };
  }

  it('a lone poisoned record ends stuck, not failed, and is then left alone', async () => {
    const w = world([row('bad')], () => SERVER);
    for (let n = 1; n <= STUCK_AFTER_SERVER_ERRORS; n += 1) {
      expect((await w.drain()).end).toBe('backoff');
    }
    expect(w.stored.get('bad')).toMatchObject({
      state: 'pending',
      serverErrors: STUCK_AFTER_SERVER_ERRORS,
      stuckAt: 0,
    });
    w.sent.length = 0;
    w.clock.now = stuckRetryMs(STUCK_AFTER_SERVER_ERRORS) - 1;
    const end = await w.drain();
    expect(w.sent).toEqual([]);
    expect(end).toEqual({ end: 'backoff', retryInMs: 1 });
  });

  it('a short outage costs minutes, not STUCK_RETRY_MS: the wait doubles per 5xx up to the cap', () => {
    expect(stuckRetryMs(STUCK_AFTER_SERVER_ERRORS)).toBe(STUCK_RETRY_FIRST_MS);
    expect(stuckRetryMs(STUCK_AFTER_SERVER_ERRORS + 1)).toBe(
      2 * STUCK_RETRY_FIRST_MS,
    );
    expect(stuckRetryMs(STUCK_AFTER_SERVER_ERRORS + 50)).toBe(STUCK_RETRY_MS);
    expect(stuckRetryMs(undefined)).toBe(STUCK_RETRY_FIRST_MS);
  });

  it('a record saved by the end-of-drain retry leaves no timer for an empty drain', async () => {
    const w = world(
      [{ ...row('bad'), serverErrors: 3, stuckAt: 0 }, row('ok')],
      () => OK,
      { now: 1000 },
    );
    expect(await w.drain()).toEqual({ end: 'done' });
    expect(w.stored.size).toBe(0);
  });

  it('a parked record still waiting sets the timer for what is left of its wait', async () => {
    const w = world(
      [{ ...row('bad'), serverErrors: 3, stuckAt: 0 }],
      () => OK,
      { now: 1000 },
    );
    expect(await w.drain()).toEqual({
      end: 'backoff',
      retryInMs: STUCK_RETRY_FIRST_MS - 1000,
    });
  });

  it('a stuckAt in the future (the clock moved back) is due, not parked', async () => {
    const w = world(
      [{ ...row('bad'), serverErrors: 3, stuckAt: 5 * STUCK_RETRY_MS }],
      () => OK,
      { now: 1000 },
    );
    expect(await w.drain()).toEqual({ end: 'done' });
    expect(w.sent).toEqual(['bad']);
  });

  it('a server-wide 5xx fails and drops nothing: every record ends stuck', async () => {
    const w = world([row('a'), row('b'), row('c')], () => SERVER);
    for (let n = 1; n <= STUCK_AFTER_SERVER_ERRORS; n += 1) {
      await w.drain();
    }
    expect(
      [...w.stored.values()].map((r) => [r.state, r.stuckAt !== undefined]),
    ).toEqual([
      ['pending', true],
      ['pending', true],
      ['pending', true],
    ]);
  });

  it('records behind a failing one are still sent in the same drain', async () => {
    const w = world([row('bad'), row('ok1'), row('ok2')], (id) =>
      id === 'bad' ? SERVER : OK,
    );
    await w.drain();
    expect(w.sent).toEqual(['bad', 'ok1', 'ok2']);
    expect([...w.stored.keys()]).toEqual(['bad']);
    expect(w.stored.get('bad')).toMatchObject({ serverErrors: 1, attempts: 1 });
  });

  it('retries a stuck record after another record saved, and keeps it stuck while it still fails', async () => {
    const w = world(
      [{ ...row('bad'), serverErrors: 3, stuckAt: 0, attempts: 3 }, row('ok')],
      (id) => (id === 'bad' ? SERVER : OK),
      { now: 1000 },
    );
    await w.drain();
    expect(w.sent).toEqual(['ok', 'bad']);
    expect(w.stored.get('bad')).toMatchObject({
      serverErrors: 4,
      stuckAt: 1000,
    });
  });

  it('does not retry a stuck record just because the server is failing everything', async () => {
    const w = world(
      [{ ...row('bad'), serverErrors: 3, stuckAt: 0 }, row('other')],
      () => SERVER,
      { now: 1000 },
    );
    await w.drain();
    expect(w.sent).toEqual(['other']);
  });

  it('retries a stuck record every STUCK_RETRY_MS by itself, and saves it when the server recovers', async () => {
    let healthy = false;
    const w = world(
      [{ ...row('bad'), serverErrors: 3, stuckAt: 0 }],
      () => (healthy ? OK : SERVER),
      { now: STUCK_RETRY_MS },
    );
    await w.drain();
    expect(w.stored.get('bad')).toMatchObject({ stuckAt: STUCK_RETRY_MS });
    w.clock.now = 2 * STUCK_RETRY_MS;
    healthy = true;
    expect((await w.drain()).end).toBe('done');
    expect(w.stored.size).toBe(0);
  });

  it('never sends a record past one with its key that stays queued', async () => {
    const w = world(
      [row('old', 'wear:1'), row('same', 'wear:1'), row('other')],
      (id) => (id === 'old' ? SERVER : OK),
    );
    await w.drain();
    expect(w.sent).toEqual(['old', 'other']);
  });

  it('keeps a stuck record’s key held past the drain’s retry of it', async () => {
    const w = world(
      [
        { ...row('bad', 'wear:1'), serverErrors: 3, stuckAt: 0 },
        row('same', 'wear:1'),
        row('ok'),
      ],
      (id) => (id === 'bad' ? SERVER : OK),
      { now: 1000 },
    );
    await w.drain();
    expect(w.sent).toEqual(['ok', 'bad']);
  });

  it('the network, a timeout or a 503 stop the drain and count nothing', async () => {
    const w = world([row('a'), row('b')], () => UNREACHABLE);
    expect((await w.drain()).end).toBe('backoff');
    expect(w.sent).toEqual(['a']);
    expect(w.stored.get('a')?.serverErrors).toBeUndefined();
  });

  it('a drain after the server answered again tries every stuck record in its turn', async () => {
    const w = world(
      [
        { ...row('bad'), serverErrors: 3, stuckAt: 0 },
        { ...row('later'), serverErrors: 3, stuckAt: 0 },
      ],
      (id) => (id === 'later' ? OK : SERVER),
      { now: 1000 },
    );
    const retried = await replayQueue([...w.stored.values()], w.driver, {
      serverAnswering: true,
    });
    expect(w.sent).toEqual(['bad', 'later']);
    expect(retried.end).toBe('backoff');
    expect(w.stored.get('bad')).toMatchObject({
      serverErrors: 4,
      stuckAt: 1000,
    });
    expect(w.stored.has('later')).toBe(false);
  });

  it('a refusal fails the record as before', async () => {
    const w = world([row('a')], () => ({ verdict: 'failed', reason: 'gone' }));
    await w.drain();
    expect(w.stored.get('a')).toMatchObject({
      state: 'failed',
      reason: 'gone',
    });
  });

  it('Try again: unstuck clears the count so the record is judged afresh', () => {
    const cleared = unstuck({
      ...row('bad'),
      attempts: 7,
      serverErrors: 4,
      stuckAt: 5,
    });
    expect(isStuck(cleared)).toBe(false);
    expect(cleared).toMatchObject({ attempts: 0 });
    expect(cleared.serverErrors).toBeUndefined();
  });

  describe('Try again and Discard take the drain’s turn', () => {
    /** A send held open until `release`: the replay in flight. */
    function held(w: ReturnType<typeof world>) {
      let release!: (v: ReplayVerdict) => void;
      let begin!: () => void;
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const answer = new Promise<ReplayVerdict>((resolve) => {
        release = resolve;
      });
      const send = w.driver.send.bind(w.driver);
      let first = true;
      w.driver.send = (record) => {
        if (!first) return send(record);
        first = false;
        w.sent.push(record.id);
        begin();
        return answer;
      };
      return { release, started };
    }
    const actions = (w: ReturnType<typeof world>) => {
      const store: StuckActionStore<Row> = {
        find: (id) => Promise.resolve(w.stored.get(id)),
        settle(record, next) {
          if (!w.stored.has(record.id)) return Promise.resolve(false);
          if (next) w.stored.set(record.id, next);
          else w.stored.delete(record.id);
          return Promise.resolve(true);
        },
      };
      return store;
    };
    const stuckRow = (): Row => ({
      ...row('bad'),
      serverErrors: 3,
      stuckAt: 0,
      attempts: 3,
    });

    it('Discard waits for the replay in flight, so a save is not reverted and no resend follows', async () => {
      const w = world([stuckRow()], () => OK, { now: STUCK_RETRY_MS });
      const gate = held(w);
      const turn = createTurns();
      const drain = turn(() => w.drain());
      await gate.started;
      let discarded: Row | undefined | 'pending' = 'pending';
      const discard = discardStuck(actions(w), turn, 'bad').then((r) => {
        discarded = r;
      });
      await Promise.resolve();
      expect(discarded).toBe('pending');
      gate.release(OK);
      await Promise.all([drain, discard]);
      expect(discarded).toBeUndefined();
      expect(w.sent).toEqual(['bad']);
      expect(w.stored.size).toBe(0);
    });

    it('Discard after a replay that failed again deletes the record and nothing resends it', async () => {
      const w = world([stuckRow()], () => SERVER, { now: STUCK_RETRY_MS });
      const gate = held(w);
      const turn = createTurns();
      const drain = turn(() => w.drain());
      await gate.started;
      const discard = discardStuck(actions(w), turn, 'bad');
      gate.release(SERVER);
      await Promise.all([drain, discard]);
      expect((await discard)?.id).toBe('bad');
      expect(w.stored.size).toBe(0);
      expect(w.sent).toEqual(['bad']);
    });

    it('Try again waits for the replay in flight, then clears the counted copy it left', async () => {
      const w = world([stuckRow()], () => SERVER, { now: STUCK_RETRY_MS });
      const gate = held(w);
      const turn = createTurns();
      const drain = turn(() => w.drain());
      await gate.started;
      const retry = retryStuck(actions(w), turn, 'bad');
      gate.release(SERVER);
      await Promise.all([drain, retry]);
      expect(await retry).toMatchObject({ id: 'bad' });
      const left = w.stored.get('bad');
      expect(left && isStuck(left)).toBe(false);
      expect(left).toMatchObject({ attempts: 0 });
    });

    it('two replays of one record never overlap: Try again’s drain starts after the first ends', async () => {
      const w = world([stuckRow()], () => SERVER, { now: STUCK_RETRY_MS });
      const gate = held(w);
      let inFlight = 0;
      let overlapped = false;
      const send = w.driver.send.bind(w.driver);
      w.driver.send = async (record) => {
        inFlight += 1;
        overlapped ||= inFlight > 1;
        try {
          return await send(record);
        } finally {
          inFlight -= 1;
        }
      };
      const turn = createTurns();
      const first = turn(() => w.drain());
      await gate.started;
      const retry = retryStuck(actions(w), turn, 'bad').then(() =>
        turn(() => w.drain()),
      );
      gate.release(SERVER);
      await Promise.all([first, retry]);
      expect(overlapped).toBe(false);
      expect(w.sent).toEqual(['bad', 'bad']);
    });

    it('a button whose action waits for the turn is disabled and aria-busy, an idle one is plain', () => {
      expect(actionBusyAttributes(true)).toEqual({
        'aria-busy': 'true',
        disabled: '',
      });
      expect(actionBusyAttributes(false)).toEqual({});
    });

    it('acts on nothing once the record is gone or no longer stuck', async () => {
      const w = world([row('fresh')], () => OK);
      const turn = createTurns();
      expect(await retryStuck(actions(w), turn, 'fresh')).toBeUndefined();
      expect(await discardStuck(actions(w), turn, 'nope')).toBeUndefined();
    });
  });

  it('stops for a sign-in', async () => {
    const w = world([row('a')], () => ({ verdict: 'signed-out' }));
    expect((await w.drain()).end).toBe('no-session');
  });
});

describe('after a sync, the worker’s refetch', () => {
  it('acts only on the allowlist’s paths, each once', () => {
    expect(
      syncedWritePaths([
        '/wardrobe/41/wear',
        '/wardrobe/41/wear',
        '/trips/7/items/packed',
        '/wardrobe/41',
        'https://elsewhere.test/wardrobe/41/wear',
        '/wardrobe/41/wear?x=1',
        41,
        null,
      ]),
    ).toEqual(['/wardrobe/41/wear', '/trips/7/items/packed']);
    expect(syncedWritePaths('/wardrobe/41/wear')).toEqual([]);
    expect(syncedWritePaths(undefined)).toEqual([]);
  });

  it.each([
    [
      '/wardrobe/41/wear',
      ['/wardrobe/41', '/laundry'],
      ['/wardrobe/4', '/wardrobe/410', '/wardrobe', '/'],
    ],
    [
      '/wardrobe/41/washed',
      ['/wardrobe/41', '/laundry'],
      ['/wardrobe/41/edit', '/calendar'],
    ],
    [
      '/calendar/88/worn',
      ['/', '/calendar', '/laundry', '/trips/7'],
      ['/calendar/month', '/trips', '/trips/7/edit', '/wardrobe/88'],
    ],
    ['/trips/7/packed', ['/trips/7'], ['/trips/70', '/trips', '/', '/laundry']],
    ['/trips/7/items/packed', ['/trips/7'], ['/trips/8']],
    ['/wardrobe/41', [], ['/wardrobe/41', '/laundry']],
  ])(
    'refetches for %s exactly the pages that draw it',
    (write, shown, notShown) => {
      for (const page of shown)
        expect(showsQueuedWrite(write, page), page).toBe(true);
      for (const page of notShown)
        expect(showsQueuedWrite(write, page), page).toBe(false);
    },
  );
});

describe('queuedWritesGoneAtClaim', () => {
  it('deletes every other account’s records when the cache gets a new owner, keeping the claimant’s', () => {
    for (const owner of ['7', undefined]) {
      const gone = queuedWritesGoneAtClaim(owner, '41');
      expect(gone, String(owner)).toBeDefined();
      expect(gone?.('7')).toBe(true);
      expect(gone?.('412')).toBe(true);
      expect(gone?.(undefined)).toBe(true);
      expect(gone?.('41')).toBe(false);
    }
  });

  it('deletes none for the same owner or a signed-out page', () => {
    expect(queuedWritesGoneAtClaim('41', '41')).toBeUndefined();
    expect(queuedWritesGoneAtClaim('41', '')).toBeUndefined();
    expect(queuedWritesGoneAtClaim(undefined, '')).toBeUndefined();
  });

  it('keeps a record only in the header’s own spelling of the account', () => {
    // The owner and a record's account must agree in format: a number, or a
    // padded or prefixed id, is another account to the claim and goes.
    const gone = queuedWritesGoneAtClaim('7', '41');
    for (const spelling of [41, ' 41', '041', 'user:41']) {
      expect(gone?.(spelling), String(spelling)).toBe(true);
    }
  });
});

describe('retryDelayMs', () => {
  it('waits 5 s, doubling, at most 5 minutes', () => {
    expect([0, 1, 2, 3, 6, 7, 30].map(retryDelayMs)).toEqual([
      5_000, 5_000, 10_000, 20_000, 160_000, 300_000, 300_000,
    ]);
  });
});

describe('offlineNotice', () => {
  it.each<[string, QueueableKind[], string]>([
    ['a page that queues nothing', [], 'none'],
    ['wears', ['wear'], 'wears'],
    ['an entry marked worn', ['entry'], 'wears'],
    ['washes', ['wash'], 'washes'],
    ['packing ticks', ['packed', 'item'], 'ticks'],
    ['ticks beside a worn mark', ['packed', 'entry'], 'changes'],
  ])('%s', (_name, kinds, notice) => {
    expect(offlineNotice(kinds)).toBe(notice);
  });
});

describe('packedCount', () => {
  it('keeps the server count while nothing is queued', () => {
    expect(
      packedCount(2, [
        { served: true, queued: undefined },
        { served: false, queued: undefined },
      ]),
    ).toBe(2);
  });

  it('adds the net of the queued ticks', () => {
    expect(
      packedCount(2, [
        { served: false, queued: true },
        { served: true, queued: false },
        { served: false, queued: true },
        { served: true, queued: true },
      ]),
    ).toBe(3);
  });

  it('ignores a queued record that agrees with the server', () => {
    expect(packedCount(1, [{ served: true, queued: true }])).toBe(1);
  });
});

describe('reasonTextName', () => {
  it.each([
    ['gone', 'textOutboxReasonGone'],
    ['too-old', 'textOutboxReasonTooOld'],
    ['future', 'textOutboxReasonFuture'],
    ['account', 'textOutboxReasonAccount'],
    ['refused', 'textOutboxReasonRefused'],
    // A record the #860 client settled as failed, still in IndexedDB.
    ['server', 'textOutboxReasonServer'],
    [undefined, 'textOutboxReasonRefused'],
  ] as const)('names %s', (reason, name) => {
    expect(reasonTextName(reason)).toBe(name);
  });
});
