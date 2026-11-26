import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bundlePageModule,
  closePage,
} from '../../test/support/page-module-browser';

/**
 * outbox.ts's page-day wiring on a page with no service worker and no
 * freshness stamp (PWA_ENABLED off, #990, #993), driven by the real htmx in
 * Chromium: the e2e server runs with the PWA on, where `#freshness` stamps
 * the day and this path never decides it. What a `<time data-day-label>` says
 * is worded against the day the body on screen arrived (BodyArrivals), so a
 * wrong arrival shows as "today" where it should say "2 days ago", and the
 * reverse. The clock is the page's own (Playwright's), moved two days at a
 * time; the server is `page.route`.
 */

const ORIGIN = 'https://closet.test';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The load's day, in the page's zone (UTC): the day `<time>` below words. */
const LOADED = new Date();
const LOADED_DAY = LOADED.toISOString().slice(0, 10);

/**
 * Every path answers this page: a signed-out one (no `data-account`, so the
 * outbox neither claims nor syncs), with the household's zone, one day label
 * and the three kinds of htmx request that move the arrival.
 */
const PAGE = `<!doctype html><html lang="en"><head><title>t</title>
<meta name="htmx-config" content='{"allowEval":false,"allowScriptTags":false,"disableInheritance":true,"historyCacheSize":3}'>
</head><body>
  <div id="app-status" data-time-zone="UTC"></div>
  <p id="path">__PATH__</p>
  <time id="label" data-day-label="relative" datetime="${LOADED_DAY}"></time>
  <a id="navigate" href="/b" hx-boost="true">Navigate</a>
  <a id="back-to-a" href="/a" hx-boost="true">A</a>
  <button id="filter" type="button" hx-get="/b?filter=1" hx-target="#results"
    hx-push-url="true">Filter</button>
  <button id="swap" type="button" hx-get="/fragment" hx-target="#results">Swap</button>
  <div id="results"></div>
</body></html>`;

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await bundlePageModule("import './views/assets/outbox.ts';", {
    toast: 'public/js/toast.js',
    'single-flight': 'views/assets/page/single-flight.ts',
  });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

/** The page at /a on its load day, htmx and the outbox loaded as the layout does. */
async function mounted(options: { historyCacheSize?: number } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install({ time: LOADED });
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname, search } = new URL(route.request().url());
    if (pathname === '/fragment' || search) {
      return route.fulfill({ contentType: 'text/html', body: 'fragment' });
    }
    const config = options.historyCacheSize ?? 3;
    return route.fulfill({
      contentType: 'text/html',
      body: PAGE.replace(
        '"historyCacheSize":3',
        `"historyCacheSize":${config}`,
      ).replace('__PATH__', pathname),
    });
  });
  await page.goto(`${ORIGIN}/a`);
  await page.addScriptTag({ path: 'node_modules/htmx.org/dist/htmx.min.js' });
  await page.addScriptTag({ content: bundle });
  await expectShown(page, '/a||today');
  return page;
}

/**
 * What the page shows, as `path|results|label`: waited for as a whole, since
 * the URL changes before htmx swaps the body in, and the body on its way out
 * words its label as well.
 */
function expectShown(page: Page, shown: string) {
  return expect
    .poll(
      () =>
        page.evaluate(() =>
          ['path', 'results', 'label']
            .map((id) => document.getElementById(id)?.textContent)
            .join('|'),
        ),
      { timeout: 5000 },
    )
    .toBe(shown);
}

/** Two days later by the page's clock (timers keep running). */
async function twoDaysLater(page: Page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(now + 2 * DAY_MS);
}

describe('outbox page-day wiring without a service worker', () => {
  it('a boosted navigation brings a body that arrived now', async () => {
    const page = await mounted();
    await twoDaysLater(page);
    await page.click('#navigate');
    await expectShown(page, '/b||2 days ago');
    await closePage(page);
  });

  it('a fragment swap leaves the body where it arrived', async () => {
    const page = await mounted();
    await twoDaysLater(page);
    await page.click('#swap');
    await expectShown(page, '/a|fragment|today');
    await closePage(page);
  });

  it('a snapshot back on screen keeps its first arrival; a pushed URL is of the body it was pushed on', async () => {
    const page = await mounted();
    await twoDaysLater(page);
    await page.click('#navigate');
    await expectShown(page, '/b||2 days ago');
    await page.click('#filter');
    await expectShown(page, '/b|fragment|2 days ago');
    await page.goBack();
    await page.goBack();
    await expectShown(page, '/a||today');
    // Straight to the pushed URL: no restore of /b sets the arrival on the way.
    await page.evaluate(() => history.go(2));
    await expectShown(page, '/b|fragment|2 days ago');
    await closePage(page);
  });

  it('a path htmx no longer holds is fetched again and arrives now', async () => {
    const page = await mounted({ historyCacheSize: 0 });
    await twoDaysLater(page);
    await page.click('#navigate');
    await expectShown(page, '/b||2 days ago');
    await page.goBack();
    await expectShown(page, '/a||2 days ago');
    await closePage(page);
  });
});
