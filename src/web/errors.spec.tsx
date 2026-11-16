import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, type LogCapture } from '../../test/support/log-capture';
import { DatabaseUnreachable, PoolExhausted } from '../db/errors';
import {
  recordErrors,
  type RecordedErrors,
} from '../../test/support/sentry-stub';
import {
  createErrorHandler,
  DatabaseOutage,
  HttpError,
  REQUEST_FAILED_EVENT,
} from './errors';
import { t } from './i18n';
import { renderPage } from './render';
import type { ViewContext } from './view-context';

/**
 * The app's error handler on a bare Fastify instance: routes that
 * throw what ported handlers can throw. The ported shell routes cannot fail
 * on request (test/integration/web.spec.ts covers their answers), so the
 * throwing routes here exist only in this spec.
 */

const REQUEST_ID = '0123456789ab';

const ctx: ViewContext = {
  appName: 'Closet',
  iconName: 'icon.png',
  siteUrl: 'http://localhost:3000',
  path: '/boom',
  signupsDisabled: false,
  pwaEnabled: false,
  weatherEnabled: false,
  metricsEnabled: false,
  errorTrackingEnabled: false,
  orderReview: false,
  release: 'dev',
  appVersion: 'dev.test',
  timeZone: 'America/New_York',
  canonicalUrl: 'http://localhost/boom',
  ogUrl: 'http://localhost/boom',
  ogImage: 'http://localhost/assets/icon.png',
  user: undefined,
};

