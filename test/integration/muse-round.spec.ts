import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import webpush, { type PushSubscription } from 'web-push';
import {
  museRound,
  personalAccessToken,
  userDevice,
} from '../../src/db/schema';
import { parsePushPayload, type PushPayload } from '../../src/web/push/payload';
import {
  createOptionGroup,
  decide,
  markSuggestion,
} from '../../src/web/wishlist/decisions';
import { createGarment, createWishlistItem } from './garments';
import {
  createTestApp,
  PWA_ENV,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * The moment a round lands (#337; docs/plans/2026-10-05-muse-suggestions.md
 * section 4 A): finish_round stores the round (muse_round), moves the
 * agent's feedback cursor to the `until` it hands back, and sends one
 * notification, tagged muse-round, to the devices that turned Muse's
 * rounds on; Today shows one card while anything of the round waits,
 * counted live, in its three statements. web-push's sendNotification is
 * stubbed: nothing leaves the process.
 */

interface Sent {
  endpoint: string;
  payload: PushPayload;
  ttl: number | undefined;
}

interface Finished {
  round: { id: number; outfits: number; pieces: number } | null;
  notified?: number;
  feedbackRead: boolean;
}

describe('a round of Muse’s', () => {
  let t: TestApp;
  let token: string;
  let tokenId: number;
  let tee: number;
  let jeans: number;
  let sent: Sent[];
  let museDevice: string;
  let morningDevice: string;
  let seq = 0;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  const subscribe = async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const res = await post('/push/subscribe', {
      endpoint,
      keys: {
        p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    });
    expect(res.statusCode).toBe(204);
    return endpoint;
  };

  /** A need with `count` options, each a wishlist garment marked as Muse's. */
  async function suggest(count: number): Promise<number[]> {
    const need = await createOptionGroup(t.db, t.owner.id, {
      name: `Need ${++seq}`,
      budget: null,
      note: null,
      tokenId,
    });
    if (!need.ok) throw new Error('need exists');
    const picks: number[] = [];
    for (let i = 0; i < count; i++) {
      const id = await createWishlistItem(t, {
        name: `Option ${seq}.${i}`,
        category: 'tops',
      });
      expect(
        await markSuggestion(t.db, t.owner.id, id, {
          tokenId,
          groupId: need.id,
          note: null,
          rank: null,
        }),
      ).toBe('marked');
      picks.push(id);
    }
    return picks;
  }

  const finish = (args: Record<string, unknown> = {}) =>
    tool<Finished>(t, token, 'finish_round', args);

  const cursor = async () =>
    (
      await t.db
        .select({ at: personalAccessToken.feedbackReadAt })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.id, tokenId))
    )[0].at;

  const todayHtml = async () => unescapeHtml((await get('/')).body);

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
    token = await createAccessToken(t, { name: 'Muse' });
    const [row] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, t.owner.id));
    tokenId = row.id;
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    museDevice = await subscribe();
    morningDevice = await subscribe();
    const save = (fields: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: '/push/reminders',
        payload: fields,
        headers: { 'hx-request': 'true' },
      });
    expect(
      (await save({ endpoint: museDevice, museRoundsOn: '1' })).statusCode,
    ).toBe(200);
    expect(
      (await save({ endpoint: morningDevice, morningOn: '1', morning: '420' }))
        .statusCode,
    ).toBe(200);
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    sent = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(
      (target: PushSubscription, payload, options) => {
        sent.push({
          endpoint: target.endpoint,
          payload: parsePushPayload(JSON.parse(String(payload)))!,
          ttl: options?.TTL,
        });
        return Promise.resolve({ statusCode: 201, body: '', headers: {} });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with nothing new is no round: no row, no card, no notification', async () => {
    expect(await finish()).toEqual({ round: null, feedbackRead: false });
    expect(await t.db.select().from(museRound)).toEqual([]);
    expect(sent).toEqual([]);
    expect(await todayHtml()).not.toContain('data-muse-round');
  });

  it('stores the round and notifies the devices that take Muse’s rounds, once, tagged', async () => {
    await suggest(2);
    const outfit = await tool<{ id: number }>(t, token, 'suggest_outfit', {
      garmentIds: [tee, jeans],
    });
    const finished = await finish({ summary: '  Autumn layers  ' });
    expect(finished).toEqual({
      round: { id: expect.any(Number), outfits: 1, pieces: 2 },
      notified: 1,
      feedbackRead: false,
    });
    const [row] = await t.db
      .select()
      .from(museRound)
      .where(eq(museRound.id, finished.round!.id));
    expect(row).toMatchObject({
      ownerId: t.owner.id,
      tokenId,
      since: null,
      summary: 'Autumn layers',
    });
    expect(sent).toEqual([
      {
        endpoint: museDevice,
        payload: {
          title: 'Muse finished a round',
          body: 'Muse: 1 outfit, 2 pieces to consider',
          url: '/outfits',
          tag: 'muse-round',
        },
        ttl: 24 * 60 * 60,
      },
    ]);
    expect(t.logs.ops('round.finished')).toContainEqual(
      expect.objectContaining({
        roundId: finished.round!.id,
        userId: t.owner.id,
        surface: 'mcp',
        tokenId,
        outfits: 1,
        pieces: 2,
        changed: true,
      }),
    );
    await post(`/outfits/${outfit.id}/dismiss`, { reason: 'style' });
  });

  it('counts only what came since the last round', async () => {
    const [previous] = await t.db
      .select()
      .from(museRound)
      .orderBy(desc(museRound.id))
      .limit(1);
    await suggest(1);
    const finished = await finish();
    expect(finished.round).toMatchObject({ outfits: 0, pieces: 1 });
    expect(sent.map((s) => s.payload)).toEqual([
      expect.objectContaining({
        body: 'Muse: 1 piece to consider',
        url: '/wardrobe/wishlist',
      }),
    ]);
    const [row] = await t.db
      .select({ since: museRound.since })
      .from(museRound)
      .where(eq(museRound.id, finished.round!.id));
    expect(row.since).toEqual(previous.finishedAt);
  });

  it('moves the feedback cursor to the until it is handed, never past now, never back', async () => {
    const read = await tool<{ until: string }>(
      t,
      token,
      'get_suggestion_feedback',
    );
    const ended = await finish({ feedbackUntil: read.until });
    expect(ended).toEqual({ round: null, feedbackRead: true });
    expect((await cursor())!.toISOString()).toBe(
      new Date(read.until).toISOString(),
    );
    // An older until keeps the cursor; a future one stops at now.
    await finish({ feedbackUntil: '2020-01-01T00:00:00Z' });
    expect((await cursor())!.toISOString()).toBe(
      new Date(read.until).toISOString(),
    );
    await finish({ feedbackUntil: '2999-01-01T00:00:00Z' });
    expect((await cursor())!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await cursor())!.getTime()).toBeGreaterThan(Date.parse(read.until));
  });

  it('refuses a blank or over-long summary, and an until that is no time', async () => {
    for (const args of [
      { summary: '   ' },
      { summary: 'x'.repeat(141) },
      { feedbackUntil: 'yesterday' },
    ]) {
      expect((await callTool(t, token, 'finish_round', args)).isError).toBe(
        true,
      );
    }
  });

  describe('Today’s card', () => {
    it('shows the latest round while it waits, in the same three statements, then the needs’ card once it is decided', async () => {
      const picks = await suggest(2);
      const outfit = await tool<{ id: number }>(t, token, 'suggest_outfit', {
        garmentIds: [picks[0], jeans],
      });
      const finished = await finish({ summary: 'Office basics' });
      const roundId = finished.round!.id;

      const record = await recordQueries(() => get('/'));
      expect(record.statements).toBe(3);
      const html = await todayHtml();
      expect(html).toContain(`data-muse-round="${roundId}"`);
      expect(html).toContain('Muse: 1 outfit, 2 pieces to consider');
      expect(html).toContain('Office basics');
      expect(html).toMatch(/href="\/outfits" class="btn btn-primary/);
      // One Muse card: the needs' waits behind the round's.
      expect(html).not.toContain('data-muse-needs');

      // The owner decides: the counts shrink, live.
      await post(`/outfits/${outfit.id}/dismiss`, { reason: 'colour' });
      await decide(t.db, t.owner.id, { kind: 'choose', garmentId: picks[0] });
      const shrunk = await todayHtml();
      expect(shrunk).not.toContain(`data-muse-round="${roundId}"`);
      // Nothing of the round waits: the card is gone, and the needs' card
      // (an earlier round's option, still open) takes the slot again.
      expect(shrunk).toContain('data-muse-needs');
    });

    it('is the owner’s alone', async () => {
      const cookie = await t.register('round-stranger@example.com');
      const res = await t.inject({
        method: 'GET',
        url: '/',
        headers: { cookie },
      });
      expect(res.body).not.toContain('data-muse-round');
    });
  });

  describe('the device’s toggle', () => {
    const form = async (endpoint: string) =>
      unescapeHtml(
        (
          await t.inject({
            method: 'POST',
            url: '/push/reminders/form',
            payload: { endpoint },
            headers: { 'hx-request': 'true' },
          })
        ).body,
      );

    it('starts off, saves with the form, and goes off when the device moves to another account', async () => {
      const endpoint = await subscribe();
      const blank = await form(endpoint);
      expect(blank).toContain('name="museRoundsOn"');
      expect(blank).not.toMatch(/name="museRoundsOn" value="1" checked/);
      expect(blank).toContain('When your agent finishes a round');

      const saved = await t.inject({
        method: 'POST',
        url: '/push/reminders',
        payload: { endpoint, museRoundsOn: '1' },
        headers: { 'hx-request': 'true' },
      });
      // The toggle alone: no word about a time starting tomorrow.
      expect(saved.body).toContain('Saved.');
      expect(saved.body).not.toContain('starts tomorrow');
      expect(await form(endpoint)).toMatch(
        /name="museRoundsOn" value="1" checked/,
      );
      const row = async () =>
        (
          await t.db
            .select({ on: userDevice.museRounds, user: userDevice.userId })
            .from(userDevice)
            .where(eq(userDevice.pushEndpoint, endpoint))
        )[0];
      expect((await row()).on).toBe(true);

      const other = await t.register('round-other@example.com');
      const moved = await t.inject({
        method: 'POST',
        url: '/push/subscribe',
        payload: {
          endpoint,
          keys: {
            p256dh: createECDH('prime256v1')
              .generateKeys()
              .toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
          },
        },
        headers: { cookie: other },
      });
      expect(moved.statusCode).toBe(204);
      expect(await row()).toMatchObject({ on: false });
      expect(
        await t.db
          .select({ id: userDevice.id })
          .from(userDevice)
          .where(
            and(
              eq(userDevice.pushEndpoint, endpoint),
              eq(userDevice.userId, t.owner.id),
            ),
          ),
      ).toEqual([]);
    });
  });
});
