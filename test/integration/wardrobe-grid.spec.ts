import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capsule,
  capsuleGarment,
  file,
  garment,
  wardrobeShare,
} from '../../src/db/schema';
import { rankedIdCursor } from '../../src/web/api/resource';
import { GRID_PAGE_SIZE } from '../../src/web/wardrobe/grid-page-size';
import { deviceToken } from './api';
import { HX_FRAGMENT } from './pages';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  asFixture,
  userIdOf,
} from './harness';

/**
 * The wardrobe grid in pages: GET /wardrobe renders the newest
 * GRID_PAGE_SIZE garments and a sentinel that, scrolled into view, fetches
 * GET /wardrobe/tiles?before=<last id> with the same filters (keyset
 * pagination: a page costs the same however deep it is). Filtering and
 * searching start again from the first page.
 */
describe('wardrobe grid', () => {
  let t: TestApp;
  /** Ids of the seeded garments, newest first. */
  let ids: number[];
  const TOTAL = GRID_PAGE_SIZE + 12;

  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await t.inject({ method: 'GET', url, headers });
    expect(res.statusCode).toBe(200);
    return { ...res, html: unescapeHtml(res.body) };
  };

  /** Garment ids of the tiles, in page order. */
  const tileIds = (html: string) =>
    [...html.matchAll(/<a href="\/wardrobe\/(\d+)"[^>]*data-tile=""/g)].map(
      (m) => Number(m[1]),
    );

  const sentinelUrl = (html: string) =>
    /hx-get="(\/wardrobe\/tiles\?[^"]+)"[^>]*hx-trigger="revealed"/.exec(
      html,
    )?.[1];

  beforeAll(async () => {
    t = await createTestApp();
    // Straight into the tables: the grid reads rows, and this many uploads
    // would only slow the spec. Every other garment has a photo row.
    const rows: (typeof garment.$inferInsert)[] = [];
    for (let i = 0; i < TOTAL; i++) {
      let photoId: number | null = null;
      if (i % 2 === 0) {
        const [photo] = await asFixture(t.db, (tx) =>
          tx
            .insert(file)
            .values({
              fileName: `${randomUUID()}.webp`,
              createdOn: new Date().toISOString(),
              createdById: t.owner.id,
            })
            .returning({ id: file.id }),
        );
        photoId = photo.id;
      }
      rows.push({
        shareableId: randomUUID(),
        ownerId: t.owner.id,
        name: i === 3 ? 'Sale 100% wool_coat' : `Garment ${i}`,
        // Found by "garment" through its notes alone: ranked after the rest.
        notes: i === 3 ? 'A garment for the sales' : null,
        category: i % 3 === 0 ? 'tops' : 'bottoms',
        photoId,
      });
    }
    const inserted = await asFixture(t.db, (tx) =>
      tx.insert(garment).values(rows).returning({ id: garment.id }),
    );
    ids = inserted.map((row) => row.id).reverse();
  });

  afterAll(() => t?.cleanup());

  it('renders the first page, newest first, the count of all, and a sentinel for the rest', async () => {
    const { html } = await get('/wardrobe');
    expect(tileIds(html)).toEqual(ids.slice(0, GRID_PAGE_SIZE));
    expect(html).toContain(`${TOTAL} results`);
    expect(sentinelUrl(html)).toBe(
      `/wardrobe/tiles?before=${ids[GRID_PAGE_SIZE - 1]}`,
    );
  });

  it('serves the next page as tiles alone, ending without a sentinel', async () => {
    const first = await get('/wardrobe');
    const next = await get(sentinelUrl(first.html)!, HX_FRAGMENT);
    expect(next.body).not.toContain('<main');
    expect(next.body).not.toContain('<html');
    expect(tileIds(next.html)).toEqual(ids.slice(GRID_PAGE_SIZE));
    expect(sentinelUrl(next.html)).toBeUndefined();
    // Later pages are below the fold: every image loads lazily.
    const images = next.html.match(/<img\b[^>]*>/g) ?? [];
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(img).toContain('loading="lazy"');
  });

  it('carries the filters into the sentinel, and pages within them', async () => {
    const tops = ids.filter((_, i) => (TOTAL - 1 - i) % 3 === 0);
    expect(tops.length).toBeLessThan(GRID_PAGE_SIZE);
    const { html } = await get('/wardrobe?category=Tops');
    expect(tileIds(html)).toEqual(tops);
    expect(html).toContain(`${tops.length} results`);
    expect(sentinelUrl(html)).toBeUndefined();

    const deep = await get(
      `/wardrobe/tiles?category=tops&before=${tops[5]}`,
      HX_FRAGMENT,
    );
    expect(tileIds(deep.html)).toEqual(tops.slice(6));
  });

  it('a filtered or searched fragment starts from the first page', async () => {
    const notesOnly = ids[TOTAL - 1 - 3];
    const named = ids.filter((id) => id !== notesOnly);
    const res = await get('/wardrobe?keyword=garment', HX_FRAGMENT);
    expect(res.headers.vary).toContain('HX-Request');
    expect(res.body.trimStart()).toMatch(/^<div id="wardrobe-body"/);
    expect(tileIds(res.html)).toEqual(named.slice(0, GRID_PAGE_SIZE));
    expect(sentinelUrl(res.html)).toBe(
      `/wardrobe/tiles?keyword=garment&before=${named[GRID_PAGE_SIZE - 1]}`,
    );
    // The ranked keyset (#673): the next page ends the named matches, then
    // the notes-only one, though its id is newer than the cursor's.
    let next = '';
    const record = await recordQueries(async () => {
      next = (await get(sentinelUrl(res.html)!, HX_FRAGMENT)).html;
    });
    expect(record.statements).toBe(2);
    expect(tileIds(next)).toEqual([...named.slice(GRID_PAGE_SIZE), notesOnly]);
    // A cursor past rank 0 says its rank: only the notes-only matches older
    // than its id follow it.
    const ranked = await get(
      `/wardrobe/tiles?keyword=garment&before=1.${ids[0]}`,
      HX_FRAGMENT,
    );
    expect(tileIds(ranked.html)).toEqual([notesOnly]);
  });

  // The rank travels in the cursor (#784): the cursor's garment edited
  // between pages (now matched by its notes alone) neither moves the keyset
  // nor makes the next page skip a row; it may show that garment again.
  it('a keyword page after its cursor garment changed may repeat, never skip', async () => {
    const notesOnly = ids[TOTAL - 1 - 3];
    const named = ids.filter((id) => id !== notesOnly);
    const first = await get('/wardrobe?keyword=garment', HX_FRAGMENT);
    const cursorId = named[GRID_PAGE_SIZE - 1];
    const [{ name }] = await t.db
      .select({ name: garment.name })
      .from(garment)
      .where(eq(garment.id, cursorId));
    const rename = (values: { name: string | null; notes: string | null }) =>
      asFixture(t.db, (tx) =>
        tx.update(garment).set(values).where(eq(garment.id, cursorId)),
      );
    await rename({ name: 'Renamed', notes: 'Still a garment' });
    try {
      const next = await get(sentinelUrl(first.html)!, HX_FRAGMENT);
      expect(tileIds(next.html)).toEqual([
        ...named.slice(GRID_PAGE_SIZE),
        cursorId,
        notesOnly,
      ]);
    } finally {
      await rename({ name, notes: null });
    }
  });

  // The SQL split is WORD_SPACES, the keyword's own (#789): `[[:space:]]`
  // kept a BOM inside a word and split on a NEL the keyword's `\s` keeps.
  it('splits a stored name on the same spaces as the keyword', async () => {
    const pasted = await asFixture(t.db, (tx) =>
      tx
        .insert(garment)
        .values(
          ['Navy\u00a0blazer', 'Navy\ufeffblazer', 'Navy\u0085blazer'].map(
            (name) => ({
              shareableId: randomUUID(),
              ownerId: t.owner.id,
              name,
              category: 'outerwear',
            }),
          ),
        )
        .returning({ id: garment.id }),
    );
    const pastedIds = pasted.map((row) => row.id);
    try {
      const { html } = await get('/wardrobe?keyword=blazer');
      expect(tileIds(html).sort()).toEqual([...pastedIds].sort());
    } finally {
      await asFixture(t.db, (tx) =>
        tx.delete(garment).where(inArray(garment.id, pastedIds)),
      );
    }
  });

  it.each([
    // Wildcards in the keyword are matched as themselves.
    ['100%', 1],
    ['wool_coat', 1],
    ['%', 1],
    ['_', 1],
    ['\\', 0],
    // And case does not matter.
    ['SALE', 1],
  ])('keyword %j finds %i garment(s)', async (keyword, found) => {
    const { html } = await get(
      `/wardrobe?keyword=${encodeURIComponent(keyword)}`,
    );
    expect(tileIds(html)).toHaveLength(found);
  });

  // Production pays a network round trip per statement (#156), so these
  // counts are the page's latency budget (#159): the session, the page,
  // and one statement for everything around it (gridContext).
  describe('statements per request', () => {
    it('the page: the tiles, and the count, filter values, capsules, prompts and switcher together', async () => {
      const record = await recordQueries(() => get('/wardrobe'));
      expect(record.statements).toBe(3);
      // A page of tiles (and the one that says there are more), and one row
      // for everything else: the lists arrive as JSON inside it.
      expect(record.rows).toBe(1 + (GRID_PAGE_SIZE + 1) + 1);
      const context = record.sql.find((sql) => sql.includes('json_agg'));
      for (const read of ['pending_photo', 'wardrobe_share', 'capsule']) {
        expect(context).toContain(`"${read}"`);
      }
    });

    it('a fragment: the same, without the app bar’s switcher it does not render', async () => {
      const record = await recordQueries(() =>
        get('/wardrobe?keyword=garment', HX_FRAGMENT),
      );
      expect(record.statements).toBe(3);
      expect(record.sql.join('\n')).not.toContain('"wardrobe_share"');
    });

    it('select mode: the tiles and one context statement (the count for "Select all N", the capsules), no filters or prompts', async () => {
      const record = await recordQueries(() => get('/wardrobe?select=1'));
      expect(record.statements).toBe(3);
    });

    it('the next page: the tiles alone', async () => {
      const record = await recordQueries(() =>
        get(`/wardrobe/tiles?before=${ids[GRID_PAGE_SIZE - 1]}`, HX_FRAGMENT),
      );
      expect(record.statements).toBe(2);
    });

    it('the capsule picker: members marked on the tiles, the capsule looked up with the context', async () => {
      const [picked] = await asFixture(t.db, (tx) =>
        tx
          .insert(capsule)
          .values({ ownerId: t.owner.id, name: 'Picked' })
          .returning({ id: capsule.id }),
      );
      await asFixture(t.db, (tx) =>
        tx.insert(capsuleGarment).values(
          [ids[0], ids[2]].map((garmentId) => ({
            capsuleId: picked.id,
            garmentId,
          })),
        ),
      );

      const page = await recordQueries(() =>
        get(`/wardrobe?pick=${picked.id}`),
      );
      expect(page.statements).toBe(3);
      const { html } = await get(`/wardrobe?pick=${picked.id}`);
      const checked = [
        ...html.matchAll(
          /<input[^>]*name="ids"[^>]*value="(\d+)"[^>]*\schecked=""/g,
        ),
      ].map((m) => Number(m[1]));
      expect(checked).toEqual([ids[0], ids[2]]);

      const next = await recordQueries(() =>
        get(
          `/wardrobe/tiles?pick=${picked.id}&before=${ids[GRID_PAGE_SIZE - 1]}`,
          HX_FRAGMENT,
        ),
      );
      expect(next.statements).toBe(2);
    });
  });

  it.each(['abc', '0', '2.5', '1.', '.5', '1.2147483648'])(
    'a malformed cursor (%s) is a 400',
    async (before) => {
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/tiles?keyword=garment&before=${before}`,
        headers: HX_FRAGMENT,
      });
      expect(res.statusCode).toBe(400);
    },
  );

  // A cursor is compared only against the addressed wardrobe's rows (#784):
  // the cursor's rank was once read from the garment its id named, any
  // wardrobe's, so a stranger paging with another user's garment id learnt
  // from the answer whether that garment's private name, brand or notes held
  // the keyword. Now any id answers as an unknown one (`ghost`, a deleted
  // garment's) and a forged rank reorders only the caller's own rows.
  describe('a cursor reads no other row', () => {
    let stranger: { id: number; cookie: string; token: string };
    let probe: number;
    let probeInNotes: number;
    let ghost: number;

    /** Tile ids, a shared wardrobe's (`/wardrobe/<id>?ownerId=`) too. */
    const tilesAs = async (cookie: string, query: string) => {
      const { html } = await get(`/wardrobe/tiles?${query}`, {
        ...HX_FRAGMENT,
        cookie,
      });
      return [
        ...html.matchAll(/<a href="\/wardrobe\/(\d+)[?"][^>]*data-tile=""/g),
      ].map((m) => Number(m[1]));
    };

    beforeAll(async () => {
      const email = 'cursor-stranger@closet.invalid';
      const cookie = await t.register(email);
      const id = await userIdOf(t, email);
      stranger = { id, cookie, token: (await deviceToken(t, { email })).token };
      [{ id: ghost }] = await asFixture(t.db, (tx) =>
        tx
          .insert(garment)
          .values({ shareableId: randomUUID(), ownerId: id, category: 'tops' })
          .returning({ id: garment.id }),
      );
      await asFixture(t.db, (tx) =>
        tx.delete(garment).where(eq(garment.id, ghost)),
      );
      const rows = await asFixture(t.db, (tx) =>
        tx
          .insert(garment)
          .values(
            [
              { name: 'Plain', notes: 'A probe garment, in the notes' },
              { name: 'Probe garment', notes: null },
              { name: 'Café crème', brand: 'J.Crew', notes: null },
            ].map((row) => ({
              ...row,
              shareableId: randomUUID(),
              ownerId: id,
              category: 'tops',
            })),
          )
          .returning({ id: garment.id }),
      );
      [probeInNotes, probe] = rows.map((row) => row.id);
    });

    it("answers another wardrobe's garment id as an unknown one", async () => {
      // ids[0], the owner's "Garment 59", is matched by "garment" and not by
      // "probe": the two ranks the old lookup told apart.
      for (const keyword of ['garment', 'probe']) {
        for (const rank of ['', '1.']) {
          const at = (id: number) =>
            tilesAs(stranger.cookie, `keyword=${keyword}&before=${rank}${id}`);
          const answer = await at(ids[0]);
          expect(answer, `${keyword} ${rank}`).toEqual(await at(ghost));
          // Every own row is newer than both: rank 0 leaves the notes-only
          // match, rank 1 nothing.
          expect(answer).toEqual(rank === '' ? [probeInNotes] : []);
        }
        const api = async (id: number) => {
          const cursor = rankedIdCursor({ rank: 0, id });
          const res = await t.api(stranger.token, {
            method: 'GET',
            url: `/api/v1/garments?keyword=${keyword}&cursor=${cursor}`,
          });
          expect(res.statusCode, res.body).toBe(200);
          return res.json<{ data: { id: number }[] }>().data.map((g) => g.id);
        };
        expect(await api(ids[0])).toEqual([probeInNotes]);
        expect(await api(ghost)).toEqual([probeInNotes]);
      }
    });

    it("pages a shared wardrobe against its owner's rows alone", async () => {
      await asFixture(t.db, (tx) =>
        tx.insert(wardrobeShare).values({
          grantorId: t.owner.id,
          granteeId: stranger.id,
          permission: 'VIEW',
          acceptedAt: new Date(),
          createdAt: new Date(),
        }),
      );
      // The viewer's own garments as the cursor: one named by the keyword,
      // one only in its notes. Each answers as the ghost does: the owner's
      // named matches from the newest (all older than the cursor), never a
      // rank read from the viewer's rows.
      const owner = `ownerId=${t.owner.id}&keyword=garment`;
      const fromGhost = await tilesAs(
        stranger.cookie,
        `${owner}&before=${ghost}`,
      );
      expect(fromGhost).toEqual(
        ids.filter((id) => id !== ids[TOTAL - 1 - 3]).slice(0, GRID_PAGE_SIZE),
      );
      for (const own of [probe, probeInNotes]) {
        expect(
          await tilesAs(stranger.cookie, `${owner}&before=${own}`),
        ).toEqual(fromGhost);
      }
    });

    // One fold on both sides, independent of the database's locale (#784):
    // accented letters stay letters, punctuation drops, case folds.
    it.each(['café', 'CAFÉ', 'crème', 'jcrew', 'J.Crew', 'j.crew'])(
      'finds "Café crème" by J.Crew with %s',
      async (keyword) => {
        const { html } = await get(
          `/wardrobe?keyword=${encodeURIComponent(keyword)}`,
          { ...HX_FRAGMENT, cookie: stranger.cookie },
        );
        expect(html).toContain('Café crème');
      },
    );
  });
});
