import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  optionGroup,
  outfit,
  outfitSlot,
  personalAccessToken,
} from '../../src/db/schema';
import { MAX_OPTIONS_PER_GROUP } from '../../src/wardrobe/suggestions';
import { setGarmentStatus } from '../../src/web/wardrobe/status';
import { markSuggestion } from '../../src/web/wishlist/decisions';
import { FEEDBACK_MARGIN_MS } from '../../src/web/wishlist/feedback';
import { createGarment, createWishlistItem, garmentRow } from './garments';
import { createTestApp, type TestApp, userIdOf, asFixture } from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { callTool, createAccessToken, mcpRequest, tool } from './mcp';

/**
 * The agent's MCP tools (#337, docs/plans/2026-10-05-muse-suggestions.md
 * section 5), driven as a client: a need (create_option_group), its
 * options from product links (suggest_garment), an outfit
 * (suggest_outfit), what stands where (list_suggestions), the closet's
 * coverage, and the owner's decisions coming back (get_suggestion_feedback)
 * with the never-again rules: a dismissed product's link, a need set
 * aside and an outfit declined are refused. The plans' tools are gone.
 * Rows are asserted through t.db.
 */

interface Feedback {
  since: string | null;
  until: string;
  needs: {
    needId: number;
    decision: string;
    garment: { id: number } | null;
    reason: string | null;
    ownerNote: string | null;
  }[];
  picksSetAside: {
    garmentId: number;
    needId: number | null;
    reason: string | null;
    note: string | null;
    sourceUrl: string | null;
  }[];
  purchases: {
    garmentId: number;
    pricePaid: string | null;
    different: boolean;
    needId: number | null;
    at: string | null;
  }[];
  outfits: {
    outfitId: number;
    reaction: string;
    reason: string | null;
    at: string | null;
  }[];
  wears: { garmentId: number; wears: number; status: string }[];
}

