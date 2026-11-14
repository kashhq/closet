import { and, eq, sql } from 'drizzle-orm';
import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, instantAt, type IsoDate } from '../../src/calendar-date';
import {
  garment,
  garmentWear,
  outfitCalendar,
  tripGarmentPacked,
  tripItem,
} from '../../src/db/schema';
import {
  QUEUEABLE_ROUTES,
  queueableKindOf,
  queuedTarget,
} from '../../src/offline-writes';
import { PAGE_ACCOUNT_HEADER } from '../../src/web/page-cache';
import { setWoreToday, wearsSinceWashSql } from '../../src/web/wears/queries';
import { createGarment } from './garments';
import { interleave } from './interleave';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';

/**
 * The server half of offline queued writes (#178a,
 * docs/plans/2026-11-12-offline-queued-writes.md section 4): the five
 * queueable routes take a replay (`X-Closet-Queued: <account>`,
 * `Idempotency-Key`), answer it 204 `changed | unchanged`, apply it twice
 * as once, date a wear or wash by the tap's day within the window, never
 * move a wash back, refuse another account's replay and keep a gone
 * target's 404. A tap without the header is the routes' own specs'
 * (wears, calendar, trips), unchanged.
 *
 * And the page half's markup (#178b, src/web/outbox.tsx): what the outbox
 * reads to queue a tap, show its other state and its "Waiting to sync",
 * and which account it saves for. Its behavior in a browser is
 * test/offline-writes.spec.ts.
 */

type Fields = Record<string, string | readonly string[]>;
const KEY = '1a2b3c4d-0000-4000-8000-000000000001';

