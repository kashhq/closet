import { type BrowserContext, type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { signIn } from './support/e2e-session';
import { type NextBuild, startNextBuild } from './support/next-build';
import { pageErrors } from './support/page-errors';
import { cachedPaths, networkSwitch } from './support/service-worker';

/**
 * The installed app's update flow (src/web/shell/AGENTS.md, Updates): a new
 * build's worker waits, public/js/pwa.js offers it in a toast, Reload posts
 * SKIP_WAITING (only online), and the page reloads once the new worker
 * controls it. Never a forced reload, in this window or another. Then the
 * activation refresh (#656): the pages build A stored still open offline
 * under build B, with their age, until B fetches each again, one at a time
 * in the cache's order, resuming where a cut stopped it.
 *
 * Each test runs the app behind its own proxy (test/support/next-build.ts),
 * which deploys a second build of the worker at the same URL; the browser
 * finds it with the update check it runs after navigations
 * (`registration.update()` here, so the check comes after pwa.js listens).
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys).
 */
test.describe('service worker update', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );
  test.use({ viewport: { width: 390, height: 844 } });

  let next: NextBuild;
  test.beforeEach(async ({ page }) => {
    next = await startNextBuild();
    await signIn(page, 'sw-update');
  });
  test.afterEach(async () => {
    await next.close();
  });

  test("offers a new build, reloads onto it only online, and keeps the older build's pages until refreshed", async ({
    page,
    context,
  }) => {
    const errors = pageErrors(page, { console: true });
    const setNetwork = await networkSwitch(context);
    const refetches = await recordRefetches(context);

    await openControlled(page, () => page.goto(`${next.origin}/wardrobe`));
    // The installed app opened again: a document the worker controls from
    // its first request (the other test's first window is the first visit).
    await openControlled(page, () => page.reload());
    // Each a first visit, NetworkFirst: no stale-first open, so no
    // revalidation rewrites a copy behind the spec's back.
    for (const path of ['/outfits', '/calendar']) {
      await page.goto(`${next.origin}${path}`);
      await expect.poll(() => cachedPaths(page)).toContain(path);
    }
    await openControlled(page, () => page.goto(`${next.origin}/`));
    await expect.poll(() => cachedPaths(page)).toContain('/');
    await markDocument(page);
    const builtByA = await storedPages(page);

    const build = next.deploy();
    await checkForUpdate(page);
    await expect(updateToast(page)).toBeVisible();
    // Installed and waiting: the page keeps its document and its worker.
    expect(await hasWaitingWorker(page)).toBe(true);
    expect(await isMarkedDocument(page)).toBe(true);

    // Offline, by the heartbeat: Reload would activate the new build with
    // no network to refresh the pages with. Disabled, saying why.
    const reload = updateToast(page).getByRole('button', { name: 'Reload' });
    await setNetwork('offline');
    await expect(page.locator('html')).toHaveAttribute(
      'data-connectivity',
      'offline',
    );
    await expect(reload).toBeDisabled();
    await expect(updateToast(page)).toContainText("once you're back online");
    await setNetwork('online');
    await expect(page.locator('html')).toHaveAttribute(
      'data-connectivity',
      'online',
    );
    await expect(reload).toBeEnabled();

    // A boosted navigation swaps the body, toast host included: the offer
    // comes back with the new page.
    await page.locator('.dock a[href="/outfits"]').click();
    await expect(page).toHaveURL(`${next.origin}/outfits`);
    await expect(updateToast(page)).toBeVisible();
    expect(await isMarkedDocument(page)).toBe(true);

    const reloaded = page.waitForEvent('load');
    await updateToast(page).getByRole('button', { name: 'Reload' }).click();
    await reloaded;
    await expect(page.locator('.dock')).toBeVisible();
    expect(await isMarkedDocument(page)).toBe(false);
    expect(await controllingBuild(page)).toBe(build);
    expect(await hasWaitingWorker(page)).toBe(false);
    await expect(updateToast(page)).toBeHidden();

    // The reload's WARM_PAGES started the refresh, whose every fetch is held
    // back: what A stored is still A's. Due, in the cache's order: every
    // copy stamped before B activated (the reloaded /outfits is B's now).
    const activatedAt = await activationTime(page);
    await expect
      .poll(async () =>
        (await storedPages(page)).some(
          (copy) =>
            copy.id === `${next.origin}/outfits` && copy.cachedAt > activatedAt,
        ),
      )
      .toBe(true);
    const due = (await storedPages(page)).filter(
      (copy) => copy.cachedAt <= activatedAt,
    );
    const dueIds = due.map((copy) => copy.id);
    expect(dueIds).toContain(`${next.origin}/wardrobe`);
    expect(dueIds.length).toBeGreaterThanOrEqual(3);
    for (const id of dueIds) {
      expect(builtByA.map((copy) => copy.id)).toContain(id);
    }

    // Cut off after the activation, the app opens A's copy of a tab root
    // (NetworkFirst's fallback, never stale-first) with its age, and A's
    // page runs: its modules resolve, so no page error.
    await setNetwork('offline');
    const wardrobeByA = due.find(
      (copy) => copy.id === `${next.origin}/wardrobe`,
    );
    const offline = await context.newPage();
    const offlineErrors = pageErrors(offline);
    await offline.goto(`${next.origin}/wardrobe`);
    await expect(offline.locator('.dock')).toBeVisible();
    await expect(offline.locator('#freshness')).toHaveAttribute(
      'data-fetched-at',
      String(wardrobeByA?.cachedAt),
    );
    // Two minutes on, the app brought back to the foreground: the label.
    // The clock goes in only now: Playwright's fake clock also fakes
    // `performance`, whose Navigation Timing freshness.js reads the stamp
    // from on load.
    await offline.clock.install();
    await offline.clock.fastForward('02:00');
    await offline.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    await expect(offline.locator('#freshness')).toHaveText(
      /^Updated \d+ minutes ago$/,
    );
    expect(offlineErrors).toEqual([]);
    await offline.close();

    // Back online, one key cut: the refresh walks the cache in order and
    // stops there; nothing after it is asked. Then it resumes at the cut
    // key on the next WARM_PAGES, never asking again for what it renewed.
    await setNetwork('online');
    refetches.cut = dueIds[1];
    refetches.hold = false;
    await askToWarm(page);
    await expect
      .poll(() => refetches.since(dueIds, 'cut'))
      .toContain(dueIds[1]);
    expect(refetches.since(dueIds, 'answered')).toEqual([dueIds[0]]);

    refetches.cut = undefined;
    await askToWarm(page);
    await expect
      .poll(async () =>
        (await storedPages(page)).filter(
          (copy) => copy.cachedAt <= activatedAt,
        ),
      )
      .toEqual([]);
    expect(refetches.since(dueIds, 'answered')).toEqual(dueIds);
    // The new build serves the same pages (only its worker changed), so each
    // page was asked with its copy's tag and confirmed by a 304 (#708): its
    // copy stored again with a new stamp, one, never a second Server-Timing
    // entry. A fragment carries no tag and is fetched whole.
    const asked = refetches.list.filter(
      (r) => !r.held && r.outcome === 'answered' && dueIds.includes(r.id),
    );
    for (const { id, conditional } of asked) {
      expect(conditional, id).toBe(!id.endsWith('|hx'));
    }
    for (const copy of await storedPages(page)) {
      expect(copy.stamps, copy.id).toBe(1);
    }

    // Offline again, the tab root opens at once from B's own copy.
    await setNetwork('offline');
    const renewed = await context.newPage();
    await renewed.goto(`${next.origin}/wardrobe`);
    await expect(renewed.locator('.dock')).toBeVisible();
    expect(
      Number(
        await renewed.locator('#freshness').getAttribute('data-fetched-at'),
      ),
    ).toBeGreaterThan(activatedAt);
    await renewed.close();

    // The cut network's own failed loads are the test's doing.
    expect(
      errors.filter((line) => !line.includes('net::ERR_INTERNET_DISCONNECTED')),
    ).toEqual([]);
  });
});

