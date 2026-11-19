/**
 * The freshness indicator (frontend-pwa.md: reads render from cache with a
 * "last updated" timestamp). Started by pwa.ts on every page, with or
 * without a service worker: htmx's history snapshots and the back-forward
 * cache are caches too, and a page no worker controls (the HTTP twin, which
 * has no `navigator.serviceWorker` at all) still takes the server's copy
 * after a sync.
 *
 * What is on screen came from the network (live: nothing to say) or from a
 * cache: the service worker's (views/assets/src-sw.ts: a tab root opened
 * stale-while-revalidate, or any page whose network request timed out or
 * failed) or htmx's history snapshots. For a cached copy a minute old or
 * more, #freshness in the app bar says "Updated 3 minutes ago".
 *
 * A cached page asks the worker to revalidate itself as soon as this script
 * runs (checkDocument), and again whenever the device comes back online
 * while showing one (connectivity:change): the same REVALIDATE_PAGE request
 * every time. Once the outbox has saved queued writes a page on screen
 * shows (outbox:synced, outbox.ts), the page fetches its server copy
 * itself and takes it the same way, live or cached, controlled or not: the
 * worker renews only the copies it cached, so asking it would find nothing
 * new (#900). When the server's page differs it is swapped in at once if
 * the page is untouched (no tap, key or wheel yet, scrolled to the top, no
 * dialog open); otherwise a toast offers it ("Newer version of this page",
 * Refresh), so content never moves under a thumb or a half-typed form. When
 * the session turned out to be gone or to be another account's, the page
 * reloads: what is on screen is not this session's.
 */
import { ageLabel } from 'age-label';
import { latestOnly } from 'single-flight';
import { showToast } from 'toast';
import { OUTBOX_SYNCED_EVENT } from '../../../src/offline-writes';
import { PAGE_TAG_TIMING_NAME } from '../../../src/page-tag';
import {
  CACHED_AT_HEADER,
  CACHED_AT_TIMING_NAME,
} from '../../../src/web/page-cache';
import {
  APP_STATUS_ID,
  CONNECTIVITY_CHANGE_EVENT,
  FETCHED_AT,
  FRESHNESS_CHANGE_EVENT,
  FRESHNESS_ID,
  PAGE_ETAG,
  type StatusText,
  statusTextAttribute,
} from '../../../src/web/page-contract';

// Online, a revalidation lands within a few hundred ms: the age waits this
// long so a copy about to be replaced does not flash it.
const REVALIDATION_GRACE_MS = 1_000;
const TICK_MS = 30_000;

const text = (name: StatusText) =>
  document
    .getElementById(APP_STATUS_ID)
    ?.getAttribute(statusTextAttribute(name)) ?? undefined;
const pageUrl = () => location.href.split('#')[0];

/**
 * A fragment that pushed its URL (the wardrobe's filters): where it was
 * swapped and how, so a revalidation asks for the fragment again and swaps
 * the server's in the same way.
 */
interface Fragment {
  targetId: string;
  swapStyle: string;
}

interface Display {
  id: number;
  url: string;
  /** When the server produced what is on screen (epoch ms). */
  fetchedAt: number;
  /**
   * The server's tag for what is on screen (tagOf: its opaque value), sent
   * back as If-None-Match after a sync; undefined when unknown (a fragment,
   * a copy taken before the worker said it), and then any copy is newer.
   */
  etag: string | undefined;
  fromCache: boolean;
  /** The age stays hidden until then, waiting for a revalidation. */
  quietUntil: number;
  interacted: boolean;
  offer: { dismiss: () => void } | null;
  /** Null for a whole page. */
  fragment: Fragment | null;
}

type DisplayFields = Partial<
  Pick<Display, 'fetchedAt' | 'etag' | 'fromCache' | 'quietUntil' | 'fragment'>
>;

/**
 * What a revalidation found (the worker's REVALIDATE_PAGE answer, or the
 * page's own after a sync: takeServerCopy). `etag` is the ETag header.
 */
interface Revalidation {
  outcome: 'current' | 'updated' | 'signed-out' | 'account-changed' | 'failed';
  html?: string;
  fetchedAt?: number;
  etag?: string;
}

/** The display on screen: replaced whenever the page or its URL changes. */
let display = newDisplay();

