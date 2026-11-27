import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
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
import { agentRound, personalAccessToken } from '../../src/db/schema';
import { parsePushPayload, type PushPayload } from '../../src/web/push/payload';
import {
  createOptionGroup,
  decide,
  markSuggestion,
} from '../../src/web/wishlist/decisions';
import {
  closeQuietRounds,
  QUIET_PERIOD_MS,
  QuietCloseFailed,
  type RoundCloseDeps,
} from '../../src/web/wishlist/round-end';
import { finishRound, quietRounds } from '../../src/web/wishlist/rounds';
import { createGarment, createWishlistItem } from './garments';
import {
  createTestApp,
  PWA_ENV,
  recordQueries,
  type TestApp,
  userIdOf,
} from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * The quiet close of a round (#337): an agent that never calls
 * finish_round has its round closed by the minute timer once its newest
 * suggestion or outfit is QUIET_PERIOD_MS old, through finishRound with
 * the newest write's token, no summary and the feedback cursor where it
 * was, and notified as finish_round notifies. The timer is not running
 * here: each "tick" is closeQuietRounds at the instant it is handed.
 * web-push's sendNotification is stubbed: nothing leaves the process.
 */

interface Sent {
  endpoint: string;
  payload: PushPayload;
}

describe('a round its agent left open', () => {
  let t: TestApp;
  let deps: RoundCloseDeps;
  let token: string;
  let tokenId: number;
  let tee: number;
  let jeans: number;
  let agentDevice: string;
  let sent: Sent[];
  let seq = 0;

  /** A tick now: what was just written is not quiet yet. */
  const tickNow = () => closeQuietRounds(deps, new Date());
  /** A tick a quiet period from now: everything written so far is quiet. */
  const tickLater = () =>
    closeQuietRounds(deps, new Date(Date.now() + QUIET_PERIOD_MS + 1_000));

  const rounds = () =>
    t.db.select().from(agentRound).orderBy(desc(agentRound.id));

  const cursor = async () =>
    (
      await t.db
        .select({ at: personalAccessToken.feedbackReadAt })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.id, tokenId))
    )[0].at;

  const closedLines = () =>
    t.logs.records
      .map((record) => record.msg ?? '')
      .filter((msg) => /quiet/i.test(msg));

  /** A need with `count` options, each a wishlist garment marked as the agent's. */
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

  const proposeOutfit = (garmentIds: number[]) =>
    tool<{ id: number }>(t, token, 'suggest_outfit', { garmentIds });

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
    deps = {
      db: t.db,
      push: t.push,
      logger: t.logger.child({ logger: 'Stylist' }),
    };
    token = await createAccessToken(t, { name: 'Stylist' });
    const [row] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, t.owner.id));
    tokenId = row.id;
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    agentDevice = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const subscribed = await t.inject({
      method: 'POST',
      url: '/push/subscribe',
      payload: {
        endpoint: agentDevice,
        keys: {
          p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      },
    });
    expect(subscribed.statusCode).toBe(204);
    const saved = await t.inject({
      method: 'POST',
      url: '/push/reminders',
      payload: { endpoint: agentDevice, agentRoundsOn: '1' },
      headers: { 'hx-request': 'true' },
    });
    expect(saved.statusCode).toBe(200);
    // The agent read its feedback and ended an empty round, so its cursor
    // is set; the quiet close must leave it where it is.
    const read = await tool<{ until: string }>(
      t,
      token,
      'get_suggestion_feedback',
    );
    await tool(t, token, 'finish_round', { feedbackUntil: read.until });
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    sent = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(
      (target: PushSubscription, payload) => {
        sent.push({
          endpoint: target.endpoint,
          payload: parsePushPayload(JSON.parse(String(payload)))!,
        });
        return Promise.resolve({ statusCode: 201, body: '', headers: {} });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds nothing in one statement, and logs nothing, when nothing was written', async () => {
    const record = await recordQueries(tickLater);
    expect(record.statements).toBe(1);
    expect(await rounds()).toEqual([]);
    expect(sent).toEqual([]);
    expect(closedLines()).toEqual([]);
  });

  it('leaves a round alone while its newest write is younger than the quiet period', async () => {
    await suggest(2);
    expect(await tickNow()).toBe(0);
    expect(await rounds()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('closes it once quiet: the newest write’s token, no summary, the cursor untouched, one notification', async () => {
    const before = await cursor();
    expect(before).not.toBeNull();
    await proposeOutfit([tee, jeans]);

    const record = await recordQueries(tickLater);
    const [round, ...older] = await rounds();
    expect(older).toEqual([]);
    expect(round).toMatchObject({
      ownerId: t.owner.id,
      tokenId,
      since: null,
      summary: null,
    });
    // The quiet read; finishRound's transaction (begin, the owner lock,
    // the round, commit); the devices' read for the batch.
    expect(record.statements).toBe(6);
    expect(sent).toEqual([
      {
        endpoint: agentDevice,
        payload: {
          title: 'Stylist finished a round',
          body: 'Stylist: 1 outfit, 2 pieces to consider',
          url: '/outfits',
          tag: 'agent-round',
        },
      },
    ]);
    expect(await cursor()).toEqual(before);
    expect(closedLines()).toContain(
      `Round ${round.id} of user ${t.owner.id} closed after ${QUIET_PERIOD_MS / 60_000} quiet minutes (token ${tokenId}): 1 outfits, 2 pieces, 1 devices notified`,
    );
  });

  it('closes it once: a second tick finds nothing', async () => {
    const count = (await rounds()).length;
    expect(await tickLater()).toBe(0);
    expect(await rounds()).toHaveLength(count);
    expect(sent).toEqual([]);
  });

  it('finds nothing after the agent’s own finish_round', async () => {
    await suggest(1);
    const finished = await tool<{ round: { id: number } | null }>(
      t,
      token,
      'finish_round',
      { summary: 'One more' },
    );
    expect(finished.round).not.toBeNull();
    sent = [];
    const count = (await rounds()).length;
    expect(await tickLater()).toBe(0);
    expect(await rounds()).toHaveLength(count);
    expect(sent).toEqual([]);
  });

  it('finds nothing when the owner decided everything the agent left open', async () => {
    const [pick] = await suggest(1);
    await decide(t.db, t.owner.id, {
      kind: 'dismiss-pick',
      garmentId: pick,
      reason: 'style',
      note: null,
    });
    const count = (await rounds()).length;
    expect(await quietRounds(t.db, new Date(Date.now() + 1_000))).toEqual([]);
    expect(await tickLater()).toBe(0);
    expect(await rounds()).toHaveLength(count);
  });

  describe('beside the agent’s own finish_round', () => {
    it('is harmless after the read: the owner lock leaves the second end nothing', async () => {
      await suggest(1);
      const later = new Date(Date.now() + QUIET_PERIOD_MS + 1_000);
      expect(
        await quietRounds(t.db, new Date(later.getTime() - QUIET_PERIOD_MS)),
      ).toEqual([{ ownerId: t.owner.id, tokenId }]);
      // The agent's call lands between the quiet read and its finishRound.
      await tool(t, token, 'finish_round', {});
      const count = (await rounds()).length;
      expect(
        await finishRound(t.db, t.owner.id, {
          tokenId,
          summary: null,
          feedbackUntil: null,
        }),
      ).toEqual({ ok: false, reason: 'empty' });
      expect(await rounds()).toHaveLength(count);
    });

    it('stores one round when both end it at once', async () => {
      await suggest(2);
      const count = (await rounds()).length;
      sent = [];
      await Promise.all([tickLater(), tool(t, token, 'finish_round', {})]);
      expect(await rounds()).toHaveLength(count + 1);
      expect(sent).toHaveLength(1);
    });
  });

  it('keeps closing the other owners’ rounds when one fails, then fails the run for the job’s metric', async () => {
    await suggest(1);
    // A second owner with a quiet round of their own agent's.
    const email = 'quiet-other@example.com';
    const cookie = await t.register(email);
    const otherId = await userIdOf(t, email);
    await createAccessToken(t, { cookie, name: 'Stylist' });
    const [otherToken] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, otherId));
    const need = await createOptionGroup(t.db, otherId, {
      name: 'A raincoat',
      budget: null,
      note: null,
      tokenId: otherToken.id,
    });
    if (!need.ok) throw new Error('need exists');
    const pick = await createWishlistItem(t, { name: 'Raincoat', cookie });
    expect(
      await markSuggestion(t.db, otherId, pick, {
        tokenId: otherToken.id,
        groupId: need.id,
        note: null,
        rank: null,
      }),
    ).toBe('marked');
    const ownerRounds = async (ownerId: number) =>
      (await rounds()).filter((round) => round.ownerId === ownerId).length;
    const before = await ownerRounds(t.owner.id);

    // The first owner's finishRound (owners in id order) fails; the run is
    // timed as server.ts times it.
    vi.spyOn(t.db, 'transaction').mockRejectedValueOnce(new Error('down'));
    const run = t.metrics.timeJob('agent_rounds', (now: Date) =>
      closeQuietRounds(deps, now),
    );
    const later = new Date(Date.now() + QUIET_PERIOD_MS + 1_000);
    const failure = await run(later).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QuietCloseFailed);
    expect((failure as QuietCloseFailed).ownerIds).toEqual([t.owner.id]);
    expect(await ownerRounds(t.owner.id)).toBe(before);
    expect(await ownerRounds(otherId)).toBe(1);
    expect(closedLines()).toContain(
      `Quiet round of user ${t.owner.id} not closed`,
    );
    const { body } = await t.metrics.exposition();
    expect(body).toMatch(
      /^job_duration_seconds_count\{name="agent_rounds",outcome="failure"\} 1$/m,
    );

    // The next minute closes it.
    expect(await closeQuietRounds(deps, later)).toBe(1);
    expect(await ownerRounds(t.owner.id)).toBe(before + 1);
  });
});
