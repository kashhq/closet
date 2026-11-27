import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  outfit,
  outfitCalendar,
  outfitSlot,
  personalAccessToken,
  tripOutfit,
} from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { insertEntry, wearOutfitOn } from '../../src/web/calendar/queries';
import { updateOutfit } from '../../src/web/outfits/queries';
import { addTripOutfit } from '../../src/web/trips/queries';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { createGarment, createWishlistItem } from './garments';
import { createTestApp, hasText, type TestApp, unescapeHtml } from './harness';
import { interleave } from './interleave';
import { callTool, createAccessToken, tool } from './mcp';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * Outfits holding pieces not bought yet (#335, phase 2 of the agent epic;
 * the rule: src/web/outfits/references.ts). An outfit may hold a wishlist
 * garment only while nothing holds it, so a planned, packed or worn
 * outfit is always complete. Every surface that plans, packs or wears an
 * outfit refuses an incomplete one, each row with its complete twin
 * accepted beside it; the pickers show it disabled; what chooses on its
 * own (Ideas, Today, the week planner) never meets one; Bought it
 * completes it. The wishlist spec's pattern, one row per surface.
 */

const refusalOf = (pieces: string) =>
  `Buy ${pieces} first: an outfit with pieces not bought yet can’t be planned or packed.`;
const BLAZER_REFUSAL = refusalOf('Wool blazer');

