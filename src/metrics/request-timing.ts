import { currentRequest } from '../request-context';

/**
 * Where a request's server time went, for its `Server-Timing` header
 * (registerHttpMetrics): `db`, the time its queries held a pool connection
 * (the wait for one included; concurrent queries add up), and `render`, the
 * time spent turning JSX into HTML. A device reads both beside its own
 * timings, so a slow tap can be split into server and network.
 *
 * Carried in the request's async context (src/request-context.ts, which
 * creates it), not passed along: the pool (src/db/client.ts) and the
 * renderer (src/web/render.ts) run far from the request object. Outside a
 * request (the timers, the CLIs) there is no timing and nothing is recorded.
 */
export interface RequestTiming {
  dbMs: number;
  /**
   * SQL statements the request sent, transaction control included (the
   * pool's StatementCounter, src/db/client.ts): http_request_db_statements
   * and the access line's db_statements. Not in Server-Timing.
   */
  dbStatements: number;
  renderMs: number;
  /** A secret the request carries was checked: no Server-Timing (markSecretChecked). */
  secretChecked: boolean;
}

/** The timing of the request this code runs for, if any. */
export function currentRequestTiming(): RequestTiming | undefined {
  return currentRequest()?.timing;
}

/**
 * Called by every function that checks a secret a request carries, before
 * it looks: verifyPassword (src/web/auth/passwords.ts), authenticateToken
 * (personal-tokens.ts) and the invite lookups (src/web/sharing/queries.ts).
 * That request then answers without Server-Timing, whose `db` and `render`
 * would hand a guesser the server's own time without the network's jitter:
 * whether an email's lookup found a row, whether a token matched (#136).
 * Marked by the check itself rather than declared per route, so a new route
 * that checks a password or a token is covered without remembering to. In
 * async context like the rest of the timing, so the query layer needs no
 * request; outside one (the seed, the CLIs) it does nothing.
 */
export function markSecretChecked(): void {
  const timing = currentRequestTiming();
  if (timing) timing.secretChecked = true;
}

/** Awaits `render`, adding its time to the request's `render`. */
export async function timeRender<T>(render: () => Promise<T>): Promise<T> {
  const timing = currentRequestTiming();
  const started = performance.now();
  try {
    return await render();
  } finally {
    if (timing) timing.renderMs += performance.now() - started;
  }
}

/**
 * The Server-Timing entry that repeats a page's ETag (src/web/render.ts),
 * its opaque value without `W/` or quotes, for the one reader that cannot
 * see the header: a document's own script, through Navigation Timing.
 * public/js/freshness.js sends it back as If-None-Match after a sync, so an
 * unchanged page answers 304 and offers nothing (#900); it duplicates this
 * name (it cannot import a TS module).
 */
export const PAGE_TAG_TIMING_NAME = 'etag';

/**
 * The header's value. `route` carries the matched route template as a
 * description, which is how public/js/vitals.js names what it measured
 * without ever sending a URL (a full load reads it from Navigation Timing's
 * serverTiming, an htmx request from the header). `etag`, the answer's
 * ETag, is repeated as PAGE_TAG_TIMING_NAME.
 */
export function serverTimingHeader(
  timing: RequestTiming,
  route: string | undefined,
  etag?: string,
): string {
  const entries = [
    `db;dur=${timing.dbMs.toFixed(1)}`,
    `render;dur=${timing.renderMs.toFixed(1)}`,
  ];
  if (route) entries.push(`route;desc="${route}"`);
  const opaque = etag?.replace(/^W\//, '').replace(/"/g, '');
  if (opaque) entries.push(`${PAGE_TAG_TIMING_NAME};desc="${opaque}"`);
  return entries.join(', ');
}
