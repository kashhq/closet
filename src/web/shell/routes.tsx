import type { FastifyPluginCallback } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../../calendar-date';
import { PAGE_ACCOUNT_HEADER } from '../page-cache';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import { AboutPage } from './about-page';
import { webManifest } from './manifest';
import { OfflinePage } from './offline-page';
import { WARM_LIST_PATH } from './offline-warm';
import { warmList } from './warm-list';

/**
 * The app shell outside any feature: the PWA's manifest and offline
 * fallback, the about page, and the service worker's warm list. Every route
 * but the warm list is public: the browser fetches the manifest without
 * credentials, and the service worker may install before sign-in. `/` is
 * Today (src/web/today); the heartbeat connectivity.js probes is
 * /health/live (src/web/health).
 */
export const shellRoutes: FastifyPluginCallback<WebOptions> = (
  app,
  { config, db, logger },
  done,
) => {
  // no-cache (revalidate, like sw.js): the installed app must pick up
  // APP_NAME/ICON_NAME changes on its next check. A static path
  // (static-prefixes.ts): no session, no page context.
  app.get(
    '/manifest.json',
    { config: { public: true } },
    async (_request, reply) =>
      reply
        .type('application/manifest+json; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(webManifest(config)),
  );

  app.get('/about', { config: { public: true } }, async (_request, reply) =>
    renderPage(reply, <AboutPage ctx={viewContext(reply)} />),
  );

  app.get(
    '/offline.html',
    { config: { public: true } },
    async (_request, reply) =>
      renderPage(reply, <OfflinePage ctx={viewContext(reply)} />),
  );

  // The service worker's warm list (#286, offline-warm.md): the session's
  // own wardrobe, never a shared one (no ?ownerId= is read), so warming
  // never widens what a grantee's device holds. Session-gated like any
  // page; no-store, since it names every garment of the account. It says
  // whose list it is (X-Page-Account, as send() does on pages), so the
  // worker claims its caches for that account before storing anything.
  app.get(WARM_LIST_PATH, async (request, reply) => {
    const ownerId = sessionUserId(request);
    const list = await warmList(
      db,
      ownerId,
      todayIn(config.timeZone, new Date()),
    );
    logger.info(
      `Warm list for user ${ownerId}: ${list.pages.length} pages, ${list.fragments.length} fragments, ${list.images.length} images`,
    );
    return reply
      .header('Cache-Control', 'no-store')
      .header(PAGE_ACCOUNT_HEADER, String(ownerId))
      .send(list);
  });

  // Browsers and tools probe /.well-known/ (Chrome DevTools, app links); an
  // empty object keeps those probes out of the error log. OAuth's names are
  // exact routes that win over this one (src/web/oauth/routes.ts).
  app.get(
    '/.well-known/*',
    { config: { public: true } },
    async (_request, reply) => reply.send({}),
  );
  done();
};
