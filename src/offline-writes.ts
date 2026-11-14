import { addDays, type IsoDate, todayIn } from './calendar-date';

/**
 * The writes the installed app queues while offline and replays on
 * reconnect (#178, docs/plans/2026-11-12-offline-queued-writes.md), each
 * kind with the route its replay posts to. Each of those routes names its
 * kind (`config: { queueable }`, src/web/offline-writes.ts), and
 * test/integration/queued-writes.spec.ts holds the routes and this list
 * equal both ways: the page's outbox replays only a path that matches one
 * of these, so a route missing here would never be replayed and one only
 * here would be replayed without the account check.
 */
export const QUEUEABLE_ROUTES = {
  wear: '/wardrobe/:id/wear',
  wash: '/wardrobe/:id/washed',
  entry: '/calendar/:id/worn',
  packed: '/trips/:id/packed',
  item: '/trips/:id/items/packed',
} as const;

export type QueueableKind = keyof typeof QUEUEABLE_ROUTES;

/**
 * How far back a replayed wear or wash may be dated (owner decision 3,
 * 2026-11-13): a phone offline longer than a week asks for the wear to be
 * added from the calendar instead.
 */
export const REPLAY_WINDOW_DAYS = 7;

/** Why a queued write is refused, sent as `X-Closet-Outcome` with its 409. */
export type ReplayRefusal = 'too-old' | 'future' | 'account';

/**
 * An explicit day on Wore today or Washed (the tap's day, not the replay's)
 * is accepted from `today - REPLAY_WINDOW_DAYS` to `today`; anything else
 * is the refusal to answer. Undefined when the day is accepted.
 */
export function dayRefusal(
  day: IsoDate,
  today: IsoDate,
): Exclude<ReplayRefusal, 'account'> | undefined {
  if (day > today) return 'future';
  if (day < addDays(today, -REPLAY_WINDOW_DAYS)) return 'too-old';
  return undefined;
}

/**
 * The page's outbox (views/assets/outbox.ts, bundled into public/js/outbox.js;
 * plan section 3) and the views that mark the queueable controls share
 * these rules, so a key the server renders is the key the outbox collapses
 * by.
 */

/** Where a queued write replays, and the key its records collapse by. */
export interface QueuedTarget {
  /**
   * One record per key, the last intent wins: `wear:41:2026-11-12` (a
   * garment's wear on a day; its region names `wear:41` and the outbox adds
   * the page's day, #708), `wash:41`, `entry:88`, `packed:7:41` (a
   * trip's garment), `item:7:3` (a trip's extra).
   */
  key: string;
  path: string;
}

/**
 * The target of a queued write: `id` is the route's `:id` (the garment, the
 * entry, the trip); `part` what the key adds, the trip's garment or extra.
 */
export function queuedTarget(
  kind: QueueableKind,
  id: number,
  part?: number,
): QueuedTarget {
  return {
    key: [kind, id, ...(part === undefined ? [] : [part])].join(':'),
    path: QUEUEABLE_ROUTES[kind].replace(':id', String(id)),
  };
}

const QUEUEABLE_PATHS = Object.entries(QUEUEABLE_ROUTES).map(
  ([kind, pattern]) => ({
    kind: kind as QueueableKind,
    path: new RegExp(`^${pattern.replace(':id', '[1-9]\\d{0,9}')}$`),
  }),
);

/**
 * The kind a stored record's path replays as, or undefined: the outbox
 * replays nothing else (plan section 7), whatever its store holds.
 */
export function queueableKindOf(path: string): QueueableKind | undefined {
  return QUEUEABLE_PATHS.find((route) => route.path.test(path))?.kind;
}

/**
 * What marks a replay (plan section 4), naming the account that queued it:
 * sent by the page's outbox, read by src/web/offline-writes.ts (the replay
 * contract) and src/web/auth/session-access.ts, which answers a replay
 * without a session the bodiless 401, never the navigation's 302. The
 * household's HTTP twin gets no Fetch Metadata, so without this header a
 * replay would look like a navigation and its redirect reach the outbox as
 * an opaque answer.
 */
export const REPLAY_HEADER = 'X-Closet-Queued';

/** Whether a request is a replay, from Node's lower-cased headers. */
export function isReplayRequest(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return headers[REPLAY_HEADER.toLowerCase()] !== undefined;
}

