import { t } from '../i18n';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../errors';

/**
 * Makes this plugin's routes read a text/plain body as JSON, up to
 * `maxBytes`: the pages' beacons (POST /metrics/vitals, POST /errors/client)
 * post with `navigator.sendBeacon`, whose string body is text/plain, a
 * simple request in every browser, where a JSON Blob is refused by some.
 * Fastify encapsulates the parser, so no route outside the plugin reads
 * text/plain this way.
 */
export function readBeaconBodies(app: FastifyInstance, maxBytes: number): void {
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser(
    'text/plain',
    { parseAs: 'string', bodyLimit: maxBytes },
    (_request, body, parsed) => {
      try {
        parsed(null, JSON.parse(body as string));
      } catch {
        parsed(new HttpError(400, t('refusal.request.unreadable')), undefined);
      }
    },
  );
}
