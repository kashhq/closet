import { type Page, type Route } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { CACHED_AT_TIMING_NAME, PAGES_CACHE } from '../src/web/page-cache';
import { APP_ORIGIN, signIn } from './support/e2e-session';
import {
  cachedPaths,
  cachePage,
  waitForServiceWorker,
  withoutWarming,
} from './support/service-worker';
import { WEBKIT_CANNOT_NAVIGATE_OFFLINE } from './support/webkit-limits';

/** Long past a claim's few milliseconds, well inside the test's timeout. */
const CLAIM_BOUND_MS = 10_000;

/** A build id no worker has: a page rendered by another deploy. */
const OTHER_BUILD = 'another-build';

/**
 * What only a browser can show about the installed app: online, the worker
 * answers a navigation from its preload; offline, a visited page comes from
 * its page cache with the connectivity banner and an unvisited one is the
 * offline page. The worker's caching rules themselves (src/web/shell/) are
 * served by the integration tier's shell specs.
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys). The Safari
 * projects (nightly) cannot navigate offline and skip it.
 */
test.describe('installed app delivery', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );

  // Login is always required: without a session every page below would be
  // the login page (which also loads bundle.css, so the first test passed
  // on the wrong page).
  // What the offline specs find cached is their own visits' alone.
  test.beforeEach(async ({ page, context }) => {
    await withoutWarming(context);
    await signIn(page, 'pwa-test');
  });

  test('navigations use the preload online and the cache or offline page offline', async ({
    page,
    context,
    browser,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
    await waitForServiceWorker(page);
    // Enabled in the worker's activate event (views/assets/src-sw.ts).
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await navigator.serviceWorker.ready).navigationPreload.getState(),
        ),
      )
      .toMatchObject({ enabled: true });

    // The worker stores a page after answering it: wait for the one the
    // fallback page must link.
    await cachePage(page, '/wardrobe');
    const online = await page.goto('/outfits');
    expect(online?.fromServiceWorker()).toBe(true);
    expect(online?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Outfits' }),
    ).toBeVisible();

    // The server up but its database not (#643): its 503 busy page is taken
    // like a timeout, and the cached copy answers with its freshness stamp
    // (the Server-Timing entry only a stored copy carries). Insights, not a
    // tab root: those open from the cache whatever the server says.
    await cachePage(page, '/wardrobe/insights');
    // context.route sees the worker's own fetch, never the navigation
    // preload; ServerFirstPages judges either answer the same way.
    const setPreload = (enabled: boolean) =>
      page.evaluate(async (on) => {
        const { navigationPreload } = await navigator.serviceWorker.ready;
        await (on ? navigationPreload.enable() : navigationPreload.disable());
      }, enabled);
    await setPreload(false);
    await context.route(/\/wardrobe\/insights$/, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'text/html',
        headers: { 'Retry-After': '5' },
        body: '<!DOCTYPE html><title>busy</title><h1>Busy</h1>',
      }),
    );
    const busy = await page.goto('/wardrobe/insights');
    expect(busy?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Insights' }),
    ).toBeVisible();
    const stamp = await page.evaluate(
      (name) =>
        (
          performance.getEntriesByType(
            'navigation',
          )[0] as PerformanceNavigationTiming
        ).serverTiming.some((entry) => entry.name === name),
      CACHED_AT_TIMING_NAME,
    );
    expect(stamp).toBe(true);
    await context.unroute(/\/wardrobe\/insights$/);
    await setPreload(true);

    await expect(page.locator('#connectivity-banner')).toBeHidden();
    await context.setOffline(true);
    // Visited above, so the page cache has it: served from there while the
    // preload fails behind it, and the app says it is offline.
    await page.goto('/outfits');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Outfits' }),
    ).toBeVisible();
    await expect(page.locator('.dock')).toBeVisible();
    await expect(page.locator('#connectivity-banner')).toBeVisible();
    // Never visited: the offline page.
    await page.goto('/calendar');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Offline' }),
    ).toBeVisible();
    // It says so, links the tab roots, and shows no "saved data" banner (#658).
    await expect(page.getByText("This page wasn't saved")).toBeVisible();
    // Only the tab roots this device saved (Wardrobe and Outfits, visited
    // above) are linked; the others would loop back here.
    const saved = page.locator('main').getByRole('link');
    await expect(saved).toHaveText(['Wardrobe', 'Outfits']);
    await expect(page.locator('#connectivity-banner')).toBeHidden();
    await context.setOffline(false);

    // A quota error purges the pages cache whole, the offline page with it
    // (purgeOnQuotaError). The next page stored online warms it again
    // (ensureOfflinePage, #731), so an unvisited page offline is still the
    // offline page, not the browser's error.
    await page.evaluate((name) => caches.delete(name), PAGES_CACHE);
    await cachePage(page, '/outfits');
    await expect.poll(() => cachedPaths(page)).toContain('/offline.html');
    await context.setOffline(true);
    await page.goto('/calendar');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Offline' }),
    ).toBeVisible();
    await context.setOffline(false);

    // A page whose navigation started while the first worker installed is a
    // reserved client when the activation claims (clientsClaim), so it
    // commits uncontrolled: no controllerchange, no warm, every boosted tap
    // past the worker until a reload (#1140; on a loaded box the trips
    // scenario's second device hung in waitForServiceWorker this way). It
    // asks for a claim naming its build (CLAIM_CLIENTS), which the worker
    // grants only to its own: a hard reload after a deploy holds the next
    // build's assets. Two tabs held from before the registration until the
    // first tab's worker has claimed construct the race; the second is
    // rendered as another build.
    await test.step("a page left out of the first worker's claim is claimed, of its own build only", async () => {
      const device = await browser.newContext({
        baseURL: APP_ORIGIN,
        serviceWorkers: 'allow',
      });
      try {
        const hold = async (
          held: Page,
          answer: (route: Route) => Promise<void>,
        ) => {
          let asked = () => {};
          const requested = new Promise<void>((resolve) => (asked = resolve));
          let release = () => {};
          const released = new Promise<void>((resolve) => (release = resolve));
          await held.route('**/auth/login', async (route) => {
            asked();
            await released;
            await answer(route);
          });
          // Wrapped: an async function's returned promise would be awaited
          // here, before the navigation it waits for has started.
          return { requested, release };
        };
        const late = await device.newPage();
        const lateHold = await hold(late, (route) => route.fallback());
        const other = await device.newPage();
        const otherHold = await hold(other, async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            /data-asset-version="[^"]*"/,
            `data-asset-version="${OTHER_BUILD}"`,
          );
          expect(body).toContain(`data-asset-version="${OTHER_BUILD}"`);
          await route.fulfill({ response, body });
        });
        // Started before any registration: never the worker's navigations.
        const lateLoad = late.goto('/auth/login');
        const otherLoad = other.goto('/auth/login');
        await Promise.all([lateHold.requested, otherHold.requested]);

        const first = await device.newPage();
        await first.goto('/auth/login');
        await first.evaluate(() => navigator.serviceWorker.ready);
        // Running when the activation claimed: taken at once.
        await first.waitForFunction(() => !!navigator.serviceWorker.controller);

        lateHold.release();
        await lateLoad;
        let bound: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          late
            .waitForFunction(() => !!navigator.serviceWorker.controller)
            .then(() => 'controlled'),
          new Promise<string>((stuck) => {
            bound = setTimeout(() => stuck('never controlled'), CLAIM_BOUND_MS);
          }),
        ]).finally(() => clearTimeout(bound));
        expect(outcome).toBe('controlled');

        // Another build's page asks too, and is refused: the next build's
        // update flow, never this worker, takes it.
        const refused = device.waitForEvent('console', (message) =>
          message
            .text()
            .startsWith(
              `[sw] CLAIM_CLIENTS from build ${OTHER_BUILD}: nothing claimed`,
            ),
        );
        otherHold.release();
        await otherLoad;
        await refused;
        expect(
          await other.evaluate(() => navigator.serviceWorker.controller),
        ).toBeNull();
      } finally {
        await device.close();
      }
    });
  });
});
