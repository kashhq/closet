import { type Page } from '@playwright/test';
import { expect } from './support/fixtures';
import sharp from 'sharp';
import { test } from './support/cutout-hold';
import { addPhotographedGarment, createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * Adding a garment from a photo (#97) at phone width: a fresh account's
 * Today leads with "Add your first garment" (#666), whose one tap opens the
 * add sheet, the camera row opens the camera
 * (`capture=environment`), the chosen photo
 * is prepared on the phone and posted, the new garment form opens with it,
 * and saving lands on the garment with its cutout under way (held pending
 * until the page has shown it, test/support/cutout-stub.ts); then the
 * search box finds it by two of its words in any order (#673). The filter
 * sheet (#674) and select mode's kept selection (#677) ride along at the
 * same width, and at a desktop's the garment page's split (#1068) and the
 * filters docked beside the grid (#1067).
 */

test.use({ viewport: { width: 390, height: 844 } });

/** The first-run path (#666): an empty closet's Today, one tap. */
async function openAddSheet(page: Page) {
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Add your first garment', exact: true })
    .click();
  const sheet = page.locator('#add-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * A tall menu opened from a mid-page trigger at desktop width (Today's
 * first-run button on a short window) is capped to the room beside its
 * anchor and scrolls inside itself, so its last row stays reachable under
 * the locked page.
 */
async function checkAddMenuReach(page: Page) {
  await page.setViewportSize({ width: 1440, height: 560 });
  const sheet = await openAddSheet(page);
  const box = sheet.locator('.modal-box');
  const last = box.locator('a, button, label').last();
  await last.scrollIntoViewIfNeeded();
  const view = page.viewportSize()!;
  const at = (await last.boundingBox())!;
  const frame = (await box.boundingBox())!;
  expect(at.y).toBeGreaterThanOrEqual(frame.y);
  expect(at.y + at.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
  expect(frame.y).toBeGreaterThanOrEqual(0);
  expect(frame.y + frame.height).toBeLessThanOrEqual(view.height);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
}

/**
 * The garment page from lg is PageShell's `split` (#1068): the photo left
 * of the facts, and sticky, so it stays in view at its place under the bar
 * while the facts scroll past it. A garment of its own, with notes and care
 * notes long enough that the facts run well past the photo (a fresh
 * garment's are about its height, and sticky holds nothing in a frame no
 * taller than itself). Run last: it adds a garment to the closet.
 */
async function checkSplitAtDesktop(page: Page) {
  const words = 'Soft brushed twill, a little roomy in the shoulder. '.repeat(
    30,
  );
  const id = await addPhotographedGarment(page, 'Long notes coat', 'coats', {
    notes: words,
    washingDetails: words,
  });
  await page.setViewportSize({ width: 1024, height: 560 });
  await page.goto(`/wardrobe/${id}`);
  const photo = page.locator('#garment-photo');
  const facts = page.locator('#garment-body');
  await expect(photo.locator('img')).toBeVisible();
  const before = {
    photo: (await photo.boundingBox())!,
    facts: (await facts.boundingBox())!,
  };
  expect(before.photo.x + before.photo.width).toBeLessThanOrEqual(
    before.facts.x,
  );
  const step = 200;
  expect(
    await page.evaluate((y) => {
      window.scrollTo(0, y);
      return window.scrollY;
    }, step),
  ).toBe(step);
  expect((await facts.boundingBox())!.y).toBeCloseTo(before.facts.y - step, 0);
  const after = (await photo.boundingBox())!;
  expect(after.y).toBeCloseTo(before.photo.y, 0);
  const bar = (await page.locator('header.app-bar').boundingBox())!;
  expect(after.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(after.y + after.height).toBeLessThanOrEqual(560);
  await checkTallSubjectScrolls(page, id);
  await checkSubjectFocusRing(page);
  await page.setViewportSize({ width: 390, height: 844 });
}

/**
 * The scrolling subject clips on both axes, so a control's focus ring (2px
 * plus a 2px offset) must sit inside it: a photoless garment's "Add photo"
 * button is the subject's one control.
 */
async function checkSubjectFocusRing(page: Page) {
  const bare = await createGarment(page, 'Bare coat', 'coats');
  await page.goto(`/wardrobe/${bare}`);
  const subject = page.locator('#garment-aside');
  const button = subject.getByRole('button', { name: 'Add a photo' });
  await page.keyboard.press('Tab');
  await button.focus();
  await expect(button).toBeFocused();
  const ring = await button.evaluate((el) => {
    const style = getComputedStyle(el);
    const reach =
      parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const box = el.getBoundingClientRect();
    const frame = el.closest('#garment-aside')!.getBoundingClientRect();
    return {
      reach,
      inside:
        box.left - reach >= frame.left &&
        box.right + reach <= frame.right &&
        box.top - reach >= frame.top &&
        box.bottom + reach <= frame.bottom,
    };
  });
  expect(ring.reach).toBeGreaterThanOrEqual(4);
  expect(ring.inside).toBe(true);
}

/**
 * A split page's subject taller than the window under the bar scrolls inside
 * itself (main.css, the split aside's max-height), so the collage under long
 * notes stays reachable. An outfit of the coat with notes at the cap, at 1440
 * x 700.
 */
async function checkTallSubjectScrolls(page: Page, garmentId: number) {
  const made = await page.request.post('/outfits', {
    form: {
      name: 'Long notes outfit',
      notes: 'Wear it open over a plain tee, sleeves pushed up. '
        .repeat(80)
        .slice(0, 4000),
      category: 'coats',
      garmentId: String(garmentId),
      scheduleDate: '',
    },
    headers: SAME_ORIGIN,
  });
  expect(made.ok()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(made.url());
  const subject = page.locator('#outfit-aside');
  const collage = subject.locator('[data-collage]');
  await expect(collage).toBeAttached();
  const frame = await subject.evaluate((el) => ({
    scrolls: el.scrollHeight > el.clientHeight,
    bottom: el.getBoundingClientRect().bottom,
  }));
  expect(frame.scrolls).toBe(true);
  expect(frame.bottom).toBeLessThanOrEqual(700);
  await collage.scrollIntoViewIfNeeded();
  const at = (await collage.boundingBox())!;
  const box = (await subject.boundingBox())!;
  expect(at.y + at.height).toBeLessThanOrEqual(box.y + box.height + 1);
  expect(at.y + at.height).toBeLessThanOrEqual(700);
}

const photo = () =>
  sharp({
    create: { width: 900, height: 1200, channels: 3, background: '#357' },
  })
    .jpeg()
    .toBuffer();

test('the camera row takes a photo, the form opens with it, and saving lands on the garment with its cutout under way', async ({
  page,
  cutouts,
}) => {
  const email = await signIn(page, 'add-photo');
  await cutouts.hold(email);
  await checkAddMenuReach(page);
  const sheet = await openAddSheet(page);

  const camera = sheet.locator('[data-photo-source="camera"]');
  await expect(camera).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    camera.click(),
  ]);
  expect(await chooser.element().getAttribute('capture')).toBe('environment');
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles({
    name: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    buffer: await photo(),
  });

  await expect(page).toHaveURL(/\/wardrobe\/new\?photo=[0-9a-f-]+\.webp$/);
  const preview = page.locator('#link-photo img');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty('complete', true);
  expect(
    await preview.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);
  await expect(
    page.getByText('The background is removed once you save.'),
  ).toBeVisible();
  // Nothing is wider than the phone.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await page.locator('input[name="name"]').fill('Blue camera shirt');
  await page.locator('#garment-category').fill('shirt');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page).toHaveURL(/\/wardrobe\/\d+(\?created=1)?$/);
  await expect(page.getByText('Camera shirt').first()).toBeVisible();
  await expect(page.locator('#garment-photo-status')).toHaveText(
    /Removing background/,
  );
  await cutouts.release(email);
  await expect(page.locator('#garment-photo img')).toHaveAttribute(
    'src',
    /^\/file\/nobg\/[0-9a-f-]+\.webp\?v=2&k=[0-9a-f]{12}&s=[\w-]{16}$/,
    { timeout: 15_000 },
  );

  // The grid shows the new garment once, with its photo.
  await page.goto('/wardrobe');
  const grid = page.locator('#wardrobe-grid');
  await expect(grid.getByText('Camera shirt')).toHaveCount(1);

  // Typing two of its words, in another order than its name's, finds it.
  // The field is collapsed to its icon until tapped, as a finger does.
  await page.getByRole('search').locator('label').click();
  const search = page.getByRole('textbox', { name: 'Search' });
  await expect(search).toBeFocused();
  await search.fill('shirt blue');
  const searched = page.waitForResponse(
    (res) =>
      new URL(res.url()).searchParams.get('keyword') === 'shirt blue' &&
      res.ok(),
  );
  await search.press('Enter');
  await searched;
  await expect(grid.getByText('Blue camera shirt')).toBeVisible();
  await expect(page.locator('[data-tile]')).toHaveCount(1);

  await checkFilterSheet(page);
  await checkSelectMode(page);
  await checkSplitAtDesktop(page);
});

/**
 * Select mode keeps its selection (#677): two tiles tapped once take a
 * warmth, then a formality, then join a capsule, never selected again. Run
 * after the filter sheet (its blue tops are the two), not a scenario of its
 * own.
 */
async function checkSelectMode(page: Page) {
  const made = await page.request.post('/capsules', {
    form: { name: 'Office' },
    headers: SAME_ORIGIN,
  });
  expect(made.ok()).toBe(true);
  await page.goto('/wardrobe?select=1&color=blue&category=tops');
  const grid = page.locator('#wardrobe-grid');
  const count = page.locator('#selected-count');
  await grid.getByRole('checkbox', { name: 'Blue shirt' }).click();
  await grid.getByRole('checkbox', { name: 'Blue tee' }).click();
  await expect(count).toHaveText('2');

  const setOne = async (property: string, value: string, toast: string) => {
    await page.getByRole('button', { name: 'Set…' }).click();
    const dialog = page.locator('#bulk-dialog');
    await dialog.getByRole('tab', { name: property }).click();
    await dialog.getByRole('radio', { name: value, exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(toast)).toBeVisible();
    // Back in select mode with the same two checked.
    await expect(count).toHaveText('2');
    await expect(grid.getByRole('checkbox', { checked: true })).toHaveCount(2);
  };
  await setOne('Warmth', 'Warm', 'Set on 2 garments');
  await setOne('Formality', 'Smart casual', 'Set on 2 garments');

  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page
    .locator('#bulk-actions')
    .getByRole('button', { name: 'Add to capsule' })
    .click();
  await expect(page.getByText('2 garments added to the capsule')).toBeVisible();
  await expect(grid.getByRole('checkbox', { checked: true })).toHaveCount(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  // Focus scrolls clear of the action bar above the dock too (#1026): the
  // scroll padding reserves at least the bar's height beyond the dock's.
  const reserved = await page.evaluate(() => {
    const bar = document.getElementById('wardrobe-actions');
    if (!bar) return null;
    return {
      padding: parseFloat(
        getComputedStyle(document.documentElement).scrollPaddingBottom,
      ),
      needed: window.innerHeight - bar.getBoundingClientRect().top,
    };
  });
  expect(reserved?.padding).toBeGreaterThanOrEqual(
    reserved?.needed ?? Infinity,
  );
  // At 200% text too (#1030): the reservation is the bar's real height, so
  // a checkbox scrolled to the bottom edge, as focus scrolls one up from
  // below the fold, lands whole above the action bar.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await grid.getByRole('checkbox').last().focus();
  const clear = await page.evaluate(() => {
    const focused = document.activeElement!;
    focused.scrollIntoView({ block: 'end' });
    const box = focused.getBoundingClientRect();
    const bar = document.getElementById('wardrobe-actions')!;
    const appBar = document.querySelector('.app-bar')!;
    return {
      below: bar.getBoundingClientRect().top - box.bottom,
      above: box.top - appBar.getBoundingClientRect().bottom,
    };
  });
  expect(clear.below).toBeGreaterThanOrEqual(0);
  expect(clear.above).toBeGreaterThanOrEqual(0);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
}

/**
 * The filter sheet (#674): blue shirts in five taps, by keyboard one
 * choice cleared alone, and the keyboard kept inside the open sheet until
 * Escape hands it back to Filters (#1062). Run at the end of the scenario above (the closet
 * already holds its camera shirt, a custom category), not as a scenario of
 * its own.
 */
async function checkFilterSheet(page: Page) {
  await createGarment(page, 'Blue shirt', 'tops', {
    props: '1',
    color: 'blue',
    type: 'shirt',
  });
  await createGarment(page, 'Blue tee', 'tops', {
    props: '1',
    color: 'blue',
    type: 't-shirt',
  });
  await createGarment(page, 'Red shirt', 'tops', {
    props: '1',
    color: 'red',
    type: 'shirt',
  });
  await page.goto('/wardrobe');
  const tiles = page.locator('[data-tile]');
  await expect(tiles).toHaveCount(4);

  // Filters, Tops, Shirt, Blue, Apply: the type chips are there as soon as
  // the category is chosen, with no Apply between.
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  // "Shirt" is also the camera garment's custom category: scope to Type.
  const types = sheet.getByRole('group', { name: 'Type · Tops' });
  const shirtType = types.getByRole('radio', { name: 'Shirt', exact: true });
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await sheet.getByRole('radio', { name: 'Tops', exact: true }).click();
  await shirtType.click();
  await sheet.getByRole('radio', { name: 'Blue', exact: true }).click();
  await sheet.getByRole('button', { name: 'Apply filters' }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Blue shirt');

  // Keyboard only: Tab enters the sheet's first chip, then walks to each
  // group's chosen chip, and the arrow keys move to the group's clear chip.
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.keyboard.press('Tab');
  await expect(
    sheet.getByRole('radio', { name: 'Tops', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    sheet.getByRole('radio', { name: 'Blue', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(shirtType).toBeFocused();
  // The group offers what the closet holds: Clear, T-shirt, Shirt.
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft');
  await expect(types.getByRole('radio', { name: '× Clear' })).toBeChecked();
  await sheet.getByRole('button', { name: 'Apply filters' }).click();
  // The type alone is cleared: both blue tops stay, the red one is out.
  await expect(tiles).toHaveCount(2);
  await expect(page.locator('#wardrobe-grid')).not.toContainText('Red shirt');

  // A sheet keeps the keyboard (layout/sheet.tsx, #1062): Tab cycles inside
  // it however far it goes, Escape closes it and focus is back on the
  // control that opened it (confirm-sheet.js's openSheet).
  const opener = page.getByRole('button', { name: 'Filters', exact: true });
  await opener.click();
  await expect(sheet).toBeVisible();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('#filter-modal') !== null,
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();

  // A keyword typed and not yet searched rides along with the sheet's
  // Apply: the page has one keyword field, the scope row's (#1067).
  await page.getByRole('search').locator('label').click();
  await page.getByRole('textbox', { name: 'Search' }).fill('shirt');
  await opener.click();
  await sheet.getByRole('radio', { name: 'Red', exact: true }).click();
  await sheet.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/[?&]keyword=shirt\b/);
  await expect(page).toHaveURL(/[?&]color=red\b/);
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Red shirt');

  await checkDockedFilters(page);
}

/**
 * The same filter sheet at a desktop's width (#1067): docked as the facet
 * column left of the grid, shown without opening anything (no opener), a
 * change applied with focus kept on Apply (htmx refocuses it by id in the
 * facets the answer brings), Back landing on facets that show its URL's
 * filters, and `/` focusing the search.
 */
async function checkDockedFilters(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/wardrobe');
  const tiles = page.locator('[data-tile]');
  await expect(tiles).toHaveCount(4);
  const facets = page.getByRole('dialog', { name: 'Filters' });
  await expect(facets).toBeVisible();
  await expect(facets).not.toHaveAttribute('open');
  await expect(
    page.getByRole('button', { name: 'Filters', exact: true }),
  ).toBeHidden();
  const facetsBox = (await facets.boundingBox())!;
  const gridBox = (await page.locator('#wardrobe-grid').boundingBox())!;
  expect(facetsBox.x + facetsBox.width).toBeLessThanOrEqual(gridBox.x);

  await facets.getByRole('radio', { name: 'Red', exact: true }).click();
  const apply = facets.getByRole('button', { name: 'Apply filters' });
  await apply.click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Red shirt');
  await expect(apply).toBeFocused();
  const red = facets.getByRole('radio', { name: 'Red', exact: true });
  await expect(red).toBeChecked();

  // A second filter, then Back: the facets are the snapshot's markup, so
  // they must hold the first URL's filters in their attributes, not
  // whatever the form held when it was left.
  const colors = facets.getByRole('group', { name: 'Color' });
  const categories = facets.getByRole('group', { name: 'Category' });
  const tops = categories.getByRole('radio', { name: 'Tops', exact: true });
  await tops.click();
  await apply.click();
  await expect(page).toHaveURL(/[?&]category=tops\b/);
  await expect(categories.getByRole('radio', { name: '× Clear' })).toHaveCount(
    1,
  );
  await page.goBack();
  await expect(page).not.toHaveURL(/category=/);
  await expect(page).toHaveURL(/[?&]color=red\b/);
  await expect(red).toBeChecked();
  await expect(tops).not.toBeChecked();
  await expect(colors.getByRole('radio', { name: '× Clear' })).toHaveCount(1);
  await expect(categories.getByRole('radio', { name: '× Clear' })).toHaveCount(
    0,
  );

  // `/` from anywhere but a field focuses the search.
  await page.keyboard.press('/');
  const search = page
    .getByRole('search')
    .getByRole('textbox', { name: 'Search' });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
}
