import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transitionRequest } from '../../src/web/requests/request-actions';
import { createTrip } from '../../src/web/trips/queries';
import { createGarment } from './garments';
import { asFixture, createTestApp, type TestApp, userIdOf } from './harness';
import { callTool, mcpRequest, mintToken } from './mcp';

/**
 * "Ask your agent" over MCP (#681 B3, src/web/requests/AGENTS.md): what
 * list_agent_requests lists and how it projects a subject, the claim and
 * answer through the one writer, and a read-only token. The machine's own
 * edges are agent-requests.spec.ts's; the stamps mcp-attribution.spec.ts's.
 */

let t: TestApp;
let userId: number;
let agent: string;
let rival: string;
let readOnly: string;

const ask = async (
  subject: { kind: 'garment' | 'trip' | 'need'; id: number } | null,
  body = 'Help me',
  owner: number = userId,
) =>
  (
    await transitionRequest(
      { db: t.db, logger: t.logger },
      { userId: owner, surface: 'page' },
      { kind: 'ask', body, subject, clientId: null },
    )
  ).id;

async function token(name: string, readOnlyScope = false): Promise<string> {
  const minted = await mintToken(t, userId, name, 'mcp', {
    readOnly: readOnlyScope,
    ownWardrobeOnly: false,
  });
  if (!minted.created) throw new Error(`no token: ${minted.reason}`);
  return minted.token;
}

const list = async (who: string) => {
  const answer = await callTool(t, who, 'list_agent_requests');
  expect(answer.isError, JSON.stringify(answer.value)).toBe(false);
  return (
    answer.value as {
      requests: {
        id: number;
        body: string;
        status: string;
        claimedByYou: boolean;
        subject: Record<string, unknown> | null;
      }[];
    }
  ).requests;
};

beforeAll(async () => {
  t = await createTestApp();
  userId = t.owner.id;
  agent = await token('Agent');
  rival = await token('Rival');
  readOnly = await token('Reader', true);
});

afterAll(async () => {
  await t?.cleanup();
});

describe('list_agent_requests', () => {
  it('lists the oldest first with each subject through its resource mapper, and no one else’s', async () => {
    const garmentId = await createGarment(t, { name: 'Navy blazer' });
    const tripId = await asFixture(t.db, (tx) =>
      createTrip(tx, userId, {
        name: 'Austin',
        destination: null,
        startsOn: t.today(),
        endsOn: t.today(),
        notes: null,
      }),
    );
    const first = await ask({ kind: 'garment', id: garmentId }, 'About this');
    const second = await ask({ kind: 'trip', id: tripId }, 'About the trip');
    const third = await ask(null, 'Plain');
    const other = await t.register('requests-other@example.com');
    expect(other).toBeTruthy();
    await ask(
      null,
      'Not yours',
      await userIdOf(t, 'requests-other@example.com'),
    );

    const requests = await list(agent);
    expect(requests.map((r) => r.id)).toEqual([first, second, third]);
    expect(requests[0]).toMatchObject({
      status: 'open',
      claimedByYou: false,
      subject: { kind: 'garment', id: garmentId, name: 'Navy blazer' },
    });
    expect(requests[1].subject).toMatchObject({
      kind: 'trip',
      id: tripId,
      name: 'Austin',
      outfits: 0,
    });
    expect(requests[2].subject).toBeNull();
  });

  it('shows a claim to its token only, and again once its lease is gone', async () => {
    const id = await ask(null, 'Claim me');
    await callTool(t, agent, 'claim_agent_request', { id });
    expect((await list(agent)).find((r) => r.id === id)).toMatchObject({
      status: 'claimed',
      claimedByYou: true,
    });
    expect((await list(rival)).some((r) => r.id === id)).toBe(false);
    await asFixture(t.db, (tx) =>
      tx.execute(
        sql`update agent_request set claimed_at = now() - interval '31 minutes' where id = ${id}`,
      ),
    );
    expect((await list(rival)).find((r) => r.id === id)).toMatchObject({
      status: 'claimed',
      claimedByYou: false,
    });
  });
});

describe('claim and answer', () => {
  it('answers a claim, and refuses the rival, a repeat and an unknown id in the machine’s words', async () => {
    const id = await ask(null, 'Work');
    expect(
      (await callTool(t, agent, 'claim_agent_request', { id })).value,
    ).toMatchObject({ id, status: 'claimed' });
    const held = await callTool(t, rival, 'claim_agent_request', { id });
    expect(held).toMatchObject({ isError: true });
    expect(JSON.stringify(held.value)).toContain(
      'Another agent is working on this request',
    );
    const done = await callTool(t, agent, 'answer_agent_request', {
      id,
      answer: 'Did it',
    });
    expect(done.value).toMatchObject({ id, status: 'answered', changed: true });
    const again = await callTool(t, agent, 'answer_agent_request', {
      id,
      answer: 'Again',
    });
    expect(JSON.stringify(again.value)).toContain('Already answered');
    expect((await list(agent)).some((r) => r.id === id)).toBe(false);
    const unknown = await callTool(t, agent, 'claim_agent_request', {
      id: 2_000_000,
    });
    expect(JSON.stringify(unknown.value)).toContain('Request not found');
  });
});

describe('a read-only token', () => {
  it('lists requests and cannot claim or answer them', async () => {
    const id = await ask(null, 'Read only');
    expect((await list(readOnly)).some((r) => r.id === id)).toBe(true);
    for (const [name, args] of [
      ['claim_agent_request', { id }],
      ['answer_agent_request', { id, answer: 'No' }],
    ] as const) {
      const res = await mcpRequest(t, readOnly, 'tools/call', {
        name,
        arguments: args,
      });
      expect(res.body).toContain(`Tool ${name} not found`);
    }
    expect((await list(agent)).find((r) => r.id === id)?.status).toBe('open');
  });
});
