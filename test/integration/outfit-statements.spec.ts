import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outfitCalendar, outfitSlot } from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { createGarment } from './garments';
import {
  createTestApp,
  hasText,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';

/**
 * What each Outfits page and write costs in statements (#164): production
 * reaches Postgres over a link of ~114 ms a round trip, so the count is
 * the latency. Every read after the session's is one statement whatever
 * the outfits hold (page-context.ts); an edit and a delete cost the same
 * with or without wears, and one more only on a trip (the prune). The
 * behaviour of each route is its own spec's (outfits, saved-outfits,
 * outfit-saves, wears, trips); this one pins the statements, and proves
 * the reads that were narrowed feed nothing the page shows.
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

describe('outfit statements (#164)', () => {
  let t: TestApp;
  let today: string;
  let tee: number;
  let jeans: number;

  const post = (url: string, fields: Record<string, string | string[]>) =>
    t.inject({ method: 'POST', url, ...form(fields) });

  /** An outfit of the tee, the jeans and shoes of its own (one garment set, one outfit). */
  const newOutfit = async (name: string, notes = '') => {
    const shoes = await createGarment(t, {
      name: `${name} shoes`,
      category: 'footwear',
    });
    const res = await post('/outfits', {
      name,
      notes,
      category: ['tops', 'bottoms', 'footwear'],
      garmentId: [tee, jeans, shoes].map(String),
    });
    expect(res.statusCode).toBe(302);
    return {
      id: Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]),
      shoes,
    };
  };

  /** Planned on `day`, and marked worn when asked (a day that has passed). */
  const planned = async (outfitId: number, day: string, worn = false) => {
    expect(
      (await post('/calendar', { outfitId: String(outfitId), date: day }))
        .statusCode,
    ).toBe(302);
    if (!worn) return;
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
      );
    const marked = await t.inject({
      method: 'POST',
      url: `/calendar/${entry.id}/worn`,
      ...form({ worn: '1' }),
    });
    expect(marked.statusCode).toBe(303);
  };

  const onTrip = async (outfitId: number) => {
    const trip = await post('/trips', {
      name: 'Statements trip',
      destination: '',
      startsOn: addDays(today, 3),
      endsOn: addDays(today, 5),
      notes: '',
    });
    expect(trip.statusCode).toBe(303);
    const tripId = Number(
      /^\/trips\/(\d+)/.exec(String(trip.headers.location))![1],
    );
    const added = await post(`/trips/${tripId}/outfits`, {
      outfitId: String(outfitId),
      day: '',
      occasion: '',
    });
    expect(added.statusCode).toBe(303);
  };

  const slotsOf = async (outfitId: number) =>
    t.db
      .select({
        position: outfitSlot.position,
        category: outfitSlot.category,
        garmentId: outfitSlot.garmentId,
      })
      .from(outfitSlot)
      .where(eq(outfitSlot.outfitId, outfitId))
      .orderBy(asc(outfitSlot.position));

  beforeAll(async () => {
    t = await createTestApp();
    today = t.today();
    tee = await createGarment(t, { name: 'Statement tee', category: 'tops' });
    jeans = await createGarment(t, {
      name: 'Statement jeans',
      category: 'bottoms',
    });
  });

  afterAll(() => t?.cleanup());

  describe('the pages', () => {
    it('reads the Saved tab in one statement, however many outfits and entries', async () => {
      const worn = await newOutfit('Worn one', 'A note no tile shows');
      await planned(worn.id, addDays(today, -2), true);
      await planned(worn.id, addDays(today, 4));
      await newOutfit('Never planned');
      const load = () => t.inject({ method: 'GET', url: '/outfits' });
      const recorded = await recordQueries(load);
      // The session's user row, then the tiles with their activity and
      // The agent's outfits with what their pieces unlock (#335), in one.
      expect(recorded.statements).toBe(2);
      // The tiles read no notes and no share link: the page shows neither.
      const read = recorded.sql
        .slice(1)
        .find((text) => text.includes('"outfit"'));
      expect(read).not.toMatch(/"notes"|"shareable_id"/);
      const html = unescapeHtml((await load()).body);
      expect(hasText(html, 'Worn one')).toBe(true);
      expect(html).not.toContain('A note no tile shows');
    });

    it('reads the day to pick for in the same statement', async () => {
      const day = addDays(today, 6);
      const recorded = await recordQueries(() =>
        t.inject({ method: 'GET', url: `/outfits?for=day:${day}` }),
      );
      expect(recorded.statements).toBe(2);
    });

    it('reads the outfit page, its plans and its Worn strip in one statement', async () => {
      const outfit = await newOutfit('Page one', 'Shown on its page');
      await planned(outfit.id, addDays(today, -5), true);
      await planned(outfit.id, addDays(today, -1), true);
      await planned(outfit.id, addDays(today, 2));
      let html = '';
      const recorded = await recordQueries(async () => {
        const res = await t.inject({
          method: 'GET',
          url: `/outfits/${outfit.id}`,
        });
        expect(res.statusCode).toBe(200);
        html = unescapeHtml(res.body);
      });
      expect(recorded.statements).toBe(2);
      expect(hasText(html, 'Shown on its page')).toBe(true);
      expect(html.match(/data-worn-day=/g)).toHaveLength(2);
      expect(html.match(/data-planned-entry=/g)).toHaveLength(1);
    });

    it('answers an outfit that is not the owner’s in as many, with a 404', async () => {
      const other = await t.register('statements-other@example.com');
      const theirs = await t.inject({
        method: 'GET',
        url: '/outfits',
        headers: { cookie: other },
      });
      expect(theirs.statusCode).toBe(200);
      const outfit = await newOutfit('Not theirs');
      const recorded = await recordQueries(async () => {
        const res = await t.inject({
          method: 'GET',
          url: `/outfits/${outfit.id}`,
          headers: { cookie: other },
        });
        expect(res.statusCode).toBe(404);
      });
      expect(recorded.statements).toBe(2);
    });
  });

  describe('edit', () => {
    // The session; begin and the owner lock; the outfit locked with its
    // fields and the planner's entries claimed; the slots; the trips it is
    // on; commit.
    const EDIT = 7;

    const edit = (id: number, fields: Record<string, string | string[]>) =>
      recordQueries(async () => {
        const res = await post(`/outfits/${id}`, fields);
        expect(res.statusCode).toBe(302);
      });

    it('costs as many with a rename or without, and one more on a trip', async () => {
      const outfit = await newOutfit('Edited');
      const rows = {
        category: ['tops', 'bottoms', 'footwear'],
        garmentId: [tee, jeans, outfit.shoes].map(String),
      };
      expect(
        (await edit(outfit.id, { name: 'Renamed', ...rows })).statements,
      ).toBe(EDIT);
      expect((await edit(outfit.id, rows)).statements).toBe(EDIT);
      await onTrip(outfit.id);
      // The prune of its trips' packed marks.
      expect((await edit(outfit.id, rows)).statements).toBe(EDIT + 1);
    });

    it('replaces the slots in place: fewer rows trim the rest, more add them', async () => {
      const outfit = await newOutfit('Resized');
      await edit(outfit.id, {
        category: ['footwear'],
        garmentId: [String(outfit.shoes)],
      });
      expect(await slotsOf(outfit.id)).toEqual([
        { position: 0, category: 'footwear', garmentId: outfit.shoes },
      ]);
      const recorded = await edit(outfit.id, {
        category: ['bottoms', 'tops', 'accessories'],
        garmentId: [String(jeans), String(tee), ''],
      });
      expect(recorded.statements).toBe(EDIT);
      expect(await slotsOf(outfit.id)).toEqual([
        { position: 0, category: 'bottoms', garmentId: jeans },
        { position: 1, category: 'tops', garmentId: tee },
        { position: 2, category: 'accessories', garmentId: null },
      ]);
    });
  });

  describe('delete', () => {
    // The session; begin and the owner lock; the outfit locked; its wears
    // detached; its trips read and the outfit deleted; commit.
    const DELETE = 7;

    const remove = (id: number) =>
      recordQueries(async () => {
        const res = await t.inject({
          method: 'DELETE',
          url: `/outfits/${id}`,
          headers: { 'hx-request': 'true' },
        });
        expect(res.statusCode).toBe(200);
      });

    it('costs as many whether it was worn or not, and one more on a trip', async () => {
      const unworn = await newOutfit('Deleted unworn');
      expect((await remove(unworn.id)).statements).toBe(DELETE);
      const worn = await newOutfit('Deleted worn');
      await planned(worn.id, addDays(today, -3), true);
      expect((await remove(worn.id)).statements).toBe(DELETE);
      const packed = await newOutfit('Deleted on a trip');
      await onTrip(packed.id);
      expect((await remove(packed.id)).statements).toBe(DELETE + 1);
    });
  });
});