/**
 * The kinds whose record posts the tap's `day` (todayIn APP_TIMEZONE): a
 * Sunday-night wear replayed Monday is Sunday's. An entry's day is its own.
 */
export function takesDay(kind: QueueableKind): boolean {
  return kind === 'wear' || kind === 'wash';
}

/**
 * The kinds whose record posts the tap's instant (`at`, ISO), so a replay
 * orders a same-day wear (Wore today, an entry marked worn) and wash by when
 * they were tapped, not replayed (#676; tapInstant judges it).
 */
export function takesInstant(kind: QueueableKind): boolean {
  return takesDay(kind) || kind === 'entry';
}

/** When a tap happened as far as the server can tell, and its day in APP_TIMEZONE. */
export interface TapInstant {
  at: Date;
  day: IsoDate;
}

/**
 * The instant of a wear, a wash or an entry's mark (#676), the one rule
 * every writer of garment_wear.worn_at and garment.washed_at goes through:
 * the posted one (the tap's: the outbox's, an API client's), never after
 * the server's now (a fast client clock); without one, a live tap is now,
 * but a replay (`replayed`: REPLAY_HEADER) is unknown, null: a record queued
 * before its kind carried `at` (an older outbox) was tapped some time
 * before the replay, and stamping the replay's time could put a morning
 * wash after an evening wear. A slow client clock is not caught: its
 * instant is earlier than the tap, and can misorder.
 */
export function tapInstant(
  posted: Date | undefined,
  replayed: boolean,
  now: Date,
  timeZone: string,
): TapInstant | null {
  if (posted === undefined && replayed) return null;
  const at = posted === undefined || posted > now ? now : posted;
  return { at, day: todayIn(timeZone, at) };
}

/**
 * The instant a wear or wash on `day` is stored with (garment_wear.worn_at,
 * garment.washed_at): the tap's, only when it falls on `day`; else null,
 * the day rule (a wear that day counts as before the wash). Outside the
 * day it is dropped, never clamped to the day's edge: a wrong clock or a
 * mark made after the day (a calendar "Worn?" for yesterday), and clamping
 * to the day's start would invent a morning wash that counts every wear of
 * the day. Membership is todayIn's, so a DST day needs no midnight
 * arithmetic.
 */
export function instantOnDay(
  tap: TapInstant | null,
  day: IsoDate,
): Date | null {
  return tap?.day === day ? tap.at : null;
}

/** The packing ticks: a record per item, posting `shown` and `packed`. */
export function isChecklist(kind: QueueableKind): boolean {
  return kind === 'packed' || kind === 'item';
}

/**
 * The most records waiting at once: past it the queueable controls are
 * disabled offline, with the banner saying why.
 */
export const OUTBOX_MAX_PENDING = 200;

/**
 * Whether a tap goes through the outbox rather than straight to the server:
 * offline, or while any of its keys has a pending record (queued, backing
 * off or in flight), even online. A tap sent past a pending record would
 * land first and then be overwritten by the older record's replay (Wore
 * today, a 503, Undo during the backoff: the replay marks it worn again);
 * through the outbox it replaces that record (`OutboxStore.putCollapsed`)
 * and replays after the one in flight.
 */
export function goesThroughOutbox(
  offline: boolean,
  keys: readonly string[],
  pendingKeys: ReadonlySet<string>,
): boolean {
  return offline || keys.some((key) => pendingKeys.has(key));
}

/** What the queue's rules read of a stored record. */
export interface StoredRecord {
  account: string;
  key: string;
  state: 'pending' | 'failed';
}

/**
 * The outbox's store, the one truth about what waits: IndexedDB in the page
 * (views/assets/outbox.ts), shared by every tab of the origin; a stub in the
 * spec. Every decision reads it as committed, never a copy a failed put or
 * another tab's write could leave disagreeing with it.
 */
export interface OutboxStore<R extends StoredRecord> {
  /** The account's records, oldest first. */
  records(account: string): Promise<R[]>;
  /**
   * Each record in place of its account's record of the same key, in one
   * transaction: the last intent wins, and nothing in between is seen.
   */
  putCollapsed(records: readonly R[]): Promise<void>;
}

const pendingKeys = (records: readonly StoredRecord[]) =>
  new Set(records.filter((r) => r.state === 'pending').map((r) => r.key));

