import type { FastifyInstance, FastifyReply } from 'fastify';
import { isWarmRequest } from '../warm-request';
import type { Metrics } from './metrics';
import { serverTimingHeader } from './request-timing';

/** The route label of a request no route matched (the 404 page). */
export const UNMATCHED_ROUTE = 'unmatched';

/** The answer's ETag as one string (a page's, set by src/web/render.ts), if any. */
const etagOf = (header: ReturnType<FastifyReply['getHeader']>) =>
  typeof header === 'string' ? header : undefined;

/**
 * The per-request half of the metrics, on the root instance before anything
 * else (createApp): every route's template is noted as it is registered (the
 * device beacon may name only those), each request answers with its
 * RequestTiming (created by src/request-context.ts) as `Server-Timing` (db,
 * render, the route template, a page's ETag; not once a secret was checked,
 * markSecretChecked) and lands in
 * http_request_duration_seconds and http_request_db_statements under its
 * route template, never its URL, so
 * ids never become series. A request the service worker made to warm the
 * offline caches (#286: hundreds of renders a day per device, no one
 * waiting) is left out, so the latencies stay a person's.
 *
 * Hooks, not a plugin: added to the root, they apply to every route
 * registered after them (AGENTS.md Gotchas, plugin inheritance).
 */
export function registerHttpMetrics(
  app: FastifyInstance,
  metrics: Metrics,
): void {
  app.addHook('onRoute', (route) => {
    metrics.addRoute(route.url);
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.timing && !request.timing.secretChecked) {
      reply.header(
        'Server-Timing',
        serverTimingHeader(
          request.timing,
          request.routeOptions.url,
          etagOf(reply.getHeader('ETag')),
        ),
      );
    }
    done(null, payload);
  });
  app.addHook('onResponse', (request, reply, done) => {
    if (isWarmRequest(request.headers)) {
      done();
      return;
    }
    metrics.observeRequest(
      request.routeOptions.url ?? UNMATCHED_ROUTE,
      request.method,
      reply.statusCode,
      reply.elapsedTime / 1000,
      request.timing?.dbStatements ?? 0,
    );
    done();
  });
}
