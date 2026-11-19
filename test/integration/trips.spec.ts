import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  garmentWear,
  outfitCalendar,
  trip,
  tripGarmentPacked,
  tripItem,
  tripOutfit,
  weatherForecast,
} from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { deleteOutfit } from '../../src/web/outfits/queries';
import { addTripOutfit } from '../../src/web/trips/queries';
import {
  STUB_WEATHER_NOW,
  startWeatherStub,
  type WeatherStub,
} from '../support/weather-stub';
import {
  createTestApp,
  hasText,
  hxLocationPath,
  recordQueries,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import { interleave } from './interleave';
import { callTool, createAccessToken, tool } from './mcp';
import {
  expectFragment,
  expectFullPage,
  expectOfflineGuarded,
  HX_FRAGMENT,
} from './pages';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * Trips and packing lists (#10): the trip form, outfits for its days and
 * occasions (from the saved list and from the gallery with `for=trip:ID`),
 * the derived packing list (copies needed, warnings; the rule itself is
 * unit-tested in src/wardrobe/packing.spec.ts), packed marks that survive
 * edits and leave with their garments, extras and their copy from another
 * trip, "Wore it" (and its Undo) through the calendar, the destination's
 * forecast, and the MCP tools.
 */

type Fields = Record<string, string | string[]>;

const form = (fields: Fields) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
};

describe('trips', () => {
  let t: TestApp;
  let stub: WeatherStub;
  let token: string;
  // The owner's closet: 3 white tees, jeans, sneakers, a jacket, 6 socks.
  let tee: number;
  let jeans: number;
  let sneakers: number;
  let jacket: number;
  let socks: number;
  let polo: number;
  let dayOutfit: number;
  let dinnerOutfit: number;
  let poloOutfit: number;

  const post = (url: string, fields: Fields, headers = {}) => {
    const body = form(fields);
    return t.inject({
      method: 'POST',
      url,
      payload: body.payload,
      headers: { ...body.headers, ...headers },
    });
  };
  const get = (url: string) => t.inject({ method: 'GET', url });

  const garment = async (fields: Fields): Promise<number> => {
    const res = await post('/wardrobe', { props: '1', care: '1', ...fields });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const outfitOf = async (
    name: string,
    garments: [category: string, id: number][],
  ): Promise<number> => {
    const res = await post('/outfits', {
      name,
      category: garments.map(([category]) => category),
      garmentId: garments.map(([, id]) => String(id)),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  const newTrip = async (fields: Partial<Record<string, string>> = {}) => {
    const today = t.today();
    const res = await post('/trips', {
      name: 'Austin conference',
      destination: '',
      startsOn: addDays(today, 3),
      endsOn: addDays(today, 7),
      notes: '',
      ...fields,
    });
    expect(res.statusCode, res.body).toBe(303);
    const location = String(res.headers.location);
    expect(location).toMatch(/^\/trips\/\d+\?created=1$/);
    return Number(/^\/trips\/(\d+)/.exec(location)![1]);
  };

  const addOutfit = (
    tripId: number,
    outfitId: number,
    slot: { day?: string; occasion?: string } = {},
  ) =>
    post(`/trips/${tripId}/outfits`, {
      outfitId: String(outfitId),
      day: slot.day ?? '',
      occasion: slot.occasion ?? '',
    });

  const packedOf = async (tripId: number) =>
    (
      await t.db
        .select({ id: tripGarmentPacked.garmentId })
        .from(tripGarmentPacked)
        .where(eq(tripGarmentPacked.tripId, tripId))
    )
      .map((row) => row.id)
      .sort((a, b) => a - b);

  const pack = (
    tripId: number,
    packed: number[],
    shown: number[],
    headers = {},
  ) =>
    post(
      `/trips/${tripId}/packed`,
      { packed: packed.map(String), shown: shown.map(String) },
      headers,
    );

  /** A garment's row on the trip page: its pack count and warnings. */
  const packingRow = (html: string, garmentId: number): string => {
    const start = html.indexOf(`data-packing-garment="${garmentId}"`);
    expect(start, `garment ${garmentId} on the list`).toBeGreaterThan(-1);
    const ends = [
      html.indexOf('data-packing-garment=', start + 1),
      html.indexOf('</fieldset>', start),
    ].filter((end) => end > -1);
    return html.slice(start, Math.min(...ends));
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW });
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
    tee = await garment({
      name: 'White tee',
      category: 'tops',
      color: ['white'],
      quantity: '3',
    });
    jeans = await garment({
      name: 'Raw jeans',
      category: 'bottoms',
      color: ['blue'],
    });
    sneakers = await garment({
      name: 'White sneakers',
      category: 'footwear',
      color: ['white'],
    });
    jacket = await garment({
      name: 'Denim jacket',
      category: 'outerwear',
      color: ['blue'],
    });
    socks = await garment({
      name: 'Socks',
      category: 'accessories',
      color: ['white'],
      quantity: '6',
      washAfterWears: '1',
    });
    polo = await garment({
      name: 'Navy polo',
      category: 'tops',
      color: ['blue'],
    });
    dayOutfit = await outfitOf('Conference day', [
      ['tops', tee],
      ['bottoms', jeans],
      ['footwear', sneakers],
      ['accessories', socks],
    ]);
    dinnerOutfit = await outfitOf('Dinner', [
      ['outerwear', jacket],
      ['tops', tee],
      ['bottoms', jeans],
      ['footwear', sneakers],
    ]);
    poloOutfit = await outfitOf('Polo day', [
      ['tops', polo],
      ['bottoms', jeans],
    ]);
    token = await createAccessToken(t);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await t?.cleanup();
    await stub?.close();
  });

  describe('the trip form', () => {
    it('creates a trip and lists it under the Calendar’s Trips tab', async () => {
      const id = await newTrip({ name: '  Lisbon  ', destination: ' Lisbon ' });
      const [row] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(row).toMatchObject({
        name: 'Lisbon',
        destination: 'Lisbon',
        latitude: null,
        ownerId: t.owner.id,
      });
      const list = await get('/trips');
      expect(list.statusCode).toBe(200);
      expectFullPage(list);
      expect(list.body).toContain(`href="/trips/${id}"`);
      expect(await addOutfit(id, dayOutfit)).toMatchObject({ statusCode: 303 });
      await post(`/trips/${id}/items`, { label: 'Adapter' });
      await post(`/trips/${id}/items`, { label: 'Charger' });
      const counted = unescapeHtml((await get('/trips')).body);
      const card = counted.slice(counted.indexOf(`data-trip="${id}"`));
      expect(card.slice(0, card.indexOf('</a>'))).toContain(
        'Outfits: 1 · Extras: 2',
      );
      // The Calendar's tabs, Trips current; the dock marks the Calendar.
      expect(list.body).toMatch(/href="\/trips"[^>]*class="tab tab-active"/);
      expect(list.body).toMatch(/href="\/calendar"[^>]*class="tab"/);
      const page = await get(`/trips/${id}?created=1`);
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      expect(page.body).toContain('Trip created');
      // One section per day, then "Any day".
      expect(
        page.body.match(/data-trip-day="\d{4}-\d{2}-\d{2}"/g),
      ).toHaveLength(5);
      expect(page.body).toContain('data-trip-day="any"');
    });

    it('is disabled offline, new and edit alike: a cached copy must not post into the offline page', async () => {
      const id = await newTrip();
      for (const [url, action] of [
        ['/trips/new', '/trips'],
        [`/trips/${id}/edit`, `/trips/${id}`],
      ]) {
        const res = await get(url);
        expect(res.statusCode).toBe(200);
        expectOfflineGuarded(res, action);
      }
    });

    it('refuses a blank name, a backward range or a trip past 60 days, with messages', async () => {
      const today = t.today();
      const before = await t.db.$count(trip);
      const valid = {
        name: 'Refused',
        startsOn: today,
        endsOn: addDays(today, 2),
      };
      const cases: [Fields, string][] = [
        [{ ...valid, name: '  ' }, 'Give the trip a name'],
        [
          { ...valid, startsOn: addDays(today, 5), endsOn: addDays(today, 4) },
          'The last day comes before the first',
        ],
        [{ ...valid, endsOn: addDays(today, 60) }, 'A trip is at most 60 days'],
        [{ ...valid, startsOn: '' }, 'Choose a day'],
      ];
      for (const [fields, message] of cases) {
        const res = await post('/trips', fields);
        expect(res.statusCode).toBe(400);
        expectFullPage(res);
        expect(res.body).toContain(message);
      }
      expect(await t.db.$count(trip)).toBe(before);
    });

    it('moves outfits of days a new date range leaves out to any day, once each', async () => {
      const id = await newTrip();
      const first = addDays(t.today(), 3);
      const last = addDays(t.today(), 7);
      expect((await addOutfit(id, dayOutfit, { day: first })).statusCode).toBe(
        303,
      );
      expect((await addOutfit(id, dayOutfit, { day: last })).statusCode).toBe(
        303,
      );
      expect(
        (await addOutfit(id, poloOutfit, { day: last, occasion: 'evening' }))
          .statusCode,
      ).toBe(303);
      const res = await post(`/trips/${id}`, {
        name: 'Shorter',
        startsOn: addDays(first, 1),
        endsOn: addDays(last, -1),
      });
      expect(res.statusCode).toBe(303);
      const rows = await t.db
        .select({
          outfitId: tripOutfit.outfitId,
          day: tripOutfit.day,
          occasion: tripOutfit.occasion,
        })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      // The day outfit was on two dropped days: one undated row, not two.
      expect(rows.sort((a, b) => a.outfitId - b.outfitId)).toEqual([
        { outfitId: dayOutfit, day: null, occasion: null },
        { outfitId: poloOutfit, day: null, occasion: 'evening' },
      ]);
    });
  });

  describe('outfits on a trip', () => {
    let id: number;
    let days: string[];

    beforeAll(async () => {
      id = await newTrip();
      days = [0, 1, 2, 3, 4].map((n) => addDays(t.today(), 3 + n));
    });

    it('adds a saved outfit for a day and an occasion, once', async () => {
      const res = await addOutfit(id, dayOutfit, {
        day: days[0],
        occasion: 'daytime',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/trips/${id}#day-${days[0]}`);
      // Again, even for another occasion: nothing more, the first occasion kept.
      expect(
        (await addOutfit(id, dayOutfit, { day: days[0], occasion: 'evening' }))
          .statusCode,
      ).toBe(303);
      const rows = await t.db
        .select({ day: tripOutfit.day, occasion: tripOutfit.occasion })
        .from(tripOutfit)
        .where(
          and(eq(tripOutfit.tripId, id), eq(tripOutfit.outfitId, dayOutfit)),
        );
      expect(rows).toEqual([{ day: days[0], occasion: 'daytime' }]);
      expect(t.logs.ops('trip.outfit.added').at(-1)).toMatchObject({
        tripId: id,
        outfitId: dayOutfit,
        day: days[0],
        occasion: 'evening',
        changed: false,
      });
    });

    it('refuses a day outside the trip (400) and someone else’s outfit (404)', async () => {
      expect(
        (await addOutfit(id, dayOutfit, { day: addDays(days[4], 1) }))
          .statusCode,
      ).toBe(400);
      const cookie = await t.register('other-trips@example.com');
      const theirs = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...form({ name: 'Theirs', category: 'tops', garmentId: '' }),
        headers: { ...form({}).headers, cookie },
      });
      const theirOutfit = Number(
        /^\/outfits\/(\d+)$/.exec(String(theirs.headers.location))![1],
      );
      expect((await addOutfit(id, theirOutfit)).statusCode).toBe(404);
    });

    // addTripOutfit's locking statement has a snapshot that predates its
    // wait for the locks (the owner's, then the trip's): an outfit deleted
    // during that wait must be read again (owned, FOR KEY SHARE), or the
    // insert dies on the foreign key (500).
    it('answers no-outfit, writing nothing, for an outfit deleted while it waited for the locks', async () => {
      const doomed = await outfitOf('Deleted meanwhile', [['tops', polo]]);
      const [, added] = await interleave(
        t.db,
        (tx) => deleteOutfit(tx, doomed, t.owner.id),
        () =>
          addTripOutfit(t.db, {
            tripId: id,
            ownerId: t.owner.id,
            outfitId: doomed,
            madeBy: BY_PERSON,
          }),
      );
      expect(added).toBe('no-outfit');
      expect(
        await t.db.$count(tripOutfit, eq(tripOutfit.outfitId, doomed)),
      ).toBe(0);
    });

    it('offers the saved outfits on the add page, those on the day disabled', async () => {
      const res = await get(
        `/trips/${id}/outfits/new?day=${days[0]}&occasion=evening`,
      );
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(html).toMatch(new RegExp(`value="${dayOutfit}"[^>]*disabled=""`));
      expect(html).not.toMatch(
        new RegExp(`value="${poloOutfit}"[^>]*disabled=""`),
      );
      expect(html).toContain(`name="day" value="${days[0]}"`);
      expect(html).toContain('name="occasion" value="evening"');
      // Ideas for the same day and occasion, through the gallery.
      expect(html).toContain(
        `/outfits/ideas?for=trip:${id}:${days[0]}&occasion=evening`,
      );
      // A day that is not the trip's is no day (navigation state).
      const lenient = await get(
        `/trips/${id}/outfits/new?day=1999-01-01&occasion=brunch`,
      );
      expect(lenient.statusCode).toBe(200);
      expect(unescapeHtml(lenient.body)).toContain('name="day" value=""');
    });
  });

  describe('the packing list', () => {
    let id: number;
    let days: string[];

    beforeAll(async () => {
      id = await newTrip();
      days = [0, 1, 2, 3, 4].map((n) => addDays(t.today(), 3 + n));
      // The day outfit every day, dinner on the first two: tees and jeans
      // worn once a day whatever the occasions.
      for (const day of days) {
        expect(
          (await addOutfit(id, dayOutfit, { day, occasion: 'daytime' }))
            .statusCode,
        ).toBe(303);
      }
      for (const day of days.slice(0, 2)) {
        expect(
          (await addOutfit(id, dinnerOutfit, { day, occasion: 'evening' }))
            .statusCode,
        ).toBe(303);
      }
    });

    it('lists each garment once, by role, with the copies to pack and why not', async () => {
      const res = await get(`/trips/${id}`);
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      // The aside holds the extras and the notes too (#1147).
      expect(html).toMatch(
        /<aside id="trip-aside"[^>]*aria-label="Packing and notes"/,
      );
      const roles = [...html.matchAll(/<fieldset data-role="([a-z-]+)"/g)].map(
        (m) => m[1],
      );
      expect(roles).toEqual([
        'layer',
        'top',
        'bottom',
        'footwear',
        'accessory',
      ]);
      // Tees (k = 1): 5 days, 3 owned: pack 3, 2 short.
      expect(packingRow(html, tee)).toContain('data-pack="3"');
      expect(packingRow(html, tee)).toContain('You own 3, the trip needs 5');
      expect(packingRow(html, tee)).toContain('In 7 outfits');
      // Jeans (k = 3): 5 days, 2 copies needed, 1 owned.
      expect(packingRow(html, jeans)).toContain('You own 1, the trip needs 2');
      // Socks (k = 1), 6 owned: 5 to pack, nothing to say.
      expect(packingRow(html, socks)).toContain('data-pack="5"');
      expect(packingRow(html, socks)).not.toContain('data-warning');
      // Sneakers are never washed: one pair.
      expect(packingRow(html, sneakers)).not.toContain('data-pack="');
      // Pieces: 1 jacket, 3 tees, 1 pair of jeans, 1 of sneakers, 5 socks.
      expect(html).toMatch(/0 of 5 packed · 11 pieces/);
    });

    it('warns to wash a garment with too few clean copies, and one lent out', async () => {
      // A tee worn today: 2 of 3 clean, 3 to pack. Six socks worn once:
      // 5 clean, 5 to pack, nothing to say. The jacket lent.
      for (const id of [tee, socks]) {
        expect(
          (await post(`/wardrobe/${id}/wear`, { worn: '1' })).statusCode,
        ).toBe(303);
      }
      expect(
        (await post(`/wardrobe/${jacket}/away`, { away: 'lent', awayNote: '' }))
          .statusCode,
      ).toBe(303);
      const html = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(packingRow(html, tee)).toContain('Wash before you pack: 2 clean');
      expect(packingRow(html, socks)).not.toContain('data-warning');
      expect(packingRow(html, jacket)).toContain('Lent out');
      expect(html).toContain('need attention');
      // Unworn and back: the warnings go.
      for (const id of [tee, socks]) {
        expect(
          (await post(`/wardrobe/${id}/wear`, { worn: '0' })).statusCode,
        ).toBe(303);
      }
      expect(
        (await post(`/wardrobe/${jacket}/away`, { away: '', awayNote: '' }))
          .statusCode,
      ).toBe(303);
      const after = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(packingRow(after, tee)).not.toContain('data-warning="wash"');
      expect(packingRow(after, jacket)).not.toContain('data-warning');
    });

    it('saves packed marks on change, answering the status line and the summary', async () => {
      const res = await pack(
        id,
        [tee, jeans],
        [tee, jeans, sneakers],
        HX_FRAGMENT,
      );
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toContain('Saved');
      expect(res.body).toMatch(
        /id="trip-packed-summary"[^>]*hx-swap-oob="true"/,
      );
      expect(res.body).toContain('2 of 5 packed');
      expect(await packedOf(id)).toEqual([tee, jeans].sort((a, b) => a - b));
      // Unchecked among those shown leaves; what was not shown stays.
      await pack(id, [sneakers], [jeans, sneakers]);
      expect(await packedOf(id)).toEqual([tee, sneakers].sort((a, b) => a - b));
      // A garment of no outfit on the trip is never marked.
      await pack(id, [polo], [polo]);
      expect(await packedOf(id)).not.toContain(polo);
      // The page shows them checked.
      const html = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(packingRow(html, tee)).toMatch(
        /name="packed" value="\d+"[^>]*checked/,
      );
      expect(packingRow(html, jeans)).not.toMatch(/name="packed"[^>]*checked/);
      // The outbox adds its queued ticks to the server's number (#658):
      // the line carries it and the string to fill, and shows it untouched.
      expect(html).toMatch(
        /data-packed-served="2"\s+data-packed-count="\{packed\} of 5 packed/,
      );
    });

    it('keeps packed marks through edits that keep the garment on the list', async () => {
      await pack(id, [tee, jeans, jacket], [tee, jeans, jacket, sneakers]);
      const marked = await packedOf(id);
      // The trip renamed, an outfit added, the dinner outfit re-saved whole.
      expect(
        (
          await post(`/trips/${id}`, {
            name: 'Renamed',
            startsOn: days[0],
            endsOn: days[4],
          })
        ).statusCode,
      ).toBe(303);
      expect(
        (await addOutfit(id, poloOutfit, { day: days[2] })).statusCode,
      ).toBe(303);
      const saved = await post(`/outfits/${dinnerOutfit}`, {
        name: 'Dinner',
        category: ['outerwear', 'tops', 'bottoms', 'footwear'],
        garmentId: [jacket, tee, jeans, sneakers].map(String),
      });
      expect(saved.statusCode).toBe(302);
      expect(await packedOf(id)).toEqual(marked);
    });

    it('removes the marks of garments that leave the list, with them', async () => {
      await pack(id, [tee, jeans, jacket, polo], [tee, jeans, jacket, polo]);
      expect(await packedOf(id)).toContain(polo);
      // Taking the polo outfit off: the polo leaves; the jeans stay (others hold them).
      const [poloRow] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(
          and(eq(tripOutfit.tripId, id), eq(tripOutfit.outfitId, poloOutfit)),
        );
      const removed = await post(
        `/trips/${id}/outfits/${poloRow.id}/delete`,
        {},
      );
      expect(removed.statusCode).toBe(303);
      expect(await packedOf(id)).toEqual(
        [tee, jeans, jacket].sort((a, b) => a - b),
      );
      // The jacket edited out of the dinner outfit: its mark goes with it.
      const edited = await post(`/outfits/${dinnerOutfit}`, {
        name: 'Dinner',
        category: ['tops', 'bottoms', 'footwear'],
        garmentId: [tee, jeans, sneakers].map(String),
      });
      expect(edited.statusCode).toBe(302);
      expect(await packedOf(id)).toEqual([tee, jeans].sort((a, b) => a - b));
      // Put back: it comes back unpacked.
      await post(`/outfits/${dinnerOutfit}`, {
        name: 'Dinner',
        category: ['outerwear', 'tops', 'bottoms', 'footwear'],
        garmentId: [jacket, tee, jeans, sneakers].map(String),
      });
      expect(await packedOf(id)).not.toContain(jacket);
    });

    it('removes the marks of an outfit’s garments when the outfit is deleted', async () => {
      const lonely = await outfitOf('Polo only', [['tops', polo]]);
      expect((await addOutfit(id, lonely)).statusCode).toBe(303);
      await pack(id, [polo], [polo]);
      expect(await packedOf(id)).toContain(polo);
      const deleted = await t.inject({
        method: 'DELETE',
        url: `/outfits/${lonely}`,
        headers: HX_FRAGMENT,
      });
      expect(deleted.statusCode).toBe(200);
      expect(await packedOf(id)).not.toContain(polo);
      expect(
        await t.db.$count(tripOutfit, eq(tripOutfit.outfitId, lonely)),
      ).toBe(0);
    });
  });

  describe('extras', () => {
    let first: number;
    let second: number;

    beforeAll(async () => {
      first = await newTrip({ name: 'First trip' });
      second = await newTrip({ name: 'Second trip' });
    });

    const labels = async (tripId: number) =>
      (
        await t.db
          .select({ label: tripItem.label, packed: tripItem.packed })
          .from(tripItem)
          .where(eq(tripItem.tripId, tripId))
          .orderBy(tripItem.id)
      ).map((row) => `${row.label}${row.packed ? ' ✓' : ''}`);

    it('adds extras once whatever their case, packs them on change and removes them', async () => {
      for (const label of [
        'Phone charger',
        'Toiletries',
        ' phone CHARGER ',
        'Passport',
      ]) {
        const res = await post(`/trips/${first}/items`, { label });
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe(`/trips/${first}#extras`);
      }
      expect(await labels(first)).toEqual([
        'Phone charger',
        'Toiletries',
        'Passport',
      ]);
      const items = await t.db
        .select({ id: tripItem.id, label: tripItem.label })
        .from(tripItem)
        .where(eq(tripItem.tripId, first))
        .orderBy(tripItem.id);
      const res = await post(
        `/trips/${first}/items/packed`,
        {
          packed: [String(items[0].id)],
          shown: items.map((i) => String(i.id)),
        },
        HX_FRAGMENT,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('1 of 3 packed');
      expect(unescapeHtml(res.body)).toMatch(
        /data-packed-served="1"\s+data-packed-count="\{packed\} of 3 packed"/,
      );
      expect(await labels(first)).toEqual([
        'Phone charger ✓',
        'Toiletries',
        'Passport',
      ]);
      const removed = await post(
        `/trips/${first}/items/${items[2].id}/delete`,
        {},
      );
      expect(removed.statusCode).toBe(303);
      expect(await labels(first)).toEqual(['Phone charger ✓', 'Toiletries']);
    });

    it('copies extras from a previous trip, unpacked and once', async () => {
      await post(`/trips/${second}/items`, { label: 'Toiletries' });
      const page = unescapeHtml((await get(`/trips/${second}`)).body);
      expect(page).toContain(
        `<option value="${first}">From First trip (2)</option>`,
      );
      const copied = await post(`/trips/${second}/items/copy`, {
        from: String(first),
      });
      expect(copied.statusCode).toBe(303);
      expect(copied.headers.location).toBe(`/trips/${second}?copied=1#extras`);
      expect(await labels(second)).toEqual(['Toiletries', 'Phone charger']);
      await post(`/trips/${second}/items/copy`, { from: String(first) });
      expect(await labels(second)).toEqual(['Toiletries', 'Phone charger']);
      // Not from itself, nor from someone else's trip.
      expect(
        (await post(`/trips/${second}/items/copy`, { from: String(second) }))
          .statusCode,
      ).toBe(404);
    });
  });

  describe('ideas for a trip (the gallery with for=trip:ID)', () => {
    let id: number;
    let day: string;

    beforeAll(async () => {
      id = await newTrip({ name: 'Ideas trip' });
      day = addDays(t.today(), 4);
    });

    it('opens the gallery for the trip’s day, with the trip’s pick', async () => {
      const res = await get(
        `/outfits/ideas?for=trip:${id}:${day}&occasion=evening`,
      );
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(html).toContain(`data-ideas-trip="${id}"`);
      expect(html).toContain('For Ideas trip');
      expect(html).toContain('Add to the trip');
      expect(html).toContain(`name="for" value="trip:${id}:${day}"`);
      expect(html).toContain('name="occasion" value="evening"');
      // Shuffle keeps the destination.
      expect(html).toMatch(
        new RegExp(
          `/outfits/ideas\\?for=trip:${id}:${day}&occasion=evening&seed=\\d+`,
        ),
      );
    });

    it('adds a picked idea to the trip, once, and 404s someone else’s trip', async () => {
      const garments = [tee, jeans, sneakers];
      const pick = () =>
        post('/outfits/ideas/pick', {
          garmentId: garments.map(String),
          for: `trip:${id}:${day}`,
          occasion: 'evening',
          seed: '1',
        });
      const res = await pick();
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/trips/${id}?picked=1`);
      await pick();
      const rows = await t.db
        .select({ day: tripOutfit.day, occasion: tripOutfit.occasion })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      expect(rows).toEqual([{ day, occasion: 'evening' }]);
      // No calendar entry: a trip is a list, not the calendar.
      const [outfitRow] = await t.db
        .select({ outfitId: tripOutfit.outfitId })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      expect(
        await t.db.$count(
          outfitCalendar,
          eq(outfitCalendar.outfitId, outfitRow.outfitId),
        ),
      ).toBe(0);
      // A day outside it, or a malformed one, is refused.
      const outside = await post('/outfits/ideas/pick', {
        garmentId: garments.map(String),
        for: `trip:${id}:${addDays(day, 30)}`,
      });
      expect(outside.statusCode).toBe(400);
      const malformed = await post('/outfits/ideas/pick', {
        garmentId: garments.map(String),
        for: `trip:${id}:2026-02-30`,
      });
      expect(malformed.statusCode).toBe(400);
      const stranger = await t.register('trip-stranger@example.com');
      const theirs = await t.inject({
        method: 'GET',
        url: `/outfits/ideas?for=trip:${id}`,
        headers: { cookie: stranger },
      });
      expect(theirs.statusCode).toBe(404);
    });
  });

  describe('"Wore it" on a trip outfit', () => {
    it("marks only today's copy of an outfit on two days worn", async () => {
      const today = t.today();
      // An outfit of its own: other specs wear the polo outfit today.
      const twice = await outfitOf('Twice on the trip', [['tops', polo]]);
      const id = await newTrip({
        name: 'Twice',
        startsOn: today,
        endsOn: addDays(today, 2),
      });
      await addOutfit(id, twice, { day: today, occasion: 'work' });
      await addOutfit(id, twice, { day: addDays(today, 1) });
      const rows = await t.db
        .select({ id: tripOutfit.id, day: tripOutfit.day })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      const todays = rows.find((r) => r.day === today)!;
      expect(
        (await post(`/trips/${id}/outfits/${todays.id}/wear`, {})).statusCode,
      ).toBe(303);
      const page = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(page.match(/✓ Worn/g)).toHaveLength(1);
      // Today is a day of the trip: the home screen says Away, linking to it (#684).
      expect(unescapeHtml((await get('/')).body)).toMatch(
        new RegExp(
          `href="/trips/${id}"[^>]*data-away="${id}"[^>]*>\\s*Away: Twice\\s*<`,
        ),
      );
    });

    it('plans the trip outfit today and marks it worn through the calendar, once', async () => {
      const today = t.today();
      const id = await newTrip({
        name: 'On now',
        startsOn: today,
        endsOn: addDays(today, 2),
      });
      expect(
        (await addOutfit(id, poloOutfit, { day: today, occasion: 'work' }))
          .statusCode,
      ).toBe(303);
      const page = unescapeHtml((await get(`/trips/${id}`)).body);
      const [row] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      expect(page).toContain(`/trips/${id}/outfits/${row.id}/wear`);
      const wearsBefore = await t.db.$count(garmentWear);
      for (let tap = 0; tap < 2; tap += 1) {
        const res = await post(`/trips/${id}/outfits/${row.id}/wear`, {});
        expect(res.statusCode).toBe(303);
      }
      const entries = await t.db
        .select({ occasion: outfitCalendar.occasion })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.outfitId, poloOutfit),
            eq(outfitCalendar.day, today),
            isNotNull(outfitCalendar.wornAt),
          ),
        );
      expect(entries).toEqual([{ occasion: 'work' }]);
      expect(await t.db.$count(garmentWear)).toBe(wearsBefore + 2);
      expect(t.logs.ops('trip.outfit.worn').at(-1)).toMatchObject({
        tripId: id,
        changed: false,
      });
      const after = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(after).toContain('✓ Worn');
      expect(after).not.toContain(`/trips/${id}/outfits/${row.id}/wear`);
    });

    it('undoes the wear through the calendar, back to the trip, and offers "Wore it" again', async () => {
      const today = t.today();
      // An outfit of its own: an earlier spec wore the polo outfit today.
      const worn = await outfitOf('Undo socks and jacket', [
        ['outerwear', jacket],
        ['accessories', socks],
      ]);
      const id = await newTrip({ name: 'Undo on the road', startsOn: today });
      await addOutfit(id, worn, { day: today, occasion: 'work' });
      const [row] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      const wear = `/trips/${id}/outfits/${row.id}/wear`;
      const before = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(before).toMatch(
        new RegExp(`action="${wear}"[^>]*data-needs-network[\\s\\S]*?Wore it`),
      );
      expect((await post(wear, {})).statusCode).toBe(303);
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(
          and(eq(outfitCalendar.outfitId, worn), eq(outfitCalendar.day, today)),
        );
      const wornPage = unescapeHtml((await get(`/trips/${id}`)).body);
      const undoAt = wornPage.indexOf(`action="/calendar/${entry.id}/worn"`);
      expect(undoAt).toBeGreaterThan(-1);
      const undoForm = wornPage.slice(
        undoAt,
        wornPage.indexOf('</form>', undoAt),
      );
      // Queued offline, not disabled (#178).
      expect(undoForm).toContain('data-offline-queue="entry"');
      expect(undoForm).toContain('✓ Worn');
      expect(undoForm).toContain('name="worn" value="0"');
      expect(undoForm).toContain(`name="returnTo" value="/trips/${id}"`);
      expect(undoForm).toContain('Undo');

      const undo = await post(`/calendar/${entry.id}/worn`, {
        worn: '0',
        returnTo: `/trips/${id}`,
      });
      expect(undo.statusCode).toBe(303);
      expect(undo.headers.location).toBe(`/trips/${id}`);
      const [after] = await t.db
        .select({ wornAt: outfitCalendar.wornAt })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.id, entry.id));
      expect(after.wornAt).toBeNull();
      const page = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(page).not.toContain('✓ Worn');
      expect(page).toContain(wear);
    });

    it('marks the entry already planned today worn, keeping its occasion and taking it over from the week planner', async () => {
      const today = t.today();
      const layers = await outfitOf('Evening layers', [
        ['outerwear', jacket],
        ['footwear', sneakers],
      ]);
      await asFixture(t.db, (tx) =>
        tx.insert(outfitCalendar).values({
          ownerId: t.owner.id,
          outfitId: layers,
          day: today,
          occasion: 'evening',
          plannedBy: 'auto',
        }),
      );
      const id = await newTrip({ name: 'Planned already', startsOn: today });
      await addOutfit(id, layers, { day: today, occasion: 'work' });
      const [row] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      const res = await post(`/trips/${id}/outfits/${row.id}/wear`, {});
      expect(res.statusCode).toBe(303);
      const entries = await t.db
        .select({
          occasion: outfitCalendar.occasion,
          plannedBy: outfitCalendar.plannedBy,
          wornAt: outfitCalendar.wornAt,
        })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.outfitId, layers),
            eq(outfitCalendar.day, today),
          ),
        );
      expect(entries).toEqual([
        { occasion: 'evening', plannedBy: 'user', wornAt: expect.any(Date) },
      ]);
      expect(t.logs.ops('trip.outfit.worn').at(-1)).toMatchObject({
        outfitId: layers,
        entryPlanned: false,
        changed: true,
        wears: 2,
      });
    });

    it('is refused (409) for an outfit of another day of the trip, as a page left open past midnight posts it', async () => {
      const today = t.today();
      const yesterday = addDays(today, -1);
      const id = await newTrip({
        name: 'Over midnight',
        startsOn: yesterday,
        endsOn: addDays(today, 1),
      });
      expect(
        (await addOutfit(id, dinnerOutfit, { day: yesterday })).statusCode,
      ).toBe(303);
      const [row] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      const entriesBefore = await t.db.$count(outfitCalendar);
      const wearsBefore = await t.db.$count(garmentWear);
      const res = await post(`/trips/${id}/outfits/${row.id}/wear`, {});
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain('This outfit is for another day of the trip');
      expect(await t.db.$count(outfitCalendar)).toBe(entriesBefore);
      expect(await t.db.$count(garmentWear)).toBe(wearsBefore);
      // The page never offered it.
      expect(unescapeHtml((await get(`/trips/${id}`)).body)).not.toContain(
        `/outfits/${row.id}/wear"`,
      );
    });

    it('is refused (409) while the trip is not on', async () => {
      const id = await newTrip();
      expect((await addOutfit(id, poloOutfit)).statusCode).toBe(303);
      const [row] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      const res = await post(`/trips/${id}/outfits/${row.id}/wear`, {});
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml((await get(`/trips/${id}`)).body)).not.toContain(
        '/wear"',
      );
    });
  });

  describe('the destination’s forecast', () => {
    it('creates a trip at the place its form picked: the forecast on first view; a failed search still creates it unlocated (#684)', async () => {
      const form = unescapeHtml((await get('/trips/new')).body);
      expect(form).toContain('hx-get="/trips/new/places"');
      const fragment = (url: string) =>
        t.inject({ method: 'GET', url, headers: HX_FRAGMENT });
      t.logs.clear();
      const search = await fragment('/trips/new/places?destination=austin');
      expectFragment(search);
      // Each place is picked by a GET into the form, never a nested form.
      expect(search.body).not.toContain('<form');
      const pick = /hx-get="(\/trips\/new\/place\?[^"]+)"/.exec(
        unescapeHtml(search.body),
      )![1];
      const picked = await fragment(pick);
      expectFragment(picked);
      const field = (name: string) =>
        new RegExp(`name="${name}" value="([^"]*)"`).exec(
          unescapeHtml(picked.body),
        )![1];
      // The name is read-only beside the coordinates and zone it names.
      expect(picked.body).toMatch(
        /readonly[^>]*name="destination"|name="destination"[^>]*readonly/,
      );
      const label = field('destination');
      expect(label).toBe('Austin, Texas, United States');
      expect(field('timeZone')).toBe('America/Chicago');
      // Neither the search's place nor the pick's is logged.
      expect(JSON.stringify(t.logs.records)).not.toMatch(/austin|30\.27/i);

      const id = await newTrip({
        destination: label,
        latitude: field('latitude'),
        longitude: field('longitude'),
        timeZone: field('timeZone'),
      });
      const [row] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(row).toMatchObject({
        destination: label,
        latitude: 30.27,
        longitude: -97.74,
        timeZone: 'America/Chicago',
      });
      // Located, and never where: the place is the person's.
      const created = t.logs.ops('trip.created').at(-1);
      expect(created).toMatchObject({ tripId: id, located: true });
      expect(JSON.stringify(created)).not.toContain(label);
      const page = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(page).toMatch(/<button type="submit"[^>]*>\s*Change\s*</);
      const weather = await get(`/trips/${id}/weather`);
      expectFragment(weather);
      expect(weather.body).toContain('data-trip-weather="forecast"');
      expect(weather.body.match(/data-weather-day="/g)).toHaveLength(5);

      // Change puts the text back, editable, without searching again.
      const hits = stub.hits.length;
      const change = /hx-get="(\/trips\/new\/destination\?[^"]+)"/.exec(
        unescapeHtml(picked.body),
      )![1];
      const text = unescapeHtml((await fragment(change)).body);
      expect(text).toContain(`value="${label}"`);
      expect(text).not.toContain('readonly');
      expect(text).not.toContain('name="latitude"');
      expect(stub.hits.length).toBe(hits);

      // A failed search says so in the picker; saving still creates the trip, unlocated.
      stub.fail(true);
      try {
        const failed = await fragment('/trips/new/places?destination=austin');
        expect(failed.statusCode).toBe(200);
        expect(failed.body).toContain('The search did not work just now.');
      } finally {
        stub.fail(false);
      }
      const unlocated = await newTrip({ destination: 'Austin' });
      const [plain] = await t.db
        .select()
        .from(trip)
        .where(eq(trip.id, unlocated));
      expect(plain).toMatchObject({ destination: 'Austin', latitude: null });
      // Too short to search is no places, never a 400 htmx would not show.
      const searches = stub.hits.length;
      const short = await fragment('/trips/new/places?destination=a');
      expect(short.statusCode).toBe(200);
      expect(short.body).toContain('No place by that name.');
      expect(stub.hits.length).toBe(searches);
      // A place without its coordinates, or without a name, is refused whole.
      const partials: Fields[] = [
        { destination: label, latitude: '30.27' },
        { destination: ' ', latitude: '30.27', longitude: '-97.74' },
      ];
      for (const partial of partials) {
        const refused = await post('/trips', {
          name: 'Half a place',
          startsOn: addDays(t.today(), 3),
          endsOn: addDays(t.today(), 4),
          ...partial,
        });
        expect(refused.statusCode, JSON.stringify(partial)).toBe(400);
      }
    });

    it('finds the destination through the weather’s search and shows its days within the forecast', async () => {
      const id = await newTrip({ destination: 'Austin' });
      const before = await get(`/trips/${id}/weather`);
      expectFragment(before);
      expect(before.body).toContain('data-trip-weather="no-location"');
      const search = await t.inject({
        method: 'GET',
        url: `/trips/${id}/places?q=austin`,
        headers: HX_FRAGMENT,
      });
      expect(search.statusCode).toBe(200);
      expect(unescapeHtml(search.body)).toContain(
        'Austin, Texas, United States',
      );
      // The pick posts the answer's zone beside its coordinates (#678).
      expect(search.body).toContain('name="timeZone" value="America/Chicago"');
      // The request log names the route, never the typed city.
      expect(JSON.stringify(t.logs.records)).not.toContain('q=austin');
      const set = await post(`/trips/${id}/destination`, {
        name: 'Austin, Texas, United States',
        latitude: '30.26715',
        longitude: '-97.74306',
        timeZone: 'America/Chicago',
      });
      expect(set.statusCode).toBe(303);
      const [row] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(row).toMatchObject({
        latitude: 30.27,
        longitude: -97.74,
        timeZone: 'America/Chicago',
      });
      const res = await get(`/trips/${id}/weather`);
      expectFragment(res);
      const html = unescapeHtml(res.body);
      const shown = [...html.matchAll(/data-weather-day="([\d-]+)"/g)].map(
        (m) => m[1],
      );
      expect(shown).toEqual([3, 4, 5, 6, 7].map((n) => addDays(t.today(), n)));
      expect(html).toContain(`/outfits/ideas?for=trip:${id}:${shown[0]}`);
      // Asked in the destination's zone, never the household's.
      expect(
        stub.hits.some(
          (hit) =>
            hit.includes('latitude=30.27&longitude=-97.74') &&
            hit.includes('timezone=America%2FChicago'),
        ),
      ).toBe(true);
      // An empty zone field (a result that named none) is the household's zone (#807).
      const noZone = await post(`/trips/${id}/destination`, {
        name: 'Austin, Texas, United States',
        latitude: '30.26715',
        longitude: '-97.74306',
        timeZone: '',
      });
      expect(noZone.statusCode).toBe(303);
      const [unzoned] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(unzoned.timeZone).toBeNull();
      // A new destination name clears the location it no longer describes.
      await post(`/trips/${id}`, {
        name: 'Austin conference',
        destination: 'Dallas',
        startsOn: shown[0],
        endsOn: shown[4],
      });
      const [renamed] = await t.db.select().from(trip).where(eq(trip.id, id));
      // The zone goes with the place it described.
      expect(renamed).toMatchObject({
        destination: 'Dallas',
        latitude: null,
        longitude: null,
        timeZone: null,
      });
      // Someone else's trip is not found, weather routes included.
      const cookie = await t.register('trip-weather-stranger@example.com');
      for (const request of [
        { method: 'GET' as const, url: `/trips/${id}/weather` },
        { method: 'GET' as const, url: `/trips/${id}/places?q=austin` },
        {
          method: 'POST' as const,
          url: `/trips/${id}/destination`,
          ...form({ name: 'Austin', latitude: '30.27', longitude: '-97.74' }),
        },
      ]) {
        const res = await t.inject({
          ...request,
          headers: { ...('headers' in request ? request.headers : {}), cookie },
        });
        expect(res.statusCode, request.url).toBe(404);
      }
      const [kept] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(kept.latitude).toBeNull();
    });

    it('says from when the forecast of days past 16 days arrives, with their typical weather meanwhile and no forecast fetched', async () => {
      const today = t.today();
      const id = await newTrip({
        startsOn: addDays(today, 30),
        endsOn: addDays(today, 32),
      });
      await post(`/trips/${id}/destination`, {
        name: 'Austin, Texas, United States',
        latitude: '30.27',
        longitude: '-97.74',
      });
      const forecasts = () =>
        stub.hits.filter((hit) => hit.startsWith('/v1/forecast?')).length;
      const before = forecasts();
      const res = await get(`/trips/${id}/weather`);
      expect(res.body).toContain('data-forecast-from=""');
      expect(hasText(res.body, 'arrives on')).toBe(true);
      // The climate normals (climate-normals.spec.ts covers them).
      expect(res.body).toContain('data-trip-typical=""');
      expect(forecasts()).toBe(before);
    });

    it('limits how many destinations one account can locate a minute: each is a fetch and a cached row', async () => {
      const cookie = await t.register('trip-hopper@example.com');
      const today = t.today();
      const created = await post(
        '/trips',
        {
          name: 'Road trip',
          destination: '',
          startsOn: addDays(today, 3),
          endsOn: addDays(today, 5),
          notes: '',
        },
        { cookie },
      );
      const id = Number(
        /^\/trips\/(\d+)/.exec(String(created.headers.location))![1],
      );
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await post(
          `/trips/${id}/destination`,
          {
            name: `Stop ${i}`,
            latitude: String(30 + i / 10),
            longitude: '-97.74',
          },
          { cookie },
        );
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(303));
      expect(statuses[10]).toBe(429);
      expect(t.logs.messages('warn', 'Web')).toContainEqual(
        expect.stringMatching(
          /^Rate limit reached: POST \/trips\/\d+\/destination for user \d+$/,
        ),
      );
    });

    it('gives the gallery the destination’s forecast for a trip day', async () => {
      const today = t.today();
      const id = await newTrip({
        startsOn: addDays(today, 1),
        endsOn: addDays(today, 2),
      });
      const ideas = await get(
        `/outfits/ideas?for=trip:${id}:${addDays(today, 1)}`,
      );
      // Not located yet: no weather, rather than home's.
      expect(ideas.body).not.toContain('data-ideas-weather');
      await post(`/trips/${id}/destination`, {
        name: 'Austin, Texas, United States',
        latitude: '30.27',
        longitude: '-97.74',
      });
      const located = await get(
        `/outfits/ideas?for=trip:${id}:${addDays(today, 1)}`,
      );
      expect(located.body).toContain('data-ideas-weather');
    });

    describe('a cached forecast without the trip day (#678)', () => {
      // Across the date line the destination's forecast can start a day
      // after home's today; the gallery reads the destination's typical day.
      const tokyoTripDay = async () => {
        const today = t.today();
        const day = addDays(today, 1);
        const id = await newTrip({ startsOn: day, endsOn: addDays(today, 2) });
        const set = await post(`/trips/${id}/destination`, {
          name: 'Tokyo, Japan',
          latitude: '35.6895',
          longitude: '139.69171',
          timeZone: 'Asia/Tokyo',
        });
        expect(set.statusCode).toBe(303);
        expect((await get(`/trips/${id}/weather`)).statusCode).toBe(200);
        const [cached] = await t.db
          .select()
          .from(weatherForecast)
          .where(eq(weatherForecast.timeZone, 'Asia/Tokyo'));
        const ideas = () => get(`/outfits/ideas?for=trip:${id}:${day}`);
        return { day, cached, ideas };
      };
      const dropDay = (
        cached: typeof weatherForecast.$inferSelect,
        day: string,
      ) =>
        t.db
          .update(weatherForecast)
          .set({
            forecast: {
              ...cached.forecast!,
              days: cached.forecast!.days.filter((d) => d.day !== day),
            },
          })
          .where(eq(weatherForecast.timeZone, 'Asia/Tokyo'));

      it('reads the destination’s typical day, not no weather', async () => {
        const { day, cached, ideas } = await tokyoTripDay();
        await dropDay(cached, day);
        const res = await ideas();
        expect(res.body).toContain('data-ideas-weather="typical"');
      });

      it('reads it too when a stale forecast, kept while the provider is down, no longer covers the day', async () => {
        const { day, cached, ideas } = await tokyoTripDay();
        await dropDay(cached, day);
        await t.db
          .update(weatherForecast)
          .set({ fetchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
          .where(eq(weatherForecast.timeZone, 'Asia/Tokyo'));
        stub.fail(true);
        try {
          const res = await ideas();
          expect(res.body).toContain('data-ideas-weather="typical"');
        } finally {
          stub.fail(false);
        }
      });
    });
  });

  describe('MCP', () => {
    it('lists trips, reads one with its packing list, and plans outfits on it', async () => {
      const today = t.today();
      const id = await newTrip({
        name: 'MCP trip',
        startsOn: addDays(today, 3),
        endsOn: addDays(today, 4),
      });
      const listed = await tool<{ trips: { id: number; phase: string }[] }>(
        t,
        token,
        'list_trips',
      );
      expect(listed.trips.find((row) => row.id === id)).toMatchObject({
        phase: 'upcoming',
      });
      const added = await tool(t, token, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
        date: addDays(today, 3),
        occasion: 'work',
      });
      expect(added).toMatchObject({ added: true, outfitCreated: false });
      const again = await tool(t, token, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
        date: addDays(today, 3),
      });
      expect(again).toMatchObject({ added: false });
      const picked = await tool(t, token, 'plan_trip_outfit', {
        tripId: id,
        garmentIds: [polo, sneakers],
        date: addDays(today, 4),
      });
      expect(picked).toMatchObject({ added: true, outfitCreated: true });
      const refused = await callTool(t, token, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
        date: addDays(today, 9),
      });
      expect(refused.isError).toBe(true);
      expect(refused.value.error).toMatch(/day of the trip/);
      const both = await callTool(t, token, 'plan_trip_outfit', { tripId: id });
      expect(both.value.error).toBe('Give either outfitId or garmentIds');
      const read = await tool<{
        days: { outfits: { outfitId: number; occasion: string | null }[] }[];
        packing: {
          groups: {
            role: string;
            garments: {
              id: number;
              copiesNeeded: number;
              pack: number;
              warnings: { kind: string }[];
            }[];
          }[];
        };
        weather?: unknown;
      }>(t, token, 'get_trip', { tripId: id });
      expect(read.days[0].outfits).toEqual([
        expect.objectContaining({ outfitId: dayOutfit, occasion: 'work' }),
      ]);
      const bottoms = read.packing.groups.find((g) => g.role === 'bottom')!;
      // Jeans on both days: 2 wears, one copy (k = 3).
      expect(bottoms.garments).toEqual([
        expect.objectContaining({ id: jeans, copiesNeeded: 1, pack: 1 }),
      ]);
      expect(read.weather).toEqual({ status: 'no-location' });
      const stranger = await t.register('mcp-trip-stranger@example.com');
      const theirToken = await createAccessToken(t, { cookie: stranger });
      const hidden = await callTool(t, theirToken, 'get_trip', { tripId: id });
      expect(hidden.value.error).toBe('Trip not found');
      const theirAdd = await callTool(t, theirToken, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
      });
      expect(theirAdd.value.error).toBe('Trip not found');
    });
  });

  // #166: production reaches Postgres at about 114 ms a statement (#156),
  // so each route's count is held here. The session is one; a read is one
  // more (selectScalars); a trip write is one statement under the trip's
  // lock (lockedTripCte) where its outcome allows, else begin, the lock,
  // the writes, commit.
  describe('statements per request', () => {
    const htmx = { ...HX_FRAGMENT };
    let id: number;
    let itemId: number;

    const count = async (request: () => Promise<{ statusCode: number }>) => {
      let status = 0;
      const record = await recordQueries(async () => {
        status = (await request()).statusCode;
      });
      return { status, statements: record.statements, sql: record.sql };
    };

    beforeAll(async () => {
      const today = t.today();
      id = await newTrip({
        name: 'Counted',
        destination: 'Austin',
        startsOn: today,
        endsOn: addDays(today, 3),
      });
      await addOutfit(id, dayOutfit, { day: today, occasion: 'daytime' });
      await addOutfit(id, dinnerOutfit, { day: addDays(today, 1) });
      await post(`/trips/${id}/items`, { label: 'Charger' });
      [{ id: itemId }] = await t.db
        .select({ id: tripItem.id })
        .from(tripItem)
        .where(eq(tripItem.tripId, id));
      // Located without the rate-limited route, which specs above spend.
      await asFixture(t.db, (tx) =>
        tx
          .update(trip)
          .set({ latitude: 30.27, longitude: -97.74 })
          .where(eq(trip.id, id)),
      );
    });

    it('reads each page in one statement after the session', async () => {
      for (const url of [
        '/trips',
        `/trips/${id}`,
        `/trips/${id}/edit`,
        `/trips/${id}/outfits/new?day=${t.today()}`,
      ]) {
        const read = await count(() => get(url));
        expect(read, url).toMatchObject({ status: 200, statements: 2 });
      }
      expect(await count(() => get('/trips/new'))).toMatchObject({
        status: 200,
        statements: 1,
      });
      // The trip page's one statement holds every part of it.
      const page = await count(() => get(`/trips/${id}`));
      const [read] = page.sql.filter((text) => text.includes('json_agg'));
      for (const table of [
        'trip',
        'trip_outfit',
        'outfit_slot',
        'garment_wear',
        'trip_garment_packed',
        'trip_item',
        'outfit_calendar',
      ]) {
        expect(read).toContain(`"${table}"`);
      }
    });

    it('reads a located trip’s forecast in one statement after the trip', async () => {
      // The first read fetches and saves the place's forecast and normals.
      expect((await get(`/trips/${id}/weather`)).statusCode).toBe(200);
      await t.weather?.settled();
      const read = await count(() =>
        t.inject({ method: 'GET', url: `/trips/${id}/weather`, headers: htmx }),
      );
      expect(read).toMatchObject({ status: 200, statements: 3 });
      // The person's offset and unit, never where they are.
      const all = read.sql.join('\n');
      expect(all).toContain('"temperature_offset"');
      expect(all).not.toContain('"home_latitude"');
      expect(all).not.toContain('"here_latitude"');
    });

    it('writes the packing list and the extras in one statement each, a saved outfit in a transaction', async () => {
      const shown = [tee, jeans].map(String);
      const writes: [
        url: string,
        fields: Fields,
        headers: object,
        statements: number,
      ][] = [
        [`/trips/${id}/packed`, { packed: [String(tee)], shown }, {}, 2],
        // The autosave's answer: the write, then the summary's one read.
        [`/trips/${id}/packed`, { packed: shown, shown }, htmx, 3],
        [`/trips/${id}/items`, { label: 'Adapter' }, {}, 2],
        [
          `/trips/${id}/items/packed`,
          { packed: [String(itemId)], shown: [String(itemId)] },
          {},
          2,
        ],
        // Its summary comes from the write itself.
        [`/trips/${id}/items/packed`, { shown: [String(itemId)] }, htmx, 2],
        // A saved outfit: begin, the trip and outfit locked, the insert
        // judged after the lock (#335: complete, as an edit left it), commit.
        [`/trips/${id}/outfits`, { outfitId: String(poloOutfit) }, {}, 5],
      ];
      for (const [url, fields, headers, statements] of writes) {
        const write = await count(() => post(url, fields, headers));
        expect(write, `${url} ${JSON.stringify(fields)}`).toMatchObject({
          statements,
        });
        expect(write.status).toBeLessThan(400);
      }
      const other = await newTrip({ name: 'Copy target' });
      expect(
        await count(() =>
          post(`/trips/${other}/items/copy`, { from: String(id) }),
        ),
      ).toMatchObject({ status: 303, statements: 2 });
      expect(await t.db.$count(tripItem, eq(tripItem.tripId, other))).toBe(2);
    });

    it('edits a trip in a transaction of two statements, and takes an outfit off in two', async () => {
      const [row] = await t.db.select().from(trip).where(eq(trip.id, id));
      const edit = await count(() =>
        post(`/trips/${id}`, {
          name: 'Counted again',
          destination: row.destination ?? '',
          startsOn: row.startsOn,
          endsOn: row.endsOn,
          notes: '',
        }),
      );
      // The session, begin, the lock, the writes, commit.
      expect(edit).toMatchObject({ status: 303, statements: 5 });
      // A refused form asks whose trip it is only then.
      const refused = await count(() =>
        post(`/trips/${id}`, {
          name: '',
          destination: '',
          startsOn: row.startsOn,
          endsOn: row.endsOn,
          notes: '',
        }),
      );
      expect(refused).toMatchObject({ status: 400, statements: 2 });
      const [polo] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(
          and(eq(tripOutfit.tripId, id), eq(tripOutfit.outfitId, poloOutfit)),
        );
      const removed = await count(() =>
        post(`/trips/${id}/outfits/${polo.id}/delete`, {}),
      );
      expect(removed).toMatchObject({ status: 303, statements: 5 });
    });

    it('wears a trip outfit today in seven statements, and a second tap in six', async () => {
      const [day] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(
          and(eq(tripOutfit.tripId, id), eq(tripOutfit.outfitId, dayOutfit)),
        );
      const url = `/trips/${id}/outfits/${day.id}/wear`;
      // The session, the trip outfit, begin, the owner lock, the entry
      // planned and locked, its mark and wears, commit.
      expect(await count(() => post(url, {}))).toMatchObject({
        status: 303,
        statements: 7,
      });
      // Worn already: nothing to mark.
      expect(await count(() => post(url, {}))).toMatchObject({
        status: 303,
        statements: 6,
      });
    });
  });

  it('deletes a trip with its rows, keeping its outfits', async () => {
    const id = await newTrip({ name: 'Doomed' });
    await addOutfit(id, dayOutfit);
    await post(`/trips/${id}/items`, { label: 'Hat' });
    await pack(id, [tee], [tee]);
    const res = await t.inject({
      method: 'DELETE',
      url: `/trips/${id}`,
      headers: HX_FRAGMENT,
    });
    expect(res.statusCode).toBe(200);
    expect(hxLocationPath(res)).toBe('/trips');
    for (const table of [tripOutfit, tripItem, tripGarmentPacked] as const) {
      expect(
        (
          await t.db
            .select({ n: count() })
            .from(table)
            .where(eq(table.tripId, id))
        )[0].n,
      ).toBe(0);
    }
    expect(await t.db.$count(trip, eq(trip.id, id))).toBe(0);
    expect((await get(`/outfits/${dayOutfit}`)).statusCode).toBe(200);
  });
});
