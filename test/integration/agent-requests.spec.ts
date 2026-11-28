import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRequest } from '../../src/db/schema';
import {
  CLAIM_LEASE_MINUTES,
  REQUEST_ANSWER_MAX,
} from '../../src/wardrobe/agent-requests';
import { HttpError } from '../../src/web/errors';
import {
  type RequestTransition,
  transitionRequest,
} from '../../src/web/requests/request-actions';
import { revokeToken } from '../../src/web/auth/personal-tokens';
import { createInvite } from '../../src/web/sharing/queries';
import type { Actor } from '../../src/web/sharing/access';
import { deviceToken, expectProblem } from './api';
import { createGarment } from './garments';
import { asFixture, createTestApp, type TestApp, userIdOf } from './harness';
import { interleave } from './interleave';
import { mintToken } from './mcp';

/**
 * "Ask your agent" requests (#681 B1, src/web/requests/AGENTS.md): the
 * asker's API, and the machine's moves as the agent's tools (#1287) will
 * call them, through transitionRequest. Races are sequenced on the owner
 * lock (interleave), never slept. Another user's request on every API
 * route is authorization-account.spec.ts's.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.cleanup();
});

interface Asker {
  id: number;
  cookie: string;
  device: string;
  agent: (name: string) => Promise<number>;
}

async function asker(email: string): Promise<Asker> {
  const cookie = await t.register(email);
  const id = await userIdOf(t, email);
  return {
    id,
    cookie,
    device: (await deviceToken(t, { email })).token,
    agent: async (name) => {
      const minted = await mintToken(t, id, name);
      if (!minted.created) throw new Error(`no token: ${minted.reason}`);
      return minted.id;
    },
  };
}

const deps = () => ({ db: t.db, logger: t.logger });
const agentOf = (userId: number): Actor => ({ userId, surface: 'mcp' });

const ask = async (who: Asker, payload: object) =>
  t.api(who.device, {
    method: 'POST',
    url: '/api/v1/agent-requests',
    payload,
  });

async function asked(who: Asker, body: string): Promise<number> {
  const res = await ask(who, { body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

/** transitionRequest's refusal, as the tool will answer it: its status and words. */
async function refusalOf(
  userId: number,
  transition: RequestTransition,
): Promise<{ status: number; message: string }> {
  const error: unknown = await transitionRequest(
    deps(),
    agentOf(userId),
    transition,
  ).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof HttpError)) throw new Error('not refused');
  return { status: error.statusCode, message: error.message };
}

const rowOf = async (id: number) =>
  (await t.db.select().from(agentRequest).where(eq(agentRequest.id, id)))[0];

