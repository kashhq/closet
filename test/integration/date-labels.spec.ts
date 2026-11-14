import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  garmentWear,
  outfit,
  outfitCalendar,
} from '../../src/db/schema';
import { addDays, type IsoDate } from '../../src/calendar-date';
import { dateLabel } from '../../src/web/date-labels';
import { createGarment } from './garments';
import {
  createTestApp,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';

/**
 * Every date a user reads is a word, never `2026-08-14` (#356): the pages
 * that once printed one (Insights' last worn, the garment page's acquired
 * date) and the ones that head days (the calendar week, a trip), with dates
 * old enough to fall past "N days ago" and into another year.
 */

/** The page's text: no scripts or styles, no tags and so no attributes. */
function visibleText(html: string): string {
  return unescapeHtml(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

describe('date labels', () => {
  let t: TestApp;
  let garmentId: number;
  let tripId: number;
  const daysAgo = (days: number): IsoDate => addDays(t.today(), -days);

  const text = async (url: string) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode, url).toBe(200);
    return visibleText(res.body);
  };

  beforeAll(async () => {
    t = await createTestApp();
    const ownerId = t.owner.id;
    const { cookie } = t.owner;
    garmentId = await createGarment(t, { name: 'Old coat', cookie });
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ acquiredOn: daysAgo(500), lastWashedOn: daysAgo(20) })
        .where(eq(garment.id, garmentId)),
    );
    // Worn long ago (Insights' least worn and not-worn-for lists) and this
    // week on the calendar.
    await asFixture(t.db, (tx) =>
      tx.insert(garmentWear).values({ garmentId, ownerId, day: daysAgo(400) }),
    );
    const [made] = await asFixture(t.db, (tx) =>
      tx
        .insert(outfit)
        .values({ shareableId: randomUUID(), ownerId, name: 'Coat day' })
        .returning({ id: outfit.id }),
    );
    await asFixture(t.db, (tx) =>
      tx
        .insert(outfitCalendar)
        .values({ ownerId, outfitId: made.id, day: t.today() }),
    );
    const res = await t.inject({
      method: 'POST',
      url: '/trips',
      payload: {
        name: 'Away',
        startsOn: t.today(),
        endsOn: addDays(t.today(), 2),
      },
    });
    expect(res.statusCode).toBe(303);
    tripId = Number(/^\/trips\/(\d+)/.exec(String(res.headers.location))![1]);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it.each([
    ['Insights', () => '/wardrobe/insights'],
    ['Insights, not worn for a year', () => '/wardrobe/insights?unworn=365'],
    ['the garment page', () => `/wardrobe/${garmentId}`],
    ['the calendar week', () => '/calendar'],
    ['the trip page', () => `/trips/${tripId}`],
  ])('%s shows no ISO date', async (_, url) => {
    const shown = await text(url());
    expect(shown.match(ISO_DATE)).toBeNull();
  });

  it('the error page shows no timestamp, only the way on', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/999999' });
    expect(res.statusCode).toBe(404);
    const shown = visibleText(res.body);
    expect(shown.match(ISO_DATE)).toBeNull();
    expect(shown).toContain('Open Wardrobe');
  });

  it('an old date reads as a date with its year: last worn, acquired, washed', async () => {
    expect(await text('/wardrobe/insights')).toContain(
      `Last worn ${dateLabel(daysAgo(400), t.today())}`,
    );
    expect(await text(`/wardrobe/${garmentId}`)).toContain(
      dateLabel(daysAgo(500), t.today()),
    );
    // The garment page's are worded by its script (src/page-day.ts, #708);
    // before it runs, the date with its year.
    const garmentPage = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}`,
    });
    expect(garmentPage.body).toContain(
      `<time datetime="${daysAgo(20)}" data-day-label="relative">`,
    );
    expect(dateLabel(daysAgo(500), t.today())).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,
    );
  });
});
