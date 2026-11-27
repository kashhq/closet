import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment as garmentTable,
  outfit as outfitTable,
  outfitCalendar,
  outfitSlot,
} from '../../src/db/schema';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import {
  createTestApp,
  hasText,
  hxLocationPath,
  imgTags,
  recordQueries,
  TestApp,
  unescapeHtml,
} from './harness';

/**
 * Outfits end to end: the list, the detail page, create/edit/delete as the
 * outfit form posts them (urlencoded, one category + garmentId pair per
 * row: pages the installed app cached before Styling replaced the builder,
 * #42, and the fixtures other specs build through it), and scheduling from
 * the form. Proves the rendered HTML and the outfit_slot rows agree. The
 * composer itself is Styling's (test/integration/styling.spec.ts).
 */

/** A saved outfit_slot row, as the tests compare them. */
interface SavedSlot {
  category: string;
  garmentId: number | null;
}

/** One builder row as the form posts it: category plus garment (or none). */
type Slot = [category: string, garmentId: number | null];

interface OutfitFields {
  name?: string;
  notes?: string;
  scheduleDate?: string;
  returnTo?: string;
  returnToWeek?: string;
}

/** The body the outfit form (src/web/outfits/form-page.tsx) submits, in document order. */
function outfitForm(fields: OutfitFields, slots: Slot[]) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields) as [string, string?][]) {
    if (value !== undefined) form.append(key, value);
  }
  for (const [category, garmentId] of slots) {
    form.append('category', category);
    form.append('garmentId', garmentId == null ? '' : String(garmentId));
  }
  return {
    payload: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

const byId = (a: number, b: number) => a - b;

function outfitIdFrom(location: unknown): number {
  const target = String(location);
  const match = /^\/outfits\/(\d+)$/.exec(target);
  if (!match) throw new Error(`Unexpected outfit redirect: ${target}`);
  return Number(match[1]);
}

/** A Saved tile's markup, from its data-outfit-id to the next tile's. */
function tileOf(html: string, outfitId: number): string {
  const start = html.indexOf(`data-outfit-id="${outfitId}"`);
  if (start === -1) throw new Error(`No tile for outfit ${outfitId}`);
  const end = html.indexOf('data-outfit-id="', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

/** Garment links on the show page, in rendered order. */
function shownGarmentIds(html: string): number[] {
  return [...html.matchAll(/href="\/wardrobe\/(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
}

describe('outfits', () => {
  let t: TestApp;

  const createOutfit = async (
    fields: OutfitFields,
    slots: Slot[],
  ): Promise<number> => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...outfitForm(fields, slots),
    });
    expect(res.statusCode).toBe(302);
    return outfitIdFrom(res.headers.location);
  };

  const updateOutfit = (id: number, fields: OutfitFields, slots: Slot[]) =>
    t.inject({
      method: 'POST',
      url: `/outfits/${id}`,
      ...outfitForm(fields, slots),
    });

  /** The garments an outfit's slots name, ascending (the membership set). */
  const slotGarmentIds = async (outfitId: number): Promise<number[]> =>
    (
      await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(
          and(
            eq(outfitSlot.outfitId, outfitId),
            isNotNull(outfitSlot.garmentId),
          ),
        )
    )
      .map((row) => row.garmentId!)
      .sort(byId);

  const savedSlots = (outfitId: number): Promise<SavedSlot[]> =>
    t.db
      .select({
        category: outfitSlot.category,
        garmentId: outfitSlot.garmentId,
      })
      .from(outfitSlot)
      .where(eq(outfitSlot.outfitId, outfitId))
      .orderBy(asc(outfitSlot.position));

  const outfitRow = async (id: number) => {
    const [row] = await t.db
      .select()
      .from(outfitTable)
      .where(eq(outfitTable.id, id));
    return row;
  };

  const outfitCount = async () =>
    (await t.db.select({ n: count() }).from(outfitTable))[0].n;

  const calendarEntries = (outfitId: number) =>
    t.db
      .select()
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId))
      .orderBy(asc(outfitCalendar.id));

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  // Runs first, while the wardrobe is still empty.
  it('GET /outfits shows its empty state before any outfit exists', async () => {
    const list = await t.inject({ method: 'GET', url: '/outfits' });
    expect(list.statusCode).toBe(200);
    expect(hasText(list.body, 'No saved outfits.')).toBe(true);
    expect(list.body).toContain('href="/styling"');
  });

  describe('POST /outfits', () => {
    it('stores one slot per row, in order, empty rows included', async () => {
      const top = await createGarment(t, { name: 'Linen', category: 'tops' });
      const pants = await createGarment(t, {
        name: 'Chinos',
        category: 'bottoms',
      });

      const id = await createOutfit({ name: 'Brunch', notes: 'Sunny' }, [
        ['tops', top],
        ['footwear', null],
        ['bottoms', pants],
      ]);

      const outfit = await outfitRow(id);
      expect(outfit.name).toBe('Brunch');
      expect(outfit.notes).toBe('Sunny');
      expect(outfit.ownerId).toBe(t.owner.id);
      // No public link until Share is tapped (#669).
      expect(outfit.shareableId).toBeNull();
      expect(await savedSlots(id)).toEqual([
        { category: 'tops', garmentId: top },
        { category: 'footwear', garmentId: null },
        { category: 'bottoms', garmentId: pants },
      ]);
      expect(await calendarEntries(id)).toHaveLength(0);
    });

    // #219: never a slot stored empty behind the save's back. The garment
    // is not theirs, so the answer is a 404 like any unknown id.
    it('refuses a garment id that is not in the wardrobe, writing nothing', async () => {
      const top = await createGarment(t, { name: 'Polo', category: 'tops' });
      const before = await outfitCount();
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...outfitForm({ name: 'Tampered' }, [
          ['tops', top],
          ['bottoms', 999_999],
        ]),
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain(
        'Not saved: a garment you chose is no longer in your wardrobe.',
      );
      expect(await outfitCount()).toBe(before);
    });

    it('accepts a single row (scalar fields, not arrays) and an empty outfit', async () => {
      const top = await createGarment(t, { name: 'Tee', category: 'tops' });
      const single = await createOutfit({ name: 'Single' }, [['tops', top]]);
      expect(await savedSlots(single)).toEqual([
        { category: 'tops', garmentId: top },
      ]);

      const empty = await createOutfit({}, []);
      expect(await savedSlots(empty)).toEqual([]);
      // A blank name is no name: the pages say "Untitled outfit".
      expect((await outfitRow(empty)).name).toBeNull();
    });

    it.each([
      ['a row without its garment id', 'category=tops&name=Unpaired'],
      ['a garment id that is not an id', 'category=tops&garmentId=abc'],
      ['a blank category', 'category=%20&garmentId='],
      ['a name longer than its cap', `name=${'x'.repeat(256)}`],
      ['notes longer than their cap', `notes=${'x'.repeat(4001)}`],
    ])('400s %s and writes nothing', async (_label, payload) => {
      const before = await outfitCount();
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.statusCode).toBe(400);
      expect(await outfitCount()).toBe(before);
    });

    it('keeps notes longer than the old varchar(255) whole', async () => {
      const notes = 'Layer it. '.repeat(100).trim();
      const id = await createOutfit({ name: 'Wordy', notes }, []);
      expect((await outfitRow(id)).notes).toBe(notes);
    });

    it('schedules the new outfit and returns to that calendar week', async () => {
      const top = await createGarment(t, { name: 'Oxford', category: 'tops' });
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...outfitForm(
          {
            name: 'Planned',
            scheduleDate: '2026-10-14',
            returnTo: '/calendar',
          },
          [['tops', top]],
        ),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/calendar?week=2026-10-14');

      const [outfit] = await t.db
        .select({ id: outfitTable.id })
        .from(outfitTable)
        .where(eq(outfitTable.name, 'Planned'));
      const entries = await calendarEntries(outfit.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].day).toBe('2026-10-14');
      expect(entries[0].wornAt).toBeFalsy();
    });

    it('prefers returnToWeek over the schedule date for the calendar redirect', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...outfitForm(
          {
            name: 'Week redirect',
            scheduleDate: '2026-10-15',
            returnTo: '/calendar',
            returnToWeek: '2026-10-11',
          },
          [],
        ),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/calendar?week=2026-10-11');
    });

    it('rejects an invalid schedule date without saving a half-written outfit', async () => {
      const before = await outfitCount();
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...outfitForm({ name: 'Bad date', scheduleDate: 'garbage' }, []),
      });
      expect(res.statusCode).toBe(400);
      expect(await outfitCount()).toBe(before);
    });

    // The outfit, its slots and its calendar entry commit together: a
    // failure after the outfit row is written leaves nothing behind.
    it('rolls the outfit back when scheduling it fails', async () => {
      const before = await outfitCount();
      const top = await createGarment(t, {
        name: 'Rollback',
        category: 'tops',
      });
      // A day Postgres rejects but the schema accepts cannot be posted (both
      // use the full-date rule), so break the insert at the database: the
      // calendar table refuses writes for the length of this request.
      await t.db.execute(
        sql`create function refuse_entry() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`,
      );
      await t.db.execute(
        sql`create trigger refuse_entry before insert on outfit_calendar for each row execute function refuse_entry()`,
      );
      try {
        const res = await t.inject({
          method: 'POST',
          url: '/outfits',
          ...outfitForm({ name: 'Doomed plan', scheduleDate: '2026-11-02' }, [
            ['tops', top],
          ]),
        });
        expect(res.statusCode).toBe(500);
      } finally {
        await t.db.execute(sql`drop trigger refuse_entry on outfit_calendar`);
        await t.db.execute(sql`drop function refuse_entry()`);
      }
      expect(await outfitCount()).toBe(before);
      const [orphans] = await t.db
        .select({ n: count() })
        .from(outfitSlot)
        .where(eq(outfitSlot.garmentId, top));
      expect(orphans.n).toBe(0);
    });
  });

  describe('GET /outfits and GET /outfits/:id', () => {
    it('lists every outfit as a tile linking to it, with no calendar form (R5)', async () => {
      const a = await createOutfit({ name: 'Office', notes: 'Mondays' }, []);
      const b = await createOutfit({ name: 'Gym' }, []);

      const res = await t.inject({ method: 'GET', url: '/outfits' });
      expect(res.statusCode).toBe(200);
      for (const [id, name] of [
        [a, 'Office'],
        [b, 'Gym'],
      ] as const) {
        expect(res.body).toMatch(
          new RegExp(`<a href="/outfits/${id}"[^>]*data-outfit-id="${id}"`),
        );
        expect(hasText(tileOf(res.body, id), name)).toBe(true);
      }
      // The per-card "add to calendar" dropdown is gone: Plan is the
      // outfit page's, and the grid posts nothing without ?for=.
      expect(res.body).not.toContain('action="/calendar"');
      expect(res.body).not.toContain('hx-post="/calendar"');
      // Notes are the outfit page's.
      expect(hasText(res.body, 'Mondays')).toBe(false);
      expect(hasText(res.body, 'No saved outfits.')).toBe(false);
    });

    it('shows an outfit with its garments, notes and edit/delete actions', async () => {
      const top = await createGarment(t, {
        name: 'Silk top',
        category: 'tops',
      });
      const id = await createOutfit({ name: 'Gala', notes: 'Black tie' }, [
        ['tops', top],
        ['footwear', null],
      ]);

      const res = await t.inject({ method: 'GET', url: `/outfits/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<h1[^>]*>Gala<\/h1>/);
      expect(hasText(res.body, 'Black tie')).toBe(true);
      expect(shownGarmentIds(res.body)).toEqual([top]);
      expect(hasText(res.body, 'Silk top')).toBe(true);
      // Edit is Styling with the outfit open (#42).
      expect(unescapeHtml(res.body)).toContain(
        `href="/styling?outfit=${id}&returnTo=%2Foutfits%2F${id}"`,
      );
      expect(res.body).toContain(`hx-delete="/outfits/${id}"`);
    });

    it('404s an unknown outfit and 400s a non-numeric id', async () => {
      expect(
        (await t.inject({ method: 'GET', url: '/outfits/999999' })).statusCode,
      ).toBe(404);
      expect(
        (await t.inject({ method: 'GET', url: '/outfits/abc/edit' }))
          .statusCode,
      ).toBe(400);
    });

    describe('garment order', () => {
      // Built bottom-up: the saved order is the reverse of creation (id) order.
      let outfitId: number;
      let saved: number[];

      beforeAll(async () => {
        const top = await createGarment(t, {
          name: 'Order top',
          category: 'tops',
        });
        const pants = await createGarment(t, {
          name: 'Order pants',
          category: 'bottoms',
        });
        const shoes = await createGarment(t, {
          name: 'Order shoes',
          category: 'footwear',
        });
        for (const id of [top, pants, shoes]) {
          await uploadPhoto(t, id, await jpegPhoto(64, 64));
        }
        saved = [shoes, pants, top];
        outfitId = await createOutfit({ name: 'Ordered' }, [
          ['footwear', shoes],
          ['bottoms', pants],
          ['tops', top],
        ]);
      });

      it('the show page renders garments in the saved order', async () => {
        const res = await t.inject({
          method: 'GET',
          url: `/outfits/${outfitId}`,
        });
        expect(shownGarmentIds(res.body)).toEqual(saved);
      });

      it('the list lays the garments out top to toe, whatever the saved order', async () => {
        const res = await t.inject({ method: 'GET', url: '/outfits' });
        const alts = imgTags(tileOf(res.body, outfitId)).map(
          (tag) => /alt="([^"]*)"/.exec(tag)?.[1],
        );
        // The Saved tile is an OutfitCollage (R5): clothes as they lie on a bed.
        expect(alts).toEqual(['Order top', 'Order pants', 'Order shoes']);
      });

      it('the calendar lays the garments out top to toe, whatever the saved order', async () => {
        await t.inject({
          method: 'POST',
          url: '/calendar',
          payload: { date: '2030-11-05', outfitId: String(outfitId) },
        });
        const res = await t.inject({
          method: 'GET',
          url: '/calendar?week=2030-11-05',
        });
        // The entry is an OutfitCollage (R6): every garment of the outfit,
        // laid out by role (top, pants, shoes) whatever order it was saved in
        // (shoes, pants, top); the saved order is the outfit page's list.
        // The entry's link names the outfit, so its photos are decorative
        // (alt="", #730); the order is read from each piece's category.
        const tags = imgTags(res.body);
        expect(tags.map((tag) => /alt="([^"]*)"/.exec(tag)?.[1])).toEqual([
          '',
          '',
          '',
        ]);
        expect(
          tags.map((tag) => /data-collage-piece="([^"]*)"/.exec(tag)?.[1]),
        ).toEqual(['tops', 'bottoms', 'footwear']);
      });

      it('lists outfits newest first, in one statement with their activity', async () => {
        const load = () => t.inject({ method: 'GET', url: '/outfits' });
        const res = await load();
        const ids = [...res.body.matchAll(/data-outfit-id="(\d+)"/g)].map((m) =>
          Number(m[1]),
        );
        expect(ids.length).toBeGreaterThan(3);
        expect(ids).toEqual([...ids].sort((a, b) => b - a));
        // The session's user row, then every outfit with its garments,
        // the entries' activity (worn counts, next plans) and the agent's
        // outfits (#335) in one (#164).
        expect((await recordQueries(load)).statements).toBe(2);
      });
    });
  });

  // POST /outfits/:id: the outfit form pages cached before Styling (#42)
  // still post; Styling saves an edit through the same writer
  // (test/integration/styling.spec.ts).
  describe('POST /outfits/:id', () => {
    it('replaces membership and order, and updates name and notes', async () => {
      const top = await createGarment(t, { name: 'Tank', category: 'tops' });
      const shorts = await createGarment(t, {
        name: 'Shorts',
        category: 'bottoms',
      });
      const sandals = await createGarment(t, {
        name: 'Sandals',
        category: 'footwear',
      });
      const id = await createOutfit({ name: 'Beach' }, [
        ['tops', top],
        ['bottoms', shorts],
      ]);

      const res = await updateOutfit(id, { name: 'Boardwalk', notes: 'Hot' }, [
        ['footwear', sandals],
        ['tops', top],
      ]);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/outfits/${id}`);

      const outfit = await outfitRow(id);
      expect(outfit.name).toBe('Boardwalk');
      expect(outfit.notes).toBe('Hot');
      expect(await savedSlots(id)).toEqual([
        { category: 'footwear', garmentId: sandals },
        { category: 'tops', garmentId: top },
      ]);
      expect(await calendarEntries(id)).toHaveLength(0);
    });

    it('removing every row empties the outfit', async () => {
      const top = await createGarment(t, { name: 'Vest', category: 'tops' });
      const id = await createOutfit({ name: 'Emptied' }, [['tops', top]]);

      expect((await updateOutfit(id, { name: 'Emptied' }, [])).statusCode).toBe(
        302,
      );
      expect(await savedSlots(id)).toEqual([]);
    });

    it('leaves name and notes alone when the post does not carry them', async () => {
      const id = await createOutfit({ name: 'Kept', notes: 'As is' }, []);
      const res = await t.inject({
        method: 'POST',
        url: `/outfits/${id}`,
        payload: { category: 'tops', garmentId: '' },
      });
      expect(res.statusCode).toBe(302);
      expect(await outfitRow(id)).toMatchObject({
        name: 'Kept',
        notes: 'As is',
      });
      expect(await savedSlots(id)).toEqual([
        { category: 'tops', garmentId: null },
      ]);
    });

    it('400s a malformed schedule date and changes nothing', async () => {
      const top = await createGarment(t, { name: 'Steady', category: 'tops' });
      const id = await createOutfit({ name: 'Steady' }, [['tops', top]]);
      const res = await updateOutfit(
        id,
        { name: 'Changed', scheduleDate: '2026-13-01' },
        [],
      );
      expect(res.statusCode).toBe(400);
      expect((await outfitRow(id)).name).toBe('Steady');
      expect(await savedSlots(id)).toEqual([
        { category: 'tops', garmentId: top },
      ]);
    });

    it('schedules from the edit form and returns to the calendar week', async () => {
      const id = await createOutfit({ name: 'Rescheduled' }, []);
      const res = await updateOutfit(
        id,
        {
          name: 'Rescheduled',
          scheduleDate: '2026-10-21',
          returnTo: '/calendar',
          returnToWeek: '2026-10-18',
        },
        [],
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/calendar?week=2026-10-18');
      const entries = await calendarEntries(id);
      expect(entries.map((e) => e.day)).toEqual(['2026-10-21']);
    });

    it('saving the same schedule date twice keeps one calendar entry', async () => {
      const id = await createOutfit({ name: 'Saved twice' }, []);
      for (let i = 0; i < 2; i++) {
        const res = await updateOutfit(
          id,
          { name: 'Saved twice', scheduleDate: '2026-10-22' },
          [],
        );
        expect(res.statusCode).toBe(302);
      }
      expect(await calendarEntries(id)).toHaveLength(1);
    });

    it('404s an update to an unknown outfit', async () => {
      const res = await updateOutfit(999_999, { name: 'Ghost' }, []);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /outfits/:id', () => {
    it('removes the outfit, its slots and its calendar entries, but not the garments', async () => {
      const top = await createGarment(t, {
        name: 'Doomed top',
        category: 'tops',
      });
      const id = await createOutfit(
        { name: 'Doomed', scheduleDate: '2026-10-28' },
        [['tops', top]],
      );
      expect(await slotGarmentIds(id)).toEqual([top]);
      expect(await calendarEntries(id)).toHaveLength(1);

      const res = await t.inject({ method: 'DELETE', url: `/outfits/${id}` });
      expect(res.statusCode).toBe(200);
      expect(hxLocationPath(res)).toBe('/outfits');

      expect(await outfitRow(id)).toBeUndefined();
      expect(await savedSlots(id)).toEqual([]);
      expect(await calendarEntries(id)).toHaveLength(0);
      const [kept] = await t.db
        .select({ n: count() })
        .from(garmentTable)
        .where(eq(garmentTable.id, top));
      expect(kept.n).toBe(1);

      const gone = await t.inject({ method: 'GET', url: `/outfits/${id}` });
      expect(gone.statusCode).toBe(404);
      const again = await t.inject({ method: 'DELETE', url: `/outfits/${id}` });
      expect(again.statusCode).toBe(404);
    });
  });
});
