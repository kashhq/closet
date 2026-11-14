import { expect, test } from './support/fixtures';
import {
  addPhotographedGarment,
  createGarment,
  createOutfitOf,
} from './support/e2e-data';
import { expectCollagePiecesInsidePlinths } from './support/collage-fit';
import { E2E_PASSWORD, SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * Planning an outfit on the calendar from its page: the plan sheet (htmx,
 * an inline handler for the occasion) posts and the app lands on that week;
 * then "Plan my week", after which Saved still opens on the person's outfit
 * (#659) and the planner's are one tab away; a layered outfit's collage
 * stays inside its cell (#663).
 * The calendar's own behaviour is test/integration/calendar.spec.ts.
 */

test('the outfit page plans the outfit from its sheet and lands on that week; Plan my week leaves Saved to the person', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'client-plan-sheet');
  const garment = await createGarment(page, 'Sheet tee', 'tops');
  const res = await page.request.post('/outfits', {
    form: { name: 'Sheet outfit', category: 'tops', garmentId: `${garment}` },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  const outfitUrl = res.url();
  await page.goto(outfitUrl);

  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const sheet = page.locator('#outfit-plan-sheet');
  await expect(sheet).toBeVisible();
  await sheet.locator('input[name="date"]').fill('2030-10-10');
  await sheet.getByRole('radio', { name: 'Evening' }).check();
  await sheet.getByRole('button', { name: 'Plan it' }).click();

  await expect(page).toHaveURL(/\/calendar\?week=2030-10-10/);
  await expect(page.getByText('Sheet outfit').first()).toBeVisible();

  // #659: "Plan my week" fills the week with one-offs, and Saved still
  // opens on the outfit the person made; the planner's sit behind
  // "Worn and planned".
  await createGarment(page, 'Sheet jeans', 'bottoms');
  const week = Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((day) => [`day-${day}`, 'all-day']),
  );
  const template = await page.request.post('/auth/profile/week', {
    form: week,
    headers: SAME_ORIGIN,
  });
  expect(template.ok()).toBe(true);
  // #683: at phone width the tap lands on the day the plan starts, which is
  // in view, and the banner's rows are links to their days.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Plan my week' }).click();
  await expect(page).toHaveURL(/\/calendar\?.*#day-\d{4}-\d\d-\d\d$/);
  const firstDay = new URL(page.url()).hash;
  await expect(page.locator(firstDay)).toBeInViewport();
  await expect(
    page.locator('[data-planned-entries] a[href^="#day-"]').first(),
  ).toBeAttached();
  await page.goto('/outfits');
  const tiles = page.locator('#saved-outfits li');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Sheet outfit');
  await page.getByRole('tab', { name: 'Worn and planned' }).click();
  await expect(page).toHaveURL(/show=one-offs/);
  await expect(tiles.first()).toBeVisible();
  await expect(tiles.first()).not.toContainText('Sheet outfit');

  // #663: a layer over a top in the plan's cells never spills out of the
  // plinth: the month's 48 px cells and the week's rows at 390 px, the
  // week's columns at 1280 px.
  const coat = await addPhotographedGarment(page, 'Fit coat', 'outerwear');
  // The top has no photo: its hanger placeholder must fit the cell too.
  const tee = await createGarment(page, 'Fit tee', 'tops');
  const layered = await createOutfitOf(
    page,
    'Layered',
    [
      { id: coat, category: 'outerwear' },
      { id: tee, category: 'tops' },
    ],
    '2030-10-11',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/calendar/month?month=2030-10');
  await expect(page.locator('[data-collage="cell"] img')).toHaveCount(1);
  await expectCollagePiecesInsidePlinths(page);
  await page.goto('/calendar?week=2030-10-10');
  await expect(page.locator('[data-collage="cell"] img')).toHaveCount(1);
  await expectCollagePiecesInsidePlinths(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectCollagePiecesInsidePlinths(page);

  // #822: an agent's entry wears its token's name as a badge, and a long
  // name stays inside the row at phone width.
  const tokenName = 'Laptop Claude on the long walk home';
  const minted = await page.request.post('/auth/tokens', {
    // "Can make changes": a token is read-only unless ticked (#701).
    data: { name: tokenName, currentPassword: E2E_PASSWORD, writes: 'on' },
    headers: SAME_ORIGIN,
  });
  expect(minted.ok()).toBe(true);
  const agentToken = /closet_[A-Za-z0-9_-]{43}/.exec(await minted.text())?.[0];
  expect(agentToken).toBeDefined();
  const scheduled = await page.request.post('/mcp', {
    headers: {
      authorization: `Bearer ${agentToken}`,
      accept: 'application/json, text/event-stream',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'schedule_outfit',
        arguments: { outfitId: layered, date: '2030-10-12' },
      },
    },
  });
  expect(scheduled.ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/calendar?week=2030-10-10');
  const badge = page.locator('[data-occasion] [data-agent]');
  await expect(badge).toHaveCount(1);
  await expect(badge).toBeVisible();
  const row = page.locator('[data-occasion]:has([data-agent])');
  const overflow = await row.evaluate((el) => ({
    row: el.scrollWidth - el.clientWidth,
    page: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow).toEqual({ row: 0, page: 0 });

  // #686: removing an entry acts at once and Undo, in the toast, puts it
  // back; deleting an outfit asks in the app's own sheet (pageErrors fails
  // any native dialog), which Cancel and Escape leave alone and the
  // keyboard can reach.
  const sheetRow = page.locator('[data-occasion]', {
    hasText: 'Sheet outfit',
  });
  await sheetRow.getByText('Change', { exact: true }).click();
  await sheetRow.getByRole('button', { name: 'Remove from calendar' }).click();
  await expect(sheetRow).toHaveCount(0);
  const status = page.locator('#toast-host');
  await expect(status).toContainText('Removed from the calendar');
  await status.getByRole('button', { name: 'Undo' }).click();
  await expect(sheetRow).toHaveCount(1);
  await expect(status).toContainText('Put back on the calendar');

  // #891: a page drawn before the entry was worn (in another request) sent
  // its Remove without asking; the server's 409 opens the sheet and that is
  // all the person sees (no failure toast), and its yes deletes.
  const savedOutfitId = /\/outfits\/(\d+)/.exec(outfitUrl)?.[1];
  expect(savedOutfitId).toBeDefined();
  const past = await page.request.post('/calendar', {
    form: { outfitId: `${savedOutfitId}`, date: '2020-10-07' },
    headers: SAME_ORIGIN,
  });
  expect(past.ok()).toBe(true);
  await page.goto('/calendar?week=2020-10-07');
  const staleRow = page.locator('[data-occasion]');
  const staleId = await staleRow
    .locator('[data-remove-entry]')
    .getAttribute('data-remove-entry');
  const worn = await page.request.post(`/calendar/${staleId}/worn`, {
    form: { week: '2020-10-07', worn: '1' },
    headers: SAME_ORIGIN,
  });
  expect(worn.ok()).toBe(true);
  const staleSheet = page.locator('#confirm-sheet');
  await staleRow.getByText('Change', { exact: true }).click();
  await staleRow.getByRole('button', { name: 'Remove from calendar' }).click();
  await expect(staleSheet).toBeVisible();
  await expect(staleSheet).toContainText('Remove this scheduled outfit?');
  await expect(status).not.toContainText('That did not go through');
  await staleSheet.locator('[data-confirm-accept]').click();
  await expect(staleRow).toHaveCount(0);
  // The 409 is the browser's and htmx's own console line, expected here.
  expect(errors.splice(0)).toEqual([
    expect.stringContaining('409'),
    expect.stringContaining(`/calendar/${staleId}/delete`),
  ]);

  await page.goto(outfitUrl);
  const menu = page.locator('summary', { hasText: '⋯' });
  const confirmSheet = page.locator('#confirm-sheet');
  await menu.click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirmSheet).toBeVisible();
  await expect(confirmSheet).toContainText(
    'Are you sure you want to delete this?',
  );
  await expect(
    confirmSheet.getByRole('button', { name: 'Cancel' }).first(),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmSheet).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Delete', exact: true }),
  ).toBeFocused();
  await expect(page).toHaveURL(outfitUrl);

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmSheet
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page).toHaveURL(/\/outfits(\?|$)/);
  expect(errors).toEqual([]);
});
