import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  optionGroup,
  outfitSlot,
  personalAccessToken,
} from '../../src/db/schema';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { createGarment, createWishlistItem, garmentRow } from './garments';
import {
  createTestApp,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
} from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * The agent's suggestions, phase 1A (#333): the provenance writer's wishlist
 * rule, every decision's rows through the one writer (decide), "Bought it"
 * settling a suggestion's group, and the wishlist's exclusion rule held
 * for suggestions in every state: no closet read shows one, and no list of
 * things to buy shows one set aside. Dismissal never deletes.
 */

describe('suggestions', () => {
  let t: TestApp;
  let ownerId: number;
  let tokenId: number;
  let mcpToken: string;
  let jeans: number;
  let tee: number;
  let outfitId: number;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  async function group(name: string): Promise<number> {
    const [row] = await t.db
      .insert(optionGroup)
      .values({ ownerId, name, suggestedByTokenId: tokenId })
      .returning({ id: optionGroup.id });
    return row.id;
  }

  /** A wishlist garment marked as the agent's pick of `groupId`, ranked `rank`. */
  async function pick(
    name: string,
    groupId: number | null,
    rank: number | null = null,
  ): Promise<number> {
    const id = await createWishlistItem(t, {
      name,
      category: 'tops',
      price: '120',
      sourceUrl: `https://shop.example/${encodeURIComponent(name)}`,
    });
    expect(
      await markSuggestion(t.db, ownerId, id, {
        tokenId,
        groupId,
        note: `Why ${name}`,
        rank,
      }),
    ).toBe('marked');
    return id;
  }

  const groupRow = async (id: number) =>
    (await t.db.select().from(optionGroup).where(eq(optionGroup.id, id)))[0];

  const dismissal = async (id: number) => {
    const row = await garmentRow(t, id);
    return {
      status: row?.status,
      reason: row?.dismissedReason ?? null,
      note: row?.dismissedNote ?? null,
      at: row?.dismissedAt ?? null,
    };
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = t.owner.id;
    mcpToken = await createAccessToken(t, { name: 'Stylist' });
    const [token] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, ownerId));
    tokenId = token.id;
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    const saved = await post('/outfits', {
      name: 'Tee and jeans',
      category: ['tops', 'bottoms'],
      garmentId: [String(tee), String(jeans)],
    });
    outfitId = Number(
      /\/outfits\/(\d+)/.exec(String(saved.headers.location))![1],
    );
  });

  afterAll(() => t?.cleanup());

  describe('provenance (markSuggestion)', () => {
    it('is written only on the owner’s wishlist garment, once, into their own group', async () => {
      const tee = await createGarment(t, {
        name: 'Grey tee',
        category: 'tops',
      });
      const own = await group('A grey tee');
      const provenance = { tokenId, groupId: own, note: 'n', rank: 1 };
      expect(await markSuggestion(t.db, ownerId, tee, provenance)).toBe(
        'refused',
      );
      const wish = await createWishlistItem(t, {
        name: 'Ecru tee',
        category: 'tops',
      });
      await t.register('other-suggestions@example.com');
      const otherId = await userIdOf(t, 'other-suggestions@example.com');
      const [theirs] = await t.db
        .insert(optionGroup)
        .values({ ownerId: otherId, name: 'Theirs' })
        .returning({ id: optionGroup.id });
      expect(
        await markSuggestion(t.db, ownerId, wish, {
          ...provenance,
          groupId: theirs.id,
        }),
      ).toBe('refused');
      expect(await markSuggestion(t.db, ownerId, wish, provenance)).toBe(
        'marked',
      );
      expect(await markSuggestion(t.db, ownerId, wish, provenance)).toBe(
        'refused',
      );
      expect(await garmentRow(t, tee)).toMatchObject({
        suggestedAt: null,
        suggestionGroupId: null,
      });
      // A need decided, or one holding its five open options, takes no more.
      const closed = await group('Closed need');
      await decide(t.db, ownerId, {
        kind: 'dismiss-group',
        groupId: closed,
        reason: 'not_now',
        note: null,
      });
      const late = await createWishlistItem(t, {
        name: 'Late option',
        category: 'tops',
      });
      expect(
        await markSuggestion(t.db, ownerId, late, {
          ...provenance,
          groupId: closed,
        }),
      ).toBe('refused');
      const crowded = await group('Crowded need');
      for (let rank = 1; rank <= 5; rank++) {
        await pick(`Crowded ${rank}`, crowded, rank);
      }
      expect(
        await markSuggestion(t.db, ownerId, late, {
          ...provenance,
          groupId: crowded,
        }),
      ).toBe('full');
      expect((await garmentRow(t, late))?.suggestedAt).toBeNull();
      // The database's backstop: no provenance without suggested_at.
      await expect(
        asFixture(t.db, (tx) =>
          tx
            .update(garment)
            .set({ suggestionNote: 'sneaked in' })
            .where(eq(garment.id, tee)),
        ),
      ).rejects.toThrow();
    });
  });

  describe('decisions (decide)', () => {
    it('This one resolves the group and sets its other open picks aside at that instant; Undo restores them', async () => {
      const blazer = await group('Navy blazer');
      const a = await pick('Blazer A', blazer, 1);
      const b = await pick('Blazer B', blazer, 2);
      const c = await pick('Blazer C', blazer, 3);
      expect(
        await decide(t.db, ownerId, {
          kind: 'dismiss-pick',
          garmentId: c,
          reason: 'colour',
          note: null,
        }),
      ).toMatchObject({ ok: true, dismissed: [c] });
      const before = await t.db.$count(garment);

      expect(
        await decide(t.db, ownerId, { kind: 'choose', garmentId: a }),
      ).toEqual({ ok: true, groupId: blazer, dismissed: [b], restored: [] });
      const chosen = await groupRow(blazer);
      expect(chosen).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: a,
      });
      expect(await dismissal(b)).toEqual({
        status: 'wishlist',
        reason: 'chose_another',
        note: null,
        at: chosen.decidedAt,
      });
      expect((await dismissal(a)).reason).toBeNull();
      // Nothing is deleted.
      expect(await t.db.$count(garment)).toBe(before);
      // A second tap is refused, not applied twice.
      expect(
        await decide(t.db, ownerId, { kind: 'choose', garmentId: b }),
      ).toEqual({ ok: false, reason: 'not-allowed' });

      expect(
        await decide(t.db, ownerId, { kind: 'undo-group', groupId: blazer }),
      ).toMatchObject({ ok: true, restored: [b] });
      expect(await groupRow(blazer)).toMatchObject({
        status: 'open',
        resolvedGarmentId: null,
        decidedAt: null,
      });
      expect((await dismissal(b)).reason).toBeNull();
      // The owner's own earlier "Not for me" stays.
      expect((await dismissal(c)).reason).toBe('colour');
    });

    it('Not for me records the reason and note; Undo opens the pick again', async () => {
      const coat = await group('Rain coat');
      const pickId = await pick('Coat A', coat, 1);
      await decide(t.db, ownerId, {
        kind: 'dismiss-pick',
        garmentId: pickId,
        reason: 'too_pricey',
        note: 'Over $300',
      });
      expect(await dismissal(pickId)).toMatchObject({
        status: 'wishlist',
        reason: 'too_pricey',
        note: 'Over $300',
      });
      expect(
        await decide(t.db, ownerId, { kind: 'undo-pick', garmentId: pickId }),
      ).toMatchObject({ ok: true, restored: [pickId] });
      expect(await dismissal(pickId)).toMatchObject({
        reason: null,
        note: null,
        at: null,
      });
    });

    it('Not for me on a need dismisses the group with its note; Undo reopens it', async () => {
      const need = await group('Linen shirt');
      await pick('Linen A', need, 1);
      await decide(t.db, ownerId, {
        kind: 'dismiss-group',
        groupId: need,
        reason: 'not_now',
        note: 'Next summer',
      });
      expect(await groupRow(need)).toMatchObject({
        status: 'dismissed',
        dismissedReason: 'not_now',
        ownerNote: 'Next summer',
      });
      await decide(t.db, ownerId, { kind: 'undo-group', groupId: need });
      expect(await groupRow(need)).toMatchObject({
        status: 'open',
        dismissedReason: null,
        decidedAt: null,
      });
    });

    it('refuses another owner’s group as not found', async () => {
      await t.register('stranger-suggestions@example.com');
      const need = await group('Mine alone');
      const strangerId = await userIdOf(t, 'stranger-suggestions@example.com');
      expect(
        await decide(t.db, strangerId, { kind: 'undo-group', groupId: need }),
      ).toEqual({ ok: false, reason: 'not-found' });
    });

    it('"Bought it" on a pick resolves its group and sets the others aside; Returned archives it and reopens the need', async () => {
      const boots = await group('Chelsea boots');
      const a = await pick('Boots A', boots, 1);
      const b = await pick('Boots B', boots, 2);
      await decide(t.db, ownerId, { kind: 'choose', garmentId: b });
      const res = await post(`/wardrobe/${a}/bought`, {
        acquiredOn: t.today(),
        price: '180',
      });
      expect(res.statusCode).toBe(303);
      expect(await groupRow(boots)).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: a,
      });
      // The chosen one too: the owner bought another.
      expect((await dismissal(b)).reason).toBe('chose_another');
      // Provenance is kept on the owned garment.
      expect(await garmentRow(t, a)).toMatchObject({
        status: 'closet',
        suggestionGroupId: boots,
        addedByTokenId: tokenId,
      });

      expect(
        await decide(t.db, ownerId, { kind: 'returned', garmentId: a }),
      ).toMatchObject({ ok: true, dismissed: [a] });
      expect(await dismissal(a)).toMatchObject({
        status: 'archived',
        reason: 'returned',
      });
      expect(await groupRow(boots)).toMatchObject({
        status: 'open',
        resolvedGarmentId: null,
      });
    });

    it('a different one bought resolves the group with that garment', async () => {
      const scarf = await group('Wool scarf');
      const a = await pick('Scarf A', scarf, 1);
      const mine = await createGarment(t, {
        name: 'Scarf from the market',
        category: 'scarves',
      });
      expect(
        await decide(t.db, ownerId, {
          kind: 'bought',
          groupId: scarf,
          garmentId: mine,
        }),
      ).toMatchObject({ ok: true, dismissed: [a] });
      expect(await groupRow(scarf)).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: mine,
      });
      expect(await garmentRow(t, mine)).toMatchObject({
        suggestedAt: null,
        suggestionGroupId: null,
      });
    });
  });

  describe('more decisions', () => {
    it('buying a pick that was set aside makes it the clean answer, and sets the chosen one aside', async () => {
      const coat = await group('Overcoat');
      const a = await pick('Overcoat A', coat, 1);
      const b = await pick('Overcoat B', coat, 2);
      await decide(t.db, ownerId, { kind: 'choose', garmentId: a });
      expect((await dismissal(b)).reason).toBe('chose_another');
      const res = await post(`/wardrobe/${b}/bought`, {
        acquiredOn: t.today(),
        price: '300',
      });
      expect(res.statusCode).toBe(303);
      expect(await dismissal(b)).toEqual({
        status: 'closet',
        reason: null,
        note: null,
        at: null,
      });
      expect((await dismissal(a)).reason).toBe('chose_another');
      expect(await groupRow(coat)).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: b,
      });
    });

    it('Not for me on the chosen pick reopens the need with the options its choice set aside', async () => {
      const need = await group('Belt');
      const a = await pick('Belt A', need, 1);
      const b = await pick('Belt B', need, 2);
      await decide(t.db, ownerId, { kind: 'choose', garmentId: a });
      expect(
        await decide(t.db, ownerId, {
          kind: 'dismiss-pick',
          garmentId: a,
          reason: 'fit_size',
          note: null,
        }),
      ).toMatchObject({ ok: true, dismissed: [a], restored: [b] });
      expect(await groupRow(need)).toMatchObject({ status: 'open' });
      expect((await dismissal(b)).reason).toBeNull();
      expect((await dismissal(a)).reason).toBe('fit_size');
    });

    it('a purchase settles a group only with a garment of the owner’s in the closet', async () => {
      const need = await group('Gloves');
      await pick('Gloves A', need, 1);
      const wished = await createWishlistItem(t, {
        name: 'Gloves not bought',
        category: 'accessories',
      });
      await t.register('glove-stranger@example.com');
      const strangerId = await userIdOf(t, 'glove-stranger@example.com');
      const [theirs] = await asFixture(t.db, (tx) =>
        tx
          .insert(garment)
          .values({
            shareableId: 'glove-stranger',
            category: 'accessories',
            ownerId: strangerId,
          })
          .returning({ id: garment.id }),
      );
      expect(
        await decide(t.db, ownerId, {
          kind: 'bought',
          groupId: need,
          garmentId: wished,
        }),
      ).toEqual({ ok: false, reason: 'not-allowed' });
      expect(
        await decide(t.db, ownerId, {
          kind: 'bought',
          groupId: need,
          garmentId: theirs.id,
        }),
      ).toEqual({ ok: false, reason: 'not-found' });
      expect(await groupRow(need)).toMatchObject({ status: 'open' });
    });
  });

  describe('a suggestion is never deleted', () => {
    it('DELETE answers 409 for a suggestion and keeps it; a plain wishlist item still goes', async () => {
      const need = await group('Socks');
      const kept = await pick('Socks A', need, 1);
      const res = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/${kept}`,
      });
      expect(res.statusCode).toBe(409);
      expect(await garmentRow(t, kept)).toBeDefined();
      const plain = await createWishlistItem(t, {
        name: 'Plain socks',
        category: 'accessories',
      });
      const gone = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/${plain}`,
      });
      expect(gone.statusCode).toBeLessThan(400);
      expect(await garmentRow(t, plain)).toBeUndefined();
    });

    it('a bought pick is an ordinary garment: it can be deleted, and its group can still be undone', async () => {
      const need = await group('Cap');
      const a = await pick('Cap A', need, 1);
      const b = await pick('Cap B', need, 2);
      const bought = await post(`/wardrobe/${a}/bought`, {
        acquiredOn: t.today(),
        price: '30',
      });
      expect(bought.statusCode).toBe(303);
      const res = await t.inject({ method: 'DELETE', url: `/wardrobe/${a}` });
      expect(res.statusCode).toBeLessThan(400);
      expect(await garmentRow(t, a)).toBeUndefined();
      // The foreign key nulled what resolved it: the undo still reopens it.
      expect(await groupRow(need)).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: null,
      });
      expect(
        await decide(t.db, ownerId, { kind: 'undo-group', groupId: need }),
      ).toMatchObject({ ok: true, restored: [b] });
      expect(await groupRow(need)).toMatchObject({ status: 'open' });
      expect((await dismissal(b)).reason).toBeNull();
    });
  });

  describe('are out of every closet read, in every state', () => {
    let open: number;
    let chosen: number;
    let setAside: number;
    let lone: number;

    beforeAll(async () => {
      const knit = await group('Merino knit');
      open = await pick('Suggested knit open', knit, 1);
      const cardigan = await group('Cardigan');
      chosen = await pick('Suggested cardigan chosen', cardigan, 1);
      setAside = await pick('Suggested cardigan aside', cardigan, 2);
      await decide(t.db, ownerId, { kind: 'choose', garmentId: chosen });
      lone = await pick('Suggested lone pick', null);
      await decide(t.db, ownerId, {
        kind: 'dismiss-pick',
        garmentId: lone,
        reason: 'style',
        note: null,
      });
    });

    // Each page shows an owned garment by name (its control), so the
    // absence of every suggestion, all named "Suggested …", means something.
    async function expectOnlyOwned(pages: [url: string, owned: string][]) {
      for (const [url, owned] of pages) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(200);
        const html = unescapeHtml(res.body);
        expect(html, url).toContain(owned);
        expect(html, url).not.toContain('Suggested');
      }
    }

    it('the grid, Styling, capsules, tagging, Ideas, Today and insights', async () => {
      const capsule = await post('/capsules', { name: 'Everyday' });
      const capsuleId = Number(
        /^\/capsules\/(\d+)/.exec(String(capsule.headers.location))![1],
      );
      await post(`/capsules/${capsuleId}/garments`, {
        ids: [tee],
        shown: [tee],
      });
      // Tagging shows one card, the newest closet garment needing details:
      // none here has a type.
      const [newest] = await t.db
        .select({ name: garment.name })
        .from(garment)
        .where(and(eq(garment.ownerId, ownerId), eq(garment.status, 'closet')))
        .orderBy(desc(garment.id))
        .limit(1);
      await expectOnlyOwned([
        ['/wardrobe', 'Raw jeans'],
        ['/wardrobe?archived=true', 'Raw jeans'],
        ['/wardrobe/tiles?before=2147483647', 'Raw jeans'],
        ['/styling', 'White tee'],
        ['/styling/garments?role=top&before=2147483647', 'White tee'],
        [`/capsules/${capsuleId}`, 'White tee'],
        ['/wardrobe/tag', newest.name!],
        // Every idea wears the closet's only bottoms (clean, so before the
        // wear below).
        ['/outfits/ideas', 'Raw jeans'],
        ['/', 'Raw jeans'],
        ['/wardrobe/insights', 'Raw jeans'],
      ]);
    });

    it('laundry, the week planner and its calendar, and a trip’s packing list', async () => {
      // Laundry lists what was worn.
      await post(`/wardrobe/${jeans}/wear`, { worn: '1' });
      // The week planner plans every day of a set week.
      await post(
        '/auth/profile/week',
        Object.fromEntries(
          [0, 1, 2, 3, 4, 5, 6].map((day) => [`day-${day}`, 'all-day']),
        ),
      );
      const planned = await post('/calendar/plan-week', {});
      expect(planned.statusCode).toBe(303);
      const trip = await post('/trips', {
        name: 'Weekend away',
        destination: '',
        startsOn: t.today(),
        endsOn: t.today(),
        notes: '',
      });
      const tripId = Number(
        /^\/trips\/(\d+)/.exec(String(trip.headers.location))![1],
      );
      await post(`/trips/${tripId}/outfits`, {
        outfitId: String(outfitId),
        day: '',
        occasion: '',
      });
      await expectOnlyOwned([
        ['/laundry', 'Raw jeans'],
        // The planner's outfits, each with the closet's only bottoms.
        [String(planned.headers.location), 'Raw jeans'],
        [`/trips/${tripId}`, 'Raw jeans'],
      ]);
    });

    it('cannot be worn, washed or lent, nor planned in an outfit', async () => {
      for (const id of [open, chosen, setAside, lone]) {
        for (const [action, payload] of [
          ['wear', { worn: '1' }],
          ['washed', {}],
          ['away', { away: 'lent' }],
        ] as const) {
          const res = await post(`/wardrobe/${id}/${action}`, payload);
          expect(res.statusCode, `${action} ${id}`).toBe(409);
        }
      }
      // An outfit holds one only incomplete, never planned (#335;
      // incomplete-outfits.spec.ts): a save planned on a day writes nothing.
      const before = await t.db.$count(outfitSlot);
      const res = await post('/outfits', {
        name: 'With a pick',
        category: ['tops', 'bottoms'],
        garmentId: [String(chosen), String(jeans)],
        scheduleDate: t.today(),
      });
      expect(res.statusCode).toBe(409);
      expect(await t.db.$count(outfitSlot)).toBe(before);
    });

    it('MCP’s closet reads never list one', async () => {
      const searched = await tool<{ garments: { name: string | null }[] }>(
        t,
        mcpToken,
        'search_garments',
      );
      const wardrobe = await tool<{ garments: { name: string | null }[] }>(
        t,
        mcpToken,
        'get_wardrobe',
      );
      for (const { garments } of [searched, wardrobe]) {
        expect(garments.map((g) => g.name)).toContain('Raw jeans');
        expect(garments.filter((g) => g.name?.startsWith('Suggested'))).toEqual(
          [],
        );
      }
    });

    it('lists of things to buy leave out what was set aside: the Wishlist tab and list_wishlist', async () => {
      const page = unescapeHtml((await get('/wardrobe/wishlist')).body);
      // What is set aside is only under "N set aside", to be undone (#333).
      const cut = page.indexOf('data-inbox-section="set-aside"');
      const live = cut === -1 ? page : page.slice(0, cut);
      expect(live).toContain('Suggested knit open');
      expect(live).toContain('Suggested cardigan chosen');
      expect(live).not.toContain('Suggested cardigan aside');
      expect(live).not.toContain('Suggested lone pick');
      expect(page.slice(cut)).toContain('Suggested lone pick');
      const listed = await tool<{ items: { name: string | null }[] }>(
        t,
        mcpToken,
        'list_wishlist',
      );
      const names = listed.items.map((i) => i.name);
      expect(names).toContain('Suggested knit open');
      expect(names).not.toContain('Suggested cardigan aside');
      expect(names).not.toContain('Suggested lone pick');
      // Set aside, never deleted: the rows are all there.
      const rows = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(inArray(garment.id, [open, chosen, setAside, lone]));
      expect(rows).toHaveLength(4);
    });

    it('Styling’s Include picks leaves out the one set aside', async () => {
      const styling = unescapeHtml((await get('/styling?picks=1')).body);
      expect(styling).toContain('Suggested knit open');
      expect(styling).not.toContain('Suggested cardigan aside');
    });
  });
});
