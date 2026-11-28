import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRequest } from '../../src/db/schema';
import {
  CLAIM_LEASE_MINUTES,
  REQUEST_ANSWER_MAX,
  REQUEST_BODY_MAX,
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
import {
  asFixture,
  createTestApp,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { interleave } from './interleave';
import { mintToken } from './mcp';

/**
 * "Ask your agent" requests (#681 B1, src/web/requests/AGENTS.md): the
 * asker's API and pages (#1286: Today's card, the list and a request), and the machine's moves as the agent's tools (#1287) will
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

  // The asker's pages (#1286): Today's card lists what is open, claimed or
  // answered and not seen yet, the no-agent line until a token is minted;
  // Got it takes one off Today; the request's page links its subject.
  it('shows Today and the pages where each request stands', async () => {
    const a = await asker('requests-pages@example.com');
    const page = async (url: string) => {
      const res = await t.inject({
        method: 'GET',
        url,
        headers: { cookie: a.cookie },
      });
      expect(res.statusCode, url).toBe(200);
      return unescapeHtml(res.body);
    };
    const cardOf = (html: string) =>
      /<section[^>]*data-today-requests="(\d+)"[\s\S]*?<\/section>/.exec(html);
    const tee = await createGarment(t, { name: 'Pages tee', cookie: a.cookie });
    const asks = await t.inject({
      method: 'POST',
      url: '/requests',
      payload: {
        body: 'What goes with this?',
        subjectKind: 'garment',
        subjectId: String(tee),
      },
      headers: { cookie: a.cookie },
    });
    expect(asks.statusCode).toBe(303);
    const open = Number(/^\/requests\/(\d+)$/.exec(asks.headers.location!)![1]);
    const waiting = cardOf(await page('/'))!;
    expect(waiting[1]).toBe('1');
    expect(waiting[0]).toContain('Waiting for your agent');
    expect(waiting[0]).toContain('data-no-agent');
    const detail = await page(`/requests/${open}`);
    expect(detail).toContain(`href="/wardrobe/${tee}" class="link">Pages tee`);
    expect(detail).toContain(`action="/requests/${open}/withdraw"`);

    const tokenId = await a.agent('Pages agent');
    const claimed = await asked(a, 'Pack me for this');
    const answered = await asked(a, 'Find me three cheaper options');
    const gone = await asked(a, 'Never mind');
    for (const move of [
      { kind: 'claim', id: claimed, tokenId },
      { kind: 'answer', id: answered, tokenId, answer: 'Three under $40.' },
    ] as const) {
      await transitionRequest(deps(), agentOf(a.id), move);
    }
    await transitionRequest(deps(), agentOf(a.id), {
      kind: 'withdraw',
      id: gone,
    });
    const card = cardOf(await page('/'))!;
    expect(card[1]).toBe('3');
    expect(card[0]).toMatch(/data-agent="Pages agent"[\s\S]*is on it/);
    expect(card[0]).toContain('Three under $40.');
    expect(card[0]).toContain(`action="/requests/${answered}/seen"`);
    expect(card[0]).not.toContain('Never mind');
    expect(card[0]).not.toContain('data-no-agent');

    const seen = await t.inject({
      method: 'POST',
      url: `/requests/${answered}/seen`,
      payload: { returnTo: '/' },
      headers: { cookie: a.cookie },
    });
    expect([seen.statusCode, seen.headers.location]).toEqual([303, '/']);
    expect(cardOf(await page('/'))![0]).not.toContain('Three under $40.');
    const list = await page('/requests');
    expect(
      Array.from(list.matchAll(/data-request="(\d+)"/g), (m) => Number(m[1])),
    ).toEqual([gone, answered, claimed, open]);
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
  it('Today says no agent is connected while an older request waits beyond the shown few', async () => {
    const a = await asker('requests-beyond@example.com');
    await asked(a, 'Still waiting');
    const tokenId = await a.agent('Gone soon');
    for (const body of ['One', 'Two', 'Three']) {
      const id = await asked(a, body);
      await transitionRequest(deps(), agentOf(a.id), {
        kind: 'answer',
        id,
        tokenId,
        answer: `Done: ${body}`,
      });
    }
    await revokeToken(deps(), agentOf(a.id), 'mcp', tokenId);
    const today = await t.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: a.cookie },
    });
    const card = /<section[^>]*data-today-requests="4"[\s\S]*?<\/section>/.exec(
      unescapeHtml(today.body),
    )![0];
    expect(card).not.toContain('Still waiting');
    expect(card).toContain('data-no-agent');
  });

  it('measures a multi-line ask as the sheet did: CRLF is one line break, at the limit accepted', async () => {
    const a = await asker('requests-crlf@example.com');
    // A form sends each line break as CRLF; the textarea's maxlength counted
    // it as one, so 100 lines of 4 and one more character are the limit.
    const lines = Array.from({ length: 100 }, () => 'abcd').join('\r\n');
    const atLimit = `${lines}e`;
    expect(atLimit.replaceAll('\r\n', '\n')).toHaveLength(REQUEST_BODY_MAX);
    const send = (body: string) =>
      t.inject({
        method: 'POST',
        url: '/requests',
        payload: { body },
        headers: { cookie: a.cookie },
      });
    const sent = await send(` ${atLimit}\r\n`);
    expect(sent.statusCode, sent.body).toBe(303);
    const id = Number(/^\/requests\/(\d+)$/.exec(sent.headers.location!)![1]);
    expect((await rowOf(id))?.body).toBe(atLimit.replaceAll('\r\n', '\n'));
    expect((await send(`${atLimit}f`)).statusCode).toBe(400);
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
