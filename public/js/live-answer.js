/**
 * Whether connectivity.js's heartbeat reached this server (#731): a 2xx
 * carrying /health/live's own header (`LIVE_HEADER` in
 * src/web/health/routes.ts; test/integration/delivery.spec.ts holds the
 * two equal). Any 2xx is not enough: on the plain-HTTP twin a captive portal
 * or an intercepting proxy answers 200 or 204 itself, and an app that took
 * that for online would replay its queued writes into it.
 *
 * Unit-tested in src/web/layout/live-answer.spec.ts.
 */

export const LIVE_HEADER = 'X-Closet-Live';
export const LIVE_VALUE = 'up';

/**
 * @param {{ ok: boolean, headers: Pick<Headers, 'get'> }} response
 * @returns {boolean}
 */
export function isLiveAnswer(response) {
  return response.ok && response.headers.get(LIVE_HEADER) === LIVE_VALUE;
}