describe('createErrorHandler', () => {
  let app: FastifyInstance;
  let logs: LogCapture;
  let errors: RecordedErrors;
  let secondRender: unknown;

  beforeEach(async () => {
    const captured = captureLogs();
    logs = captured.logs;
    errors = recordErrors();
    // A fixed id: the answers name it (createApp mints 12 hex per request).
    app = Fastify({ genReqId: () => REQUEST_ID });
    // What the root preValidation hook in app.ts does for every non-static
    // request.
    app.decorateReply('locals', undefined);
    app.addHook('preValidation', async (request, reply) => {
      if (request.url !== '/static') reply.locals = ctx;
    });
    app.setErrorHandler(
      createErrorHandler(
        captured.logger,
        errors.tracker,
        new DatabaseOutage(captured.logger),
      ),
    );
    app.get('/missing', () => {
      throw new HttpError(404);
    });
    app.get('/busy', () => {
      throw new HttpError(503, 'Try again in a moment.', {
        logDetail: 'owner 7',
      });
    });
    app.get('/pool-full', () => {
      throw new PoolExhausted(
        new Error('timeout exceeded when trying to connect'),
      );
    });
    app.get('/db-down', () => {
      throw new DatabaseUnreachable(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      );
    });
    app.post('/busy-write', () => {
      throw new HttpError(503);
    });
    app.get('/boom', () => {
      throw new Error('connection refused at 10.0.0.5');
    });
    app.get('/curly', () => {
      throw new HttpError(409, 'Undo “Wore today” first…');
    });
    // A multipart part over the size limit fails inside the handler.
    app.get('/too-large', () => {
      throw Object.assign(new Error('request file too large'), {
        statusCode: 413,
        code: 'FST_REQ_FILE_TOO_LARGE',
      });
    });
    // A body parser's refusal that quotes the request, as JSON.parse's
    // SyntaxError does.
    app.get('/quoting', () => {
      throw Object.assign(
        new SyntaxError(
          'Unexpected token, "{"password":"hunter2-sec" is not valid JSON',
        ),
        { statusCode: 400 },
      );
    });
    app.post('/json', () => 'unreachable');
    // As a ported route declares its input (src/web/plugin.ts, Validation).
    app.post(
      '/validated',
      {
        schema: {
          body: {
            type: 'object',
            required: ['date'],
            properties: { date: { type: 'string', format: 'date' } },
          },
        },
      },
      () => 'unreachable',
    );
    app.get('/static', () => {
      throw new Error('boom');
    });
    app.get('/twice', async (_request, reply) => {
      await renderPage(reply, <p>first</p>);
      secondRender = await renderPage(reply, <p>second</p>).catch(
        (error: Error) => error.message,
      );
      return reply;
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('renders the error page with the thrown status', async () => {
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toMatch(/^<!DOCTYPE html><html lang="en">/);
    expect(res.body).toMatch(/<h1\b[^>]*>Not found<\/h1>/);
    expect(res.body).toContain('>Not Found</p>');
    // No session here: no dock (#662).
    expect(res.body).not.toContain('class="dock"');
    expect(logs.messages('warn')).toEqual(['GET /missing -> 404: Not Found']);
  });

  it('keeps a Fastify 4xx thrown in the handler, with a message of ours', async () => {
    const res = await app.inject({ method: 'GET', url: '/too-large' });
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatch(/<h1\b[^>]*>That did not work<\/h1>/);
    expect(res.body).toContain('>The request is too large</p>');
    expect(logs.messages('warn')).toEqual([
      'GET /too-large -> 413: The request is too large (FST_REQ_FILE_TOO_LARGE)',
    ]);
  });

  it('never shows or logs the message of a 4xx it did not write', async () => {
    const res = await app.inject({ method: 'GET', url: '/quoting' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('>The request could not be read</p>');
    expect(res.body).not.toContain('hunter2');
    expect(logs.messages('warn')).toEqual([
      'GET /quoting -> 400: The request could not be read (SyntaxError)',
    ]);
  });

  // Body parsing runs before the root preValidation hook, so there is no page
  // context yet: the status is kept and the answer is data.
  it('answers an unparsable body with a 400 before any page context exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400 });
  });

  // Validation runs after the root preValidation hook: the page context
  // exists, so a malformed input gets the error page.
  it('renders a failed schema validation as the 400 error page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/validated',
      payload: { date: 'garbage' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/^<!DOCTYPE html>/);
    expect(res.body).toMatch(/<h1\b[^>]*>That did not work<\/h1>/);
    expect(res.body).toContain('body/date must match format &quot;date&quot;');
  });

  it('keeps a chosen 5xx HttpError, logged as a warning with its log detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/busy' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('>Try again in a moment.</p>');
    expect(res.body).not.toContain('owner 7');
    expect(logs.messages('warn')).toEqual([
      'GET /busy -> 503: Try again in a moment. (owner 7)',
    ]);
    expect(logs.records.some((record) => record.level === 'error')).toBe(false);
  });

  // #117: the error tracker gets crashes, never an answer the code chose.
  // The owner lock's 503 is contention working as designed (errors.tsx).
  it('sends only the unexpected 500 to the error tracker', async () => {
    for (const url of ['/missing', '/busy', '/too-large']) {
      await app.inject({ method: 'GET', url });
    }
    await app.inject({ method: 'POST', url: '/validated', payload: {} });
    expect(errors.exceptions).toEqual([]);

    await app.inject({ method: 'GET', url: '/boom' });
    expect(errors.exceptions).toHaveLength(1);
    const [{ error, context }] = errors.exceptions;
    expect((error as Error).message).toBe('connection refused at 10.0.0.5');
    expect(context).toEqual({
      source: 'route',
      tags: { route: '/boom', method: 'GET' },
      userId: undefined,
    });
  });

  // #643: a pool full of busy connections is load, not an outage. Taken as
  // one it was captured and latched the outage, which only a new connection
  // ended, never opened while the pool stays full.
  it('answers a full pool busy without capturing it or beginning an outage', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/pool-full' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toContain(t('SERVER_BUSY'));
    }
    expect(errors.exceptions).toEqual([]);
    expect(logs.messages('warn')).toEqual(
      Array(3).fill(
        `GET /pool-full -> 503: ${t('SERVER_BUSY')} (every database connection busy)`,
      ),
    );

    // The outage latch is untouched: the database's first failure after it
    // still begins one, captured.
    await app.inject({ method: 'GET', url: '/db-down' });
    await app.inject({ method: 'GET', url: '/db-down' });
    expect(errors.exceptions).toHaveLength(1);
  });

  it('hides the detail of anything else behind a 500, logged with its stack', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain(
      '>Something went wrong on our side. Try again in a moment.</p>',
    );
    // The id a person quotes when reporting it (its log lines carry it).
    expect(res.body).toContain(`Request ID: ${REQUEST_ID}`);
    expect(res.body).not.toContain('10.0.0.5');
    const [logged] = logs.records.filter((record) => record.level === 'error');
    expect(logged.msg).toBe('GET /boom -> 500');
    expect(logged.err?.stack).toContain('connection refused at 10.0.0.5');
  });

  // #644: a sentence and the way on, never a debug dump.
  describe('the error page by class', () => {
    const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const page = async (url: string, query = '') =>
      (await app.inject({ method: 'GET', url: `${url}${query}` })).body;

    it('a 404 has Back and its way home, no Try again, no id, path or time', async () => {
      const body = await page('/missing');
      expect(body).toContain('data-history-back=""');
      expect(body).toContain('href="/"');
      expect(body).not.toContain('Try again</a>');
      expect(body).not.toContain(REQUEST_ID);
      expect(body).not.toContain('Path:');
      expect(body).not.toMatch(ISO_TIMESTAMP);
    });

    it('a 503 has Try again to the same URL and the id', async () => {
      const body = await page('/busy', '?week=2026-11-09');
      expect(body).toContain('Try again</a>');
      expect(body).toContain('href="/busy?week=2026-11-09"');
      expect(body).toContain(`Request ID: ${REQUEST_ID}`);
      expect(body).not.toMatch(ISO_TIMESTAMP);
    });

    it('a 500 shows the id and no Try again', async () => {
      const body = await page('/boom');
      expect(body).toContain(`Request ID: ${REQUEST_ID}`);
      expect(body).not.toContain('Try again</a>');
      expect(body).not.toContain('Path:');
    });

    it('never offers Try again for a write or a URL carrying a credential', async () => {
      const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
      const withToken = await page('/busy', `?t=${token}`);
      expect(withToken).not.toContain('Try again</a>');
      const post = await app.inject({ method: 'POST', url: '/busy-write' });
      expect(post.body).not.toContain('Try again</a>');
    });
  });

  it("names a fragment request's failure in an ASCII HX-Trigger htmx reads back", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/curly',
      headers: { 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toBe('');
    const trigger = String(res.headers['hx-trigger']);
    expect(trigger).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(trigger)).toEqual({
      [REQUEST_FAILED_EVENT]: {
        message: 'Undo “Wore today” first…',
        requestId: REQUEST_ID,
      },
    });
  });

  it('answers data on a path without a page context', async () => {
    const res = await app.inject({ method: 'GET', url: '/static' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      statusCode: 500,
      message: 'Something went wrong on our side. Try again in a moment.',
      request_id: REQUEST_ID,
    });
  });

  it('never answers twice', async () => {
    const res = await app.inject({ method: 'GET', url: '/twice' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<!DOCTYPE html><p>first</p>');
    expect(secondRender).toBe('/twice: reply already sent');
  });
});

// #842: a query sent before the outage and answered late said the database
// was back, so the next failure was captured as a second outage.
describe('DatabaseOutage', () => {
  it('ends only with an answer to something begun after the outage did', () => {
    const { logger, logs } = captureLogs();
    let clock = 1_000;
    const outage = new DatabaseOutage(logger, () => clock);
    expect(outage.failure()).toBe(true);

    clock = 3_000;
    outage.recovered(900);
    expect(outage.failure()).toBe(false);
    expect(logs.messages('info')).toEqual([]);

    outage.recovered(1_000);
    expect(logs.messages('info')).toEqual([
      'Database reachable again after 2 s; 2 request(s) answered busy',
    ]);
    expect(outage.failure()).toBe(true);
  });
});