function updateToast(page: Page) {
  return page.locator('#toast-host .alert', {
    hasText: 'Update available',
  });
}

/**
 * Loads a document of the app and waits until pwa.js has registered (it
 * listens for updates from then on, so a check before would go unseen) and
 * the service worker controls the page.
 */
async function openControlled(
  page: Page,
  load: () => Promise<unknown>,
): Promise<void> {
  const registered = page.waitForEvent('console', (message) =>
    message.text().includes('[pwa] service worker registered'),
  );
  await load();
  await registered;
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

/**
 * Marks the document: a boosted navigation keeps the mark (only the body is
 * swapped), a reload loses it.
 */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.testDocument = 'before-update';
  });
}

function isMarkedDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.dataset.testDocument === 'before-update',
  );
}

async function checkForUpdate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('no service worker registration');
    await registration.update();
  });
}

function hasWaitingWorker(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!registration?.waiting;
  });
}

/**
 * The build whose worker controls the page (NextBuild.deploy's id), or null
 * for the server's own build, which has no answer to TEST_BUILD.
 */
function controllingBuild(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) {
          resolve(null);
          return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => resolve(String(event.data));
        controller.postMessage({ type: 'TEST_BUILD' }, [channel.port2]);
        setTimeout(() => resolve(null), 1000);
      }),
  );
}

