import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  outfit,
  outfitCalendar,
  personalAccessToken,
} from '../../src/db/schema';
import { wearOutfitOn } from '../../src/web/calendar/queries';
import { createGarment, createWishlistItem } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * The agent's outfits on the Outfits tab (#335, docs/plans/2026-10-05-agent-
 * suggestions.md section 4 B): ordinary outfits the agent proposed
 * (outfit.proposed_at). From the agent is its own section, the owner's grid
 * and pickers keep to their own (ownersOutfit); each card leads with one
 * primary by where the outfit stands; Love (Save once complete), Not for
 * me with a reason and Undo go through the one writer (reactToOutfit);
 * Bought it makes a loved outfit the owner's; a proposal is never deleted.
 * The migration that made plan looks these outfits is
 * agent-outfits-migration.spec.ts (retired 2026-10-13)'s.
 */
describe('the agent’s outfits (#335)', () => {
  let t: TestApp;
  let tokenId: number;
  let mcpToken: string;
  let tee: number;
  let jeans: number;
  let shoes: number;
  let blazer: number;
  let knit: number;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  /** An outfit of these garments, proposed by the agent with `reaction`. */
  const proposed = async (
    name: string,
    garments: number[],
    reaction: 'proposed' | 'loved' | 'revise' | 'declined' = 'proposed',
    at = new Date(),
  ) => {
    const res = await post('/outfits', {
      name,
      notes: '',
      category: garments.map(() => 'tops'),
      garmentId: garments.map(String),
    });
    expect(res.statusCode, res.body).toBe(302);
    const id = Number(
      /^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1],
    );
    await asFixture(t.db, (tx) =>
      tx
        .update(outfit)
        .set({
          proposedAt: at,
          addedByTokenId: tokenId,
          proposalNote: `Why ${name}`,
          reaction,
          ownerNote: reaction === 'revise' ? 'Warmer, please' : null,
          dismissedReason: reaction === 'declined' ? 'colour' : null,
        })
        .where(eq(outfit.id, id)),
    );
    return id;
  };

  const rowOf = async (id: number) =>
    (await t.db.select().from(outfit).where(eq(outfit.id, id)))[0];

  /** One card's markup on the tab: up to the next card. */
  const cardOf = (html: string, id: number) => {
    const start = html.indexOf(`data-agent-outfit="${id}"`);
    if (start === -1) return undefined;
    const next = html.indexOf('data-agent-outfit="', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
  };

  const primaryOf = (html: string, id: number) =>
    /data-agent-primary="([a-z]+)"/.exec(cardOf(html, id) ?? '')?.[1];

  const tab = async () => unescapeHtml((await get('/outfits')).body);

  /** A closet accessory of its own: a garment set no earlier test saved (a save of one reuses it). */
  let belts = 0;
  const belt = () =>
    createGarment(t, { name: `Belt ${++belts}`, category: 'accessories' });

  beforeAll(async () => {
    t = await createTestApp();
    mcpToken = await createAccessToken(t, { name: 'Stylist' });
    const [token] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, t.owner.id));
    tokenId = token.id;
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    shoes = await createGarment(t, {
      name: 'Canvas shoes',
      category: 'footwear',
    });
    blazer = await createWishlistItem(t, {
      name: 'Wool blazer',
      category: 'outerwear',
      price: '280',
    });
    knit = await createWishlistItem(t, { name: 'Grey knit', category: 'tops' });
  });

  afterAll(() => t?.cleanup());

  describe('the tab', () => {
    it('shows the agent’s outfits first, as cards, newest first; the grid and the pickers keep to the owner’s', async () => {
      const own = await post('/outfits', {
        name: 'My own',
        notes: '',
        category: ['tops', 'bottoms'],
        garmentId: [tee, jeans].map(String),
      });
      const ownId = Number(
        /^\/outfits\/(\d+)$/.exec(String(own.headers.location))![1],
      );
      const older = await proposed(
        'Older look',
        [blazer, tee],
        'proposed',
        new Date(Date.now() - 60_000),
      );
      const newer = await proposed('Newer look', [knit, jeans]);
      // Complete, but the agent's until saved: never in a picker either.
      const completePending = await proposed(
        'Complete, not saved',
        [tee, jeans, shoes],
        'proposed',
        new Date(Date.now() - 120_000),
      );
      const html = await tab();
      expect(html).toContain('From Stylist');
      expect(html.indexOf(`data-agent-outfit="${newer}"`)).toBeLessThan(
        html.indexOf(`data-agent-outfit="${older}"`),
      );
      expect(html).toContain('Your outfits');
      // The grid's tiles: the owner's only.
      const grid = html.slice(html.indexOf('id="saved-outfits"'));
      expect(grid).toContain(`data-outfit-id="${ownId}"`);
      expect(grid).not.toContain(`data-outfit-id="${newer}"`);
      // Picking for a day: no section, and only the owner's outfits.
      const picking = unescapeHtml(
        (await get(`/outfits?for=day:${t.today()}&occasion=all-day`)).body,
      );
      expect(picking).not.toContain('data-agent-outfits');
      expect(picking).not.toContain(`value="${newer}"`);
      expect(picking).not.toContain(`value="${completePending}"`);
      const plan = unescapeHtml(
        (await get(`/calendar/plan?for=day:${t.today()}&occasion=all-day`))
          .body,
      );
      expect(plan).toContain(`value="${ownId}"`);
      expect(plan).not.toContain(`value="${newer}"`);
      expect(plan).not.toContain(`value="${completePending}"`);
      const tripPicker = await post('/trips', {
        name: 'Picker trip',
        destination: '',
        startsOn: t.today(),
        endsOn: t.today(),
        notes: '',
      });
      const tripId = Number(
        /^\/trips\/(\d+)/.exec(String(tripPicker.headers.location))![1],
      );
      const add = unescapeHtml(
        (await get(`/trips/${tripId}/outfits/new`)).body,
      );
      expect(add).toContain(`value="${ownId}"`);
      expect(add).not.toContain(`value="${completePending}"`);
      // The garment page's outfits: the owner's only.
      const jeansPage = unescapeHtml((await get(`/wardrobe/${jeans}`)).body);
      expect(jeansPage).not.toContain('Newer look');
    });

    it('each card leads with one primary, by where the outfit stands', async () => {
      const complete = await proposed('Complete one', [tee, shoes]);
      const loved = await proposed(
        'Loved, to buy',
        [blazer, jeans, shoes],
        'loved',
      );
      const revise = await proposed('Sent back', [knit, shoes], 'revise');
      const cardigan = await createWishlistItem(t, {
        name: 'Navy cardigan',
        category: 'outerwear',
      });
      const replace = await proposed('With a piece set aside', [
        cardigan,
        jeans,
      ]);
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({ dismissedAt: new Date(), dismissedReason: 'colour' })
          .where(eq(garment.id, cardigan)),
      );
      const html = await tab();
      expect(primaryOf(html, complete)).toBe('save');
      expect(primaryOf(html, loved)).toBe('choose');
      expect(primaryOf(html, revise)).toBe('love');
      expect(cardOf(html, revise)).toContain('You asked: Warmer, please');
      expect(primaryOf(html, replace)).toBe('replace');
      expect(cardOf(html, replace)).toContain(
        'Needs a replacement: Navy cardigan was set aside',
      );
      // A piece to buy wears its price, and says what it unlocks.
      const card = cardOf(html, loved)!;
      expect(card).toContain('$280');
      expect(card).toMatch(
        /data-unlocks-link=""[^>]*>[^<]*(Unlocks|Goes with|outfit)/i,
      );
    });

    it('costs one statement after the session, sections and unlocks included', async () => {
      const recorded = await recordQueries(() => get('/outfits'));
      expect(recorded.statements).toBe(2);
    });

    it('keeps bare /outfits byte-stable', async () => {
      expect((await get('/outfits')).body).toBe((await get('/outfits')).body);
    });
  });

  describe('reactions (reactToOutfit)', () => {
    it('Love keeps an incomplete outfit in the agent’s section, loved; Bought it makes it the owner’s', async () => {
      const coat = await createWishlistItem(t, {
        name: 'Rain coat',
        category: 'outerwear',
      });
      const id = await proposed('Rainy day', [coat, tee]);
      const res = await post(`/outfits/${id}/love`, { returnTo: '/outfits' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/outfits?decided=love');
      const row = await rowOf(id);
      expect(row.reaction).toBe('loved');
      expect(row.reactedAt).toBeInstanceOf(Date);
      expect(primaryOf(await tab(), id)).toBe('choose');
      const bought = await post(`/wardrobe/${coat}/bought`, {
        acquiredOn: t.today(),
        price: '150',
      });
      expect(bought.statusCode).toBe(303);
      const html = await tab();
      expect(cardOf(html, id)).toBeUndefined();
      expect(html.slice(html.indexOf('id="saved-outfits"'))).toContain(
        `data-outfit-id="${id}"`,
      );
    });

    it('Save on a complete outfit makes it the owner’s at once', async () => {
      const id = await proposed('Plain day', [jeans, shoes]);
      const res = await post(`/outfits/${id}/love`, {});
      expect(res.headers.location).toBe('/outfits?decided=save');
      const html = await tab();
      expect(cardOf(html, id)).toBeUndefined();
      expect(html).toContain(`data-outfit-id="${id}"`);
    });

    it('Not for me takes a reason (400 without), keeps the outfit set aside, and Undo brings it back', async () => {
      const id = await proposed('Too loud', [knit, tee]);
      expect(
        (await post(`/outfits/${id}/dismiss`, { note: 'no' })).statusCode,
      ).toBe(400);
      const res = await post(`/outfits/${id}/dismiss`, {
        reason: 'style',
        note: ' Not me ',
      });
      expect(res.headers.location).toBe('/outfits?decided=dismiss');
      expect(await rowOf(id)).toMatchObject({
        reaction: 'declined',
        dismissedReason: 'style',
        ownerNote: 'Not me',
      });
      const html = await tab();
      expect(cardOf(html, id)).toBeUndefined();
      expect(html).toMatch(
        new RegExp(
          `data-agent-set-aside-outfit="${id}"[\\s\\S]*?Too loud[\\s\\S]*?The style`,
        ),
      );
      const undo = await post(`/outfits/${id}/undo`, {});
      expect(undo.headers.location).toBe('/outfits?decided=undo');
      expect(await rowOf(id)).toMatchObject({
        reaction: 'proposed',
        dismissedReason: null,
        ownerNote: null,
      });
    });

    it('refuses a move its reaction does not take (409), and a non-proposal or another’s (404)', async () => {
      const id = await proposed('Loved already', [tee, jeans, blazer], 'loved');
      expect((await post(`/outfits/${id}/love`, {})).statusCode).toBe(409);
      expect((await post(`/outfits/${id}/undo`, {})).statusCode).toBe(409);
      const own = await post('/outfits', {
        name: 'Not a proposal',
        notes: '',
        category: ['tops'],
        garmentId: [String(shoes)],
      });
      const ownId = Number(
        /^\/outfits\/(\d+)$/.exec(String(own.headers.location))![1],
      );
      expect((await post(`/outfits/${ownId}/love`, {})).statusCode).toBe(404);
      const stranger = await t.register('stranger-agent@example.com');
      const theirs = await t.inject({
        method: 'POST',
        url: `/outfits/${id}/dismiss`,
        payload: { reason: 'style' },
        headers: { cookie: stranger },
      });
      expect(theirs.statusCode).toBe(404);
      expect((await rowOf(id)).reaction).toBe('loved');
    });

    it('goes back to a safe page only', async () => {
      const id = await proposed('Redirected', [knit, tee, shoes]);
      const res = await post(`/outfits/${id}/love`, {
        returnTo: 'https://evil.example/',
      });
      expect(res.headers.location).toBe('/outfits?decided=love');
    });
  });

  describe('the outfit page and delete', () => {
    it('says it is the agent’s, offers the card’s moves, and hides Delete until loved', async () => {
      const id = await proposed('Office blazer', [blazer, shoes]);
      const page = unescapeHtml((await get(`/outfits/${id}`)).body);
      expect(page).toContain('From Stylist');
      expect(page).toContain('Why Office blazer');
      expect(page).toContain(`action="/outfits/${id}/love"`);
      expect(page).toContain(`action="/outfits/${id}/dismiss"`);
      expect(page).not.toContain(`hx-delete="/outfits/${id}"`);
      const refused = await t.inject({
        method: 'DELETE',
        url: `/outfits/${id}`,
      });
      expect(refused.statusCode).toBe(409);
      expect(await rowOf(id)).toBeDefined();
      await post(`/outfits/${id}/love`, {});
      const loved = unescapeHtml((await get(`/outfits/${id}`)).body);
      expect(loved).toContain(`hx-delete="/outfits/${id}"`);
    });
  });

  describe('what may be held: complete, and the owner’s (outfitMayBeHeld)', () => {
    it('a complete proposal not saved is never planned or packed, and its page offers no Plan', async () => {
      const id = await proposed('Complete proposal', [
        shoes,
        tee,
        await belt(),
      ]);
      const planned = await post('/calendar', {
        outfitId: id,
        date: t.today(),
      });
      expect(planned.statusCode).toBe(409);
      expect(unescapeHtml(planned.body)).toContain(
        'Save it first: suggested outfits are planned or packed once they’re yours.',
      );
      const trip = await post('/trips', {
        name: 'Proposal trip',
        destination: '',
        startsOn: t.today(),
        endsOn: t.today(),
        notes: '',
      });
      const tripId = Number(
        /^\/trips\/(\d+)/.exec(String(trip.headers.location))![1],
      );
      const packed = await post(`/trips/${tripId}/outfits`, {
        outfitId: id,
        day: '',
        occasion: '',
      });
      expect(packed.statusCode).toBe(409);
      const page = unescapeHtml((await get(`/outfits/${id}`)).body);
      expect(page).not.toContain('data-outfit-plan=""');
      expect(page).not.toContain('id="outfit-plan-sheet"');
      expect(page).toContain(`action="/outfits/${id}/love"`);
    });

    it('a replace and a wear refuse it too (setEntryOutfit, planToWear)', async () => {
      const id = await proposed('Not yours, replaced', [
        tee,
        shoes,
        await belt(),
      ]);
      const own = await post('/outfits', {
        name: 'Own, planned',
        notes: '',
        category: ['tops', 'accessories'],
        garmentId: [tee, await belt()].map(String),
        scheduleDate: t.today(),
      });
      expect(own.statusCode).toBe(302);
      const [entry] = await t.db
        .select({ id: outfitCalendar.id, outfitId: outfitCalendar.outfitId })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.day, t.today()))
        .orderBy(desc(outfitCalendar.id))
        .limit(1);
      const replaced = await post('/calendar', {
        outfitId: id,
        date: t.today(),
        replace: entry.id,
      });
      expect(replaced.statusCode).toBe(409);
      expect(unescapeHtml(replaced.body)).toContain('Save it first');
      const [kept] = await t.db
        .select({ outfitId: outfitCalendar.outfitId })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.id, entry.id));
      expect(kept.outfitId).toBe(entry.outfitId);
      await expect(
        wearOutfitOn(t.db, {
          ownerId: t.owner.id,
          outfitId: id,
          day: t.today(),
          occasion: 'all-day',
          at: new Date(),
          today: t.today(),
        }),
      ).rejects.toMatchObject({ name: 'OutfitNotYours', statusCode: 409 });
      expect(
        await t.db
          .select({ id: outfitCalendar.id })
          .from(outfitCalendar)
          .where(eq(outfitCalendar.outfitId, id)),
      ).toEqual([]);
    });

    it('a save of an incomplete proposal’s set with a day is refused whole: the proposal stays pending', async () => {
      const extra = await belt();
      const id = await proposed('Still pending', [blazer, jeans, extra]);
      const res = await post('/outfits', {
        name: 'Same set, planned',
        notes: '',
        category: ['outerwear', 'bottoms', 'accessories'],
        garmentId: [blazer, jeans, extra].map(String),
        scheduleDate: t.today(),
      });
      expect(res.statusCode).toBe(409);
      expect(await rowOf(id)).toMatchObject({
        reaction: 'proposed',
        reactedAt: null,
      });
    });

    it('a save of its set says it saved the agent’s outfit, not "Already saved"', async () => {
      const extra = await belt();
      const id = await proposed('Saved from Stylist', [jeans, extra]);
      const res = await post('/outfits', {
        name: 'Mine now',
        notes: '',
        category: ['bottoms', 'accessories'],
        garmentId: [jeans, extra].map(String),
      });
      expect(res.headers.location).toBe(`/outfits/${id}?alreadySaved=agent`);
      const page = unescapeHtml((await get(String(res.headers.location))).body);
      expect(page).toContain('Saved the suggested outfit: it’s yours now');
      expect(page).not.toContain('Already saved');
    });

    it('a Styling save of its garments with a day adopts it: loved, then planned', async () => {
      const extra = await belt();
      const id = await proposed('Adopted in Styling', [jeans, shoes, extra]);
      const res = await t.inject({
        method: 'POST',
        url: '/styling',
        payload: {
          role: ['bottom', 'footwear', 'accessory'],
          garmentId: [jeans, shoes, extra].map(String),
          lock: ['', '', ''],
          scheduleDate: t.today(),
        },
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(await rowOf(id)).toMatchObject({ reaction: 'loved' });
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, id));
      expect(entry).toBeDefined();
    });

    it('a gallery pick of its garments adopts one set aside: back, loved, then planned', async () => {
      const id = await proposed('Adopted by a pick', [tee], 'declined');
      const picked = await tool<{ id: number; alreadySaved: boolean }>(
        t,
        mcpToken,
        'pick_outfit',
        { garmentIds: [tee], date: t.today() },
      );
      expect(picked).toMatchObject({ id, alreadySaved: true });
      expect(await rowOf(id)).toMatchObject({
        reaction: 'loved',
        dismissedReason: null,
      });
    });

    it('no reaction moves an outfit that is the owner’s: loved, bought, planned, then a stale ×', async () => {
      const scarf = await createWishlistItem(t, {
        name: 'Wool scarf',
        category: 'accessories',
      });
      const id = await proposed('Scarf day', [scarf, jeans], 'loved');
      await post(`/wardrobe/${scarf}/bought`, {
        acquiredOn: t.today(),
        price: '40',
      });
      expect(
        (await post('/calendar', { outfitId: id, date: t.today() })).statusCode,
      ).toBe(302);
      const before = await rowOf(id);
      const stale = await post(`/outfits/${id}/dismiss`, { reason: 'style' });
      expect(stale.statusCode).toBe(409);
      expect(unescapeHtml(stale.body)).toContain(
        'This outfit is yours now: it was saved since this page was drawn.',
      );
      expect(await rowOf(id)).toEqual(before);
    });
  });

  describe('MCP', () => {
    it('list_outfits lists the owner’s own; get_outfit says a proposal’s note and reaction', async () => {
      const id = await proposed('Proposed over MCP', [
        knit,
        shoes,
        await belt(),
      ]);
      const { outfits } = await tool<{ outfits: { id: number }[] }>(
        t,
        mcpToken,
        'list_outfits',
      );
      expect(outfits.map((o) => o.id)).not.toContain(id);
      const one = await tool<{ proposal: unknown }>(t, mcpToken, 'get_outfit', {
        id,
      });
      expect(one.proposal).toEqual({
        note: 'Why Proposed over MCP',
        reaction: 'proposed',
        ownerNote: null,
        dismissedReason: null,
      });
    });
  });

  it('a piece to buy’s price badge is its page’s link, whatever it unlocks', async () => {
    const id = await proposed('Badge link', [blazer, shoes, await belt()]);
    const card = cardOf(await tab(), id)!;
    expect(card).toMatch(
      new RegExp(`<a href="/wardrobe/${blazer}"[^>]*data-piece-link=""`),
    );
  });

  it('an archived piece is marked Archived, the link to its page', async () => {
    const parka = await createGarment(t, {
      name: 'Old parka',
      category: 'outerwear',
    });
    const id = await proposed('Archived piece', [parka, tee, await belt()]);
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ status: 'archived' })
        .where(eq(garment.id, parka)),
    );
    const card = cardOf(await tab(), id)!;
    expect(card).toMatch(
      new RegExp(
        `<a href="/wardrobe/${parka}"[^>]*data-piece-link=""[^>]*>\\s*<span[^>]*data-mark="archived"`,
      ),
    );
  });
});

describe('the generator’s memory keeps the agent’s proposals (#335)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('Ideas never offers a set the agent proposed, even one the owner set aside', async () => {
    const tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    const jeans = await createGarment(t, {
      name: 'Raw jeans',
      category: 'bottoms',
    });
    const shoes = await createGarment(t, {
      name: 'Canvas shoes',
      category: 'footwear',
    });
    const ideas = async () =>
      unescapeHtml(
        (await t.inject({ method: 'GET', url: '/outfits/ideas' })).body,
      );
    // The closet's one idea, before any proposal.
    expect(await ideas()).toContain('Canvas shoes');
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: {
        name: 'Stylist’s',
        notes: '',
        category: ['tops', 'bottoms', 'footwear'],
        garmentId: [tee, jeans, shoes].map(String),
      },
    });
    const id = Number(
      /^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1],
    );
    await asFixture(t.db, (tx) =>
      tx
        .update(outfit)
        .set({
          proposedAt: new Date(),
          reaction: 'declined',
          dismissedReason: 'style',
        })
        .where(eq(outfit.id, id)),
    );
    expect(await ideas()).not.toContain('Canvas shoes');
  });
});
