import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, instantAt } from '../../src/calendar-date';
import {
  garment,
  garmentWear,
  outfit,
  outfitCalendar,
  outfitSlot,
} from '../../src/db/schema';
import { deviceToken, expectProblem } from './api';
import { createGarment, createWishlistItem } from './garments';
import { asFixture, createTestApp, type TestApp } from './harness';

/**
 * Outfits, wears, washes and away on /api/v1 (#193a): each its page twin's
 * domain function with a JSON body. Who may do what is the authorization
 * matrix's (authorization-outfits.spec.ts, authorization-wardrobe.spec.ts
 * replay their cases on these twins); what each costs is api-statements'.
 */

let t: TestApp;
let token: string;
let strangerToken: string;

interface Saved {
  id: number;
  alreadySaved: boolean;
  schedule?: string;
}

const create = (payload: object, as = token) =>
  t.api(as, { method: 'POST', url: '/api/v1/outfits', payload });

const slotsOf = (id: number) =>
  t.db
    .select({ garmentId: outfitSlot.garmentId, category: outfitSlot.category })
    .from(outfitSlot)
    .where(eq(outfitSlot.outfitId, id))
    .orderBy(outfitSlot.position);

beforeAll(async () => {
  t = await createTestApp();
  token = (await deviceToken(t)).token;
  const email = 'api-outfits-stranger@example.com';
  await t.register(email);
  strangerToken = (await deviceToken(t, { email })).token;
});

/**
 * A top and a bottom of the owner's, new for each test: one garment set is
 * one outfit, so a set another test saved would be reused.
 */
async function pair(): Promise<[shirt: number, jeans: number]> {
  return [
    await createGarment(t, { name: 'Api shirt', category: 'tops' }),
    await createGarment(t, { name: 'Api jeans', category: 'bottoms' }),
  ];
}

afterAll(async () => {
  await t?.cleanup();
});

