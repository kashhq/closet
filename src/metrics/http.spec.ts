import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { DISABLED_ERROR_TRACKER } from './error-tracker';
import { registerRequestContext } from '../request-context';
import {
  configurePasswordHashing,
  verifyPassword,
} from '../web/auth/passwords';
import { registerHttpMetrics } from './http';
import { Metrics } from './metrics';

// Server-Timing fails closed (#136): a route that checks a secret needs no
// declaration, since the check itself marks its request. These routes are
// the next credential route someone writes and flags nothing on.
describe('registerHttpMetrics, Server-Timing', () => {
  const app = Fastify();

  beforeAll(async () => {
    // As createApp: the timing lives in the request context; bcrypt at its
    // floor, since only the mark matters here.
    configurePasswordHashing(4);
    registerRequestContext(app);
    registerHttpMetrics(
      app,
      new Metrics({
        enabled: false,
        version: 'abc1234',
        logger: captureLogs().logger,
        errors: DISABLED_ERROR_TRACKER,
      }),
    );
    app.post<{ Body: { password: string } }>(
      '/reset-password',
      async (request) => ({
        ok: await verifyPassword(request.body.password, undefined),
      }),
    );
    app.post('/plain', () => Promise.resolve({ ok: true }));
    app.get('/tagged', (_request, reply) =>
      reply.header('ETag', 'W/"abc-123"').send('page'),
    );
    await app.ready();
  });

  afterAll(() => app.close());

  it('leaves it off a request that checked a password, with no route flag', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { password: 'Guess1234' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['server-timing']).toBeUndefined();
  });

  it('keeps it on a request that checked none', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/plain',
      payload: { password: 'Guess1234' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['server-timing']).toContain('route;desc="/plain"');
  });

  // A document's script reads no header but Server-Timing: freshness.js
  // sends the tag back as If-None-Match after a sync (#900).
  it('repeats an answer’s ETag as its opaque value', async () => {
    const res = await app.inject({ method: 'GET', url: '/tagged' });
    expect(res.headers['server-timing']).toContain('etag;desc="abc-123"');
    const plain = await app.inject({ method: 'POST', url: '/plain' });
    expect(plain.headers['server-timing']).not.toContain('etag');
  });
});