/**
 * `goesThroughOutbox` over the store as committed now: another tab's
 * pending record counts, a put that failed does not. A store that cannot be
 * read rejects; the page then sends online taps straight on.
 */
export async function routesThroughOutbox<R extends StoredRecord>(
  store: OutboxStore<R>,
  account: string,
  offline: boolean,
  keys: readonly string[],
): Promise<boolean> {
  if (offline) return true;
  return goesThroughOutbox(
    false,
    keys,
    pendingKeys(await store.records(account)),
  );
}

export type EnqueueResult =
  | { outcome: 'queued' }
  /** Past OUTBOX_MAX_PENDING: nothing stored. */
  | { outcome: 'full' }
  /** The store refused (private mode, quota): nothing stored. */
  | { outcome: 'unavailable'; error: unknown };

/**
 * Stores a tap's records. They are pending only once the put has
 * committed: until then, and after a failed put, nothing routes through
 * them.
 */
export async function enqueue<R extends StoredRecord>(
  store: OutboxStore<R>,
  account: string,
  incoming: readonly R[],
): Promise<EnqueueResult> {
  try {
    const waiting = pendingKeys(await store.records(account));
    const added = incoming.filter((record) => !waiting.has(record.key));
    if (waiting.size + added.length > OUTBOX_MAX_PENDING) {
      return { outcome: 'full' };
    }
    await store.putCollapsed(incoming);
    return { outcome: 'queued' };
  } catch (error) {
    return { outcome: 'unavailable', error };
  }
}

/** Why a queued write was not saved: the notice's reason. */
export type ReplayFailure = 'gone' | 'refused' | 'server' | ReplayRefusal;

/** What the outbox does with a record after its replay's answer. */
export type ReplayVerdict =
  /** Saved (204): the record goes. */
  | { verdict: 'saved'; changed: boolean }
  /** Refused for good: the record stays, failed, until dismissed. */
  | { verdict: 'failed'; reason: ReplayFailure }
  /**
   * The server may take it later. `server` is a 5xx: it counts toward the
   * record being stuck (replayQueue);
   * `unreachable` is the network, a timeout, 408, 429 or a 503, which say
   * nothing about the record and never do.
   */
  | { verdict: 'retry'; cause: RetryCause }
  /** No session (401, or a redirect): stop, keep everything for the next sign-in. */
  | { verdict: 'signed-out' };

const UNREACHABLE = 'unreachable';
export type RetryCause = 'server' | typeof UNREACHABLE;

function isRefusal(outcome: string | null): outcome is ReplayRefusal {
  return outcome === 'too-old' || outcome === 'future' || outcome === 'account';
}

const SIGNED_OUT: ReplayVerdict = { verdict: 'signed-out' };
const SERVER_ERROR: ReplayVerdict = { verdict: 'retry', cause: 'server' };
const UNAVAILABLE: ReplayVerdict = { verdict: 'retry', cause: UNREACHABLE };

/** replayVerdict's answers that the status alone decides. */
const VERDICT_OF_STATUS: Readonly<Partial<Record<number, ReplayVerdict>>> = {
  0: SIGNED_OUT,
  401: SIGNED_OUT,
  404: { verdict: 'failed', reason: 'gone' },
  // 502, 503 and 504 are the proxy or the busy page (#643) saying the server
  // is unavailable (a restart, a deploy), not a record it choked on: only a
  // 500 or another 5xx counts toward stuck.
  408: UNAVAILABLE,
  502: UNAVAILABLE,
  503: UNAVAILABLE,
  504: UNAVAILABLE,
  410: { verdict: 'saved', changed: false },
  429: UNAVAILABLE,
};

/**
 * The notice's `data-text-outbox-*` name for a failure's reason. `server` is
 * legacy: the #860 client settled a record as failed with it (it is no
 * longer produced, a 5xx makes a record stuck), and such records are still
 * in IndexedDB until dismissed.
 */
export function reasonTextName(reason: ReplayFailure | undefined): string {
  switch (reason) {
    case 'gone':
      return 'textOutboxReasonGone';
    case 'too-old':
      return 'textOutboxReasonTooOld';
    case 'future':
      return 'textOutboxReasonFuture';
    case 'account':
      return 'textOutboxReasonAccount';
    case 'server':
      return 'textOutboxReasonServer';
    case 'refused':
    case undefined:
      return 'textOutboxReasonRefused';
  }
}