describe('the asker', () => {
  it('asks, reads it back, withdraws once; an agent answering after is refused', async () => {
    const a = await asker('requests-ask@example.com');
    const body = 'What should I wear to the dinner tonight?';
    const created = await ask(a, { body: `  ${body} ` });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<{ id: number }>();
    expect(created.headers.location).toBe(`/api/v1/agent-requests/${id}`);

    const read = await t.api(a.device, {
      method: 'GET',
      url: `/api/v1/agent-requests/${id}`,
    });
    expect(read.json()).toEqual({
      id,
      body,
      status: 'open',
      createdAt: expect.any(String),
    });
    const list = await t.api(a.device, {
      method: 'GET',
      url: '/api/v1/agent-requests',
    });
    expect(list.json()).toMatchObject({
      data: [{ id, status: 'open' }],
      pagination: { limit: 20 },
    });

    const withdraw = () =>
      t.api(a.device, {
        method: 'POST',
        url: `/api/v1/agent-requests/${id}/withdraw`,
      });
    expect((await withdraw()).json()).toEqual({
      id,
      status: 'withdrawn',
      changed: true,
    });
    expect((await withdraw()).json()).toEqual({
      id,
      status: 'withdrawn',
      changed: false,
    });

    const tokenId = await a.agent('Laptop');
    expect(
      await refusalOf(a.id, { kind: 'answer', id, tokenId, answer: 'Navy' }),
    ).toEqual({ status: 409, message: 'The owner withdrew this request' });
    expect(await refusalOf(a.id, { kind: 'claim', id, tokenId })).toMatchObject(
      { message: 'The owner withdrew this request' },
    );
    expect(await rowOf(id)).toMatchObject({
      status: 'withdrawn',
      answer: null,
      claimedByTokenId: null,
    });
    // Got it before an answer is a 409; a blank body never asks.
    expectProblem(
      await t.api(a.device, {
        method: 'POST',
        url: `/api/v1/agent-requests/${id}/seen`,
      }),
      409,
      'conflict',
    );
    expectProblem(await ask(a, { body: '   ' }), 400, 'validation');
  });

  it('names a subject it sees (a shared garment), never one it does not; a replayed client id answers the first', async () => {
    const owner = await asker('requests-owner@example.com');
    const partner = await asker('requests-partner@example.com');
    const garmentId = await createGarment(t, {
      name: 'Shared coat',
      cookie: owner.cookie,
    });
    const invite = await createInvite(t.db, owner.id, 'VIEW');
    const accepted = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${invite.inviteToken}/accept`,
      headers: { cookie: partner.cookie },
    });
    expect(accepted.statusCode).toBe(302);

    const clientId = randomUUID();
    const first = await ask(partner, {
      body: 'What goes with this?',
      subject: { kind: 'garment', id: garmentId },
      clientId,
    });
    expect(first.statusCode, first.body).toBe(201);
    const { id } = first.json<{ id: number }>();
    const replay = await ask(partner, { body: 'Changed', clientId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ id });
    expect((await rowOf(id)).body).toBe('What goes with this?');

    // The owner's trip is not the partner's to name: its 404.
    const ownerTrip = await t.api(owner.device, {
      method: 'POST',
      url: '/api/v1/trips',
      payload: { name: 'Lisbon', startsOn: t.today(), endsOn: t.today() },
    });
    expect(ownerTrip.statusCode, ownerTrip.body).toBe(201);
    const tripId = ownerTrip.json<{ id: number }>().id;
    const refused = await ask(partner, {
      body: 'Pack me for this',
      subject: { kind: 'trip', id: tripId },
    });
    expect(expectProblem(refused, 404, 'not_found').detail).toBe(
      'Trip not found',
    );
    // The share ended: the request stays, its subject no longer shown.
    const removed = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/${invite.id}/remove`,
      headers: { cookie: owner.cookie },
    });
    expect(removed.statusCode, removed.body).toBeLessThan(400);
    const read = await t.api(partner.device, {
      method: 'GET',
      url: `/api/v1/agent-requests/${id}`,
    });
    expect(read.json()).not.toHaveProperty('subject');
    // The garment's owner deletes it: no write reaches the partner's row.
    const deleted = await t.inject({
      method: 'DELETE',
      url: `/wardrobe/${garmentId}`,
      headers: { cookie: owner.cookie, 'hx-request': 'true' },
    });
    expect(deleted.statusCode, deleted.body).toBeLessThan(400);
    expect((await rowOf(id)).garmentId).toBe(garmentId);
  });
});

describe('a replayed ask', () => {
  it('answers the first request with where it is now, not open (#1311)', async () => {
    const a = await asker('requests-replay@example.com');
    const clientId = randomUUID();
    const body = 'Which shoes?';
    const first = await transitionRequest(deps(), agentOf(a.id), {
      kind: 'ask',
      body,
      subject: null,
      clientId,
    });
    expect(first).toEqual({ id: first.id, status: 'open', changed: true });
    await transitionRequest(deps(), agentOf(a.id), {
      kind: 'withdraw',
      id: first.id,
    });
    expect(
      await transitionRequest(deps(), agentOf(a.id), {
        kind: 'ask',
        body,
        subject: null,
        clientId,
      }),
    ).toEqual({ id: first.id, status: 'withdrawn', changed: false });
  });
});

