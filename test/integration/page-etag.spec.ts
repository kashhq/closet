import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { garment } from '../../src/db/schema';
import { ASSET_VERSION_HEADER } from '../../src/static-build';
import { createInvite } from '../../src/web/sharing/queries';
import { createGarment } from './garments';
import {
  asFixture,
  createTestApp,
  PWA_ENV,
  type TestApp,
  userIdOf,
} from './harness';

/**
 * A rendered page's validator (#708, send() in src/web/render.ts): the
 * offline warm sends If-None-Match from its stored copy and re-stamps it on
 * a 304 (src/web/shell/offline-warm.md), so an unchanged page costs headers.
 */
const RELEASE = '0123abc';

describe('page ETags', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ ...PWA_ENV, APP_VERSION: RELEASE });
  });

  afterAll(() => t?.cleanup());

  afterEach(() => {
    vi.useRealTimers();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });

  it('answers a matching If-None-Match with a bodiless 304 that keeps the page headers', async () => {
    const id = await createGarment(t, { name: 'Validated tee' });
    const url = `/wardrobe/${id}`;
    const page = await get(url, { 'accept-encoding': 'br, gzip' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-encoding']).toBe('br');
    const etag = String(page.headers.etag);
    expect(etag).toMatch(/^W\/"[\w-]{27}"$/);

    const again = await get(url, {
      'accept-encoding': 'br, gzip',
      // A list, the tag without its W/: weak comparison.
      'if-none-match': `"other", ${etag.slice(2)}`,
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers['content-encoding']).toBeUndefined();
    expect(again.headers['content-length']).toBeUndefined();
    expect(again.headers['content-type']).toBeUndefined();
    expect(again.headers.etag).toBe(etag);
    expect(again.headers['cache-control']).toBe('private, no-cache');
    expect(again.headers['x-page-account']).toBe(String(t.owner.id));
    expect(again.headers[ASSET_VERSION_HEADER.toLowerCase()]).toBe(RELEASE);

    // HEAD names the tag but keeps its 200: Fastify's HEAD route would put
    // Content-Length: 0 on a 304 (send(), src/web/render.ts).
    const head = await t.inject({
      method: 'HEAD',
      url,
      headers: { 'if-none-match': etag },
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers.etag).toBe(etag);

    const changed = await get(url, { 'if-none-match': '"other"' });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).toBe(etag);
  });

  it('keeps a dual-branch route’s Vary on its 304, and answers a fragment request the fragment', async () => {
    const page = await get('/wardrobe');
    const etag = String(page.headers.etag);
    expect(etag).toMatch(/^W\//);
    const again = await get('/wardrobe', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.headers.vary).toBe(page.headers.vary);
    expect(String(again.headers.vary)).toMatch(/HX-Request/i);

    // The page's tag on a fragment request (an HTTP cache may send any
    // stored tag of the URL): never a 304 answering it with the page.
    const fragment = await get('/wardrobe', {
      'hx-request': 'true',
      'if-none-match': etag,
    });
    expect(fragment.statusCode).toBe(200);
    expect(fragment.headers.etag).toBeUndefined();
    expect(fragment.body).not.toContain('<!DOCTYPE html>');
  });

  it('gives no tag to an error page or an answer to a post', async () => {
    const missing = await get('/wardrobe/999999');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.etag).toBeUndefined();
    const id = await createGarment(t, { name: 'Posted tee' });
    const posted = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/wear`,
      payload: { worn: '1' },
    });
    expect(posted.headers.etag).toBeUndefined();
  });

  // The warm refreshes a copy a day old: a garment page whose history did
  // not change must keep its tag across the day (no server-day value in it:
  // "last worn yesterday", Wore today's state and the outbox's day are the
  // client's, views/assets/page-day.ts).
  it('keeps an unchanged garment page’s tag from one day to the next', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-06-10T16:00:00Z'),
    });
    const id = await createGarment(t, { name: 'Day-stable chinos' });
    const url = `/wardrobe/${id}`;
    for (const path of ['/wear', '/washed']) {
      const res = await t.inject({
        method: 'POST',
        url: `${url}${path}`,
        payload: path === '/wear' ? { worn: '1' } : {},
      });
      expect(res.statusCode).toBeLessThan(400);
    }
    const first = await get(url);
    // The wear's day is data (data-worn-on, <time datetime>); the page's
    // own day is nowhere: no outbox day, no dated key, no worn-today state.
    expect(first.body).toContain(`data-worn-on="2026-06-10"`);
    expect(first.body).not.toContain('data-outbox-day');
    expect(first.body).toContain(`data-outbox-key="wear:${id}"`);
    expect(first.body).not.toContain(
      'Undo “Wore today”</button></form><template',
    );
    vi.setSystemTime(new Date('2026-06-11T16:00:00Z'));
    const second = await get(url);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  describe('across accounts', () => {
    const signUp = async (label: string) => {
      const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
      const cookie = await t.register(email);
      return { id: await userIdOf(t, email), cookie };
    };

    it('never answers one account’s tag with a 304 for another', async () => {
      const other = await signUp('etag-other');
      const mine = await get('/calendar');
      const theirs = await get('/calendar', { cookie: other.cookie });
      expect(theirs.headers.etag).not.toBe(mine.headers.etag);
      const crossed = await get('/calendar', {
        cookie: other.cookie,
        'if-none-match': String(mine.headers.etag),
      });
      expect(crossed.statusCode).toBe(200);
    });

    it('answers a grantee 200 once the owner has edited the shared garment', async () => {
      const grantee = await signUp('etag-grantee');
      const { inviteToken } = await createInvite(t.db, t.owner.id, 'VIEW');
      const accepted = await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${inviteToken}/accept`,
        headers: { cookie: grantee.cookie },
      });
      expect(accepted.statusCode).toBe(302);
      const id = await createGarment(t, { name: 'Shared coat' });
      const url = `/wardrobe/${id}?ownerId=${t.owner.id}`;
      const seen = await get(url, { cookie: grantee.cookie });
      expect(seen.statusCode).toBe(200);
      const etag = String(seen.headers.etag);
      expect(etag).not.toBe(
        String((await get(`/wardrobe/${id}`)).headers.etag),
      );
      expect(
        (await get(url, { cookie: grantee.cookie, 'if-none-match': etag }))
          .statusCode,
      ).toBe(304);

      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({ name: 'Edited coat' })
          .where(eq(garment.id, id)),
      );
      const after = await get(url, {
        cookie: grantee.cookie,
        'if-none-match': etag,
      });
      expect(after.statusCode).toBe(200);
      expect(after.body).toContain('Edited coat');
    });
  });
});