/**
 * A replay's answer (src/web/offline-writes.ts): 204 saved, 401 signed out,
 * 404 gone (a deleted garment, entry or trip), 410 saved (a queued wear's
 * client id names a wear that landed and was deleted since, #196a: the tap
 * was saved once and a later write undid it), a 409 refused for the reason
 * in `X-Closet-Outcome` (a wishlist item has none), a server error or rate
 * limit retried (a 5xx counts toward stuck, replayQueue). A redirect (status 0: the outbox fetches with `redirect:
 * 'manual'`, so it is opaque) is kept like a 401: the only one a queueable
 * route gives is the session gate's to the login page, for a client that
 * did not say it was a replay. Anything else (a 400, a 403) is refused: the
 * page must never take an answer it does not know for saved.
 */
export function replayVerdict(
  status: number,
  outcome: string | null,
): ReplayVerdict {
  if (status === 204)
    return { verdict: 'saved', changed: outcome === 'changed' };
  if (status === 409 && isRefusal(outcome)) {
    return { verdict: 'failed', reason: outcome };
  }
  return (
    VERDICT_OF_STATUS[status] ??
    (status >= 500 ? SERVER_ERROR : { verdict: 'failed', reason: 'refused' })
  );
}

/** What a page tells the user about offline, from the writes it queues. */
export type OfflineNotice = 'none' | 'wears' | 'washes' | 'ticks' | 'changes';

/**
 * The offline notice of a page, derived from the kinds its
 * `data-offline-queue` controls carry (never written per page, so a notice
 * cannot contradict what the outbox does): `none` queues nothing, `wears`
 * (a wear or an entry's worn mark), `washes` and `ticks` (a trip's packing
 * and extras) name the one thing that is saved on the phone, `changes` is
 * several of them. The page's views map each to its string.
 */
export function offlineNotice(kinds: readonly QueueableKind[]): OfflineNotice {
  const groups = new Set(
    kinds.map((kind) => {
      if (isChecklist(kind)) return 'ticks';
      return kind === 'wash' ? 'washes' : 'wears';
    }),
  );
  if (groups.size === 0) return 'none';
  if (groups.size > 1) return 'changes';
  return [...groups][0];
}

/**
 * A "N of M packed" line while ticks wait to sync: the server's count plus
 * the net of the queued records, never a recount of the page. A row is its
 * state in the server's markup (`served`) and the intent of its pending
 * record (`queued`, undefined without one); only a row whose pending record
 * disagrees with the server moves the count, so a page with nothing queued
 * keeps the server's number (#658).
 */
export function packedCount(
  served: number,
  rows: readonly { served: boolean; queued: boolean | undefined }[],
): number {
  return rows.reduce((count, row) => {
    if (row.queued === undefined || row.queued === row.served) return count;
    return count + (row.queued ? 1 : -1);
  }, served);
}

/**
 * The longest a replay may wait for its answer: a request hung on a flaky
 * link would otherwise hold the drain lock for every tab, and sign-out
 * behind it. Aborted, it is a network error: retried with backoff.
 */
export const REPLAY_TIMEOUT_MS = 15_000;

/**
 * The page's message to the service worker after a drain saved queued
 * writes (plan section 5): `{ type, paths }`, the saved records' paths. The
 * worker refetches the cached pages that show them (`showsQueuedWrite`), so
 * a page reopened offline later shows the synced state, not the one cached
 * before the tap (views/assets/src-sw.ts, refetchSyncedPages).
 */
export const OUTBOX_SYNCED = 'OUTBOX_SYNCED';

/**
 * The worker's answer to every tab it controls once that refetch is done:
 * `{ type, pages: [{ url, fragment, html, fetchedAt }] }`, each cached page
 * (or `|hx` fragment) whose server copy differs from the one it replaced. A
 * tab showing one swaps it in as a revalidation's (public/js/freshness.js,
 * which spells this string itself: it cannot import a TS module).
 */
export const PAGES_RENEWED = 'PAGES_RENEWED';

/**
 * Which queued writes go when a page claims the worker's page cache
 * (src-sw.ts, claimPageCache): `owner` is the cache's account before the
 * claim (undefined: none), `account` the claiming page's X-Page-Account
 * ('' signed out). Undefined when none go: the same owner, or a signed-out
 * page (signing back in as the same account replays them). Otherwise the
 * test a record's `account` field fails to stay: every other account's go,
 * as the page's own rule does (outbox.ts). Compared as they are stored:
 * X-Page-Account and `#app-status`'s `data-account` (what a record carries)
 * are both `String(user.id)`, and a record in any other spelling of the
 * same account would be deleted (test/integration/queued-writes.spec.ts
 * holds the two equal).
 */
