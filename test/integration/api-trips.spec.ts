import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  outfit,
  outfitCalendar,
  trip,
  tripGarmentPacked,
  tripItem,
  tripOutfit,
} from '../../src/db/schema';
import { deviceToken, expectProblem } from './api';
import { createGarment } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * Trips and packing on /api/v1 (#194a): each its page twin's writer
 * through trip-actions.ts, with a JSON body. Who may do what is the
 * authorization matrix's (authorization-trips.spec.ts replays every case
 * on these twins); what each costs is api-statements'.
 */

let t: TestApp;
let token: string;
let strangerToken: string;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

beforeAll(async () => {
  t = await createTestApp();
  token = (await deviceToken(t)).token;
  const email = 'api-trips-stranger@example.com';
  await t.register(email);
  strangerToken = (await deviceToken(t, { email })).token;
});

afterAll(async () => {
  await t?.cleanup();
});

/** A trip of the owner's through the API: its id. */
async function newTrip(
  fields: { name?: string; startsOn?: string; endsOn?: string } = {},
): Promise<number> {
  const today = t.today();
  const res = await api('POST', '/trips', {
    name: 'Api trip',
    startsOn: today,
    endsOn: addDays(today, 1),
    ...fields,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

/** A saved outfit of one new garment: both ids. */
async function newOutfit(
  name = 'Api tee',
): Promise<{ outfitId: number; garmentId: number }> {
  const garmentId = await createGarment(t, { name, category: 'shirt' });
  const res = await api('POST', '/outfits', {
    slots: [{ category: 'shirt', garmentId }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return { outfitId: res.json<{ id: number }>().id, garmentId };
}

const tripOutfitsOf = (tripId: number) =>
  t.db
    .select({
      id: tripOutfit.id,
      outfitId: tripOutfit.outfitId,
      day: tripOutfit.day,
      occasion: tripOutfit.occasion,
    })
    .from(tripOutfit)
    .where(eq(tripOutfit.tripId, tripId))
    .orderBy(tripOutfit.id);

describe('trips', () => {
  // #861: without WEATHER_ENABLED no search offers a place, so posted
  // coordinates are neither kept nor counted against the destination budget.
  it('ignores a place without weather, on the API and the page, charging nothing', async () => {
    const today = t.today();
    const dates = { startsOn: today, endsOn: addDays(today, 1) };
    const place = { name: 'Austin', latitude: 30.27, longitude: -97.74 };
    const ids: number[] = [];
    // One more than the destination budget's 10 a minute.
    for (let i = 0; i < 11; i++) {
      const made = await api('POST', '/trips', {
        name: `Unlocated ${i}`,
        ...dates,
        place,
      });
      expect(made.statusCode, made.body).toBe(201);
      const body = made.json<{ id: number; placeDeferred: boolean }>();
      expect(body.placeDeferred).toBe(false);
      ids.push(body.id);
    }
    const page = await t.inject({
      method: 'POST',
      url: '/trips',
      payload: new URLSearchParams({
        name: 'Unlocated page',
        destination: 'Austin',
        ...dates,
        notes: '',
        latitude: '30.27',
        longitude: '-97.74',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(page.statusCode, page.body).toBe(303);
    expect(String(page.headers.location)).toMatch(/^\/trips\/\d+\?created=1$/);
    ids.push(Number(/^\/trips\/(\d+)/.exec(String(page.headers.location))![1]));
    const located = await t.db.$count(
      trip,
      and(inArray(trip.id, ids), isNotNull(trip.latitude)),
    );
    expect(located).toBe(0);
    expect(
      t.logs
        .ops('trip.created')
        .filter((line) => ids.includes(line.tripId as number))
        .map((line) => line.located),
    ).toEqual(ids.map(() => false));
  });

  it('creates a trip judged by the form: 201 with its Location, a refusal naming the field', async () => {
    const today = t.today();
    const made = await api('POST', '/trips', {
      name: '  Lisbon  ',
      destination: 'Lisbon',
      startsOn: today,
      endsOn: addDays(today, 2),
      clientId: '3b0f9d0e-8a7c-4f61-9b2e-5d4c3b2a1f00',
    });
    expect(made.statusCode, made.body).toBe(201);
    const { id } = made.json<{ id: number }>();
    expect(made.headers.location).toBe(`/api/v1/trips/${id}`);
    const [row] = await t.db
      .select({ name: trip.name, destination: trip.destination })
      .from(trip)
      .where(eq(trip.id, id));
    expect(row).toEqual({ name: 'Lisbon', destination: 'Lisbon' });
    expect(t.logs.ops('trip.created').at(-1)).toMatchObject({
      tripId: id,
      surface: 'api',
      changed: true,
      clientId: '3b0f9d0e',
    });

    const before = await t.db.$count(trip);
    const backward = await api('POST', '/trips', {
      name: ' ',
      startsOn: today,
      endsOn: addDays(today, -1),
    });
    const problem = expectProblem(backward, 400, 'validation');
    expect(problem.errors?.map(({ path }) => path).sort()).toEqual([
      'body/endsOn',
      'body/name',
    ]);
    // Never coerced: a day is a string.
    expectProblem(
      await api('POST', '/trips', {
        name: 'X',
        startsOn: 20261113,
        endsOn: today,
      }),
      400,
      'validation',
    );
    expect(await t.db.$count(trip)).toBe(before);
  });

  it('lists upcoming trips first, a page at a time; a forged cursor is a 400', async () => {
    const owner = 'api-trips-list@example.com';
    await t.register(owner);
    const own = (await deviceToken(t, { email: owner })).token;
    const today = t.today();
    const make = (name: string, startsOn: string) =>
      api('POST', '/trips', { name, startsOn, endsOn: startsOn }, own);
    await make('Past', addDays(today, -10));
    await make('Later', addDays(today, 20));
    await make('Soon', addDays(today, 3));

    const first = await api('GET', '/trips?limit=2', undefined, own);
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<{
      data: { name: string; phase: string; outfitCount: number }[];
      pagination: { nextCursor?: string; limit: number };
    }>();
    expect(page.data.map(({ name, phase }) => [name, phase])).toEqual([
      ['Soon', 'upcoming'],
      ['Later', 'upcoming'],
    ]);
    expect(page.data[0].outfitCount).toBe(0);
    expect(page.pagination.limit).toBe(2);
    const next = await api(
      'GET',
      `/trips?limit=2&cursor=${page.pagination.nextCursor}`,
      undefined,
      own,
    );
    expect(next.json()).toMatchObject({
      data: [{ name: 'Past', phase: 'past' }],
      pagination: { limit: 2 },
    });
    expect(next.json<{ pagination: object }>().pagination).not.toHaveProperty(
      'nextCursor',
    );
    const forged = Buffer.from('at:0').toString('base64url');
    expectProblem(
      await api('GET', `/trips?cursor=${forged}`, undefined, own),
      400,
      'validation',
    );
  });

  it('reads a trip as its page does: days, any day, the packing list and the extras', async () => {
    const { outfitId, garmentId } = await newOutfit('Read tee');
    const tripId = await newTrip({ name: 'Read trip' });
    const today = t.today();
    expect(
      (await api('POST', `/trips/${tripId}/outfits`, { outfitId, day: today }))
        .statusCode,
    ).toBe(201);
    await api('PUT', `/trips/${tripId}/packing/${garmentId}`, { packed: true });
    await api('POST', `/trips/${tripId}/items`, { label: 'Charger' });

    const res = await api('GET', `/trips/${tripId}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      id: tripId,
      name: 'Read trip',
      located: false,
      phase: 'current',
      anyDay: [],
      packing: { garments: 1, packed: 1, pieces: 1 },
      extras: [{ label: 'Charger', packed: false }],
    });
    expect(body).not.toHaveProperty('destination');
    const days = body.days as {
      day: string;
      outfits: { outfitId: number; garments: { id: number }[] }[];
    }[];
    expect(days.map(({ day }) => day)).toEqual([today, addDays(today, 1)]);
    expect(days[0].outfits).toMatchObject([
      { outfitId, day: today, garments: [{ id: garmentId, name: 'Read tee' }] },
    ]);
    const groups = (body.packing as { groups: unknown[] }).groups;
    expect(groups).toMatchObject([
      {
        garments: [
          { id: garmentId, wears: 1, copiesNeeded: 1, pack: 1, packed: true },
        ],
      },
    ]);

    const foreign = await api(
      'GET',
      `/trips/${tripId}`,
      undefined,
      strangerToken,
    );
    expectProblem(foreign, 404, 'not_found');
    expect(foreign.body).not.toContain('Read trip');
  });

  it('replaces the fields whole: outfits off the new dates move to any day, a blank name is a 400', async () => {
    const { outfitId } = await newOutfit('Moved tee');
    const today = t.today();
    const tripId = await newTrip({ name: 'Moving', endsOn: addDays(today, 2) });
    await api('POST', `/trips/${tripId}/outfits`, {
      outfitId,
      day: addDays(today, 2),
    });
    const saved = await api('PUT', `/trips/${tripId}`, {
      name: 'Shorter',
      startsOn: today,
      endsOn: today,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ undated: 1, locationCleared: false });
    expect(await tripOutfitsOf(tripId)).toMatchObject([
      { outfitId, day: null },
    ]);

    const blank = await api('PUT', `/trips/${tripId}`, {
      name: '',
      startsOn: today,
      endsOn: today,
    });
    expect(
      expectProblem(blank, 400, 'validation').errors?.map(({ path }) => path),
    ).toEqual(['body/name']);
    // Another's trip is a 404 whatever was sent, a refused body too.
    for (const name of ['', 'Taken']) {
      expectProblem(
        await api(
          'PUT',
          `/trips/${tripId}`,
          { name, startsOn: today, endsOn: today },
          strangerToken,
        ),
        404,
        'not_found',
      );
    }
    const [row] = await t.db
      .select({ name: trip.name })
      .from(trip)
      .where(eq(trip.id, tripId));
    expect(row.name).toBe('Shorter');
  });

  it('deletes a trip, keeping its outfits; again is a 404', async () => {
    const { outfitId } = await newOutfit('Kept tee');
    const tripId = await newTrip();
    await api('POST', `/trips/${tripId}/outfits`, { outfitId });
    expect((await api('DELETE', `/trips/${tripId}`)).statusCode).toBe(204);
    expect(await t.db.$count(trip, eq(trip.id, tripId))).toBe(0);
    expect(await t.db.$count(outfit, eq(outfit.id, outfitId))).toBe(1);
    expectProblem(await api('DELETE', `/trips/${tripId}`), 404, 'not_found');
  });
});

describe('trip outfits', () => {
  it('adds a saved outfit once a day (201, then 200 added: false) and refuses a day outside the trip', async () => {
    const { outfitId } = await newOutfit('Once tee');
    const tripId = await newTrip();
    const today = t.today();
    const body = { outfitId, day: today, occasion: 'evening' };
    const added = await api('POST', `/trips/${tripId}/outfits`, body);
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toEqual({
      outfitId,
      outfitCreated: false,
      added: true,
    });
    const again = await api('POST', `/trips/${tripId}/outfits`, {
      ...body,
      occasion: 'work',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ added: false });
    expect(await tripOutfitsOf(tripId)).toMatchObject([
      { outfitId, day: today, occasion: 'evening' },
    ]);

    const outside = await api('POST', `/trips/${tripId}/outfits`, {
      outfitId,
      day: addDays(today, 5),
    });
    expect(expectProblem(outside, 400, 'validation').detail).toContain(today);
    expect(await tripOutfitsOf(tripId)).toHaveLength(1);
  });

  it("makes an idea's garments an outfit on the trip, and wants exactly one of outfitId and garmentIds", async () => {
    const garmentId = await createGarment(t, {
      name: 'Idea tee',
      category: 'shirt',
    });
    const tripId = await newTrip();
    const picked = await api('POST', `/trips/${tripId}/outfits`, {
      garmentIds: [garmentId],
      name: 'Idea',
    });
    expect(picked.statusCode, picked.body).toBe(201);
    const { outfitId } = picked.json<{ outfitId: number }>();
    expect(picked.json()).toEqual({
      outfitId,
      outfitCreated: true,
      added: true,
    });
    expect(await tripOutfitsOf(tripId)).toMatchObject([
      { outfitId, day: null },
    ]);

    for (const payload of [{}, { outfitId, garmentIds: [garmentId] }]) {
      const refused = await api('POST', `/trips/${tripId}/outfits`, payload);
      expect(
        expectProblem(refused, 400, 'validation').errors?.map(
          ({ path }) => path,
        ),
      ).toEqual(['body/outfitId']);
    }
    // Another's outfit is the outfit's 404, nothing added.
    const { outfitId: foreign } = await newOutfit('Mine only');
    const strangerTrip = await api(
      'POST',
      '/trips',
      { name: 'Theirs', startsOn: t.today(), endsOn: t.today() },
      strangerToken,
    );
    const theirTripId = strangerTrip.json<{ id: number }>().id;
    expectProblem(
      await api(
        'POST',
        `/trips/${theirTripId}/outfits`,
        { outfitId: foreign },
        strangerToken,
      ),
      404,
      'not_found',
    );
    expect(await tripOutfitsOf(theirTripId)).toEqual([]);
  });

  it('takes an outfit off with its packed marks; again is a 404', async () => {
    const { outfitId, garmentId } = await newOutfit('Off tee');
    const tripId = await newTrip();
    await api('POST', `/trips/${tripId}/outfits`, { outfitId });
    await api('PUT', `/trips/${tripId}/packing/${garmentId}`, { packed: true });
    const [{ id: tripOutfitId }] = await tripOutfitsOf(tripId);
    const removed = await api(
      'DELETE',
      `/trips/${tripId}/outfits/${tripOutfitId}`,
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ outfitId, unpacked: 1 });
    expect(
      await t.db.$count(
        tripGarmentPacked,
        eq(tripGarmentPacked.tripId, tripId),
      ),
    ).toBe(0);
    expectProblem(
      await api('DELETE', `/trips/${tripId}/outfits/${tripOutfitId}`),
      404,
      'not_found',
    );
  });

  it("wears today's outfit once through the calendar, and refuses one of another day (409)", async () => {
    const { outfitId } = await newOutfit('Worn tee');
    const today = t.today();
    const tripId = await newTrip();
    await api('POST', `/trips/${tripId}/outfits`, { outfitId, day: today });
    await api('POST', `/trips/${tripId}/outfits`, {
      outfitId,
      day: addDays(today, 1),
    });
    const [todays, tomorrows] = await tripOutfitsOf(tripId);
    const url = `/trips/${tripId}/outfits/${todays.id}/wears`;
    const worn = await api('POST', url);
    expect(worn.statusCode, worn.body).toBe(200);
    const { entryId } = worn.json<{ entryId: number }>();
    expect(worn.json()).toEqual({
      outfitId,
      day: today,
      occasion: 'all-day',
      entryId,
      changed: true,
    });
    expect((await api('POST', url)).json()).toMatchObject({
      entryId,
      changed: false,
    });
    const entries = await t.db
      .select({ id: outfitCalendar.id, worn: isNotNull(outfitCalendar.wornAt) })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.outfitId, outfitId),
          eq(outfitCalendar.day, today),
        ),
      );
    expect(entries).toEqual([{ id: entryId, worn: true }]);
    // Only today's copy reports the entry, not the same outfit tomorrow.
    const { days } = (await api('GET', `/trips/${tripId}`)).json<{
      days: { outfits: { wornTodayEntryId?: number | null }[] }[];
    }>();
    expect(days[0].outfits[0].wornTodayEntryId).toBe(entryId);
    expect(days[1].outfits[0].wornTodayEntryId ?? null).toBeNull();
    expectProblem(
      await api('POST', `/trips/${tripId}/outfits/${tomorrows.id}/wears`),
      409,
      'conflict',
    );
  });
});

describe('packing and extras', () => {
  it('ticks a garment set-state; one the list does not hold is a 404', async () => {
    const { outfitId, garmentId } = await newOutfit('Tick tee');
    const loose = await createGarment(t, { name: 'Loose', category: 'shirt' });
    const tripId = await newTrip();
    await api('POST', `/trips/${tripId}/outfits`, { outfitId });
    const url = `/trips/${tripId}/packing/${garmentId}`;
    const marks = () =>
      t.db.$count(tripGarmentPacked, eq(tripGarmentPacked.tripId, tripId));

    expect((await api('PUT', url, { packed: true })).json()).toEqual({
      garmentId,
      packed: true,
      changed: true,
    });
    expect((await api('PUT', url, { packed: true })).json()).toMatchObject({
      changed: false,
    });
    expect(await marks()).toBe(1);
    expect((await api('PUT', url, { packed: false })).json()).toMatchObject({
      packed: false,
      changed: true,
    });
    expect(await marks()).toBe(0);

    expectProblem(
      await api('PUT', `/trips/${tripId}/packing/${loose}`, { packed: true }),
      404,
      'not_found',
    );
    expectProblem(await api('PUT', url, { packed: 'true' }), 400, 'validation');
    expect(await marks()).toBe(0);
  });

  it('adds an extra once in any case, ticks it, copies, removes; a gone extra is a 404', async () => {
    const tripId = await newTrip();
    const otherId = await newTrip({ name: 'Other' });
    const add = (label: string, to = tripId) =>
      api('POST', `/trips/${to}/items`, { label });

    expect((await add(' Charger ')).statusCode).toBe(201);
    const again = await add('charger');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ added: false });
    expectProblem(await add('   '), 400, 'validation');
    const [{ id: itemId }] = await t.db
      .select({ id: tripItem.id })
      .from(tripItem)
      .where(eq(tripItem.tripId, tripId));

    const item = `/trips/${tripId}/items/${itemId}`;
    expect((await api('PATCH', item, { packed: true })).json()).toEqual({
      id: itemId,
      label: 'Charger',
      packed: true,
      changed: true,
    });
    expect((await api('PATCH', item, { packed: true })).json()).toMatchObject({
      changed: false,
    });

    await add('Passport', otherId);
    await add('Charger', otherId);
    const copy = () =>
      api('POST', `/trips/${tripId}/items/copies`, { fromTripId: otherId });
    expect((await copy()).json()).toEqual({ added: 1 });
    expect((await copy()).json()).toEqual({ added: 0 });
    expectProblem(
      await api('POST', `/trips/${tripId}/items/copies`, {
        fromTripId: tripId,
      }),
      404,
      'not_found',
    );

    expect((await api('DELETE', item)).statusCode).toBe(204);
    expectProblem(await api('DELETE', item), 404, 'not_found');
    expectProblem(
      await api('PATCH', item, { packed: false }),
      404,
      'not_found',
    );
  });
});
