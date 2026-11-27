import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  pendingPhoto,
  personalAccessToken,
} from '../../src/db/schema';
import { MAX_OPTIONS_PER_GROUP } from '../../src/wardrobe/suggestions';
import { markSuggestion } from '../../src/web/wishlist/decisions';
import { createWishlistItem } from './garments';
import { createTestApp, type TestApp, asFixture } from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * suggest_garment judged again as it writes (#337): its refusals before
 * the fetch (mcp-agent.spec.ts) are read ahead, so a need set aside or
 * filled during the fetch, a link set aside by the owner whoever added
 * it, or the same link marked by a call alongside is refused under the
 * owner lock (markSuggestedProduct), leaving no garment and no pending
 * photo. A spec of its own: the link imports' budget is 10 a minute per
 * user.
 */
describe('suggest_garment, judged again as it writes', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let tokenId: number;
  let products = 0;

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  /** A product page of its own; `meanwhile` runs while the app fetches it. */
  async function product(
    name: string,
    price = '120.00',
    meanwhile?: () => Promise<void>,
  ): Promise<string> {
    const slug = `p${++products}`;
    sites.serve(`/img/${slug}.jpg`, jpeg(await productShot('#334455')));
    sites.serve(`/products/${slug}`, {
      meanwhile,
      ...html(`<!doctype html><html><head><title>${name}</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name,
        brand: { '@type': 'Brand', name: 'Studio' },
        image: [sites.url(`/img/${slug}.jpg`)],
        offers: { price, priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    });
    return sites.url(`/products/${slug}`);
  }

  const need = async (name: string) =>
    (await tool<{ id: number }>(t, token, 'create_option_group', { name })).id;

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    token = await createAccessToken(t, { name: 'Stylist' });
    const [row] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, t.owner.id));
    tokenId = row.id;
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('refuses the link of a wishlist item the owner set aside, whoever added it', async () => {
    const groupId = await need('A trench coat');
    const url = await product('Trench Coat');
    const own = await createWishlistItem(t, {
      name: 'My trench',
      category: 'outerwear',
      sourceUrl: `${url.replace('http://', 'https://www.')}?srsltid=x`,
    });
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ dismissedAt: new Date(), dismissedReason: 'style' })
        .where(eq(garment.id, own)),
    );
    const refused = await callTool(t, token, 'suggest_garment', {
      url,
      groupId,
    });
    expect(refused.isError).toBe(true);
    expect(refused.value.error).toContain(`garment ${own}`);
    expect(refused.value.error).toContain('style');
  });

  it.each([
    [
      'set aside',
      (groupId: number) =>
        post(`/wardrobe/wishlist/needs/${groupId}/dismiss`, {
          reason: 'not_now',
        }).then(() => undefined),
      'decided',
    ],
    [
      'filled',
      async (groupId: number) => {
        for (let i = 0; i < MAX_OPTIONS_PER_GROUP; i++) {
          const id = await createWishlistItem(t, {
            name: `Filler ${groupId}-${i}`,
            category: 'tops',
          });
          await markSuggestion(t.db, t.owner.id, id, {
            tokenId,
            groupId,
            note: null,
            rank: null,
          });
        }
      },
      `${MAX_OPTIONS_PER_GROUP} open options`,
    ],
  ])(
    'leaves no garment and no photo when the need is %s during the fetch',
    async (what, meanwhile, refusal) => {
      const groupId = await need(`A raincoat, ${what}`);
      const url = await product('Raincoat', '99.00', () => meanwhile(groupId));
      const refused = await callTool(t, token, 'suggest_garment', {
        url,
        groupId,
        category: 'outerwear',
      });
      expect(refused.isError).toBe(true);
      expect(refused.value.error).toContain(refusal);
      expect(
        await t.db
          .select({ id: garment.id })
          .from(garment)
          .where(eq(garment.sourceUrl, url)),
      ).toEqual([]);
      expect(
        await t.db
          .select({ name: pendingPhoto.fileName })
          .from(pendingPhoto)
          .where(eq(pendingPhoto.userId, t.owner.id)),
      ).toEqual([]);
    },
  );

  it('lets one of two calls at once suggest a link, never both', async () => {
    const groupId = await need('A peacoat');
    const url = await product('Peacoat', '180.00');
    const answers = await Promise.all([
      callTool(t, token, 'suggest_garment', {
        url,
        groupId,
        category: 'outerwear',
      }),
      callTool(t, token, 'suggest_garment', {
        url: `${url}?utm_source=x`,
        groupId,
        category: 'outerwear',
      }),
    ]);
    expect(answers.filter((a) => a.isError)).toHaveLength(1);
    const rows = await t.db
      .select({ id: garment.id })
      .from(garment)
      .where(eq(garment.suggestionGroupId, groupId));
    expect(rows).toHaveLength(1);
  });
});
