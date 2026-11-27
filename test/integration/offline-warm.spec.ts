import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  file,
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
  trip,
  tripItem,
  wardrobeShare,
} from '../../src/db/schema';
import type { GarmentStatus } from '../../src/wardrobe/status';
import { addDays } from '../../src/calendar-date';
import {
  isQueueablePage,
  LAUNDRY_PAGE,
  QUEUEABLE_ROUTES,
  type QueueableKind,
  queuedTarget,
  showsQueuedWrite,
} from '../../src/offline-writes';
import { weekOf } from '../../src/web/calendar/calendar-view';
import { TAB_ROOTS } from '../../src/web/page-cache';
import {
  parseWarmList,
  WARM_GARMENT_CAP,
  WARM_LIST_PATH,
  WARM_OUTFIT_CAP,
  WARM_PAGE_CAP,
  WARM_TRIP_CAP,
  type WarmList,
} from '../../src/web/shell/offline-warm';
import { WARM_REQUEST_HEADER } from '../../src/warm-request';
import { GRID_PAGE_SIZE } from '../../src/web/wardrobe/grid-page-size';
import {
  createTestApp,
  PWA_ENV,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
} from './harness';

/**
 * GET /offline/warm (#286): the list the service worker warms for offline
 * reading. Always the session's own wardrobe: a grantee's list never holds
 * the wardrobe shared with them, whatever `?ownerId=` says. The worker side
 * (what it fetches, keeps and drops) is test/offline-warm.spec.ts (retired 2026-10-13) and
 * test/stale-pages.spec.ts (retired 2026-10-13).
 */
