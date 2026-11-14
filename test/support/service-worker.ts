import { type BrowserContext, expect, type Page } from '@playwright/test';
import { PAGES_CACHE } from '../../src/web/page-cache';

/** Where withoutWarming keeps the real postMessage for warmOnce. */
const ORIGINAL_POST_MESSAGE = '__closetPostMessage';

/** The worker's image cache (views/assets/src-sw.ts, IMAGES_CACHE). */
const IMAGES_CACHE = 'images-v2';

/**
 * Takes the device off the network and puts it back. Chromium's setOffline
 * cuts the page's requests and the navigation preload but not a request the
 * worker makes itself (NetworkFirst for an htmx request, REVALIDATE_PAGE,
 * CacheFirst for an image), which the route fails meanwhile.
 */
export async function networkSwitch(context: BrowserContext) {
  let offline = false;
  await context.route('**/*', async (route) => {
    if (offline) await route.abort('internetdisconnected');
    else await route.fallback();
  });
  return async (state: 'offline' | 'online') => {
    offline = state === 'offline';
    await context.setOffline(offline);
  };
}

/**
 * Closes a context that went through networkSwitch. The switch's handler
 * answers every request the context makes, and a device left offline with
 * queued writes keeps making them (the outbox's replays, the heartbeat). A
 * request whose handler is still awaiting its `abort()` when the context goes
 * away gets "Target page, context or browser has been closed" from it, and
 * that rejection lands on `close()` (#867). 'ignoreErrors' drops those
 * in-flight handlers' errors instead, without waiting on them: 'wait' (#868)
 * made teardown wait on every `abort()`'s browser round trip, which Playwright
 * races only against the request's page or worker closing, so one that never
 * answered hung the scenario until its timeout (#886). Nothing those handlers
 * still do matters once the device is offline and closing.
 * setOffline(true) comes first: unrouting alone would put the device online
 * for a moment, and its queued ticks and wears would replay against the shared
 * e2e server, changing other scenarios' state. Chromium's own network kill
 * needs no route.
 */
export async function closeSwitchedContext(
  context: BrowserContext,
): Promise<void> {
  await context.setOffline(true);
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
}

/**
 * Loads /wardrobe and waits until the service worker controls the page, so
 * the next navigation goes through it. A freshly registered worker precaches
 * in the background first.
 */
export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.goto('/wardrobe');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

/** The paths the page cache holds (pages and fragments alike). */
export function cachedPaths(page: Page): Promise<string[]> {
  return page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  }, PAGES_CACHE);
}

/** Visits `path` through the worker until its page is in the cache. */
export async function cachePage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect.poll(() => cachedPaths(page)).toContain(path);
}

/** The images the worker's image cache holds, as path and query. */
export function cachedImages(page: Page): Promise<string[]> {
  return page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => {
      const url = new URL(request.url);
      return `${url.pathname}${url.search}`;
    });
  }, IMAGES_CACHE);
}

/**
 * Every URL Workbox's expiration keeps a row for (its `workbox-expiration`
 * IndexedDB, one row per URL an ExpirationPlugin saw stored), as
 * `<cache> <path and query>`. Read only once a row has been written:
 * opening a database that does not exist yet would create it without its
 * store, and Workbox's own open would then find no store to write to.
 */
export function expirationUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const name = 'workbox-expiration';
    if (!(await indexedDB.databases()).some((db) => db.name === name)) {
      return [];
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error(`open ${name}`));
    });
    try {
      const rows = await new Promise<{ cacheName: string; url: string }[]>(
        (resolve, reject) => {
          const all = db
            .transaction('cache-entries')
            .objectStore('cache-entries')
            .getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () =>
            reject(all.error ?? new Error('read cache-entries'));
        },
      );
      return rows.map((row) => {
        const url = new URL(row.url);
        return `${row.cacheName} ${url.pathname}${url.search}`;
      });
    } finally {
      db.close();
    }
  });
}

