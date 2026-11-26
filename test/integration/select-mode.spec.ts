import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capsuleGarment, garment } from '../../src/db/schema';
import { GRID_PAGE_SIZE } from '../../src/web/wardrobe/grid-page-size';
import {
  asFixture,
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectNativePostForms, expectNoRawI18nKeys } from './pages';

/**
 * Select mode as one selection several verbs act on (#677): every verb
 * answers back to select mode with what it acted on still checked, "Select
 * all N" acts on every garment of the filters (not only the loaded page),
 * and Archive, Mark washed and Add to capsule each call their writer once.
 * Who may use each verb is the matrix's (authorization-wardrobe.routes.ts).
 */
describe('select mode verbs', () => {
  let t: TestApp;
  let ownerId: number;
  /** Three tops to tag, archive and wash; GRID_PAGE_SIZE + 2 coats for "Select all". */
  let tops: number[];
  let coats: number[];
  let capsuleId: number;

  const post = (url: string, payload: Record<string, unknown>) =>
    t.inject({ method: 'POST', url, payload });
  const get = (url: string) => t.inject({ method: 'GET', url });
  /** A post and the statements it sent (recordQueries). */
  const recordedPost = async (
    url: string,
    payload: Record<string, unknown>,
  ) => {
    let res!: Awaited<ReturnType<typeof post>>;
    const record = await recordQueries(async () => {
      res = await post(url, payload);
    });
    return { res, statements: record.statements };
  };
  const checkedIds = (html: string) =>
    [
      ...unescapeHtml(html).matchAll(/name="ids" value="(\d+)" checked=""/g),
    ].map((match) => Number(match[1]));
  const rows = (garmentIds: number[]) =>
    t.db
      .select()
      .from(garment)
      .where(inArray(garment.id, garmentIds))
      .orderBy(garment.id);

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    const insert = (category: string, count: number, name: string) =>
      asFixture(t.db, (tx) =>
        tx
          .insert(garment)
          .values(
            Array.from({ length: count }, (_, i) => ({
              shareableId: randomUUID(),
              ownerId,
              name: `${name} ${i}`,
              category,
            })),
          )
          .returning({ id: garment.id }),
      );
    coats = (await insert('outerwear', GRID_PAGE_SIZE + 2, 'Coat')).map(
      (row) => row.id,
    );
    tops = (await insert('tops', 3, 'Top')).map((row) => row.id);
    const made = await post('/capsules', { name: 'Office' });
    capsuleId = Number(/^\/capsules\/(\d+)/.exec(made.headers.location!)![1]);
  });

  afterAll(() => t?.cleanup());

  it('keeps the selection across a property, so a second one needs no reselecting', async () => {
    const warmth = await post('/wardrobe/bulk?category=tops', {
      ids: tops,
      property: 'warmth',
      warmth: '2',
    });
    expect(warmth.statusCode).toBe(303);
    const page = await get(warmth.headers.location!);
    expect(page.statusCode).toBe(200);
    expectNoRawI18nKeys(page);
    expectNativePostForms(page);
    // Still select mode, the same three checked, the bar counting them.
    expect(checkedIds(page.body).sort()).toEqual([...tops].sort());
    expect(page.body).toMatch(/id="selected-count"[^>]*>3</);
    expect(page.body).toContain('Set on 3 garments');

    const formality = await post('/wardrobe/bulk?category=tops', {
      ids: checkedIds(page.body),
      property: 'formality',
      formality: '3',
    });
    expect(checkedIds((await get(formality.headers.location!)).body)).toEqual(
      expect.arrayContaining(tops),
    );
    for (const top of await rows(tops)) {
      expect([top.warmth, top.formality]).toEqual([2, 3]);
    }
  });

  it('a filter swap brings the bar exactly when the body has tiles, its Save on the answer’s form', async () => {
    // The fragment GET the scope row's search sends (PageFragment).
    const filter = async (query: string) => {
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe?pick=${capsuleId}&${query}`,
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      // The actions region always rides out of band, so it is never stale.
      expect(html).toMatch(/<div id="wardrobe-actions"[^>]*hx-swap-oob="true"/);
      return html;
    };
    const bar = (html: string) => html.includes('class="action-bar"');
    for (const [query, tiles] of [
      ['keyword=nothing-matches', false],
      ['category=tops', true],
      ['keyword=nothing-matches', false],
    ] as const) {
      const html = await filter(query);
      expect({ query, bar: bar(html) }).toEqual({ query, bar: tiles });
      if (!tiles) {
        expect(html).toMatch(/<div id="wardrobe-actions" hidden=""/);
        continue;
      }
      // Save submits the picker's form in this same answer.
      expect(html).toMatch(/<button type="submit" form="pick-form"/);
      expect(html).toContain('<form id="pick-form"');
    }
  });

  it('offers "Select all N" with the filters’ count, and it acts on every page', async () => {
    const html = (await get('/wardrobe?select=1&category=outerwear')).body;
    expect(html).toContain(`Select all ${coats.length}`);
    // The first page alone holds GRID_PAGE_SIZE tiles.
    expect(html.match(/name="ids"/g)).toHaveLength(GRID_PAGE_SIZE);

    // The post carries the filters and all=1, never the ids.
    const res = await post('/wardrobe/bulk?category=outerwear', {
      all: '1',
      property: 'warmth',
      warmth: '4',
    });
    // Resolved once: the answer carries the ids, never all=1.
    expect(res.headers.location).not.toContain('all=1');
    expect(res.headers.location).toContain('selected=');
    expect((await rows(coats)).map((coat) => coat.warmth)).toEqual(
      coats.map(() => 4),
    );
    // Nothing outside the filters moved.
    expect((await rows(tops)).map((top) => top.warmth)).toEqual([2, 2, 2]);
    // Back with all selected: every tile checked, the bar says N.
    const back = (await get(res.headers.location!)).body;
    expect(checkedIds(back)).toHaveLength(GRID_PAGE_SIZE);
    // The two on the next page ride as carried ids, so the bar says N.
    expect(back.match(/data-carried="true"/g)).toHaveLength(
      coats.length - GRID_PAGE_SIZE,
    );
    expect(back).toMatch(
      new RegExp(`id="selected-count"[^>]*>${coats.length}<`),
    );
    // Later pages arrive checked: the sentinel's tiles carry the selection.
    const tilesUrl = /hx-get="([^"]*\/wardrobe\/tiles[^"]*)"/.exec(
      unescapeHtml(back),
    )![1];
    const tiles = (await get(tilesUrl)).body;
    expect(checkedIds(tiles)).toHaveLength(coats.length - GRID_PAGE_SIZE);
  });

  it('resolves Select all once: a Set… that leaves the filter does not change what the next verb acts on', async () => {
    const all = await post('/wardrobe/bulk?category=outerwear&warmth=4', {
      all: '1',
      property: 'warmth',
      warmth: '5',
    });
    // The coats left ?warmth=4; the kept selection is still all of them.
    expect(all.headers.location).not.toContain('all=1');
    const ids = new URL(all.headers.location!, 'http://x').searchParams
      .get('selected')!
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    expect(ids).toEqual([...coats].sort((a, b) => a - b));

    // The carried selection reaches every verb as ids; none re-runs the filters.
    const washed = await post(
      '/wardrobe/bulk/washed?category=outerwear&warmth=4',
      {
        ids,
      },
    );
    expect(washed.headers.location).toContain(`bulkWashed=${coats.length}`);
    expect(washed.headers.location).not.toContain('all=1');
    const made = await post('/capsules', { name: 'Outerwear' });
    const capsule = await post('/wardrobe/bulk/capsule?warmth=4', {
      ids,
      capsuleId: Number(/^\/capsules\/(\d+)/.exec(made.headers.location!)![1]),
    });
    expect(capsule.headers.location).toContain(`bulkAdded=${coats.length}`);
    expect(capsule.headers.location).not.toContain('all=1');
    const archived = await post('/wardrobe/bulk/archive?category=outerwear', {
      ids,
    });
    expect(archived.headers.location).toContain(`bulkArchived=${coats.length}`);
    expect(archived.headers.location).not.toContain('all=1');
  });

  it('Mark washed with nothing selected writes nothing', async () => {
    const { res, statements } = await recordedPost('/wardrobe/bulk/washed', {
      ids: [],
    });
    expect(res.headers.location).toContain('bulkWashed=0');
    // Only the session.
    expect(statements).toBe(1);
  });

  it('adds the selection to a capsule in one write, keeping it selected', async () => {
    const { res, statements } = await recordedPost(
      '/wardrobe/bulk/capsule?category=tops',
      { ids: tops, capsuleId },
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('bulkAdded=3');
    expect(res.headers.location).toContain('select=1');
    // The session, then setCapsuleMembers' begin, lock, insert, commit (nothing to remove).
    expect(statements).toBe(5);
    const members = await t.db
      .select({ garmentId: capsuleGarment.garmentId })
      .from(capsuleGarment)
      .where(eq(capsuleGarment.capsuleId, capsuleId));
    expect(members.map((row) => row.garmentId).sort()).toEqual(
      [...tops].sort(),
    );
    const toast = (await get(res.headers.location!)).body;
    expect(toast).toContain('3 garments added to the capsule');
  });

  it('marks the selection washed today', async () => {
    const { res, statements } = await recordedPost('/wardrobe/bulk/washed', {
      ids: tops.slice(0, 2),
    });
    expect(res.headers.location).toContain('bulkWashed=2');
    // The session, then markWashed's one statement.
    expect(statements).toBe(2);
    expect((await rows(tops)).map((top) => top.lastWashedOn)).toEqual([
      t.today(),
      t.today(),
      null,
    ]);
  });

  it('archives the selection, which leaves the grid, and comes back with nothing checked', async () => {
    const { res, statements } = await recordedPost(
      '/wardrobe/bulk/archive?category=tops',
      { ids: [tops[0]] },
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(
      '/wardrobe?category=tops&select=1&bulkArchived=1',
    );
    // The session, then setGarmentsStatus: begin, the locked read, the update, commit.
    expect(statements).toBe(5);
    expect((await rows([tops[0]]))[0].status).toBe('archived');
    // An archived garment again is not counted.
    const again = await post('/wardrobe/bulk/archive', { ids: [tops[0]] });
    expect(again.headers.location).toContain('bulkArchived=0');
    const page = (await get(res.headers.location!)).body;
    expect(page).toContain('1 garment archived');
    expect(page).not.toContain(`name="ids" value="${tops[0]}"`);
  });

  it('Select all on the archived view washes only the closet, and the toast counts those', async () => {
    const [kept, shelved] = await asFixture(t.db, (tx) =>
      tx
        .insert(garment)
        .values(
          (['closet', 'archived'] as const).map((status) => ({
            shareableId: randomUUID(),
            ownerId,
            name: `Scarf ${status}`,
            category: 'accessories',
            status,
          })),
        )
        .returning({ id: garment.id }),
    );
    const res = await post(
      '/wardrobe/bulk/washed?category=accessories&archived=true',
      {
        all: '1',
      },
    );
    expect(res.headers.location).toContain('bulkWashed=1');
    expect(res.headers.location).toContain('bulkSkipped=1');
    const toast = (await get(res.headers.location!)).body;
    expect(toast).toContain('1 garment marked washed · 1 archived skipped');
    const [closet, archived] = await rows([kept.id, shelved.id]);
    expect(closet.lastWashedOn).toBe(t.today());
    expect(archived.lastWashedOn).toBeNull();
  });

  // #819: the skipped were every id not washed, so a garment deleted in
  // another tab, or a hand-built post's foreign, wishlist or repeated id,
  // read as "archived skipped".
  it('Mark washed counts as skipped only the archived, never another id it did not wash', async () => {
    await t.register('bulk-wash-stranger@example.com');
    const strangerId = await userIdOf(t, 'bulk-wash-stranger@example.com');
    const made = await asFixture(t.db, (tx) =>
      tx
        .insert(garment)
        .values(
          (
            [
              [ownerId, 'closet'],
              [ownerId, 'archived'],
              [ownerId, 'wishlist'],
              [strangerId, 'closet'],
              [ownerId, 'closet'],
            ] as const
          ).map(([owner, status]) => ({
            shareableId: randomUUID(),
            ownerId: owner,
            name: `Skip ${status}`,
            category: 'tops',
            status,
          })),
        )
        .returning({ id: garment.id }),
    );
    const [kept, shelved, wanted, foreign, deleted] = made.map((row) => row.id);
    await asFixture(t.db, (tx) =>
      tx.delete(garment).where(eq(garment.id, deleted)),
    );
    const res = await post('/wardrobe/bulk/washed', {
      ids: [kept, kept, shelved, wanted, foreign, deleted],
    });
    const flags = new URL(res.headers.location!, 'http://x').searchParams;
    expect(
      ['bulkWashed', 'bulkSkipped', 'bulkWishlist', 'bulkUnseen'].map((flag) =>
        flags.get(flag),
      ),
    ).toEqual(['1', '1', '1', '2']);
    // Each skip by its reason; another's and a deleted id are one count,
    // so nothing tells them apart.
    const toast = unescapeHtml((await get(res.headers.location!)).body);
    expect(toast).toContain(
      '1 garment marked washed · 1 archived skipped · 1 on the wishlist skipped · 2 not found skipped',
    );
    expect(t.logs.ops('garments.washed').at(-1)).toMatchObject({
      asked: 6,
      washed: 1,
      archived: 1,
      wishlist: 1,
      unseen: 2,
    });
    expect(
      (await rows(made.map((row) => row.id))).map((r) => r.lastWashedOn),
    ).toEqual([t.today(), null, null, null]);
  });

  it('pluralizes every toast through i18n', async () => {
    const one = await get('/wardrobe?bulkUpdated=1&bulkSkipped=0');
    expectNoRawI18nKeys(one);
    expect(one.body).toContain('Set on 1 garment');
    expect(one.body).not.toContain('1 garments');
    const washed = (await get('/wardrobe?bulkWashed=1')).body;
    expect(washed).toContain('1 garment marked washed');
  });
});
