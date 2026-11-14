import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import { outfit, outfitSlot } from '../../src/db/schema';
import { OUTFIT_PAGE_SIZE } from '../../src/web/outfits/page-size';
import { deviceToken } from './api';
import { createGarment } from './garments';
import {
  asFixture,
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * The saved-outfit lists a page at a time (#660): the Saved tab, the
 * calendar's plan page and a trip's add page read one page through one
 * keyset reader (outfitPageSql) and fetch the next with their sentinel;
 * list_outfits and GET /api/v1/outfits page alike. Every outfit here has
 * the same name and the same garment, so nothing but the id tells two
 * apart: a keyset on anything less would repeat or skip them.
 */

const OUTFITS = 2 * OUTFIT_PAGE_SIZE;
const SMALL_EMAIL = 'paging-small@example.com';

let t: TestApp;
/** The owner's outfits, newest first. */
let ids: number[];
let tripId: number;
let smallCookie: string;
let smallTripId: number;

type Get = (url: string, cookie?: string) => Promise<string>;

const get: Get = async (url, cookie) => {
  const res = await t.inject({
    method: 'GET',
    url,
    headers: { 'hx-request': 'true', ...(cookie ? { cookie } : {}) },
  });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return unescapeHtml(res.body);
};

/** The next page's address in `html`: its sentinel's hx-get, or undefined on the last page. */
function sentinelOf(html: string, marker: string): string | undefined {
  const tag = new RegExp(`<[a-z]+[^>]*data-${marker}-more[^>]*>`).exec(html);
  if (!tag) return undefined;
  return /hx-get="([^"]+)"/.exec(tag[0])![1];
}

/** Every page of a list from its first page's address: each page's ids. */
async function walk(
  first: string,
  marker: string,
  idsOf: (html: string) => number[],
): Promise<number[][]> {
  const pages: number[][] = [];
  let next: string | undefined = first;
  while (next !== undefined) {
    const html = await get(next);
    pages.push(idsOf(html));
    next = sentinelOf(html, marker);
    expect(pages.length).toBeLessThanOrEqual(OUTFITS);
  }
  return pages;
}

const tileIds = (html: string) =>
  [...html.matchAll(/<a href="\/outfits\/(\d+)"[^>]*data-outfit-id/g)].map(
    (match) => Number(match[1]),
  );

const buttonIds = (html: string) =>
  [...html.matchAll(/name="outfitId" value="(\d+)"/g)].map((match) =>
    Number(match[1]),
  );

/** `count` outfits of `ownerId`, alike but for their id; the ids, newest first. */
async function insertOutfits(
  ownerId: number,
  garmentId: number,
  count: number,
): Promise<number[]> {
  return asFixture(t.db, async (tx) => {
    const rows = await tx
      .insert(outfit)
      .values(
        Array.from({ length: count }, () => ({
          shareableId: randomUUID(),
          ownerId,
          name: 'Same name',
        })),
      )
      .returning({ id: outfit.id });
    await tx.insert(outfitSlot).values(
      rows.map((row) => ({
        outfitId: row.id,
        position: 0,
        category: 'tops',
        garmentId,
      })),
    );
    return rows.map((row) => row.id).reverse();
  });
}

async function newTrip(cookie?: string): Promise<number> {
  const res = await t.inject({
    method: 'POST',
    url: '/trips',
    payload: {
      name: 'Paging trip',
      destination: '',
      startsOn: addDays(t.today(), 3),
      endsOn: addDays(t.today(), 4),
      notes: '',
    },
    headers: cookie ? { cookie } : {},
  });
  expect(res.statusCode).toBe(303);
  return Number(/^\/trips\/(\d+)/.exec(String(res.headers.location))![1]);
}

beforeAll(async () => {
  t = await createTestApp();
  const tee = await createGarment(t, { name: 'Paging tee', category: 'tops' });
  ids = await insertOutfits(t.owner.id, tee, OUTFITS);
  tripId = await newTrip();
  smallCookie = await t.register(SMALL_EMAIL);
  const smallTee = await createGarment(t, {
    name: 'Small tee',
    category: 'tops',
    cookie: smallCookie,
  });
  await insertOutfits(await userIdOf(t, SMALL_EMAIL), smallTee, 2);
  smallTripId = await newTrip(smallCookie);
});

afterAll(() => t?.cleanup());

