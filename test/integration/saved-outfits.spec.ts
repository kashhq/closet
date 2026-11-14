import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outfitCalendar } from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { shortDayLabel } from '../../src/web/date-labels';
import { createGarment } from './garments';
import {
  createTestApp,
  hasText,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { expectFullPage, expectNativePostForms } from './pages';
import { takeSelfie } from './selfies';

/**
 * Redesign R5 (#85; plan "Outfits"): the Saved tab as a grid of collage
 * tiles with what the calendar says of each outfit, the Saved tab picking
 * for a calendar day (`?for=day:D&occasion=O[&replace=E]`, the "+ Plan"
 * sheet's "Pick a saved outfit"), the tabs carrying that day between Saved
 * and Ideas, and the outfit page: its entries (planned, worn), Plan and
 * Edit in Styling, Share and Delete in the ⋯ menu.
 */

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

/** A Saved tile's markup, from its data-outfit-id to the next tile's. */
function tileOf(html: string, outfitId: number): string {
  const start = html.indexOf(`data-outfit-id="${outfitId}"`);
  expect(start, `tile of outfit ${outfitId}`).toBeGreaterThan(-1);
  const end = html.indexOf('data-outfit-id="', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

describe('Saved outfits and the outfit page (R5)', () => {
  let t: TestApp;
  let top: number;
  let jeans: number;
  let today: string;

  // Each outfit its own shoes beside the tee and jeans: one garment set is
  // one outfit (#219), so the same two garments would be the same outfit.
  const newOutfit = async (name: string) => {
    const shoes = await createGarment(t, {
      name: `${name} shoes`,
      category: 'footwear',
    });
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...form({
        name,
        category: ['tops', 'bottoms', 'footwear'],
        garmentId: [String(top), String(jeans), String(shoes)],
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  /** POST /calendar as the Plan sheet and the picking grid post it. */
  const plan = async (
    outfitId: number,
    date: string,
    occasion = 'all-day',
    extra: Record<string, string> = {},
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({ outfitId: String(outfitId), date, occasion, ...extra }),
    });
    expect(res.statusCode).toBe(302);
    return res;
  };

  const entryOf = async (outfitId: number, day: string) => {
    const [entry] = await t.db
      .select({ id: outfitCalendar.id, occasion: outfitCalendar.occasion })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
      );
    return entry;
  };

  const markWorn = async (entryId: number) => {
    const res = await t.inject({
      method: 'POST',
      url: `/calendar/${entryId}/worn`,
      ...form({ worn: '1' }),
    });
    expect(res.statusCode).toBe(303);
  };

  const page = async (url: string) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
    expectNativePostForms(res);
    return unescapeHtml(res.body);
  };

  beforeAll(async () => {
    t = await createTestApp();
    today = t.today();
    top = await createGarment(t, { name: 'Grid tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Grid jeans', category: 'bottoms' });
  });

  afterAll(() => t?.cleanup());

  describe('the Saved grid', () => {
    it('says how often each outfit was worn and when it is next planned', async () => {
      const worn = await newOutfit('Worn twice');
      for (const back of [3, 10]) {
        const day = addDays(today, -back);
        await plan(worn, day);
        await markWorn((await entryOf(worn, day)).id);
      }
      const planned = await newOutfit('Planned ahead');
      await plan(planned, addDays(today, 9));
      await plan(planned, addDays(today, 2));
      // A plan that passed unworn says nothing.
      const lapsed = await newOutfit('Lapsed');
      await plan(lapsed, addDays(today, -4));

      const html = await page('/outfits');
      expect(hasText(tileOf(html, worn), 'Worn 2×')).toBe(true);
      const ahead = tileOf(html, planned);
      // The soonest plan, as "Planned Oct 3".
      expect(
        hasText(ahead, `Planned ${shortDayLabel(addDays(today, 2))}`),
      ).toBe(true);
      expect(hasText(ahead, 'Worn')).toBe(false);
      expect(tileOf(html, lapsed)).not.toMatch(/Planned|Worn/);
    });

    it('counts an entry kept by its selfie as worn, as the outfit page’s Worn strip does', async () => {
      const outfit = await newOutfit('Selfie then unmarked');
      await plan(outfit, today);
      const entry = await entryOf(outfit, today);
      await takeSelfie(t, entry.id);
      // Unmarked: the selfie stays, and with it the day's record.
      const unmark = await t.inject({
        method: 'POST',
        url: `/calendar/${entry.id}/worn`,
        ...form({ worn: '0' }),
      });
      expect(unmark.statusCode).toBe(303);

      const tile = tileOf(await page('/outfits'), outfit);
      expect(hasText(tile, 'Worn 1×')).toBe(true);
      // Today's entry is not also the next plan.
      expect(tile).not.toMatch(/Planned/);
      const strip = await page(`/outfits/${outfit}`);
      expect(strip).toContain(`data-worn-day="${today}"`);
    });

    it('is a stale-while-revalidate tab root: two renders are the same bytes', async () => {
      const first = await t.inject({ method: 'GET', url: '/outfits' });
      const second = await t.inject({ method: 'GET', url: '/outfits' });
      expect(second.body).toBe(first.body);
    });
  });

  describe('picking for a day (?for=day:)', () => {
    it('is one native form to POST /calendar with the day, and a tap plans the outfit there', async () => {
      const outfit = await newOutfit('Pick me');
      const day = addDays(today, 5);
      const html = await page(`/outfits?for=day:${day}&occasion=evening`);
      expect(html).toContain('action="/calendar"');
      expect(html).toContain(
        `<input type="hidden" name="date" value="${day}"/>`,
      );
      expect(html).toContain(
        '<input type="hidden" name="occasion" value="evening"/>',
      );
      expect(html).toContain(
        `<input type="hidden" name="week" value="${day}"/>`,
      );
      expect(tileOf(html, outfit)).toContain(
        `name="outfitId" value="${outfit}"`,
      );
      expect(html).not.toContain('name="replace"');
      // The day is said, with the way back to its plan page.
      expect(html).toContain(`data-destination-day="${day}"`);
      expect(html).toContain(
        `href="/calendar/plan?for=day:${day}&occasion=evening"`,
      );
      // Styling carries the day too.
      expect(html).toContain(`href="/styling?for=day:${day}&occasion=evening"`);

      const res = await plan(outfit, day, 'evening', { week: day });
      expect(res.headers.location).toBe(`/calendar?week=${day}`);
      expect((await entryOf(outfit, day)).occasion).toBe('evening');
    });

    it('disables an outfit already on the day, saying for which occasion', async () => {
      const outfit = await newOutfit('Already there');
      const day = addDays(today, 6);
      await plan(outfit, day, 'work');
      const tile = tileOf(
        await page(`/outfits?for=day:${day}&occasion=evening`),
        outfit,
      );
      expect(tile).toMatch(/<button[^>]*disabled=""/);
      expect(hasText(tile, 'On this day · Work')).toBe(true);
    });

    it('carries `replace` only for the user’s unworn entry of that day and occasion', async () => {
      const held = await newOutfit('Held');
      const day = addDays(today, 7);
      await plan(held, day, 'evening');
      const entry = (await entryOf(held, day)).id;
      const changing = await page(
        `/outfits?for=day:${day}&occasion=evening&replace=${entry}`,
      );
      expect(changing).toContain(
        `<input type="hidden" name="replace" value="${entry}"/>`,
      );
      expect(changing).toContain('Changing ');
      // Another occasion's entry, or none at all, plans one more.
      for (const query of [
        `for=day:${day}&occasion=work&replace=${entry}`,
        `for=day:${day}&occasion=evening&replace=999999`,
      ]) {
        expect(await page(`/outfits?${query}`)).not.toContain('name="replace"');
      }
      // A worn entry keeps its outfit.
      const past = addDays(today, -1);
      await plan(held, past, 'evening');
      const worn = (await entryOf(held, past)).id;
      await markWorn(worn);
      expect(
        await page(`/outfits?for=day:${past}&occasion=evening&replace=${worn}`),
      ).not.toContain('name="replace"');
    });

    it('reads a malformed or trip destination as the plain grid', async () => {
      for (const query of [
        'for=day:2030-02-30',
        'for=trip:5',
        'for=nonsense',
      ]) {
        const html = await page(`/outfits?${query}`);
        expect(html, query).not.toContain('action="/calendar"');
        expect(html, query).not.toContain('data-destination-day');
      }
    });

    it('reads the day in the same statement as the grid', async () => {
      const day = addDays(today, 8);
      const plain = await recordQueries(() =>
        t.inject({ method: 'GET', url: '/outfits' }),
      );
      const picking = await recordQueries(() =>
        t.inject({ method: 'GET', url: `/outfits?for=day:${day}` }),
      );
      // #164: the day's entries are a column of the grid's statement, as
      // Muse's outfits are of the plain tab's (#335): one statement each.
      expect(picking.statements).toBe(plain.statements);
    });
  });

  describe('the tabs', () => {
    it('carry the day between Saved and Ideas, and nothing without one', async () => {
      const day = addDays(today, 3);
      const query = `for=day:${day}&occasion=work`;
      const saved = await page(`/outfits?${query}`);
      expect(saved).toContain(`href="/outfits/ideas?${query}"`);
      const ideas = await page(`/outfits/ideas?${query}`);
      expect(ideas).toContain(`href="/outfits?${query}"`);
      const plain = await page('/outfits');
      expect(plain).toContain('href="/outfits/ideas"');
    });
  });

  describe('the outfit page', () => {
    it('lists the days it is planned for, soonest first, and not the ones that passed', async () => {
      const outfit = await newOutfit('Entries');
      const later = addDays(today, 12);
      const sooner = addDays(today, 4);
      await plan(outfit, later, 'evening');
      await plan(outfit, sooner, 'work');
      await plan(outfit, addDays(today, -2));
      const html = await page(`/outfits/${outfit}`);
      const planned = html.slice(html.indexOf('data-outfit-planned'));
      const days = [...planned.matchAll(/href="\/calendar\?week=([\d-]+)"/g)]
        .map((m) => m[1])
        .slice(0, 2);
      expect(days).toEqual([sooner, later]);
      expect(planned).toContain('· Work');
      expect(html).not.toContain(`href="/calendar?week=${addDays(today, -2)}"`);
    });

    it('offers Plan (a sheet posting to /calendar, its day the client’s today) and Edit in Styling', async () => {
      const outfit = await newOutfit('Actions');
      const html = await page(`/outfits/${outfit}`);
      const sheet = html.slice(html.indexOf('id="outfit-plan-sheet"'));
      expect(sheet).toContain('action="/calendar"');
      expect(sheet).toContain(
        `<input type="hidden" name="outfitId" value="${outfit}"/>`,
      );
      // The page names no today (#708): the script fills the default
      // (defaultsToToday; the calendar e2e reads it in a browser).
      expect(sheet).toMatch(
        /<input type="date" name="date"[^>]*data-value-today=""[^>]*required/,
      );
      expect(sheet).not.toContain(`value="${today}"`);
      expect(sheet).toMatch(/value="all-day"[^>]*checked=""/);
      expect(html).toContain(
        `href="/styling?outfit=${outfit}&returnTo=%2Foutfits%2F${outfit}"`,
      );
      expect(hasText(html, 'Edit in Styling')).toBe(true);
      // Share and Delete are in the ⋯ menu.
      const menu = html.slice(html.indexOf('id="outfit-menu"'));
      expect(menu).toContain(`hx-delete="/outfits/${outfit}"`);
      // Not shared yet: Share makes the public link (#669).
      expect(menu).toContain(`hx-post="/outfits/${outfit}/share"`);
    });

    it('shows the collage of its garments', async () => {
      const outfit = await newOutfit('Collage');
      const html = await page(`/outfits/${outfit}`);
      const main = html.slice(html.indexOf('<main'));
      const collage = main.slice(0, main.indexOf('data-outfit-plan'));
      expect(collage).toContain('bg-base-200');
      expect(hasText(collage, 'Grid tee')).toBe(true);
    });
  });
});
