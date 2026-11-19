/**
 * Says an answer is this server's /health/live (#731): the route sends the
 * header (src/web/health/routes.ts) and connectivity.ts's heartbeat
 * (views/assets/page/) counts a 2xx as online only with it. Any 2xx is not
 * enough: on the plain-HTTP twin a captive portal or an intercepting proxy
 * answers 200 or 204 itself, and an app that took that for online would
 * replay its queued writes into it. Pure: the heartbeat's bundle imports it.
 */

export const LIVE_HEADER = 'X-Closet-Live';
export const LIVE_VALUE = 'up';

export function isLiveAnswer(response: {
  ok: boolean;
  headers: Pick<Headers, 'get'>;
}): boolean {
  return response.ok && response.headers.get(LIVE_HEADER) === LIVE_VALUE;
}