describe('outfits', () => {
  it('creates once per garment set: 201 with its Location, then 200 alreadySaved, planned when asked', async () => {
    const [shirt, jeans] = await pair();
    const slots = [
      { category: 'shirt', garmentId: shirt },
      { category: 'jeans', garmentId: jeans },
      { category: 'shoes' },
    ];
    const made = await create({ name: '  Weekend  ', slots });
    expect(made.statusCode, made.body).toBe(201);
    const { id } = made.json<Saved>();
    expect(made.json()).toEqual({ id, alreadySaved: false });
    expect(made.headers.location).toBe(`/api/v1/outfits/${id}`);
    expect(await slotsOf(id)).toEqual([
      { garmentId: shirt, category: 'shirt' },
      { garmentId: jeans, category: 'jeans' },
      { garmentId: null, category: 'shoes' },
    ]);
    const [row] = await t.db
      .select({ name: outfit.name })
      .from(outfit)
      .where(eq(outfit.id, id));
    expect(row.name).toBe('Weekend');

    const day = addDays(t.today(), 3);
    const again = await create({
      name: 'Another name',
      slots: slots.slice(0, 2),
      plan: { day, occasion: 'evening' },
      clientId: '7f6c2a8e-1b2c-4d3e-8f9a-0b1c2d3e4f5a',
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({
      id,
      alreadySaved: true,
      schedule: 'scheduled',
    });
    const entries = await t.db
      .select({ day: outfitCalendar.day, occasion: outfitCalendar.occasion })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, id));
    expect(entries).toEqual([{ day, occasion: 'evening' }]);
    expect(t.logs.ops('outfit.created')).toContainEqual(
      expect.objectContaining({
        outfitId: id,
        surface: 'api',
        changed: false,
        clientId: expect.stringMatching(/^7f6c2a8e/),
      }),
    );
  });

  it('refuses an outfit with no garment (a retried empty create would never dedup)', async () => {
    const before = await t.db.$count(outfit);
    expectProblem(await create({ slots: [] }), 400, 'validation');
    expectProblem(
      await create({ slots: [{ category: 'shirt' }, { category: 'jeans' }] }),
      400,
      'validation',
    );
    expect(await t.db.$count(outfit)).toBe(before);
  });

  it("refuses another's garment whole (a 404 that names nothing), and a JSON id as a string", async () => {
    const [shirt] = await pair();
    const before = await t.db.$count(outfit);
    const foreign = await create(
      { slots: [{ category: 'shirt', garmentId: shirt }] },
      strangerToken,
    );
    expectProblem(foreign, 404, 'not_found');
    expect(foreign.body).not.toContain('Api shirt');
    // Never coerced (jsonApiValidator): "3" is not an id.
    const coerced = await create({
      slots: [{ category: 'shirt', garmentId: String(shirt) }],
    });
    expectProblem(coerced, 400, 'validation');
    expect(await t.db.$count(outfit)).toBe(before);
  });

  it('refuses planning an outfit with a piece to buy, nothing written', async () => {
    const wanted = await createWishlistItem(t, {
      name: 'Api blazer',
      category: 'blazer',
    });
    const before = await t.db.$count(outfit);
    const res = await create({
      slots: [{ category: 'blazer', garmentId: wanted }],
      plan: { day: t.today() },
    });
    expectProblem(res, 409, 'conflict');
    expect(await t.db.$count(outfit)).toBe(before);
  });

  it('lists newest first a page at a time, with the pieces to buy, and reads one with its days', async () => {
    const [shirt, jeans] = await pair();
    const wanted = await createWishlistItem(t, {
      name: 'Api scarf',
      category: 'scarf',
    });
    const ids: number[] = [];
    for (const garmentIds of [[shirt], [jeans], [shirt, wanted]]) {
      const res = await create({
        slots: garmentIds.map((garmentId) => ({
          category: 'any',
          garmentId,
        })),
      });
      ids.unshift(res.json<Saved>().id);
    }
    const first = await t.api(token, {
      method: 'GET',
      url: '/api/v1/outfits?limit=2',
    });
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<{
      data: { id: number; toBuy: number[]; garments: { id: number }[] }[];
      pagination: { nextCursor?: string; limit: number };
    }>();
    expect(page.data.map(({ id }) => id)).toEqual(ids.slice(0, 2));
    expect(page.data[0].toBuy).toEqual([wanted]);
    expect(page.data[0].garments.map(({ id }) => id)).toEqual([shirt, wanted]);
    const second = await t.api(token, {
      method: 'GET',
      url: `/api/v1/outfits?limit=2&cursor=${page.pagination.nextCursor}`,
    });
    expect(second.json<typeof page>().data[0].id).toBe(ids[2]);

    const planned = addDays(t.today(), 1);
    await t.inject({
      method: 'POST',
      url: '/calendar',
      payload: { date: planned, outfitId: String(ids[1]) },
    });
    const one = await t.api(token, {
      method: 'GET',
      url: `/api/v1/outfits/${ids[1]}`,
    });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({
      id: ids[1],
      garments: [{ id: jeans, category: 'bottoms', role: 'bottom' }],
      toBuy: [],
      planned: [{ day: planned, occasion: 'all-day' }],
      worn: [],
    });
    expect(one.json()).not.toHaveProperty('name');
    expectProblem(
      await t.api(strangerToken, {
        method: 'GET',
        url: `/api/v1/outfits/${ids[1]}`,
      }),
      404,
      'not_found',
    );
  });

  it('lists every outfit without `show`, the kept ones with show=kept and the one-offs with show=one-offs (#659); another value is a 400', async () => {
    const [shirt, jeans] = await pair();
    const ids: Record<'person' | 'idea' | 'planner', number> = {
      person: 0,
      idea: 0,
      planner: 0,
    };
    const sets = { person: [shirt], idea: [jeans], planner: [shirt, jeans] };
    for (const origin of ['person', 'idea', 'planner'] as const) {
      const res = await create({
        slots: sets[origin].map((garmentId) => ({
          category: 'any',
          garmentId,
        })),
      });
      ids[origin] = res.json<Saved>().id;
      if (origin !== 'person') {
        await asFixture(t.db, (tx) =>
          tx.update(outfit).set({ origin }).where(eq(outfit.id, ids[origin])),
        );
      }
    }
    const listed = async (query: string) => {
      const res = await t.api(token, {
        method: 'GET',
        url: `/api/v1/outfits?limit=100${query}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      const mine = new Set(Object.values(ids));
      return res
        .json<{ data: { id: number; origin: string }[] }>()
        .data.filter(({ id }) => mine.has(id))
        .map(({ id, origin }) => ({ id, origin }));
    };
    expect(await listed('')).toEqual([
      { id: ids.planner, origin: 'planner' },
      { id: ids.idea, origin: 'idea' },
      { id: ids.person, origin: 'person' },
    ]);
    expect(await listed('&show=kept')).toEqual([
      { id: ids.person, origin: 'person' },
    ]);
    expect(await listed('&show=one-offs')).toEqual([
      { id: ids.planner, origin: 'planner' },
      { id: ids.idea, origin: 'idea' },
    ]);
    // A client's typo is refused, never answered with the whole list.
    expectProblem(
      await t.api(token, { method: 'GET', url: '/api/v1/outfits?show=all' }),
      400,
      'validation',
    );
  });

  it("lists Muse's waiting proposals with proposed=true, to their owner only, and leaves the default list as it was", async () => {
    const [shirt, jeans] = await pair();
    const waiting = (
      await create({ slots: [{ category: 'any', garmentId: shirt }] })
    ).json<Saved>().id;
    const setAside = (
      await create({ slots: [{ category: 'any', garmentId: jeans }] })
    ).json<Saved>().id;
    await asFixture(t.db, async (tx) => {
      await tx
        .update(outfit)
        .set({
          proposedAt: new Date(),
          reaction: 'proposed',
          proposalNote: 'For rain',
        })
        .where(eq(outfit.id, waiting));
      await tx
        .update(outfit)
        .set({
          proposedAt: new Date(),
          reaction: 'declined',
          dismissedReason: 'style',
        })
        .where(eq(outfit.id, setAside));
    });
    const ids = async (url: string, as = token) =>
      (await t.api(as, { method: 'GET', url })).json<{
        data: { id: number; proposal?: { note?: string; reaction: string } }[];
      }>().data;

    const proposed = await ids('/api/v1/outfits?proposed=true');
    expect(proposed.map(({ id }) => id)).toEqual([waiting]);
    expect(proposed[0].proposal).toEqual({
      reaction: 'proposed',
      note: 'For rain',
    });
    const owned = (await ids('/api/v1/outfits')).map(({ id }) => id);
    expect(owned).not.toContain(waiting);
    expect(owned).not.toContain(setAside);
    expect(await ids('/api/v1/outfits?proposed=true', strangerToken)).toEqual(
      [],
    );
    expectProblem(
      await t.api(token, {
        method: 'GET',
        url: '/api/v1/outfits?proposed=yes',
      }),
      400,
      'validation',
    );
  });

  it('PATCH changes only what is sent: a rename keeps the rows, `slots` replaces them, null clears', async () => {
    const [shirt, jeans] = await pair();
    const made = await create({
      name: 'Before',
      notes: 'Kept',
      slots: [{ category: 'shirt', garmentId: shirt }, { category: 'belt' }],
    });
    const { id } = made.json<Saved>();
    const patch = (payload: object) =>
      t.api(token, {
        method: 'PATCH',
        url: `/api/v1/outfits/${id}`,
        payload,
      });
    const read = () =>
      t.db
        .select({ name: outfit.name, notes: outfit.notes })
        .from(outfit)
        .where(eq(outfit.id, id));

    const renamed = await patch({ name: 'After' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toEqual({ entriesClaimed: 0 });
    expect(await read()).toEqual([{ name: 'After', notes: 'Kept' }]);
    expect(await slotsOf(id)).toEqual([
      { garmentId: shirt, category: 'shirt' },
      { garmentId: null, category: 'belt' },
    ]);

    await patch({
      notes: null,
      slots: [{ category: 'jeans', garmentId: jeans }],
    });
    expect(await read()).toEqual([{ name: 'After', notes: null }]);
    expect(await slotsOf(id)).toEqual([
      { garmentId: jeans, category: 'jeans' },
    ]);

    expectProblem(
      await t.api(strangerToken, {
        method: 'PATCH',
        url: `/api/v1/outfits/${id}`,
        payload: { name: 'Taken' },
      }),
      404,
      'not_found',
    );
    expect(await read()).toEqual([{ name: 'After', notes: null }]);
  });

  it('DELETE keeps the days it was worn as wears, then is a 404', async () => {
    const [shirt, jeans] = await pair();
    const made = await create({
      slots: [
        { category: 'belt', garmentId: shirt },
        { category: 'x', garmentId: jeans },
      ],
    });
    const { id } = made.json<Saved>();
    const today = t.today();
    await t.inject({
      method: 'POST',
      url: '/calendar',
      payload: { date: today, outfitId: String(id) },
    });
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, id));
    await t.inject({
      method: 'POST',
      url: `/calendar/${entry.id}/worn`,
      payload: { worn: '1' },
    });
    const del = () =>
      t.api(token, { method: 'DELETE', url: `/api/v1/outfits/${id}` });
    expect((await del()).statusCode).toBe(204);
    expect(await t.db.$count(outfit, eq(outfit.id, id))).toBe(0);
    const kept = await t.db
      .select({ garmentId: garmentWear.garmentId })
      .from(garmentWear)
      .where(and(eq(garmentWear.day, today), eq(garmentWear.garmentId, jeans)));
    expect(kept).toHaveLength(1);
    expectProblem(await del(), 404, 'not_found');
  });
});

describe('wears, washes and away', () => {
  const wear = (id: number, day: string, method: 'PUT' | 'DELETE' = 'PUT') =>
    t.api(token, { method, url: `/api/v1/garments/${id}/wears/${day}` });

  it('wears a garment on a day of the last week once, and undoes it', async () => {
    const id = await createGarment(t, { name: 'Worn tee' });
    const day = addDays(t.today(), -2);
    expect((await wear(id, day)).json()).toEqual({
      day,
      worn: true,
      changed: true,
    });
    expect((await wear(id, day)).json()).toMatchObject({ changed: false });
    expect(await t.db.$count(garmentWear, eq(garmentWear.garmentId, id))).toBe(
      1,
    );
    expect((await wear(id, day, 'DELETE')).json()).toEqual({
      day,
      worn: false,
      changed: true,
    });
    expect((await wear(id, day, 'DELETE')).json()).toMatchObject({
      changed: false,
    });
    expectProblem(await wear(id, addDays(t.today(), -8)), 409, 'conflict');
    expectProblem(await wear(id, addDays(t.today(), 1)), 409, 'conflict');
    const wanted = await createWishlistItem(t, { name: 'Unworn wish' });
    expectProblem(await wear(wanted, t.today()), 409, 'conflict');
  });

  it('washes one garment forward only, and many on laundry day (others ignored)', async () => {
    const id = await createGarment(t, { name: 'Washed tee' });
    const wash = (day: string) =>
      t.api(token, {
        method: 'POST',
        url: `/api/v1/garments/${id}/washes`,
        payload: { day },
      });
    const today = t.today();
    expect((await wash(today)).json()).toEqual({ day: today, changed: true });
    expect((await wash(addDays(today, -1))).json()).toMatchObject({
      changed: false,
    });

    const other = await createGarment(t, { name: 'Laundry tee' });
    const strangers = await createGarment(t, {
      name: 'Not mine',
      cookie: await t.register('api-laundry-other@example.com'),
    });
    const laundry = await t.api(token, {
      method: 'POST',
      url: '/api/v1/garments/washes',
      payload: { garmentIds: [other, strangers], day: today },
    });
    expect(laundry.statusCode, laundry.body).toBe(200);
    expect(laundry.json()).toEqual({ washed: [other] });
    const [row] = await t.db
      .select({ lastWashedOn: garment.lastWashedOn })
      .from(garment)
      .where(eq(garment.id, strangers));
    expect(row.lastWashedOn).toBeNull();
  });

  // #676: `at` orders a wear and a wash of one day; the server judges it.
  it('stores a posted `at` on its day, caps one after now, and drops one off its day', async () => {
    const day = addDays(t.today(), -1);
    const at = (onDay: string, hour: number) =>
      instantAt(onDay, hour, t.timeZone).toISOString();
    const wornAtOf = async (id: number) =>
      (
        await t.db
          .select({ wornAt: garmentWear.wornAt })
          .from(garmentWear)
          .where(eq(garmentWear.garmentId, id))
      ).map((row) => row.wornAt?.toISOString() ?? null);
    const washedAtOf = async (id: number) =>
      (
        await t.db
          .select({ washedAt: garment.washedAt })
          .from(garment)
          .where(eq(garment.id, id))
      )[0].washedAt;

    const tee = await createGarment(t, { name: 'Timed tee' });
    const worn = await t.api(token, {
      method: 'PUT',
      url: `/api/v1/garments/${tee}/wears/${day}`,
      payload: { at: at(day, 19) },
    });
    expect(worn.statusCode, worn.body).toBe(200);
    expect(await wornAtOf(tee)).toEqual([at(day, 19)]);
    const washed = await t.api(token, {
      method: 'POST',
      url: `/api/v1/garments/${tee}/washes`,
      payload: { day, at: at(day, 9) },
    });
    expect(washed.json()).toEqual({ day, changed: true });
    expect((await washedAtOf(tee))?.toISOString()).toBe(at(day, 9));

    // A fast client clock: an hour ahead is stored as the server's now.
    const fast = await createGarment(t, { name: 'Fast-clock tee' });
    const before = Date.now();
    await t.api(token, {
      method: 'POST',
      url: `/api/v1/garments/${fast}/washes`,
      payload: {
        day: t.today(),
        at: new Date(before + 3_600_000).toISOString(),
      },
    });
    const capped = (await washedAtOf(fast))!.getTime();
    expect(capped).toBeGreaterThanOrEqual(before);
    expect(capped).toBeLessThanOrEqual(Date.now());

    // Off its day (a wrong clock): the day rule, no instant.
    const offDay = await createGarment(t, { name: 'Off-day tee' });
    const laundry = await t.api(token, {
      method: 'POST',
      url: '/api/v1/garments/washes',
      payload: {
        garmentIds: [offDay],
        day,
        at: at(addDays(day, -2), 19),
      },
    });
    expect(laundry.json()).toEqual({ washed: [offDay] });
    expect(await washedAtOf(offDay)).toBeNull();
  });

  it('puts a garment away with a note and back, set-state', async () => {
    const id = await createGarment(t, { name: 'Lent coat' });
    const away = (payload: object) =>
      t.api(token, {
        method: 'PUT',
        url: `/api/v1/garments/${id}/away`,
        payload,
      });
    expect((await away({ away: 'lent', note: ' Sam ' })).json()).toEqual({
      away: 'lent',
      note: 'Sam',
    });
    expect((await away({ away: null, note: 'dropped' })).json()).toEqual({});
    const [row] = await t.db
      .select({ away: garment.away, awayNote: garment.awayNote })
      .from(garment)
      .where(eq(garment.id, id));
    expect(row).toEqual({ away: null, awayNote: null });
  });
});
