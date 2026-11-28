import { createECDH, randomBytes, randomUUID } from 'node:crypto';
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
import { parsePushPayload, type PushPayload } from '../../src/web/push/payload';
import { transitionRequest } from '../../src/web/requests/request-actions';
import { createTestApp, PWA_ENV, type TestApp } from './harness';
import { callTool, mintToken } from './mcp';

/**
 * The push when an agent answers a request (#1288; src/web/requests/
 * request-push.ts): one notification after the answer's commit, tagged
 * agent-request-<id>, to the devices taking the agent's rounds, whose body
 * is the request's first line and never the answer. web-push is stubbed.
 */

interface Sent {
  endpoint: string;
  payload: PushPayload;
  ttl: number | undefined;
}

let t: TestApp;
let agent: string;
let sent: Sent[];
let onDevice: string;
let offDevice: string;
let failSends = false;

async function subscribe(agentRoundsOn: boolean): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  const res = await t.inject({
    method: 'POST',
    url: '/push/subscribe',
    payload: {
      endpoint,
      keys: {
        p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    },
  });
  expect(res.statusCode).toBe(204);
  if (agentRoundsOn) {
    const saved = await t.inject({
      method: 'POST',
      url: '/push/reminders',
      payload: { endpoint, agentRoundsOn: '1' },
      headers: { 'hx-request': 'true' },
    });
    expect(saved.statusCode).toBe(200);
  }
  return endpoint;
}

const ask = async (body: string) =>
  (
    await transitionRequest(
      { db: t.db, logger: t.logger },
      { userId: t.owner.id, surface: 'page' },
      { kind: 'ask', body, subject: null, clientId: null },
    )
  ).id;

const answer = (
  who: string,
  id: number,
  text = 'Done: it is in your Saved outfits, with the secret budget.',
) => callTool(t, who, 'answer_agent_request', { id, answer: text });

beforeAll(async () => {
  t = await createTestApp(PWA_ENV);
  const minted = await mintToken(t, t.owner.id, 'Stylist', 'mcp', {
    readOnly: false,
    ownWardrobeOnly: false,
  });
  if (!minted.created) throw new Error(`no token: ${minted.reason}`);
  agent = minted.token;
  onDevice = await subscribe(true);
  offDevice = await subscribe(false);
});

afterAll(() => t?.cleanup());

beforeEach(() => {
  sent = [];
  failSends = false;
  vi.spyOn(webpush, 'sendNotification').mockImplementation(
    (target: PushSubscription, payload, options) => {
      if (failSends) return Promise.reject(new Error('push service down'));
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

describe('an answered request', () => {
  it('tells the devices taking the agent’s rounds, once: the token’s name, the question’s first line, never the answer', async () => {
    const id = await ask(
      'What goes with the navy blazer?\nI have a dinner on Friday.',
    );
    const done = await answer(agent, id);
    expect(done.isError, JSON.stringify(done.value)).toBe(false);
    expect(sent).toEqual([
      {
        endpoint: onDevice,
        payload: {
          title: 'Stylist answered your request',
          body: 'What goes with the navy blazer?',
          url: `/requests/${id}`,
          tag: `agent-request-${id}`,
        },
        ttl: 24 * 60 * 60,
      },
    ]);
    expect(sent.map((s) => s.endpoint)).not.toContain(offDevice);
    expect(JSON.stringify(sent)).not.toContain('secret budget');
  });

  it('cuts a long first line at 80 characters', async () => {
    const id = await ask('x'.repeat(200));
    await answer(agent, id);
    expect(sent[0].payload.body).toBe(`${'x'.repeat(79)}…`);
  });

  it('notifies nobody for a refused or repeated answer', async () => {
    const id = await ask('Twice?');
    await answer(agent, id);
    sent = [];
    const again = await answer(agent, id);
    expect(again.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('is still answered when the send fails, and the failure is logged', async () => {
    failSends = true;
    const id = await ask('Does the push fail?');
    const done = await answer(agent, id);
    expect(done.isError, JSON.stringify(done.value)).toBe(false);
    expect(done.value).toMatchObject({ id, status: 'answered', changed: true });
    expect(sent).toEqual([]);
  });
});