describe('GET /offline/warm', () => {
  let t: TestApp;
  /** The owner's closet garments, newest first. */
  let closet: number[];
  let archived: number;
  let wished: number;
  let setAside: number;
  let outfitId: number;

  const warmList = async (
    cookie: string,
    url = WARM_LIST_PATH,
  ): Promise<WarmList> => {
    const res = await t.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const list = parseWarmList(res.json());
    if (!list) throw new Error(`Not a warm list: ${res.body}`);
    return list;
  };

  /** A garment straight into the table, with a photo row when asked. */
  const insertGarment = async (
    ownerId: number,
    status: GarmentStatus,
    withPhoto: boolean,
  ): Promise<number> => {
    let photoId: number | null = null;
    if (withPhoto) {
      const [photo] = await asFixture(t.db, (tx) =>
        tx
          .insert(file)
          .values({
            fileName: `${randomUUID()}.webp`,
            createdOn: new Date().toISOString(),
            createdById: ownerId,
          })
          .returning({ id: file.id }),
      );
      photoId = photo.id;
    }
    const [row] = await asFixture(t.db, (tx) =>
      tx
        .insert(garment)
        .values({
          shareableId: randomUUID(),
          ownerId,
          name: `Piece ${randomUUID().slice(0, 8)}`,
          category: 'tops',
          status,
          photoId,
        })
        .returning({ id: garment.id }),
    );
    return row.id;
  };

  const insertOutfit = async (
    ownerId: number,
    garmentIds: number[],
  ): Promise<number> => {
    const [made] = await asFixture(t.db, (tx) =>
      tx
        .insert(outfit)
        .values({ shareableId: randomUUID(), ownerId, name: 'Warm outfit' })
        .returning({ id: outfit.id }),
    );
    if (garmentIds.length > 0) {
      await asFixture(t.db, (tx) =>
        tx.insert(outfitSlot).values(
          garmentIds.map((garmentId, position) => ({
            outfitId: made.id,
            position,
            category: 'tops',
            garmentId,
          })),
        ),
      );
    }
    return made.id;
  };

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
    // More than a grid page, so the list names a later one; every other
    // garment has a photo.
    const ids: number[] = [];
    for (let i = 0; i < GRID_PAGE_SIZE + 5; i++) {
      ids.push(await insertGarment(t.owner.id, 'closet', i % 2 === 0));
    }
    closet = ids.reverse();
    archived = await insertGarment(t.owner.id, 'archived', true);
    wished = await insertGarment(t.owner.id, 'wishlist', true);
    setAside = await insertGarment(t.owner.id, 'wishlist', false);
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ dismissedAt: new Date() })
        .where(eq(garment.id, setAside)),
    );
    outfitId = await insertOutfit(t.owner.id, [closet[0], closet[1]]);
  });

  afterAll(() => t?.cleanup());

  it('lists the next week, every closet garment and outfit, uncacheable and owned', async () => {
    const res = await t.inject({
      method: 'GET',
      url: WARM_LIST_PATH,
      headers: { cookie: t.owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    // Whose list it is: the worker claims its caches for this account.
    expect(res.headers['x-page-account']).toBe(String(t.owner.id));
    // Never a tab root, as the server sends it (parseWarmList would drop
    // one): they open stale-while-revalidate, so a warmed copy would open
    // stale after the user's own edits. Cached when first opened.
    const sent = res.json<WarmList>();
    for (const root of TAB_ROOTS) expect(sent.pages).not.toContain(root);

    const list = await warmList(t.owner.cookie);
    const nextSunday = addDays(weekOf(t.today()).start, 7);
    expect(list.pages).toEqual([
      `/calendar?week=${nextSunday}`,
      // Always: Washed queues offline (#657).
      '/laundry',
      ...closet.map((id) => `/wardrobe/${id}`),
      `/outfits/${outfitId}`,
      // The agent inbox (#333): the Wishlist tab, and what is still wanted.
      '/wardrobe/wishlist',
      `/wardrobe/${wished}`,
    ]);
    // Archived: neither warmed nor kept, so its cached page goes.
    expect(list.pages).not.toContain(`/wardrobe/${archived}`);
    expect(list.keep).not.toContain(`/wardrobe/${archived}`);
    // A wishlist item set aside: its visited page stays, unwarmed.
    expect(list.keep).toEqual([`/wardrobe/${setAside}`]);
  });

  it('names the grid’s later pages exactly as the grid’s own scroll asks for them', async () => {
    const list = await warmList(t.owner.cookie);
    const grid = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: t.owner.cookie },
    });
    const sentinel = /hx-get="(\/wardrobe\/tiles\?[^"]+)"/.exec(
      unescapeHtml(grid.body),
    )?.[1];
    expect(list.fragments).toEqual([sentinel]);
    expect(list.fragments).toEqual([
      `/wardrobe/tiles?before=${closet[GRID_PAGE_SIZE - 1]}`,
    ]);
  });

  it('names the thumbs the warmed pages show, each once', async () => {
    const list = await warmList(t.owner.cookie);
    const shown = new Set<string>();
    for (const url of ['/wardrobe', '/wardrobe/wishlist', ...list.fragments]) {
      const res = await t.inject({
        method: 'GET',
        url,
        headers: { cookie: t.owner.cookie, 'hx-request': 'true' },
      });
      for (const [, src] of unescapeHtml(res.body).matchAll(
        /<img[^>]*src="(\/file\/thumb\/[^"]+)"/g,
      )) {
        shown.add(src);
      }
    }
    // Every closet garment with a photo, the outfit's two among them, and
    // the wishlist item's.
    expect(new Set(list.images)).toEqual(shown);
    expect(list.images).toHaveLength(shown.size);
    expect(list.images).toHaveLength(Math.ceil(closet.length / 2) + 1);
  });

  it('marks a warm’s requests in the request log', async () => {
    await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: t.owner.cookie, [WARM_REQUEST_HEADER]: '1' },
    });
    expect(t.logs.messages('info', 'Http')).toContainEqual(
      expect.stringMatching(/^GET \/wardrobe 200 [\d.]+ms \(warm\)$/),
    );
  });

  it('leaves a warm’s requests out of the request histogram', async () => {
    const countOf = async (route: string) => {
      const exposed = await t.metrics.registry.metrics();
      const line = exposed
        .split('\n')
        .find(
          (row) =>
            row.startsWith('http_request_duration_seconds_count{') &&
            row.includes(`route="${route}"`),
        );
      return Number(line?.split(' ').at(-1) ?? 0);
    };
    const before = await countOf('/outfits/:id');
    await t.inject({
      method: 'GET',
      url: `/outfits/${outfitId}`,
      headers: { cookie: t.owner.cookie, [WARM_REQUEST_HEADER]: '1' },
    });
    expect(await countOf('/outfits/:id')).toBe(before);
    await t.inject({
      method: 'GET',
      url: `/outfits/${outfitId}`,
      headers: { cookie: t.owner.cookie },
    });
    expect(await countOf('/outfits/:id')).toBe(before + 1);
  });

  // The worker's own fetch is no navigation (Sec-Fetch-Mode: cors): the
  // gate refuses it, and the worker reads the 401 as the session's end.
  it('refuses the worker’s signed-out request with a 401', async () => {
    const res = await t.inject({
      method: 'GET',
      url: WARM_LIST_PATH,
      anonymous: true,
      headers: { 'sec-fetch-mode': 'cors', [WARM_REQUEST_HEADER]: '1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sends a signed-out request to the login page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: WARM_LIST_PATH,
      anonymous: true,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/auth\/login/);
  });

  describe('a grantee', () => {
    let granteeCookie: string;
    let granteeId: number;
    let own: number;

    beforeAll(async () => {
      const email = 'warm-grantee@example.com';
      granteeCookie = await t.register(email);
      granteeId = await userIdOf(t, email);
      await t.db.insert(wardrobeShare).values({
        grantorId: t.owner.id,
        granteeId,
        permission: 'MANAGE',
        acceptedAt: new Date(),
        createdAt: new Date(),
      });
      own = await insertGarment(granteeId, 'closet', true);
    });

    it('warms only their own wardrobe; naming the owner is a 404', async () => {
      // The share is live: the grantee does see the owner's wardrobe.
      const shared = await t.inject({
        method: 'GET',
        url: `/wardrobe/${closet[0]}?ownerId=${t.owner.id}`,
        headers: { cookie: granteeCookie },
      });
      expect(shared.statusCode).toBe(200);

      const res = await t.inject({
        method: 'GET',
        url: WARM_LIST_PATH,
        headers: { cookie: granteeCookie },
      });
      expect(res.headers['x-page-account']).toBe(String(granteeId));
      const list = await warmList(granteeCookie, WARM_LIST_PATH);
      const garmentPages = list.pages.filter((path) =>
        /^\/wardrobe\/\d+$/.test(path),
      );
      expect(garmentPages).toEqual([`/wardrobe/${own}`]);
      expect(list.pages).not.toContain(`/outfits/${outfitId}`);
      expect(list.fragments).toEqual([]);
      expect(list.keep).toEqual([]);
      expect(list.images).toHaveLength(1);
      expect(list.pages.join(' ')).not.toContain('ownerId');

      // The warm list is the account's own (#680): never under another's id.
      const named = await t.inject({
        method: 'GET',
        url: `${WARM_LIST_PATH}?ownerId=${t.owner.id}`,
        headers: { cookie: granteeCookie },
      });
      expect(named.statusCode).toBe(404);
      expect(named.body).not.toContain(`/wardrobe/${closet[0]}`);
    });
  });

  describe('caps', () => {
    let cookie: string;
    /** Newest first. */
    let garments: number[];
    let outfits: number[];

    beforeAll(async () => {
      const email = 'warm-caps@example.com';
      cookie = await t.register(email);
      const ownerId = await userIdOf(t, email);
      const rows = Array.from({ length: WARM_GARMENT_CAP + 1 }, (_, i) => ({
        shareableId: randomUUID(),
        ownerId,
        name: `Capped ${i}`,
        category: 'tops',
      }));
      const inserted = await asFixture(t.db, (tx) =>
        tx.insert(garment).values(rows).returning({ id: garment.id }),
      );
      garments = inserted.map((row) => row.id).reverse();
      const made = await asFixture(t.db, (tx) =>
        tx
          .insert(outfit)
          .values(
            Array.from({ length: WARM_OUTFIT_CAP + 1 }, () => ({
              shareableId: randomUUID(),
              ownerId,
            })),
          )
          .returning({ id: outfit.id }),
      );
      outfits = made.map((row) => row.id).reverse();
    });

    it('warms the newest garments and outfits up to the caps and keeps the rest', async () => {
      const list = await warmList(cookie);
      const warmedGarments = list.pages.filter((path) =>
        /^\/wardrobe\/\d+$/.test(path),
      );
      const warmedOutfits = list.pages.filter((path) =>
        /^\/outfits\/\d+$/.test(path),
      );
      expect(warmedGarments).toEqual(
        garments.slice(0, WARM_GARMENT_CAP).map((id) => `/wardrobe/${id}`),
      );
      expect(warmedOutfits).toEqual(
        outfits.slice(0, WARM_OUTFIT_CAP).map((id) => `/outfits/${id}`),
      );
      expect(list.keep).toEqual([
        `/wardrobe/${garments[WARM_GARMENT_CAP]}`,
        `/outfits/${outfits[WARM_OUTFIT_CAP]}`,
      ]);
      expect(list.pages.length + list.fragments.length).toBeLessThanOrEqual(
        WARM_PAGE_CAP,
      );
      // Every later grid page whose every tile is warmed: none renders a
      // garment past the cap.
      const wholePages = Math.floor(WARM_GARMENT_CAP / GRID_PAGE_SIZE);
      expect(list.fragments).toEqual(
        Array.from(
          { length: wholePages - 1 },
          (_, i) =>
            `/wardrobe/tiles?before=${garments[(i + 1) * GRID_PAGE_SIZE - 1]}`,
        ),
      );
      // The last listed grid page renders only warmed garments.
      const last = await t.inject({
        method: 'GET',
        url: list.fragments.at(-1)!,
        headers: { cookie, 'hx-request': 'true' },
      });
      const shown = [
        ...unescapeHtml(last.body).matchAll(/href="(\/wardrobe\/\d+)"/g),
      ].map((match) => match[1]);
      expect(shown.length).toBeGreaterThan(0);
      expect(warmedGarments).toEqual(expect.arrayContaining(shown));
    });
  });

  // #659: one-offs sit behind "Worn and planned", but Today and the
  // calendar open the ones this week and next hold, so those warm first,
  // ahead of the kept outfits that fill the cap; the rest are only kept.
  describe('one-offs', () => {
    it('warms the near-term one-offs first, then the kept ones to the cap, and only keeps the other one-offs', async () => {
      const email = 'warm-one-offs@example.com';
      const cookie = await t.register(email);
      const ownerId = await userIdOf(t, email);
      const ids = await asFixture(t.db, async (tx) => {
        const insert = async (origin: 'idea' | 'planner'): Promise<number> => {
          const [row] = await tx
            .insert(outfit)
            .values({ shareableId: randomUUID(), ownerId, origin })
            .returning({ id: outfit.id });
          return row.id;
        };
        // The oldest first, so newest-first order alone would cut them.
        const planned = await insert('planner');
        const later = await insert('idea');
        const unplanned = await insert('idea');
        await tx.insert(outfitCalendar).values([
          { day: t.today(), outfitId: planned, ownerId },
          // Past next week: not near-term.
          { day: addDays(t.today(), 21), outfitId: later, ownerId },
        ]);
        const kept = await tx
          .insert(outfit)
          .values(
            Array.from({ length: WARM_OUTFIT_CAP }, () => ({
              shareableId: randomUUID(),
              ownerId,
            })),
          )
          .returning({ id: outfit.id });
        return {
          planned,
          later,
          unplanned,
          kept: kept.map((row) => row.id).reverse(),
        };
      });
      const list = await warmList(cookie);
      expect(
        list.pages.filter((path) => /^\/outfits\/\d+$/.test(path)),
      ).toEqual(
        [ids.planned, ...ids.kept.slice(0, WARM_OUTFIT_CAP - 1)].map(
          (id) => `/outfits/${id}`,
        ),
      );
      expect(list.keep).toEqual(
        [ids.kept[WARM_OUTFIT_CAP - 1], ids.unplanned, ids.later].map(
          (id) => `/outfits/${id}`,
        ),
      );
    });

    // #756: the window is the whole of this week, which the calendar's week
    // page links, not just the days from today. The route reads the real
    // clock, so on the week's first day there is no earlier day this week:
    // only the last-week half is asserted then.
    it('warms a one-off planned earlier this week and only keeps last week’s', async () => {
      const email = 'warm-one-offs-week@example.com';
      const cookie = await t.register(email);
      const ownerId = await userIdOf(t, email);
      const weekStart = weekOf(t.today()).start;
      const hasEarlierDay = weekStart !== t.today();
      const ids = await asFixture(t.db, async (tx) => {
        const insert = async (): Promise<number> => {
          const [row] = await tx
            .insert(outfit)
            .values({ shareableId: randomUUID(), ownerId, origin: 'idea' })
            .returning({ id: outfit.id });
          return row.id;
        };
        const thisWeek = await insert();
        const lastWeek = await insert();
        await tx
          .insert(outfitCalendar)
          .values([
            { day: addDays(weekStart, -1), outfitId: lastWeek, ownerId },
            ...(hasEarlierDay
              ? [{ day: weekStart, outfitId: thisWeek, ownerId }]
              : []),
          ]);
        return { thisWeek, lastWeek };
      });
      const list = await warmList(cookie);
      if (hasEarlierDay) {
        expect(list.pages).toContain(`/outfits/${ids.thisWeek}`);
      }
      expect(list.pages).not.toContain(`/outfits/${ids.lastWeek}`);
      expect(list.keep).toContain(`/outfits/${ids.lastWeek}`);
    });
  });

  describe('pages with queueable controls (#657)', () => {
    let cookie: string;
    const tripIds = { past: 0, ending: 0, later: 0, sooner: 0 };

    beforeAll(async () => {
      const email = 'warm-queueable@example.com';
      cookie = await t.register(email);
      const ownerId = await userIdOf(t, email);
      const today = t.today();
      const make = async (name: string, startsOn: string, endsOn: string) => {
        const [row] = await asFixture(t.db, (tx) =>
          tx
            .insert(trip)
            .values({ ownerId, name, startsOn, endsOn })
            .returning({ id: trip.id }),
        );
        return row.id;
      };
      // The household's today, never UTC's: a trip's last day is still on.
      tripIds.past = await make('Past', addDays(today, -9), addDays(today, -1));
      tripIds.later = await make(
        'Later',
        addDays(today, 30),
        addDays(today, 33),
      );
      tripIds.ending = await make('Ending', addDays(today, -2), today);
      tripIds.sooner = await make(
        'Sooner',
        addDays(today, 5),
        addDays(today, 6),
      );
      // A trip draws its ticks only once it has something to pack.
      await asFixture(t.db, (tx) =>
        tx
          .insert(tripItem)
          .values({ tripId: tripIds.sooner, label: 'Charger' }),
      );
    });

    it('warms the laundry and the trips ahead or on, nearest first, and not a past trip', async () => {
      const list = await warmList(cookie);
      const queueable = list.pages.filter(
        (path) => path === LAUNDRY_PAGE || path.startsWith('/trips/'),
      );
      expect(queueable).toEqual([
        LAUNDRY_PAGE,
        `/trips/${tripIds.ending}`,
        `/trips/${tripIds.sooner}`,
        `/trips/${tripIds.later}`,
      ]);
      // Right after next week, before the wardrobe's pages.
      expect(list.pages.indexOf(LAUNDRY_PAGE)).toBe(1);
      expect(list.pages).not.toContain(`/trips/${tripIds.past}`);
      // A past trip still exists: its visited copy stays.
      expect(list.keep).toEqual([`/trips/${tripIds.past}`]);
    });

    it('caps the trips a warm names and keeps the rest', async () => {
      const email = 'warm-trip-cap@example.com';
      const capped = await t.register(email);
      const id = await userIdOf(t, email);
      const day = addDays(t.today(), 1);
      const rows = await asFixture(t.db, (tx) =>
        tx
          .insert(trip)
          .values(
            Array.from({ length: WARM_TRIP_CAP + 1 }, (_, i) => ({
              ownerId: id,
              name: `Trip ${i}`,
              startsOn: day,
              endsOn: day,
            })),
          )
          .returning({ id: trip.id }),
      );
      // The same first day: by id, so the last one made is past the cap.
      const ids = rows.map((row) => row.id).sort((a, b) => a - b);
      const list = await warmList(capped);
      expect(list.pages.filter((p) => p.startsWith('/trips/'))).toEqual(
        ids.slice(0, WARM_TRIP_CAP).map((n) => `/trips/${n}`),
      );
      expect(list.keep).toEqual([`/trips/${ids[WARM_TRIP_CAP]}`]);
    });

    // The invariant: a page showsQueuedWrite names is Today, a tab root, a
    // warmed garment page, or a queueable page the warm list holds.
    it('covers every page that shows a queued write', async () => {
      const list = await warmList(cookie);
      const id = tripIds.sooner;
      const candidates = [
        '/',
        '/calendar',
        LAUNDRY_PAGE,
        `/trips/${id}`,
        `/wardrobe/${id}`,
        `/outfits/${id}`,
        '/wardrobe',
        '/wardrobe/wishlist',
        '/insights',
        '/styling',
        '/trips',
      ];
      const covered = (path: string) =>
        path === '/' ||
        TAB_ROOTS.has(path) ||
        /^\/wardrobe\/\d+$/.test(path) ||
        (isQueueablePage(path) && list.pages.includes(path));
      for (const kind of Object.keys(QUEUEABLE_ROUTES) as QueueableKind[]) {
        const write = queuedTarget(kind, id).path;
        for (const page of candidates) {
          if (showsQueuedWrite(write, page)) {
            expect(covered(page), `${page} shows ${write}`).toBe(true);
          }
        }
      }
    });

    it('lists only pages that render a queueable control', async () => {
      // The laundry draws its control only while something needs a wash.
      const worn = await t.inject({
        method: 'POST',
        url: `/wardrobe/${closet[0]}/wear`,
        headers: { cookie: t.owner.cookie },
        payload: { worn: '1' },
      });
      expect(worn.statusCode).toBeLessThan(400);
      for (const [path, as] of [
        [LAUNDRY_PAGE, t.owner.cookie],
        [`/trips/${tripIds.sooner}`, cookie],
      ]) {
        expect(isQueueablePage(path)).toBe(true);
        const res = await t.inject({
          method: 'GET',
          url: path,
          headers: { cookie: as },
        });
        expect(res.statusCode).toBe(200);
        expect(unescapeHtml(res.body), path).toContain('data-offline-queue');
      }
    });
  });
});
