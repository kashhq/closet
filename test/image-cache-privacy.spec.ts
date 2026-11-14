import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import sharp from 'sharp';
import { addPhotographedGarment, createOutfit } from './support/e2e-data';
import {
  registerElsewhere,
  signIn,
  switchAccount,
} from './support/e2e-session';
import { householdToday } from './support/household-today';
import {
  cachedImages,
  cachedPaths,
  cachePage,
  expirationUrls,
  networkSwitch,
  waitForServiceWorker,
  withoutWarming,
} from './support/service-worker';
import { WEBKIT_CANNOT_WATCH_WORKER } from './support/webkit-limits';

/**
 * The service worker's image cache is the session's, like its page cache
 * (#226, views/assets/src-sw.ts SESSION_CACHES): signing out and in as
 * another account drops it, offline included, and outfit selfies are never
 * in any of the worker's caches, even opened as a document. The worker's
 * session logic has its unit coverage in views/assets; this is the one
 * browser proof that no photo outlives its session.
 *
 * Needs a server started with PWA_ENABLED=true. Offline goes through
 * networkSwitch: setOffline alone does not cut the worker's own fetches,
 * and routing them is Chromium's alone, so the Safari projects skip it.
 */
test.describe('the image cache belongs to one session', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );
  // What this spec caches is its own visits' alone (withoutWarming); the
  // warm's own photos are stale-pages.spec.ts (retired 2026-10-13)'s.
  test.beforeEach(async ({ context }) => {
    await withoutWarming(context);
  });

  /**
   * The photo's thumb, cutout and original, from its tile on the wardrobe
   * page open in `page`: the signed URLs the page itself requests (#162).
   * A photo's three URLs differ only in their path (imageUrl signs the set,
   * not the variant), so the path swap gives the exact URLs the garment page
   * and the mask editor load, which is what the worker caches by.
   */
  async function photoUrls(page: Page): Promise<string[]> {
    const thumb = await page
      .locator('#wardrobe-grid > a img')
      .getAttribute('src');
    expect(thumb).toMatch(
      /^\/file\/thumb\/[0-9a-f-]+\.webp\?v=\d+(&k=[0-9a-f]{12})?&s=[A-Za-z0-9_-]{16}$/,
    );
    return [
      thumb!,
      thumb!.replace('/file/thumb/', '/file/nobg/'),
      thumb!.replace('/file/thumb/', '/file/'),
    ];
  }

  /** Loads each URL as an <img>; whether each one showed. */
  function loadImages(page: Page, urls: string[]): Promise<boolean[]> {
    return page.evaluate(
      (targets) =>
        Promise.all(
          targets.map(
            (src) =>
              new Promise<boolean>((resolve) => {
                const img = new Image();
                img.onload = () => resolve(img.naturalWidth > 0);
                img.onerror = () => resolve(false);
                img.src = src;
              }),
          ),
        ),
      urls,
    );
  }

  /** The URLs any Cache Storage cache of this origin holds a copy of. */
  function cachedAnywhere(page: Page, urls: string[]): Promise<string[]> {
    return page.evaluate(async (targets) => {
      const found: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const url of targets) {
          if (await cache.match(url, { ignoreSearch: true })) {
            found.push(`${name} ${url}`);
          }
        }
      }
      return found;
    }, urls);
  }

  /** Loads the photos through the worker until the image cache holds them. */
  async function cacheImages(page: Page, urls: string[]): Promise<void> {
    expect(await loadImages(page, urls)).toEqual(urls.map(() => true));
    await expect
      .poll(() => cachedImages(page))
      .toEqual(expect.arrayContaining(urls));
  }

  /** Takes a selfie from Today's planned card; the thumb's URL. */
  async function takeSelfie(page: Page, garmentId: number): Promise<string> {
    await createOutfit(page, 'Dinner', garmentId, householdToday());
    await page.goto('/');
    const card = page.locator('[data-today-row="planned"] article');
    await card.getByLabel('Choose a photo').setInputFiles({
      name: 'mirror.jpg',
      mimeType: 'image/jpeg',
      buffer: await sharp({
        create: { width: 600, height: 800, channels: 3, background: '#a58d74' },
      })
        .jpeg()
        .toBuffer(),
    });
    const thumb = card.locator('img[src^="/selfies/thumb/"]');
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    return (await thumb.getAttribute('src'))!;
  }

  test('after signing out and in as another account, none of the first one’s photos is served, offline included', async ({
    page,
    context,
    playwright,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    await signIn(page, 'img-first');
    const garmentId = await addPhotographedGarment(page, 'Private coat');
    await waitForServiceWorker(page);
    const network = await networkSwitch(context);
    await cachePage(page, '/wardrobe');
    const photos = await photoUrls(page);
    await cacheImages(page, photos);
    // Workbox's expiration keeps a row per stored URL (its own IndexedDB):
    // the first account's photos and its garment's page are there now.
    await cachePage(page, `/wardrobe/${garmentId}`);
    const firstRows = [
      ...photos.map((url) => `images-v2 ${url}`),
      `pages-v2 /wardrobe/${garmentId}`,
    ];
    await expect
      .poll(() => expirationUrls(page))
      .toEqual(expect.arrayContaining(firstRows));

    // A selfie is its owner's alone: the worker keeps none, neither its
    // <img> loads nor the photo opened as a document, which is no page and
    // must not claim the page cache for nobody (dropping the account's
    // pages) either.
    const selfieThumb = await takeSelfie(page, garmentId);
    const selfie = selfieThumb.replace('/selfies/thumb/', '/selfies/');
    const opened = await page.goto(selfie);
    expect(opened?.headers()['content-type']).toBe('image/webp');
    await cachePage(page, '/about');
    expect(await cachedPaths(page)).toContain('/wardrobe');
    const selfies = [selfieThumb, selfie];
    expect(await cachedAnywhere(page, selfies)).toEqual([]);

    const second = await registerElsewhere(playwright, 'img-second');
    await test.step('SESSION_ENDING empties both caches before the sign-out reaches the server', async () => {
      // The page's sign-out post is held at the route, so the landing page
      // cannot have been asked for: what the caches hold then is what the
      // message alone dropped (pwa.js announceSessionBoundaries).
      // Read from a page of its own: the signing-out one is mid-navigation.
      const probe = await context.newPage();
      await probe.goto('/health/live');
      let held = false;
      let leftAtPost: Error | undefined;
      await context.route('**/auth/logout', async (route) => {
        if (route.request().method() === 'POST') {
          held = true;
          leftAtPost = await expect
            .poll(
              async () => ({
                // The drop re-warms the offline fallback page: A's own
                // visits are what must be gone.
                pages: (await cachedPaths(probe)).filter((path) =>
                  ['/wardrobe', '/about'].includes(path),
                ),
                images: await cachedImages(probe),
              }),
              { timeout: 3_000 },
            )
            .toEqual({ pages: [], images: [] })
            .then(
              () => undefined,
              (error: Error) => error,
            );
        }
        await route.fallback();
      });
      await switchAccount(page, second);
      await context.unroute('**/auth/logout');
      await probe.close();
      expect(held, 'the sign-out post reached the route').toBe(true);
      expect(leftAtPost).toBeUndefined();
    });
    await expect.poll(() => cachedAnywhere(page, photos)).toEqual([]);
    // The drop forgets those rows with the caches (#731): no URL of the
    // first account outlives its session on the device.
    // The worker deletes a cache's rows before the cache, so the poll above
    // passing means these are gone too.
    expect(
      (await expirationUrls(page)).filter((row) => firstRows.includes(row)),
    ).toEqual([]);

    await network('offline');
    const everything = [...photos, ...selfies];
    expect(await loadImages(page, everything)).toEqual(
      everything.map(() => false),
    );
    expect(await cachedAnywhere(page, everything)).toEqual([]);
  });
});
