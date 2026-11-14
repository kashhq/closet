import { type Page } from '@playwright/test';
import { expect } from './support/fixtures';
import sharp from 'sharp';
import { test } from './support/cutout-hold';
import { createGarment } from './support/e2e-data';
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
 * same width.
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
}

/**
 * The filter sheet (#674): blue shirts in five taps, and by keyboard one
 * choice cleared alone. Run at the end of the scenario above (the closet
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
}
