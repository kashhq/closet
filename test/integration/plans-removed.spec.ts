import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { optionGroup } from '../../src/db/schema';
import { markSuggestion } from '../../src/web/wishlist/decisions';
import { createWishlistItem } from './garments';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { createPageFixture, type PageFixture, pageRoutes } from './pages';

/**
 * Wardrobe plans removed (#337 part B1; the plan tables stay until B2
 * drops them): the old addresses land on the Wishlist inbox that replaced
 * them (302: nothing should cache them for good), an old form's post
 * changes nothing, and no page links a plan, the shopping list or a
 * wishlist item's plan items any more.
 */
describe('wardrobe plans, removed', () => {
  let t: TestApp;
  let fixture: PageFixture;

  beforeAll(async () => {
    t = await createTestApp();
    fixture = await createPageFixture(t);
    // An agent need with a pick, so the inbox, the need's page and Today's
    // card all render something of the agent's.
    const [need] = await t.db
      .insert(optionGroup)
      .values({ ownerId: t.owner.id, name: 'A navy knit', budget: '100' })
      .returning({ id: optionGroup.id });
    const pick = await createWishlistItem(t, { name: 'Navy crew' });
    expect(
      await markSuggestion(t.db, t.owner.id, pick, {
        tokenId: null,
        groupId: need.id,
        note: 'Goes with your chinos',
        rank: 1,
      }),
    ).toBe('marked');
  });

  afterAll(() => t?.cleanup());

  it('sends every plans address and the shopping list to the Wishlist inbox', async () => {
    for (const url of [
      '/wardrobe/plans',
      '/wardrobe/plans/new',
      '/wardrobe/plans/14',
      '/wardrobe/plans/14?view=outfits',
      '/wardrobe/plans/14/review',
      '/wardrobe/plans/14/items/3/edit',
      '/wardrobe/plans/14/items/3/candidates?returnTo=%2Fwardrobe%2Fshopping',
      '/wardrobe/plans/compare?a=13&b=14',
      '/wardrobe/shopping',
      '/wardrobe/shopping?plan=13',
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 302 });
      expect(res.headers.location, url).toBe('/wardrobe/wishlist');
    }
  });

  it('sends a wishlist item’s plan items to its page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${fixture.wishlistId}/plan-items`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/wardrobe/${fixture.wishlistId}`);
  });

  it('asks a signed-out visitor to log in first, as any page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe/plans/14',
      anonymous: true,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/auth\/login/);
  });

  it('refuses an old form’s post, writing nothing', async () => {
    for (const url of [
      '/wardrobe/plans',
      '/wardrobe/plans/14/review',
      `/wardrobe/${fixture.wishlistId}/plan-items`,
    ]) {
      const res = await t.inject({
        method: 'POST',
        url,
        payload: { name: 'Old plan' },
      });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).toBeLessThan(500);
    }
  });

  it('links no plan, shopping list or plan items from any page', async () => {
    const routes = pageRoutes(fixture, '00000000-0000-4000-8000-000000000000');
    const agent = [
      '/wardrobe/wishlist',
      ...(await t.db.select({ id: optionGroup.id }).from(optionGroup)).map(
        ({ id }) => `/wardrobe/wishlist/needs/${id}`,
      ),
    ];
    for (const url of [...routes.map((route) => route.url), ...agent]) {
      const res = await t.inject({ method: 'GET', url });
      if (res.statusCode !== 200) continue;
      const html = unescapeHtml(res.body);
      expect(html, url).not.toMatch(
        /\/wardrobe\/plans|\/wardrobe\/shopping|\/plan-items/,
      );
    }
  });
});
