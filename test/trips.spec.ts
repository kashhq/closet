import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { addDays } from '../src/calendar-date';
import { createGarment } from './support/e2e-data';
import {
  APP_ORIGIN,
  SAME_ORIGIN,
  signIn,
  submitLogin,
} from './support/e2e-session';
import {
  cachedPaths,
  closeSwitchedContext,
  dropSessionCaches,
  holdWarmList,
  networkSwitch,
  waitForServiceWorker,
  warmOnce,
  withoutWarming,
} from './support/service-worker';
import { householdToday } from './support/household-today';
import {
  expectNoZoomingFields,
  expectTouchTargets,
} from './support/touch-targets';

/**
 * Trips (#10) at phone width, what only a browser shows: the trip form, the
 * destination picked on the form and its forecast loaded into the page, the
 * week's Away row (#684), an outfit added for a day, the packing list's and the
 * extras' checkboxes saved on change (htmx, the summary swapped out of
 * band), "Wore it" and its Undo, nothing wider than the phone. With a
 * touch screen, the phone's sizing (#636) on the pages it passes: no field
 * under 16 px (login, the trip and garment forms, Profile) and no control
 * under 44 px (Today, the week, the trip, Profile). In the Safari projects
 * (nightly) the field check is WebKit's.
 * test/integration/trips.spec.ts has the behavior.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

/** A tee (×3), jeans and sneakers, and an outfit of the three. */
async function closet(page: Page): Promise<{ outfit: number }> {
  const tee = await createGarment(page, 'Travel tee', 'tops', {
    care: '1',
    quantity: '3',
    color: 'grey',
  });
  const jeans = await createGarment(page, 'Travel jeans', 'bottoms', {
    color: 'blue',
  });
  const shoes = await createGarment(page, 'Travel sneakers', 'footwear', {
    color: 'white',
  });
  // One row per garment, as the builder posts them.
  const res = await page.request.post('/outfits', {
    headers: {
      ...SAME_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    data: new URLSearchParams([
      ['name', 'Travel day'],
      ['category', 'tops'],
      ['garmentId', String(tee)],
      ['category', 'bottoms'],
      ['garmentId', String(jeans)],
      ['category', 'footwear'],
      ['garmentId', String(shoes)],
    ]).toString(),
  });
  expect(res.ok()).toBe(true);
  return { outfit: Number(new URL(res.url()).pathname.split('/').pop()) };
}

/** No element wider than the phone: the page never scrolls sideways. */
async function expectPhoneWidth(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
}

test.describe('Trips', () => {
  test('a trip from the form to a packed bag', async ({
    page,
    browser,
    browserName,
  }) => {
    await page.goto('/auth/login');
    await expectNoZoomingFields(page);
    const email = await signIn(page, 'trips');
    const { outfit } = await closet(page);
    const today = householdToday();

    // The Calendar's Trips tab, then the form.
    await page.goto('/calendar');
    await page.getByRole('link', { name: 'Trips' }).click();
    await expect(page).toHaveURL(/\/trips$/);
    await page.getByRole('link', { name: 'New trip' }).first().click();
    await expectNoZoomingFields(page);
    await page.getByLabel('Name').fill('Austin conference');
    // Picked on the form (#684): Find, then the place.
    await page.getByLabel('Destination').fill('Austin');
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page
      .getByRole('button', { name: 'Austin, Texas, United States' })
      .click();
    await expect(page.getByLabel('Destination')).toHaveValue(
      'Austin, Texas, United States',
    );
    await expect(page.getByLabel('Destination')).toHaveAttribute(
      'readonly',
      '',
    );
    await page.getByLabel('First day').fill(today);
    await page.getByLabel('Last day').fill(addDays(today, 2));
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/\/trips\/\d+$/);
    await expect(page.getByText('Trip created')).toBeVisible();
    await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
      'href',
      '/calendar',
    );
    const tripUrl = page.url();

    // Located with the trip (#684): its forecast comes into the page on
    // first view, no Find needed.
    await expect(page.locator('[data-trip-weather="forecast"]')).toBeVisible();
    await expect(page.locator('[data-weather-day]')).toHaveCount(3);
    await expect(
      page.getByRole('button', { name: 'Change', exact: true }),
    ).toBeVisible();

    // A saved outfit for today, from the add page.
    await page
      .locator(`[data-trip-day="${today}"]`)
      .locator('[data-add-outfit]')
      .click();
    await page.getByRole('button', { name: /Travel day/ }).click();
    await expect(
      page.locator(`[data-trip-day="${today}"] [data-trip-outfit]`),
    ).toHaveCount(1);
    await expectPhoneWidth(page);
    await expectTouchTargets(page);

    // The packing list: a checkbox saved on change, the summary out of band.
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '0 of 3 packed',
    );
    await page.getByRole('checkbox', { name: /Travel tee/ }).check();
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '1 of 3 packed',
    );
    await page.getByRole('checkbox', { name: /Travel jeans/ }).check();
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '2 of 3 packed',
    );

    // Extras: added, then packed on change.
    await page.getByLabel('Charger, toiletries, passport…').fill('Charger');
    await page.getByRole('button', { name: 'Add', exact: true }).last().click();
    await page.getByRole('checkbox', { name: 'Charger' }).check();
    await expect(page.locator('#trip-items-summary')).toContainText(
      '1 of 1 packed',
    );

    // What the server kept.
    await page.reload();
    await expect(
      page.getByRole('checkbox', { name: /Travel tee/ }),
    ).toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: /Travel sneakers/ }),
    ).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Charger' })).toBeChecked();

    // "Wore it", through the calendar, and its Undo back to the trip.
    await page.getByRole('button', { name: 'Wore it' }).click();
    await expect(page.getByText('✓ Worn', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Wore it' })).toBeVisible();
    await page.goto(`/calendar?week=${today}`);
    // The calendar's chip opens the outfit in Styling (#42).
    await expect(
      page.locator(`a[href^="/styling?outfit=${outfit}&"]`),
    ).toHaveCount(1);
    // The trip's days in the week say Away, under the date, linking to it.
    const away = page
      .locator(`section[data-day="${today}"]`)
      .getByRole('link', { name: 'Away: Austin' });
    await expect(away).toBeVisible();
    await expect(away).toHaveAttribute('href', new URL(tripUrl).pathname);
    await expectPhoneWidth(page);
    await expectTouchTargets(page);

    // The rest of the phone's sizing: Today (the trip's outfit on it), the
    // garment form, Profile.
    await page.goto('/');
    await expectTouchTargets(page);
    await page.goto('/wardrobe/new');
    await expectNoZoomingFields(page);
    await page.goto('/auth/profile');
    await expectNoZoomingFields(page);
    await expectTouchTargets(page);
    // The app bar's menus close on Escape, focus back on the summary (#730).
    await page.goto(`/outfits/${outfit}`);
    const menu = page.locator('#outfit-menu');
    await menu.locator('summary').click();
    await expect(menu).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveAttribute('open');
    await expect(menu.locator('summary')).toBeFocused();

    // Focus never lands under the fixed dock (#730): the page's last control,
    // focused from the keyboard, is scrolled clear of it.
    await page.goto(new URL(tripUrl).pathname);
    await page.locator('main').locator('a, button, input').last().focus();
    const clearance = await page.evaluate(() => {
      const focused = document.activeElement?.getBoundingClientRect();
      const dock = document.querySelector('.dock')?.getBoundingClientRect();
      return focused && dock ? dock.top - focused.bottom : null;
    });
    expect(clearance).toBeGreaterThanOrEqual(0);

    // 200% text (#730): nothing wider than the phone, the dock's labels
    // give way to their icons (still named).
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expectPhoneWidth(page);
    // A long title wraps to its two clamped lines inside the bar, and the
    // page's first content still starts below it (#1028).
    const bar = await page.evaluate(() => {
      const header = document.querySelector('.app-bar');
      const h1 = header?.querySelector('h1');
      if (!header || !h1) return null;
      window.scrollTo(0, 0);
      h1.textContent = 'A very long title '.repeat(8);
      const first = document.querySelector('main')?.firstElementChild;
      return {
        barBottom: header.getBoundingClientRect().bottom,
        titleBottom: h1.getBoundingClientRect().bottom,
        contentTop: first?.getBoundingClientRect().top ?? null,
      };
    });
    expect(bar?.titleBottom).toBeLessThanOrEqual(bar?.barBottom ?? 0);
    expect(bar?.contentTop).toBeGreaterThanOrEqual(bar?.barBottom ?? Infinity);
    await expect(page.locator('.dock-label').first()).toHaveCSS('width', '1px');
    await expect(page.getByRole('link', { name: 'Wardrobe' })).toBeVisible();

    // The error page (#644): inside the phone's width, its actions tappable.
    const missing = await page.goto('/wardrobe/999999');
    expect(missing?.status()).toBe(404);
    await expect(page.getByRole('link', { name: 'Back' })).toBeVisible();
    await expectPhoneWidth(page);
    await expectTouchTargets(page);

    // A second device, signed in and warmed, never opening the trip: its
    // page opens offline and a tick queues (#657).
    await test.step('the warm names the trip, so it packs offline without a visit', async (step) => {
      step.skip(
        process.env.PWA_ENABLED !== 'true',
        'needs a server started with PWA_ENABLED=true',
      );
      step.skip(
        browserName !== 'chromium',
        'the worker is watched in Chromium',
      );
      const context = await browser.newContext({
        baseURL: APP_ORIGIN,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        serviceWorkers: 'allow',
      });
      try {
        await withoutWarming(context);
        const network = await networkSwitch(context);
        const device = await context.newPage();
        await device.goto('/auth/login');
        await submitLogin(device, email);
        await device.waitForURL((url) => url.pathname === '/');
        await waitForServiceWorker(device);
        // The warm list is held until a drop has overtaken it: the first
        // signed-in page claiming the cache from the sign-in page's empty
        // owner is one in practice (#812); SESSION_ENDING makes it at a
        // moment the spec chooses.
        const list = await holdWarmList(device);
        await warmOnce(device);
        await expect
          .poll(list.asked, { message: 'warm hold lost (worker restarted?)' })
          .toBe(true);
        await dropSessionCaches(device);
        await list.release();
        // The warm that the drop overtook runs again and stores the trip.
        const tripPath = new URL(tripUrl).pathname;
        await expect.poll(() => cachedPaths(device)).toContain(tripPath);

        await network('offline');
        await device.evaluate(() => window.dispatchEvent(new Event('offline')));
        await device.goto(tripPath);
        await expect(device.locator('#connectivity-banner')).toBeVisible();
        await device.getByRole('checkbox', { name: /Travel sneakers/ }).check();
        await expect(device.locator('#outbox-banner')).toHaveText(
          '1 change waiting to sync',
        );
        // The notice says what still works here (#658): ticks queue, and
        // nothing says packing needs a connection.
        const note = device.locator('[data-offline-note]');
        await expect(note).toContainText('Ticks are saved on this phone');
        await expect(note).not.toContainText('Packing');
        // Two queued ticks: the counter follows them, and no status line
        // still says "Saved".
        await device.getByRole('checkbox', { name: /Travel tee/ }).uncheck();
        await expect(device.locator('#trip-packed-summary')).toContainText(
          '2 of 3 packed',
        );
        await expect(
          device.locator(
            'section[aria-labelledby="trip-packing-heading"] [data-autosave-status]',
          ),
        ).not.toContainText('Saved');
      } finally {
        await closeSwitchedContext(context);
      }
    });
  });
});