function newDisplay(): Display {
  return {
    id: 0,
    url: pageUrl(),
    fetchedAt: Date.now(),
    etag: undefined,
    fromCache: false,
    quietUntil: 0,
    interacted: false,
    offer: null,
    fragment: null,
  };
}

function render() {
  const element = document.getElementById(FRESHNESS_ID);
  if (!element) return;
  const label =
    display.fromCache && Date.now() >= display.quietUntil
      ? ageLabel(Date.now() - display.fetchedAt, document.documentElement.lang)
      : null;
  if (label) {
    element.textContent = (text('updated-ago') ?? '').replace('{ago}', label);
  }
  element.classList.toggle('hidden', !label);
}

/** Describes the display on screen (fetchedAt, fromCache, quietUntil). */
function update(fields: DisplayFields) {
  Object.assign(display, fields);
  // In the body, so htmx's history snapshot of this page keeps it.
  // The page's day is read from it too (views/assets/outbox.ts, #708: Wore
  // today's state and guard, the day labels), which this event re-applies.
  const element = document.getElementById(FRESHNESS_ID);
  // The tag too, so a history restore knows which copy it shows.
  if (element) {
    if (display.etag) element.setAttribute(PAGE_ETAG, display.etag);
    else element.removeAttribute(PAGE_ETAG);
  }
  if (
    element &&
    element.getAttribute(FETCHED_AT) !== String(display.fetchedAt)
  ) {
    element.setAttribute(FETCHED_AT, String(display.fetchedAt));
    document.dispatchEvent(new CustomEvent(FRESHNESS_CHANGE_EVENT));
  }
  render();
  const wait = display.quietUntil - Date.now();
  if (wait > 0) setTimeout(render, wait);
}

/** A new display: another page, or this one at another URL. */
function startDisplay(fields: DisplayFields = {}) {
  display.offer?.dismiss();
  display = { ...newDisplay(), id: display.id + 1 };
  update(fields);
}

/** An ETag header's opaque value (W/ and quotes off): the weak comparison's. */
const tagOf = (header: string | null | undefined) =>
  header?.replace(/^W\//, '').replace(/"/g, '') || undefined;

function fromResponse(xhr: XMLHttpRequest): DisplayFields {
  const cachedAt = Number(xhr.getResponseHeader(CACHED_AT_HEADER));
  const etag = tagOf(xhr.getResponseHeader('ETag'));
  return cachedAt > 0
    ? { fetchedAt: cachedAt, fromCache: true, etag }
    : { fetchedAt: Date.now(), fromCache: false, etag };
}

/**
 * A URL-pushing fragment's display: its target and the swap its requesting
 * element named. The layout turns htmx's inheritance off, so the element's
 * own hx-swap is the one htmx used; the element is read after the swap,
 * detached by an outerHTML swap, which keeps its attributes.
 */
function fragmentOf(target: Element, requester: Element): Fragment {
  const swap = requester.getAttribute('hx-swap');
  return {
    targetId: target.id,
    swapStyle: swap?.split(' ')[0] || window.htmx.config.defaultSwapStyle,
  };
}

const untouched = () =>
  !display.interacted &&
  window.scrollY === 0 &&
  !document.querySelector('dialog[open]');

/**
 * The server's page in place of the cached one, as a boosted navigation
 * would (htmx processes it; the target in the event detail tells pwa.ts and
 * connectivity.ts the body was swapped). A fragment goes back into its
 * target the way its request swapped it, out-of-band parts included.
 */
function swapIn(html: string, fields: DisplayFields) {
  const { fragment } = display;
  const target = fragment
    ? document.getElementById(fragment.targetId)
    : document.body;
  // A fragment display's target is on screen: fragmentOf read its id from
  // the element its swap settled into, and a new display replaces it.
  window.htmx.swap(
    target as Element,
    html,
    { swapStyle: fragment ? fragment.swapStyle : 'innerHTML' },
    { eventInfo: { target } },
  );
  startDisplay({ ...fields, fragment });
}

function onRevalidated(
  id: number,
  { outcome, html, fetchedAt, etag: header }: Revalidation,
) {
  if (id !== display.id) return; // the user has moved on
  const path = location.pathname;
  const etag = tagOf(header);
  if (outcome === 'current') {
    update({ fetchedAt, fromCache: false, quietUntil: 0 });
  } else if (outcome === 'updated' && untouched()) {
    console.info(`[freshness] ${path}: newer copy swapped in`);
    swapIn(html ?? '', { fetchedAt, fromCache: false, etag });
  } else if (outcome === 'updated') {
    console.info(`[freshness] ${path}: newer copy offered`);
    update({ quietUntil: 0 });
    // One offer at a time: the newest copy replaces an older one's.
    display.offer?.dismiss();
    display.offer = showToast({
      text: text('newer-page') ?? '',
      kind: 'info',
      action: {
        label: text('refresh') ?? '',
        onClick: () => {
          if (id !== display.id) return;
          // Held since the revalidation: it says its age if that is long.
          swapIn(html ?? '', { fetchedAt, fromCache: true, etag });
          window.scrollTo(0, 0);
        },
      },
    });
  } else if (outcome === 'signed-out' || outcome === 'account-changed') {
    // The worker has dropped every cached page; the reload asks the server.
    console.info(`[freshness] ${path}: ${outcome}, reloading`);
    location.reload();
  } else {
    update({ quietUntil: 0 }); // failed: the copy stays, and says its age
  }
}

/** The worker's REVALIDATE_PAGE (views/assets/src-sw.ts). */
interface RevalidatePage {
  type: 'REVALIDATE_PAGE';
  url: string;
  fragment: boolean;
}

/**
 * Posts to the controlling worker; its answers come back on a port.
 * `navigator.serviceWorker` is undefined without a secure context.
 */
function ask(
  message: RevalidatePage,
  onAnswer: (answer: Revalidation) => void,
) {
  // Optional: the DOM lib types it as always there, and it is not.
  const worker = (navigator.serviceWorker as ServiceWorkerContainer | undefined)
    ?.controller;
  if (!worker) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent<Revalidation>) =>
    onAnswer(event.data);
  worker.postMessage(message, [channel.port2]);
}

