import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { outfitCalendar } from '../../src/db/schema';
import { OCCASIONS } from '../../src/wardrobe/occasions';
import { dayColumns, planButtonLabel } from './calendar-page';
import { createGarment } from './garments';
import {
  createTestApp,
  hasText,
  recordQueries,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import { expectFullPage, expectNativePostForms } from './pages';

/**
 * Several outfits a day, each for an occasion (#13, plan section 8): the
 * entry's occasion from every write that plans (POST /calendar, the outfit
 * form), the unique key that still keeps an outfit to once a day, the week
 * page stacking a day in occasion order, and the plan page that adds one
 * more. The wears side (a day is one wear however many outfits) is in
 * wears.spec.ts; the migration's default in occasions-migration.spec.ts (retired 2026-10-13).
 *
 * Days are in 2030 (planned, so no worn pills) unless a test needs today.
 */

const DAY = '2030-10-09';
const WEEK_URL = `/calendar?week=${DAY}`;

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

describe('occasions', () => {
  let t: TestApp;

  const newOutfit = async (
    name: string,
    fields: Record<string, string> = {},
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...form({ name, ...fields }),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)/.exec(String(res.headers.location))?.[1]);
  };

  const plan = (fields: Record<string, string>) =>
    t.inject({ method: 'POST', url: '/calendar', ...form(fields) });

  const entriesOn = (day: string) =>
    t.db
      .select({
        outfitId: outfitCalendar.outfitId,
        occasion: outfitCalendar.occasion,
      })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.ownerId, t.owner.id),
          eq(outfitCalendar.day, day),
        ),
      )
      .orderBy(asc(outfitCalendar.id));

  const page = async (url: string) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return unescapeHtml(res.body);
  };

  beforeAll(async () => {
    t = await createTestApp();
    // The builder shows its form only with a garment to cycle.
    await createGarment(t, { name: 'Builder shirt' });
    // An outfit's worth of closet: an empty one hides "+ Plan" (#666).
    await createGarment(t, { name: 'Tee', category: 'tops' });
    await createGarment(t, { name: 'Jeans', category: 'bottoms' });
  });

  afterAll(() => t?.cleanup());

  describe('POST /calendar', () => {
    it('plans the outfit for the posted occasion, and all day without one', async () => {
      const office = await newOutfit('Office');
      const dinner = await newOutfit('Dinner');
      const brunch = await newOutfit('Brunch');
      const day = '2030-11-04';
      for (const [outfitId, occasion] of [
        [office, 'work'],
        [dinner, 'evening'],
      ] as const) {
        const res = await plan({
          outfitId: String(outfitId),
          date: day,
          occasion,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe(`/calendar?week=${day}`);
      }
      // As a page cached before #13 posts it.
      expect(
        (await plan({ outfitId: String(brunch), date: day })).statusCode,
      ).toBe(302);

      expect(await entriesOn(day)).toEqual([
        { outfitId: office, occasion: 'work' },
        { outfitId: dinner, occasion: 'evening' },
        { outfitId: brunch, occasion: 'all-day' },
      ]);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Outfit ${dinner} scheduled on ${day} (evening) by user ${t.owner.id}`,
      );
    });

    it('keeps an outfit to once a day: another occasion for it changes nothing', async () => {
      const outfit = await newOutfit('Once a day');
      const day = '2030-11-05';
      await plan({ outfitId: String(outfit), date: day, occasion: 'work' });
      const again = await t.inject({
        method: 'POST',
        url: '/calendar',
        ...form({ outfitId: String(outfit), date: day, occasion: 'evening' }),
      });
      expect(again.statusCode).toBe(302);
      expect(await entriesOn(day)).toEqual([
        { outfitId: outfit, occasion: 'work' },
      ]);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Outfit ${outfit} already scheduled on ${day} for user ${t.owner.id}; evening not added`,
      );
    });

    it('refuses an occasion the app does not have with a 400, writing nothing', async () => {
      const outfit = await newOutfit('Bad occasion');
      for (const occasion of ['dinner', 'Evening', 'night out', '']) {
        const res = await plan({
          outfitId: String(outfit),
          date: '2030-11-06',
          occasion,
        });
        expect({ occasion, status: res.statusCode }).toEqual({
          occasion,
          status: 400,
        });
        expectFullPage(res);
      }
      expect(await entriesOn('2030-11-06')).toEqual([]);
    });

    it('stores only the known occasions: the check constraint agrees', async () => {
      const outfit = await newOutfit('Constraint');
      // Raw SQL: the column's type already refuses it in TypeScript.
      await expect(
        asFixture(t.db, (tx) =>
          tx.execute(
            sql`insert into outfit_calendar (owner_id, outfit_id, day, occasion)
              values (${t.owner.id}, ${outfit}, '2030-11-07', 'brunch')`,
          ),
        ),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'outfit_calendar_occasion_check' },
      });
    });
  });

  describe('the week page', () => {
    it("stacks a day's outfits in occasion order, each labelled", async () => {
      const outfits = {
        evening: await newOutfit('Dinner out'),
        'night-out': await newOutfit('Drinks'),
        work: await newOutfit('Desk'),
        workout: await newOutfit('Run'),
        'all-day': await newOutfit('Errands'),
      };
      // Planned out of order: the page orders them, not the insert.
      for (const [occasion, outfitId] of Object.entries(outfits)) {
        await plan({ outfitId: String(outfitId), date: DAY, occasion });
      }

      const wednesday = dayColumns(await page(WEEK_URL)).get(DAY)!;
      const order = [...wednesday.matchAll(/data-occasion="([a-z-]+)"/g)].map(
        (match) => match[1],
      );
      expect(order).toEqual([
        'all-day',
        'workout',
        'work',
        'evening',
        'night-out',
      ]);
      for (const label of [
        'All day',
        'Workout',
        'Work',
        'Evening',
        'Night out',
      ]) {
        expect(hasText(wednesday, label)).toBe(true);
      }
      // Each row's outfit under its label.
      const rows = wednesday.split('data-occasion=').slice(1);
      expect(hasText(rows[1], 'Run')).toBe(true);
      expect(hasText(rows[4], 'Drinks')).toBe(true);
      // One more is "+ Another outfit"; an empty day says "+ Plan".
      const html = await page(WEEK_URL);
      expect(planButtonLabel(html, DAY)).toBe('+ Another outfit');
      expect(planButtonLabel(html, '2030-10-10')).toBe('+ Plan');
    });
  });

  describe('GET /calendar/plan', () => {
    it('offers every occasion, the builder for the chosen one, and the saved outfits to plan', async () => {
      const day = '2030-10-16';
      const desk = await newOutfit('Plan desk');
      const other = await newOutfit('Plan other');
      await plan({ outfitId: String(desk), date: day, occasion: 'work' });

      let res: Awaited<ReturnType<typeof t.inject>> | undefined;
      // #165, #660: the session, then a page of the saved outfits and the
      // day's entries in one statement (planContext); the day's entries
      // bare (which outfits, for which occasion), with no collage or
      // selfie the page does not draw.
      const read = await recordQueries(async () => {
        res = await t.inject({
          method: 'GET',
          url: `/calendar/plan?for=day:${day}&occasion=evening`,
        });
      });
      expect(read.statements).toBe(2);
      expect(read.sql.join('\n')).not.toMatch(/"selfie"/);
      expectFullPage(res!);
      expectNativePostForms(res!);
      const html = unescapeHtml(res!.body);
      expect(hasText(html, 'Wednesday, Oct 16')).toBe(true);
      // The occasions as links, the chosen one marked.
      for (const occasion of [
        'all-day',
        'workout',
        'work',
        'daytime',
        'evening',
        'night-out',
      ]) {
        expect(html).toContain(
          `href="/calendar/plan?for=day:${day}&occasion=${occasion}"`,
        );
      }
      expect(html).toMatch(
        /occasion=evening"\s+class="[^"]*btn-primary[^"]*"\s+aria-current="true"/,
      );
      // Style one: Styling with the same destination (#42).
      expect(html).toContain(`href="/styling?for=day:${day}&occasion=evening"`);
      // Or pick one: POST /calendar with the day and the occasion.
      expect(html).toContain('action="/calendar"');
      expect(html).toContain(`name="date" value="${day}"`);
      expect(html).toContain('name="occasion" value="evening"');
      // The outfit already on the day cannot be planned twice.
      const deskButton = new RegExp(`<button[^>]*value="${desk}"[^>]*>`).exec(
        html,
      )![0];
      expect(deskButton).toContain(' disabled=""');
      expect(hasText(html, 'On this day · Work')).toBe(true);
      const otherButton = new RegExp(`<button[^>]*value="${other}"[^>]*>`).exec(
        html,
      )![0];
      expect(otherButton).not.toContain(' disabled=""');

      // Picking it plans it for the evening.
      const picked = await plan({
        date: day,
        occasion: 'evening',
        week: day,
        outfitId: String(other),
      });
      expect(picked.headers.location).toBe(`/calendar?week=${day}`);
      expect(await entriesOn(day)).toEqual([
        { outfitId: desk, occasion: 'work' },
        { outfitId: other, occasion: 'evening' },
      ]);
    });

    it('falls back to today, all day, for a missing or malformed destination', async () => {
      // The clock stands still, so "today" cannot turn at midnight between
      // the request and the expectation (only Date is faked; the session's
      // token stays valid at the real time).
      vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
      const today = t.today();
      try {
        for (const query of [
          '',
          '?for=garbage',
          '?for=day:2030-02-30',
          '?for=trip:3',
        ]) {
          const html = await page(`/calendar/plan${query}`);
          expect({
            query,
            today: html.includes(`name="date" value="${today}"`),
          }).toEqual({
            query,
            today: true,
          });
          expect(html).toContain('name="occasion" value="all-day"');
        }
        // An unknown occasion is all day on the given day.
        const html = await page(
          '/calendar/plan?for=day:2030-10-12&occasion=brunch',
        );
        expect(html).toContain('name="date" value="2030-10-12"');
        expect(html).toContain('name="occasion" value="all-day"');
      } finally {
        vi.useRealTimers();
      }
    });

    it('tells a user without outfits there are none yet, and still offers Styling', async () => {
      const cookie = await t.register('no-outfits@example.com');
      const res = await t.inject({
        method: 'GET',
        url: `/calendar/plan?for=day:${DAY}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(hasText(res.body, 'No saved outfits yet.')).toBe(true);
      expect(unescapeHtml(res.body)).toContain(
        `/styling?for=day:${DAY}&occasion=all-day`,
      );
    });
  });

  describe('the outfit form', () => {
    /** The builder's link, followed into Styling (#42). */
    const styled = async (url: string) => {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(302);
      return page(String(res.headers.location));
    };

    it('opens Styling from the plan page with the day and the occasion chosen', async () => {
      const html = await styled(
        `/outfits/new?for=day:${DAY}&occasion=night-out&returnTo=/calendar`,
      );
      expect(html).toContain(`name="for" value="day:${DAY}"`);
      expect(html).toContain('name="occasion" value="night-out"');
      expect(html).toContain('data-styling-for="day"');
    });

    it('reads a calendar link cached before #13 (?scheduleDate=) as all day', async () => {
      const html = await styled(
        `/outfits/new?scheduleDate=${DAY}&returnTo=/calendar`,
      );
      expect(html).toContain(`name="for" value="day:${DAY}"`);
      expect(html).toContain('name="occasion" value="all-day"');
    });

    it('plans the saved outfit for the chosen occasion, all day without one', async () => {
      const day = '2030-11-12';
      const evening = await newOutfit('Form evening', {
        scheduleDate: day,
        scheduleOccasion: 'evening',
      });
      const cached = await newOutfit('Form cached', { scheduleDate: day });
      expect(await entriesOn(day)).toEqual([
        { outfitId: evening, occasion: 'evening' },
        { outfitId: cached, occasion: 'all-day' },
      ]);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Outfit ${evening} created by user \\d+: 0 row\\(s\\), scheduled on ${day} \\(evening\\)$`,
          ),
        ),
      );
    });

    it('re-saving an outfit on a day it is already on keeps its occasion', async () => {
      const day = '2030-11-13';
      const outfit = await newOutfit('Kept occasion', {
        scheduleDate: day,
        scheduleOccasion: 'evening',
      });
      const res = await t.inject({
        method: 'POST',
        url: `/outfits/${outfit}`,
        ...form({ scheduleDate: day, scheduleOccasion: 'all-day' }),
      });
      expect(res.statusCode).toBe(302);
      expect(await entriesOn(day)).toEqual([
        { outfitId: outfit, occasion: 'evening' },
      ]);
    });

    it('refuses an unknown occasion with a 400, saving nothing', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...form({
          name: 'Refused',
          scheduleDate: '2030-11-14',
          scheduleOccasion: 'brunch',
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(await entriesOn('2030-11-14')).toEqual([]);
    });
  });

  describe('the outfit page', () => {
    it('offers every occasion beside the day in its Plan sheet, all day first chosen', async () => {
      const outfit = await newOutfit('Listed');
      const html = await page(`/outfits/${outfit}`);
      const sheet = html.slice(html.indexOf('id="outfit-plan-sheet"'));
      for (const occasion of OCCASIONS) {
        expect(sheet).toContain(
          `type="radio" name="occasion" value="${occasion}"`,
        );
      }
      expect(sheet).toMatch(/value="all-day"[^>]*checked=""/);
    });
  });
});
