import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, optionGroup } from '../../src/db/schema';
import { markSuggestion } from '../../src/web/wishlist/decisions';
import { deviceToken, expectProblem } from './api';
import { createGarment, createWishlistItem, garmentRow } from './garments';
import { createTestApp, type TestApp, TEST_PASSWORD } from './harness';

/**
 * The wishlist and the agent's inbox on /api/v1 (#194b): the tab and a need's
 * screen as their pages read them, every owner decision through
 * makeDecision, "Bought it" through buyWishlistItem, "Bought a different
 * one" through POST /garments. Who may do what is the authorization
 * matrix's (authorization-wardrobe.spec.ts replays the cases on these
 * twins); what each costs is api-statements'.
 */

let t: TestApp;
let token: string;
let viewerToken: string;
let managerToken: string;
let ownerId: number;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

async function need(name: string): Promise<number> {
  const [row] = await t.db
    .insert(optionGroup)
    .values({ ownerId, name, budget: '100' })
    .returning({ id: optionGroup.id });
  return row.id;
}

async function pick(name: string, groupId: number, rank: number | null = null) {
  const id = await createWishlistItem(t, { name, price: '90' });
  const marked = await markSuggestion(t.db, ownerId, id, {
    tokenId: null,
    groupId,
    note: `Stylist on ${name}`,
    rank,
  });
  expect(marked).toBe('marked');
  return id;
}

const groupRow = async (id: number) =>
  (await t.db.select().from(optionGroup).where(eq(optionGroup.id, id)))[0];

/** A fresh account the owner shares the wardrobe with; its device token. */
async function shareWith(
  email: string,
  permission: 'VIEW' | 'MANAGE',
): Promise<string> {
  const cookie = await t.register(email);
  const invite = await t.inject({
    method: 'POST',
    url: '/wardrobe-share/create-invite-link',
    payload: { permission, currentPassword: TEST_PASSWORD },
    headers: { 'hx-request': 'true' },
  });
  const shareToken = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    invite.body,
  )![1];
  await t.inject({
    method: 'POST',
    url: `/wardrobe-share/invite/${shareToken}/accept`,
    headers: { cookie },
  });
  return (await deviceToken(t, { email })).token;
}

beforeAll(async () => {
  t = await createTestApp();
  ownerId = t.owner.id;
  token = (await deviceToken(t)).token;
  await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
  await createGarment(t, { name: 'Sneakers', category: 'footwear' });
  viewerToken = await shareWith('api-wishlist-viewer@example.com', 'VIEW');
  managerToken = await shareWith('api-wishlist-manager@example.com', 'MANAGE');
});

afterAll(async () => {
  await t?.cleanup();
});