/**
 * How this document was served: a Server-Timing entry the worker adds when
 * it answers from its cache (page-cache.ts's cacheWillUpdate), read through
 * Navigation Timing. Not asking the worker: it once had to remember what it
 * served, keyed by the navigation's resultingClientId, for this ask to
 * collect later, and WebKit can free that memory once the fetch event's own
 * waitUntil settles, before the page's script has even run (#240). A cached
 * page asks for REVALIDATE_PAGE itself at once instead, the same
 * self-contained request a reconnect makes below: nothing needs to survive
 * between the two.
 */
function checkDocument() {
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const timings = navigation?.serverTiming ?? [];
  const named = (name: string) =>
    timings.find((timing) => timing.name === name)?.description;
  // The server's tag for this document, live or cached (the copy keeps it).
  update({ etag: named(PAGE_TAG_TIMING_NAME) || undefined });
  const cachedAt = named(CACHED_AT_TIMING_NAME);
  if (cachedAt === undefined) return; // answered live: nothing more to say
  const id = display.id;
  update({
    fetchedAt: Number(cachedAt),
    fromCache: true,
    quietUntil: Date.now() + REVALIDATION_GRACE_MS,
  });
  ask(
    { type: 'REVALIDATE_PAGE', url: display.url, fragment: false },
    (answer) => onRevalidated(id, answer),
  );
}

/**
 * The server's copy of the display, fetched by the page itself (a
 * fragment's with HX-Request, as its request was) and conditional on the
 * tag of what is on screen: a 304, or a 200 with that same tag, is
 * `current` (nothing offered, #900); a 200 with another tag, or with none
 * known, is `updated`: swapped in if untouched, else offered. Only a 200
 * HTML answer that was not redirected is a copy of this page; anything else
 * (unreachable, signed out, an error page) leaves the page as the outbox
 * drew it, and the next revalidation or load asks again.
 *
 * One at a time per page (latestOnly): each outbox:synced asks again, the
 * newer request aborts the older, and an older answer arriving late is
 * dropped, so a stale copy never replaces a newer one. A display left
 * meanwhile drops it too (onRevalidated's id).
 */
