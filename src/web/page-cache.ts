/**
 * What the server and the service worker's page cache agree on
 * (views/assets/src-sw.ts bundles this file; keep it free of Node and DOM).
 *
 * The tab roots open stale-while-revalidate: the worker answers a document
 * load from its cache at once and fetches the page again behind it. The
 * page on screen learns how old it is and whether the server's copy differs
 * from the worker (public/js/freshness.js), and says so.
 */

import { isApiPath } from './api-path';
import { LOGIN_PATH } from './auth/login-path';
import { INSPIRATION_SHARE_PATH } from './inspiration/share-target';
import { type Section, SECTION_HOME } from './layout/sections';

/**
 * The account a rendered page belongs to: the signed-in user's id, absent on
 * a signed-out render. Set by send() in src/web/render.ts on every HTML
 * answer. The worker keeps its page cache to one account and drops it when a
 * page for another arrives: it cannot read the httpOnly session cookie, so a
 * response is the only way it learns who is signed in.
 */
/**
 * The worker's page cache (views/assets/src-sw.ts). v2 since 2026-09-26:
 * copies are stamped and owned (pageStore); pages-v1 held neither and is
 * retired on activate. A full page is stored under its absolute URL
 * (pageCacheKey), which the offline fallback page reads to link only what
 * this device saved (`data-pages-cache`, public/js/connectivity.js).
 */
export const PAGES_CACHE = 'pages-v2';

export const PAGE_ACCOUNT_HEADER = 'X-Page-Account';

/**
 * Added by the worker to the copy it caches: when it received the page from
 * the server (epoch ms, the device's clock, the one the page compares it
 * with). Only a response served from the cache carries it; public/js/
 * freshness.js reads it from htmx's requests.
 */
export const CACHED_AT_HEADER = 'X-SW-Cached-At';

/**
 * The Server-Timing metric name the worker appends to a page it caches,
 * `desc` the same epoch ms as CACHED_AT_HEADER (#240). A document's own
 * script cannot read an arbitrary response header, only Server-Timing
 * (Navigation Timing's `serverTiming`, already how src/metrics reads the
 * route template), and reading it this way needs nothing the worker must
 * remember until the page asks: asking its own memory for what it served,
 * keyed by the navigation's resultingClientId, did not survive a worker
 * WebKit had stopped meanwhile (public/js/freshness.js duplicates this
 * name; it cannot import a TS module). Once the page sees this, it asks for
 * REVALIDATE_PAGE itself (src-sw.ts), a fresh, self-contained request that
 * needs nothing remembered either.
 */
export const CACHED_AT_TIMING_NAME = 'cache';

/**
 * Set by endSession (src/web/auth/session.ts) on every answer that ends a
 * session on this device: sign-out, account deletion, and a cookie that no
 * longer opens a session (revoked elsewhere, expired), whatever the answer
 * is, a 4xx included. The worker reads it as the session's end (#131).
 * Clear-Site-Data, sent beside it, cannot serve: Chromium applies it and
 * hides it from the response, the worker's own fetch included.
 */
export const SESSION_ENDED_HEADER = 'X-Session-Ended';

/** Whether the server ended this device's session with this answer. */
export function endedSession(headers: { has(name: string): boolean }): boolean {
  return headers.has(SESSION_ENDED_HEADER);
}

/** The MCP endpoint's path (src/web/mcp): an API for programs, never a page. */
export const MCP_PATH = '/mcp';

/** The wardrobe export's downloads (src/web/wardrobe/export-routes.ts, #200). */
export function wardrobeExportPath(format: 'csv' | 'json'): string {
  return `/wardrobe/export.${format}`;
}

const EXPORT_PATHS: ReadonlySet<string> = new Set([
  wardrobeExportPath('csv'),
  wardrobeExportPath('json'),
]);

/**
 * Requests no worker route matches, so the worker neither answers nor
 * caches them: the MCP endpoint, the JSON API (isApiPath, the rule
 * surfaceOf reads), and the wardrobe export.
 * Programs call MCP and the API, not the app (and they have no worker),
 * but a browser tab opened on either must reach the server as it is and
 * never land in the page cache. An
 * export is a download the browser navigates to: as a page it would be
 * stored in the page cache (a whole wardrobe per copy) and answered from
 * there offline, stale.
 */
export function bypassesWorker(url: { pathname: string }): boolean {
  return (
    url.pathname === MCP_PATH ||
    url.pathname.startsWith(`${MCP_PATH}/`) ||
    isApiPath(url.pathname) ||
    EXPORT_PATHS.has(url.pathname)
  );
}