describe('reads', () => {
  it("answers the inbox's sections; a share reads them without the unlocks", async () => {
    const coats = await need('A rain coat');
    const first = await pick('Yellow mac', coats, 1);
    await pick('Green parka', coats, 2);
    const looking = await need('Wool socks');
    const replaced = await createGarment(t, {
      name: 'Old tee',
      category: 'tops',
    });
    const own = await api('POST', '/garments', {
      category: 'tops',
      name: 'Linen tee',
      destination: 'wishlist',
      replacesGarmentId: replaced,
    });
    expect(own.statusCode, own.body).toBe(201);
    const ownId = own.json<{ id: number }>().id;

    const res = await api('GET', '/wishlist');
    expect(res.statusCode, res.body).toBe(200);
    const inbox = res.json<{
      needs: {
        need: { id: number; status: string };
        options: {
          id: number;
          fromAgent: boolean;
          rank?: number;
          unlocks?: object;
        }[];
      }[];
      items: { id: number; fromAgent: boolean; replaces?: { id: number } }[];
      stillLooking: { id: number }[];
    }>();
    const card = inbox.needs.find(({ need: n }) => n.id === coats)!;
    expect(card.need.status).toBe('open');
    expect(card.options.map(({ id }) => id)).toContain(first);
    expect(card.options[0]).toMatchObject({
      fromAgent: true,
      unlocks: expect.any(Object),
    });
    expect(inbox.stillLooking.map(({ id }) => id)).toContain(looking);
    expect(inbox.items.find(({ id }) => id === ownId)).toMatchObject({
      fromAgent: false,
      replaces: { id: replaced },
    });

    const shared = await api(
      'GET',
      `/wishlist?ownerId=${ownerId}`,
      undefined,
      viewerToken,
    );
    expect(shared.statusCode).toBe(200);
    expect(shared.body).toContain('Yellow mac');
    expect(shared.body).not.toContain('unlocks');

    const detail = await api('GET', `/wishlist/needs/${coats}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      need: { id: coats, name: 'A rain coat', budget: '100.00' },
      options: expect.arrayContaining([
        expect.objectContaining({
          id: first,
          judged: expect.objectContaining({ best: expect.any(Array) }),
        }),
      ]),
      setAside: [],
    });
    const viewed = await api(
      'GET',
      `/wishlist/needs/${coats}?ownerId=${ownerId}`,
      undefined,
      viewerToken,
    );
    expect(viewed.statusCode).toBe(200);
    expect(viewed.body).not.toContain('judged');
    // Not in the viewer's own wardrobe.
    expectProblem(
      await api('GET', `/wishlist/needs/${coats}`, undefined, viewerToken),
      404,
      'not_found',
    );
  });

  it('"New from the agent" answers what came in since the last call, once', async () => {
    const fresh = await need('A belt');
    await pick('Brown belt', fresh);
    const seen = await api('POST', '/wishlist/seen');
    expect(seen.statusCode, seen.body).toBe(200);
    expect(
      seen.json<{ needs: { id: number }[] }>().needs.map(({ id }) => id),
    ).toContain(fresh);
    expect((await api('POST', '/wishlist/seen')).json()).toEqual({ needs: [] });
  });
});

describe('decisions', () => {
  it('chooses a pick, undoes the choice, sets a pick aside; a double tap is a 409', async () => {
    const groupId = await need('A scarf');
    const chosen = await pick('Grey scarf', groupId, 1);
    const other = await pick('Red scarf', groupId, 2);

    const choose = await api('POST', `/garments/${chosen}/decisions`, {
      event: 'choose',
    });
    expect(choose.statusCode, choose.body).toBe(200);
    expect(choose.json()).toEqual({
      needId: groupId,
      setAside: [other],
      restored: [],
    });
    expect(await groupRow(groupId)).toMatchObject({
      status: 'resolved',
      resolvedGarmentId: chosen,
    });
    expectProblem(
      await api('POST', `/garments/${chosen}/decisions`, { event: 'choose' }),
      409,
      'conflict',
    );

    // The choice is the need's to undo: its siblings come back.
    const undo = await api('POST', `/wishlist/needs/${groupId}/decisions`, {
      event: 'undo',
    });
    expect(undo.json()).toEqual({
      needId: groupId,
      setAside: [],
      restored: [other],
    });

    expectProblem(
      await api('POST', `/garments/${other}/decisions`, {
        event: 'dismiss',
        reason: 'pricey',
      }),
      400,
      'validation',
    );
    const dismissed = await api('POST', `/garments/${other}/decisions`, {
      event: 'dismiss',
      reason: 'too_pricey',
      note: '  Too much  ',
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    const [row] = await t.db
      .select({ reason: garment.dismissedReason, note: garment.dismissedNote })
      .from(garment)
      .where(eq(garment.id, other));
    expect(row).toEqual({ reason: 'too_pricey', note: 'Too much' });
    expect(t.logs.ops('suggestion.decided')).toContainEqual(
      expect.objectContaining({
        decision: 'dismiss-pick',
        garmentId: other,
        needId: groupId,
        surface: 'api',
      }),
    );
  });

  it('sets a need aside and brings it back', async () => {
    const groupId = await need('A hat');
    await pick('Bucket hat', groupId);
    const aside = await api('POST', `/wishlist/needs/${groupId}/decisions`, {
      event: 'dismiss',
      reason: 'not_now',
    });
    expect(aside.statusCode, aside.body).toBe(200);
    expect(await groupRow(groupId)).toMatchObject({
      status: 'dismissed',
      dismissedReason: 'not_now',
    });
    const back = await api('POST', `/wishlist/needs/${groupId}/decisions`, {
      event: 'undo',
    });
    expect(back.statusCode).toBe(200);
    expect(await groupRow(groupId)).toMatchObject({ status: 'open' });
    expectProblem(
      await api('POST', `/wishlist/needs/${groupId}/decisions`, {
        event: 'undo',
      }),
      409,
      'conflict',
    );
  });
});

describe('Bought it', () => {
  it('buys a pick with its day and price, settling its need; a repeat is a 409; Returned opens it again', async () => {
    const groupId = await need('Gloves');
    const gloves = await pick('Leather gloves', groupId);
    const sibling = await pick('Wool gloves', groupId);
    const today = t.today();
    const bought = await api('POST', `/garments/${gloves}/purchases`, {
      acquiredOn: today,
      price: '49.9',
    });
    expect(bought.statusCode, bought.body).toBe(200);
    expect(bought.json()).toEqual({});
    expect(await garmentRow(t, gloves)).toMatchObject({
      status: 'closet',
      acquiredOn: today,
      price: '49.90',
    });
    expect(await groupRow(groupId)).toMatchObject({
      status: 'resolved',
      resolvedGarmentId: gloves,
    });
    expect((await garmentRow(t, sibling))?.dismissedReason).toBe(
      'chose_another',
    );
    expectProblem(
      await api('POST', `/garments/${gloves}/purchases`, { acquiredOn: today }),
      409,
      'conflict',
    );
    // Never coerced: a price is a string.
    expectProblem(
      await api('POST', `/garments/${sibling}/purchases`, { price: 12 }),
      400,
      'validation',
    );

    const returned = await api('POST', `/garments/${gloves}/returns`);
    expect(returned.statusCode, returned.body).toBe(200);
    expect(returned.json()).toEqual({ needId: groupId });
    expect(await garmentRow(t, gloves)).toMatchObject({
      status: 'archived',
      dismissedReason: 'returned',
    });
    expect(await groupRow(groupId)).toMatchObject({ status: 'open' });
  });

  it('archives the garment it replaces when asked', async () => {
    const old = await createGarment(t, {
      name: 'Worn hoodie',
      category: 'tops',
    });
    const item = await createWishlistItem(t, {
      name: 'New hoodie',
      replaces: old,
    });
    const bought = await api('POST', `/garments/${item}/purchases`, {
      acquiredOn: null,
      price: null,
      archiveReplaced: true,
    });
    expect(bought.json()).toEqual({ archivedReplaced: old });
    expect((await garmentRow(t, old))?.status).toBe('archived');
    expect(await garmentRow(t, item)).toMatchObject({
      status: 'closet',
      price: null,
    });
  });

  it('"Bought a different one": a closet garment settling the need, in one write', async () => {
    const groupId = await need('A watch');
    await pick('Steel watch', groupId);
    expectProblem(
      await api('POST', '/garments', {
        category: 'accessories',
        destination: 'wishlist',
        boughtForNeedId: groupId,
      }),
      400,
      'validation',
    );
    const made = await api('POST', '/garments', {
      category: 'accessories',
      name: 'Vintage watch',
      boughtForNeedId: groupId,
    });
    expect(made.statusCode, made.body).toBe(201);
    const { id } = made.json<{ id: number }>();
    expect(await groupRow(groupId)).toMatchObject({
      status: 'resolved',
      resolvedGarmentId: id,
    });
    // Settled: no need left to buy for, and nothing stored.
    const before = await t.db.$count(garment);
    expectProblem(
      await api('POST', '/garments', {
        category: 'accessories',
        boughtForNeedId: groupId,
      }),
      404,
      'not_found',
    );
    expect(await t.db.$count(garment)).toBe(before);
  });

  it('answers a retry of a create that settled a need with the first row, settling nothing again', async () => {
    const groupId = await need('A bag');
    await pick('Tote bag', groupId);
    const body = {
      category: 'bags',
      name: 'Canvas bag',
      boughtForNeedId: groupId,
      clientId: randomUUID(),
    };
    const first = await api('POST', '/garments', body);
    expect(first.statusCode, first.body).toBe(201);
    const { id } = first.json<{ id: number }>();
    const before = await t.db.$count(garment);
    const retry = await api('POST', '/garments', body);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual({ id });
    expect(await t.db.$count(garment)).toBe(before);
    expect(await groupRow(groupId)).toMatchObject({
      status: 'resolved',
      resolvedGarmentId: id,
    });
  });

  it("refuses a MANAGE share settling the owner's need, storing nothing", async () => {
    const groupId = await need('A scarf');
    await pick('Wool scarf', groupId);
    const before = await t.db.$count(garment);
    expectProblem(
      await api(
        'POST',
        `/garments?ownerId=${ownerId}`,
        {
          category: 'accessories',
          name: 'Silk scarf',
          boughtForNeedId: groupId,
        },
        managerToken,
      ),
      404,
      'not_found',
    );
    expect(await t.db.$count(garment)).toBe(before);
    expect(await groupRow(groupId)).toMatchObject({
      status: 'open',
      resolvedGarmentId: null,
    });
    // The same share may still add a garment without the need.
    const plain = await api(
      'POST',
      `/garments?ownerId=${ownerId}`,
      { category: 'accessories', name: 'Silk scarf' },
      managerToken,
    );
    expect(plain.statusCode, plain.body).toBe(201);
  });
});