describe('MCP: the agent’s tools', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let tokenId: number;
  let strangerToken: string;
  let tee: number;
  let jeans: number;
  let shoes: number;
  let products = 0;

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  /** A product page of its own, its link (a JSON-LD product with a photo and a price). */
  async function product(name: string, price = '120.00'): Promise<string> {
    const slug = `p${++products}`;
    sites.serve(`/img/${slug}.jpg`, jpeg(await productShot('#334455')));
    sites.serve(
      `/products/${slug}`,
      html(`<!doctype html><html><head><title>${name}</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name,
        brand: { '@type': 'Brand', name: 'Studio' },
        image: [sites.url(`/img/${slug}.jpg`)],
        offers: { price, priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    return sites.url(`/products/${slug}`);
  }

  const need = async (name: string, extra: Record<string, unknown> = {}) =>
    (
      await tool<{ id: number }>(t, token, 'create_option_group', {
        name,
        ...extra,
      })
    ).id;

  async function suggest(
    groupId: number,
    url: string,
    extra: Record<string, unknown> = {},
  ) {
    return tool<{ id: number; price: string | null }>(
      t,
      token,
      'suggest_garment',
      {
        url,
        groupId,
        ...extra,
      },
    );
  }

  const feedback = (args: Record<string, unknown> = {}) =>
    tool<Feedback>(t, token, 'get_suggestion_feedback', args);

  /**
   * The cursor moved to this instant, past the overlap a call leaves
   * (OWNER_LOCK_TIMEOUT_MS): the next call tells only what follows.
   */
  const caughtUp = () =>
    t.db
      .update(personalAccessToken)
      .set({ feedbackReadAt: sql`now()` })
      .where(eq(personalAccessToken.id, tokenId));

  const garmentCount = async () =>
    (await t.db.select({ id: garment.id }).from(garment)).length;

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    token = await createAccessToken(t, { name: 'Stylist' });
    const [row] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, t.owner.id));
    tokenId = row.id;
    const stranger = await t.register('stranger@example.com');
    strangerToken = await createAccessToken(t, { cookie: stranger });
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    shoes = await createGarment(t, {
      name: 'Canvas shoes',
      category: 'footwear',
    });
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  describe('create_option_group', () => {
    it('opens a need with the agent’s token, its budget and note', async () => {
      const id = await need('  A navy blazer ', {
        budget: 300,
        note: 'Pairs with the raw jeans',
      });
      const [row] = await t.db
        .select()
        .from(optionGroup)
        .where(eq(optionGroup.id, id));
      expect(row).toMatchObject({
        ownerId: t.owner.id,
        name: 'A navy blazer',
        budget: '300.00',
        note: 'Pairs with the raw jeans',
        status: 'open',
        suggestedByTokenId: tokenId,
      });
    });

    it('refuses the name of a need still open, naming it, and of one set aside, with its reason', async () => {
      const id = await need('Chelsea boots');
      const again = await callTool(t, token, 'create_option_group', {
        name: 'chelsea BOOTS',
      });
      expect(again.isError).toBe(true);
      expect(again.value.error).toContain(`id ${id}`);

      expect(
        (
          await post(`/wardrobe/wishlist/needs/${id}/dismiss`, {
            reason: 'not_now',
          })
        ).statusCode,
      ).toBe(303);
      const declined = await callTool(t, token, 'create_option_group', {
        name: 'Chelsea boots',
      });
      expect(declined.isError).toBe(true);
      expect(declined.value.error).toContain('not_now');
      const rows = await t.db
        .select({ id: optionGroup.id })
        .from(optionGroup)
        .where(eq(optionGroup.ownerId, t.owner.id));
      expect(rows.filter((r) => r.id > id)).toEqual([]);
    });
  });

  describe('create_option_group, a need chosen', () => {
    it('refuses the name of a need the owner chose an option for until it is bought', async () => {
      const groupId = await need('A cashmere scarf');
      const scarf = await createWishlistItem(t, {
        name: 'Cashmere scarf',
        category: 'accessories',
      });
      await markSuggestion(t.db, t.owner.id, scarf, {
        tokenId,
        groupId,
        note: null,
        rank: null,
      });
      expect((await post(`/wardrobe/${scarf}/choose`)).statusCode).toBe(303);
      const chosen = await callTool(t, token, 'create_option_group', {
        name: 'a cashmere scarf ',
      });
      expect(chosen.isError).toBe(true);
      expect(chosen.value.error).toContain(
        `chose an option for that need (id ${groupId})`,
      );

      expect(
        (
          await post(`/wardrobe/${scarf}/bought`, {
            acquiredOn: t.today(),
            price: '90',
          })
        ).statusCode,
      ).toBe(303);
      // Settled by a purchase: history, and the need may come round again.
      expect(await need('A cashmere scarf')).toBeGreaterThan(groupId);
    });
  });

  describe('suggest_garment', () => {
    it('imports the product onto the wishlist as an option of the need, with its note, rank, price and size', async () => {
      const groupId = await need('A wool overcoat', { budget: 400 });
      const url = await product('Wool Overcoat', '380.00');
      const saved = await suggest(groupId, url, {
        note: 'Heavy wool, fits over a blazer',
        rank: 1,
        price: 349,
        size: 'M',
      });
      const row = await garmentRow(t, saved.id);
      expect(row).toMatchObject({
        ownerId: t.owner.id,
        status: 'wishlist',
        name: 'Wool Overcoat',
        addedByTokenId: tokenId,
        suggestionGroupId: groupId,
        suggestionNote: 'Heavy wool, fits over a blazer',
        suggestionRank: 1,
        price: '349.00',
        size: 'Medium', // the form's own normalizing
        sourceUrl: url,
      });
      expect(row?.suggestedAt).not.toBeNull();
    });

    it('refuses before the fetch: an unknown or another’s need, a need decided, one full', async () => {
      const url = await product('Never fetched');
      const before = await garmentCount();
      const hits = sites.hits.length;

      const unknown = await callTool(t, token, 'suggest_garment', {
        url,
        groupId: 999_999,
      });
      expect(unknown.value.error).toBe('Need not found');
      const theirs = await need('A scarf');
      const stranger = await callTool(t, strangerToken, 'suggest_garment', {
        url,
        groupId: theirs,
      });
      expect(stranger.value.error).toBe('Need not found');

      const decided = await need('A beanie');
      await post(`/wardrobe/wishlist/needs/${decided}/dismiss`, {
        reason: 'style',
      });
      const closed = await callTool(t, token, 'suggest_garment', {
        url,
        groupId: decided,
      });
      expect(closed.isError).toBe(true);
      expect(closed.value.error).toContain('decided');

      const full = await need('A belt');
      for (let i = 0; i < MAX_OPTIONS_PER_GROUP; i++) {
        const id = await createWishlistItem(t, {
          name: `Belt ${i}`,
          category: 'accessories',
        });
        expect(
          await markSuggestion(t.db, t.owner.id, id, {
            tokenId,
            groupId: full,
            note: null,
            rank: null,
          }),
        ).toBe('marked');
      }
      const crowded = await callTool(t, token, 'suggest_garment', {
        url,
        groupId: full,
      });
      expect(crowded.isError).toBe(true);
      expect(crowded.value.error).toContain(
        `${MAX_OPTIONS_PER_GROUP} open options`,
      );

      expect(await garmentCount()).toBe(before + MAX_OPTIONS_PER_GROUP);
      expect(sites.hits.length).toBe(hits);
    });

    it('refuses a product suggested already, its link’s tracking aside', async () => {
      const groupId = await need('A linen shirt');
      const url = await product('Linen Shirt');
      const first = await suggest(groupId, url);
      const again = await callTool(t, token, 'suggest_garment', {
        url: `${url}?utm_source=agent#size`,
        groupId,
      });
      expect(again.isError).toBe(true);
      expect(again.value.error).toContain(`garment ${first.id}`);
    });
  });

  describe('suggest_outfit', () => {
    it('proposes closet garments with an option, once; the owner’s own and a declined set are refused', async () => {
      const groupId = await need('A grey knit');
      const knit = await suggest(groupId, await product('Grey Knit', '90.00'), {
        category: 'tops',
      });
      const proposed = await tool<{ id: number }>(t, token, 'suggest_outfit', {
        garmentIds: [knit.id, jeans, shoes],
        note: 'Weekend, cool days',
      });
      const [row] = await t.db
        .select()
        .from(outfit)
        .where(eq(outfit.id, proposed.id));
      expect(row).toMatchObject({
        ownerId: t.owner.id,
        addedByTokenId: tokenId,
        proposalNote: 'Weekend, cool days',
        reaction: 'proposed',
      });
      expect(row.proposedAt).not.toBeNull();
      const slots = await t.db
        .select({
          garmentId: outfitSlot.garmentId,
          category: outfitSlot.category,
        })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, proposed.id))
        .orderBy(outfitSlot.position);
      expect(slots).toEqual([
        { garmentId: knit.id, category: 'tops' },
        { garmentId: jeans, category: 'bottoms' },
        { garmentId: shoes, category: 'footwear' },
      ]);

      const retry = await tool(t, token, 'suggest_outfit', {
        garmentIds: [shoes, jeans, knit.id],
      });
      expect(retry).toEqual({ id: proposed.id, alreadyProposed: 'proposed' });

      expect(
        (await post(`/outfits/${proposed.id}/dismiss`, { reason: 'style' }))
          .statusCode,
      ).toBe(303);
      const declined = await callTool(t, token, 'suggest_outfit', {
        garmentIds: [knit.id, jeans, shoes],
      });
      expect(declined.isError).toBe(true);
      expect(declined.value.error).toContain('declined');

      const own = await tool<{ id: number }>(t, token, 'create_outfit', {
        garmentIds: [tee, jeans],
      });
      const owners = await callTool(t, token, 'suggest_outfit', {
        garmentIds: [tee, jeans],
      });
      expect(owners.isError).toBe(true);
      expect(owners.value.error).toContain(`outfit ${own.id}`);
    });

    it('refuses an option the owner set aside, and another’s garment, writing nothing', async () => {
      const groupId = await need('A cardigan');
      const cardigan = await suggest(groupId, await product('Cardigan'));
      await post(`/wardrobe/${cardigan.id}/dismiss`, { reason: 'colour' });
      const before = await t.db.select({ id: outfit.id }).from(outfit);
      const aside = await callTool(t, token, 'suggest_outfit', {
        garmentIds: [cardigan.id, jeans],
      });
      expect(aside.isError).toBe(true);
      const theirs = await callTool(t, strangerToken, 'suggest_outfit', {
        garmentIds: [tee, jeans],
      });
      expect(theirs.isError).toBe(true);
      expect(await t.db.select({ id: outfit.id }).from(outfit)).toHaveLength(
        before.length,
      );
    });
  });

  describe('list_suggestions', () => {
    it('answers the inbox: open needs with their options and unlocks, still looking, set aside, and the outfits', async () => {
      const looking = await need('A raincoat');
      const groupId = await need('White sneakers', { budget: 150 });
      const sneaker = await suggest(
        groupId,
        await product('White Sneaker', '110.00'),
        { rank: 1, note: 'Clean leather' },
      );
      const list = await tool<{
        needs: {
          id: number;
          budget: string | null;
          options: {
            id: number;
            rank: number | null;
            note: string | null;
            unlocks: number | string | null;
          }[];
        }[];
        stillLooking: { id: number }[];
        setAside: {
          needs: { id: number; reason: string | null }[];
          options: { id: number; reason: string | null }[];
        };
        outfits: { id: number; reaction: string; reason: string | null }[];
      }>(t, token, 'list_suggestions');
      const sneakers = list.needs.find((n) => n.id === groupId)!;
      expect(sneakers.budget).toBe('150.00');
      expect(sneakers.options).toEqual([
        expect.objectContaining({
          id: sneaker.id,
          rank: 1,
          note: 'Clean leather',
        }),
      ]);
      expect(sneakers.options[0].unlocks).not.toBeNull();
      expect(list.stillLooking.map((n) => n.id)).toContain(looking);
      expect(list.setAside.needs.map((n) => n.reason)).toContain('not_now');
      expect(list.setAside.options.map((o) => o.reason)).toContain('colour');
      expect(
        list.outfits.some(
          (o) => o.reaction === 'declined' && o.reason === 'style',
        ),
      ).toBe(true);
    });
  });

  describe('get_suggestion_feedback', () => {
    it('round-trips a dismissal: the feedback tells it, writing nothing, and its link is never suggested again', async () => {
      const groupId = await need('A field jacket');
      const url = await product('Olive Field Jacket', '210.00');
      const jacket = await suggest(groupId, url);
      await caughtUp();

      await post(`/wardrobe/${jacket.id}/dismiss`, {
        reason: 'too_pricey',
        note: 'Under 150 please',
      });
      const told = await feedback();
      expect(told.since).not.toBeNull();
      expect(told.picksSetAside).toEqual([
        expect.objectContaining({
          garmentId: jacket.id,
          needId: groupId,
          reason: 'too_pricey',
          note: 'Under 150 please',
          sourceUrl: url,
        }),
      ]);
      // A pure read: told again until the round ends, the cursor untouched.
      const cursor = async () =>
        (
          await t.db
            .select({ at: personalAccessToken.feedbackReadAt })
            .from(personalAccessToken)
            .where(eq(personalAccessToken.id, tokenId))
        )[0].at;
      const kept = await cursor();
      const again = await feedback();
      expect(again.picksSetAside.map((p) => p.garmentId)).toEqual([jacket.id]);
      expect(Date.parse(again.until)).toBeGreaterThanOrEqual(
        Date.parse(told.until),
      );
      expect(await cursor()).toEqual(kept);
      await feedback({ all: true });
      expect(await cursor()).toEqual(kept);

      const before = await garmentCount();
      const refused = await callTool(t, token, 'suggest_garment', {
        url,
        groupId,
      });
      expect(refused.isError).toBe(true);
      expect(refused.value.error).toContain('set this product aside');
      expect(refused.value.error).toContain('too_pricey');
      expect(await garmentCount()).toBe(before);
    });

    it('tells a choice, a purchase with the price paid and its wears, and an outfit loved; `all` tells everything again', async () => {
      const groupId = await need('A belt bag');
      const bag = await suggest(groupId, await product('Belt Bag', '60.00'));
      const loved = await tool<{ id: number }>(t, token, 'suggest_outfit', {
        garmentIds: [bag.id, tee, jeans],
      });
      await caughtUp();

      expect((await post(`/wardrobe/${bag.id}/choose`)).statusCode).toBe(303);
      expect((await post(`/outfits/${loved.id}/love`)).statusCode).toBe(303);
      const chosen = await feedback();
      expect(chosen.needs).toEqual([
        expect.objectContaining({
          needId: groupId,
          decision: 'chosen',
          garment: expect.objectContaining({ id: bag.id }),
        }),
      ]);
      expect(chosen.outfits).toEqual([
        expect.objectContaining({ outfitId: loved.id, reaction: 'loved' }),
      ]);

      await caughtUp();
      expect(
        (
          await post(`/wardrobe/${bag.id}/bought`, {
            acquiredOn: t.today(),
            price: '55',
          })
        ).statusCode,
      ).toBe(303);
      const bought = await feedback();
      expect(bought.purchases).toEqual([
        expect.objectContaining({
          garmentId: bag.id,
          pricePaid: '55.00',
          different: false,
          needId: groupId,
        }),
      ]);
      expect(bought.purchases[0].at).not.toBeNull();
      expect(bought.needs).toEqual([
        expect.objectContaining({ needId: groupId, decision: 'bought' }),
      ]);
      expect(bought.wears).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            garmentId: bag.id,
            wears: 0,
            status: 'closet',
          }),
        ]),
      );
      expect((await garmentRow(t, bag.id))?.boughtAt).not.toBeNull();

      const everything = await feedback({ all: true });
      expect(everything.since).toBeNull();
      expect(everything.purchases.map((p) => p.garmentId)).toContain(bag.id);
      expect(everything.picksSetAside.length).toBeGreaterThan(0);
    });

    it('answers an until behind the read, so a decision stamped before the read and committed after it is told next round', async () => {
      const groupId = await need('A linen blazer');
      const blazer = await createWishlistItem(t, {
        name: 'Linen blazer',
        category: 'outerwear',
      });
      await markSuggestion(t.db, t.owner.id, blazer, {
        tokenId,
        groupId,
        note: null,
        rank: null,
      });
      // The last round ended a minute ago (its cursor behind its read).
      await t.db
        .update(personalAccessToken)
        .set({ feedbackReadAt: sql`now() - interval '1 minute'` })
        .where(eq(personalAccessToken.id, tokenId));
      const read = await feedback();
      const until = Date.parse(read.until);
      expect(until).toBeLessThan(Date.now() - FEEDBACK_MARGIN_MS / 2);
      // A decision whose transaction began a second after `until`, before
      // the read, and committed only now (decide stamps its start).
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({
            dismissedAt: new Date(until + 1_000),
            dismissedReason: 'colour',
          })
          .where(eq(garment.id, blazer)),
      );
      // The round ends as part A2's finish_round moves the cursor.
      await t.db
        .update(personalAccessToken)
        .set({
          feedbackReadAt: sql`greatest(${personalAccessToken.feedbackReadAt}, least(${read.until}::timestamptz, now()))`,
        })
        .where(eq(personalAccessToken.id, tokenId));
      const next = await feedback();
      expect(next.picksSetAside.map((p) => p.garmentId)).toContain(blazer);
    });

    it('tells a migrated reaction (no reacted_at) before the first round only', async () => {
      const [migrated] = await asFixture(t.db, (tx) =>
        tx
          .insert(outfit)
          .values({
            shareableId: crypto.randomUUID(),
            ownerId: t.owner.id,
            proposedAt: new Date(),
            addedByTokenId: tokenId,
            reaction: 'loved',
          })
          .returning({ id: outfit.id }),
      );
      const fresh = await createAccessToken(t, { name: 'Stylist again' });
      const first = await tool<Feedback>(t, fresh, 'get_suggestion_feedback');
      expect(first.since).toBeNull();
      expect(first.outfits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outfitId: migrated.id, at: null }),
        ]),
      );
      // Past a round's end (part A2's finish_round moves the cursor).
      await t.db
        .update(personalAccessToken)
        .set({ feedbackReadAt: sql`now()` })
        .where(eq(personalAccessToken.name, 'Stylist again'));
      const later = await tool<Feedback>(t, fresh, 'get_suggestion_feedback');
      expect(later.outfits.map((o) => o.outfitId)).not.toContain(migrated.id);
    });

    it('is the caller’s own: another user hears nothing of the owner’s decisions', async () => {
      const theirs = await tool<Feedback>(
        t,
        strangerToken,
        'get_suggestion_feedback',
      );
      expect(theirs).toMatchObject({
        needs: [],
        picksSetAside: [],
        purchases: [],
        outfits: [],
        wears: [],
      });
    });
  });

  describe('get_closet_coverage', () => {
    it('judges targets against the closet: owned, missing, and why', async () => {
      const answer = await tool<{
        targets: {
          target: number;
          status: string;
          fulfilledBy: { id: number; name: string | null }[];
          reason: string | null;
        }[];
      }>(t, token, 'get_closet_coverage', {
        targets: [
          { category: 'bottoms' },
          { category: 'outerwear', type: 'blazer', quantity: 2 },
        ],
      });
      expect(answer.targets).toEqual([
        expect.objectContaining({
          target: 0,
          status: 'owned',
          fulfilledBy: [
            expect.objectContaining({ id: jeans, name: 'Raw jeans' }),
          ],
          reason: null,
        }),
        expect.objectContaining({
          target: 1,
          status: 'missing',
          fulfilledBy: [],
          reason: 'nothing-matches',
        }),
      ]);
    });

    // The closet as get_wardrobe reads it (garmentSummaries, CLOSET_FILTERS),
    // oldest first as plans' closetPieces was: another user's, so the shared
    // closet above stays as it is.
    it('reads only the closet, counts copies, reports replace_soon and names takers oldest first', async () => {
      const cookie = await t.register('coverage@example.com');
      const coverageToken = await createAccessToken(t, { cookie });
      const userId = await userIdOf(t, 'coverage@example.com');
      const bottom = (name: string) =>
        createGarment(t, { name, category: 'bottoms', cookie });
      const oldChinos = await bottom('Old chinos');
      const twinJeans = await bottom('Twin jeans');
      const wornChinos = await bottom('Worn chinos');
      const archived = await bottom('Archived chinos');
      const wanted = await createWishlistItem(t, {
        name: 'Wanted chinos',
        category: 'bottoms',
        cookie,
      });
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({ quantity: 2 })
          .where(eq(garment.id, twinJeans)),
      );
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({ condition: 'replace_soon' })
          .where(eq(garment.id, wornChinos)),
      );
      expect(
        (await setGarmentStatus(t.db, archived, userId, { event: 'archive' }))
          .ok,
      ).toBe(true);

      const answer = await tool<{
        targets: {
          status: string;
          have: number;
          need: number;
          fulfilledBy: { id: number; copies: number }[];
          replaceSoon: { id: number }[];
          takenBy: { id: number; target: number }[];
          reason: string | null;
        }[];
      }>(t, coverageToken, 'get_closet_coverage', {
        targets: [
          { category: 'bottoms', quantity: 2 },
          { category: 'bottoms' },
        ],
      });
      const [pair, another] = answer.targets;
      // The ×2 jeans count 2: with the old chinos, 3 copies for 2 wanted.
      expect(pair).toMatchObject({ status: 'owned', have: 3, need: 2 });
      expect(pair.fulfilledBy).toEqual([
        expect.objectContaining({ id: oldChinos, copies: 1 }),
        expect.objectContaining({ id: twinJeans, copies: 2 }),
      ]);
      expect(pair.replaceSoon.map((g) => g.id)).toEqual([wornChinos]);
      // Both taken by the first target, named oldest first.
      expect(another).toMatchObject({
        status: 'missing',
        reason: 'replace-soon',
      });
      expect(another.takenBy).toEqual([
        expect.objectContaining({ id: oldChinos, target: 0 }),
        expect.objectContaining({ id: twinJeans, target: 0 }),
      ]);
      // The archive and the wishlist are not the closet.
      const named = JSON.stringify(answer);
      expect(named).not.toContain('Archived chinos');
      expect(named).not.toContain('Wanted chinos');
      for (const id of [archived, wanted]) {
        expect(named).not.toContain(`"id":${id},`);
      }
    });

    it('refuses a type of another category and a range upside down', async () => {
      const type = await callTool(t, token, 'get_closet_coverage', {
        targets: [{ category: 'tops', type: 'jeans' }],
      });
      expect(type.isError).toBe(true);
      const range = await callTool(t, token, 'get_closet_coverage', {
        targets: [{ category: 'tops', warmth: { min: 4, max: 2 } }],
      });
      expect(range.value.error).toBe('warmth: min is above max');
    });
  });

  it('lists none of the plans’ tools, retired with plans (#337)', async () => {
    const res = await mcpRequest(t, token, 'tools/list');
    const listed = res
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((listedTool) => listedTool.name);
    for (const name of [
      'create_plan',
      'propose_plan_item',
      'update_plan_item',
      'list_plans',
      'get_plan_gaps',
      'get_plan_feedback',
      'get_shopping_list',
      'add_candidate',
      'update_candidate',
      'compare_plans',
      'list_looks',
      'propose_look',
      'update_look',
    ]) {
      expect(listed).not.toContain(name);
    }
  });

  it('never marks anything owned: a suggestion leaves the wishlist only through Bought it', async () => {
    const owned = await t.db
      .select({ id: garment.id, boughtAt: garment.boughtAt })
      .from(garment)
      .where(
        and(
          isNotNull(garment.suggestedAt),
          eq(garment.status, 'closet'),
          eq(garment.ownerId, t.owner.id),
        ),
      );
    // The belt bag and the scarf, which the owner bought in the app.
    expect(owned).toHaveLength(2);
    for (const row of owned) expect(row.boughtAt).not.toBeNull();
  });
});