/**
 * What the worker does with a navigation that is not a GET (a form post,
 * ours or a cross-site page's): it **never sends one to the server**
 * (#542, src-sw.ts). It cannot tell who started the post, and its own
 * fetch in the post's place would carry this site's Origin and cookie past
 * the same-origin check. So the fetch event of every one is stopped before
 * any route sees it, and:
 *  - `share-target`: the manifest's share target, the one it answers, on the
 *    device (receiveShare: a stash and a 303, no fetch; share-target.ts);
 *  - `browser`: any other, left to the browser, which posts it as it is and
 *    the server judges its real Origin.
 * Undefined for every other request: the worker's routes.
 */
export function navigationPostAnswer(
  request: { method: string; mode: string; url: string },
  origin: string,
): 'share-target' | 'browser' | undefined {
  if (request.mode !== 'navigate' || request.method === 'GET') return undefined;
  const url = new URL(request.url);
  return request.method === 'POST' &&
    url.origin === origin &&
    url.pathname === INSPIRATION_SHARE_PATH
    ? 'share-target'
    : 'browser';
}

/**
 * The sections whose home opens stale-while-revalidate: every one but
 * Today. Styling's `/styling` (#42) qualifies: the bare page is the fresh
 * stack, a function of the wardrobe alone (freshStates: every row on "No
 * garment", never the day's seed, the forecast, rotation or what
 * is clean), so it renders byte for byte the same until the wardrobe
 * changes; Shuffle's seed only appears once Shuffle answers. Its other
 * addresses (`?with=`, `?for=`, `?outfit=`, `?ownerId=`) carry a query and
 * go to the network like every navigation. Today (`/`, the manifest's start_url) is all of the day's own
 * data (the plan, the suggestions, what was worn, the weather through
 * them), so it could only be byte-stable by loading all of it as
 * fragments, leaving a shell with a date; and a copy opened first would
 * put yesterday's plan and "Wear this" on screen. It is NetworkFirst like
 * any page (the navigation preload races a cold worker), and offline the
 * worker's last copy shows with its age (freshness.js) and its writes
 * disabled. #15 decided it.
 */
export const OPENS_STALE: readonly Section[] = [
  'wardrobe',
  'styling',
  'outfits',
  'calendar',
];

/**
 * The tab roots the worker opens from its cache. Exact paths without a
 * query: a filtered wardrobe or another calendar week is a place the user
 * navigated to, and goes to the network first like every other page. Never
 * warmed (src/web/shell/warm-list.ts, parseWarmList): cached when opened.
 */
export const TAB_ROOTS: ReadonlySet<string> = new Set(
  OPENS_STALE.map((section) => SECTION_HOME[section]),
);

/**
 * Whether the worker answers this request from its cache before asking the
 * server. Document loads only (opening the app, a reload, a typed URL): an
 * in-app tap is an htmx request that follows the user's own writes (an
 * archive lands on /wardrobe through HX-Location), and must show them, so it
 * stays network first.
 */
export function servesStaleWhileRevalidate(
  request: { mode: string; url: string },
  origin: string,
): boolean {
  if (request.mode !== 'navigate') return false;
  const url = new URL(request.url);
  return (
    url.origin === origin && url.search === '' && TAB_ROOTS.has(url.pathname)
  );
}