/**
 * The context's pages never post WARM_PAGES (pwa.js, #286), so the worker
 * never warms the wardrobe. For a spec whose cache contents or offline
 * pages are its own visits' alone: a warm running beside it would fill the
 * caches with every page and thumb. The message itself is held back, not a
 * record in the cache: every sign-in drops the caches, and the next page
 * would warm again.
 */
export async function withoutWarming(context: BrowserContext): Promise<void> {
  await context.addInitScript((storeAs) => {
    const post = Reflect.get(ServiceWorker.prototype, 'postMessage') as (
      ...args: unknown[]
    ) => void;
    // Kept for warmOnce: the one WARM_PAGES a spec asks for itself.
    Reflect.set(window, storeAs, post);
    ServiceWorker.prototype.postMessage = function (
      this: ServiceWorker,
      message: unknown,
      ...rest: unknown[]
    ) {
      const type = (message as { type?: unknown } | null)?.type;
      if (type === 'WARM_PAGES') return;
      Reflect.apply(post, this, [message, ...rest]);
    };
  }, ORIGINAL_POST_MESSAGE);
}

/**
 * Asks the controlling worker for exactly one warm, on a page of a context
 * under withoutWarming: the spec, not a load or a controllerchange, decides
 * when the run starts, so a second WARM_PAGES cannot queue another run
 * behind it (warmPages' warmAgain) and hide what the first one did.
 */
export async function warmOnce(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const post = Reflect.get(window, key) as (...args: unknown[]) => void;
    Reflect.apply(post, navigator.serviceWorker.controller, [
      { type: 'WARM_PAGES' },
    ]);
  }, ORIGINAL_POST_MESSAGE);
}

/**
 * Tells the worker a session is ending (what a sign-in or sign-out post does,
 * pwa.js) and returns once its drop has emptied the page cache: a sentinel
 * put there first is the proof, since the worker's console cannot be waited
 * on (Playwright can attach to it after its first lines). The generation
 * moved before the first delete, so whatever the worker fetched earlier is
 * overtaken by now.
 */
export async function dropSessionCaches(page: Page): Promise<void> {
  const sentinel = '/spec-drop-sentinel';
  await page.evaluate(
    async ([cacheName, key]) => {
      const cache = await caches.open(cacheName);
      await cache.put(key, new Response('x'));
      navigator.serviceWorker.controller?.postMessage({
        type: 'SESSION_ENDING',
      });
    },
    [PAGES_CACHE, sentinel] as const,
  );
  await page.waitForFunction(
    async ([cacheName, key]) =>
      !(await (await caches.open(cacheName)).match(key)),
    [PAGES_CACHE, sentinel] as const,
  );
}

/**
 * Holds the worker's first fetch of the warm list (`/offline/warm`) until
 * `release()`, by wrapping `fetch` inside the worker itself. A route cannot
 * do it: Playwright attaches its interception to a service worker after the
 * worker has started, and a request made before that goes unseen. Call it
 * once the worker controls the page, before the warm is asked for. Known
 * limit: the wrapper lives in the worker's memory, so a browser restart of an
 * idle worker loses it (the hold then never reports asked).
 */
export async function holdWarmList(page: Page) {
  const [worker] = page
    .context()
    .serviceWorkers()
    .filter((candidate) => new URL(candidate.url()).pathname === '/sw.js');
  if (!worker) {
    throw new Error('holdWarmList: no /sw.js service worker in the context');
  }
  await worker.evaluate(() => {
    const real = self.fetch.bind(self);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    Reflect.set(self, 'releaseWarmList', release);
    self.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (
        !held &&
        new URL(url, self.location.href).pathname === '/offline/warm'
      ) {
        held = true;
        Reflect.set(self, 'warmListHeld', true);
        await gate;
      }
      return real(input, init);
    };
  });
  return {
    /** Whether the worker has asked for the list and is waiting on it. */
    asked: () =>
      worker.evaluate(() => Reflect.get(self, 'warmListHeld') === true),
    release: () =>
      worker.evaluate(() => {
        (Reflect.get(self, 'releaseWarmList') as () => void)();
      }),
  };
}
