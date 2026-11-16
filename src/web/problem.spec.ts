import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { recordErrors } from '../../test/support/sentry-stub';
import {
  createErrorHandler,
  DatabaseOutage,
  HttpError,
  OwnerLockTimeout,
} from './errors';
import type { Translated } from './i18n';
import { Forbidden, NotFound } from './refusals';
import { assignSurface } from './surface';

/**
 * The error handler on the API surface (#190): whatever a route under
 * /api/v1 throws, or a path no route matches under /api, answers a problem
 * body, never the HTML error page, even where a page context exists. The
 * integration tier (test/integration/api.spec.ts) proves the app's own
 * routes; these throw what a domain function can.
 */

let app: FastifyInstance;

beforeEach(async () => {
  const { logger } = captureLogs();
  app = Fastify({ genReqId: () => 'req123' });
  app.addHook('onRoute', assignSurface);
  // A page context on every request, as app.ts builds for pages: the API
  // must not render the page from it.
  app.decorateReply('locals', undefined);
  app.setErrorHandler(
    createErrorHandler(
      logger,
      recordErrors().tracker,
      new DatabaseOutage(logger),
    ),
  );
  app.setNotFoundHandler((request) => {
    throw new HttpError(
      404,
      `Cannot ${request.method} ${request.url}` as Translated,
    );
  });
  app.get('/api/v1/garment', () => {
    throw new NotFound('garment', { logDetail: 'garment 41 of owner 7' });
  });
  app.get('/api/v1/forbidden', () => {
    throw new Forbidden();
  });
  app.get('/api/v1/busy', () => {
    throw new OwnerLockTimeout('scheduleOutfit', 7);
  });
  app.get('/api/v1/boom', () => {
    throw new Error('connection refused at 10.0.0.5');
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const problem = (status: number, title: string, rest: object) => ({
  type: 'about:blank',
  title,
  status,
  requestId: 'req123',
  ...rest,
});

describe('problem+json on the api surface', () => {
  it.each([
    [
      '/api/v1/garment',
      problem(404, 'Not Found', {
        detail: 'Garment not found',
        code: 'not_found',
      }),
    ],
    [
      '/api/v1/forbidden',
      problem(403, 'Forbidden', { detail: 'Forbidden', code: 'forbidden' }),
    ],
    [
      '/api/v1/boom',
      // A 500 says nothing of what failed.
      problem(500, 'Internal Server Error', { code: 'internal' }),
    ],
  ])('answers %s with its problem', async (url, body) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toEqual(body);
    expect(res.body).not.toContain('<');
    expect(res.body).not.toContain('41');
  });

  it('answers the owner lock with busy and Retry-After', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/busy' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toMatchObject({ code: 'busy', status: 503 });
  });

  it('answers an unmatched /api path, any case, with a problem', async () => {
    const res = await app.inject({ method: 'GET', url: '/API/v1/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  it('leaves a page path to the page handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/apix' });
    expect(res.headers['content-type']).not.toMatch(/problem/);
  });
});
