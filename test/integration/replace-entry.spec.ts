import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  outfit,
  outfitCalendar,
  selfie,
  tripOutfit,
  weekPlan,
  weekPlanEntry,
} from '../../src/db/schema';
import type { Occasion } from '../../src/wardrobe/occasions';
import { addDays, type IsoDate } from '../../src/calendar-date';
import { replaceEntryOutfit } from '../../src/web/calendar/replace';
import { pickIdea } from '../../src/web/outfits/pick';
import { tripModel } from '../../src/web/trips/model';
import { addTripOutfit, createTrip } from '../../src/web/trips/queries';
import {
  createWeekPlan,
  recordAutoEntry,
} from '../../src/web/week-plan/queries';
import {
  createTestApp,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import { callTool, createAccessToken, tool } from './mcp';
import {
  expectFullPage,
  expectNativePostForms,
  expectNoScriptNavigation,
} from './pages';
import { takeSelfie } from './selfies';
import { interleave } from './interleave';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * Changing a planned outfit in place (#69): one replace write,
 * replaceEntryOutfit (src/web/calendar/replace.ts), reached from the plan
 * page's saved outfits (POST /calendar with `replace`), the gallery's pick
 * (Today's Change) and the MCP tool schedule_outfit's replaceEntryId. The
 * entry keeps its id, day and occasion; a worn entry is refused; its selfie
 * stays on the day as a look; the choice becomes the person's; an outfit
 * "Plan my week" created for it goes once nothing holds it; an outfit
 * already on the day is refused; another's entry is a 404; a double tap
 * changes it once.
 */

type Fields = Record<string, string | string[]>;

function formPayload(fields: Fields) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

describe('changing a planned outfit in place', () => {
  let t: TestApp;
  let tops: number[];
  let bottoms: number[];
  let shoes: number[];

  const garmentIn = async (name: string, category: string, color: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...formPayload({
        name,
        category,
        props: '1',
        formality: '2',
        pattern: 'solid',
        color: [color],
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const post = (url: string, fields: Fields, cookie?: string) => {
    const form = formPayload(fields);
    return t.inject({
      method: 'POST',
      url,
      payload: form.payload,
      headers: { ...form.headers, ...(cookie ? { cookie } : {}) },
    });
  };
  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  /** A saved outfit of the owner's, of these garments. */
  const outfitOf = async (garmentIds: number[], ownerId = t.owner.id) => {
    const saved = await pickIdea(t.db, ownerId, {
      garmentIds,
      origin: 'person',
      madeBy: BY_PERSON,
    });
    if (saved === 'not-found') throw new Error('garments not found');
    return saved.id;
  };

  /** The outfit planned as the plan page posts it; the entry's id. */
  const plan = async (
    outfitId: number,
    day: IsoDate,
    occasion: Occasion,
    cookie?: string,
  ) => {
    const res = await post(
      '/calendar',
      { date: day, outfitId: String(outfitId), occasion },
      cookie,
    );
    expect(res.statusCode).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
      );
    return entry.id;
  };

  /** The day's entries for an occasion, as rows. */
  const entriesFor = (day: IsoDate, occasion: Occasion) =>
    t.db
      .select({
        id: outfitCalendar.id,
        outfitId: outfitCalendar.outfitId,
        plannedBy: outfitCalendar.plannedBy,
        wornAt: outfitCalendar.wornAt,
      })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.ownerId, t.owner.id),
          eq(outfitCalendar.day, day),
          eq(outfitCalendar.occasion, occasion),
        ),
      )
      .orderBy(asc(outfitCalendar.id));

  const outfitExists = async (id: number) =>
    (await t.db.$count(outfit, eq(outfit.id, id))) === 1;

  /** An entry as "Plan my week" writes it (plan.ts: pickIdea with 'auto', then its batch row). */
  const planAuto = async (
    garmentIds: number[],
    day: IsoDate,
    occasion: Occasion,
  ) =>
    asFixture(t.db, async (tx) => {
      const weekPlanId = await createWeekPlan(tx, t.owner.id);
      const picked = await pickIdea(tx, t.owner.id, {
        garmentIds,
        plan: { day, occasion },
        origin: 'planner',
        madeBy: BY_PERSON,
      });
      if (picked === 'not-found') throw new Error('garments not found');
      const [entry] = await tx
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.outfitId, picked.id),
            eq(outfitCalendar.day, day),
          ),
        );
      await recordAutoEntry(tx, {
        entryId: entry.id,
        weekPlanId,
        outfitCreated: !picked.alreadySaved,
        needs: null,
      });
      return { entryId: entry.id, outfitId: picked.id };
    });

  // Every test starts without outfits or entries (a plain delete is fine:
  // nothing here is worn history another test needs).
  const clear = async () => {
    await asFixture(t.db, (tx) => tx.delete(outfit));
    await asFixture(t.db, (tx) => tx.delete(weekPlan));
  };

  beforeAll(async () => {
    t = await createTestApp();
    tops = [
      await garmentIn('White tee', 'tops', 'white'),
      await garmentIn('Grey tee', 'tops', 'grey'),
      await garmentIn('Black tee', 'tops', 'black'),
    ];
    bottoms = [
      await garmentIn('Jeans', 'bottoms', 'blue'),
      await garmentIn('Chinos', 'bottoms', 'beige'),
    ];
    shoes = [
      await garmentIn('Sneakers', 'footwear', 'white'),
      await garmentIn('Boots', 'footwear', 'brown'),
    ];
  });

  afterAll(() => t?.cleanup());

  beforeEach(clear);

  describe('from the plan page (POST /calendar with replace)', () => {
    it('puts the saved outfit in the entry’s place: one entry for the occasion, the person’s choice', async () => {
      const day = addDays(t.today(), 2);
      const first = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const second = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const entryId = await plan(first, day, 'evening');

      t.logs.clear();
      const res = await post('/calendar', {
        date: day,
        outfitId: String(second),
        occasion: 'evening',
        week: day,
        replace: String(entryId),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/calendar?week=${day}`);
      expect(await entriesFor(day, 'evening')).toEqual([
        { id: entryId, outfitId: second, plannedBy: 'user', wornAt: null },
      ]);
      // The outfit it held was the person's: it stays in their list.
      expect(await outfitExists(first)).toBe(true);
      expect(t.logs.ops('calendar.entry.changed').at(-1)).toMatchObject({
        userId: t.owner.id,
        surface: 'page',
        entryId,
        day,
        occasion: 'evening',
        previousOutfitId: first,
        outfitId: second,
        changed: true,
        outfitCreated: false,
        plannerOutfitsRemoved: 0,
      });
    });

    it('refuses the outfit already on the day, naming its occasion, and changes nothing', async () => {
      const day = addDays(t.today(), 3);
      const lunch = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const dinner = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const entryId = await plan(lunch, day, 'daytime');
      await plan(dinner, day, 'evening');

      const res = await post('/calendar', {
        date: day,
        outfitId: String(dinner),
        occasion: 'daytime',
        replace: String(entryId),
      });
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain(
        'That outfit is already planned on this day (Evening).',
      );
      expect(await entriesFor(day, 'daytime')).toMatchObject([
        { id: entryId, outfitId: lunch },
      ]);
    });

    it('rolls back a pick’s takeover of a planner outfit when the outfit is already on the day', async () => {
      const day = addDays(t.today(), 3);
      const entry = await planAuto(
        [tops[0], bottoms[0], shoes[0]],
        day,
        'work',
      );
      const other = await planAuto(
        [tops[1], bottoms[1], shoes[1]],
        day,
        'evening',
      );
      const created = () =>
        t.db
          .select({ outfitCreated: weekPlanEntry.outfitCreated })
          .from(weekPlanEntry)
          .where(eq(weekPlanEntry.entryId, other.entryId));
      expect(await created()).toEqual([{ outfitCreated: true }]);

      // The pick reuses the evening's planner outfit (taking it over), which is already on the day.
      const res = await post('/outfits/ideas/pick', {
        garmentId: [tops[1], bottoms[1], shoes[1]].map(String),
        for: `day:${day}`,
        occasion: 'work',
        replace: String(entry.entryId),
      });
      expect(res.statusCode).toBe(409);
      expect(await created()).toEqual([{ outfitCreated: true }]);
      expect(await entriesFor(day, 'work')).toMatchObject([
        { id: entry.entryId, outfitId: entry.outfitId },
      ]);
    });

    it('answers 404 for another user’s entry, and for the entry named on another day or occasion', async () => {
      const day = addDays(t.today(), 1);
      const mine = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const other = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const entryId = await plan(mine, day, 'work');

      const stranger = await t.register('stranger-replace@example.com');
      const theirs = await post(
        '/calendar',
        {
          date: day,
          outfitId: String(other),
          occasion: 'work',
          replace: String(entryId),
        },
        stranger,
      );
      // Their request names the owner's outfit too: not theirs either way.
      expect(theirs.statusCode).toBe(404);

      for (const [date, occasion] of [
        [addDays(day, 1), 'work'],
        [day, 'evening'],
      ] as const) {
        const res = await post('/calendar', {
          date,
          outfitId: String(other),
          occasion,
          replace: String(entryId),
        });
        expect(res.statusCode, `${date} ${occasion}`).toBe(404);
        expect(res.body).toContain('Calendar entry not found');
      }
      expect(await entriesFor(day, 'work')).toMatchObject([
        { id: entryId, outfitId: mine },
      ]);
    });

    it('is a 400 for a replace that is not an id', async () => {
      const res = await post('/calendar', {
        date: t.today(),
        outfitId: '1',
        replace: 'first',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('from the gallery (Today’s Change)', () => {
    it('makes the idea an outfit and puts it in the entry’s place, once however often it is tapped', async () => {
      const day = t.today();
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const entryId = await plan(planned, day, 'all-day');
      const idea = [tops[2], bottoms[1], shoes[1]];
      const pick = () =>
        post('/outfits/ideas/pick', {
          garmentId: idea.map(String),
          for: `day:${day}`,
          occasion: 'all-day',
          replace: String(entryId),
        });

      const first = await pick();
      expect(first.statusCode).toBe(303);
      expect(first.headers.location).toBe(`/calendar?week=${day}`);
      const [changed] = await entriesFor(day, 'all-day');
      expect(changed).toMatchObject({ id: entryId, plannedBy: 'user' });
      expect(changed.outfitId).not.toBe(planned);

      // The second tap finds the entry changed: nothing more is written.
      t.logs.clear();
      const second = await pick();
      expect(second.statusCode).toBe(303);
      expect(second.headers.location).toBe(
        `/calendar?week=${day}&alreadySaved=1`,
      );
      expect(await entriesFor(day, 'all-day')).toEqual([changed]);
      expect(await t.db.$count(outfit)).toBe(2);
      expect(t.logs.ops('calendar.entry.changed').at(-1)).toMatchObject({
        entryId,
        outfitId: changed.outfitId,
        changed: false,
        adopted: false,
      });
    });

    it('two replaces at the same moment change the entry once', async () => {
      const day = addDays(t.today(), 4);
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const entryId = await plan(planned, day, 'evening');
      const idea = [tops[1], bottoms[1], shoes[0]];
      const target = { entryId, day, occasion: 'evening' as const };
      const owner = { userId: t.owner.id, surface: 'page' as const };
      const [first, second] = await interleave(
        t.db,
        (tx) =>
          replaceEntryOutfit(
            { db: tx, logger: t.logger },
            owner,
            target,
            {
              garmentIds: idea,
              origin: 'idea',
            },
            BY_PERSON,
          ),
        () =>
          replaceEntryOutfit(
            { db: t.db, logger: t.logger },
            owner,
            target,
            {
              garmentIds: idea,
              origin: 'idea',
            },
            BY_PERSON,
          ),
      );
      expect(first).toMatchObject({ outcome: 'replaced', alreadySaved: false });
      expect(second).toMatchObject({
        outcome: 'unchanged',
        outfitId: (first as { outfitId: number }).outfitId,
      });
      expect(await entriesFor(day, 'evening')).toHaveLength(1);
      expect(await t.db.$count(outfit)).toBe(2);
    });

    it('refuses a worn entry, creating nothing, and says to add another outfit', async () => {
      const day = t.today();
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const entryId = await plan(planned, day, 'work');
      expect(
        (await post(`/calendar/${entryId}/worn`, { worn: '1' })).statusCode,
      ).toBe(303);

      const res = await post('/outfits/ideas/pick', {
        garmentId: [tops[1], bottoms[1], shoes[1]].map(String),
        for: `day:${day}`,
        occasion: 'work',
        replace: String(entryId),
      });
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain(
        'This outfit is marked worn, so it stays as the record of that day. Add another outfit to the day instead.',
      );
      const [kept] = await entriesFor(day, 'work');
      expect(kept).toMatchObject({ id: entryId, outfitId: planned });
      expect(kept.wornAt).not.toBeNull();
      // The idea was not saved either: the refusal comes first.
      expect(await t.db.$count(outfit)).toBe(1);
    });

    it('is a 400 for a replace without a day', async () => {
      const res = await post('/outfits/ideas/pick', {
        garmentId: [tops[0], bottoms[0]].map(String),
        replace: '1',
      });
      expect(res.statusCode).toBe(400);
      expect(await t.db.$count(outfit)).toBe(0);
    });
  });

  describe('the rules', () => {
    it('keeps the entry’s selfie on its day as a look, never on the new outfit', async () => {
      const day = t.today();
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const other = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const entryId = await plan(planned, day, 'evening');
      // A selfie marks the entry worn; unmarking keeps the photo (#19).
      const taken = await takeSelfie(t, entryId);
      expect(
        (await post(`/calendar/${entryId}/worn`, { worn: '0' })).statusCode,
      ).toBe(303);

      const res = await post('/calendar', {
        date: day,
        outfitId: String(other),
        occasion: 'evening',
        replace: String(entryId),
      });
      expect(res.statusCode).toBe(302);
      expect(
        await t.db
          .select({
            id: selfie.id,
            day: selfie.day,
            entry: selfie.outfitCalendarId,
          })
          .from(selfie),
      ).toEqual([{ id: taken.id, day, entry: null }]);
      const week = unescapeHtml((await get(`/calendar?week=${day}`)).body);
      expect(week).toContain(`data-looks="${day}"`);
      expect(week).toContain(taken.fileName);
    });

    it('removes the outfit "Plan my week" created for the entry once nothing holds it', async () => {
      const day = addDays(t.today(), 1);
      const auto = await planAuto([tops[0], bottoms[0], shoes[0]], day, 'work');
      const chosen = await outfitOf([tops[1], bottoms[1], shoes[1]]);

      const res = await post('/calendar', {
        date: day,
        outfitId: String(chosen),
        occasion: 'work',
        replace: String(auto.entryId),
      });
      expect(res.statusCode).toBe(302);
      expect(await entriesFor(day, 'work')).toEqual([
        {
          id: auto.entryId,
          outfitId: chosen,
          plannedBy: 'user',
          wornAt: null,
        },
      ]);
      expect(await outfitExists(auto.outfitId)).toBe(false);
    });

    // #883: the flag describes the outfit the entry holds, so a later remove
    // prunes only an outfit this entry made.
    it('sets the entry’s created flag for the outfit it now holds, and keeps it when the same outfit is chosen again', async () => {
      const day = addDays(t.today(), 1);
      const createdFlag = async (entryId: number) =>
        (
          await t.db
            .select({ outfitCreated: outfitCalendar.outfitCreated })
            .from(outfitCalendar)
            .where(eq(outfitCalendar.id, entryId))
        )[0].outfitCreated;
      const taken = await planAuto(
        [tops[0], bottoms[0], shoes[0]],
        day,
        'work',
      );
      expect(await createdFlag(taken.entryId)).toBe(true);
      // The person chooses the planner's outfit again: taken over, nothing else.
      expect(
        (
          await post('/calendar', {
            date: day,
            outfitId: String(taken.outfitId),
            occasion: 'work',
            replace: String(taken.entryId),
          })
        ).statusCode,
      ).toBe(302);
      expect(await entriesFor(day, 'work')).toMatchObject([
        { id: taken.entryId, outfitId: taken.outfitId, plannedBy: 'user' },
      ]);
      expect(await createdFlag(taken.entryId)).toBe(true);

      // A saved outfit in its place was not made by the entry.
      const saved = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const replaced = await post('/calendar', {
        date: day,
        outfitId: String(saved),
        occasion: 'work',
        replace: String(taken.entryId),
      });
      expect(replaced.statusCode).toBe(302);
      expect(await createdFlag(taken.entryId)).toBe(false);
    });

    it('keeps a planner-made outfit another entry still holds, and one the person took over', async () => {
      const day = addDays(t.today(), 2);
      const held = await planAuto([tops[0], bottoms[0], shoes[0]], day, 'work');
      // The same outfit planned by hand on another day: someone holds it.
      await plan(held.outfitId, addDays(day, 1), 'evening');
      const takenOver = await planAuto(
        [tops[1], bottoms[1], shoes[1]],
        day,
        'evening',
      );
      // Editing the outfit makes the entry the person's (#16).
      await asFixture(t.db, (tx) =>
        tx
          .update(outfitCalendar)
          .set({ plannedBy: 'user' })
          .where(eq(outfitCalendar.id, takenOver.entryId)),
      );
      const chosen = [
        await outfitOf([tops[2], bottoms[0], shoes[1]]),
        await outfitOf([tops[2], bottoms[1], shoes[0]]),
      ];

      for (const [entry, occasion, outfitId] of [
        [held, 'work', chosen[0]],
        [takenOver, 'evening', chosen[1]],
      ] as const) {
        const res = await post('/calendar', {
          date: day,
          outfitId: String(outfitId),
          occasion,
          replace: String(entry.entryId),
        });
        expect(res.statusCode).toBe(302);
        expect(await outfitExists(entry.outfitId), occasion).toBe(true);
      }
    });

    it('keeps a planner-made outfit a trip holds, with the trip’s packing list', async () => {
      const day = addDays(t.today(), 1);
      const auto = await planAuto([tops[0], bottoms[1], shoes[1]], day, 'work');
      const tripId = await createTrip(t.db, t.owner.id, {
        name: 'Austin',
        destination: null,
        startsOn: addDays(day, 3),
        endsOn: addDays(day, 5),
        notes: null,
      });
      expect(
        await addTripOutfit(t.db, {
          tripId,
          ownerId: t.owner.id,
          outfitId: auto.outfitId,
          madeBy: BY_PERSON,
        }),
      ).toBe('added');
      const chosen = await outfitOf([tops[1], bottoms[0], shoes[0]]);

      const res = await post('/calendar', {
        date: day,
        outfitId: String(chosen),
        occasion: 'work',
        replace: String(auto.entryId),
      });
      expect(res.statusCode).toBe(302);
      expect(await entriesFor(day, 'work')).toMatchObject([
        { id: auto.entryId, outfitId: chosen },
      ]);
      expect(await outfitExists(auto.outfitId)).toBe(true);
      expect(
        await t.db.$count(
          tripOutfit,
          and(
            eq(tripOutfit.tripId, tripId),
            eq(tripOutfit.outfitId, auto.outfitId),
          ),
        ),
      ).toBe(1);
      const model = await tripModel(t.db, t.owner.id, tripId, t.today());
      expect(model!.undated.map((o) => o.outfitId)).toEqual([auto.outfitId]);
      expect(model!.packing.garments).toBe(3);
    });

    it('keeps an outfit the planner found already saved: it was the person’s', async () => {
      const day = addDays(t.today(), 3);
      const saved = await outfitOf([tops[0], bottoms[1], shoes[0]]);
      const auto = await planAuto([tops[0], bottoms[1], shoes[0]], day, 'work');
      expect(auto.outfitId).toBe(saved);
      const chosen = await outfitOf([tops[1], bottoms[0], shoes[1]]);
      const res = await post('/calendar', {
        date: day,
        outfitId: String(chosen),
        occasion: 'work',
        replace: String(auto.entryId),
      });
      expect(res.statusCode).toBe(302);
      expect(await outfitExists(saved)).toBe(true);
    });
  });

  describe('the pages', () => {
    it('the calendar row offers Change on an unworn entry only, to the plan page for its place', async () => {
      const day = t.today();
      const worn = await plan(
        await outfitOf([tops[0], bottoms[0], shoes[0]]),
        day,
        'work',
      );
      const open = await plan(
        await outfitOf([tops[1], bottoms[1], shoes[1]]),
        day,
        'evening',
      );
      await post(`/calendar/${worn}/worn`, { worn: '1' });
      const week = unescapeHtml((await get(`/calendar?week=${day}`)).body);
      expect(week).toContain(
        `href="/calendar/plan?for=day:${day}&occasion=evening&replace=${open}"`,
      );
      expect(week).not.toContain(`replace=${worn}`);
    });

    it('the plan page opened to change an entry changes it; for a worn one it plans another and says why', async () => {
      const day = addDays(t.today(), -1);
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const entryId = await plan(planned, day, 'evening');
      const url = `/calendar/plan?for=day:${day}&occasion=evening&replace=${entryId}`;

      const res = await get(url);
      expectFullPage(res);
      expectNativePostForms(res);
      expectNoScriptNavigation(res);
      const page = unescapeHtml(res.body);
      expect(page).toContain('Change outfit');
      expect(page).toContain(`data-replacing="${entryId}"`);
      expect(page).toContain(`name="replace" value="${entryId}"`);
      expect(page).toContain(
        `href="/outfits/ideas?for=day:${day}&occasion=evening&replace=${entryId}"`,
      );
      // The occasion is the entry's, and the builder would add.
      expect(page).not.toContain('Build a new outfit');
      expect(page).not.toContain(`aria-current="true"`);

      await post(`/calendar/${entryId}/worn`, { worn: '1' });
      const worn = unescapeHtml((await get(url)).body);
      expect(worn).toContain('Plan an outfit');
      expect(worn).toContain('is marked worn, so it stays as the record');
      expect(worn).not.toContain('name="replace"');

      // Another user's entry, or a mangled one: the page plans another.
      const stranger = await t.register('stranger-plan@example.com');
      const theirs = unescapeHtml((await get(url, stranger)).body);
      expect(theirs).toContain('Plan an outfit');
      expect(theirs).not.toContain('name="replace"');
      const mangled = await get(
        `/calendar/plan?for=day:${day}&occasion=evening&replace=abc`,
      );
      expect(mangled.statusCode).toBe(200);
    });

    it('Today’s Change opens the gallery for the entry’s place, whose picks carry it', async () => {
      const day = t.today();
      const entryId = await plan(
        await outfitOf([tops[0], bottoms[0], shoes[0]]),
        day,
        'all-day',
      );
      const today = unescapeHtml((await get('/')).body);
      const ideasUrl = `/outfits/ideas?for=day:${day}&occasion=all-day&replace=${entryId}`;
      expect(today).toContain(`href="${ideasUrl}"`);

      const gallery = await get(ideasUrl);
      expectFullPage(gallery);
      expectNativePostForms(gallery);
      const page = unescapeHtml(gallery.body);
      expect(page).toContain('Changing ');
      expect(page).toContain('Wear this instead');
      expect(page).toContain(`name="replace" value="${entryId}"`);
      // Its back link is the plan page for the same change.
      expect(page).toContain(
        `href="/calendar/plan?for=day:${day}&occasion=all-day&replace=${entryId}"`,
      );
    });
  });

  describe('MCP: schedule_outfit with replaceEntryId', () => {
    it('logs a refused replace with the tool and the refusal’s detail', async () => {
      const token = await createAccessToken(t);
      const day = addDays(t.today(), 2);
      const lunch = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const dinner = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const entryId = await plan(lunch, day, 'daytime');
      await plan(dinner, day, 'evening');

      t.logs.clear();
      const refused = await callTool(t, token, 'schedule_outfit', {
        outfitId: dinner,
        date: day,
        replaceEntryId: entryId,
      });
      expect(refused.isError).toBe(true);
      expect(t.logs.messages('warn', 'Mcp')).toEqual([]);
      const lines = t.logs
        .messages('info', 'Mcp')
        .filter((m) => m.includes('MCP schedule_outfit'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`refused 409 (Calendar entry ${entryId}`);
      expect(lines[0]).toContain(
        ': That outfit is already planned on this day (Evening).',
      );
    });

    it('changes the entry, refuses a worn one, and is a 404 for another’s', async () => {
      const token = await createAccessToken(t);
      const day = t.today();
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const chosen = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const entryId = await plan(planned, day, 'daytime');

      const answer = await tool(t, token, 'schedule_outfit', {
        outfitId: chosen,
        date: day,
        replaceEntryId: entryId,
      });
      expect(answer).toEqual({
        outcome: 'replaced',
        date: day,
        occasion: 'daytime',
        entryId,
        previousOutfitId: planned,
        selfieKeptAsLook: false,
        plannerOutfitRemoved: false,
      });
      // A retry changes nothing.
      expect(
        await tool(t, token, 'schedule_outfit', {
          outfitId: chosen,
          date: day,
          replaceEntryId: entryId,
        }),
      ).toMatchObject({ outcome: 'unchanged' });
      expect(await entriesFor(day, 'daytime')).toMatchObject([
        { id: entryId, outfitId: chosen },
      ]);

      await post(`/calendar/${entryId}/worn`, { worn: '1' });
      const worn = await callTool(t, token, 'schedule_outfit', {
        outfitId: planned,
        date: day,
        replaceEntryId: entryId,
      });
      expect(worn.isError).toBe(true);
      expect(JSON.stringify(worn.value)).toContain('marked worn');

      const strangerCookie = await t.register('stranger-mcp@example.com');
      const theirToken = await createAccessToken(t, {
        cookie: strangerCookie,
      });
      const theirs = await callTool(t, theirToken, 'schedule_outfit', {
        outfitId: planned,
        date: day,
        replaceEntryId: entryId,
      });
      expect(theirs.isError).toBe(true);
      expect(JSON.stringify(theirs.value)).toContain('not found');
    });
  });
});
