import { describe, expect, it } from 'vitest';
// connectivity.ts's heartbeat: its verdict is this pure helper, tested here.
import { isLiveAnswer, LIVE_HEADER, LIVE_VALUE } from './live-answer';

describe('isLiveAnswer', () => {
  it.each([
    // /health/live itself.
    [200, { [LIVE_HEADER]: LIVE_VALUE }, true],
    // A captive portal's or an intercepting proxy's own answer (#731):
    // something answers, but not this server.
    [200, {}, false],
    [204, {}, false],
    [200, { [LIVE_HEADER]: 'down' }, false],
    // The header on a failure is still no answer.
    [503, { [LIVE_HEADER]: LIVE_VALUE }, false],
  ] as const)('%i %j is live: %s', (status, headers, live) => {
    const response = new Response(status === 204 ? null : '', {
      status,
      headers,
    });
    expect(isLiveAnswer(response)).toBe(live);
  });
});
