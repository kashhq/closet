import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { type Cookie, type Page } from '@playwright/test';
import { expect } from './support/fixtures';
import sharp from 'sharp';
import { addDays } from '../src/calendar-date';
import { test } from './support/cutout-hold';
import { SAME_ORIGIN, signUpHeaders } from './support/e2e-session';
import { openGarmentMenu, openPhotoSheet } from './support/garment-page';
import { householdToday } from './support/household-today';
import { fakeSubscription, stubPushManager } from './support/push-stub';
import { expectReadableTabs } from './support/tab-contrast';

/**
 * Phone-width (390 px) screenshots, and a desktop (1440 px) block, of the key pages with the seed personas
 * (AGENTS.md, Seed personas), saved to screenshots/ for CI to upload as a
 * PR artifact: how every change looks with real data. Not a visual gate:
 * people look at them. Runs only with SEED_SCREENSHOTS (CI's e2e job), as
 * it writes the personas into whatever database the server uses.
 *
 * The seed runs here rather than as a CI step: the CLI refuses a database
 * the build has not migrated, and the server Playwright starts is what
 * migrates it. A fixed anchor makes every run's history the same, and the
 * calendar is addressed by week, whatever today is.
 *
 * Every test owns the personas it shows (#103). The file is serial, so a
 * failure retries the whole file in a fresh worker, and beforeAll rewrites
 * all three personas at the anchor (--reset) every time it runs: neither a
 * retry nor a later run on the same database inherits a Theo that an earlier
 * attempt re-seeded at the real today or added a garment to. The tests that
 * change Theo come last in the file. Pages are reached by exact name, never
 * as "the first tile" of a search, whose order follows the seed's inserts.
 */

const PASSWORD = 'Closet-demo-1';
const ANCHOR = '2026-09-26';
const DIR = 'screenshots';

test.skip(!process.env.SEED_SCREENSHOTS, 'SEED_SCREENSHOTS is not set');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

function seed(...args: string[]): void {
  execFileSync(
    'node',
    ['dist/seed/seed.cli.js', ...args, '--reset', '--password-stdin'],
    { input: `${PASSWORD}\n`, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  sessions.clear();
}

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  seed('--persona', 'all', '--anchor', ANCHOR);
});

const personaEmail = (persona: string) => `${persona}@closet.invalid`;

/**
 * One sign-in per persona and seed, replayed as cookies: the per-account
 * sign-in limit (5 a minute, #984) answers 429 to the dozens a run would
 * otherwise make. A re-seed ends the persona's sessions, so `seed()` drops
 * its entry. Module state lives as long as the serial file's worker.
 */
const sessions = new Map<string, Cookie[]>();