describe('incomplete outfits', () => {
  let t: TestApp;
  let mcpToken: string;
  let tee: number;
  let jeans: number;
  let shoes: number;
  let blazer: number;
  /** Tee, jeans and the blazer to buy. */
  let incomplete: number;
  /** Tee and jeans: the twin every row plans, packs or edits to compare. */
  let complete: number;
  let day: string;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  const formSave = async (
    name: string,
    garmentIds: number[],
    extra: Record<string, string> = {},
  ) =>
    post('/outfits', {
      name,
      notes: '',
      category: garmentIds.map(() => 'tops'),
      garmentId: garmentIds.map(String),
      ...extra,
    });

  const savedId = async (name: string, garmentIds: number[]) => {
    const res = await formSave(name, garmentIds);
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/outfits\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const entriesOf = (outfitId: number) =>
    t.db
      .select({ id: outfitCalendar.id, day: outfitCalendar.day })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId));

  const slotsOf = async (outfitId: number) =>
    (
      await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, outfitId))
        .orderBy(asc(outfitSlot.position))
    ).map((slot) => slot.garmentId);

  const newTrip = async (name: string) => {
    const res = await post('/trips', {
      name,
      destination: '',
      startsOn: day,
      endsOn: addDays(day, 2),
      notes: '',
    });
    expect(res.statusCode).toBe(303);
    return Number(/^\/trips\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const onTrip = (tripId: number) =>
    t.db
      .select({ outfitId: tripOutfit.outfitId })
      .from(tripOutfit)
      .where(eq(tripOutfit.tripId, tripId));

  beforeAll(async () => {
    t = await createTestApp();
    mcpToken = await createAccessToken(t, { name: 'Stylist' });
    day = addDays(t.today(), 3);
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    shoes = await createGarment(t, {
      name: 'Canvas shoes',
      category: 'footwear',
    });
    blazer = await createWishlistItem(t, {
      name: 'Wool blazer',
      category: 'outerwear',
      price: '280',
    });
    incomplete = await savedId('With the blazer', [tee, jeans, blazer]);
    complete = await savedId('Tee and jeans', [tee, jeans]);
  });

  afterAll(() => t?.cleanup());

  describe('a save holds a piece to buy only while nothing holds the outfit', () => {
    it('the outfit form saves it, slot for slot', async () => {
      expect(await slotsOf(incomplete)).toEqual([tee, jeans, blazer]);
    });

    it('a save planned on a day is refused whole, nothing written', async () => {
      const before = await t.db.$count(outfit);
      const res = await formSave('Planned with the blazer', [shoes, blazer], {
        scheduleDate: day,
      });
      expect(res.statusCode).toBe(409);
      expect(hasText(res.body, BLAZER_REFUSAL)).toBe(true);
      expect(await t.db.$count(outfit)).toBe(before);
    });

    it('an edit adding one to a planned outfit, or to one on a trip, is refused; unheld it is kept', async () => {
      const planned = await savedId('Planned', [tee, shoes]);
      expect(
        (await post('/calendar', { outfitId: planned, date: day })).statusCode,
      ).toBe(302);
      const packed = await savedId('Packed', [jeans, shoes]);
      const tripId = await newTrip('Edit trip');
      expect(
        (
          await post(`/trips/${tripId}/outfits`, {
            outfitId: packed,
            day: '',
            occasion: '',
          })
        ).statusCode,
      ).toBe(303);
      for (const [id, garments] of [
        [planned, [tee, shoes]],
        [packed, [jeans, shoes]],
      ] as const) {
        const res = await post(`/outfits/${id}`, {
          name: 'Edited',
          notes: '',
          category: ['tops', 'tops', 'tops'],
          garmentId: [...garments, blazer].map(String),
        });
        expect(res.statusCode, String(id)).toBe(409);
        expect(unescapeHtml(res.body)).toContain(
          'Not saved: Wool blazer is not bought yet, and this outfit is planned or on a trip.',
        );
        expect(await slotsOf(id)).toEqual([...garments]);
      }
      const unheld = await savedId('Unheld', [shoes]);
      const edited = await post(`/outfits/${unheld}`, {
        name: 'Unheld',
        notes: '',
        category: ['tops', 'tops'],
        garmentId: [shoes, blazer].map(String),
      });
      expect(edited.statusCode).toBe(302);
      expect(await slotsOf(unheld)).toEqual([shoes, blazer]);
    });

    it('create_outfit (MCP) saves one and lists its pieces to buy; planned, it is refused, nothing saved', async () => {
      const before = await t.db.$count(outfit);
      const refused = await callTool(t, mcpToken, 'create_outfit', {
        garmentIds: [shoes, jeans, blazer],
        scheduleDate: day,
      });
      expect(refused).toEqual({
        isError: true,
        value: { error: BLAZER_REFUSAL },
      });
      expect(await t.db.$count(outfit)).toBe(before);
      const created = await tool<{ id: number }>(t, mcpToken, 'create_outfit', {
        garmentIds: [shoes, jeans, blazer],
      });
      const { outfits } = await tool<{
        outfits: { id: number; toBuy: { id: number; name: string }[] }[];
      }>(t, mcpToken, 'list_outfits');
      const listed = new Map(outfits.map((o) => [o.id, o.toBuy]));
      expect(listed.get(created.id)).toEqual([
        { id: blazer, name: 'Wool blazer' },
      ]);
      expect(listed.get(complete)).toEqual([]);
      const one = await tool<{ toBuy: unknown[] }>(t, mcpToken, 'get_outfit', {
        id: incomplete,
      });
      expect(one.toBuy).toEqual([{ id: blazer, name: 'Wool blazer' }]);
    });
  });

  describe('every way to plan, pack or wear it refuses it, naming the piece', () => {
    it('POST /calendar (the Plan sheet, the pickers)', async () => {
      const res = await post('/calendar', { outfitId: incomplete, date: day });
      expect(res.statusCode).toBe(409);
      expect(hasText(res.body, BLAZER_REFUSAL)).toBe(true);
      expect(await entriesOf(incomplete)).toEqual([]);
      const twin = await post('/calendar', { outfitId: complete, date: day });
      expect(twin.statusCode).toBe(302);
    });

    it('a replace (Change)', async () => {
      const replaced = await savedId('Replaced', [tee, jeans, shoes]);
      const date = addDays(day, 5);
      expect(
        (await post('/calendar', { outfitId: replaced, date })).statusCode,
      ).toBe(302);
      const [entry] = await entriesOf(replaced);
      const res = await post('/calendar', {
        outfitId: incomplete,
        date,
        replace: entry.id,
      });
      expect(res.statusCode).toBe(409);
      expect(hasText(res.body, BLAZER_REFUSAL)).toBe(true);
      expect(await entriesOf(replaced)).toEqual([entry]);
      expect(await entriesOf(incomplete)).toEqual([]);
      const twin = await post('/calendar', {
        outfitId: complete,
        date,
        replace: entry.id,
      });
      expect(twin.statusCode).toBe(302);
      expect(
        await t.db
          .select({ outfitId: outfitCalendar.outfitId })
          .from(outfitCalendar)
          .where(eq(outfitCalendar.id, entry.id)),
      ).toEqual([{ outfitId: complete }]);
    });

    it('wearing it (planToWear: defence only, as Wear this picks closet garments and a trip holds complete outfits)', async () => {
      const wear = (outfitId: number) =>
        wearOutfitOn(t.db, {
          ownerId: t.owner.id,
          outfitId,
          day: t.today(),
          occasion: 'all-day',
          at: new Date(),
          today: t.today(),
        });
      await expect(wear(incomplete)).rejects.toMatchObject({
        statusCode: 409,
        message: BLAZER_REFUSAL,
      });
      expect(await entriesOf(incomplete)).toEqual([]);
      expect(await wear(complete)).toMatchObject({ scheduled: 'scheduled' });
    });

    it('a trip’s add', async () => {
      const tripId = await newTrip('Weekend away');
      const res = await post(`/trips/${tripId}/outfits`, {
        outfitId: incomplete,
        day: '',
        occasion: '',
      });
      expect(res.statusCode).toBe(409);
      expect(hasText(res.body, BLAZER_REFUSAL)).toBe(true);
      expect(await onTrip(tripId)).toEqual([]);
      const twin = await post(`/trips/${tripId}/outfits`, {
        outfitId: complete,
        day: '',
        occasion: '',
      });
      expect(twin.statusCode).toBe(303);
      expect(await onTrip(tripId)).toEqual([{ outfitId: complete }]);
    });

    it('MCP schedule_outfit and plan_trip_outfit', async () => {
      const scheduled = await callTool(t, mcpToken, 'schedule_outfit', {
        outfitId: incomplete,
        date: addDays(day, 1),
      });
      expect(scheduled).toEqual({
        isError: true,
        value: { error: BLAZER_REFUSAL },
      });
      const tripId = await newTrip('MCP trip');
      const packed = await callTool(t, mcpToken, 'plan_trip_outfit', {
        tripId,
        outfitId: incomplete,
      });
      expect(packed).toEqual({
        isError: true,
        value: { error: BLAZER_REFUSAL },
      });
      expect(await entriesOf(incomplete)).toEqual([]);
      expect(await onTrip(tripId)).toEqual([]);
      // The complete twin goes through both.
      await tool(t, mcpToken, 'schedule_outfit', {
        outfitId: complete,
        date: addDays(day, 6),
      });
      await tool(t, mcpToken, 'plan_trip_outfit', {
        tripId,
        outfitId: complete,
      });
      expect(await onTrip(tripId)).toEqual([{ outfitId: complete }]);
    });
  });

  describe('Styling edits it in place, keeping the piece to buy', () => {
    it('opens with the piece as its row, and a save that renames it or swaps a piece keeps it', async () => {
      const id = await savedId('Styled with the blazer', [
        jeans,
        shoes,
        blazer,
      ]);
      const opened = unescapeHtml((await get(`/styling?outfit=${id}`)).body);
      expect(opened).toContain('Wool blazer');
      const renamed = await post('/styling', {
        outfit: String(id),
        garmentId: [jeans, shoes, blazer].map(String),
        name: 'Renamed, blazer kept',
      });
      expect(renamed.statusCode, renamed.body).toBe(303);
      expect(await slotsOf(id)).toEqual([blazer, jeans, shoes]);
      const swapped = await post('/styling', {
        outfit: String(id),
        garmentId: [tee, shoes, blazer].map(String),
        name: 'A tee for the jeans',
      });
      expect(swapped.statusCode, swapped.body).toBe(303);
      expect(await slotsOf(id)).toEqual([blazer, tee, shoes]);
    });

    /** Styling's rows as the page posts them back (Shuffle, "Add row"), editing `outfitId`. */
    const rowsQuery = (
      outfitId: number,
      rows: [role: string, garmentId: number | null, locked: boolean][],
      extra: Record<string, string> = {},
    ) => {
      const query = new URLSearchParams({ outfit: String(outfitId), ...extra });
      for (const [role, garmentId, locked] of rows) {
        query.append('role', role);
        query.append('garmentId', garmentId === null ? '' : String(garmentId));
        query.append('lock', locked ? '1' : '');
      }
      return query.toString();
    };
    const carries = (html: string, garmentId: number) =>
      html.includes(`name="garmentId" value="${garmentId}"`);

    it('Shuffle (the piece locked), "Add row" and a refused Save keep it, and the Save after them does', async () => {
      const id = await savedId('Styled round trips', [tee, blazer]);
      const shuffled = await get(
        `/styling/shuffle?${rowsQuery(
          id,
          [
            ['layer', blazer, true],
            ['top', tee, false],
            ['bottom', null, false],
          ],
          { seed: '3' },
        )}`,
      );
      expect(shuffled.statusCode).toBe(200);
      expect(carries(shuffled.body, blazer)).toBe(true);
      const added = await get(
        `/styling/row?${rowsQuery(
          id,
          [
            ['layer', blazer, false],
            ['top', tee, false],
          ],
          { add: 'footwear' },
        )}`,
      );
      expect(added.statusCode).toBe(200);
      expect(carries(added.body, blazer)).toBe(true);
      // Refused for a garment that is gone: the page again, the piece kept.
      const refused = await post('/styling', {
        outfit: String(id),
        role: ['layer', 'top', 'footwear'],
        garmentId: [blazer, tee, 2147483000].map(String),
        lock: ['', '', ''],
        name: 'Styled round trips',
      });
      expect(refused.statusCode).toBe(404);
      expect(carries(refused.body, blazer)).toBe(true);
      const saved = await post('/styling', {
        outfit: String(id),
        garmentId: [blazer, tee, shoes].map(String),
        name: 'Styled round trips',
      });
      expect(saved.statusCode, saved.body).toBe(303);
      expect(await slotsOf(id)).toEqual([blazer, tee, shoes]);
    });

    it('a row carries a wishlist item only while it edits a saved outfit', async () => {
      const fresh = new URLSearchParams();
      for (const [role, garmentId] of [
        ['layer', blazer],
        ['top', tee],
      ] as const) {
        fresh.append('role', role);
        fresh.append('garmentId', String(garmentId));
        fresh.append('lock', '');
      }
      const added = await get(`/styling/row?${fresh.toString()}&add=footwear`);
      expect(added.statusCode).toBe(200);
      expect(carries(added.body, blazer)).toBe(false);
      expect(carries(added.body, tee)).toBe(true);
    });

    it('a save adding one to a planned outfit names the plan, not a wishlist item', async () => {
      const id = await savedId('Styled, planned', [tee, shoes]);
      expect(
        (await post('/calendar', { outfitId: id, date: addDays(day, 4) }))
          .statusCode,
      ).toBe(302);
      const res = await post('/styling', {
        outfit: String(id),
        garmentId: [tee, shoes, blazer].map(String),
        name: 'Styled, planned',
      });
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain(
        'Not saved: Wool blazer is not bought yet, and this outfit is planned or on a trip.',
      );
      expect(await slotsOf(id)).toEqual([tee, shoes]);
    });
  });

  describe('the pickers show it disabled, saying to buy it first', () => {
    /** The `disabled` attribute (not the `disabled:` variant in a class). */
    const DISABLED = /\sdisabled(=""|(?=[\s>]))/;

    /** The submit button of `outfitId` in a picking form, as markup. */
    const buttonOf = (html: string, outfitId: number) => {
      const match = new RegExp(
        `<button[^>]*name="outfitId"[^>]*value="${outfitId}"[^>]*>`,
      ).exec(html);
      if (!match) throw new Error(`No button for outfit ${outfitId}`);
      return match[0];
    };

    it('the calendar’s plan page, the Saved tab’s pick for a day and a trip’s add page', async () => {
      const tripId = await newTrip('Picker trip');
      for (const url of [
        `/calendar/plan?for=day:${addDays(day, 1)}&occasion=all-day`,
        `/outfits?for=day:${addDays(day, 1)}&occasion=all-day`,
        `/trips/${tripId}/outfits/new`,
      ]) {
        const html = unescapeHtml((await get(url)).body);
        expect(buttonOf(html, incomplete), url).toMatch(DISABLED);
        expect(buttonOf(html, complete), url).not.toMatch(DISABLED);
        expect(html, url).toContain('Buy 1 piece first');
      }
    });

    it('the Saved grid says what it waits for; its page offers the piece in place of Plan', async () => {
      const grid = unescapeHtml((await get('/outfits')).body);
      expect(grid).toMatch(
        new RegExp(`data-outfit-id="${incomplete}"[\\s\\S]*?1 piece to buy`),
      );
      const page = unescapeHtml((await get(`/outfits/${incomplete}`)).body);
      expect(page).toContain('To wear this, buy');
      expect(page).toContain(`data-piece-to-buy="${blazer}"`);
      expect(page).not.toContain('data-outfit-plan=""');
      expect(page).not.toContain('id="outfit-plan-sheet"');
      const twin = unescapeHtml((await get(`/outfits/${complete}`)).body);
      expect(twin).toContain('data-outfit-plan=""');
      expect(twin).not.toContain('data-outfit-to-buy');
    });
  });

  describe('its pieces as they change', () => {
    it('a dismissed pick keeps its slot: the outfit stays incomplete, never emptied', async () => {
      const [token] = await t.db
        .select({ id: personalAccessToken.id })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.userId, t.owner.id));
      const knit = await createWishlistItem(t, {
        name: 'Cable knit',
        category: 'tops',
      });
      expect(
        await markSuggestion(t.db, t.owner.id, knit, {
          tokenId: token.id,
          groupId: null,
          note: 'A warm layer',
          rank: null,
        }),
      ).toBe('marked');
      const withKnit = await savedId('With the knit', [knit, jeans]);
      expect(
        await decide(t.db, t.owner.id, {
          kind: 'dismiss-pick',
          garmentId: knit,
          reason: 'colour',
          note: null,
        }),
      ).toMatchObject({ ok: true });
      expect(await slotsOf(withKnit)).toEqual([knit, jeans]);
      const res = await post('/calendar', { outfitId: withKnit, date: day });
      expect(res.statusCode).toBe(409);
      expect(hasText(res.body, refusalOf('Cable knit'))).toBe(true);
    });

    it('Bought it completes it: nothing in the outfit changes, and it plans', async () => {
      const bought = await post(`/wardrobe/${blazer}/bought`, {
        acquiredOn: t.today(),
        price: '280',
      });
      expect(bought.statusCode).toBe(303);
      expect(await slotsOf(incomplete)).toEqual([tee, jeans, blazer]);
      const res = await post('/calendar', {
        outfitId: incomplete,
        date: addDays(day, 2),
      });
      expect(res.statusCode).toBe(302);
      expect(await entriesOf(incomplete)).toHaveLength(1);
      const page = unescapeHtml((await get(`/outfits/${incomplete}`)).body);
      expect(page).toContain('data-outfit-plan=""');
    });
  });

  describe('an edit adding a piece races a plan or a pack (one outcome, never both)', () => {
    let scarf: number;

    beforeAll(async () => {
      scarf = await createWishlistItem(t, {
        name: 'Silk scarf',
        category: 'accessories',
      });
    });

    const addScarf = (tx: Parameters<typeof updateOutfit>[0], id: number) =>
      updateOutfit(tx, id, t.owner.id, {
        slots: [
          { category: 'tops', garmentId: shoes },
          { category: 'accessories', garmentId: scarf },
        ],
      });

    it('an edit first: the plan and the pack after it see the piece and refuse', async () => {
      const id = await savedId('Raced edit first', [shoes]);
      const [, planned] = await interleave(
        t.db,
        (tx) => addScarf(tx, id),
        () => post('/calendar', { outfitId: id, date: day }),
      );
      expect(planned.statusCode).toBe(409);
      const tripId = await newTrip('Raced trip');
      const other = await savedId('Raced edit first, packed', [jeans]);
      const [, packed] = await interleave(
        t.db,
        (tx) =>
          updateOutfit(tx, other, t.owner.id, {
            slots: [
              { category: 'bottoms', garmentId: jeans },
              { category: 'accessories', garmentId: scarf },
            ],
          }),
        () =>
          post(`/trips/${tripId}/outfits`, {
            outfitId: other,
            day: '',
            occasion: '',
          }),
      );
      expect(packed.statusCode).toBe(409);
      expect(await entriesOf(id)).toEqual([]);
      expect(await onTrip(tripId)).toEqual([]);
    });

    it('a plan first: the edit after it finds the outfit held and refuses', async () => {
      // Its own garment set: a save of a set already saved reuses that outfit.
      const id = await savedId('Raced plan first', [tee]);
      const [planned, edit] = await interleave(
        t.db,
        (tx) =>
          insertEntry(tx, {
            ownerId: t.owner.id,
            outfitId: id,
            day,
            occasion: 'all-day',
            chooser: BY_PERSON,
          }),
        () => addScarf(t.db, id).catch((error: unknown) => error),
      );
      expect(planned).toMatchObject({ outcome: 'scheduled' });
      expect(edit).toMatchObject({ statusCode: 409 });
      expect(await slotsOf(id)).toEqual([tee]);
    });

    it('a pack first: the edit after it finds the outfit held and refuses', async () => {
      const id = await savedId('Raced pack first', [shoes]);
      const tripId = await newTrip('Packed first');
      const [added, edit] = await interleave(
        t.db,
        (tx) =>
          addTripOutfit(tx, {
            tripId,
            ownerId: t.owner.id,
            outfitId: id,
            madeBy: BY_PERSON,
          }),
        () => addScarf(t.db, id).catch((error: unknown) => error),
      );
      expect(added).toBe('added');
      expect(edit).toMatchObject({ statusCode: 409 });
      expect(await slotsOf(id)).toEqual([shoes]);
    });
  });
});