describe('queued writes', () => {
  let t: TestApp;
  const registered: RouteOptions[] = [];
  let shirt: number;
  let jeans: number;

  const post = (url: string, fields: Fields, headers: object = {}) => {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of [value].flat()) body.append(name, item);
    }
    return t.inject({
      method: 'POST',
      url,
      payload: body.toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
    });
  };
  /** A replay as the outbox sends it: a fetch naming the account and key. */
  const replay = (url: string, fields: Fields, account = t.owner.id) =>
    post(url, fields, {
      'x-closet-queued': String(account),
      'idempotency-key': KEY,
      'sec-fetch-mode': 'cors',
    });
  const outcome = (res: { statusCode: number; headers: object }) => [
    res.statusCode,
    (res.headers as Record<string, unknown>)['x-closet-outcome'],
  ];
  const daysAgo = (days: number): IsoDate => addDays(t.today(), -days);

  const wearDays = async (garmentId: number) =>
    (
      await t.db
        .select({ day: garmentWear.day })
        .from(garmentWear)
        .where(eq(garmentWear.garmentId, garmentId))
    )
      .map((row) => row.day)
      .sort();
  const lastWashed = async (garmentId: number) =>
    (
      await t.db
        .select({ day: garment.lastWashedOn })
        .from(garment)
        .where(eq(garment.id, garmentId))
    )[0]?.day;

  const newOutfit = async (garmentIds: number[]) => {
    const res = await post('/outfits', {
      name: 'Queued look',
      category: garmentIds.map(() => 'tops'),
      garmentId: garmentIds.map(String),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)/.exec(String(res.headers.location))![1]);
  };
  const newEntry = async (outfitId: number, day: IsoDate) => {
    expect(
      (await post('/calendar', { outfitId: String(outfitId), date: day }))
        .statusCode,
    ).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
      );
    return entry.id;
  };
  const newTrip = async (outfitId: number) => {
    const res = await post('/trips', {
      name: 'Queued trip',
      destination: '',
      startsOn: t.today(),
      endsOn: addDays(t.today(), 2),
      notes: '',
    });
    expect(res.statusCode).toBe(303);
    const id = Number(/^\/trips\/(\d+)/.exec(String(res.headers.location))![1]);
    expect(
      (
        await post(`/trips/${id}/outfits`, {
          outfitId: String(outfitId),
          day: '',
          occasion: '',
        })
      ).statusCode,
    ).toBe(303);
    return id;
  };
  const packedOf = async (tripId: number) =>
    (
      await t.db
        .select({ id: tripGarmentPacked.garmentId })
        .from(tripGarmentPacked)
        .where(eq(tripGarmentPacked.tripId, tripId))
    )
      .map((row) => row.id)
      .sort((a, b) => a - b);

  beforeAll(async () => {
    t = await createTestApp({}, { onRoute: (route) => registered.push(route) });
    shirt = await createGarment(t, { name: 'Queued shirt' });
    jeans = await createGarment(t, {
      name: 'Queued jeans',
      category: 'bottoms',
    });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it('marks exactly the listed routes queueable', () => {
    const marked = Object.fromEntries(
      registered
        .filter((route) => route.config?.queueable !== undefined)
        .map((route) => [
          route.config!.queueable,
          `${String(route.method)} ${route.url}`,
        ]),
    );
    expect(marked).toEqual(
      Object.fromEntries(
        Object.entries(QUEUEABLE_ROUTES).map(([kind, url]) => [
          kind,
          `POST ${url}`,
        ]),
      ),
    );
  });

  it('applies a replayed Wore today on the tap’s day, twice as once, and its undo', async () => {
    const url = `/wardrobe/${shirt}/wear`;
    const day = daysAgo(3);
    const wear = { worn: '1', day, clientId: KEY };
    expect(outcome(await replay(url, wear))).toEqual([204, 'changed']);
    expect(outcome(await replay(url, wear))).toEqual([204, 'unchanged']);
    expect(await wearDays(shirt)).toEqual([day]);
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${shirt} worn on ${day} by user ${t.owner.id} (replayed, key 1a2b3c4d)`,
    );
    // Last write wins: the undo queued after it unwears that day.
    expect(outcome(await replay(url, { worn: '0', day }))).toEqual([
      204,
      'changed',
    ]);
    expect(await wearDays(shirt)).toEqual([]);
    // The wear came and went: a late retry of it brings nothing back
    // (its tombstone, #196a), and the outbox takes the 410 for saved.
    expect((await replay(url, wear)).statusCode).toBe(410);
    expect(await wearDays(shirt)).toEqual([]);
  });

  describe('a queued wear’s client id (#196a)', () => {
    const clientIdsOf = async (garmentId: number) =>
      (
        await t.db
          .select({ clientId: garmentWear.clientId })
          .from(garmentWear)
          .where(eq(garmentWear.garmentId, garmentId))
      ).map((row) => row.clientId);
    const ID = (n: number) =>
      `1a2b3c4d-0000-4000-8000-${String(n).padStart(12, '0')}`;

    it('is stored; a wear already there keeps its own; another garment’s is a 409', async () => {
      const day = daysAgo(2);
      const worn = await createGarment(t, { name: 'Client id jeans' });
      const url = `/wardrobe/${worn}/wear`;
      expect(
        outcome(await replay(url, { worn: '1', day, clientId: ID(10) })),
      ).toEqual([204, 'changed']);
      // Another device's tap for the same garment and day: a no-op that
      // never rewrites the stored id.
      expect(
        outcome(await replay(url, { worn: '1', day, clientId: ID(11) })),
      ).toEqual([204, 'unchanged']);
      expect(await clientIdsOf(worn)).toEqual([ID(10)]);
      // A page tap (no client id) on another day stores none.
      expect((await post(url, { worn: '1' })).statusCode).toBe(303);
      expect((await clientIdsOf(worn)).sort()).toEqual([ID(10), null].sort());
      // The same id for another garment: refused, nothing written.
      const res = await replay(`/wardrobe/${shirt}/wear`, {
        worn: '1',
        day,
        clientId: ID(10),
      });
      expect(res.statusCode).toBe(409);
      expect(await clientIdsOf(shirt)).toEqual([]);
      expect(t.logs.messages('info', 'Web')).toContain(
        `Garment ${shirt} wear on ${day} by user ${t.owner.id} refused: client id 1a2b3c4d names another wear (replayed, key 1a2b3c4d)`,
      );
    });

    // The undo commits while the retry waits on the owner lock: the retry's
    // statement took its snapshot before the wait, so only the trigger's
    // own read (a fresh snapshot) sees the tombstone. A check in the
    // writer's statement would bring the wear back.
    it('is refused as gone when its wear was deleted while the retry waited', async () => {
      const day = daysAgo(1);
      const garmentId = await createGarment(t, { name: 'Raced shirt' });
      const url = `/wardrobe/${garmentId}/wear`;
      const wear = { worn: '1', day, clientId: ID(20) };
      expect(outcome(await replay(url, wear))).toEqual([204, 'changed']);
      const [, retried] = await interleave(
        t.db,
        (tx) =>
          setWoreToday(tx, {
            garmentId,
            ownerId: t.owner.id,
            day,
            worn: false,
            wornAt: null,
          }),
        () => replay(url, wear),
      );
      expect(retried.statusCode).toBe(410);
      expect(await wearDays(garmentId)).toEqual([]);
    });
  });

  it('refuses a day outside the window, 409 with its reason, nothing written', async () => {
    const url = `/wardrobe/${shirt}/wear`;
    expect(outcome(await replay(url, { worn: '1', day: daysAgo(8) }))).toEqual([
      409,
      'too-old',
    ]);
    expect(
      outcome(await replay(`/wardrobe/${shirt}/washed`, { day: daysAgo(-1) })),
    ).toEqual([409, 'future']);
    expect(await wearDays(shirt)).toEqual([]);
    expect(await lastWashed(shirt)).toBeNull();
  });

  it('never moves a wash back: a late replay of an older one is unchanged', async () => {
    const url = `/wardrobe/${jeans}/washed`;
    expect(outcome(await replay(url, { day: daysAgo(2) }))).toEqual([
      204,
      'changed',
    ]);
    expect(outcome(await replay(url, { day: daysAgo(2) }))).toEqual([
      204,
      'unchanged',
    ]);
    expect(outcome(await replay(url, { day: daysAgo(5) }))).toEqual([
      204,
      'unchanged',
    ]);
    expect(await lastWashed(jeans)).toBe(daysAgo(2));
    // A tap still washes today, the day it answers the garment page for.
    expect((await post(url, {})).statusCode).toBe(303);
    expect(await lastWashed(jeans)).toBe(t.today());
  });

  // #676: each record carries its tap's instant, so the order of the
  // replays no longer decides a same-day wear against its wash.
  describe('a wear and a wash of one day, by their taps’ instants', () => {
    const at = (hour: number) =>
      instantAt(daysAgo(1), hour, t.timeZone).toISOString();
    // Raw SQL: a single-table Drizzle select writes the rule's columns
    // unqualified, and its `id` reads garment_wear's (src/db/AGENTS.md).
    const sinceWash = async (garmentId: number) =>
      (
        await t.db.execute<{ since: number }>(
          sql`select ${wearsSinceWashSql()} as since from ${garment} where ${eq(garment.id, garmentId)}`,
        )
      ).rows[0].since;

    it('counts the evening’s wear after the morning’s wash, replayed wear first; a timeless wash keeps the instant', async () => {
      const tee = await createGarment(t, { name: 'Evening tee' });
      const wear = `/wardrobe/${tee}/wear`;
      const wash = `/wardrobe/${tee}/washed`;
      const day = daysAgo(1);
      expect(
        outcome(await replay(wear, { worn: '1', day, at: at(19) })),
      ).toEqual([204, 'changed']);
      expect(outcome(await replay(wash, { day, at: at(9) }))).toEqual([
        204,
        'changed',
      ]);
      expect(await sinceWash(tee)).toBe(1);
      // A record queued before #676 carries no instant, so its replay has
      // none (tapInstant), and never erases the 09:00 one.
      expect(outcome(await replay(wash, { day }))).toEqual([204, 'unchanged']);
      expect(outcome(await replay(wash, { day, at: at(8) }))).toEqual([
        204,
        'unchanged',
      ]);
      expect(await sinceWash(tee)).toBe(1);
      // A later wash that day moves it past the wear, once.
      expect(outcome(await replay(wash, { day, at: at(21) }))).toEqual([
        204,
        'changed',
      ]);
      expect(outcome(await replay(wash, { day, at: at(21) }))).toEqual([
        204,
        'unchanged',
      ]);
      expect(await sinceWash(tee)).toBe(0);
    });

    it('counts the morning’s wear before the evening’s wash, replayed wash first', async () => {
      const tee = await createGarment(t, { name: 'Morning tee' });
      const day = daysAgo(1);
      expect(
        outcome(await replay(`/wardrobe/${tee}/washed`, { day, at: at(21) })),
      ).toEqual([204, 'changed']);
      expect(
        outcome(
          await replay(`/wardrobe/${tee}/wear`, { worn: '1', day, at: at(8) }),
        ),
      ).toEqual([204, 'changed']);
      expect(await sinceWash(tee)).toBe(0);
      const [row] = await t.db
        .select({ washedAt: garment.washedAt })
        .from(garment)
        .where(eq(garment.id, tee));
      expect(row.washedAt?.toISOString()).toBe(at(21));
    });

    const wornAtOf = async (garmentId: number) =>
      (
        await t.db
          .select({ wornAt: garmentWear.wornAt })
          .from(garmentWear)
          .where(eq(garmentWear.garmentId, garmentId))
      ).map((row) => row.wornAt?.toISOString() ?? null);

    it('orders an entry marked worn by its tap’s instant too, whenever it replays', async () => {
      // Tapped worn at 15:00; one tee washed that morning, one that night.
      const morning = await createGarment(t, { name: 'Washed-at-nine tee' });
      const night = await createGarment(t, { name: 'Washed-at-nine-pm tee' });
      const day = daysAgo(1);
      const entry = await newEntry(await newOutfit([morning, night]), day);
      for (const [tee, hour] of [
        [morning, 9],
        [night, 21],
      ]) {
        expect(
          outcome(
            await replay(`/wardrobe/${tee}/washed`, { day, at: at(hour) }),
          ),
        ).toEqual([204, 'changed']);
      }
      expect(
        outcome(
          await replay(`/calendar/${entry}/worn`, { worn: '1', at: at(15) }),
        ),
      ).toEqual([204, 'changed']);
      expect(await wornAtOf(morning)).toEqual([at(15)]);
      expect(await sinceWash(morning)).toBe(1);
      expect(await sinceWash(night)).toBe(0);
    });

    it('knows no instant for a replay that posted none, on its own day too; a live tap is now', async () => {
      const tee = await createGarment(t, { name: 'Old-outbox tee' });
      const day = t.today();
      const entry = await newEntry(await newOutfit([tee]), day);
      // Records queued before #676: the replay's time is not the tap's.
      expect(outcome(await replay(`/wardrobe/${tee}/washed`, { day }))).toEqual(
        [204, 'changed'],
      );
      expect(
        outcome(await replay(`/wardrobe/${tee}/wear`, { worn: '1', day })),
      ).toEqual([204, 'changed']);
      expect(
        outcome(await replay(`/calendar/${entry}/worn`, { worn: '1' })),
      ).toEqual([204, 'changed']);
      const [row] = await t.db
        .select({ washedAt: garment.washedAt })
        .from(garment)
        .where(eq(garment.id, tee));
      expect(row.washedAt).toBeNull();
      expect(await wornAtOf(tee)).toEqual([null, null]);

      const live = await createGarment(t, { name: 'Live-tap tee' });
      const liveEntry = await newEntry(await newOutfit([live]), day);
      expect(
        (await post(`/calendar/${liveEntry}/worn`, { worn: '1' })).statusCode,
      ).toBe(303);
      expect(await wornAtOf(live)).toEqual([expect.any(String)]);
    });

    it('gives a timeless day-level wear the instant a later Wore today knows', async () => {
      const tee = await createGarment(t, { name: 'Timed-later tee' });
      const day = daysAgo(1);
      const wear = `/wardrobe/${tee}/wear`;
      // An older outbox's Wore today (no instant), a 09:00 wash, then the
      // same wear with its 19:00 instant: the wear counts after the wash.
      expect(outcome(await replay(wear, { worn: '1', day }))).toEqual([
        204,
        'changed',
      ]);
      expect(
        outcome(await replay(`/wardrobe/${tee}/washed`, { day, at: at(9) })),
      ).toEqual([204, 'changed']);
      expect(await sinceWash(tee)).toBe(0);
      expect(
        outcome(await replay(wear, { worn: '1', day, at: at(19) })),
      ).toEqual([204, 'changed']);
      expect(await sinceWash(tee)).toBe(1);
      // An earlier or unknown instant moves nothing.
      const movesNothing: Fields[] = [
        { worn: '1', day, at: at(12) },
        { worn: '1', day },
      ];
      for (const fields of movesNothing) {
        expect(outcome(await replay(wear, fields))).toEqual([204, 'unchanged']);
      }
      expect(await wornAtOf(tee)).toEqual([at(19)]);
    });

    it('keeps the later known instant where a deleted outfit’s wear meets a day-level one', async () => {
      const tee = await createGarment(t, { name: 'Detached tee' });
      const day = daysAgo(1);
      const outfit = await newOutfit([tee]);
      const entry = await newEntry(outfit, day);
      expect(
        outcome(await replay(`/wardrobe/${tee}/washed`, { day, at: at(9) })),
      ).toEqual([204, 'changed']);
      // An older outbox's Wore today (no instant), and the entry at 19:00.
      expect(
        outcome(await replay(`/wardrobe/${tee}/wear`, { worn: '1', day })),
      ).toEqual([204, 'changed']);
      expect(
        outcome(
          await replay(`/calendar/${entry}/worn`, { worn: '1', at: at(19) }),
        ),
      ).toEqual([204, 'changed']);
      expect(await sinceWash(tee)).toBe(1);

      const res = await t.inject({
        method: 'DELETE',
        url: `/outfits/${outfit}`,
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);

      expect(await wornAtOf(tee)).toEqual([at(19)]);
      expect(await sinceWash(tee)).toBe(1);
    });
  });

  it('replays an entry worn, twice as once, and its undo', async () => {
    const entry = await newEntry(await newOutfit([shirt]), daysAgo(1));
    const url = `/calendar/${entry}/worn`;
    expect(outcome(await replay(url, { worn: '1' }))).toEqual([204, 'changed']);
    expect(outcome(await replay(url, { worn: '1' }))).toEqual([
      204,
      'unchanged',
    ]);
    expect(await wearDays(shirt)).toEqual([daysAgo(1)]);
    expect(outcome(await replay(url, { worn: '0' }))).toEqual([204, 'changed']);
    expect(await wearDays(shirt)).toEqual([]);
  });

  it('replays a packing tick as just its item, beside another tick', async () => {
    const tripId = await newTrip(await newOutfit([shirt, jeans]));
    const url = `/trips/${tripId}/packed`;
    const tick = { packed: [String(shirt)], shown: [String(shirt)] };
    expect(outcome(await replay(url, tick))).toEqual([204, 'changed']);
    expect(outcome(await replay(url, tick))).toEqual([204, 'unchanged']);
    // Jeans ticked on another device; the shirt's untick replayed after.
    await post(url, { packed: [String(jeans)], shown: [String(jeans)] });
    expect(outcome(await replay(url, { shown: [String(shirt)] }))).toEqual([
      204,
      'changed',
    ]);
    expect(await packedOf(tripId)).toEqual([jeans]);

    await post(`/trips/${tripId}/items`, { label: 'Charger' });
    const [{ id: itemId }] = await t.db
      .select({ id: tripItem.id })
      .from(tripItem)
      .where(eq(tripItem.tripId, tripId));
    const items = `/trips/${tripId}/items/packed`;
    const itemTick = { packed: [String(itemId)], shown: [String(itemId)] };
    expect(outcome(await replay(items, itemTick))).toEqual([204, 'changed']);
    expect(outcome(await replay(items, itemTick))).toEqual([204, 'unchanged']);
  });

  it('refuses another account’s replay, 409 account, nothing written', async () => {
    const entry = await newEntry(await newOutfit([jeans]), t.today());
    for (const [url, fields] of [
      [`/wardrobe/${jeans}/wear`, { worn: '1' }],
      [`/calendar/${entry}/worn`, { worn: '1' }],
    ] as const) {
      expect(outcome(await replay(url, fields, t.owner.id + 1000))).toEqual([
        409,
        'account',
      ]);
    }
    expect(await wearDays(jeans)).toEqual([]);
    expect(t.logs.messages('warn', 'Web')).toContain(
      `Queued wear for account ${t.owner.id + 1000} refused: signed in as user ${t.owner.id} (replayed, key 1a2b3c4d)`,
    );
  });

  it('answers a gone garment, entry and trip 404, and keeps the CSRF and session gates', async () => {
    const gone = await createGarment(t, { name: 'Gone shirt' });
    const entry = await newEntry(await newOutfit([gone]), t.today());
    const tripId = await newTrip(await newOutfit([gone]));
    expect(
      (await t.inject({ method: 'DELETE', url: `/wardrobe/${gone}` }))
        .statusCode,
    ).toBeLessThan(400);
    expect(
      (await t.inject({ method: 'DELETE', url: `/trips/${tripId}` }))
        .statusCode,
    ).toBeLessThan(400);
    expect((await post(`/calendar/${entry}/delete`, {})).statusCode).toBe(303);
    for (const [url, fields] of [
      [`/wardrobe/${gone}/wear`, { worn: '1' }],
      [`/wardrobe/${gone}/washed`, {}],
      [`/calendar/${entry}/worn`, { worn: '1' }],
      [`/trips/${tripId}/packed`, { shown: [String(gone)] }],
      [`/trips/${tripId}/items/packed`, { shown: ['1'] }],
    ] as const) {
      expect((await replay(url, fields)).statusCode, url).toBe(404);
    }
    const url = `/wardrobe/${shirt}/wear`;
    const noOrigin = await t.inject({
      method: 'POST',
      url,
      payload: 'worn=1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-closet-queued': String(t.owner.id),
      },
      sameOrigin: false,
    });
    expect(noOrigin.statusCode).toBe(403);
    // No Fetch Metadata, as on the plain-HTTP twin: the replay header alone
    // gets the 401 that keeps the record, where a bare post (a person at a
    // browser) is sent to the login page.
    const signedOut = (queued: boolean) =>
      t.inject({
        method: 'POST',
        url,
        payload: 'worn=1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(queued ? { 'x-closet-queued': String(t.owner.id) } : {}),
        },
        anonymous: true,
      });
    expect((await signedOut(true)).statusCode).toBe(401);
    expect((await signedOut(false)).statusCode).toBe(302);
    expect(await wearDays(shirt)).toEqual([]);
  });

  it('costs a replay the writer’s statements and the session, no answer read', async () => {
    const entry = await newEntry(await newOutfit([shirt]), t.today());
    const tripId = await newTrip(await newOutfit([shirt]));
    const counted: [url: string, fields: Fields, statements: number][] = [
      [`/wardrobe/${shirt}/wear`, { worn: '1' }, 2],
      [`/wardrobe/${shirt}/washed`, {}, 2],
      // begin, the owner lock, the entry locked, the change, commit
      [`/calendar/${entry}/worn`, { worn: '1' }, 6],
      [
        `/trips/${tripId}/packed`,
        { packed: [String(shirt)], shown: [String(shirt)] },
        2,
      ],
      [`/trips/${tripId}/items/packed`, { shown: [] }, 2],
    ];
    for (const [url, fields, statements] of counted) {
      let status = 0;
      const record = await recordQueries(async () => {
        status = (await replay(url, fields)).statusCode;
      });
      expect([status, record.statements], url).toEqual([204, statements]);
    }
  });

  describe('the pages’ queueable controls', () => {
    const page = async (url: string, anonymous = false) =>
      unescapeHtml((await t.inject({ method: 'GET', url, anonymous })).body);
    /** A region's opening tag, or undefined. */
    const regionTag = (html: string, key: string) =>
      new RegExp(`<[a-z]+ [^>]*data-outbox-key="${key}"[^>]*>`).exec(html)?.[0];
    /** What a region with another state shows, and that state. */
    const states = (html: string, key: string) => {
      const from = html.indexOf(`data-outbox-key="${key}"`);
      expect(from, key).toBeGreaterThan(-1);
      const open = html.indexOf('<template data-outbox-state="">', from);
      const close = html.indexOf('</template>', open);
      return {
        shown: html.slice(from, open),
        alternate: html.slice(open, close),
        chip: html.slice(close, html.indexOf('</span>', close)),
      };
    };
    /** Every region's key names the kind its path replays as. */
    const expectKeysMatchPaths = (html: string) => {
      const regions = Array.from(
        html.matchAll(/data-outbox-key="([^"]+)" data-outbox-path="([^"]+)"/g),
      );
      expect(regions.length).toBeGreaterThan(0);
      for (const [, key, path] of regions) {
        expect(queueableKindOf(path), key).toBe(key.split(':')[0]);
      }
      expect(html.match(/data-outbox-chip=""/g)).toHaveLength(regions.length);
    };

    it('marks each with its record, its other state and its chip, never the network guard', async () => {
      const tee = await createGarment(t, {
        name: 'Marked tee',
        category: 'tops',
      });
      const today = t.today();
      expect(
        (await post(`/wardrobe/${tee}/wear`, { worn: '1' })).statusCode,
      ).toBe(303);

      // The garment page names no day (#708): Wore today shows, its undo
      // waits, and the last wear's day and kind tell the page's script
      // (views/assets/outbox.ts, showPageDay) to show the undo on that day.
      const garmentPage = await page(`/wardrobe/${tee}`);
      const wear = queuedTarget('wear', tee);
      expect(regionTag(garmentPage, wear.key)).toContain(
        `data-outbox-path="${wear.path}" data-outbox-label="Marked tee" data-worn-on="${today}" data-worn-by="single"`,
      );
      const wore = states(garmentPage, wear.key);
      expect(wore.shown).toMatch(
        /data-offline-queue="wear"[^>]*><input type="hidden" name="worn" value="1"\/>/,
      );
      expect(wore.alternate).toContain('Undo');
      expect(wore.alternate).toMatch(
        /data-offline-queue="wear"[^>]*><input type="hidden" name="worn" value="0"\/>/,
      );
      expect(wore.chip).toContain('Waiting to sync');
      const wash = states(garmentPage, queuedTarget('wash', tee).key);
      expect(wash.shown).toContain('data-offline-queue="wash"');
      expect(wash.alternate).toContain('✓ Washed');
      expect(wash.alternate).not.toContain('<form');
      for (const part of [wore.shown, wore.alternate, wash.shown]) {
        expect(part).not.toContain('data-needs-network');
      }
      expectKeysMatchPaths(garmentPage);

      // The laundry: one native form, a wash per row.
      const laundry = await page('/laundry');
      expect(laundry).toMatch(
        /<form [^>]*action="\/laundry"[^>]*data-offline-queue="wash"/,
      );
      expect(regionTag(laundry, `wash:${tee}`)).toContain(
        'data-outbox-label="Marked tee"',
      );
      expectKeysMatchPaths(laundry);

      // An entry: the calendar's pill (htmx) and Today's button (a PostForm).
      const entry = await newEntry(await newOutfit([tee]), today);
      const target = queuedTarget('entry', entry);
      for (const url of [`/calendar?week=${today}`, '/']) {
        const html = await page(url);
        const pill = states(html, target.key);
        expect(pill.shown, url).toMatch(
          /data-offline-queue="entry"[^>]*><input type="hidden" name="worn" value="1"\/>/,
        );
        expect(pill.alternate, url).toContain('✓ Worn');
        expect(pill.alternate, url).toContain('name="worn" value="0"');
        expectKeysMatchPaths(html);
      }

      // A trip: each packing tick and extra is its own record; "Wore it"
      // for an outfit not on the calendar plans one, so it needs the network.
      const tripId = await newTrip(await newOutfit([tee]));
      await post(`/trips/${tripId}/items`, { label: 'Charger' });
      const [{ id: itemId }] = await t.db
        .select({ id: tripItem.id })
        .from(tripItem)
        .where(eq(tripItem.tripId, tripId));
      const trip = await page(`/trips/${tripId}`);
      expect(trip).toMatch(
        new RegExp(
          `action="/trips/${tripId}/packed"[^>]*data-offline-queue="packed"`,
        ),
      );
      expect(trip).toMatch(
        new RegExp(
          `action="/trips/${tripId}/items/packed"[^>]*data-offline-queue="item"`,
        ),
      );
      expect(
        regionTag(trip, queuedTarget('packed', tripId, tee).key),
      ).toContain('data-outbox-label="Marked tee"');
      expect(
        regionTag(trip, queuedTarget('item', tripId, itemId).key),
      ).toContain('data-outbox-label="Charger"');
      expect(trip).toMatch(
        new RegExp(
          `action="/trips/${tripId}/outfits/\\d+/wear"[^>]*data-needs-network=""`,
        ),
      );
      expect(trip).toMatch(
        new RegExp(
          `action="/trips/${tripId}/items/${itemId}/delete"[^>]*data-needs-network=""`,
        ),
      );
      expectKeysMatchPaths(trip);
    });

    it('names the account and the zone, and loads the outbox, on signed-in pages only', async () => {
      const answer = await t.inject({ method: 'GET', url: '/wardrobe' });
      const signedIn = unescapeHtml(answer.body);
      expect(signedIn).toMatch(
        new RegExp(
          `<div id="app-status"[^>]* data-account="${t.owner.id}" data-time-zone="${t.timeZone}"`,
        ),
      );
      // The worker's claim keeps the records whose account equals the page's
      // X-Page-Account (queuedWritesGoneAtClaim), and a record's account is
      // this attribute: one spelling, or a sign-in deletes the user's own.
      expect(answer.headers[PAGE_ACCOUNT_HEADER.toLowerCase()]).toBe(
        /data-account="([^"]+)"/.exec(signedIn)?.[1],
      );
      expect(signedIn).toContain(
        'data-text-outbox-waiting-many="{count} changes waiting to sync"',
      );
      expect(signedIn).toContain(
        'data-text-outbox-not-saved="{label}, {action}: not saved, {reason}."',
      );
      expect(signedIn).toMatch(
        /<script type="module" src="\/js\/outbox\.js\?v=[^"]+"><\/script>/,
      );
      expect(signedIn).toContain('id="outbox-notice"');

      const signedOut = await page('/auth/login', true);
      expect(signedOut).toContain('id="app-status"');
      for (const absent of [
        'data-account=',
        'data-text-outbox-',
        '/js/outbox.js',
        'id="outbox-banner"',
      ]) {
        expect(signedOut).not.toContain(absent);
      }
    });
  });
});