const takeServerCopy = latestOnly(
  async (signal): Promise<{ id: number; answer: Revalidation } | null> => {
    const { id, url, fragment, etag } = display;
    const path = location.pathname;
    const headers: Record<string, string> = {};
    if (fragment) headers['HX-Request'] = 'true';
    else if (etag) headers['If-None-Match'] = `W/"${etag}"`;
    try {
      // no-store: the server's own 304 reaches this script, never the HTTP
      // cache's 200 in its place.
      const response = await fetch(url, { headers, cache: 'no-store', signal });
      const tag = tagOf(response.headers.get('ETag') ?? undefined);
      if (response.status === 304 || (tag && tag === etag)) {
        console.info(`[freshness] ${path}: server copy after a sync unchanged`);
        return { id, answer: { outcome: 'current', fetchedAt: Date.now() } };
      }
      const type = response.headers.get('Content-Type') ?? '';
      if (!response.ok || response.redirected || !type.includes('text/html')) {
        console.info(
          `[freshness] ${path}: server copy after a sync answered ${response.status}, kept`,
        );
        return null;
      }
      const html = await response.text();
      return {
        id,
        answer: { outcome: 'updated', html, fetchedAt: Date.now(), etag: tag },
      };
    } catch (error) {
      if (!signal.aborted) {
        console.info(
          `[freshness] ${path}: server copy after a sync failed`,
          error,
        );
      }
      return null;
    }
  },
  (taken) => {
    if (taken) onRevalidated(taken.id, taken.answer);
  },
);

/** htmx:afterSettle's: xhr only for a swap that came from a request. */
interface HtmxSettleDetail {
  xhr?: XMLHttpRequest;
  target: Element;
  requestConfig: { elt: Element };
}

export function watchFreshness() {
  startDisplay();
  checkDocument();

  // Only what the user does counts, not a scroll the browser restores.
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(
      type,
      () => {
        display.interacted = true;
      },
      { capture: true, passive: true },
    );
  }

  // A boosted navigation swaps the body; a fragment that pushes a URL (the
  // wardrobe's filters, whose target has an id) is a new display too. Other
  // fragments are parts of this one. htmx's history swaps and swapIn carry
  // no xhr: handled below and in swapIn.
  document.addEventListener('htmx:afterSettle', (event) => {
    const { xhr, target, requestConfig } = (
      event as CustomEvent<HtmxSettleDetail>
    ).detail;
    if (!xhr) return;
    const page = target === document.body;
    if (!page && pageUrl() === display.url) return;
    startDisplay({
      ...fromResponse(xhr),
      fragment: page ? null : fragmentOf(target, requestConfig.elt),
    });
  });

  // Back (or forward): htmx restores its snapshot of the page, which kept
  // its stamp, or fetches the page when it has none.
  let missed: DisplayFields | null = null;
  document.addEventListener('htmx:historyCacheMissLoad', (event) => {
    missed = fromResponse(
      (event as CustomEvent<{ xhr: XMLHttpRequest }>).detail.xhr,
    );
  });
  document.addEventListener('htmx:historyRestore', (event) => {
    if ((event as CustomEvent<{ cacheMiss?: boolean }>).detail.cacheMiss) {
      startDisplay(missed ?? {});
      missed = null;
      return;
    }
    const kept = document.getElementById(FRESHNESS_ID);
    startDisplay({
      fetchedAt: Number(kept?.getAttribute(FETCHED_AT)) || Date.now(),
      fromCache: true,
      etag: kept?.getAttribute(PAGE_ETAG) ?? undefined,
    });
  });
  // The browser's back-forward cache is a cache too.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      startDisplay({
        fetchedAt: display.fetchedAt,
        fromCache: true,
        etag: display.etag,
      });
    }
  });

  // The server's copy of what is on screen, a fragment's for a fragment
  // (the worker keys it apart from the page).
  const revalidate = () => {
    const id = display.id;
    ask(
      {
        type: 'REVALIDATE_PAGE',
        url: display.url,
        fragment: display.fragment !== null,
      },
      (answer) => onRevalidated(id, answer),
    );
  };
  // Back online (connectivity.ts): a cached copy asks for the server's.
  document.addEventListener(CONNECTIVITY_CHANGE_EVENT, (event) => {
    if (event.detail.state === 'online' && display.fromCache) revalidate();
  });
  // Queued writes saved that the page shows (outbox.ts, #178): what is on
  // screen shows them only as the outbox drew them; the counts and lines
  // come with the server's copy, fetched here.
  document.addEventListener(OUTBOX_SYNCED_EVENT, () => {
    void takeServerCopy();
  });

  setInterval(render, TICK_MS);
  document.addEventListener('visibilitychange', render);
}
