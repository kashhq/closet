import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  userIdOf,
} from './harness';
import { HX_FRAGMENT } from './pages';

/**
 * What each Styling request costs in statements (#163): production pays a
 * round trip per statement (#156), so the count is the latency. Each
 * request's first statement is the session's user, which reads a shared
 * wardrobe's share with it (#170). After it: one statement for a page
 * without "Style this", for "Add row" and for a refused Save's page
 * (stripsReads); two for "Style this" and Shuffle, whose windows must
 * reach the idea the first one drew (ideaReads, then stripsReads). The
 * behaviour of each route is styling.spec.ts's and outfit-saves.spec.ts's;
 * this one pins the statements, and that the windows still reach a chosen
 * garment deep in its strip now that the choice is judged in SQL. Include
 * picks (`?picks=1`, #335) ride in stripsReads' statement: the same
 * counts. Their behaviour is styling-picks.spec.ts's.
 */

/** Tables only the wardrobe's owner may read through Styling: their wears, outfits, clashes and rules. */
const OWNERS_RECORDS = [
  '"garment_wear"',
  '"outfit_slot"',
  '"generator_avoid"',
  '"outfit_rule"',
];

describe('Styling statements (#163)', () => {
  let t: TestApp;
  let ownerId: number;
  let viewer: string;
  /** Tops, oldest first: 13, so the oldest is past a strip's first window. */
  let tops: number[];
  let bottom: number;
  let shoes: number;
  let capsuleId: number;
  let outfitId: number;
  /** A wishlist item: Include picks' garment. */
  let candidate: number;

  const form = (payload: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      for (const one of [value].flat()) body.append(key, one);
    }
    return {
      payload: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
  };

  const get = (url: string, cookie?: string) =>
    t.inject({
      method: 'GET',
      url,
      headers: {
        ...(url.includes('/styling/') ? HX_FRAGMENT : {}),
        ...(cookie ? { cookie } : {}),
      },
    });

  const garmentIn = async (name: string, category: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({ name, category, props: '1', formality: '2', color: 'blue' }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  /** The rows' fields as Shuffle and "Add row" send them. */
  const rowsQuery = (
    rows: [role: string, garmentId: number | null, locked: boolean][],
    extra: Record<string, string> = {},
  ) => {
    const query = new URLSearchParams(extra);
    for (const [role, garmentId, locked] of rows) {
      query.append('role', role);
      query.append('garmentId', garmentId === null ? '' : String(garmentId));
      query.append('lock', locked ? '1' : '');
    }
    return query.toString();
  };

  /** The garment ids a row's strip shows. */
  const stripOf = (html: string, role: string): number[] => {
    const start = html.indexOf(`data-styling-row="${role}"`);
    expect(start, `a ${role} row`).toBeGreaterThan(-1);
    const end = html.indexOf('data-styling-row="', start + 1);
    return [
      ...html
        .slice(start, end === -1 ? undefined : end)
        .matchAll(/data-snap-value="(\d+)"/g),
    ].map((m) => Number(m[1]));
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    tops = [];
    for (let i = 0; i < 13; i++) tops.push(await garmentIn(`Tee ${i}`, 'tops'));
    bottom = await garmentIn('Jeans', 'bottoms');
    shoes = await garmentIn('Boots', 'footwear');
    const capsule = await t.inject({
      method: 'POST',
      url: '/capsules',
      ...form({ name: 'Weekend', notes: '' }),
    });
    capsuleId = Number(
      /^\/capsules\/(\d+)/.exec(String(capsule.headers.location))![1],
    );
    const saved = await t.inject({
      method: 'POST',
      url: '/styling',
      ...form({
        role: ['top', 'bottom'],
        garmentId: [String(tops[0]), String(bottom)],
        lock: ['', ''],
        name: 'Oldest tee',
      }),
    });
    expect(saved.statusCode).toBe(303);
    outfitId = Number(
      /^\/outfits\/(\d+)/.exec(String(saved.headers.location))![1],
    );

    candidate = await t
      .inject({
        method: 'POST',
        url: '/wardrobe',
        ...form({
          name: 'Linen shirt',
          category: 'tops',
          to: 'wishlist',
          wishlist: '1',
          replaces: '',
          props: '1',
          product: '1',
        }),
      })
      .then((res) => {
        expect(res.statusCode).toBe(302);
        return Number(
          /^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1],
        );
      });

    viewer = await t.register('viewer-statements@example.com');
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    const accepted = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      payload: {},
      headers: { cookie: viewer },
    });
    expect(accepted.statusCode).toBeLessThan(400);
  });

  afterAll(() => t?.cleanup());

  /** `url`'s statements, after a first request warmed it; each answered 200. */
  const statementsOf = async (url: string, cookie?: string) => {
    expect((await get(url, cookie)).statusCode).toBe(200);
    return recordQueries(async () => {
      expect((await get(url, cookie)).statusCode).toBe(200);
    });
  };

  describe('GET /styling', () => {
    it('the fresh stack: the session, then the windows and the capsule menu in one', async () => {
      const record = await statementsOf('/styling');
      expect(record.statements).toBe(2);
      expect(record.sql[1]).toContain('row_number()');
      expect(record.sql[1]).toContain('"capsule"');
    });

    it('?capsule= is checked in that statement, and still a 404 outside the wardrobe', async () => {
      expect(
        (await statementsOf(`/styling?capsule=${capsuleId}`)).statements,
      ).toBe(2);
      const refused = await recordQueries(() =>
        get(`/styling?capsule=${capsuleId + 1000}`),
      );
      expect(refused.statements).toBe(2);
      expect(
        (await get(`/styling?capsule=${capsuleId + 1000}`)).statusCode,
      ).toBe(404);
    });

    it('?outfit= opens on the outfit in that statement, its oldest garment on its strip', async () => {
      const record = await statementsOf(`/styling?outfit=${outfitId}`);
      expect(record.statements).toBe(2);
      const page = (await get(`/styling?outfit=${outfitId}`)).body;
      // Thirteen tops, newest first: the oldest is the 13th, past the first
      // window of 10, and the strip reaches it with the 10 before it (#996).
      expect(stripOf(page, 'top')).toEqual(tops.slice(0, 11).reverse());
      expect((await get('/styling?outfit=999999')).statusCode).toBe(404);
    });

    it('?with= ("Style this"): the idea with the garment checked in it, then the windows', async () => {
      const record = await statementsOf(`/styling?with=${tops[0]}`);
      expect(record.statements).toBe(3);
      expect(record.sql[1]).toContain('"generator_avoid"');
      expect(record.sql[1]).toContain('"outfit_rule"');
      const page = (await get(`/styling?with=${tops[0]}`)).body;
      expect(stripOf(page, 'top')).toContain(tops[0]);
      expect((await get(`/styling?with=${bottom + 1000}`)).statusCode).toBe(
        404,
      );
    });

    it('?picks=1: the picks ride in that statement', async () => {
      const record = await statementsOf('/styling?picks=1');
      expect(record.statements).toBe(2);
      expect(record.sql[1]).toContain('row_number()');
      expect(record.sql[1]).toContain('"option_group"');
      expect(stripOf((await get('/styling?picks=1')).body, 'top')[0]).toBe(
        candidate,
      );
    });

    it('a shared wardrobe ignores ?picks=1: no pick read in its statements', async () => {
      const record = await statementsOf(
        `/styling?ownerId=${ownerId}&picks=1`,
        viewer,
      );
      expect(record.statements).toBe(2);
      expect(record.sql.join('\n')).not.toContain('"option_group"');
    });

    it('a shared wardrobe: the session with the share, then one statement, and none of the owner’s records', async () => {
      const record = await statementsOf(`/styling?ownerId=${ownerId}`, viewer);
      expect(record.statements).toBe(2);
      expect(record.sql[0]).toContain('"wardrobe_share"');
      const styled = await statementsOf(
        `/styling?ownerId=${ownerId}&with=${tops[0]}`,
        viewer,
      );
      expect(styled.statements).toBe(3);
      const all = [...record.sql, ...styled.sql].join('\n');
      for (const table of OWNERS_RECORDS) expect(all).not.toContain(table);
    });
  });

  describe('the rows’ fragments', () => {
    it('Shuffle: the idea with the posted rows checked in it, then the windows', async () => {
      const query = rowsQuery(
        [
          ['top', tops[0], true],
          ['bottom', null, false],
          ['footwear', null, false],
        ],
        { seed: '5' },
      );
      const record = await statementsOf(`/styling/shuffle?${query}`);
      expect(record.statements).toBe(3);
      const rows = (await get(`/styling/shuffle?${query}`)).body;
      // The locked oldest tee stays chosen, and its strip reaches it.
      expect(rows).toContain(`name="garmentId" value="${tops[0]}"`);
      expect(stripOf(rows, 'top')).toContain(tops[0]);
    });

    it('Shuffle over a shared wardrobe: the session with the share, then two, none of the owner’s records', async () => {
      const query = rowsQuery(
        [
          ['top', tops[0], true],
          ['bottom', null, false],
        ],
        { ownerId: String(ownerId), seed: '5' },
      );
      const record = await statementsOf(`/styling/shuffle?${query}`, viewer);
      expect(record.statements).toBe(3);
      const all = record.sql.join('\n');
      for (const table of OWNERS_RECORDS) expect(all).not.toContain(table);
    });

    it('Shuffle and "Add row" with ?picks=1: the same counts', async () => {
      const query = rowsQuery([['top', candidate, false]], {
        picks: '1',
        seed: '5',
      });
      expect((await statementsOf(`/styling/shuffle?${query}`)).statements).toBe(
        3,
      );
      const row = rowsQuery([['top', candidate, false]], {
        picks: '1',
        add: 'footwear',
      });
      expect((await statementsOf(`/styling/row?${row}`)).statements).toBe(2);
    });

    it('"Add row": one statement, its strips reaching each posted garment in its own role', async () => {
      const query = rowsQuery(
        [
          ['top', tops[0], false],
          ['bottom', bottom, false],
        ],
        { add: 'footwear' },
      );
      const record = await statementsOf(`/styling/row?${query}`);
      expect(record.statements).toBe(2);
      const rows = (await get(`/styling/row?${query}`)).body;
      expect(stripOf(rows, 'top')).toEqual(tops.slice(0, 11).reverse());
      // A garment posted in another role's row is dropped from it, and its
      // own strip is not stretched to reach it.
      const misplaced = rowsQuery([['bottom', tops[0], false]]);
      const moved = (await get(`/styling/row?${misplaced}`)).body;
      expect(moved).not.toContain(`name="garmentId" value="${tops[0]}"`);
      expect(stripOf(moved, 'top')).toEqual(tops.slice(-10).reverse());
    });

    it('a strip’s next page: one statement', async () => {
      const record = await statementsOf(
        `/styling/garments?role=top&before=${tops[5]}`,
      );
      expect(record.statements).toBe(2);
    });
  });

  describe('POST /styling (Save)', () => {
    const save = (garmentIds: number[], fields: Record<string, string> = {}) =>
      t.inject({
        method: 'POST',
        url: '/styling',
        ...form({
          ...fields,
          role: garmentIds.map((id) => (id === shoes ? 'footwear' : 'top')),
          garmentId: garmentIds.map(String),
          lock: garmentIds.map(() => ''),
        }),
      });

    it('a refused Save answers its page in one statement after the refusal', async () => {
      const archived = await garmentIn('Old tee', 'tops');
      const gone = await t.inject({
        method: 'POST',
        url: `/wardrobe/${archived}/archive`,
      });
      expect(gone.statusCode).toBeLessThan(400);
      const record = await recordQueries(async () => {
        const res = await save([archived, shoes], {
          capsule: String(capsuleId),
        });
        expect(res.statusCode).toBe(409);
        expect(res.body).toContain('data-styling-refused');
      });
      // The session, the pick's transaction (begin, the owner lock, the
      // garments, commit), the refusal's names (goneGarments), then the
      // page in one.
      expect(record.statements).toBe(7);
      expect(record.sql.lastIndexOf('commit')).toBe(4);
      expect(record.sql[6]).toContain('row_number()');
    });
  });
});