export function queuedWritesGoneAtClaim(
  owner: string | undefined,
  account: string,
): ((recordAccount: unknown) => boolean) | undefined {
  if (account === '' || owner === account) return undefined;
  return (recordAccount) => recordAccount !== account;
}

/**
 * An OUTBOX_SYNCED message's paths as the worker may act on them: only a
 * path the replay allowlist takes, each once. Anything else is dropped, so
 * a message can never make the worker fetch a page of its choosing.
 */
export function syncedWritePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const accepted = paths.filter(
    (path): path is string =>
      typeof path === 'string' && queueableKindOf(path) !== undefined,
  );
  return [...new Set(accepted)];
}

// The pages that render a queued write's state (as literals: this layer
// imports no web/ module): a garment's own page (its wear section) and the
// laundry (a wear makes a garment dirty, a wash clean); Today, the calendar's
// weeks and a trip's page (each draws WornControl, and the entry's wears
// feed the laundry); a trip's page for its ticks.
const ENTRY_PAGES = new Set(['/', '/calendar']);

/**
 * The pages that render a `data-offline-queue` control and are no tab root
 * or Today: the laundry and a trip's page. One list for both readers, so
 * they cannot drift: `showsQueuedWrite` refetches them after a replay, and
 * the warm list (src/web/shell/warm-list.ts) names them, so the installed
 * app opens them offline without a prior visit (#657). A new page that
 * renders a queueable control joins here; test/integration/offline-warm.spec.ts
 * fails while one shown by `showsQueuedWrite` is neither here, warmed
 * elsewhere (a garment's page) nor a page the warm leaves out on purpose.
 */
export const LAUNDRY_PAGE = '/laundry';
const TRIP_PAGE = /^\/trips\/[1-9]\d{0,9}$/;

/** Whether `pagePath` is one of the queueable pages the warm must name. */
export function isQueueablePage(pagePath: string): boolean {
  return pagePath === LAUNDRY_PAGE || TRIP_PAGE.test(pagePath);
}

/**
 * Whether a page (its pathname; any query, so every cached week or filter)
 * shows the state the queued write at `writePath` changes. A garment's wear
 * count on the pages of an entry's outfit is left to the page's own
 * revalidation: the entry's path does not name its garments.
 */
export function showsQueuedWrite(writePath: string, pagePath: string): boolean {
  const kind = queueableKindOf(writePath);
  const id = writePath.split('/')[2];
  switch (kind) {
    case 'wear':
    case 'wash':
      return pagePath === `/wardrobe/${id}` || pagePath === LAUNDRY_PAGE;
    case 'entry':
      return ENTRY_PAGES.has(pagePath) || isQueueablePage(pagePath);
    case 'packed':
    case 'item':
      return pagePath === `/trips/${id}`;
    case undefined:
      return false;
  }
}

const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** The wait before the next drain after `attempts` failed ones: 5 s doubling, at most 5 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(
    RETRY_FIRST_MS * 2 ** Math.max(attempts - 1, 0),
    RETRY_MAX_MS,
  );
}

/**
 * Consecutive 5xx answers after which a record is `stuck` (#691, #865): kept
 * queued, skipped by the drain, named in the notice. A 5xx says nothing sure
 * about who is at fault (the record or the server), so a record is never
 * failed or dropped for one.
 */
export const STUCK_AFTER_SERVER_ERRORS = 3;
/** The longest a stuck record waits before the drain tries it again by itself. */
export const STUCK_RETRY_MS = 30 * 60_000;
/**
 * The first wait of a record that just became stuck. It doubles with every
 * further 5xx up to STUCK_RETRY_MS, so a short database blip (about three
 * drains of 500s, while the heartbeat's probe keeps answering) costs minutes,
 * not the half hour of a poisoned record.
 */
export const STUCK_RETRY_FIRST_MS = 60_000;

