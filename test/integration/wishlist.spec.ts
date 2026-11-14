import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capsuleGarment, outfitSlot } from '../../src/db/schema';
import { countToTag } from '../../src/web/wardrobe/queries';
import { createGarment, createWishlistItem, garmentRow } from './garments';
import {
  createTestApp,
  hxLocationPath,
  type TestApp,
  unescapeHtml,
  userIdOf,
  TEST_PASSWORD,
} from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { expectOfflineGuarded } from './pages';

/**
 * The wishlist (#18, slice 18a): garment.status 'wishlist', its tab, adding
 * (by hand, from a link, as a replacement), "Bought it", and the rule that
 * makes it work: inCloset is the one predicate of every closet read, so a
 * wishlist item is absent from the grid, the outfit builder, capsules,
 * laundry and tagging, and cannot be worn, washed, lent, put in a capsule
 * or in a planned outfit until it is bought (an outfit nothing holds may
 * hold it, incomplete: #335). Shared like the rest of the wardrobe: a
 * VIEW grantee reads the wishlist, a MANAGE grantee adds and buys, only the
 * owner archives what a purchase replaces.
 */

describe('the wishlist', () => {
  let t: TestApp;
  let sites: LinkSites;
  let viewer: string;
  let manager: string;
  let stranger: string;
  let ownerId: number;
  /** The owner's closet: a merino marked replace_soon (in a capsule, worn today) and jeans. */
  let merino: number;
  let jeans: number;
  let capsuleId: number;
  /** On the wishlist: the merino's replacement, and a beanie in a category nothing else has. */
  let charcoal: number;
  let beanie: number;

  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (
    url: string,
    payload: Record<string, unknown> = {},
    cookie?: string,
  ) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });
  const statusOf = async (id: number) => (await garmentRow(t, id))?.status;
  const today = () => t.today();

  const share = async (permission: 'VIEW' | 'MANAGE', cookie: string) => {
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission, currentPassword: TEST_PASSWORD },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    await post(`/wardrobe-share/invite/${token}/accept`, {}, cookie);
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    sites.serve('/img/crew.jpg', jpeg(await productShot('#444444')));
    sites.serve(
      '/products/crew',
      html(`<!doctype html><html><head><title>Merino Crew</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Charcoal Merino Crew',
        brand: { '@type': 'Brand', name: 'Knit Co' },
        color: 'Grey',
        image: [sites.url('/img/crew.jpg')],
        offers: { price: '79.00', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    ownerId = await userIdOf(t, 'owner@example.com');
    merino = await createGarment(t, { name: 'Grey merino', category: 'tops' });
    jeans = await createGarment(t, { name: 'Jeans', category: 'bottoms' });
    await post(`/wardrobe/${merino}/condition`, {
      condition: 'replace_soon',
      conditionNote: 'Pilling',
    });
    const capsule = await post('/capsules', { name: 'Office' });
    capsuleId = Number(
      /^\/capsules\/(\d+)\?/.exec(capsule.headers.location as string)![1],
    );
    await post(`/capsules/${capsuleId}/garments`, {
      ids: [merino],
      shown: [merino],
    });
    await post(`/wardrobe/${merino}/wear`, { worn: '1' });

    charcoal = await createWishlistItem(t, {
      name: 'Charcoal merino',
      category: 'tops',
      replaces: merino,
      price: '79',
      sourceUrl: 'https://shop.example/charcoal',
    });
    beanie = await createWishlistItem(t, {
      name: 'Wool beanie',
      category: 'hats',
    });
    viewer = await t.register('viewer-wishlist@example.com');
    manager = await t.register('manager-wishlist@example.com');
    stranger = await t.register('stranger-wishlist@example.com');
    await share('VIEW', viewer);
    await share('MANAGE', manager);
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  describe('is absent from every closet read (inCloset)', () => {
    it('stores the items on the wishlist, the replacement pointing at the merino', async () => {
      expect(await garmentRow(t, charcoal)).toMatchObject({
        status: 'wishlist',
        replacesGarmentId: merino,
        price: '79.00',
        sourceUrl: 'https://shop.example/charcoal',
      });
      expect(await statusOf(beanie)).toBe('wishlist');
    });

    it('the grid, with or without archived, and its filter choices', async () => {
      for (const url of [
        '/wardrobe',
        '/wardrobe?archived=true',
        '/wardrobe?keyword=merino',
        `/wardrobe/tiles?before=${beanie + 1}`,
      ]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toContain('Grey merino');
        expect(res.body, url).not.toContain('Charcoal merino');
        expect(res.body, url).not.toContain('Wool beanie');
      }
      // The beanie's category is on the wishlist only: not a filter choice.
      expect((await get('/wardrobe')).body).not.toContain('value="hats"');
      expect((await get('/wardrobe')).body).toContain('2 results');
    });

    it('Styling and its strips', async () => {
      const styling = await get('/styling');
      expect(styling.body).toContain('Grey merino');
      expect(styling.body).not.toContain('Charcoal merino');
      expect(styling.body).not.toContain('Wool beanie');
      const tops = await get('/styling/garments?role=top&before=2147483647');
      expect(tops.body).toContain('Grey merino');
      expect(tops.body).not.toContain('Charcoal merino');
      // Hats are uncategorised (`none`): the beanie is in no strip.
      const other = await get('/styling/garments?role=none&before=2147483647');
      expect(other.body).not.toContain('Wool beanie');
    });

    it('capsules: the list, the closet card, a capsule page, and membership', async () => {
      for (const url of ['/capsules', `/capsules/${capsuleId}`]) {
        const res = await get(url);
        expect(res.body, url).not.toContain('Charcoal merino');
        expect(res.body, url).not.toContain('Wool beanie');
      }
      // The closet card counts the closet: the merino and the jeans.
      expect((await get('/capsules')).body).toContain('2 garments');
      // The picker's post and the garment page's toggles cannot add one.
      await post(`/capsules/${capsuleId}/garments`, {
        ids: [merino, charcoal],
        shown: [merino, charcoal],
      });
      // The item is the wardrobe's, so the toggles find it (200, not a
      // 404) and change nothing.
      const toggled = await post(`/wardrobe/${beanie}/capsules`, {
        capsuleIds: [capsuleId],
        shown: [capsuleId],
      });
      expect(toggled.statusCode).toBe(200);
      const members = await t.db
        .select({ garmentId: capsuleGarment.garmentId })
        .from(capsuleGarment)
        .where(eq(capsuleGarment.capsuleId, capsuleId));
      expect(members.map((m) => m.garmentId)).toEqual([merino]);
    });

    it('laundry, the wash counts and tagging', async () => {
      const laundry = await get('/laundry');
      expect(laundry.body).toContain('Grey merino');
      expect(laundry.body).not.toContain('Charcoal merino');
      // The beanie has no type or warmth, but is not the closet's to tag.
      expect(await countToTag(t.db, ownerId)).toBe(2);
    });

    it('cannot be worn, washed or lent (409), nor washed from /laundry', async () => {
      for (const [action, payload] of [
        ['wear', { worn: '1' }],
        ['washed', {}],
        ['away', { away: 'lent' }],
      ] as const) {
        const res = await post(`/wardrobe/${charcoal}/${action}`, payload);
        expect(res.statusCode, action).toBe(409);
      }
      const batch = await post('/laundry', { ids: [charcoal, merino] });
      expect(batch.headers.location).toBe('/laundry?washed=1');
      expect((await garmentRow(t, charcoal))?.lastWashedOn).toBeNull();
    });

    it('an outfit holds it only unplanned: a save planned on a day refuses it, naming it, and writes nothing (#219, #335)', async () => {
      const before = await t.db.$count(outfitSlot);
      const res = await post('/outfits', {
        name: 'Wishful',
        category: ['tops', 'bottoms'],
        garmentId: [String(charcoal), String(jeans)],
        scheduleDate: t.today(),
      });
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain(
        'Buy Charcoal merino first: an outfit with pieces not bought yet can’t be planned or packed.',
      );
      expect(await t.db.$count(outfitSlot)).toBe(before);
    });
  });

  describe('the Wishlist tab', () => {
    it('lists the items with price, product link and what they replace, and "Bought it"', async () => {
      const res = await get('/wardrobe/wishlist');
      expect(res.statusCode).toBe(200);
      const body = unescapeHtml(res.body);
      expect(body).toContain('Charcoal merino');
      expect(body).toContain('Wool beanie');
      expect(body).not.toContain('>Jeans<');
      expect(body).toContain('$79.00');
      expect(body).toContain(
        'href="https://shop.example/charcoal" target="_blank" rel="noopener noreferrer"',
      );
      expect(body).toContain('Replaces Grey merino');
      expect(body).toContain(`href="/wardrobe/${charcoal}/bought"`);
      // A tab of the Wardrobe: its tabs, Wishlist the active one.
      expect(body).toMatch(
        /<a href="\/wardrobe\/wishlist" class="tab tab-active" aria-current="page"/,
      );
      expect(body).toContain('href="/wardrobe/new?to=wishlist"');
      expect(body).toContain('href="/wardrobe/new/from-link?to=wishlist"');
    });

    it('shows a VIEW grantee the owner’s wishlist, read-only', async () => {
      const res = await get(`/wardrobe/wishlist?ownerId=${ownerId}`, viewer);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Charcoal merino');
      expect(res.body).not.toContain('/bought');
      expect(res.body).not.toContain('to=wishlist');
      const own = await get('/wardrobe/wishlist', viewer);
      expect(own.body).not.toContain('Charcoal merino');
      expect(
        (await get(`/wardrobe/wishlist?ownerId=${ownerId}`, stranger))
          .statusCode,
      ).toBe(404);
    });

    it('is the Wardrobe section in the dock', async () => {
      const res = await get('/wardrobe/wishlist');
      expect(res.body).toContain('aria-current="page" href="/wardrobe"');
    });
  });

  describe('adding', () => {
    it('by hand: the form lands on the wishlist without the closet’s care fields', async () => {
      const form = await get('/wardrobe/new?to=wishlist');
      expect(form.statusCode).toBe(200);
      expect(form.body).toContain('name="to" value="wishlist"');
      expect(form.body).toContain('name="wishlist" value="1"');
      expect(form.body).not.toContain('name="care"');
      expect(form.body).not.toContain('name="dateAquired"');
      const id = await createWishlistItem(t, { name: 'Linen shirt' });
      const saved = await get(`/wardrobe/${id}`);
      expect(saved.body).toContain('Linen shirt');
      expect(t.logs.messages('info', 'Web')).toContain(
        `Garment ${id} created (wishlist) by user ${ownerId} in wardrobe ${ownerId}`,
      );
    });

    it('"Find a replacement" on a replace_soon garment opens the form prefilled', async () => {
      const page = unescapeHtml((await get(`/wardrobe/${merino}`)).body);
      expect(page).toContain(
        `href="/wardrobe/new?to=wishlist&replaces=${merino}"`,
      );
      // The wishlist items already replacing it are listed.
      expect(page).toContain(`href="/wardrobe/${charcoal}"`);

      const form = await get(`/wardrobe/new?to=wishlist&replaces=${merino}`);
      expect(form.statusCode).toBe(200);
      expect(form.body).toContain(`<option value="${merino}" selected="">`);
      expect(form.body).toMatch(/name="category"[^>]*value="Tops"/);
      // What belonged to the old one is not carried over.
      expect(form.body).not.toContain('value="Grey merino"');
      // A garment outside the wardrobe is a 404 like an unknown one.
      expect(
        (await get(`/wardrobe/new?to=wishlist&replaces=${merino}`, stranger))
          .statusCode,
      ).toBe(404);
    });

    it('stores a replacement only when it is the same owner’s, owned, and not itself', async () => {
      const strangerId = await userIdOf(t, 'stranger-wishlist@example.com');
      const theirs = await createWishlistItem(t, {
        name: 'Their idea',
        replaces: merino,
        cookie: stranger,
      });
      expect(await garmentRow(t, theirs)).toMatchObject({
        ownerId: strangerId,
        replacesGarmentId: null,
      });
      const onWishlist = await createWishlistItem(t, {
        name: 'Replacing a wish',
        replaces: charcoal,
      });
      expect((await garmentRow(t, onWishlist))?.replacesGarmentId).toBeNull();
      // An edit naming itself stores nothing either.
      await post(`/wardrobe/${onWishlist}`, {
        name: 'Replacing a wish',
        category: 'tops',
        wishlist: '1',
        replaces: String(onWishlist),
      });
      expect((await garmentRow(t, onWishlist))?.replacesGarmentId).toBeNull();
    });

    it('an edit without the wishlist marker leaves what it replaces alone', async () => {
      await post(`/wardrobe/${charcoal}`, {
        name: 'Charcoal merino',
        category: 'tops',
      });
      expect((await garmentRow(t, charcoal))?.replacesGarmentId).toBe(merino);
    });

    it('from a link: the destination rides through the link page to the form', async () => {
      const page = unescapeHtml(
        (await get(`/wardrobe/new/from-link?to=wishlist&replaces=${merino}`))
          .body,
      );
      expect(page).toContain(
        `action="/wardrobe/new/from-link?to=wishlist&replaces=${merino}"`,
      );
      const imported = await post(
        `/wardrobe/new/from-link?to=wishlist&replaces=${merino}`,
        { url: sites.url('/products/crew') },
      );
      expect(imported.statusCode).toBe(200);
      expect(imported.body).toContain('name="to" value="wishlist"');
      expect(imported.body).toContain(`<option value="${merino}" selected="">`);
      const linkPhoto = /name="linkPhoto" value="([^"]+)"/.exec(
        imported.body,
      )![1];
      const saved = await post('/wardrobe', {
        name: 'Charcoal Merino Crew',
        category: 'tops',
        to: 'wishlist',
        wishlist: '1',
        replaces: String(merino),
        linkPhoto,
      });
      expect(saved.statusCode).toBe(302);
      const id = Number(
        /^\/wardrobe\/(\d+)\?/.exec(saved.headers.location as string)![1],
      );
      const row = await garmentRow(t, id);
      expect(row).toMatchObject({
        status: 'wishlist',
        replacesGarmentId: merino,
      });
      expect(row?.photo).not.toBeNull();
    });

    it('a clone of a wishlist item lands on the requester’s wishlist', async () => {
      const res = await post(
        `/wardrobe/${charcoal}/clone?ownerId=${ownerId}`,
        { name: 'Me too', category: 'tops' },
        viewer,
      );
      expect(res.statusCode).toBe(302);
      const id = Number(
        /^\/wardrobe\/(\d+)$/.exec(res.headers.location as string)![1],
      );
      expect(await garmentRow(t, id)).toMatchObject({
        status: 'wishlist',
        replacesGarmentId: null,
      });
    });
  });

  describe('its page', () => {
    it('offers Bought it, not archive, wears or capsules, and says what it replaces', async () => {
      const page = unescapeHtml((await get(`/wardrobe/${charcoal}`)).body);
      expect(page).toContain(`href="/wardrobe/${charcoal}/bought"`);
      expect(page).toContain(`href="/wardrobe/${merino}"`);
      expect(page).not.toContain(`/wardrobe/${charcoal}/archive`);
      expect(page).not.toContain('id="garment-wear"');
      expect(page).not.toContain(`/wardrobe/${charcoal}/capsules`);
      expect(page).not.toContain(`/wardrobe/${charcoal}/condition`);
      expect(page).toContain('href="/wardrobe/wishlist"');
    });

    it('deleting an item goes back to the wishlist', async () => {
      const id = await createWishlistItem(t, { name: 'Not buying it' });
      const res = await t.inject({ method: 'DELETE', url: `/wardrobe/${id}` });
      expect(hxLocationPath(res)).toBe('/wardrobe/wishlist');
      expect(await garmentRow(t, id)).toBeUndefined();
    });
  });

  describe('"Bought it"', () => {
    it('prefills today and the listed price, and offers the old one for the archive, unchecked', async () => {
      const form = await get(`/wardrobe/${charcoal}/bought`);
      expect(form.statusCode).toBe(200);
      expect(form.body).toMatch(
        new RegExp(`name="acquiredOn"[^>]*value="${today()}"`),
      );
      expect(form.body).toMatch(/name="price"[^>]*value="79.00"/);
      expect(form.body).toMatch(
        /<input type="checkbox" name="archiveReplaced" value="1" class="checkbox checkbox-sm"\/>/,
      );
      expect(form.body).toContain('Also archive Grey merino');
      expectOfflineGuarded(form, `/wardrobe/${charcoal}/bought`);
    });

    it('offers a MANAGE grantee no archive (the owner’s), and refuses one asked for', async () => {
      const form = await get(
        `/wardrobe/${charcoal}/bought?ownerId=${ownerId}`,
        manager,
      );
      expect(form.statusCode).toBe(200);
      expect(form.body).not.toContain('archiveReplaced');
      const res = await post(
        `/wardrobe/${charcoal}/bought?ownerId=${ownerId}`,
        { acquiredOn: today(), price: '70', archiveReplaced: '1' },
        manager,
      );
      expect(res.statusCode).toBe(403);
      expect(await statusOf(charcoal)).toBe('wishlist');
      expect(await statusOf(merino)).toBe('closet');
    });

    it('re-renders a date or price it cannot read, writing nothing', async () => {
      const res = await post(`/wardrobe/${charcoal}/bought`, {
        acquiredOn: '2026-02-30',
        price: 'cheap',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/name="price"[^>]*value="cheap"/);
      // FormField's contract: the refused input is invalid and described by its announced message.
      expect(res.body).toContain(
        'aria-invalid="true" aria-describedby="bought-price-messages"',
      );
      expect(res.body).toMatch(
        /<div id="bought-price-messages"><p[^>]*role="alert"/,
      );
      // The refusal's re-render is the same frame, so a retry offline is held too.
      expectOfflineGuarded(res, `/wardrobe/${charcoal}/bought`);
      expect(await statusOf(charcoal)).toBe('wishlist');
    });

    it('moves it to the closet with the day and price paid, and archives the old one only when asked', async () => {
      const kept = await createWishlistItem(t, {
        name: 'Second jeans',
        category: 'bottoms',
        replaces: jeans,
        price: '98',
      });
      const first = await post(`/wardrobe/${kept}/bought`, {
        acquiredOn: '2026-09-20',
        price: '$90',
      });
      expect(first.statusCode).toBe(303);
      expect(first.headers.location).toBe(`/wardrobe/${kept}?bought=1`);
      expect(await garmentRow(t, kept)).toMatchObject({
        status: 'closet',
        acquiredOn: '2026-09-20',
        price: '90.00',
        // Kept as the record of what it replaced.
        replacesGarmentId: jeans,
      });
      expect(await statusOf(jeans)).toBe('closet');

      const bought = await post(`/wardrobe/${charcoal}/bought`, {
        acquiredOn: today(),
        price: '79.00',
        archiveReplaced: '1',
      });
      expect(bought.statusCode).toBe(303);
      expect(await statusOf(charcoal)).toBe('closet');
      expect(await statusOf(merino)).toBe('archived');
      expect(t.logs.messages('info', 'Web')).toContain(
        `Garment ${charcoal} bought (wishlist -> closet) by user ${ownerId} in wardrobe ${ownerId}; garment ${merino} it replaces archived`,
      );
      // Now a closet read, and the old one is not.
      const grid = await get('/wardrobe');
      expect(grid.body).toContain('Charcoal merino');
      expect(grid.body).not.toContain('Grey merino');
      expect((await get('/wardrobe/wishlist')).body).not.toContain(
        'Charcoal merino',
      );
      const page = await get(`/wardrobe/${charcoal}?bought=1`);
      expect(page.body).toContain('id="bought-toast"');
    });

    it('is a 409 once bought, and its form sends the person to the garment', async () => {
      const again = await post(`/wardrobe/${charcoal}/bought`, {
        acquiredOn: today(),
      });
      expect(again.statusCode).toBe(409);
      const form = await get(`/wardrobe/${charcoal}/bought`);
      expect(form.statusCode).toBe(302);
      expect(form.headers.location).toBe(`/wardrobe/${charcoal}`);
    });

    it('a MANAGE grantee buys for the owner', async () => {
      const id = await createWishlistItem(t, {
        name: 'Belt',
        category: 'accessories',
        cookie: manager,
        ownerId,
      });
      const res = await post(
        `/wardrobe/${id}/bought?ownerId=${ownerId}`,
        { acquiredOn: today(), price: '' },
        manager,
      );
      expect(res.statusCode).toBe(303);
      expect(await garmentRow(t, id)).toMatchObject({
        status: 'closet',
        ownerId,
        price: null,
      });
      // A VIEW grantee may not.
      const viewed = await createWishlistItem(t, { name: 'Scarf' });
      expect(
        (
          await post(
            `/wardrobe/${viewed}/bought?ownerId=${ownerId}`,
            { acquiredOn: today() },
            viewer,
          )
        ).statusCode,
      ).toBe(403);
    });
  });
});
