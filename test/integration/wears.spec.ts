import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, garmentWear, outfitCalendar } from '../../src/db/schema';
import {
  type AwayReason,
  isAvailable,
  washLimit,
  wearsSinceWash,
} from '../../src/wardrobe/availability';
import type { Occasion } from '../../src/wardrobe/occasions';
import type { GarmentStatus } from '../../src/wardrobe/status';
import { addDays, type IsoDate } from '../../src/calendar-date';
import {
  availableGarment,
  dirtyCopiesSql,
  wearsSinceWashSql,
} from '../../src/web/wears/queries';
import { WASH_CASES, washCaseRows } from '../support/wash-cases';
import { t as text } from '../../src/web/i18n';
import { createGarment } from './garments';
import {
  createTestApp,
  hasText,
  shownMarkup,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
  TEST_PASSWORD,
} from './harness';
import {
  expectFragment,
  expectFullPage,
  expectInPlaceWritesKeepFocus,
  expectStatusMessage,
} from './pages';

/**
 * Wears and washes (#7, plan section 1): the wear log that outfit edits
 * cannot rewrite, counted by distinct day; Wore today; Washed and the
 * laundry page; multiples; away; and the "available" rule, in SQL and in
 * TypeScript, agreeing. The owner's own records throughout: a grantee sees
 * none of it (the refusals are in authorization-wardrobe.spec.ts).
 */

/** The wear line's day, which the page's script words (src/web/day-time.tsx). */
const lastWornOn = (day: string) =>
  `last worn <time datetime="${day}" data-day-label="relative">`;

const form = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
};

