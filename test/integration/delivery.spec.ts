import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_VERSION_HEADER } from '../../src/static-build';
import { PUBLIC_DIR } from '../../src/static-assets';
import { REPLAY_TIMEOUT_MS } from '../../src/offline-writes';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { HEALTH_LIMIT } from '../../src/web/security/rate-limit';
import {
  createTestApp,
  PWA_ENV,
  TestApp,
  unescapeHtml,
  uniqueClient,
} from './harness';

/**
 * How the app shell reaches the installed PWA: cache headers on static roots,
 * the heartbeat, versioned asset URLs in the layout, and the wardrobe
 * fragment path that htmx filtering swaps into #wardrobe-main.
 */
// What the image's build bakes in (Dockerfile ARG -> ENV): the heartbeat and
// the asset keys name it.
const RELEASE = '0123abc';

describe('delivery (PWA_ENABLED=true)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ ...PWA_ENV, APP_VERSION: RELEASE });
  });

  afterAll(() => t?.cleanup());

  describe('static cache policy', () => {
    it('serves the client libraries immutable for a year', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/modules/htmx.min.js',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
    });

    it('serves public/ files immutable for a year', async () => {
      const res = await t.inject({ method: 'GET', url: '/js/connectivity.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
    });

    it('keeps the service worker revalidating', async () => {
      // Asking for brotli: the precompressed worker (sw.js.br on disk) must
      // get the worker's policy too, not the year the other files get.
      const res = await t.inject({
        method: 'GET',
        url: '/sw.js',
        headers: { 'accept-encoding': 'br' },
      });
      // Built by `npm run generate:sw`; when it is absent the policy is still
      // what matters, and a 404 says nothing about it.
      if (res.statusCode === 200) {
        expect(res.headers['cache-control']).toBe('no-cache');
      } else {
        expect(res.statusCode).toBe(404);
      }
    });

    it('keeps the manifest revalidating', async () => {
      const res = await t.inject({ method: 'GET', url: '/manifest.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    // The server removes backgrounds: the in-browser model, its runtime and
    // its WASM are no longer served.
    it.each([
      '/modules/background-removal/index.mjs',
      '/modules/onnxruntime-web/dist/ort.all.bundle.min.mjs',
      '/bg-removal-models/resources.json',
    ])('no longer serves the in-browser model: %s is a 404', async (url) => {
      expect((await t.inject({ method: 'GET', url })).statusCode).toBe(404);
    });
  });

  // The build writes a .br and a .gz beside each static text file
  // (scripts/static-assets.ts; the integration project's globalSetup does
  // the same to public/), and @fastify/static serves the one asked for.
  describe('precompressed static files', () => {
    const file = (path: string) => readFileSync(join(PUBLIC_DIR, path));
    // The source's type, never the variant's (application/octet-stream).
    const JAVASCRIPT = 'application/javascript; charset=utf-8';

    it.each([
      ['/js/connectivity.js', 'js/connectivity.js'],
      ['/modules/htmx.min.js', 'modules/htmx.min.js'],
      // An importmap module: a wrong type and the browser refuses it.
      ['/modules/workbox-window.prod.mjs', 'modules/workbox-window.prod.mjs'],
    ])('serves %s as brotli to a client that accepts it', async (url, path) => {
      const res = await t.inject({
        method: 'GET',
        url: `${url}?v=1`,
        headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');
      expect(res.headers['content-type']).toBe(JAVASCRIPT);
      expect(res.headers['vary']).toMatch(/accept-encoding/i);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      // The request metrics' onSend adds a header and leaves the body alone.
      expect(res.headers['server-timing']).toBeDefined();
      // The variant on disk, byte for byte: not compressed again on the way.
      expect(res.rawPayload.equals(file(`${path}.br`))).toBe(true);
      expect(brotliDecompressSync(res.rawPayload).equals(file(path))).toBe(
        true,
      );
    });

    it('serves gzip to a client without brotli', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/js/connectivity.js',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['content-type']).toBe(JAVASCRIPT);
      expect(res.headers['vary']).toMatch(/accept-encoding/i);
      expect(res.rawPayload.equals(file('js/connectivity.js.gz'))).toBe(true);
      expect(
        gunzipSync(res.rawPayload).equals(file('js/connectivity.js')),
      ).toBe(true);
    });

    it('serves the file itself to a request without Accept-Encoding', async () => {
      const res = await t.inject({ method: 'GET', url: '/js/connectivity.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['content-type']).toBe(JAVASCRIPT);
      // A shared cache must not hand this copy to a client that accepts br.
      expect(res.headers['vary']).toMatch(/accept-encoding/i);
      expect(res.rawPayload.equals(file('js/connectivity.js'))).toBe(true);
    });

    it('still compresses pages on the fly', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { 'accept-encoding': 'br' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');
      expect(brotliDecompressSync(res.rawPayload).toString()).toContain(
        '<html',
      );
    });

    it('boots serving the variants, none of them stale', () => {
      expect(t.logs.messages('info', 'StaticAssets')).toContainEqual(
        expect.stringMatching(/^Static assets: \d+ precompressed variant/),
      );
    });
  });

  // The health contract (src/web/health): the real round-trip on the
  // spec's database. The harness builds the app without serve(), so no
  // timer or queue runs: both optional checks are down and the app is up.
  describe('/health/live, /health/ready and the /healthz alias', () => {
    const READY = {
      status: 'up',
      version: RELEASE,
      checks: {
        database: { status: 'up', required: true },
        migrations: { status: 'up', required: true },
        storage: { status: 'up', required: true },
        cron_jobs: { status: 'down', required: false, fix: expect.any(String) },
        cutout_queue: {
          status: 'down',
          required: false,
          fix: expect.any(String),
        },
        trusted_proxies: { status: 'up', required: false },
        order_mail_owner: { status: 'up', required: false },
      },
    };

    it.each(['/health/ready', '/healthz'])(
      '%s answers 200 with the checks and the release, uncacheable, without touching the session',
      async (url) => {
        const res = await t.inject({
          method: 'GET',
          url,
          headers: uniqueClient(),
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual(READY);
        expect(res.headers['set-cookie']).toBeUndefined();
      },
    );

    it.each(['/health/live', '/healthz'])(
      "answers connectivity.js's HEAD probe of %s without a body",
      async (url) => {
        const res = await t.inject({
          method: 'HEAD',
          url,
          headers: uniqueClient(),
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toBe('');
      },
    );

    it('limits /health/ready and /healthz together per address, never /health/live', async () => {
      const client = uniqueClient();
      for (let i = 0; i < HEALTH_LIMIT.max; i++) {
        const url = i % 2 ? '/healthz' : '/health/ready';
        const res = await t.inject({ method: 'GET', url, headers: client });
        expect(res.statusCode).toBe(200);
      }
      const limited = await t.inject({
        method: 'GET',
        url: '/health/ready',
        headers: client,
      });
      expect(limited.statusCode).toBe(429);
      const live = await t.inject({
        method: 'GET',
        url: '/health/live',
        headers: client,
      });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: 'up' });
      const other = await t.inject({
        method: 'GET',
        url: '/healthz',
        headers: uniqueClient(),
      });
      expect(other.statusCode).toBe(200);
    });
  });

  describe('layout', () => {
    let html: string;

    beforeAll(async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.statusCode).toBe(200);
      html = res.body;
    });

    it('versions every first-party script and stylesheet URL', () => {
      const urls = [
        ...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g),
        ...html.matchAll(/<link\b[^>]*\shref="([^"]+)"/g),
      ]
        .map((m) => m[1])
        .filter((url) =>
          /^\/(modules|js|assets)\/|^\/bundle\.css|^\/favicon/.test(url),
        );
      expect(urls.length).toBeGreaterThanOrEqual(6);
      for (const url of urls) {
        expect(url).toMatch(/\?v=[^&"]+$/);
      }
      // Importmap entries are the module graph's URLs; same rule.
      const importmap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(
        html,
      );
      expect(importmap).not.toBeNull();
      const imports = JSON.parse(importmap![1]).imports as Record<
        string,
        string
      >;
      for (const url of Object.values(imports)) {
        expect(url).toMatch(/\?v=[^&"]+$/);
      }
      expect(imports.styling).toMatch(/^\/js\/styling\.js\?v=/);
    });

    // Issue #48: Firefox fetches it as the site icon on every cold load,
    // and iOS shows it at 180 px, so it is never the 1000 px icon.png.
    it('names the 192 px icon as the apple-touch-icon', () => {
      expect(html).toMatch(
        /<link rel="apple-touch-icon" href="\/assets\/icon-192\.png\?v=[^"]+"/,
      );
    });

    it('has one htmx-config meta and no viewport-fit', () => {
      const metas: string[] =
        html.match(/<meta\s+name="htmx-config"[^>]*>/g) ?? [];
      expect(metas).toHaveLength(1);
      const content = /content="([^"]+)"/.exec(metas[0])![1];
      // No view transitions (they drop taps while they run) and a short
      // history cache (layout.tsx says why).
      expect(JSON.parse(unescapeHtml(content))).toEqual({
        disableInheritance: true,
        historyCacheSize: 3,
        // The outbox's replay timeout bounds every htmx request (#642).
        timeout: REPLAY_TIMEOUT_MS,
      });
      expect(html).not.toContain('viewport-fit');
      // Without this, disableInheritance switches hx-boost off for every link
      // and every request loses its tap feedback.
      expect(html).toMatch(
        /<body[^>]*hx-indicator="#loading, closest a"[^>]*hx-inherit="hx-boost hx-indicator"/,
      );
    });

    it('makes no request to another origin', async () => {
      expect(html).not.toContain('preconnect');
      // Every script and link loads from this origin; the canonical link
      // names the page, it loads nothing.
      const tags: string[] = html.match(/<(script|link)\b[^>]*>/g) ?? [];
      const external = tags.filter(
        (tag) =>
          !tag.includes('rel="canonical"') &&
          /\s(src|href)="(https?:)?\/\//.test(tag),
      );
      expect(external).toEqual([]);
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toMatch(/https?:/);
    });

    it('allows no eval and no blob: scripts, workers or fetches', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      const directives = new Map(
        String(res.headers['content-security-policy'])
          .split(';')
          .map((directive) => directive.trim().split(/\s+/))
          .filter(([name]) => name)
          .map(([name, ...sources]) => [name, sources]),
      );
      expect(directives.get('script-src')).toEqual([
        "'self'",
        "'unsafe-inline'",
      ]);
      expect(directives.get('worker-src')).toEqual(["'self'"]);
      expect(directives.get('connect-src')).toEqual(["'self'"]);
      // The mask editor draws from object URLs.
      expect(directives.get('img-src')).toContain('blob:');
    });

    it('loads page-only libraries on their pages, not in the shell', () => {
      // pwa.js imports the install dialog and pull to refresh only where
      // they apply; the element is never in the markup.
      expect(html).toContain('/js/pwa.js?v=');
      expect(html).not.toContain('src="/modules/pwa-install');
      expect(html).not.toContain('<pwa-install');
      // Styling's module is only mapped here; its page imports it.
      expect(html).not.toMatch(/<script\b[^>]*\ssrc="[^"]*styling/i);
      expect(html).not.toMatch(/onnxruntime|background-removal/);
      expect(html).not.toContain('rel="preload"');
      expect(html).toContain('id="request-indicator"');
      expect(html).not.toContain('offline-indicator');
      expect(html).toContain('id="connectivity-banner"');
    });
  });

  describe('GET /wardrobe fragment', () => {
    beforeAll(async () => {
      await createGarment(t, { name: 'Fragment shirt' });
    });

    it('returns only #wardrobe-main to an htmx request', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe?keyword=Fragment',
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers.vary).toContain('HX-Request');
      expect(res.body).not.toContain('<html');
      expect(res.body).not.toContain('<nav');
      expect(res.body.trimStart()).toMatch(/^<main id="wardrobe-main"/);
      expect(res.body).toContain('Fragment shirt');
      expect(res.body).toContain('id="filter-modal"');
    });

    it('returns the full page to a boosted request', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { 'hx-request': 'true', 'hx-boosted': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers.vary).toContain('HX-Boosted');
      expect(res.body).toContain('<html');
      expect(res.body).toContain('id="wardrobe-main"');
    });

    it('renders the same partial inside the full page', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.body).toContain('id="wardrobe-main"');
      expect(res.body).toMatch(
        /<form[^>]*hx-get="\/wardrobe"[^>]*hx-target="#wardrobe-main"/,
      );
    });
  });

  // What the service worker's page cache relies on (src/web/page-cache.ts).
  describe('the page cache contract', () => {
    it('names the account on every HTML answer of a session', async () => {
      const page = await t.inject({ method: 'GET', url: '/outfits' });
      expect(page.headers['x-page-account']).toBe(String(t.owner.id));
      const fragment = await t.inject({
        method: 'GET',
        url: '/wardrobe?keyword=x',
        headers: { 'hx-request': 'true' },
      });
      expect(fragment.headers['x-page-account']).toBe(String(t.owner.id));

      const other = await t.register('page-cache-other@example.com');
      const theirs = await t.inject({
        method: 'GET',
        url: '/outfits',
        headers: { cookie: other },
      });
      expect(theirs.headers['x-page-account']).not.toBe(String(t.owner.id));
      expect(theirs.headers['x-page-account']).toMatch(/^\d+$/);
    });

    // The worker serves an older build's stored page only while that
    // build's precache is installed (src/static-build.ts, #656).
    it('names the build its ?v= URLs name on every page', async () => {
      const page = await t.inject({ method: 'GET', url: '/outfits' });
      expect(page.headers[ASSET_VERSION_HEADER.toLowerCase()]).toBe(RELEASE);
      expect(page.body).toContain(`?v=${RELEASE}`);
    });

    it('names no account on a signed-out render', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/login',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-page-account']).toBeUndefined();
    });

    // The worker tells "changed" from "the same" by comparing bodies, so a
    // tab root must render byte for byte the same while nothing changes.
    it.each(['/wardrobe', '/styling', '/outfits', '/calendar'])(
      'renders %s identically twice',
      async (url) => {
        const first = await t.inject({ method: 'GET', url });
        const second = await t.inject({ method: 'GET', url });
        expect(first.statusCode).toBe(200);
        expect(second.body).toBe(first.body);
      },
    );

    it('renders the freshness indicator hidden, with its strings', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.body).toMatch(/<span id="freshness" class="hidden[^"]*"/);
      expect(res.body).toContain('data-text-updated-ago="Updated {ago}"');
      const importmap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(
        res.body,
      );
      const imports = JSON.parse(importmap![1]).imports as Record<
        string,
        string
      >;
      expect(imports.freshness).toMatch(/^\/js\/freshness\.js\?v=/);
      expect(imports['age-label']).toMatch(/^\/js\/age-label\.js\?v=/);
    });
  });

  // An account's page may sit in no shared cache, and a browser revalidates
  // its copy before use (send(), src/web/render.ts; #286). no-cache, not
  // no-store: the back-forward cache keeps working.
  describe('HTML cache policy', () => {
    it.each([
      ['a page', '/wardrobe', {}],
      ['a fragment', '/wardrobe?keyword=x', { 'hx-request': 'true' }],
      ['a grid page', '/wardrobe/tiles?before=1', { 'hx-request': 'true' }],
      ['the offline page', '/offline.html', {}],
      ['the 404 page', '/wardrobe/999999', {}],
    ])('sends %s private, no-cache', async (_name, url, headers) => {
      const res = await t.inject({ method: 'GET', url, headers });
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control']).toBe('private, no-cache');
    });

    // Not the sign-in pages: those are no-store (their returnTo, #661).
    it('sends a signed-out page private, no-cache', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/about',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-cache');
    });

    it('leaves a photo and a static file as they were', async () => {
      const id = await createGarment(t, { name: 'Cache policy coat' });
      await uploadPhoto(t, id, await jpegPhoto());
      const grid = unescapeHtml(
        (await t.inject({ method: 'GET', url: '/wardrobe' })).body,
      );
      const thumb = /<img[^>]*src="(\/file\/thumb\/[^"]+)"/.exec(grid)?.[1];
      expect(thumb).toBeDefined();
      const photo = await t.inject({ method: 'GET', url: thumb! });
      expect(photo.statusCode).toBe(200);
      expect(photo.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
      const script = await t.inject({
        method: 'GET',
        url: '/js/pwa.js?v=1',
      });
      expect(script.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
    });
  });
});

// A directory the process cannot create (its parent is a file) is the
// unwritable storage the 503 names, whoever runs the spec.
describe('/health/ready with unwritable storage', () => {
  let t: TestApp;
  let scratch: string;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'closet-health-'));
    const file = join(scratch, 'not-a-directory');
    writeFileSync(file, '');
    t = await createTestApp({ MODELS_PATH: join(file, 'models') });
  });

  afterAll(async () => {
    await t?.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('answers 503 naming storage, with its fix and no error text', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/health/ready',
      headers: uniqueClient(),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('down');
    expect(body.checks.storage).toEqual({
      status: 'down',
      required: true,
      fix: expect.stringContaining('docs/operations.md#permissions'),
    });
    expect(body.checks.database).toEqual({ status: 'up', required: true });
    expect(res.body).not.toContain('ENOTDIR');
  });
});