/** What pwa.js posts on a signed-in load: the refresh, then the warm. */
async function askToWarm(page: Page): Promise<void> {
  await page.evaluate(() => {
    navigator.serviceWorker.controller?.postMessage({ type: 'WARM_PAGES' });
  });
}

/**
 * A page cache key as the worker's refetch asks for it: the page's URL,
 * `|hx` for a fragment (pageCacheKey), however Cache Storage encodes it.
 */
function keyId(url: string, fragment: boolean): string {
  return `${url.replace(/(?:\||%7C)hx$/i, '')}${fragment ? '|hx' : ''}`;
}

interface StoredPage {
  id: string;
  cachedAt: number;
  /** Its Server-Timing's arrival stamps: one, however often re-stamped. */
  stamps: number;
}

/** pages-v2's pages and fragments in the cache's own order, with their stamps. */
async function storedPages(page: Page): Promise<StoredPage[]> {
  const stored = await page.evaluate(async () => {
    const cache = await caches.open('pages-v2');
    const copies: { url: string; cachedAt: number; stamps: number }[] = [];
    for (const key of await cache.keys()) {
      if (new URL(key.url).origin !== location.origin) continue;
      const copy = await cache.match(key);
      copies.push({
        url: key.url,
        cachedAt: Number(copy?.headers.get('X-SW-Cached-At') ?? 0),
        stamps: (copy?.headers.get('Server-Timing') ?? '')
          .split(',')
          .filter((entry) => entry.trim().startsWith('cache;')).length,
      });
    }
    return copies;
  });
  return stored.map(({ url, cachedAt, stamps }) => ({
    id: keyId(url, /(?:\||%7C)hx$/i.test(url)),
    cachedAt,
    stamps,
  }));
}

/** When the controlling worker activated (its activated-at record). */
function activationTime(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const cache = await caches.open('pages-v2');
    const record = await cache.match('https://page-cache.invalid/activated-at');
    return Number(await record?.text());
  });
}

interface Refetch {
  id: string;
  outcome: 'answered' | 'cut';
  /** Sent with If-None-Match: the stored copy's ETag (#708). */
  conditional: boolean;
  /** Asked while `hold` cut every one. */
  held: boolean;
}

/**
 * Every request the worker marks as its own (X-Closet-Warm: the refresh,
 * the warm), in order, cut while `hold` is on or when it is `cut`'s key.
 * Registered after networkSwitch, so it runs first and leaves the rest to
 * that route.
 */
async function recordRefetches(context: BrowserContext) {
  const recorder = {
    list: [] as Refetch[],
    hold: true,
    cut: undefined as string | undefined,
    /** The due keys asked with `outcome` once the hold was let go. */
    since(ids: string[], outcome: Refetch['outcome']): string[] {
      return recorder.list
        .filter((r) => !r.held && r.outcome === outcome && ids.includes(r.id))
        .map((r) => r.id);
    },
  };
  await context.route('**/*', async (route) => {
    const headers = route.request().headers();
    if (headers['x-closet-warm'] === undefined) {
      await route.fallback();
      return;
    }
    const id = keyId(route.request().url(), headers['hx-request'] === 'true');
    const held = recorder.hold;
    const conditional = headers['if-none-match'] !== undefined;
    if (held || id === recorder.cut) {
      recorder.list.push({ id, outcome: 'cut', held, conditional });
      await route.abort('internetdisconnected');
      return;
    }
    recorder.list.push({ id, outcome: 'answered', held, conditional });
    await route.fallback();
  });
  return recorder;
}
