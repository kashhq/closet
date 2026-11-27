import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, optionGroup, user, wardrobeShare } from '../../src/db/schema';
import { postedDestination } from '../../src/web/wardrobe/destination';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { createGarment, createWishlistItem, garmentRow } from './garments';
import {
  createTestApp,
  hxLocationPath,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';

/**
 * Muse phase 1B (#333; docs/plans/2026-10-05-muse-suggestions.md, section
 * 4 C, D, F): the Wishlist tab as Muse's inbox, a need's decision screen,
 * a suggestion's page, and every decision over HTTP, each through decide()
 * with its rows asserted. Also "New from Muse" (never in the bare page,
 * doc section 9), the statements each page sends, Today's card, the
 * offline warm list and the export.
 */

describe('the Muse inbox', () => {
  let t: TestApp;
  let ownerId: number;

  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  async function need(name: string, budget: string | null = '100') {
    const [row] = await t.db
      .insert(optionGroup)
      .values({ ownerId, name, budget })
      .returning({ id: optionGroup.id });
    return row.id;
  }

  async function pick(
    name: string,
    groupId: number,
    {
      category = 'tops',
      price = '90',
      brand,
      rank = null,
    }: {
      category?: string;
      price?: string;
      brand?: string;
      rank?: number | null;
    } = {},
  ) {
    const id = await createWishlistItem(t, {
      name,
      category,
      price,
      brand,
      sourceUrl: `https://shop.example/${encodeURIComponent(name)}`,
    });
    const marked = await markSuggestion(t.db, ownerId, id, {
      tokenId: null,
      groupId,
      note: `Muse: ${name} goes with your jeans`,
      rank,
    });
    expect(marked).toBe('marked');
    return id;
  }

  const groupRow = async (id: number) =>
    (await t.db.select().from(optionGroup).where(eq(optionGroup.id, id)))[0];

  /** The order the inbox's sections come in, by their markers. */
  function sectionOrder(html: string): string[] {
    return [...html.matchAll(/data-inbox-section="([a-z-]+)"/g)].map(
      (m) => m[1],
    );
  }

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = t.owner.id;
    await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    await createGarment(t, { name: 'Chinos', category: 'bottoms' });
    await createGarment(t, { name: 'White sneakers', category: 'footwear' });
    await createGarment(t, { name: 'Loafers', category: 'footwear' });
    await createGarment(t, { name: 'White tee', category: 'tops' });
  });

  afterAll(() => t?.cleanup());

  describe('the inbox (D)', () => {
    let blazers: number;
    let navy: number;
    let chosenNeed: number;
    let chosen: number;
    let looking: number;
    let asideNeed: number;
    let asidePick: number;
    let own: number;

    beforeAll(async () => {
      blazers = await need('A navy blazer', '300');
      navy = await pick('Navy blazer', blazers, { category: 'tops' });
      await pick('Navy cap', blazers, { category: 'accessories' });
      asidePick = await pick('Grey blazer', blazers);
      await decide(t.db, ownerId, {
        kind: 'dismiss-pick',
        garmentId: asidePick,
        reason: 'colour',
        note: 'Too grey',
      });
      chosenNeed = await need('Boots');
      chosen = await pick('Chelsea boots', chosenNeed, {
        category: 'footwear',
        brand: 'Blundstone',
      });
      await pick('Desert boots', chosenNeed, { category: 'footwear' });
      await decide(t.db, ownerId, { kind: 'choose', garmentId: chosen });
      looking = await need('A rain jacket');
      asideNeed = await need('A tie');
      await pick('Silk tie', asideNeed, { category: 'accessories' });
      await decide(t.db, ownerId, {
        kind: 'dismiss-group',
        groupId: asideNeed,
        reason: 'not_now',
        note: null,
      });
      own = await createWishlistItem(t, { name: 'My own scarf' });
    });

    it('shows Ready to buy, Muse’s picks, your wishlist, still looking and set aside, in that order', async () => {
      const res = await get('/wardrobe/wishlist');
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      expect(sectionOrder(html)).toEqual([
        'ready',
        'groups',
        'own',
        'still-looking',
        'set-aside',
      ]);
      // Ready to buy: the chosen pick, its need, and Bought it.
      expect(html).toMatch(
        new RegExp(
          `data-ready="${chosen}"[\\s\\S]*Chelsea boots[\\s\\S]*/wardrobe/${chosen}/bought`,
        ),
      );
      // The open need, its open options, never the one set aside.
      expect(html).toContain(`data-need="${blazers}"`);
      expect(html).toContain(`data-option="${navy}"`);
      expect(html).not.toContain(`data-option="${asidePick}"`);
      expect(html).toContain(
        `/wardrobe/wishlist/needs/${blazers}?option=${navy}`,
      );
      // The own item, and the need with no option yet.
      expect(html).toContain(`data-own="${own}"`);
      expect(html).toContain(`data-looking="${looking}"`);
      // Set aside: the need and the pick, each with Undo.
      expect(html).toContain('2 set aside');
      expect(html).toContain(`data-set-aside="need:${asideNeed}"`);
      expect(html).toContain(`data-set-aside="pick:${asidePick}"`);
      expect(html).toContain(`action="/wardrobe/${asidePick}/undo"`);
      expect(html).toContain(
        `action="/wardrobe/wishlist/needs/${asideNeed}/undo"`,
      );
      // A chosen need is no option card, a need set aside neither.
      expect(html).not.toContain(`data-need="${chosenNeed}"`);
      expect(html).not.toContain(`data-need="${asideNeed}"`);
    });

    it('says what each option unlocks once when they all unlock the same, on each when they differ', async () => {
      // Shoes and a scarf: closet bottoms and tops make them differ.
      const differ = await need('Something for autumn');
      await pick('Suede loafers', differ, { category: 'footwear' });
      await pick('Wool scarf', differ, { category: 'accessories' });
      const same = await need('A second white tee');
      await pick('White tee A', same);
      await pick('White tee B', same);
      const html = (await get('/wardrobe/wishlist')).body;
      const chips = (card: string) =>
        [...card.matchAll(/data-unlocks="(\d+)\+?"/g)].map((m) => Number(m[1]));
      const sameCard = html.slice(
        html.indexOf(`data-need="${same}"`),
        html.indexOf('Compare and choose', html.indexOf(`data-need="${same}"`)),
      );
      expect(sameCard).toMatch(/data-unlocks-each="\d+\+?"/);
      expect(chips(sameCard)).toEqual([]);
      const differCard = html.slice(
        html.indexOf(`data-need="${differ}"`),
        html.indexOf(
          'Compare and choose',
          html.indexOf(`data-need="${differ}"`),
        ),
      );
      expect(differCard).not.toContain('data-unlocks-each');
      const counts = chips(differCard);
      expect(counts).toHaveLength(2);
      // Most unlocks first.
      expect(counts[0]).toBeGreaterThan(counts[1]);
      for (const id of [differ, same]) {
        await decide(t.db, ownerId, {
          kind: 'dismiss-group',
          groupId: id,
          reason: 'not_now',
          note: null,
        });
      }
    });

    it('orders options by what they unlock over Muse’s rank, and needs by their best option', async () => {
      // The closet's two bottoms and two pairs of shoes go with a top; a
      // pair of shoes has one top and two bottoms to go with.
      const unlocksOf = (html: string, id: number) =>
        Number(
          new RegExp(
            `data-option="${id}"[\\s\\S]*?data-unlocks="(\\d+)\\+?"`,
          ).exec(html)?.[1],
        );
      const mixed = await need('Something for Fridays');
      const shoes = await pick('Desert boots', mixed, {
        category: 'footwear',
        rank: 1,
      });
      const top = await pick('Linen shirt', mixed, { rank: 2 });
      // Two needs of one option each, the one with fewer made first.
      const fewer = await need('Weekend shoes');
      await pick('Canvas sneakers', fewer, { category: 'footwear' });
      const more = await need('A summer top');
      await pick('Striped tee', more);

      const html = (await get('/wardrobe/wishlist')).body;
      const card = html.slice(html.indexOf(`data-need="${mixed}"`));
      expect(unlocksOf(card, top)).toBeGreaterThan(unlocksOf(card, shoes));
      // The top first, though Muse ranks the shoes first.
      expect(card.indexOf(`data-option="${top}"`)).toBeLessThan(
        card.indexOf(`data-option="${shoes}"`),
      );
      const each = (id: number) =>
        Number(
          new RegExp(
            `data-need="${id}"[\\s\\S]*?data-unlocks-each="(\\d+)\\+?"`,
          ).exec(html)?.[1],
        );
      expect(each(more)).toBeGreaterThan(each(fewer));
      // The need whose option unlocks more first, though made after.
      expect(html.indexOf(`data-need="${more}"`)).toBeLessThan(
        html.indexOf(`data-need="${fewer}"`),
      );
      for (const id of [mixed, fewer, more]) {
        await decide(t.db, ownerId, {
          kind: 'dismiss-group',
          groupId: id,
          reason: 'not_now',
          note: null,
        });
      }
    });

    it('is two statements: the session, and one for every section and the unlocks', async () => {
      const record = await recordQueries(() => get('/wardrobe/wishlist'));
      expect(record.statements).toBe(2);
    });

    it('pages the needs with the Ideas sentinel past ten', async () => {
      const extra: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const id = await need(`Extra need ${index}`);
        extra.push(id);
        await pick(`Extra pick ${index}`, id);
      }
      const html = (await get('/wardrobe/wishlist')).body;
      expect(html.match(/data-need="/g)).toHaveLength(10);
      expect(html).toContain('hx-get="/wardrobe/wishlist/more?page=2"');
      expect(html).toContain('hx-trigger="intersect once"');
      const more = await get('/wardrobe/wishlist/more?page=2');
      expect(more.statusCode).toBe(200);
      expect(more.body).not.toContain('<html');
      expect(more.body.match(/data-need="/g)).toHaveLength(1);
      expect(more.body).not.toContain('data-inbox-more');
      for (const id of extra) {
        await decide(t.db, ownerId, {
          kind: 'dismiss-group',
          groupId: id,
          reason: 'not_now',
          note: null,
        });
      }
    });

    it('shows a grantee Muse’s needs, without unlocks or decisions', async () => {
      await t.register('viewer-inbox@example.com');
      const viewerId = await userIdOf(t, 'viewer-inbox@example.com');
      const cookie = await t.login('viewer-inbox@example.com');
      await t.db.insert(wardrobeShare).values({
        grantorId: ownerId,
        granteeId: viewerId,
        permission: 'VIEW',
        acceptedAt: new Date(),
        createdAt: new Date(),
      });
      const html = (await get(`/wardrobe/wishlist?ownerId=${ownerId}`, cookie))
        .body;
      expect(html).toContain(`data-need="${blazers}"`);
      expect(html).not.toContain('data-unlocks');
      expect(html).not.toContain('/undo"');
      expect(html).not.toContain('/wardrobe/wishlist/seen');
      const page = (
        await get(
          `/wardrobe/wishlist/needs/${blazers}?ownerId=${ownerId}`,
          cookie,
        )
      ).body;
      expect(page).toContain('Navy blazer');
      expect(page).not.toContain('/choose"');
      expect(page).not.toContain('data-unlocks');
    });
  });

  describe('an inbox with only what was set aside', () => {
    it('still lists it under the empty state, to be undone', async () => {
      const cookie = await t.register('aside-only@example.com');
      const asideOwner = await userIdOf(t, 'aside-only@example.com');
      const [row] = await t.db
        .insert(optionGroup)
        .values({ ownerId: asideOwner, name: 'A trench coat' })
        .returning({ id: optionGroup.id });
      expect(
        (
          await decide(t.db, asideOwner, {
            kind: 'dismiss-group',
            groupId: row.id,
            reason: 'not_now',
            note: null,
          })
        ).ok,
      ).toBe(true);
      const html = unescapeHtml((await get('/wardrobe/wishlist', cookie)).body);
      expect(html).toContain('Nothing on the wishlist yet');
      expect(html).toContain(`data-set-aside="need:${row.id}"`);
      expect(html).toContain(
        `action="/wardrobe/wishlist/needs/${row.id}/undo"`,
      );
    });
  });

  describe('New from Muse (doc section 9)', () => {
    const seenAt = async () =>
      (
        await t.db
          .select({ seen: user.suggestionsSeenAt })
          .from(user)
          .where(eq(user.id, ownerId))
      )[0].seen;

    it('leaves the bare page byte for byte the same when the seen POST moves suggestions_seen_at', async () => {
      await t.db
        .update(user)
        .set({ suggestionsSeenAt: null })
        .where(eq(user.id, ownerId));
      const before = (await get('/wardrobe/wishlist')).body;
      expect(before).toContain(
        'hx-post="/wardrobe/wishlist/seen" hx-trigger="load" hx-swap="none"',
      );
      expect(before).not.toContain('data-new-from-muse');

      const seen = await post('/wardrobe/wishlist/seen');
      expect(seen.statusCode).toBe(200);
      expect(seen.body).toContain('data-new-from-muse');
      // The visit did move the marker: from never to the newest pick.
      expect(await seenAt()).not.toBeNull();

      expect((await get('/wardrobe/wishlist')).body).toBe(before);
    });

    it('names in the seen POST’s answer, out of band, only the needs with picks since the last look', async () => {
      // Seen everything: an empty slot.
      await post('/wardrobe/wishlist/seen');
      const none = await post('/wardrobe/wishlist/seen');
      expect(none.body).toContain('id="muse-new"');
      expect(none.body).toContain('hx-swap-oob="true"');
      expect(none.body).not.toContain('data-new-from-muse');

      const jackets = await need('A field jacket');
      const jacket = await pick('Waxed field jacket', jackets);
      const fresh = unescapeHtml((await post('/wardrobe/wishlist/seen')).body);
      expect(fresh).toContain(`/wardrobe/wishlist/needs/${jackets}`);
      expect(fresh).toContain('A field jacket');
      expect(fresh).not.toContain('A navy blazer');
      expect((await seenAt())?.getTime()).toBe(
        (await garmentRow(t, jacket))?.suggestedAt?.getTime(),
      );
    });

    it('is two statements: the session, and the marker’s read and move', async () => {
      const record = await recordQueries(() => post('/wardrobe/wishlist/seen'));
      expect(record.statements).toBe(2);
    });
  });

  describe('decisions over HTTP', () => {
    it('This one resolves the need and sets its other options aside, then Undo restores them', async () => {
      const id = await need('A belt');
      const brown = await pick('Brown belt', id, { category: 'accessories' });
      const black = await pick('Black belt', id, { category: 'accessories' });
      const back = `/wardrobe/wishlist/needs/${id}?option=${brown}`;
      const res = await post(`/wardrobe/${brown}/choose`, { returnTo: back });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${back}&decided=choose`);
      const resolved = await groupRow(id);
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolvedGarmentId).toBe(brown);
      expect((await garmentRow(t, black))?.dismissedReason).toBe(
        'chose_another',
      );
      expect((await garmentRow(t, brown))?.dismissedAt).toBeNull();

      // A second tap is a stale page: 409, nothing written.
      expect((await post(`/wardrobe/${black}/choose`)).statusCode).toBe(409);

      const undo = await post(`/wardrobe/wishlist/needs/${id}/undo`, {
        returnTo: `/wardrobe/wishlist/needs/${id}`,
      });
      expect(undo.statusCode).toBe(303);
      expect(undo.headers.location).toBe(
        `/wardrobe/wishlist/needs/${id}?decided=undo`,
      );
      expect((await groupRow(id)).status).toBe('open');
      expect((await garmentRow(t, black))?.dismissedAt).toBeNull();
    });

    it('Not for me records the reason and the note, and Undo clears them', async () => {
      const id = await need('A cardigan');
      const cardigan = await pick('Shawl cardigan', id);
      const res = await post(`/wardrobe/${cardigan}/dismiss`, {
        reason: 'too_pricey',
        note: '  Wait for a sale  ',
        returnTo: '/wardrobe/wishlist',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/wardrobe/wishlist?decided=dismiss');
      const row = await garmentRow(t, cardigan);
      expect(row?.status).toBe('wishlist');
      expect(row?.dismissedReason).toBe('too_pricey');
      expect(row?.dismissedNote).toBe('Wait for a sale');
      expect(row?.dismissedAt).not.toBeNull();

      expect((await post(`/wardrobe/${cardigan}/undo`)).statusCode).toBe(303);
      const undone = await garmentRow(t, cardigan);
      expect(undone?.dismissedAt).toBeNull();
      expect(undone?.dismissedReason).toBeNull();
      expect(undone?.dismissedNote).toBeNull();
    });

    it('refuses a dismissal without one of the owner’s reasons (400)', async () => {
      const id = await need('A hat');
      const hat = await pick('Felt hat', id, { category: 'accessories' });
      expect((await post(`/wardrobe/${hat}/dismiss`)).statusCode).toBe(400);
      expect(
        (await post(`/wardrobe/${hat}/dismiss`, { reason: 'chose_another' }))
          .statusCode,
      ).toBe(400);
      expect((await garmentRow(t, hat))?.dismissedAt).toBeNull();
    });

    it('Not this need right now sets the need aside with its note, and Undo reopens it', async () => {
      const id = await need('A suit');
      await pick('Grey suit', id);
      const res = await post(`/wardrobe/wishlist/needs/${id}/dismiss`, {
        reason: 'not_now',
        note: 'After the move',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `/wardrobe/wishlist/needs/${id}?decided=dismiss`,
      );
      const row = await groupRow(id);
      expect(row.status).toBe('dismissed');
      expect(row.dismissedReason).toBe('not_now');
      expect(row.ownerNote).toBe('After the move');
      await post(`/wardrobe/wishlist/needs/${id}/undo`);
      expect((await groupRow(id)).status).toBe('open');
    });

    it('comes back only to a page of this site', async () => {
      const id = await need('Gloves');
      const gloves = await pick('Leather gloves', id, {
        category: 'accessories',
      });
      const res = await post(`/wardrobe/${gloves}/choose`, {
        returnTo: '//evil.example/x',
      });
      expect(res.headers.location).toBe(`/wardrobe/${gloves}?decided=choose`);
    });

    it('is a 404 for another owner’s pick or need, writing nothing', async () => {
      const id = await need('A watch');
      const watch = await pick('Field watch', id, { category: 'accessories' });
      await t.register('other-muse@example.com');
      const cookie = await t.login('other-muse@example.com');
      const as = (url: string, payload: Record<string, string> = {}) =>
        t.inject({ method: 'POST', url, payload, headers: { cookie } });
      expect((await as(`/wardrobe/${watch}/choose`)).statusCode).toBe(404);
      expect(
        (
          await as(`/wardrobe/wishlist/needs/${id}/dismiss`, {
            reason: 'style',
          })
        ).statusCode,
      ).toBe(404);
      expect((await groupRow(id)).status).toBe('open');
    });

    it('Bought it on the chosen pick settles the need', async () => {
      const id = await need('A coat');
      const coat = await pick('Camel coat', id, { category: 'outerwear' });
      const other = await pick('Navy coat', id, { category: 'outerwear' });
      await post(`/wardrobe/${coat}/choose`);
      expect((await get(`/wardrobe/${coat}/bought`)).statusCode).toBe(200);
      const res = await post(`/wardrobe/${coat}/bought`, {
        acquiredOn: t.today(),
        price: '250',
      });
      expect(res.statusCode).toBe(303);
      expect((await garmentRow(t, coat))?.status).toBe('closet');
      expect((await groupRow(id)).resolvedGarmentId).toBe(coat);
      expect((await garmentRow(t, other))?.dismissedReason).toBe(
        'chose_another',
      );

      // Returned it: archived, set aside `returned`, the need open again.
      const returned = await post(`/wardrobe/${coat}/returned`);
      expect(returned.statusCode).toBe(200);
      expect(hxLocationPath(returned)).toBe(
        `/wardrobe/${coat}?decided=returned`,
      );
      const row = await garmentRow(t, coat);
      expect(row?.status).toBe('archived');
      expect(row?.dismissedReason).toBe('returned');
      expect((await groupRow(id)).status).toBe('open');
      // A second Returned is a stale page.
      expect((await post(`/wardrobe/${coat}/returned`)).statusCode).toBe(409);
    });

    it('Bought a different one prefills the closet form from the best pick and settles the need with the new garment', async () => {
      const id = await need('White sneakers');
      const sneaker = await pick('Court sneaker', id, {
        category: 'footwear',
        brand: 'Veja',
      });
      const form = await get(`/wardrobe/new?forNeed=${id}`);
      expect(form.statusCode).toBe(200);
      const html = unescapeHtml(form.body);
      expect(html).toContain('id="garment-bought-for"');
      expect(html).toContain('name="forNeed" value="' + id + '"');
      expect(html).toContain('value="Veja"');

      const res = await post('/wardrobe', {
        name: 'Common Projects',
        category: 'footwear',
        forNeed: String(id),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/\?decided=boughtFor$/);
      const newId = Number(
        /\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1],
      );
      expect((await garmentRow(t, newId))?.status).toBe('closet');
      const row = await groupRow(id);
      expect(row.status).toBe('resolved');
      expect(row.resolvedGarmentId).toBe(newId);
      expect((await garmentRow(t, sneaker))?.dismissedReason).toBe(
        'chose_another',
      );

      // The need is settled: its form and its post are a 404, nothing stored.
      expect((await get(`/wardrobe/new?forNeed=${id}`)).statusCode).toBe(404);
      const count = await t.db.$count(garment);
      expect(
        (
          await post('/wardrobe', {
            name: 'Again',
            category: 'footwear',
            forNeed: String(id),
          })
        ).statusCode,
      ).toBe(404);
      expect(await t.db.$count(garment)).toBe(count);
    });
  });

  // Production pays a round trip a statement (#156). A decision is the
  // session, then decide's transaction: begin, the owner lock, its one
  // read, its one write, commit. Returned adds the archive's status change
  // (setGarmentStatus: a savepoint, the row locked, the update, released);
  // Bought a different one adds the need's check before anything is
  // stored, the garment's insert, and decide in a savepoint inside it.
  describe('statements per decision', () => {
    const counted = async (work: () => Promise<{ statusCode: number }>) => {
      const record = await recordQueries(async () => {
        const res = await work();
        expect(res.statusCode).toBeLessThan(400);
      });
      return record.statements;
    };

    it('pins This one, Not for me, Undo, a need’s Not for me and Undo, Returned and Bought a different one', async () => {
      const id = await need('A cap');
      const first = await pick('Wool cap', id, { category: 'accessories' });
      const second = await pick('Cotton cap', id, { category: 'accessories' });
      const statements: Record<string, number> = {
        dismiss: await counted(() =>
          post(`/wardrobe/${second}/dismiss`, { reason: 'colour' }),
        ),
        undo: await counted(() => post(`/wardrobe/${second}/undo`)),
        choose: await counted(() => post(`/wardrobe/${first}/choose`)),
        undoNeed: await counted(() =>
          post(`/wardrobe/wishlist/needs/${id}/undo`),
        ),
        dismissNeed: await counted(() =>
          post(`/wardrobe/wishlist/needs/${id}/dismiss`, { reason: 'not_now' }),
        ),
      };
      await post(`/wardrobe/wishlist/needs/${id}/undo`);
      statements.boughtDifferent = await counted(() =>
        post('/wardrobe', {
          name: 'Tweed cap',
          category: 'accessories',
          forNeed: String(id),
        }),
      );
      const returnable = await need('A beanie');
      const beanie = await pick('Ribbed beanie', returnable, {
        category: 'accessories',
      });
      await post(`/wardrobe/${beanie}/bought`, { acquiredOn: t.today() });
      statements.returned = await counted(() =>
        post(`/wardrobe/${beanie}/returned`),
      );
      expect(statements).toEqual({
        dismiss: 6,
        undo: 6,
        choose: 6,
        undoNeed: 6,
        dismissNeed: 6,
        boughtDifferent: 10,
        returned: 10,
      });
    });
  });

  describe('Bought a different one on a chosen need', () => {
    it('is offered beside Bought it, and settles the need, setting the chosen pick aside', async () => {
      const id = await need('A weekend bag');
      const chosen = await pick('Canvas holdall', id, { category: 'bags' });
      await post(`/wardrobe/${chosen}/choose`);
      const page = unescapeHtml(
        (await get(`/wardrobe/wishlist/needs/${id}`)).body,
      );
      const card = page.slice(page.indexOf(`data-option="${chosen}"`));
      expect(card).toMatch(
        new RegExp(
          `/wardrobe/${chosen}/bought"[\\s\\S]*?/wardrobe/new\\?forNeed=${id}"`,
        ),
      );
      // Prefilled from the chosen pick.
      const form = await get(`/wardrobe/new?forNeed=${id}`);
      expect(form.statusCode).toBe(200);
      expect(unescapeHtml(form.body)).toContain('value="bags"');

      const res = await post('/wardrobe', {
        name: 'Leather holdall',
        category: 'bags',
        forNeed: String(id),
      });
      expect(res.statusCode).toBe(302);
      const bought = Number(
        /\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1],
      );
      expect((await groupRow(id)).resolvedGarmentId).toBe(bought);
      expect((await garmentRow(t, chosen))?.dismissedReason).toBe(
        'chose_another',
      );
    });

    it('keeps the different one as the answer when a set-aside sibling is bought after it', async () => {
      const id = await need('A rain hat');
      const sibling = await pick('Waxed rain hat', id, {
        category: 'accessories',
      });
      const res = await post('/wardrobe', {
        name: 'Bucket hat',
        category: 'accessories',
        forNeed: String(id),
      });
      const different = Number(
        /\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1],
      );
      expect((await garmentRow(t, sibling))?.dismissedReason).toBe(
        'chose_another',
      );
      const bought = await post(`/wardrobe/${sibling}/bought`, {
        acquiredOn: t.today(),
        price: '60',
      });
      expect(bought.statusCode).toBe(303);
      const row = await garmentRow(t, sibling);
      expect(row?.status).toBe('closet');
      expect(row?.dismissedAt).toBeNull();
      const group = await groupRow(id);
      expect(group.status).toBe('resolved');
      expect(group.resolvedGarmentId).toBe(different);
    });

    it('settles a need once when two phones post a different one together: one garment, the other a 409', async () => {
      const id = await need('A belt bag');
      await pick('Nylon belt bag', id, { category: 'bags' });
      const before = await t.db.$count(garment);
      const [a, b] = await Promise.all(
        ['Sling bag', 'Waist pack'].map((name) =>
          post('/wardrobe', { name, category: 'bags', forNeed: String(id) }),
        ),
      );
      // The loser is refused before anything is stored (404: settled by
      // the time it looked) or by decide under the owner lock (409).
      const [won, lost] = [a.statusCode, b.statusCode].sort();
      expect(won).toBe(302);
      expect([404, 409]).toContain(lost);
      // The refused one rolled back with its garment.
      expect(await t.db.$count(garment)).toBe(before + 1);
      const settled = await groupRow(id);
      const [winner] = [a, b].filter((res) => res.statusCode === 302);
      expect(String(winner.headers.location)).toContain(
        `/wardrobe/${settled.resolvedGarmentId}?`,
      );
    });

    // The race above lands on either refusal; this is its 409 every run,
    // so the branch's coverage does not ride on the scheduler.
    it('refuses a need settled between its check and the save with a 409, the winner kept', async () => {
      const id = await need('A card holder');
      await pick('Slim card holder', id, { category: 'bags' });
      const [first, second] = await Promise.all(
        ['Leather card holder', 'Canvas card holder'].map((name) =>
          createGarment(t, { name, category: 'bags' }),
        ),
      );
      const { withGarment } = await postedDestination(
        t.db,
        { to: 'closet', forNeed: id },
        { ownerId, role: 'OWN', isOwner: true, canView: true, canManage: true },
      );
      // Settled on another phone after the check.
      expect(
        await decide(t.db, ownerId, {
          kind: 'bought',
          garmentId: first,
          groupId: id,
        }),
      ).toMatchObject({ ok: true });
      await expect(
        t.db.transaction((tx) => withGarment!(tx, second)),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await groupRow(id)).resolvedGarmentId).toBe(first);
    });

    it('takes one of two different ones decided at once, under the owner lock', async () => {
      const id = await need('A tote');
      await pick('Canvas tote', id, { category: 'bags' });
      const [first, second] = await Promise.all(
        ['Leather tote', 'Nylon tote'].map((name) =>
          createGarment(t, { name, category: 'bags' }),
        ),
      );
      const outcomes = await Promise.all(
        [first, second].map((garmentId) =>
          decide(t.db, ownerId, { kind: 'bought', garmentId, groupId: id }),
        ),
      );
      expect(outcomes.map((o) => o.ok).sort()).toEqual([false, true]);
      expect(outcomes.find((o) => !o.ok)).toEqual({
        ok: false,
        reason: 'not-allowed',
      });
      const settled = await groupRow(id);
      expect([first, second]).toContain(settled.resolvedGarmentId);
    });
  });

  describe('the decision screen (C)', () => {
    let id: number;
    let first: number;
    let second: number;

    beforeAll(async () => {
      id = await need('A navy jumper', '120');
      first = await pick('Merino jumper', id, {
        price: '110',
        brand: 'Uniqlo',
      });
      second = await pick('Cashmere jumper', id, { price: '180' });
    });

    it('shows each option with its price against the budget, unlocks, This one and Not for me in place', async () => {
      const res = await get(`/wardrobe/wishlist/needs/${id}?option=${second}`);
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      expect(html).toContain('data-need-options');
      expect(html).toContain(`data-option="${first}"`);
      expect(html).toContain(`data-option="${second}"`);
      expect(html).toContain('data-budget="within"');
      expect(html).toContain('data-budget="over"');
      expect(html).toMatch(/data-unlocks(-each)?="\d+\+?"/);
      expect(html).toContain(`action="/wardrobe/${first}/choose"`);
      expect(html).toContain(`action="/wardrobe/${second}/dismiss"`);
      expect(html).toContain('value="too_pricey"');
      // The tapped option is the one centred.
      expect(html).toMatch(
        new RegExp(`data-snap-value="${second}"[^>]*data-selected=""`),
      );
      expect(html).toContain(`action="/wardrobe/wishlist/needs/${id}/dismiss"`);
      expect(html).toContain(`/wardrobe/new?forNeed=${id}`);
    });

    it('is two statements: the session, and the need with its options judged', async () => {
      const record = await recordQueries(() =>
        get(`/wardrobe/wishlist/needs/${id}`),
      );
      expect(record.statements).toBe(2);
    });

    it('a chosen need shows its pick with Bought it and Undo choice', async () => {
      await post(`/wardrobe/${first}/choose`);
      const html = (await get(`/wardrobe/wishlist/needs/${id}`)).body;
      expect(html).toContain('data-need-state="chosen"');
      expect(html).toContain(`/wardrobe/${first}/bought`);
      expect(html).toContain(`action="/wardrobe/wishlist/needs/${id}/undo"`);
      expect(html).not.toContain(`action="/wardrobe/${second}/choose"`);
      await post(`/wardrobe/wishlist/needs/${id}/undo`);
    });

    it('is a 404 for an unknown need', async () => {
      expect((await get('/wardrobe/wishlist/needs/999999')).statusCode).toBe(
        404,
      );
    });
  });

  describe('a suggestion’s page (F)', () => {
    let id: number;
    let first: number;
    let second: number;

    beforeAll(async () => {
      id = await need('A rain coat', '200');
      first = await pick('Mac coat', id, {
        category: 'outerwear',
        price: '180',
      });
      second = await pick('Parka', id, { category: 'outerwear', price: '220' });
    });

    it('says it is Muse’s, links its need, and offers This one as the primary, never Remove', async () => {
      const html = unescapeHtml((await get(`/wardrobe/${first}`)).body);
      expect(html).toContain('data-suggestion-state="open"');
      expect(html).toContain('From your agent');
      expect(html).toContain(`href="/wardrobe/wishlist/needs/${id}"`);
      expect(html).toContain('Muse: Mac coat goes with your jeans');
      expect(html).toContain(`action="/wardrobe/${first}/choose"`);
      expect(html).toContain('data-other-options');
      expect(html).toContain(`href="/wardrobe/${second}"`);
      expect(html).not.toContain('hx-delete=');
      // Back goes to the need's screen.
      expect(html).toContain(
        `href="/wardrobe/wishlist/needs/${id}" class="btn btn-ghost btn-sm btn-circle"`,
      );
    });

    it('is still three statements: the suggestion joins the context', async () => {
      const record = await recordQueries(() => get(`/wardrobe/${first}`));
      expect(record.statements).toBe(3);
    });

    it('set aside, its primary is Undo; once bought, ⋯ offers Returned it', async () => {
      await post(`/wardrobe/${second}/dismiss`, { reason: 'style' });
      const aside = (await get(`/wardrobe/${second}?decided=dismiss`)).body;
      expect(aside).toContain('data-suggestion-state="set-aside"');
      expect(aside).toContain(`action="/wardrobe/${second}/undo"`);
      expect(aside).toContain('id="decision-toast"');

      await post(`/wardrobe/${first}/bought`, {
        acquiredOn: t.today(),
        price: '',
      });
      const bought = (await get(`/wardrobe/${first}`)).body;
      expect(bought).toContain('data-suggestion-state="bought"');
      expect(bought).toContain(`hx-post="/wardrobe/${first}/returned"`);
    });
  });

  describe('Today’s card, the warm list and the export', () => {
    it('Today’s card counts the needs to decide and leads to the inbox', async () => {
      const html = unescapeHtml((await get('/')).body);
      const [, count] = /data-muse-needs="(\d+)"/.exec(html) ?? [];
      expect(Number(count)).toBeGreaterThan(0);
      expect(html).toContain(
        `Your agent has ${count} needs for you to decide on`,
      );
      expect(html).toMatch(
        /href="\/wardrobe\/wishlist" class="btn btn-primary/,
      );
    });
  });

  describe('offline and export', () => {
    it('warms the inbox, its needs’ screens and what is still wanted', async () => {
      const res = await t.inject({ method: 'GET', url: '/offline/warm' });
      const list = res.json<{ pages: string[]; keep: string[] }>();
      expect(list.pages).toContain('/wardrobe/wishlist');
      const needs = list.pages.filter((p) =>
        p.startsWith('/wardrobe/wishlist/needs/'),
      );
      expect(needs.length).toBeGreaterThan(0);
      const [aside] = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(eq(garment.dismissedReason, 'colour'));
      expect(list.pages).not.toContain(`/wardrobe/${aside.id}`);
      expect(list.keep).toContain(`/wardrobe/${aside.id}`);
    });

    it('exports the needs: their names in the CSV, the groups in the JSON', async () => {
      const csv = await t.inject({
        method: 'GET',
        url: '/wardrobe/export.csv',
      });
      expect(csv.statusCode).toBe(200);
      const header = csv.body.split('\r\n')[0];
      expect(header).toContain('suggestion_group_id');
      expect(header).toContain('option_group');
      expect(csv.body).toContain('A navy blazer');
      const json = await t.inject({
        method: 'GET',
        url: '/wardrobe/export.json',
      });
      const bundle = json.json<{ optionGroups: Record<string, unknown>[] }>();
      const blazer = bundle.optionGroups.find(
        (g) => g.name === 'A navy blazer',
      );
      expect(blazer).toMatchObject({ status: 'open', budget: '300.00' });
      expect(blazer).not.toHaveProperty('owner_id');
    });
  });
});
