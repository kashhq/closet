import { type FastifyReply, type FastifyRequest } from 'fastify';
import type { AuthContext, SessionUser } from './auth/session';
import { requestOrigin } from './security/origin';

/**
 * The per-request page context: built by the preValidation hook in app.ts
 * for every non-static request (createViewContextBuilder) and stored as
 * `reply.locals`; JSX pages take it as a prop. Text is not in it: pages are
 * English, from t() (src/web/i18n.ts).
 */
export interface ViewContext {
  appName: string;
  /** File under public/assets/ (ICON_NAME). */
  iconName: string;
  /** SITE_URL. */
  siteUrl: string;
  /** The request path, without the query: the dock's active tab (layout/sections.ts). */
  path: string;
  /**
   * Whether a page may link to registration: false here, set from the
   * registration gate by the only pages that link to it, the login page
   * (its app bar) and an invite's (src/web/auth/registration.ts).
   */
  signupsOpen: boolean;
  pwaEnabled: boolean;
  /** WEATHER_ENABLED: pages render the weather's slots (src/web/weather/views.tsx). */
  weatherEnabled: boolean;
  /** METRICS_ENABLED: signed-in pages load the timing beacon (public/js/vitals.js). */
  metricsEnabled: boolean;
  /** SENTRY_DSN: signed-in pages load the error beacon (public/js/errors.js). */
  errorTrackingEnabled: boolean;
  /**
   * The signed-in user is the order mail's owner, with it on (#25):
   * the Wardrobe's ⋯ menu links "From your orders".
   */
  orderReview: boolean;
  /**
   * The build's release (src/build-info.ts): shown on /about, and the error
   * beacon's claimed release (the server's own wins on the event).
   */
  release: string;
  /** `?v=` on every first-party static URL; see src/build-info.ts. */
  appVersion: string;
  /**
   * The importmap's script text, the layout's one inline script: the same
   * string the CSP hashes (app.ts makes it once, `importMapScript`; #672).
   */
  importMap: string;
  /** APP_TIMEZONE: the outbox dates a queued tap in it (#178, AppStatus). */
  timeZone: string;
  canonicalUrl: string;
  /** The page's link preview URL and image unless the page names its own (Layout). */
  ogUrl: string;
  ogImage: string;
  user: SessionUser | undefined;
}

/**
 * The context of a page request. Absent only on the static paths the session
 * hook skips (static-prefixes.ts), where no route renders a page, so a
 * missing context is a routing mistake, not a runtime condition.
 */
export function viewContext(reply: FastifyReply): ViewContext {
  if (!reply.locals) {
    throw new Error(
      `No view context for ${reply.request.url}: is a page route under a static prefix?`,
    );
  }
  return reply.locals;
}

/** What the page context takes from config, resolved once by createApp(). */
export interface ViewContextConfig {
  appName: string;
  iconName: string;
  siteUrl: string;
  pwaEnabled: boolean;
  weatherEnabled: boolean;
  metricsEnabled: boolean;
  errorTrackingEnabled: boolean;
  /** The order mail's stored owner, when the order mail is on (#976). */
  orderMailOwnerId: number | undefined;
  /** BuildInfo.release and BuildInfo.assetVersion. */
  release: string;
  assetVersion: string;
  /** The importmap's text for `assetVersion`, made once by createApp (ViewContext.importMap). */
  importMap: string;
  timeZone: string;
}

/**
 * Builds a request's page context. The session comes in as an argument: the
 * builder never reads the cookie or loads the user itself (the session
 * resolver already did).
 */
export function createViewContextBuilder(config: ViewContextConfig) {
  return function buildViewContext(
    request: FastifyRequest,
    auth: AuthContext | undefined,
  ): ViewContext {
    // Forwarded headers only count from TRUSTED_PROXIES (requestOrigin); a
    // client's own X-Forwarded-Host must not rewrite canonical and og URLs.
    const origin = requestOrigin(request);
    const path = request.url.split('?')[0];
    const canonicalUrl = `${origin}${path}`;
    return {
      appName: config.appName,
      iconName: config.iconName,
      siteUrl: config.siteUrl,
      path,
      signupsOpen: false,
      pwaEnabled: config.pwaEnabled,
      weatherEnabled: config.weatherEnabled,
      metricsEnabled: config.metricsEnabled,
      errorTrackingEnabled: config.errorTrackingEnabled,
      orderReview:
        config.orderMailOwnerId !== undefined &&
        auth?.user.id === config.orderMailOwnerId,
      release: config.release,
      appVersion: config.assetVersion,
      importMap: config.importMap,
      timeZone: config.timeZone,
      canonicalUrl,
      ogUrl: canonicalUrl,
      ogImage: `${origin}/assets/${config.iconName}`,
      user: auth?.user,
    };
  };
}
