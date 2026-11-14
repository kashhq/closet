import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { ASSET_VERSION_HEADER } from '../static-build';
import { FRAGMENT_VARY, isFragmentRequest } from '../htmx/fragment-request';
import { timeRender } from '../metrics/request-timing';
import { PAGE_ACCOUNT_HEADER } from './page-cache';

const HTML = 'text/html; charset=utf-8';

/** Every HTML answer's policy unless its route set one (send below). */
const PAGE_CACHE_CONTROL = 'private, no-cache';

interface RenderOptions {
  status?: number;
}

interface SendOptions extends RenderOptions {
  /** A whole page: it carries an ETag and answers a matching If-None-Match. */
  validated?: boolean;
}

/**
 * Renders JSX to its HTML string. hono/jsx types an element as the string it
 * renders to, but at runtime it is a node whose toString() does the
 * rendering, and returns a Promise as soon as any component in the tree is
 * async; both are awaited here.
 */
export async function renderToString(element: JSX.Element): Promise<string> {
  const node = await element;
  const html = node.toString() as string | Promise<string>;
  return String(await html);
}

/**
 * Sends a whole document: the doctype and a page element (a component that
 * renders <Layout>). Returns the reply, so a handler ends with
 * `return renderPage(reply, <AboutPage ctx={viewContext(reply)} />)`.
 */
export async function renderPage(
  reply: FastifyReply,
  page: JSX.Element,
  options: RenderOptions = {},
): Promise<FastifyReply> {
  const html = await timeRender(() => renderToString(page));
  return send(reply, `<!DOCTYPE html>${html}`, {
    ...options,
    validated: true,
  });
}

/** Sends an htmx swap target: markup without the layout around it. */
export async function renderFragment(
  reply: FastifyReply,
  fragment: JSX.Element,
  options: RenderOptions = {},
): Promise<FastifyReply> {
  return send(reply, await timeRender(() => renderToString(fragment)), options);
}

/**
 * For a route that answers with either a page or a fragment of it: says
 * which one this request wants (src/htmx/fragment-request.ts, shared with the
 * service worker's cache keys) and marks the response as varying on the
 * headers that decide it, whichever branch the handler takes.
 */
export function wantsFragment(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  reply.header('Vary', FRAGMENT_VARY);
  return isFragmentRequest(request.headers);
}

/**
 * The answer to an htmx write that ends on another page (archive, delete):
 * htmx fetches `path` and swaps the body like a boosted link, pushing the
 * URL, so the document, its scripts and the service worker's page stay
 * (https://htmx.org/headers/hx-location/). HX-Redirect reloaded all of it.
 *
 * The follow-up GET says HX-Boosted because it is a whole-page swap:
 * isFragmentRequest (the server's routes and the worker's cache key) reads
 * that header, so the page comes back whole and is cached as the page, and
 * offline the worker answers it with the offline page. `path` is a same-site
 * path the server built, never user input.
 */
export function navigateTo(reply: FastifyReply, path: string): FastifyReply {
  const location = {
    path,
    target: 'body',
    swap: 'innerHTML show:top',
    headers: { 'HX-Boosted': 'true' },
  };
  return reply.header('HX-Location', JSON.stringify(location)).send();
}

function send(
  reply: FastifyReply,
  html: string,
  { status = 200, validated = false }: SendOptions,
): FastifyReply {
  // A second send is a handler bug that Fastify would only log while the
  // client keeps the first response. Fail loudly instead; the error handler
  // sees reply.sent and does not answer again either.
  if (reply.sent) {
    throw new Error(`${reply.request.url}: reply already sent`);
  }
  // Whose page this is, for the service worker's page cache
  // (src/web/page-cache.ts): it keeps one account's pages at a time.
  const account = reply.request.auth?.user.id;
  if (account !== undefined) {
    reply.header(PAGE_ACCOUNT_HEADER, String(account));
  }
  // The static build its `?v=` URLs name: the worker serves an older build's
  // stored copy only while that build's precache is installed
  // (src/static-build.ts, #656). Static paths have no context
  // and render no page.
  if (reply.locals) {
    reply.header(ASSET_VERSION_HEADER, reply.locals.appVersion);
  }
  // An account's page: no shared cache may store it, and a browser's copy
  // is revalidated before use. no-cache, not no-store, keeps the
  // back-forward cache. A route's own stricter policy (the token page's
  // no-store) stands.
  if (!reply.hasHeader('Cache-Control')) {
    reply.header('Cache-Control', PAGE_CACHE_CONTROL);
  }
  // After every header above: a 304 carries them, and the worker re-stamps
  // its copy from it (#708).
  if (validated && unchangedFor(reply, status, account, html)) {
    return reply.status(304).send();
  }
  return reply.status(status).type(HTML).send(html);
}

/**
 * Tags a page read (a GET or HEAD answered 200) with its ETag; true when it
 * is a GET whose If-None-Match names it. GET only: Fastify's HEAD route writes
 * Content-Length: 0 on a bodiless answer, which a 304 must not carry
 * (RFC 9110 8.6), so a HEAD keeps its 200 and the tag. Nothing asks HEAD of
 * a page conditionally.
 */
function unchangedFor(
  reply: FastifyReply,
  status: number,
  account: number | undefined,
  html: string,
): boolean {
  const { method, headers } = reply.request;
  if (status !== 200 || (method !== 'GET' && method !== 'HEAD')) return false;
  const etag = pageTag(account, html);
  reply.header('ETag', etag);
  return method === 'GET' && matchesTag(headers['if-none-match'], etag);
}

/**
 * A page's validator (#708, src/web/shell/offline-warm.md): its body and
 * whose page it is, so two accounts never share one, even where their pages
 * read the same. Weak: @fastify/compress sends one tag over the identity,
 * gzip and br bodies, which a strong tag must not (RFC 9110 8.8.1), and
 * If-None-Match compares weakly anyway. A page keeps its tag only while it
 * renders byte for byte the same: no clock, nonce or request id in a page,
 * and its day-relative text is the client's (views/assets/page-day.ts).
 */
function pageTag(account: number | undefined, html: string): string {
  const hash = createHash('sha256')
    .update(String(account ?? ''))
    .update('\0')
    .update(html)
    .digest('base64url')
    .slice(0, 27);
  return `W/"${hash}"`;
}

/** If-None-Match's weak comparison: `*`, or any listed tag, W/ or not. */
function matchesTag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => opaque(tag) === opaque(etag));
}