describe('the agent', () => {
  it('two claim at once: the first holds it, the second is refused', async () => {
    const a = await asker('requests-race@example.com');
    const id = await asked(a, 'Find me three cheaper options');
    const [laptop, phone] = [await a.agent('Laptop'), await a.agent('Phone')];
    const [first, second] = await interleave(
      t.db,
      (tx) =>
        transitionRequest({ db: tx, logger: t.logger }, agentOf(a.id), {
          kind: 'claim',
          id,
          tokenId: laptop,
        }),
      () =>
        transitionRequest(deps(), agentOf(a.id), {
          kind: 'claim',
          id,
          tokenId: phone,
        }).then(
          () => undefined,
          (error: unknown) => error,
        ),
    );
    expect(first).toEqual({ id, status: 'claimed', changed: true });
    expect(second).toBeInstanceOf(HttpError);
    expect((second as HttpError).message).toBe(
      'Another agent is working on this request',
    );
    expect(await rowOf(id)).toMatchObject({
      status: 'claimed',
      claimedByTokenId: laptop,
    });
    // Its own second claim renews the lease.
    await expect(
      transitionRequest(deps(), agentOf(a.id), {
        kind: 'claim',
        id,
        tokenId: laptop,
      }),
    ).resolves.toEqual({ id, status: 'claimed', changed: true });
  });

  it('a revoked token frees its claim at once: another agent claims it', async () => {
    const a = await asker('requests-revoked@example.com');
    const id = await asked(a, 'Pack me for Porto');
    const [laptop, phone] = [await a.agent('Laptop'), await a.agent('Phone')];
    const claim = (tokenId: number) =>
      transitionRequest(deps(), agentOf(a.id), { kind: 'claim', id, tokenId });
    await claim(laptop);
    expect(await revokeToken(deps(), agentOf(a.id), 'mcp', laptop)).toBe(true);
    await expect(claim(phone)).resolves.toEqual({
      id,
      status: 'claimed',
      changed: true,
    });
    expect((await rowOf(id))?.claimedByTokenId).toBe(phone);
  });

  it('a blank or over-long answer is a 400, never the constraint’s 500', async () => {
    const a = await asker('requests-answer@example.com');
    const id = await asked(a, 'What should I wear?');
    const tokenId = await a.agent('Laptop');
    const answer = (text: string) =>
      refusalOf(a.id, { kind: 'answer', id, tokenId, answer: text });
    expect(await answer('  \n ')).toMatchObject({ status: 400 });
    expect(await answer('x'.repeat(REQUEST_ANSWER_MAX + 1))).toMatchObject({
      status: 400,
    });
    expect((await rowOf(id))?.status).toBe('open');
    await expect(
      transitionRequest(deps(), agentOf(a.id), {
        kind: 'answer',
        id,
        tokenId,
        answer: `  ${'x'.repeat(REQUEST_ANSWER_MAX)}  `,
      }),
    ).resolves.toMatchObject({ status: 'answered' });
    expect((await rowOf(id))?.answer).toBe('x'.repeat(REQUEST_ANSWER_MAX));
  });

  it('an expired lease is taken over; the first agent’s answer is refused, the new one’s is the asker’s to see once', async () => {
    const a = await asker('requests-lease@example.com');
    const id = await asked(a, 'Pack me for Lisbon');
    const [laptop, phone] = [await a.agent('Laptop'), await a.agent('Phone')];
    const claim = (tokenId: number) =>
      transitionRequest(deps(), agentOf(a.id), { kind: 'claim', id, tokenId });
    await claim(laptop);
    await asFixture(t.db, (tx) =>
      tx
        .update(agentRequest)
        .set({
          claimedAt: sql`now() - make_interval(mins => ${CLAIM_LEASE_MINUTES + 1})`,
        })
        .where(eq(agentRequest.id, id)),
    );
    await expect(claim(phone)).resolves.toEqual({
      id,
      status: 'claimed',
      changed: true,
    });
    expect(
      await refusalOf(a.id, {
        kind: 'answer',
        id,
        tokenId: laptop,
        answer: 'Done',
      }),
    ).toEqual({ status: 409, message: 'Another agent took this request' });

    const answer = 'I packed three outfits on the trip.';
    await expect(
      transitionRequest(deps(), agentOf(a.id), {
        kind: 'answer',
        id,
        tokenId: phone,
        answer,
      }),
    ).resolves.toEqual({ id, status: 'answered', changed: true });
    expect(
      await refusalOf(a.id, { kind: 'answer', id, tokenId: phone, answer }),
    ).toMatchObject({ message: 'Already answered' });

    const read = await t.api(a.device, {
      method: 'GET',
      url: `/api/v1/agent-requests/${id}`,
    });
    expect(read.json()).toMatchObject({
      status: 'answered',
      answer,
      answeredBy: { name: 'Phone' },
    });
    expect(read.json()).not.toHaveProperty('claimedBy');
    const seen = () =>
      t.api(a.device, {
        method: 'POST',
        url: `/api/v1/agent-requests/${id}/seen`,
      });
    expect((await seen()).json()).toMatchObject({ changed: true });
    expect((await seen()).json()).toMatchObject({ changed: false });

    // One line per change, from the action, naming the request and the
    // token; never what was asked or answered.
    const lines = t.logs.records.filter(
      (record) => record.requestId === id && typeof record.op === 'string',
    );
    expect(lines.map((line) => line.op)).toEqual([
      'agent.request.asked',
      'agent.request.claimed',
      'agent.request.claimed',
      'agent.request.answered',
      'agent.request.seen',
    ]);
    expect(lines[2]).toMatchObject({ tokenId: phone, claim: 'takeover' });
    const logged = JSON.stringify(t.logs.records);
    expect(logged).not.toContain(answer);
    expect(logged).not.toContain('Pack me for Lisbon');
  });
});