/** How long a record stuck after `serverErrors` 5xx waits for its next try. */
export function stuckRetryMs(serverErrors = STUCK_AFTER_SERVER_ERRORS): number {
  const doublings = Math.min(
    Math.max(0, serverErrors - STUCK_AFTER_SERVER_ERRORS),
    16,
  );
  return Math.min(STUCK_RETRY_MS, STUCK_RETRY_FIRST_MS * 2 ** doublings);
}

/** A record the replay may settle: its attempts, for the backoff, and its 5xx state. */
export type ReplayRecord = StoredRecord & {
  attempts: number;
  /** Consecutive 5xx answers; absent on an older client's record. */
  serverErrors?: number;
  /** When it became stuck, or last answered 5xx while stuck: its retry clock. */
  stuckAt?: number;
};

export const isStuck = (record: ReplayRecord) => record.stuckAt !== undefined;

/** A stuck record with its counters cleared: the notice's "Try again". */
export function unstuck<R extends ReplayRecord>(record: R): R {
  return {
    ...record,
    attempts: 0,
    serverErrors: undefined,
    stuckAt: undefined,
  };
}

/** What replayQueue tells its driver to do with a record. */
export type ReplayStep<R> =
  | { step: 'saved'; changed: boolean }
  /** Refused for good: `record` is the failed one. */
  | { step: 'failed'; record: R }
  /** Stays queued: `record` has its attempt counted (and its 5xx state as it now stands). */
  | {
      step: 'kept';
      record: R;
      why: 'server-error' | 'stuck' | typeof UNREACHABLE;
    };

export interface ReplayDriver<R> {
  /** True for a record not to be sent (not a queued write, or replaced since the read). */
  skip(record: R): Promise<boolean>;
  send(record: R): Promise<ReplayVerdict>;
  /** Whether the record was still queued, so the step applied. */
  settle(record: R, step: ReplayStep<R>): Promise<boolean>;
  now(): number;
}

export type ReplayEnd =
  | { end: 'done' }
  | { end: 'no-session' }
  | { end: 'backoff'; retryInMs: number };

/**
 * One drain over the pending records, oldest first (the outbox's replayAll).
 * It infers nothing about the server's health and drops nothing:
 *
 * - A 5xx keeps the record queued and counts (`serverErrors`); at
 *   STUCK_AFTER_SERVER_ERRORS it is `stuck`. The drain goes on with other
 *   records, so one handler bug does not hold the rest, and a server-wide
 *   outage marks several stuck and loses none.
 * - A stuck record is skipped, with its key, unless it is due: its
 *   `stuckAt` is STUCK_RETRY_MS old, or a record was saved in this drain,
 *   which shows the server answering (it is then tried once more at the end).
 *   Still 5xx, it stays stuck; only the notice's Discard or a newer tap on
 *   its key ends it.
 * - A record that stays queued holds its key for the rest of the drain: no
 *   record with that key is sent past it. Other keys go on.
 * - A drain that follows the server answering again (`serverAnswering`: the
 *   heartbeat's probe succeeding after a non-online spell) tries every
 *   stuck record in its turn.
 * - The network, a timeout, 408, 429, 502, 503 and 504 stop the drain and
 *   spend nothing; a 401 stops it and keeps everything.
 */