async function signInAs(page: Page, persona: string): Promise<void> {
  const known = sessions.get(persona);
  if (known) {
    await page.context().addCookies(known);
    return;
  }
  const res = await page.request.post('/auth/login', {
    form: { email: personaEmail(persona), password: PASSWORD },
    headers: signUpHeaders(),
    maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
  sessions.set(persona, await page.context().cookies());
}

async function shot(page: Page, name: string, url?: string): Promise<void> {
  if (url) await page.goto(url);
  await page.waitForLoadState('networkidle');
  // Every shot of a page with section tabs, in both themes, proves them
  // readable (#726); a page without an inactive tab skips it (the picker
  // shows the Closet tab alone), and so does one with a sheet open (its
  // backdrop dims the tabs on purpose).
  const sheetOpen = (await page.locator('dialog[open]').count()) > 0;
  const inactiveTabs = page.locator(
    'nav.tabs a.tab:not([aria-current="page"])',
  );
  if (!sheetOpen && (await inactiveTabs.count()) > 0) {
    await expectReadableTabs(page);
  }
  await page.screenshot({
    path: `${DIR}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

/**
 * The raw selvedge jeans' page. Searched by more than "raw": the Iron Rangers'
 * notes say "with the raw denim", and as the newer garment they are the first
 * tile of `?keyword=raw` (#103).
 */
async function openRawSelvedgeJeans(page: Page): Promise<void> {
  await page.goto('/wardrobe?keyword=Raw%20selvedge');
  await page
    .locator('#wardrobe-grid')
    .getByText('Raw selvedge jeans', { exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Raw selvedge jeans',
  );
}

/** Styling with its top row locked: frozen, ringed in the accent (#106). */
async function lockTopRow(page: Page): Promise<void> {
  const top = page.locator('[data-styling-row="top"]');
  await top.locator('label.swap').click();
  await expect(top.locator('input.styling-lock')).toBeChecked();
  await expect(top.locator('.styling-strip')).toHaveCSS('overflow-x', 'hidden');
}

test('demo: Theo, every feature with real data', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '01-demo-wardrobe', '/wardrobe');
  await expect(page.locator('#wardrobe-grid a')).not.toHaveCount(0);
  await page
    .locator('#filter-modal')
    .evaluate((d: HTMLDialogElement) => d.showModal());
  await shot(page, '02-demo-filters');
  await openRawSelvedgeJeans(page);
  await shot(page, '03-demo-garment');
  // The garment page's ⋯ menu and its photo sheet (#84).
  await openGarmentMenu(page);
  await shot(page, '03c-demo-garment-menu');
  await page.locator('#garment-menu summary').click();
  await openPhotoSheet(page);
  await shot(page, '03b-demo-garment-photo-sheet');
  await page.goto(`${page.url().split('?')[0]}/edit`);
  await page
    .locator('details.collapse')
    .first()
    .evaluate((d: HTMLDetailsElement) => (d.open = true));
  await shot(page, '04-demo-garment-form');
  // Adding from a link as Android's share sheet opens it. Only the link
  // page: the prefilled form needs a fetch from the internet, which CI's
  // shots must not depend on (link-import.spec.ts covers the form).
  await shot(
    page,
    '04b-demo-link-import',
    `/wardrobe/new/from-link?text=${encodeURIComponent(
      'UB201 Tapered https://theunbrandedbrand.com/products/ub201-tapered-fit-indigo-selvedge',
    )}`,
  );
  await shot(page, '05-demo-select', '/wardrobe?select=1');
  await shot(page, '06-demo-outfits', '/outfits');
  await page.locator('#saved-outfits a[href^="/outfits/"]').first().click();
  await shot(page, '07-demo-outfit');
  // The outfit page's Plan sheet, and the Saved tab picking for a day as
  // the calendar's "Pick a saved outfit" opens it (R5).
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('#outfit-plan-sheet')).toBeVisible();
  await shot(page, '73-demo-outfit-plan-sheet');
  await shot(
    page,
    '74-demo-saved-for-day',
    '/outfits?for=day:2026-09-29&occasion=evening',
  );
  // Styling (#42) replaced the outfit builder: the fresh stack with its
  // top locked (#106: the frozen row beside the others), then its Save
  // sheet.
  await page.goto('/styling');
  await lockTopRow(page);
  await shot(page, '08-demo-styling');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#styling-save')).toBeVisible();
  await shot(page, '08b-demo-styling-save');
  await shot(page, '09-demo-calendar-history', '/calendar?week=2026-08-23');
  await shot(page, '10-demo-calendar-planned', '/calendar?week=2026-09-27');
  // The calendar's month of collages (R6, #86): August's history.
  await shot(page, '70-demo-calendar-month', '/calendar/month?month=2026-08');
  // The planned week's "+ Plan" on Tuesday: its sheet, the three ways.
  // Opened by the day's button or, while the week template leaves it open
  // slots (from today on), the first of those.
  await page.goto('/calendar?week=2026-09-27');
  await page.locator('[data-plan^="plan-2026-09-29-"]').first().click();
  await expect(page.locator('#plan-sheet-2026-09-29')).toBeVisible();
  // The viewport alone: a full-page shot stitches the modal mid-page.
  await page.screenshot({
    path: `${DIR}/71-demo-calendar-plan-sheet.png`,
    animations: 'disabled',
  });
  // Sharing is its own settings page since #728 (65 is Profile's index).
  await shot(page, '11-demo-shares', '/auth/profile/sharing');
  await shot(page, '65-demo-profile', '/auth/profile');
  // The Wardrobe's header (R3, #83): the switcher in the title (Dana's
  // wardrobe is shared with Theo), the ⋯ menu, the add sheet, and the grid
  // scoped to a capsule from the scope row.
  await page.goto('/wardrobe');
  await page.locator('#title-menu summary').click();
  await shot(page, '66-demo-wardrobe-switcher');
  await page.goto('/wardrobe');
  await page.locator('#wardrobe-menu summary').click();
  await shot(page, '67-demo-wardrobe-menu');
  await page.goto('/wardrobe');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#add-sheet')).toBeVisible();
  await shot(page, '68-demo-wardrobe-add');
  await page.goto('/wardrobe?category=tops');
  await page.locator('#capsule-scope summary').click();
  await page
    .locator('#capsule-scope')
    .getByRole('link', { name: 'Office' })
    .click();
  await expect(page).toHaveURL(/capsule=\d+/);
  await shot(page, '69-demo-wardrobe-capsule');
});

// The dark theme (#81, closet-dark follows the system's scheme): the same
// key pages (and the garment page's photo sheet) as their light twins
// above, named after them. Before any test re-seeds Theo, so each pair
// shows the same data.
test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('demo: Theo, the key pages in the dark theme', async ({ page }) => {
    await signInAs(page, 'demo');
    await shot(page, '01-demo-wardrobe-dark', '/wardrobe');
    await openRawSelvedgeJeans(page);
    await shot(page, '03-demo-garment-dark');
    await openPhotoSheet(page);
    await shot(page, '03b-demo-garment-photo-sheet-dark');
    await shot(page, '06-demo-outfits-dark', '/outfits');
    await page.locator('#saved-outfits a[href^="/outfits/"]').first().click();
    await shot(page, '07-demo-outfit-dark');
    await page.goto('/styling');
    await lockTopRow(page);
    await shot(page, '08-demo-styling-dark');
    await shot(
      page,
      '10-demo-calendar-planned-dark',
      '/calendar?week=2026-09-27',
    );
    await shot(
      page,
      '70-demo-calendar-month-dark',
      '/calendar/month?month=2026-08',
    );
  });
});

// Desktop, 1440 x 900 (#307: 390 and 1440 per PR). Styling at lg (#468):
// the rows beside the aside (the preview, Shuffle and Save), fresh, then
// shuffled around a locked top. Before any test re-seeds Theo.
test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test('demo: Theo, Styling at 1440', async ({ page }) => {
    await signInAs(page, 'demo');
    await shot(page, '82-demo-styling-desktop', '/styling');
    await lockTopRow(page);
    await page.getByRole('button', { name: /Shuffle/ }).click();
    await expect(page.locator('#styling-rows input[name="seed"]')).toHaveCount(
      1,
    );
    await shot(page, '82b-demo-styling-shuffled-desktop');
  });

  // Density (#1064): the galleries auto-fill from lg, and the calendar's
  // collages take their desktop step, so a month fits the 900 px fold.
  test('demo: Theo, the grids and the calendar at 1440', async ({ page }) => {
    await signInAs(page, 'demo');
    await shot(page, '83-demo-wardrobe-desktop', '/wardrobe');
    await shot(page, '84-demo-outfits-desktop', '/outfits');
    await shot(page, '85-demo-inspiration-desktop', '/inspiration');
    await shot(page, '86-demo-wishlist-desktop', '/wardrobe/wishlist');
    await shot(page, '87-demo-insights-desktop', '/wardrobe/insights');
    await shot(
      page,
      '88-demo-calendar-three-outfits-desktop',
      '/calendar?week=2026-08-09',
    );
    await shot(
      page,
      '89-demo-calendar-month-desktop',
      '/calendar/month?month=2026-08',
    );
  });

  // Section tabs in the app bar (#1061): each section's sibling pages not
  // shot above, so every tab row is seen in its one place, and Profile at
  // the rail's foot.
  test('demo: Theo, the section tabs at 1440', async ({ page }) => {
    await signInAs(page, 'demo');
    await shot(page, '90-demo-capsules-desktop', '/capsules');
    await shot(page, '91-demo-laundry-desktop', '/laundry');
    await shot(page, '92-demo-ideas-desktop', '/outfits/ideas?seed=1');
    await shot(page, '93-demo-trips-desktop', '/trips');
    await shot(page, '94-demo-profile-desktop', '/auth/profile');
  });
});

/**
 * Every sheet open, each from its own trigger (layout/sheet.tsx, #1062):
 * on a phone every kind is the bottom sheet, from lg the kind places it
 * (choice centred, form a right panel, menu under its trigger). Viewport
 * shots: a full-page one stitches the modal mid-page. Nothing is posted,
 * so Theo is as the seed left him.
 */
async function sheetShots(page: Page, suffix: string): Promise<void> {
  const open = async (name: string, sheet: string) => {
    await expect(page.locator(sheet)).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: `${DIR}/90-sheet-${name}${suffix}.png`,
      animations: 'disabled',
    });
  };
  await signInAs(page, 'demo');
  await page.goto('/wardrobe');
  await page.getByRole('button', { name: 'Filters' }).click();
  await open('filters', '#filter-modal');
  await page.goto('/wardrobe');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await open('add', '#add-sheet');
  await page.goto('/wardrobe?select=1');
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await open('bulk-actions', '#bulk-actions');
  await page.goto('/wardrobe?select=1');
  await page.getByRole('button', { name: 'Set…', exact: true }).click();
  await open('bulk-set', '#bulk-dialog');
  await openRawSelvedgeJeans(page);
  await page.locator('#editMaskBtn').click();
  await open('mask-editor', '#maskEditorDialog');
  await page.reload();
  await openPhotoSheet(page);
  await open('garment-photo', '#garment-photo-sheet');
  await page.reload();
  const menu = await openGarmentMenu(page);
  await menu.getByRole('button', { name: 'Archive', exact: true }).click();
  await open('confirm', '#confirm-sheet');
  await page.goto('/outfits');
  await page.locator('#saved-outfits a[href^="/outfits/"]').first().click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await open('outfit-plan', '#outfit-plan-sheet');
  await page.goto('/styling');
  await lockTopRow(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await open('styling-save', '#styling-save');
  await page.goto('/calendar?week=2026-09-27');
  await page.locator('[data-plan^="plan-2026-09-29-"]').first().click();
  await open('calendar-plan', '#plan-sheet-2026-09-29');
}

test.describe('sheets', () => {
  test('demo: Theo, every sheet at 390', async ({ page }) => {
    await sheetShots(page, '');
  });

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

    test('demo: Theo, every sheet at 1440', async ({ page }) => {
      await sheetShots(page, '-desktop');
    });
  });
});

/**
 * The pages D2 (#1060) put on `PageShell`, plus the capsule page and a
 * selfie's dialog (their frames moved in #1096 and #1106), at the current
 * viewport: `make screenshots` runs it at 390 and at 1440, so a change to
 * the frame shows against `main` on a phone and at a desktop's width.
 * `suffix` names the viewport. Theo's data is as the seed left it (before
 * the tests that re-seed him); the tagging page needs untagged garments,
 * which are Dana's.
 */
async function framedPageShots(page: Page, suffix: string): Promise<void> {
  const name = (slug: string) => `91-framed-${slug}${suffix}`;
  await signInAs(page, 'demo');
  await shot(page, name('profile'), '/auth/profile');
  await shot(page, name('style'), '/auth/profile/style');
  await shot(page, name('sizes'), '/auth/profile/sizes');
  await shot(page, name('tokens'), '/auth/tokens');
  await shot(page, name('link-import'), '/wardrobe/new/from-link');
  await shot(page, name('plan'), `/calendar/plan?for=day:${ANCHOR}`);
  await shot(page, name('recap'), `/wardrobe/recap?year=${ANCHOR.slice(0, 4)}`);
  await page.goto('/outfits');
  await page.locator('#saved-outfits a[href^="/outfits/"]').first().click();
  await shot(page, name('outfit'));
  const outfitPath = new URL(page.url()).pathname;
  const hx = { ...SAME_ORIGIN, 'hx-request': 'true' };
  await page.request.post(`${outfitPath}/share`, { headers: hx });
  await page.goto(outfitPath);
  const shareLink = new URL(
    await page.locator('[data-public-share] input').inputValue(),
  );
  const invite = await page.request.post('/wardrobe-share/create-invite-link', {
    form: { permission: 'VIEW' },
    headers: hx,
  });
  const invitePath = /\/wardrobe-share\/invite\/[0-9a-f-]{36}/.exec(
    await invite.text(),
  )?.[0];
  expect(invitePath).toBeDefined();
  await page.goto('/trips');
  await page.getByRole('link', { name: /Austin conference/ }).click();
  await expect(page.locator('#trip-packed-summary')).toBeVisible();
  await shot(page, name('trip'));
  await page.locator('[data-add-outfit]').first().click();
  await expect(
    page.getByRole('heading', { name: 'Add an outfit' }),
  ).toBeVisible();
  await shot(page, name('trip-add-outfit'));
  await page.goto('/capsules');
  await page.getByRole('link', { name: /^Weekend/ }).click();
  await expect(page.getByRole('heading', { name: 'Weekend' })).toBeVisible();
  await shot(page, name('capsule'));
  await openSelfie(page);
  await page.screenshot({
    path: `${DIR}/${name('selfie-dialog')}.png`,
    animations: 'disabled',
  });
  await shot(page, name('trips'), '/trips');
  await shot(page, name('laundry'), '/laundry');
  await shot(page, name('about'), '/about');
  await shot(page, name('offline'), '/offline.html');
  await shot(page, name('invite-signed-in'), invitePath);
  await page.context().clearCookies();
  await shot(page, name('login'), '/auth/login');
  await shot(page, name('register'), '/auth/register');
  await shot(page, name('invite'), invitePath);
  await shot(page, name('offline-signed-out'), '/offline.html');
  await shot(page, name('share'), `${shareLink.pathname}${shareLink.search}`);
  await signInAs(page, 'demo');
  await page.request.post(`${outfitPath}/share/stop`, { headers: hx });
  await signInAs(page, 'sparse');
  await shot(page, name('tag'), '/wardrobe/tag');
}

/** The latest week with a selfie, its first one open in its dialog. */
async function openSelfie(page: Page): Promise<void> {
  for (const start of [
    '2026-09-20',
    '2026-09-13',
    '2026-09-06',
    '2026-08-30',
  ]) {
    await page.goto(`/calendar?week=${start}`);
    if ((await page.locator('button[data-selfie]').count()) > 0) break;
  }
  await page.locator('button[data-selfie]').first().click();
  await expect(page.locator('dialog[open] img')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test.describe('framed pages', () => {
  test('demo: Theo, the framed pages at 390', async ({ page }) => {
    await framedPageShots(page, '');
  });

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

    test('demo: Theo, the framed pages at 1440', async ({ page }) => {
      await framedPageShots(page, '-desktop');
    });
  });
});

test('demo: Theo, capsules', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '17-demo-capsules', '/capsules');
  await page.getByRole('link', { name: /^Weekend/ }).click();
  // The list's card has the name too: the URL says the boosted tap landed.
  await expect(page).toHaveURL(/\/capsules\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Weekend' })).toBeVisible();
  await shot(page, '18-demo-capsule');
  await page.getByRole('link', { name: 'Choose garments' }).first().click();
  await expect(page.locator('#pick-form')).toBeVisible();
  await shot(page, '19-demo-capsule-picker');
});

test('demo: Theo, wears and washes', async ({ page }) => {
  await signInAs(page, 'demo');
  // Saturday's hamper: the week's wears since Sunday's laundry.
  await shot(page, '20-demo-laundry', '/laundry');
  await expect(page.getByText('Needs a wash').first()).toBeVisible();
  // The x3 white tees: worn this week (a search also finds shirts whose
  // notes mention a white tee, so the tile is picked by its name).
  await page.goto('/wardrobe?keyword=White%20tee');
  await page
    .locator('#wardrobe-grid')
    .getByText('White tee', { exact: true })
    .click();
  await expect(page.locator('#garment-wear')).toContainText('Worn');
  await shot(page, '21-demo-garment-wears');
  await shot(page, '22-demo-needs-wash', '/wardrobe?needsWash=true');
  await shot(page, '23-demo-needs-attention', '/wardrobe?attention=true');
});

test('demo: Theo, several outfits a day', async ({ page }) => {
  await signInAs(page, 'demo');
  // Thursday Aug 13: a morning run, the office, then rooftop drinks.
  await page.goto('/calendar?week=2026-08-09');
  await expect(page.locator('[data-occasion="night-out"]')).not.toHaveCount(0);
  await shot(page, '25-demo-calendar-three-outfits');
  // Planning one more on the planned Saturday (gym, the day, a date).
  await shot(
    page,
    '26-demo-calendar-plan',
    '/calendar/plan?for=day:2026-10-03&occasion=night-out',
  );
});

test('demo: Theo, the wishlist', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '30-demo-wishlist', '/wardrobe/wishlist');
  await page.getByRole('link', { name: 'New grey merino crewneck' }).click();
  await expect(page.locator('#garment-replacement')).toBeVisible();
  await shot(page, '31-demo-wishlist-item');
  await page.getByRole('link', { name: 'Bought it' }).first().click();
  await expect(
    page.getByRole('button', { name: 'Move to closet' }),
  ).toBeVisible();
  await shot(page, '32-demo-bought-it');
  // The pilling merino it replaces: "Find a replacement", and the item.
  await page.goto('/wardrobe?keyword=Grey%20merino');
  await page
    .locator('#wardrobe-grid')
    .getByText('Grey merino crewneck', { exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Find a replacement' }),
  ).toBeVisible();
  await shot(page, '33-demo-replace-soon');
  // "Goes with my closet" (#18b) on the Allbirds: 50+ outfits, and the
  // white sneakers he already owns.
  await page.goto('/wardrobe/wishlist');
  await page.getByRole('link', { name: 'White Couriers' }).click();
  await expect(page.locator('[data-goes-with-duplicates]')).toContainText(
    'White sneakers',
  );
  await shot(page, '34-demo-goes-with');
});

test('demo: Theo, weather', async ({ page }) => {
  await signInAs(page, 'demo');
  // Today's line (the seed's simulated weather, from the test server's
  // stand-in for Open-Meteo) in °F, then the forecast on this week's days.
  await page.goto('/');
  await expect(page.locator('p#weather-line')).toContainText('°F');
  // Today carries Open-Meteo's credit (CC BY 4.0, #640) on a row of its own:
  // the credit is one text line at 390 px and the weather line above it is
  // not pushed onto more rows by it.
  await page.goto('/');
  const credit = page.locator('p#weather-line [data-open-meteo]');
  await expect(credit).toHaveText('Weather data by Open-Meteo.com');
  const creditHeight = (await credit.boundingBox())?.height ?? 0;
  const lineHeight = (await page.locator('p#weather-line').boundingBox())
    ?.height;
  expect(creditHeight).toBeLessThan(20);
  expect(lineHeight).toBeLessThan(90);
  await shot(page, '35b-demo-weather-today');
  await page.goto('/calendar');
  await expect(page.locator('[data-weather-day]')).not.toHaveCount(0);
  await shot(page, '36-demo-weather-calendar');
  await page.goto('/auth/profile/weather');
  await expect(page.locator('main')).toContainText(
    'Home: Fort Greene, Brooklyn',
  );
  await shot(page, '37-demo-weather-profile');
});

test('demo: Theo, his style profile', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '40-demo-style-profile', '/auth/profile/style');
});

test('demo: Theo, his sizes (#24)', async ({ page }) => {
  await signInAs(page, 'demo');
  // Profile › Sizes (its own page since #728), and a brand's note where he
  // shops: a wishlist item's page and its form.
  await page.goto('/auth/profile/sizes');
  await expect(
    page.locator('input[name="brand"][value="Uniqlo"]'),
  ).toBeVisible();
  await shot(page, '76-demo-sizes-editor');
  await page.goto('/wardrobe/wishlist');
  await page.getByRole('link', { name: 'White Couriers' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/\d+$/);
  await expect(page.locator('main [data-brand-size]')).toContainText(
    'Your size in Allbirds: 10',
  );
  await shot(page, '77-demo-wishlist-item-size');
  await page.goto(`${page.url().split('?')[0]}/edit`);
  await expect(page.locator('#brand-size-hint')).toContainText('Allbirds');
  await shot(page, '78-demo-garment-form-size-hint');
});

test('demo: Theo, the outfit gallery', async ({ page }) => {
  await signInAs(page, 'demo');
  // A fixed seed, so the run's cards are the same ideas whatever the day's
  // seed would be (the weather still follows the test server's today).
  await page.goto('/outfits/ideas?seed=1');
  await expect(page.locator('article[data-idea]').first()).toBeVisible();
  await shot(page, '46-demo-ideas');
  // From the planned week's "+ Plan": Tuesday evening.
  await page.goto('/calendar/plan?for=day:2026-09-29&occasion=evening');
  await page.getByRole('link', { name: 'Choose from ideas' }).click();
  await expect(
    page.getByRole('button', { name: 'Plan for Tuesday' }).first(),
  ).toBeVisible();
  await shot(page, '47-demo-ideas-for-day');
  // "Style this" on the olive chinos: Styling locked on them, opened on the
  // day's idea around them (never with the olive chore coat, his Clashes,
  // whose page lists the pair).
  await page.goto('/wardrobe?keyword=Olive%20chinos');
  await page
    .locator('#wardrobe-grid')
    .getByText('Olive chinos', { exact: true })
    .click();
  await expect(page.locator('#garment-avoided')).toContainText(
    'Olive chore coat',
  );
  await page.getByRole('link', { name: 'Style this' }).click();
  await expect(
    page.locator('[data-styling-row="bottom"] input.styling-lock'),
  ).toBeChecked();
  await shot(page, '48-demo-style-this');
});

test('demo: Theo, insights', async ({ page }) => {
  await signInAs(page, 'demo');
  // Measured from the real today, not the anchor: the history ages with
  // the run's date, so the figures drift (a picture, not a gate).
  await page.goto('/wardrobe/insights');
  await expect(page.locator('#insights-worn')).toBeVisible();
  await shot(page, '50-demo-insights');
  await shot(
    page,
    '51-demo-insights-unworn-30',
    '/wardrobe/insights?unworn=30',
  );
  // "Style this" on an unworn garment opens Styling locked on it.
  await page
    .locator('#insights-unworn')
    .getByRole('link', { name: 'Style this' })
    .first()
    .click();
  await expect(page.locator('input.styling-lock:checked')).toHaveCount(1);
  await shot(page, '52-demo-insights-style-this');
});

test('demo: Theo, his year in review (#26)', async ({ page }) => {
  await signInAs(page, 'demo');
  // The anchor's year, whatever year the run is in: the history is 2026's.
  await shot(
    page,
    '80-demo-recap',
    `/wardrobe/recap?year=${ANCHOR.slice(0, 4)}`,
  );
  // "Save image" downloads the card in Chromium (no file sharing on Linux).
  const save = page.locator('#recap-export');
  await expect(save).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    save.click(),
  ]);
  await download.saveAs(`${DIR}/80b-demo-recap-card.png`);
});

test('demo: Theo, his Austin conference (#10)', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '61-demo-trips', '/trips');
  await page.getByRole('link', { name: /Austin conference/ }).click();
  // The packing list derived from the trip's outfits, partly packed.
  await expect(page.locator('#trip-packed-summary')).toContainText(
    '9 of 15 packed',
  );
  await shot(page, '62-demo-trip');
  await page.locator('[data-add-outfit]').first().click();
  await expect(
    page.getByRole('heading', { name: 'Add an outfit' }),
  ).toBeVisible();
  await shot(page, '63-demo-trip-add-outfit');
});

test('sparse: Dana, untagged and degraded', async ({ page }) => {
  await signInAs(page, 'sparse');
  await shot(page, '12-sparse-wardrobe', '/wardrobe');
  await shot(page, '13-sparse-tagging', '/wardrobe/tag');
  // A closet without a wear: the figures at zero and what to do about it.
  await shot(page, '53-sparse-insights', '/wardrobe/insights');
});

test('fresh: Riley, the empty states', async ({ page }) => {
  await signInAs(page, 'fresh');
  await shot(page, '14-fresh-wardrobe', '/wardrobe');
  await shot(page, '15-fresh-outfits', '/outfits');
  await shot(page, '65-fresh-styling', '/styling');
  await shot(page, '16-fresh-calendar', `/calendar?week=${ANCHOR}`);
  await shot(page, '72-fresh-calendar-month', '/calendar/month?month=2026-09');
  await shot(page, '24-fresh-laundry', '/laundry');
  await shot(page, '34-fresh-wishlist', '/wardrobe/wishlist');
  await shot(page, '49-fresh-ideas', '/outfits/ideas');
  await shot(page, '54-fresh-insights', '/wardrobe/insights');
  await shot(page, '81-fresh-recap', '/wardrobe/recap');
  // Today with nothing in the closet: what ideas need.
  await shot(page, '57-fresh-today', '/');
  await shot(page, '64-fresh-trips', '/trips');
  await shot(page, '79-fresh-sizes', '/auth/profile/sizes');
  await shot(
    page,
    '27-fresh-calendar-plan',
    `/calendar/plan?for=day:${ANCHOR}`,
  );
});

test('demo: Theo, outfit selfies (#19)', async ({ page }) => {
  await signInAs(page, 'demo');
  // His evenings out of the four weeks before the anchor carry a mirror
  // selfie: the latest week that has one. Before Theo is re-seeded at the
  // real today, which would move them.
  let week = '';
  for (const start of [
    '2026-09-20',
    '2026-09-13',
    '2026-09-06',
    '2026-08-30',
  ]) {
    await page.goto(`/calendar?week=${start}`);
    if ((await page.locator('button[data-selfie]').count()) > 0) {
      week = start;
      break;
    }
  }
  expect(week).not.toBe('');
  const row = page
    .locator('[data-occasion]', { has: page.locator('button[data-selfie]') })
    .first();
  await row.scrollIntoViewIfNeeded();
  await shot(page, '58-demo-calendar-selfies');
  await row.locator('button[data-selfie]').click();
  await expect(page.locator('dialog[open] img')).toBeVisible();
  await shot(page, '59-demo-selfie');
  // The outfit's Worn strip: every day it was worn, with its looks.
  const edit = await row
    .locator('a[href^="/styling?outfit="]')
    .getAttribute('href');
  const outfit = /[?&]outfit=(\d+)/.exec(edit ?? '')?.[1];
  await shot(page, '60-demo-outfit-worn', `/outfits/${outfit}`);
  await expect(page.locator('[data-worn-strip] img').first()).toBeVisible();
});

// Last but for the photo adds: it re-seeds Theo. Today is the server's
// real today, so his history is re-drawn with today as its anchor (no
// --anchor), which the simulation leaves half lived: the morning's workout worn, the evening
// planned, ideas for the day (demo.md, step 7). What exactly is planned
// depends on the weekday.
test('demo: Theo, Today and his reminders (#15)', async ({ page }) => {
  seed('--persona', 'demo');
  await signInAs(page, 'demo');
  await shot(page, '55-demo-today', '/');
  await expect(page.locator('[data-today-row]').first()).toBeVisible();

  // The profile's notifications, on, with this device's reminders: the
  // headless shell has no push service or permission, so both are stubbed
  // (test/support/push-stub.ts); the server's side is real.
  await stubPushManager(page, fakeSubscription(), true, { granted: true });
  await page.goto('/auth/profile/notifications');
  const reminders = page.locator('#push-reminders');
  await expect(reminders).toBeVisible();
  await reminders
    .getByRole('checkbox', { name: "Morning: today's outfit" })
    .check();
  await expect(reminders.getByText('Saved.')).toBeVisible();
  await page.locator('push-settings').scrollIntoViewIfNeeded();
  await shot(page, '56-demo-push-settings');

  // The weekly auto-plan (#16): his week template on the Profile, and the
  // days after today that "Plan my week" filled (the seed's, demo.md step
  // 7), marked Auto on the calendar: tomorrow's week has some.
  await shot(page, '58-demo-week-template', '/auth/profile/week');
  await shot(
    page,
    '59-demo-week-planned',
    `/calendar?week=${addDays(householdToday(), 1)}`,
  );
  await expect(page.locator('[data-auto]').first()).toBeVisible();
});

// Adding from a photo (#97): the add sheet's camera, the new garment form
// holding the photo, and the garment it saves with its cutout under way.
// Last in the file, in both themes: saving adds a garment to Theo's
// wardrobe, which no earlier shot may show.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`add from a photo, ${colorScheme}`, () => {
    test.use({ colorScheme });
    const suffix = colorScheme === 'dark' ? '-dark' : '';

    test(`demo: Theo adds a garment from a photo (${colorScheme})`, async ({
      page,
      cutouts,
    }) => {
      await signInAs(page, 'demo');
      // This shot is the cutout pending: held until it is taken.
      await cutouts.hold(personaEmail('demo'));
      await page.goto('/wardrobe');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('#add-sheet [data-photo-source="camera"]').click(),
      ]);
      await chooser.setFiles({
        name: 'IMG_0042.jpg',
        mimeType: 'image/jpeg',
        buffer: await sharp({
          create: {
            width: 900,
            height: 1200,
            channels: 3,
            background: '#6b4f3a',
          },
        })
          .jpeg()
          .toBuffer(),
      });
      await expect(page).toHaveURL(/\/wardrobe\/new\?photo=/);
      await expect(page.locator('#link-photo img')).toBeVisible();
      await shot(page, `75-demo-add-from-photo${suffix}`);
      await page.locator('input[name="name"]').fill('Suede overshirt');
      await page.locator('#garment-category').fill('jacket');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('#garment-photo-status')).toHaveText(
        /Removing background/,
      );
      await shot(page, `76-demo-add-from-photo-saved${suffix}`);
      await cutouts.release(personaEmail('demo'));
    });
  });
}