describe('what chooses outfits on its own never meets an incomplete one', () => {
  let t: TestApp;
  let mcpToken: string;
  let tee: number;
  let jeans: number;
  let shoes: number;
  let unfinished: number;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  beforeAll(async () => {
    t = await createTestApp();
    mcpToken = await createAccessToken(t, { name: 'Stylist' });
    // The closet makes one idea: this tee, these jeans, these shoes.
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    shoes = await createGarment(t, {
      name: 'Canvas shoes',
      category: 'footwear',
    });
    // The same three with a scarf to buy: an accessory is not a drawn
    // role, so the generator's duplicate rule would read this outfit as
    // the closet's one idea, were incomplete outfits in its memory.
    const scarf = await createWishlistItem(t, {
      name: 'Silk scarf',
      category: 'accessories',
    });
    const res = await post('/outfits', {
      name: 'With the scarf',
      notes: '',
      category: ['tops', 'bottoms', 'footwear', 'accessories'],
      garmentId: [tee, jeans, shoes, scarf].map(String),
    });
    expect(res.statusCode).toBe(302);
    unfinished = Number(
      /^\/outfits\/(\d+)/.exec(String(res.headers.location))![1],
    );
  });

  afterAll(() => t?.cleanup());

  it('Ideas and Today still suggest the closet’s idea', async () => {
    for (const url of ['/outfits/ideas', '/']) {
      expect(unescapeHtml((await get(url)).body), url).toContain(
        'Canvas shoes',
      );
    }
  });

  it('a pick of the idea is an outfit of its own, never the incomplete one', async () => {
    const picked = await tool<{ id: number; alreadySaved: boolean }>(
      t,
      mcpToken,
      'pick_outfit',
      { garmentIds: [tee, jeans, shoes] },
    );
    expect(picked.alreadySaved).toBe(false);
    expect(picked.id).not.toBe(unfinished);
    // Saved now: the generator's duplicate rule takes the complete one
    // (the control: the rule reads the memory this spec is about).
    expect(unescapeHtml((await get('/outfits/ideas')).body)).not.toContain(
      'Canvas shoes',
    );
    const deleted = await t.inject({
      method: 'DELETE',
      url: `/outfits/${picked.id}`,
    });
    expect(deleted.statusCode).toBeLessThan(400);
  });

  it('Plan my week plans the idea, never the incomplete outfit', async () => {
    await post(
      '/auth/profile/week',
      Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6].map((d) => [`day-${d}`, 'all-day']),
      ),
    );
    const planned = await post('/calendar/plan-week', {});
    expect(planned.statusCode).toBe(303);
    expect(String(planned.headers.location)).not.toContain('planned=none');
    const entries = await t.db
      .select({ outfitId: outfitCalendar.outfitId })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.ownerId, t.owner.id));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.outfitId)).not.toContain(unfinished);
    const held = await t.db
      .select({ id: outfit.id })
      .from(outfit)
      .where(and(eq(outfit.ownerId, t.owner.id), eq(outfit.id, unfinished)));
    expect(held).toEqual([{ id: unfinished }]);
  });
});