export async function replayQueue<R extends ReplayRecord>(
  queued: readonly R[],
  driver: ReplayDriver<R>,
  { serverAnswering = false } = {},
): Promise<ReplayEnd> {
  let held = new Set<string>();
  let anySaved = false;
  let retryInMs: number | undefined;
  const wait = (ms: number) => {
    retryInMs = Math.min(retryInMs ?? ms, ms);
  };
  const backoff = (): ReplayEnd => ({
    end: 'backoff',
    retryInMs: retryInMs ?? 0,
  });

  // Sends one record and settles its answer; an end when the drain stops.
  const attempt = async (record: R): Promise<ReplayEnd | undefined> => {
    const answer = await driver.send(record);
    if (answer.verdict === 'saved') {
      anySaved = true;
      await driver.settle(record, { step: 'saved', changed: answer.changed });
    } else if (answer.verdict === 'failed') {
      await driver.settle(record, {
        step: 'failed',
        record: { ...record, state: 'failed', reason: answer.reason },
      });
    } else if (!('cause' in answer)) {
      return { end: 'no-session' };
    } else if (answer.cause === UNREACHABLE) {
      const kept = { ...record, attempts: record.attempts + 1 };
      await driver.settle(record, {
        step: 'kept',
        record: kept,
        why: UNREACHABLE,
      });
      wait(retryDelayMs(kept.attempts));
      return backoff();
    } else {
      const serverErrors = (record.serverErrors ?? 0) + 1;
      const stuck =
        isStuck(record) || serverErrors >= STUCK_AFTER_SERVER_ERRORS;
      const kept = {
        ...record,
        attempts: record.attempts + 1,
        serverErrors,
        ...(stuck ? { stuckAt: driver.now() } : {}),
      };
      await driver.settle(record, {
        step: 'kept',
        record: kept,
        why: stuck ? 'stuck' : 'server-error',
      });
      held.add(record.key);
      wait(stuck ? stuckRetryMs(serverErrors) : retryDelayMs(kept.attempts));
    }
    return undefined;
  };

  // Stuck records not yet due: skipped, and tried at the end if a record saves.
  const parked: R[] = [];
  const waiting = new Set<R>();
  for (const record of queued) {
    if (held.has(record.key)) continue;
    if (isStuck(record) && !serverAnswering) {
      const stuckFor = driver.now() - (record.stuckAt ?? 0);
      // A negative age is a clock that moved back (or another tab's ahead):
      // due, not parked until the clock catches up.
      if (stuckFor >= 0 && stuckFor < stuckRetryMs(record.serverErrors)) {
        held.add(record.key);
        parked.push(record);
        waiting.add(record);
        continue;
      }
    }
    if (await driver.skip(record)) continue;
    const end = await attempt(record);
    if (end) return end;
  }

  // The server answered a record: the stuck ones are worth another try.
  if (anySaved) {
    held = new Set();
    for (const record of parked) {
      if (held.has(record.key)) continue;
      waiting.delete(record);
      if (await driver.skip(record)) continue;
      const end = await attempt(record);
      if (end) return end;
    }
  }
  // Only a parked record still waiting sets the timer: one the retry saved
  // (or found replaced) leaves nothing to come back for.
  for (const record of waiting) {
    wait(
      stuckRetryMs(record.serverErrors) -
        (driver.now() - (record.stuckAt ?? 0)),
    );
  }
  return retryInMs === undefined ? { end: 'done' } : backoff();
}

/** Runs `task` once nothing else holds the turn: the drain's lock, in the page. */
export type Exclusively = <T>(task: () => Promise<T>) => Promise<T>;

/** An in-tab queue of turns: the drain lock where `navigator.locks` is missing (an insecure context). */
export function createTurns(): Exclusively {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * The attributes of a notice button while its action waits for the drain's
 * turn: disabled so a second tap is not taken, `aria-busy` for the status
 * region it sits in.
 */
export const actionBusyAttributes = (busy: boolean): Record<string, string> =>
  busy ? { 'aria-busy': 'true', disabled: '' } : {};

/** The store the notice's buttons act through (the page's IndexedDB; a stub in the spec). */
export interface StuckActionStore<R extends ReplayRecord> {
  find(id: string): Promise<R | undefined>;
  /** replayQueue's `settle`: `next` in the record's place, or deleted; whether it was still queued. */
  settle(record: R, next?: R): Promise<boolean>;
}

/**
 * The notice's Try again and Discard. Both take the drain's turn
 * (`exclusively`) and read the record inside it, so neither races a replay:
 * Discard never lets a resend land after it (a record the drain saved while
 * it waited is gone, and nothing is reverted), and Try again never clears a
 * record a drain still holds (its settle would write the counted copy back
 * over the cleared one) nor starts a second replay beside it. The caller
 * drains after Try again, outside the turn.
 *
 * Each returns the record it acted on, or undefined when it was gone.
 */
export async function retryStuck<R extends ReplayRecord>(
  store: StuckActionStore<R>,
  exclusively: Exclusively,
  id: string,
): Promise<R | undefined> {
  return exclusively(async () => {
    const record = await store.find(id);
    if (!record || !isStuck(record)) return undefined;
    return (await store.settle(record, unstuck(record))) ? record : undefined;
  });
}

export async function discardStuck<R extends ReplayRecord>(
  store: StuckActionStore<R>,
  exclusively: Exclusively,
  id: string,
): Promise<R | undefined> {
  return exclusively(async () => {
    const record = await store.find(id);
    if (!record) return undefined;
    return (await store.settle(record)) ? record : undefined;
  });
}