describe('the saved-outfit lists, a page at a time (#660)', () => {
  const day = () => addDays(t.today(), 2);
  const expected = () => [
    ids.slice(0, OUTFIT_PAGE_SIZE),
    ids.slice(OUTFIT_PAGE_SIZE),
  ];

  it('Saved renders one fixed page and a sentinel; the next arrives by keyset, no duplicates or gaps', async () => {
    const first = await get('/outfits');
    expect(tileIds(first)).toEqual(ids.slice(0, OUTFIT_PAGE_SIZE));
    expect(sentinelOf(first, 'saved')).toBe(
      `/outfits/tiles?before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
    );
    expect(await walk('/outfits', 'saved', tileIds)).toEqual(expected());
  });

  it('Saved picking for a day pages inside its one form, the day and list carried', async () => {
    const pickFor = `for=day:${day()}&occasion=evening`;
    const first = await get(`/outfits?${pickFor}`);
    expect(sentinelOf(first, 'saved')).toBe(
      `/outfits/tiles?${pickFor}&before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
    );
    expect(await walk(`/outfits?${pickFor}`, 'saved', buttonIds)).toEqual(
      expected(),
    );
    // The one-offs' segment pages its own list: none here.
    const oneOffs = await get(`/outfits?${pickFor}&show=one-offs`);
    expect(buttonIds(oneOffs)).toEqual([]);
    expect(sentinelOf(oneOffs, 'saved')).toBeUndefined();
  });

  it('the plan page pages through the same reader', async () => {
    const plan = `/calendar/plan?for=day:${day()}&occasion=work`;
    expect(sentinelOf(await get(plan), 'picker')).toBe(
      `/calendar/plan/more?for=day:${day()}&occasion=work&before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
    );
    expect(await walk(plan, 'picker', buttonIds)).toEqual(expected());
  });

  it('the plan page’s next page still judges the day: an outfit on it is disabled', async () => {
    const onDay = ids[OUTFIT_PAGE_SIZE + 3];
    const planned = await t.inject({
      method: 'POST',
      url: '/calendar',
      payload: { date: day(), outfitId: String(onDay), occasion: 'evening' },
    });
    expect(planned.statusCode).toBe(302);
    const more = await get(
      `/calendar/plan/more?for=day:${day()}&occasion=work&before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
    );
    expect(more).toMatch(
      new RegExp(`name="outfitId" value="${onDay}"[^>]*disabled`),
    );
  });

  it('a trip’s add page pages through the same reader, its day carried', async () => {
    const add = `/trips/${tripId}/outfits/new?day=${addDays(t.today(), 3)}`;
    expect(sentinelOf(await get(add), 'picker')).toBe(
      `/trips/${tripId}/outfits/new/more?day=${addDays(t.today(), 3)}&before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
    );
    expect(await walk(add, 'picker', buttonIds)).toEqual(expected());
  });

  it('a next page past the last outfit is empty and has no sentinel', async () => {
    const last = await get(`/outfits/tiles?before=${ids.at(-1)}`);
    expect(tileIds(last)).toEqual([]);
    expect(sentinelOf(last, 'saved')).toBeUndefined();
  });

  it('a malformed cursor is a 400: only a sentinel builds it', async () => {
    for (const url of [
      '/outfits/tiles?before=abc',
      '/outfits/tiles',
      `/calendar/plan/more?before=0`,
      `/trips/${tripId}/outfits/new/more?before=-1`,
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('list_outfits takes before and limit and pages as GET /api/v1/outfits does', async () => {
    const mcp = await createAccessToken(t);
    const api = (await deviceToken(t)).token;
    const limit = 25;
    const mcpPages: number[][] = [];
    const apiPages: number[][] = [];
    let before: number | null | undefined;
    do {
      const page: { outfits: { id: number }[]; next: number | null } =
        await tool(t, mcp, 'list_outfits', {
          limit,
          ...(before ? { before } : {}),
        });
      mcpPages.push(page.outfits.map((row) => row.id));
      before = page.next;
    } while (before !== null);
    let cursor: string | undefined;
    do {
      const res = await t.api(api, {
        method: 'GET',
        url: `/api/v1/outfits?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{
        data: { id: number }[];
        pagination: { nextCursor?: string };
      }>();
      apiPages.push(page.data.map((row) => row.id));
      cursor = page.pagination.nextCursor;
    } while (cursor !== undefined);
    expect(mcpPages).toEqual([
      ids.slice(0, 25),
      ids.slice(25, 50),
      ids.slice(50),
    ]);
    expect(apiPages).toEqual(mcpPages);
    // Unasked, a page is the Saved tab's.
    const unasked: { outfits: unknown[]; next: number | null } = await tool(
      t,
      mcp,
      'list_outfits',
    );
    expect(unasked.outfits).toHaveLength(OUTFIT_PAGE_SIZE);
    expect(unasked.next).toBe(ids[OUTFIT_PAGE_SIZE - 1]);
  });

  it('each route’s statements do not grow with the outfits: the session, then one', async () => {
    const routes = (trip: number) => [
      '/outfits',
      `/outfits/tiles?before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
      `/calendar/plan?for=day:${day()}&occasion=work`,
      `/calendar/plan/more?for=day:${day()}&occasion=work&before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
      `/trips/${trip}/outfits/new`,
      `/trips/${trip}/outfits/new/more?before=${ids[OUTFIT_PAGE_SIZE - 1]}`,
    ];
    const counts = async (trip: number, cookie?: string) => {
      const result: number[] = [];
      for (const url of routes(trip)) {
        const recorded = await recordQueries(() => get(url, cookie));
        result.push(recorded.statements);
      }
      return result;
    };
    const many = await counts(tripId);
    expect(many).toEqual(routes(tripId).map(() => 2));
    expect(await counts(smallTripId, smallCookie)).toEqual(many);
  });
});