describe('wears and washes', () => {
  let t: TestApp;
  const today = () => t.today();
  const daysAgo = (days: number) => addDays(today(), -days);

  /** POST /wardrobe with the care fields; the new garment's id. */
  const newGarment = async (
    name: string,
    category: string,
    care: { quantity?: number; washAfterWears?: string } = {},
    cookie?: string,
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({
        name,
        category,
        care: '1',
        quantity: String(care.quantity ?? 1),
        washAfterWears: care.washAfterWears ?? '',
      }),
      ...(cookie && {
        headers: {
          ...form({}).headers,
          cookie,
        },
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  /** POST /outfits with one slot per garment; the outfit's id. */
  const newOutfit = async (name: string, garmentIds: number[]) => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...form({
        name,
        category: garmentIds.map(() => 'tops'),
        garmentId: garmentIds.map(String),
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  const editOutfit = async (outfitId: number, garmentIds: number[]) => {
    const res = await t.inject({
      method: 'POST',
      url: `/outfits/${outfitId}`,
      ...form({
        category: garmentIds.map(() => 'tops'),
        garmentId: garmentIds.map(String),
      }),
    });
    expect(res.statusCode).toBe(302);
  };

  /** Plans the outfit on `day` (all day unless said) and returns the entry's id. */
  const schedule = async (
    outfitId: number,
    day: IsoDate,
    occasion?: Occasion,
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({
        outfitId: String(outfitId),
        date: day,
        ...(occasion && { occasion }),
      }),
    });
    expect(res.statusCode).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
      );
    return entry.id;
  };

  const markWorn = async (entryId: number, worn: '1' | '0' = '1') => {
    const res = await t.inject({
      method: 'POST',
      url: `/calendar/${entryId}/worn`,
      ...form({ worn }),
    });
    expect(res.statusCode).toBe(303);
  };

  /** A garment's wear rows as (day, entry) pairs, oldest first. */
  const wearsOf = async (garmentId: number) =>
    t.db
      .select({ day: garmentWear.day, entry: garmentWear.outfitCalendarId })
      .from(garmentWear)
      .where(eq(garmentWear.garmentId, garmentId))
      .orderBy(asc(garmentWear.day), asc(garmentWear.id));

  const garmentPage = async (id: number, cookie?: string, query = '') => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${id}${query}`,
      ...(cookie && { headers: { cookie } }),
    });
    expect(res.statusCode).toBe(200);
    return res;
  };

  const post = (
    url: string,
    fields: Record<string, string> = {},
    htmx = true,
  ) =>
    t.inject({
      method: 'POST',
      url,
      ...form(fields),
      headers: {
        ...form({}).headers,
        ...(htmx ? { 'hx-request': 'true' } : {}),
      },
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('the calendar entry’s wears', () => {
    it('snapshots the outfit’s garments when the entry is marked worn; an outfit edit never changes them', async () => {
      const tee = await newGarment('Snapshot tee', 'tops');
      const shirt = await newGarment('Snapshot shirt', 'tops');
      const other = await newGarment('Swapped-in tee', 'tops');
      const outfit = await newOutfit('Snapshot', [tee, shirt]);
      const entry = await schedule(outfit, daysAgo(3));

      await markWorn(entry);
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(3), entry }]);
      expect(await wearsOf(shirt)).toEqual([{ day: daysAgo(3), entry }]);

      // Swap the shirt out: March's wears stay with the shirt.
      await editOutfit(outfit, [tee, other]);
      expect(await wearsOf(shirt)).toEqual([{ day: daysAgo(3), entry }]);
      expect(await wearsOf(other)).toEqual([]);
      expect(hasText((await garmentPage(shirt)).body, 'Worn once')).toBe(true);
      expect(hasText((await garmentPage(other)).body, 'Not worn yet')).toBe(
        true,
      );
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Calendar entry ${entry} marked worn by user \\d+ \\(2 wears logged\\)$`,
          ),
        ),
      );
    });

    it('unmarking removes exactly that entry’s wears', async () => {
      const tee = await newGarment('Unmark tee', 'tops');
      const outfit = await newOutfit('Unmark', [tee]);
      const kept = await schedule(outfit, daysAgo(5));
      const undone = await schedule(outfit, daysAgo(4));
      await markWorn(kept);
      await markWorn(undone);
      expect(await wearsOf(tee)).toHaveLength(2);

      await markWorn(undone, '0');
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(5), entry: kept }]);
    });

    it('deleting an entry removes exactly its wears', async () => {
      const tee = await newGarment('Delete tee', 'tops');
      const outfit = await newOutfit('Delete', [tee]);
      const kept = await schedule(outfit, daysAgo(6));
      const deleted = await schedule(outfit, daysAgo(2));
      await markWorn(kept);
      await markWorn(deleted);

      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${deleted}/delete`,
      });
      expect(res.statusCode).toBe(303);
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(6), entry: kept }]);
    });

    it('counts two entries on one day with the same garment as one wear', async () => {
      const tee = await newGarment('Twice tee', 'tops');
      const morning = await newOutfit('Morning', [tee]);
      // Not the tee alone again: that would be the same outfit (#219).
      const scarf = await newGarment('Evening scarf', 'accessories');
      const evening = await newOutfit('Evening', [tee, scarf]);
      await markWorn(await schedule(morning, daysAgo(1)));
      await markWorn(await schedule(evening, daysAgo(1)));

      expect(await wearsOf(tee)).toHaveLength(2);
      const page = await garmentPage(tee);
      expect(hasText(page.body, 'Worn once')).toBe(true);
      // Worded by the page's script (src/page-day.ts, #708).
      expect(page.body).toContain(lastWornOn(daysAgo(1)));
    });

    // #13: several outfits a day, each for an occasion. Wears still count
    // days: each entry keeps its own rows (so unmarking one takes exactly
    // them), and the counts and the wash rules count the day once.
    it('office then dinner, same shoes: one wear', async () => {
      const shoes = await newGarment('Loafers', 'footwear');
      const tees = await newGarment('Day and night tees', 'tops', {
        quantity: 2,
      });
      const oxford = await newGarment('Office oxford', 'tops');
      const office = await newOutfit('Office', [oxford, tees, shoes]);
      const dinner = await newOutfit('Dinner', [tees, shoes]);
      const work = await schedule(office, daysAgo(1), 'work');
      const evening = await schedule(dinner, daysAgo(1), 'evening');
      await markWorn(work);
      await markWorn(evening);

      // One row per entry and garment, one wear by the count.
      expect(await wearsOf(shoes)).toEqual([
        { day: daysAgo(1), entry: work },
        { day: daysAgo(1), entry: evening },
      ]);
      expect(hasText((await garmentPage(shoes)).body, 'Worn once')).toBe(true);
      // Two copies at one wear each: one day dirties one copy, not both.
      // Raw SQL, never a single-table Drizzle select: that writes the rule's
      // columns unqualified, and its `id` reads garment_wear's (src/db/AGENTS.md).
      const dirty = async () =>
        (
          await t.db.execute<{ dirty: number }>(
            sql`select ${dirtyCopiesSql()} as dirty from ${garment} where ${eq(garment.id, tees)}`,
          )
        ).rows[0].dirty;
      expect(await dirty()).toBe(1);
      expect(
        hasText((await garmentPage(tees)).body, '1 of 2 need a wash'),
      ).toBe(true);

      // Unmarking the office outfit leaves the dinner's wear: still once.
      await markWorn(work, '0');
      expect(await wearsOf(shoes)).toEqual([
        { day: daysAgo(1), entry: evening },
      ]);
      expect(hasText((await garmentPage(shoes)).body, 'Worn once')).toBe(true);
      expect(await dirty()).toBe(1);
      await markWorn(evening, '0');
      expect(await wearsOf(shoes)).toEqual([]);
      expect(await dirty()).toBe(0);
    });

    it('counts a garment held in two slots of one outfit once', async () => {
      const tee = await newGarment('Two-slot tee', 'tops');
      const outfit = await newOutfit('Two slots', [tee, tee]);
      await markWorn(await schedule(outfit, daysAgo(2)));
      expect(await wearsOf(tee)).toHaveLength(1);
    });
  });

  describe('deleting an outfit', () => {
    const deleteOutfit = async (outfitId: number) => {
      const res = await t.inject({
        method: 'DELETE',
        url: `/outfits/${outfitId}`,
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
    };

    it('keeps the days it was worn as day-level wears, with the counts and last worn', async () => {
      const tee = await newGarment('Deleted-outfit tee', 'tops');
      const outfit = await newOutfit('Short-lived', [tee]);
      await markWorn(await schedule(outfit, daysAgo(9)));
      await markWorn(await schedule(outfit, daysAgo(4)));
      const before = unescapeHtml((await garmentPage(tee)).body);
      expect(hasText(before, 'Worn 2 times')).toBe(true);
      expect(before).toContain(lastWornOn(daysAgo(4)));

      await deleteOutfit(outfit);

      expect(await wearsOf(tee)).toEqual([
        { day: daysAgo(9), entry: null },
        { day: daysAgo(4), entry: null },
      ]);
      const after = unescapeHtml((await garmentPage(tee)).body);
      expect(hasText(after, 'Worn 2 times')).toBe(true);
      expect(after).toContain(lastWornOn(daysAgo(4)));
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Outfit ${outfit} deleted by user \\d+ \\(2 wears kept as day-level wears\\)$`,
          ),
        ),
      );
    });

    it('keeps one wear where the garment was also logged alone that day', async () => {
      const tee = await newGarment('Both today tee', 'tops');
      await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      const outfit = await newOutfit('Today too', [tee]);
      await markWorn(await schedule(outfit, today()));
      expect(await wearsOf(tee)).toHaveLength(2);

      await deleteOutfit(outfit);

      expect(await wearsOf(tee)).toEqual([{ day: today(), entry: null }]);
    });

    it('keeps the wears of a garment taken out of the outfit before it was deleted', async () => {
      const shirt = await newGarment('Removed-then-deleted shirt', 'tops');
      const other = await newGarment('Stayed tee', 'tops');
      const outfit = await newOutfit('Edited, then deleted', [shirt, other]);
      await markWorn(await schedule(outfit, daysAgo(3)));
      await editOutfit(outfit, [other]);

      await deleteOutfit(outfit);

      expect(await wearsOf(shirt)).toEqual([{ day: daysAgo(3), entry: null }]);
      expect(await wearsOf(other)).toEqual([{ day: daysAgo(3), entry: null }]);
    });

    it('leaves an unworn outfit’s deletion as it was: no wears appear', async () => {
      const tee = await newGarment('Never worn tee', 'tops');
      const outfit = await newOutfit('Planned only', [tee]);
      await schedule(outfit, daysAgo(2));
      await deleteOutfit(outfit);
      expect(await wearsOf(tee)).toEqual([]);
    });

    it('never lets "Wore today"’s undo take a kept wear from another day', async () => {
      const tee = await newGarment('Kept history tee', 'tops');
      const outfit = await newOutfit('Gone', [tee]);
      await markWorn(await schedule(outfit, daysAgo(2)));
      await deleteOutfit(outfit);

      // The undo only ever deletes today's day-level wear.
      await post(`/wardrobe/${tee}/wear`, { worn: '0' });
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(2), entry: null }]);
    });
  });

  describe('Wore today', () => {
    it('logs one wear today, once however often it is tapped, and undoes it the same day', async () => {
      const tee = await newGarment('Today tee', 'tops');

      const first = await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      expectFragment(first);
      // The wear status, not the section: "where it is" is an autosave form
      // beside it, which no other answer may replace.
      expect(first.body).toContain('id="garment-wear-status"');
      expect(first.body).not.toContain('name="away"');
      expect(hasText(first.body, 'Worn once')).toBe(true);
      expect(hasText(first.body, 'Undo “Wore today”')).toBe(true);
      await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      expect(await wearsOf(tee)).toEqual([{ day: today(), entry: null }]);

      const undo = await post(`/wardrobe/${tee}/wear`, { worn: '0' });
      expect(hasText(undo.body, 'Not worn yet')).toBe(true);
      expect(await wearsOf(tee)).toEqual([]);
    });

    it('redirects a plain post back to the garment', async () => {
      const tee = await newGarment('Plain wear tee', 'tops');
      const res = await post(`/wardrobe/${tee}/wear`, { worn: '1' }, false);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/wardrobe/${tee}`);
    });

    it('says a worn calendar entry today wore it, instead of offering a second wear', async () => {
      const tee = await newGarment('Entry today tee', 'tops');
      await markWorn(await schedule(await newOutfit('Today', [tee]), today()));
      // The page names the day and how (#708): its script shows the
      // calendar's badge for Wore today on that day (wornState).
      const page = await garmentPage(tee);
      expect(page.body).toContain(
        `data-worn-on="${today()}" data-worn-by="entry"`,
      );
    });
  });

  // #679: each tap's control keeps one id across the swap (htmx refocuses
  // it), and the answer says what it did in the page's status region.
  describe('the result of a tap', () => {
    /** The opening tag of the element with this id, or undefined. */
    const tagOf = (html: string, id: string) =>
      new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0];

    it('Wore today and its undo keep one button and say what they did', async () => {
      const tee = await newGarment('Focus tee', 'tops');
      const id = `garment-${tee}-wore-today`;
      expect(tagOf((await garmentPage(tee)).body, id)).toBeDefined();

      const worn = await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      expectFragment(worn);
      expectInPlaceWritesKeepFocus(worn);
      expectStatusMessage(worn, text('wear.status.WORE_TODAY'));
      expect(tagOf(worn.body, id)).toBeDefined();
      expect(worn.body).not.toContain('autofocus');

      const undone = await post(`/wardrobe/${tee}/wear`, { worn: '0' });
      expectStatusMessage(undone, text('wear.status.WORE_TODAY_UNDONE'));
      expect(tagOf(undone.body, id)).toBeDefined();
    });

    it('Washed, gone once nothing is worn since, hands focus to the wear line', async () => {
      const tee = await newGarment('Focus wash tee', 'tops');
      await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      expect(
        tagOf((await garmentPage(tee)).body, `garment-${tee}-washed`),
      ).toBeDefined();

      const washed = await post(`/wardrobe/${tee}/washed`);
      expectStatusMessage(washed, text('wear.status.WASHED'));
      expect(washed.body).not.toContain(`id="garment-${tee}-washed"`);
      const line = tagOf(washed.body, 'garment-wear-status');
      expect(line).toContain('tabindex="-1"');
      expect(line).toContain('autofocus');
    });

    it('the calendar’s worn pill keeps one button across the row’s swap', async () => {
      const tee = await newGarment('Focus pill tee', 'tops');
      const entry = await schedule(await newOutfit('Pill', [tee]), today());
      const id = `entry-${entry}-worn`;
      const worn = await post(`/calendar/${entry}/worn`, { worn: '1' });
      expectFragment(worn);
      expectInPlaceWritesKeepFocus(worn);
      expectStatusMessage(worn, text('wear.status.WORN'));
      expect(tagOf(shownMarkup(worn.body), id)).toContain('type="submit"');

      const undone = await post(`/calendar/${entry}/worn`, { worn: '0' });
      expectStatusMessage(undone, text('wear.status.UNDO_WORN'));
      expect(tagOf(shownMarkup(undone.body), id)).toBeDefined();
    });

    it('Mark washed lands with the result to say and focus on the way on', async () => {
      const tee = await newGarment('Focus laundry tee', 'tops');
      await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      const before = await t.inject({ method: 'GET', url: '/laundry' });
      expect(tagOf(before.body, 'laundry-mark-washed')).not.toContain(
        'autofocus',
      );

      const after = await t.inject({ method: 'GET', url: '/laundry?washed=1' });
      expectFullPage(after);
      // The message, inert until public/js/toast.js says it.
      expect(after.body).toMatch(
        /<template id="laundry-toast" data-status-message="">1 washed<\/template>/,
      );
      expect(tagOf(after.body, 'laundry-mark-washed')).toContain('autofocus');
    });
  });

  describe('washing', () => {
    it('Washed resets the wears since the wash; a wear on the wash day counts before it', async () => {
      const jeans = await newGarment('Wash jeans', 'bottoms');
      const outfit = await newOutfit('Jeans days', [jeans]);
      for (const days of [3, 2, 1]) {
        await markWorn(await schedule(outfit, daysAgo(days)));
      }
      await post(`/wardrobe/${jeans}/wear`, { worn: '1' });
      // Bottoms: 3 wears a wash. Four days: dirty.
      let page = unescapeHtml((await garmentPage(jeans)).body);
      expect(hasText(page, 'Worn 4 times · 4 since washed')).toBe(true);
      expect(hasText(page, 'Needs a wash')).toBe(true);

      const washed = await post(`/wardrobe/${jeans}/washed`);
      expectFragment(washed);
      const [row] = await t.db
        .select({ lastWashedOn: garment.lastWashedOn })
        .from(garment)
        .where(eq(garment.id, jeans));
      expect(row.lastWashedOn).toBe(today());
      page = unescapeHtml(washed.body);
      // Today's wear was before the wash: nothing since.
      expect(hasText(page, 'Worn 4 times · 0 since washed')).toBe(true);
      expect(hasText(page, 'Needs a wash')).toBe(false);
      // A live answer names its day for the page's script (#708).
      expect(page).toContain(`data-as-of-day="${today()}"`);
      expect(page).toContain(
        `Last washed <time datetime="${today()}" data-day-label="relative">`,
      );
    });

    it('counts copies: three tees are three wears, "1 of 3 need a wash" until the last', async () => {
      const tees = await newGarment('Three tees', 'tops', { quantity: 3 });
      const outfit = await newOutfit('Tee days', [tees]);
      await markWorn(await schedule(outfit, daysAgo(3)));

      const laundry = await t.inject({ method: 'GET', url: '/laundry' });
      expectFullPage(laundry);
      expect(hasText(laundry.body, '1 of 3 need a wash')).toBe(true);
      const grid = await t.inject({
        method: 'GET',
        url: '/wardrobe?needsWash=true',
      });
      expect(grid.body).toContain('Three tees');
      expect(hasText(grid.body, '×3')).toBe(true);
      expect(grid.body).toContain('data-mark="needs-wash"');
      expect(hasText(grid.body, 'Wash 1/3')).toBe(true);

      await markWorn(await schedule(outfit, daysAgo(2)));
      await markWorn(await schedule(outfit, daysAgo(1)));
      const page = await garmentPage(tees);
      expect(hasText(page.body, '3 of 3 need a wash')).toBe(true);
    });

    it('lists the hamper on /laundry and washes the checked ones, the user’s own only', async () => {
      const shirt = await newGarment('Hamper shirt', 'tops');
      const chinos = await newGarment('Hamper chinos', 'bottoms');
      const shoes = await newGarment('Hamper shoes', 'footwear');
      const outfit = await newOutfit('Hamper', [shirt, chinos, shoes]);
      await markWorn(await schedule(outfit, daysAgo(1)));

      const page = unescapeHtml(
        (await t.inject({ method: 'GET', url: '/laundry' })).body,
      );
      // The shirt is due (checked), the chinos worn but not due (unchecked);
      // shoes are never laundered.
      expect(page).toMatch(
        new RegExp(`name="ids" value="${shirt}" checked=""`),
      );
      expect(page).toContain(`name="ids" value="${chinos}"`);
      expect(page).not.toMatch(
        new RegExp(`name="ids" value="${chinos}" checked`),
      );
      expect(page).not.toContain('Hamper shoes');

      const stranger = await t.register('laundry-stranger@example.com');
      const theirs = await newGarment('Not yours', 'tops', {}, stranger);
      const res = await t.inject({
        method: 'POST',
        url: '/laundry',
        ...form({ ids: [String(shirt), String(theirs)] }),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/laundry?washed=1');
      const washed = await t.db
        .select({ id: garment.id, lastWashedOn: garment.lastWashedOn })
        .from(garment)
        .where(sql`${garment.id} in (${shirt}, ${chinos}, ${theirs})`)
        .orderBy(garment.id);
      expect(washed).toEqual([
        { id: shirt, lastWashedOn: today() },
        { id: chinos, lastWashedOn: null },
        { id: theirs, lastWashedOn: null },
      ]);
      const after = await t.inject({ method: 'GET', url: '/laundry?washed=1' });
      expect(hasText(after.body, '1 washed')).toBe(true);
      expect(unescapeHtml(after.body)).not.toContain(
        `name="ids" value="${shirt}"`,
      );
    });

    it('prompts the owner from the wardrobe when something needs a wash', async () => {
      const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(grid.body).toMatch(/\d+ garments need a wash/);
      expect(grid.body).toContain('href="/laundry"');
    });

    it('shows an empty hamper to someone who wore nothing', async () => {
      const cookie = await t.register('laundry-empty@example.com');
      const res = await t.inject({
        method: 'GET',
        url: '/laundry',
        headers: { cookie },
      });
      expectFullPage(res);
      expect(hasText(res.body, 'Nothing needs a wash.')).toBe(true);
    });
  });

  describe('away', () => {
    it('lends a garment with a note, takes it off the available list, and brings it back', async () => {
      const jacket = await newGarment('Lent jacket', 'outerwear');
      const lent = await post(`/wardrobe/${jacket}/away`, {
        away: 'lent',
        awayNote: '  Dana has it  ',
      });
      expectFragment(lent);
      // The form's status line, never the choices (src/web/autosave.tsx).
      expect(hasText(lent.body, 'Saved')).toBe(true);
      expect(lent.body).not.toContain('name="away"');
      expect((await garmentPage(jacket)).body).toContain('value="Dana has it"');
      const [row] = await t.db
        .select({ away: garment.away, awayNote: garment.awayNote })
        .from(garment)
        .where(eq(garment.id, jacket));
      expect(row).toEqual({ away: 'lent', awayNote: 'Dana has it' });
      expect(await available(jacket)).toBe(false);
      const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(grid.body).toContain('>Lent</span>');

      await post(`/wardrobe/${jacket}/away`, { away: '', awayNote: 'stale' });
      const [back] = await t.db
        .select({ away: garment.away, awayNote: garment.awayNote })
        .from(garment)
        .where(eq(garment.id, jacket));
      expect(back).toEqual({ away: null, awayNote: null });
      expect(await available(jacket)).toBe(true);
    });

    it('refuses a reason that is not lent or repair, and a note without one in the database', async () => {
      const jacket = await newGarment('Bad away jacket', 'outerwear');
      expect(
        (await post(`/wardrobe/${jacket}/away`, { away: 'stolen' })).statusCode,
      ).toBe(400);
      await expect(
        asFixture(t.db, (tx) =>
          tx
            .update(garment)
            .set({ awayNote: 'orphan note' })
            .where(eq(garment.id, jacket)),
        ),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'garment_away_note_check' },
      });
    });
  });

  /** Whether availableGarment (SQL) lets the garment through. */
  const available = async (id: number) =>
    (
      await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(and(eq(garment.id, id), availableGarment()))
    ).length === 1;

  describe('the available rule', () => {
    interface Case {
      name: string;
      category: string;
      quantity: number;
      washAfterWears: string;
      /** Days ago worn; one row each (repeats: two entries that day). */
      worn: number[];
      washedDaysAgo: number | null;
      away: AwayReason | null;
      status: GarmentStatus;
    }

    const base: Omit<Case, 'name'> = {
      category: 'tops',
      quantity: 1,
      washAfterWears: '',
      worn: [],
      washedDaysAgo: null,
      away: null,
      status: 'closet',
    };

    const CASES: Case[] = [
      { ...base, name: 'clean tee' },
      { ...base, name: 'worn tee', worn: [1] },
      { ...base, name: 'washed after wear', worn: [2], washedDaysAgo: 1 },
      { ...base, name: 'worn on wash day', worn: [1], washedDaysAgo: 1 },
      { ...base, name: 'three tees, two worn', quantity: 3, worn: [1, 2] },
      { ...base, name: 'three tees, all worn', quantity: 3, worn: [1, 2, 3] },
      { ...base, name: 'same day twice', quantity: 2, worn: [1, 1] },
      { ...base, name: 'jeans twice', category: 'bottoms', worn: [1, 2] },
      { ...base, name: 'jeans thrice', category: 'bottoms', worn: [1, 2, 3] },
      {
        ...base,
        name: 'raw denim',
        category: 'bottoms',
        washAfterWears: '0',
        worn: [1, 2, 3, 4, 5],
      },
      { ...base, name: 'sweater once', washAfterWears: '2', worn: [1] },
      { ...base, name: 'sneakers', category: 'footwear', worn: [1, 2, 3] },
      {
        ...base,
        name: 'socks',
        category: 'accessories',
        washAfterWears: '1',
        worn: [1],
      },
      { ...base, name: 'custom', category: 'scrubs', worn: [1, 2] },
      { ...base, name: 'lent', away: 'lent' },
      { ...base, name: 'at repair', away: 'repair' },
      { ...base, name: 'archived', status: 'archived' },
      { ...base, name: 'wishlist', status: 'wishlist' },
    ];

    it('agrees in SQL (availableGarment, dirtyCopiesSql) and in TypeScript (isAvailable) on every case', async () => {
      const cookie = await t.register('rules@example.com');
      const ownerId = await userIdOf(t, 'rules@example.com');
      const ids = new Map<string, number>();
      for (const c of CASES) {
        const id = await newGarment(
          c.name,
          c.category,
          { quantity: c.quantity, washAfterWears: c.washAfterWears },
          cookie,
        );
        ids.set(c.name, id);
        await asFixture(t.db, (tx) =>
          tx
            .update(garment)
            .set({
              lastWashedOn:
                c.washedDaysAgo === null ? null : daysAgo(c.washedDaysAgo),
              away: c.away,
              status: c.status,
            })
            .where(eq(garment.id, id)),
        );
        // Straight rows: one per wear, repeats standing in for two entries.
        for (const days of c.worn) {
          await asFixture(t.db, (tx) =>
            tx
              .insert(garmentWear)
              .values({
                garmentId: id,
                ownerId,
                day: daysAgo(days),
                outfitCalendarId: null,
              })
              .onConflictDoNothing(),
          );
        }
      }
      // Raw SQL, never a single-table Drizzle select: that writes the rule's
      // columns unqualified, and its `id` reads garment_wear's (src/db/AGENTS.md).
      const { rows } = await t.db.execute<{
        id: number;
        dirty: number;
        available: boolean;
      }>(
        sql`select ${garment.id} as id, ${dirtyCopiesSql()} as dirty, ${availableGarment()} as available from ${garment} where ${eq(garment.ownerId, ownerId)}`,
      );
      const bySql = new Map(rows.map((row) => [row.id, row]));

      const expected = CASES.map((c) => {
        const days = c.worn.map(daysAgo);
        const state = {
          quantity: c.quantity,
          limit: washLimit(
            c.category,
            c.washAfterWears === '' ? null : Number(c.washAfterWears),
          ),
          wearsSinceWash: wearsSinceWash(
            days.map((day) => ({ day, wornAt: null })),
            c.washedDaysAgo === null
              ? null
              : { day: daysAgo(c.washedDaysAgo), washedAt: null },
          ),
        };
        return {
          name: c.name,
          available: isAvailable({
            ...state,
            status: c.status,
            away: c.away,
          }),
        };
      });
      const actual = CASES.map((c) => ({
        name: c.name,
        available: bySql.get(ids.get(c.name)!)!.available,
      }));
      expect(actual).toEqual(expected);
      // And the rule reads as the plan says, spelled out.
      expect(
        Object.fromEntries(actual.map((a) => [a.name, a.available])),
      ).toEqual({
        'clean tee': true,
        'worn tee': false,
        'washed after wear': true,
        'worn on wash day': true,
        'three tees, two worn': true,
        'three tees, all worn': false,
        'same day twice': true,
        'jeans twice': true,
        'jeans thrice': false,
        'raw denim': true,
        'sweater once': true,
        sneakers: true,
        socks: false,
        custom: true,
        lent: false,
        'at repair': false,
        archived: false,
        wishlist: false,
      });
    });

    // #676: the same-day order, one table for both twins
    // (test/support/wash-cases.ts). The wash is two days back, so its day
    // after is still in the past.
    it('counts a same-day wear by its instant in SQL as in TypeScript, on every case', async () => {
      const ownerId = t.owner.id;
      const washDay = daysAgo(2);
      const ids = new Map<string, number>();
      for (const c of WASH_CASES) {
        const id = await createGarment(t, { name: c.name, category: 'tops' });
        ids.set(c.name, id);
        const { wears, lastWash } = washCaseRows(c, washDay, t.timeZone);
        const instant = (ms: number | null) =>
          ms === null ? null : new Date(ms);
        // A day's second wear is an entry's (one "Wore today" a day): the
        // entry marked worn, its wear's instant then set.
        const [single, ...more] = wears;
        const entryWears: number[] = [];
        for (const wear of more) {
          const entry = await schedule(
            await newOutfit(`${c.name} ${wear.day}`, [id]),
            wear.day,
          );
          await markWorn(entry);
          entryWears.push(entry);
        }
        await asFixture(t.db, async (tx) => {
          await tx
            .update(garment)
            .set({
              lastWashedOn: lastWash?.day ?? null,
              washedAt: instant(lastWash?.washedAt ?? null),
            })
            .where(eq(garment.id, id));
          await tx.insert(garmentWear).values({
            garmentId: id,
            ownerId,
            day: single.day,
            wornAt: instant(single.wornAt),
          });
          for (const [index, entry] of entryWears.entries()) {
            await tx
              .update(garmentWear)
              .set({ wornAt: instant(more[index].wornAt) })
              .where(eq(garmentWear.outfitCalendarId, entry));
          }
        });
      }
      // Raw SQL, never a single-table Drizzle select: that writes the rule's
      // columns unqualified, and its `id` reads garment_wear's (src/db/AGENTS.md).
      const { rows } = await t.db.execute<{ id: number; since: number }>(
        sql`select ${garment.id} as id, ${wearsSinceWashSql()} as since from ${garment} where ${eq(garment.ownerId, ownerId)}`,
      );
      const bySql = new Map(rows.map((row) => [row.id, row.since]));
      const pure = WASH_CASES.map((c) => {
        const { wears, lastWash } = washCaseRows(c, washDay, t.timeZone);
        return [c.name, wearsSinceWash(wears, lastWash)];
      });
      const sqlCounts = WASH_CASES.map((c) => [
        c.name,
        bySql.get(ids.get(c.name)!),
      ]);
      const expected = WASH_CASES.map((c) => [c.name, c.count]);
      expect(sqlCounts).toEqual(expected);
      expect(pure).toEqual(expected);
    });
  });

  describe('the garment form’s care fields', () => {
    const garmentRow = async (id: number) =>
      (
        await t.db
          .select({
            quantity: garment.quantity,
            washAfterWears: garment.washAfterWears,
            condition: garment.condition,
            conditionNote: garment.conditionNote,
          })
          .from(garment)
          .where(eq(garment.id, id))
      )[0];

    it('saves copies, the wash limit and the condition, and shows them back in the form', async () => {
      const id = await createGarment(t, {
        name: 'Care form',
        category: 'bottoms',
      });
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}`,
        ...form({
          category: 'bottoms',
          care: '1',
          quantity: '2',
          washAfterWears: '0',
          condition: 'needs_repair',
          conditionNote: ' Belt loop torn ',
        }),
      });
      expect(res.statusCode).toBe(302);
      expect(await garmentRow(id)).toEqual({
        quantity: 2,
        washAfterWears: 0,
        condition: 'needs_repair',
        conditionNote: 'Belt loop torn',
      });
      const edit = unescapeHtml(
        (await t.inject({ method: 'GET', url: `/wardrobe/${id}/edit` })).body,
      );
      expect(edit).toContain('name="care" value="1"');
      expect(edit).toMatch(/name="quantity"[^>]*value="2"/);
      expect(edit).toMatch(/<option value="0" selected="">Never<\/option>/);
      expect(edit).toMatch(/value="needs_repair"[^>]*checked=""/);
    });

    it('leaves them alone when a form cached before them saves', async () => {
      const id = await newGarment('Old form', 'tops', { quantity: 3 });
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}`,
        ...form({ name: 'Old form, renamed', category: 'tops' }),
      });
      expect(await garmentRow(id)).toMatchObject({ quantity: 3 });
    });

    it.each(['0', '31', 'two', '1.5'])(
      're-renders the form with a message for %s copies',
      async (quantity) => {
        const res = await t.inject({
          method: 'POST',
          url: '/wardrobe',
          ...form({ name: 'Bad count', category: 'tops', care: '1', quantity }),
        });
        expect(res.statusCode).toBe(400);
        expect(
          hasText(res.body, 'Copies must be a whole number from 1 to 30'),
        ).toBe(true);
      },
    );

    it('drops a condition note while the garment is good', async () => {
      const id = await createGarment(t, {
        name: 'Good note',
        category: 'tops',
      });
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}`,
        ...form({
          category: 'tops',
          care: '1',
          condition: 'good',
          conditionNote: 'nothing wrong',
        }),
      });
      expect(await garmentRow(id)).toMatchObject({
        condition: 'good',
        conditionNote: null,
      });
      await expect(
        asFixture(t.db, (tx) =>
          tx
            .update(garment)
            .set({ conditionNote: 'orphan' })
            .where(eq(garment.id, id)),
        ),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'garment_condition_note_check' },
      });
      await expect(
        asFixture(t.db, (tx) =>
          tx
            .update(garment)
            .set({ condition: 'shabby' as 'good' })
            .where(eq(garment.id, id)),
        ),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'garment_condition_check' },
      });
    });
  });

  describe('condition', () => {
    it('is set from the garment page, and never makes a garment unavailable', async () => {
      const tee = await newGarment('Worn-out tee', 'tops');
      const res = await post(`/wardrobe/${tee}/condition`, {
        condition: 'replace_soon',
        conditionNote: 'Collar gone',
      });
      expectFragment(res);
      // The form's status line, never the chips (src/web/autosave.tsx).
      expect(hasText(res.body, 'Saved')).toBe(true);
      expect(res.body).not.toContain('name="condition"');
      const page = await garmentPage(tee);
      expect(page.body).toContain('value="Collar gone"');
      expect(page.body).toMatch(
        /value="replace_soon" class="[^"]*" aria-label="Replace soon" checked/,
      );
      expect(await available(tee)).toBe(true);

      const grid = await t.inject({
        method: 'GET',
        url: '/wardrobe?attention=true',
      });
      expect(grid.body).toContain('Worn-out tee');
      expect(hasText(grid.body, 'Replace soon')).toBe(true);
      expect(grid.body).not.toContain('Lent jacket');
    });

    it('is bulk-set on the selected garments, clearing the note only for good', async () => {
      const a = await newGarment('Bulk cond A', 'tops');
      const b = await newGarment('Bulk cond B', 'footwear');
      await post(`/wardrobe/${a}/condition`, {
        condition: 'needs_repair',
        conditionNote: 'Seam',
      });
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe/bulk',
        ...form({
          ids: [String(a), String(b)],
          property: 'condition',
          condition: 'replace_soon',
        }),
      });
      expect(res.statusCode).toBe(303);
      const rows = await t.db
        .select({ condition: garment.condition, note: garment.conditionNote })
        .from(garment)
        .where(sql`${garment.id} in (${a}, ${b})`)
        .orderBy(garment.id);
      expect(rows).toEqual([
        { condition: 'replace_soon', note: 'Seam' },
        { condition: 'replace_soon', note: null },
      ]);
      await t.inject({
        method: 'POST',
        url: '/wardrobe/bulk',
        ...form({ ids: [String(a)], property: 'condition', condition: 'good' }),
      });
      const [good] = await t.db
        .select({ condition: garment.condition, note: garment.conditionNote })
        .from(garment)
        .where(eq(garment.id, a));
      expect(good).toEqual({ condition: 'good', note: null });
    });
  });

  describe('a shared wardrobe', () => {
    let viewer: string;

    beforeAll(async () => {
      viewer = await t.register('wear-viewer@example.com');
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'VIEW' },
        headers: { 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie: viewer },
      });
    });

    it('shows a grantee quantity and condition, never wears, washes or away', async () => {
      const tees = await newGarment('Shared tees', 'tops', { quantity: 3 });
      await post(`/wardrobe/${tees}/wear`, { worn: '1' });
      await post(`/wardrobe/${tees}/away`, { away: 'lent', awayNote: 'Sam' });
      await post(`/wardrobe/${tees}/condition`, {
        condition: 'needs_repair',
        conditionNote: 'Hem',
      });
      const q = `?ownerId=${t.owner.id}`;

      const page = await garmentPage(tees, viewer, q);
      expect(page.body).not.toContain('id="garment-wear"');
      expect(hasText(page.body, 'Worn once')).toBe(false);
      expect(page.body).not.toContain('Sam');
      expect(hasText(page.body, 'Needs repair')).toBe(true);
      expect(hasText(page.body, '3 identical')).toBe(true);

      const grid = await t.inject({
        method: 'GET',
        url: `/wardrobe${q}&needsWash=true`,
        headers: { cookie: viewer },
      });
      // The wash filter is dropped for a grantee: the whole wardrobe shows,
      // with no wash marks or away, and the filter is not offered.
      expect(grid.body).toContain('Shared tees');
      expect(grid.body).not.toContain('data-mark="needs-wash"');
      expect(grid.body).not.toContain('data-mark="away:lent"');
      expect(grid.body).not.toContain('data-mark="away:repair"');
      expect(hasText(grid.body, '×3')).toBe(true);
      expect(grid.body).not.toContain('name="needsWash"');
      expect(grid.body).not.toContain('href="/laundry"');

      const own = await garmentPage(tees);
      expect(own.body).toContain('id="garment-wear"');
      expect(own.body).toContain('value="Sam"');
    });

    // The wash limit is the owner's record like the wears it counts
    // (FormAudience, validation.ts): a MANAGE grantee edits the garment's
    // properties, quantity and condition, and neither sees nor sets it.
    describe('the wash limit on the garment form', () => {
      let manager: string;
      const q = () => `?ownerId=${t.owner.id}`;
      const WASH_SELECT = 'name="washAfterWears"';

      const washLimitOf = async (id: number) =>
        (
          await t.db
            .select({ washAfterWears: garment.washAfterWears })
            .from(garment)
            .where(eq(garment.id, id))
        )[0].washAfterWears;

      const getAs = (cookie: string, url: string) =>
        t.inject({ method: 'GET', url, headers: { cookie } });

      const postAs = (
        cookie: string,
        url: string,
        fields: Record<string, string>,
      ) =>
        t.inject({
          method: 'POST',
          url,
          ...form(fields),
          headers: { ...form({}).headers, cookie },
        });

      beforeAll(async () => {
        manager = await t.register('wash-manager@example.com');
        const invite = await t.inject({
          method: 'POST',
          url: '/wardrobe-share/create-invite-link',
          payload: { permission: 'MANAGE', currentPassword: TEST_PASSWORD },
          headers: { 'hx-request': 'true' },
        });
        const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
          invite.body,
        )![1];
        await t.inject({
          method: 'POST',
          url: `/wardrobe-share/invite/${token}/accept`,
          headers: { cookie: manager },
        });
      });

      it('is not in a MANAGE grantee’s edit or new form, and the owner’s is', async () => {
        const jeans = await newGarment('Raw denim', 'bottoms', {
          washAfterWears: '0',
        });
        const edit = await getAs(manager, `/wardrobe/${jeans}/edit${q()}`);
        expect(edit.statusCode).toBe(200);
        expect(edit.body).not.toContain(WASH_SELECT);
        expect(edit.body).not.toContain('>Never</option>');
        // The shareable care fields stay.
        expect(edit.body).toContain('name="quantity"');
        expect(edit.body).toContain('name="condition"');

        const fresh = await getAs(manager, `/wardrobe/new${q()}`);
        expect(fresh.statusCode).toBe(200);
        expect(fresh.body).not.toContain(WASH_SELECT);

        const own = await t.inject({
          method: 'GET',
          url: `/wardrobe/${jeans}/edit`,
        });
        expect(own.body).toMatch(
          /<option value="0" selected="">Never<\/option>/,
        );
      });

      it('is left as stored when a MANAGE grantee posts one, and the rest is saved', async () => {
        const jeans = await newGarment('Selvedge', 'bottoms', {
          washAfterWears: '0',
        });
        const res = await postAs(manager, `/wardrobe/${jeans}${q()}`, {
          name: 'Selvedge',
          category: 'bottoms',
          care: '1',
          quantity: '2',
          washAfterWears: '1',
        });
        expect(res.statusCode).toBe(302);
        const [row] = await t.db
          .select({
            quantity: garment.quantity,
            washAfterWears: garment.washAfterWears,
          })
          .from(garment)
          .where(eq(garment.id, jeans));
        expect(row).toEqual({ quantity: 2, washAfterWears: 0 });
      });

      it('is the role’s default on a garment a MANAGE grantee adds', async () => {
        const res = await postAs(manager, `/wardrobe${q()}`, {
          name: 'Added for them',
          category: 'tops',
          care: '1',
          quantity: '1',
          washAfterWears: '20',
        });
        expect(res.statusCode).toBe(302);
        const id = Number(
          /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
        );
        expect(await washLimitOf(id)).toBeNull();
      });

      it('is not copied into a grantee’s clone, which sets its own', async () => {
        const jeans = await newGarment('Clone me', 'bottoms', {
          washAfterWears: '0',
        });
        const cloneForm = await getAs(viewer, `/wardrobe/${jeans}/clone${q()}`);
        expect(cloneForm.statusCode).toBe(200);
        // Their clone's own field, at the default: never the owner's value.
        expect(cloneForm.body).toContain(WASH_SELECT);
        expect(cloneForm.body).not.toMatch(/<option value="0" selected="">/);
        expect(cloneForm.body).toMatch(/<option value="" selected="">/);

        const res = await postAs(viewer, `/wardrobe/${jeans}/clone${q()}`, {
          name: 'My copy',
          category: 'bottoms',
          care: '1',
          quantity: '1',
          washAfterWears: '5',
        });
        expect(res.statusCode).toBe(302);
        const id = Number(
          /^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1],
        );
        expect(id).not.toBe(jeans);
        expect(await washLimitOf(id)).toBe(5);
        expect(await washLimitOf(jeans)).toBe(0);
      });
    });
  });
});