/** When a cached page was stored; 0 for a response without the stamp. */
export function cachedAt(headers: {
  get(name: string): string | null;
}): number {
  const value = Number(headers.get(CACHED_AT_HEADER));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A stored copy's Server-Timing with its arrival stamp (CACHED_AT_TIMING_NAME)
 * set to `stampMs`: the server's entries kept, any earlier stamp replaced, so
 * a copy re-stamped on a 304 (#708) carries exactly one, the one
 * freshness.js finds first.
 */
export function stampedServerTiming(
  timing: string | null,
  stampMs: string,
): string {
  const kept = (timing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry !== '' && entry.split(';')[0].trim() !== CACHED_AT_TIMING_NAME,
    );
  return [...kept, `${CACHED_AT_TIMING_NAME};desc="${stampMs}"`].join(', ');
}

interface HeadersOf {
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * The If-None-Match a worker's refetch sends (#708; send(),
 * src/web/render.ts): the stored copy's ETag, only for a copy of the account
 * that owns the cache (`owner`, OWNER_KEY); none for another's, a copy
 * without one, or no copy.
 */
export function revalidationTag(
  copy: HeadersOf | undefined,
  owner: string | undefined,
): string | undefined {
  if (!copy || owner === undefined || pageAccount(copy.headers) !== owner) {
    return undefined;
  }
  return copy.headers.get('ETag') ?? undefined;
}

/**
 * Whether a refetch's 304 confirms the stored copy, which is then stored
 * again with a new stamp, its body unchanged: a 304 naming the copy's tag
 * and its account, which still owns the cache. Anything else stores nothing.
 */
export function confirmsCopy(
  answer: HeadersOf,
  copy: HeadersOf,
  owner: string | undefined,
): boolean {
  const account = pageAccount(copy.headers);
  return (
    answer.status === 304 &&
    owner !== undefined &&
    account === owner &&
    pageAccount(answer.headers) === account &&
    answer.headers.get('ETag') === copy.headers.get('ETag')
  );
}

/**
 * A page request the server redirected to the login page, which then
 * rendered for nobody (a followed redirect: htmx's boosted XHR, a
 * revalidation): nobody is signed in any more. The session gate is what
 * sends a page there, so it is how the worker learns of a session ended away
 * from this device (a password changed elsewhere, the account deleted, a
 * rotated secret, expiry), which no sign-out POST announced. The landing
 * page's account is what tells it apart from a redirect that keeps the
 * session: DISABLE_REGISTRATION sends a signed-in user from /auth/register to
 * the login page too, rendered for that user.
 */
export function sentToLogin(response: {
  redirected: boolean;
  url: string;
  headers: { get(name: string): string | null };
}): boolean {
  return (
    response.redirected &&
    new URL(response.url).pathname === LOGIN_PATH &&
    pageAccount(response.headers) === ''
  );
}

/**
 * Whether an answer to a page request is a page the page cache may keep:
 * HTML, which send() in src/web/render.ts renders and stamps with its
 * account. A navigation also reaches images (a photo or a selfie opened in a
 * tab); those carry no account, so storing one would claim the cache for
 * nobody, dropping the signed-in account's pages, and keep the image where
 * the next session could be served it.
 */
export function isRenderedPage(headers: {
  get(name: string): string | null;
}): boolean {
  const mediaType = headers.get('Content-Type')?.split(';')[0];
  return mediaType?.trim().toLowerCase() === 'text/html';
}

/**
 * Whether the server asked that no cache keep this answer (`no-store`): the
 * sign-in pages, whose URL and hidden field can carry an invite token
 * (#661), and the page showing a new access token once. The worker still
 * learns from it who is signed in (claimPageCache), but never stores it
 * under a page key. Workbox itself ignores Cache-Control.
 */
export function forbidsStorage(headers: {
  get(name: string): string | null;
}): boolean {
  const directives = headers.get('Cache-Control')?.toLowerCase().split(',');
  return (
    directives?.some((directive) => directive.trim() === 'no-store') ?? false
  );
}

/** The account a response says it was rendered for; '' when signed out. */
export function pageAccount(headers: {
  get(name: string): string | null;
}): string {
  return headers.get(PAGE_ACCOUNT_HEADER) ?? '';
}

/**
 * Who an answer says is signed in, read only from a page that rendered: a
 * 200 HTML answer, its account ('' signed out); undefined for anything else.
 * The one rule both of the worker's account checks share (pageStore's claim,
 * claimPageCache, and a tab root's revalidation, revalidationOutcome): any
 * other answer says nothing about the session. The server's busy page (a 503
 * when the database is out of reach, #643) is rendered signed out, since the
 * session could not be read; taken as "signed out" it would drop the session
 * caches just before ServerFirstPages answers with their copy.
 */
export function renderedAccount(response: {
  status: number;
  headers: { get(name: string): string | null };
}): string | undefined {
  if (response.status !== 200 || !isRenderedPage(response.headers)) {
    return undefined;
  }
  return pageAccount(response.headers);
}

/**
 * What a revalidation found, compared with the copy on screen:
 *  - current: the server renders the same page;
 *  - updated: it renders a different one (someone changed something);
 *  - signed-out: the session is gone (the server redirects to the login
 *    page, or refuses);
 *  - account-changed: the server rendered it for another account, so the
 *    copy on screen is not this session's;
 *  - failed: no usable answer (offline, a timeout, a server error); the copy
 *    stays.
 */
export type Revalidation =
  | 'current'
  | 'updated'
  | 'signed-out'
  | 'account-changed'
  | 'failed';

export interface CachedPage {
  account: string;
  body: string;
}

export interface FreshPage {
  status: number;
  /** A redirect the worker saw (opaque for a navigation). */
  redirected: boolean;
  /** renderedAccount's: undefined unless the answer is a rendered page. */
  account: string | undefined;
  /** Read only for a 200. */
  body: string;
}

/** `fresh` is undefined when the request never got an answer. */
export function revalidationOutcome(
  cached: CachedPage,
  fresh: FreshPage | undefined,
): Revalidation {
  if (!fresh) return 'failed';
  // A tab root only redirects or refuses without a session.
  if (fresh.redirected || fresh.status === 401) return 'signed-out';
  if (fresh.account === undefined) return 'failed';
  if (fresh.account !== cached.account) {
    return fresh.account === '' ? 'signed-out' : 'account-changed';
  }
  return fresh.body === cached.body ? 'current' : 'updated';
}

/**
 * What the worker does with a cached page it fetched again itself (#656):
 * the activation refresh of every older-build copy and the refetch of the
 * pages a sync changed (refetchCachedPage, views/assets/src-sw.ts):
 *  - stored: a 200, through the page plugins like any page (the 200 filter,
 *    the owner claim, the stamp, the generation);
 *  - deleted: a 404 or a 403, gone or no longer this account's to see (a
 *    revoked share): its copies go, page and `|hx` fragment;
 *  - kept: a followed redirect to another page, never stored under this key
 *    (pageStore's rule), or another refusal: the old copy stays, settled;
 *  - failed: any other 5xx, this one page failing (a bug on one garment's
 *    page): the old copy stays, the run goes on to the next key, and the
 *    next run asks again;
 *  - stop: the server unreachable or throttling (a 429, or a 502, 503 or
 *    504 from it or the proxy before it): nothing more is asked, every copy
 *    stays, and the next WARM_PAGES resumes; a fetch that throws stops the
 *    same way (refetchCachedPage);
 *  - session-ended: a 401, X-Session-Ended or a redirect to the login page:
 *    the session caches go (endFetchedSession). Deliberately: it is how a
 *    password change or a revocation reaches a lost phone, at the cost of an
 *    expired cookie's offline copies.
 * The worker's fetch is no navigation, so the session gate answers it 401,
 * never the login page; no login page is stored under a page key either way.
 */
export type RefetchVerdict =
  | 'stored'
  | 'deleted'
  | 'kept'
  | 'failed'
  | 'stop'
  | 'session-ended';

/** The answers that say the server, not the page, is unwell. */
const UNAVAILABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Whether an answer says the server, not the page, is unwell (a 429, or a
 * 502, 503 or 504 from it or the proxy before it; the server's 503 `busy`
 * when its database is out of reach, #643). The worker treats it as no
 * answer: a refetch stops (refetchVerdict), and a page or htmx GET is
 * answered from its cached copy when it has one (ServerFirstPages,
 * views/assets/src-sw.ts), like a timeout.
 */
export function serverUnavailable(status: number): boolean {
  return UNAVAILABLE_STATUSES.has(status);
}

export function refetchVerdict(answer: {
  status: number;
  redirected: boolean;
  url: string;
  headers: { get(name: string): string | null; has(name: string): boolean };
}): RefetchVerdict {
  if (
    answer.status === 401 ||
    endedSession(answer.headers) ||
    sentToLogin(answer)
  ) {
    return 'session-ended';
  }
  if (answer.redirected) return 'kept';
  if (answer.status === 200) return 'stored';
  if (answer.status === 404 || answer.status === 403) return 'deleted';
  if (serverUnavailable(answer.status)) return 'stop';
  if (answer.status >= 500) return 'failed';
  return 'kept';
}

/** One key's refetch as the walk sees it (refetchInTurn). */
export type RefetchStep =
  | { verdict: 'stored' }
  | { verdict: 'kept' }
  | { verdict: 'failed' }
  | { verdict: 'deleted'; removed: number }
  | { verdict: 'stop' | 'session-ended' | 'unreachable'; stop: string };

export interface RefetchRun {
  stored: number;
  /** Copies deleted (a page and its `|hx` fragment count apart). */
  removed: number;
  kept: number;
  /** Keys whose page failed: their copies stay, due again next run. */
  failed: number;
  /** Why the walk ended early; undefined when it asked every key. */
  stop?: string;
}

/**
 * Refetches `keys` one at a time, in order (the activation refresh, a
 * sync's refetch): a failing page is counted and passed over, and only an
 * answer that says the server is unreachable, throttling or the session
 * over (RefetchStep's stop) ends the walk, as does `sessionChanged` (a drop
 * started a generation) before the next key.
 */
export async function refetchInTurn<Key>(
  keys: readonly Key[],
  refetch: (key: Key) => Promise<RefetchStep>,
  sessionChanged: () => boolean,
): Promise<RefetchRun> {
  const run: RefetchRun = { stored: 0, removed: 0, kept: 0, failed: 0 };
  for (const key of keys) {
    if (sessionChanged()) {
      run.stop = 'the session changed';
      break;
    }
    const step = await refetch(key);
    if (step.verdict === 'stored') run.stored += 1;
    else if (step.verdict === 'deleted') run.removed += step.removed;
    else if (step.verdict === 'kept') run.kept += 1;
    else if (step.verdict === 'failed') run.failed += 1;
    else {
      run.stop = step.stop;
      break;
    }
  }
  return run;
}

/**
 * A key the activation refresh found failing (a `failed` step), recorded
 * beside it in the pages cache (#782): how many runs in a row it failed and
 * when it is asked again. Without it, one page answering 500 kept the
 * refresh due, so every WARM_PAGES (each signed-in load, each return to the
 * app) rescanned the cache and asked that page again.
 */
export interface RefreshBackoff {
  failures: number;
  /** Epoch ms: the first run at or after it asks the key again. */
  retryAt: number;
  /**
   * The activation (its `activated-at`) whose refresh wrote it: a later
   * deploy may have fixed the page, so a record from an earlier activation
   * reads as none (parseRefreshBackoff) and the key is asked at once.
   */
  activatedAt: number;
}

/** The wait after a first failure, doubling with each one after it. */
export const REFRESH_BACKOFF_BASE_MS = 5 * 60_000;
/** The longest wait: a page that keeps failing is asked once a day. */
export const REFRESH_BACKOFF_CAP_MS = 24 * 60 * 60_000;

export function nextRefreshBackoff(
  previous: RefreshBackoff | undefined,
  now: number,
  activatedAt: number,
): RefreshBackoff {
  const failures = (previous?.failures ?? 0) + 1;
  const wait = Math.min(
    REFRESH_BACKOFF_BASE_MS * 2 ** (failures - 1),
    REFRESH_BACKOFF_CAP_MS,
  );
  return { failures, retryAt: now + wait, activatedAt };
}

/** Whether a due key sits this run out. */
export function isBackingOff(
  backoff: RefreshBackoff | undefined,
  now: number,
): backoff is RefreshBackoff {
  return backoff !== undefined && backoff.retryAt > now;
}

function parseRecord(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // An unreadable record reads as none: the key is asked, the scan runs.
    return undefined;
  }
}

/** A record's numeric field, or undefined for any other value or shape. */
function numberField(value: unknown, field: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const read: unknown = (value as Record<string, unknown>)[field];
  return typeof read === 'number' ? read : undefined;
}

/**
 * A stored backoff record, as the refresh of the activation at
 * `activatedAt` sees it: missing, unreadable or written under another
 * activation is none (expired, its failure count too).
 */
export function parseRefreshBackoff(
  text: string | undefined,
  activatedAt: number,
): RefreshBackoff | undefined {
  const value = parseRecord(text);
  const failures = numberField(value, 'failures');
  const retryAt = numberField(value, 'retryAt');
  if (
    failures === undefined ||
    retryAt === undefined ||
    numberField(value, 'activatedAt') !== activatedAt
  ) {
    return undefined;
  }
  return { failures, retryAt, activatedAt };
}

/**
 * When the refresh last asked every due key not backing off, and the
 * earliest backoff it left running: until then nothing is due, and a
 * WARM_PAGES skips the scan (refreshDue).
 */
export interface RefreshedRecord {
  at: number;
  retryAt?: number;
}

/** What a walk that asked every key writes; `waiting`: the keys left backing off. */
export function refreshedRecord(
  now: number,
  waiting: readonly RefreshBackoff[],
): RefreshedRecord {
  if (waiting.length === 0) return { at: now };
  return { at: now, retryAt: Math.min(...waiting.map((b) => b.retryAt)) };
}

/**
 * The stored record. A bare number was written before backoffs (#782) and
 * is its `at`; missing or unreadable is never refreshed.
 */
export function parseRefreshedRecord(
  text: string | undefined,
): RefreshedRecord | undefined {
  const value = parseRecord(text);
  if (typeof value === 'number') return { at: value };
  const at = numberField(value, 'at');
  if (at === undefined) return undefined;
  const retryAt = numberField(value, 'retryAt');
  return retryAt === undefined ? { at } : { at, retryAt };
}

/**
 * Whether a WARM_PAGES scans for older-build copies: nothing refreshed since
 * this worker activated, or a backoff the last refresh left has ended.
 */
export function refreshDue(
  record: RefreshedRecord | undefined,
  activatedAt: number,
  now: number,
): boolean {
  if (!record || record.at <= activatedAt) return true;
  return record.retryAt !== undefined && record.retryAt <= now;
}
