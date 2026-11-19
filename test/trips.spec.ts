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
import { WEBKIT_CANNOT_WATCH_WORKER } from './support/webkit-limits';
import {
  expectNoZoomingFields,
  expectTouchTargets,
} from './support/touch-targets';

/**
 * Trips (#10) at phone width, what only a browser shows: the trip form, the
 * destination picked on the form and its forecast loaded into the page, the
 * week's Away row (#684), an outfit added for a day, the packing list's and the
 * extras' checkboxes saved on change (htmx, the summary swapped out of
 * band), at 1440 the packing list beside the days, in view and saving
 * (queued offline too), "Wore it" and its Undo, nothing wider than the phone. With a
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

/**
 * A section's tabs are the app bar's (#1061). At 390 they are the bar's
 * second row, under the title, and the page starts below them. At 1440
 * they sit inline after the title and hold still between sibling pages
 * (they jumped with each page's width before), and Profile is the rail's
 * foot, the bar's avatar hidden; at 1024 a long title truncates, never the
 * tabs. Leaves the phone on the page it found.
 */
async function expectSectionTabs(page: Page): Promise<void> {
  const start = page.url();
  const sections = [
    {
      label: 'Calendar views',
      paths: ['/calendar', '/calendar/month', '/trips'],
    },
    {
      label: 'Wardrobe sections',
      paths: ['/wardrobe', '/capsules', '/laundry', '/wardrobe/wishlist'],
    },
  ];
  const layout = async (path: string, label: string) => {
    await page.goto(path);
    const bar = page.locator('.app-bar');
    const tabs = bar.getByRole('navigation', { name: label });
    const [barBox, title, row, content] = await Promise.all([
      bar.boundingBox(),
      bar.locator('h1').boundingBox(),
      tabs.boundingBox(),
      page.evaluate(
        () =>
          document
            .querySelector('main')
            ?.firstElementChild?.getBoundingClientRect().top ?? null,
      ),
    ]);
    return { barBox: barBox!, title: title!, row: row!, content: content! };
  };

  const phone = await layout('/calendar', 'Calendar views');
  expect(phone.row.y).toBeGreaterThanOrEqual(
    phone.title.y + phone.title.height,
  );
  expect(phone.row.y + phone.row.height).toBeLessThanOrEqual(
    phone.barBox.y + phone.barBox.height + 1,
  );

  // A tab focused from the keyboard shows its whole outline inside the
  // row's scroller, which clips whatever it draws outside its box.
  await page.keyboard.press('Tab');
  const tabs = page.locator('.app-bar-tabs');
  await tabs.getByRole('link').last().focus();
  const ring = await page.evaluate(() => {
    const scroller = document.querySelector('.app-bar-tabs');
    const tab = scroller?.querySelector('a:focus-visible');
    if (!scroller || !tab) return null;
    const style = getComputedStyle(tab);
    const grow =
      Math.max(0, parseFloat(style.outlineWidth)) +
      parseFloat(style.outlineOffset);
    const box = tab.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return {
      top: box.top - grow - view.top,
      bottom: view.bottom - (box.bottom + grow),
    };
  });
  expect(ring?.top).toBeGreaterThanOrEqual(0);
  expect(ring?.bottom).toBeGreaterThanOrEqual(0);

  // 200% text with a long title and the freshness line showing (the bar's
  // tallest content): the tab row stays inside the bar and the first visible
  // content starts at or below its bottom.
  for (const path of ['/trips', '/wardrobe']) {
    await page.goto(path);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
      window.scrollTo(0, 0);
      const h1 = document.querySelector('.app-bar h1');
      if (h1) h1.textContent = 'A very long title '.repeat(8);
      const fresh = document.querySelector('#freshness');
      if (fresh) {
        fresh.textContent = 'Updated 3 minutes ago';
        fresh.classList.remove('hidden');
      }
    });
    const clearance = await page.evaluate(() => {
      const barBottom =
        document.querySelector('header.app-bar')?.getBoundingClientRect()
          .bottom ?? Infinity;
      const row = document
        .querySelector('.app-bar-tabs')
        ?.getBoundingClientRect();
      const content = Array.from(
        document.querySelectorAll<HTMLElement>('main *'),
      ).find((el) => {
        const box = el.getBoundingClientRect();
        return el.childElementCount === 0 && box.width > 0 && box.height > 0;
      });
      return {
        tabsInside: (row?.bottom ?? Infinity) - barBottom,
        content:
          (content?.getBoundingClientRect().top ?? -Infinity) - barBottom,
      };
    });
    expect(clearance.tabsInside).toBeLessThanOrEqual(1);
    expect(clearance.content).toBeGreaterThanOrEqual(0);
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const { label, paths } of sections) {
    // Where the row starts, never its width: the actions after it differ.
    let first: { x: number; y: number; height: number } | undefined;
    for (const path of paths) {
      const { barBox, title, row } = await layout(path, label);
      expect(row.x, path).toBeGreaterThanOrEqual(title.x + title.width);
      expect(row.y, path).toBeGreaterThanOrEqual(barBox.y);
      expect(row.y + row.height, path).toBeLessThanOrEqual(
        barBox.y + barBox.height,
      );
      const place = { x: row.x, y: row.y, height: row.height };
      first ??= place;
      expect(place, path).toEqual(first);
    }
  }
  await expect(page.locator('#avatar')).toBeHidden();
  await expect(
    page.locator('.dock').getByRole('link', { name: 'Profile' }),
  ).toBeVisible();

  // At 1024 a 60-character title (a shared wardrobe's owner) gives way to
  // the tabs: every tab whole inside the row's box, the row unscrolled, and
  // the title cut to one line (#1110). The Wardrobe's is the switcher's.
  await page.setViewportSize({ width: 1024, height: 768 });
  for (const { label, paths } of sections) {
    await page.goto(paths[0]);
    const fit = await page.evaluate((name) => {
      const h1 = document.querySelector('.app-bar h1');
      if (h1) h1.textContent = 'W'.repeat(30) + ' ' + 'x'.repeat(29);
      const row = document.querySelector(`.app-bar nav[aria-label="${name}"]`);
      if (!row || !h1) return null;
      const box = row.getBoundingClientRect();
      const cut = Array.from(row.querySelectorAll('a')).filter((tab) => {
        const rect = tab.getBoundingClientRect();
        return rect.left < box.left - 0.5 || rect.right > box.right + 0.5;
      });
      const bar = row.closest('header')!.getBoundingClientRect();
      return {
        clipped: cut.length,
        scrolls: row.scrollWidth > row.clientWidth,
        inBar: box.left >= bar.left && box.right <= bar.right,
        titleLines: Math.round(
          h1.getBoundingClientRect().height /
            parseFloat(getComputedStyle(h1).lineHeight),
        ),
        titleCut:
          h1.scrollWidth > h1.clientWidth || h1.scrollHeight > h1.clientHeight,
      };
    }, label);
    expect(fit, paths[0]).toEqual({
      clipped: 0,
      scrolls: false,
      inBar: true,
      titleLines: 1,
      titleCut: true,
    });

    // At 200% text the title is cut to its floor first, then the tab row
    // scrolls inside the bar: the actions after it (the Wardrobe's ⋯ and
    // ＋; the Calendar's bar has none) stay whole on screen, never pushed
    // past the edge.
    if (label !== 'Wardrobe sections') continue;
    const large = await page.evaluate((name) => {
      document.documentElement.style.fontSize = '200%';
      const row = document.querySelector(`.app-bar nav[aria-label="${name}"]`);
      const h1 = document.querySelector('.app-bar h1');
      if (!row || !h1) return null;
      const box = row.getBoundingClientRect();
      const after: Element[] = [];
      for (let el = row.nextElementSibling; el; el = el.nextElementSibling) {
        if (el.getBoundingClientRect().width > 0) after.push(el);
      }
      const result = {
        scrolls: row.scrollWidth > row.clientWidth,
        trailing: after.length > 0,
        onScreen: after.every((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= box.right - 0.5 && rect.right <= innerWidth + 0.5;
        }),
        titleShown: h1.getBoundingClientRect().width > 0,
      };
      document.documentElement.style.fontSize = '';
      return result;
    }, label);
    expect(large, paths[0]).toEqual({
      scrolls: true,
      trailing: true,
      onScreen: true,
      titleShown: true,
    });
  }
  await page.setViewportSize(viewport);
  await page.goto(start);
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
    await expectSectionTabs(page);
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

    // At 1440 the packing list is the panel's aside (#1071): beside the
    // days, still in view at the page's end, and a tick there saves.
    await page.setViewportSize({ width: 1440, height: 600 });
    const aside = page.locator('#trip-aside');
    const days = page.locator(
      'section[aria-labelledby="trip-outfits-heading"]',
    );
    const asideBox = (await aside.boundingBox())!;
    const daysBox = (await days.boundingBox())!;
    expect(asideBox.x).toBeGreaterThanOrEqual(daysBox.x + daysBox.width);
    expect(asideBox.y).toBeLessThan(daysBox.y + daysBox.height);
    const scrolled = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return window.scrollY;
    });
    expect(scrolled).toBeGreaterThan(0);
    await expect(page.locator('#trip-packing-heading')).toBeInViewport();
    const sneakers = aside.getByRole('checkbox', { name: /Travel sneakers/ });
    await sneakers.check();
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '3 of 3 packed',
    );
    await sneakers.uncheck();
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '2 of 3 packed',
    );
    await page.setViewportSize({ width: 390, height: 844 });

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
    // Profile is an index (#728): two screens at most, and Sign out is the
    // first form on it, so it is reached without passing a setting's.
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBeLessThanOrEqual(2 * 844);
    await expect(page.locator('main form').first()).toHaveAttribute(
      'id',
      'logout-form',
    );
    await expect(
      page.getByRole('button', { name: 'Sign out', exact: true }),
    ).toBeVisible();
    // A setting's page (D14, #1072): the nav of Profile's own rows is hidden
    // on a phone, and from lg sits beside the page with its row current.
    const profileRows = await page
      .locator('li[id] .font-medium')
      .allInnerTexts();
    expect(profileRows.length).toBeGreaterThan(0);
    const settingsNav = page.getByRole('navigation', { name: 'Settings' });
    for (const [path, current] of [
      ['/auth/profile/sizes', 'Sizes'],
      ['/auth/devices', 'Devices'],
    ]) {
      await page.goto(path);
      await expect(settingsNav).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(settingsNav).toBeVisible();
      await expect(settingsNav.getByRole('link')).toHaveText(profileRows);
      await expect(settingsNav.locator('[aria-current="page"]')).toHaveText(
        current,
      );
      await page.setViewportSize({ width: 390, height: 844 });
    }
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
    // The labels give way only where they would overflow their links
    // (#1027): a 340 px phone hides them at 200% and shows them at 100%,
    // and just above the query's 17rem of content (a 288 px dock) the
    // widest one still fits.
    const dockLabels = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.dock > a'))
          // Profile's link is the rail's alone.
          .filter((link) => link.getClientRects().length > 0)
          .map((link) => {
            const label = link.querySelector('.dock-label');
            return {
              shown: (label?.getBoundingClientRect().width ?? 0) > 1,
              fits: (label?.scrollWidth ?? Infinity) <= link.clientWidth,
            };
          }),
      );
    await page.setViewportSize({ width: 340, height: 844 });
    expect((await dockLabels()).map((label) => label.shown)).toEqual(
      Array(5).fill(false),
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    for (const width of [340, 290]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await dockLabels(), `${width} px`).toEqual(
        Array(5).fill({ shown: true, fits: true }),
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });

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
      // networkSwitch routes the worker's own fetches (the warm is one).
      step.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
      step.skip(
        browserName === 'firefox',
        'service workers are untested in Firefox here',
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
        // The aside beside the days at 1440 queues its ticks too (#1071).
        await device.setViewportSize({ width: 1440, height: 900 });
        await device
          .locator('#trip-aside')
          .getByRole('checkbox', { name: /Travel jeans/ })
          .uncheck();
        await expect(device.locator('#outbox-banner')).toHaveText(
          '3 changes waiting to sync',
        );
        await expect(device.locator('#trip-packed-summary')).toContainText(
          '1 of 3 packed',
        );
      } finally {
        await closeSwitchedContext(context);
      }
    });
  });
});
