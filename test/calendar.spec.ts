import { expect, test } from './support/fixtures';
import {
  addPhotographedGarment,
  createGarment,
  createOutfit,
  createOutfitOf,
} from './support/e2e-data';
import { expectCollagePiecesInsidePlinths } from './support/collage-fit';
import { E2E_PASSWORD, SAME_ORIGIN, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { addDays } from '../src/calendar-date';
import { pageErrors } from './support/page-errors';
import { OUTFIT_PAGE_SIZE as PAGE_SIZE } from '../src/web/outfits/page-size';

/**
 * Planning an outfit on the calendar from its page: the plan sheet (htmx,
 * an inline handler for the occasion) posts and the app lands on that week;
 * then "Plan my week", after which Saved still opens on the person's outfit
 * (#659) and the planner's are one tab away; a layered outfit's collage
 * stays inside its cell (#663); and Saved loads its next page as it is
 * scrolled (#660).
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
  // The day starts at today, set by the page's script (#708: the page
  // names no today, so it keeps its ETag across days).
  const day = sheet.locator('input[name="date"]');
  await expect(day).toHaveValue(householdToday());
  await day.fill('2030-10-10');
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
  await page.getByRole('link', { name: 'Worn and planned' }).click();
  await expect(page).toHaveURL(/show=one-offs/);
  await expect(tiles.first()).toBeVisible();
  await expect(tiles.first()).not.toContainText('Sheet outfit');

  // #663: a layer over a top in the plan's cells never spills out of the
  // plinth: the month's 48 px cells and the week's rows at 390 px, the
  // week's columns and the month's desktop step (#1064) at 1280 px.
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
  await expect(page.locator('[data-collage="month"] img')).toHaveCount(1);
  await expectCollagePiecesInsidePlinths(page);
  await page.goto('/calendar?week=2030-10-10');
  await expect(page.locator('[data-collage="cell"] img')).toHaveCount(1);
  await expectCollagePiecesInsidePlinths(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectCollagePiecesInsidePlinths(page);
  await page.goto('/calendar/month?month=2030-10');
  await expectCollagePiecesInsidePlinths(page);

  // #1070: from lg a month cell's date, chip, dot and "+N" are a column
  // beside the collage; a forecast day with no outfit keeps its chip under
  // the date, where a planned day has it, not in the collage's column.
  const home = await page.request.post('/weather/home', {
    form: { name: 'Brooklyn', latitude: '40.69', longitude: '-73.97' },
    headers: SAME_ORIGIN,
  });
  expect(home.ok()).toBe(true);
  const planned = addDays(householdToday(), 1);
  const empty = addDays(planned, 1);
  const plan = await page.request.post('/calendar', {
    form: { date: planned, outfitId: `${layered}` },
    headers: SAME_ORIGIN,
  });
  expect(plan.ok()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  // What the chip looked like in the task that inserted it, before htmx's
  // settle: a MutationObserver's callback runs in that task, ahead of the
  // settle delay's timer. The chip used to arrive in its slot's classes and
  // take its own only after the delay, so a measure between the two found
  // the date column at the wrong width.
  await page.addInitScript(() => {
    const arrivals: Record<
      string,
      { date: number; chip: number; width: number }
    > = {};
    const settled: Record<string, boolean> = {};
    Object.assign(window, { chipArrivals: arrivals, chipSettled: settled });
    const centre = (box: DOMRect) => box.x + box.width / 2;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          // The chip may arrive itself or inside an inserted wrapper.
          const chipNode = node.matches('[data-weather-day]')
            ? node
            : node.querySelector<HTMLElement>('[data-weather-day]');
          const day = chipNode?.dataset.weatherDay;
          if (!chipNode || !day) continue;
          const date = chipNode
            .closest('[data-month-day]')
            ?.querySelector('span');
          if (!date) continue;
          const chip = chipNode.getBoundingClientRect();
          arrivals[day] = {
            date: centre(date.getBoundingClientRect()),
            chip: centre(chip),
            width: chip.width,
          };
        }
      }
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener('htmx:afterSettle', (event) => {
      const day = (event.target as HTMLElement).dataset?.weatherDay;
      if (day) settled[day] = true;
    });
  });
  const chipPlace = async (day: string) => {
    await page.goto(`/calendar/month?month=${day.slice(0, 7)}`);
    const cell = page.locator(`[data-month-day="${day}"]`);
    const chip = cell.locator(`[data-weather-day="${day}"]`);
    await expect(chip).toBeVisible();
    await page.waitForFunction(
      (d) =>
        (window as unknown as { chipSettled: Record<string, boolean> })
          .chipSettled[d],
      day,
    );
    const date = (await cell.locator('span').first().boundingBox())!;
    const box = (await chip.boundingBox())!;
    const arrived = await page.evaluate(
      (d) =>
        (
          window as unknown as {
            chipArrivals: Record<
              string,
              { date: number; chip: number; width: number }
            >;
          }
        ).chipArrivals[d],
      day,
    );
    expect(
      arrived,
      `the chip for ${day} was never seen arriving: it came in the first HTML or outside a month cell`,
    ).toBeDefined();
    const dateCentre = date.x + date.width / 2;
    const chipCentre = box.x + box.width / 2;
    // Centred under the date: the chip's width follows its temperature. And
    // drawn so from its first frame: the settle moves neither.
    return {
      below: box.y >= date.y + date.height - 1,
      centred: Math.abs(chipCentre - dateCentre) <= 1,
      settleMoved:
        Math.abs(arrived.width - box.width) > 0.5 ||
        Math.abs(arrived.chip - chipCentre) > 0.5 ||
        Math.abs(arrived.date - dateCentre) > 0.5,
    };
  };
  const underDate = { below: true, centred: true, settleMoved: false };
  expect(await chipPlace(planned)).toEqual(underDate);
  expect(await chipPlace(empty)).toEqual(underDate);

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

  // #660: Saved loads a page at a time; scrolled to its end at 390 px, the
  // sentinel brings the rest (Layered and these 31: one page and two).
  for (let n = 0; n < PAGE_SIZE + 1; n += 1) {
    const top = await createGarment(page, `Page tee ${n}`, 'tops');
    await createOutfit(page, `Page outfit ${n}`, top);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/outfits');
  const savedTiles = page.locator('#saved-outfits a[data-outfit-id]');
  await expect(savedTiles).toHaveCount(PAGE_SIZE);
  await page.locator('[data-saved-more]').scrollIntoViewIfNeeded();
  await expect(savedTiles).toHaveCount(PAGE_SIZE + 2);
  await expect(page.locator('[data-saved-more]')).toHaveCount(0);
  await expect(savedTiles.last()).toContainText('Layered');
  expect(errors).toEqual([]);
});
