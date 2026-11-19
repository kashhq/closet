/**
 * The names the page's modules (views/assets/page/, built to public/js/:
 * src/web/shell/AGENTS.md, Client modules) find in the server's markup,
 * spelled once (#713). A view writes an attribute by spreading its helper
 * (`<li {...needsNetwork()}>`); the module selects or reads it through the
 * same constant, so a rename fails the typecheck on both sides instead of
 * shipping a script that finds nothing. Pure: the page bundles import it,
 * so no DOM and no server imports.
 *
 * main.css spells the two it styles (data-needs-network, data-connectivity)
 * by hand; the plain-JS modules left in public/js/ (scripts/ci/plain_js.conf)
 * spell theirs.
 */

/** An attribute that marks rather than says: present or absent. */
const flag = (when: boolean) => (when ? '' : undefined);

// --- connectivity.ts: the offline guard and the offline page ------------

/**
 * A write that needs the server: connectivity.ts disables its controls (a
 * form's, through `form.elements`) while the heartbeat is not online, and
 * main.css dims them.
 */
export const NEEDS_NETWORK = 'data-needs-network';
export const needsNetwork = (when = true) => ({ [NEEDS_NETWORK]: flag(when) });

/** The offline fallback page, which says for itself that nothing is saved. */
export const OFFLINE_FALLBACK = 'data-offline-fallback';
export const offlineFallback = () => ({ [OFFLINE_FALLBACK]: '' });

/** The offline page's tab-root links, valued with the page cache's name. */
export const SAVED_PAGES = 'data-saved-pages';
export const savedPages = (cacheName: string) => ({ [SAVED_PAGES]: cacheName });
/** "None saved", shown when no tab root is in that cache. */
export const SAVED_PAGES_NONE = 'data-saved-pages-none';
export const savedPagesNone = () => ({ [SAVED_PAGES_NONE]: '' });

/** A part of a banner a script fills (`#connectivity-banner`'s text). */
export const ROLE = 'data-role';
export type Role = 'text' | 'list';
export const role = (name: Role) => ({ [ROLE]: name });
export const roleSelector = (name: Role) => `[${ROLE}="${name}"]`;

/**
 * The heartbeat's state on <html> (connectivity.ts writes it; pwa.ts and
 * the outbox read it, main.css dims the guarded writes by it). Absent until
 * its first change: online.
 */
export const CONNECTIVITY = 'data-connectivity';
export type Connectivity = 'online' | 'offline' | 'reconnecting';
/** Dispatched on the document by connectivity.ts at every change. */
export const CONNECTIVITY_CHANGE_EVENT = 'connectivity:change';
export interface ConnectivityChange {
  state: Connectivity;
  previous: Connectivity;
}

// --- #app-status: the scripts' strings ----------------------------------

export const APP_STATUS_ID = 'app-status';

/**
 * The strings the page's scripts show, as `data-text-<name>` on
 * #app-status (AppStatus writes every one: the record is total), so the
 * scripts stay free of i18n. The outbox's own `data-text-outbox-*` are its
 * own (app-status.tsx).
 */
export type StatusText =
  | 'offline'
  | 'reconnecting'
  | 'back-online'
  | 'update-available'
  | 'update-needs-network'
  | 'reload'
  | 'updated-ago'
  | 'newer-page'
  | 'refresh'
  | 'request-timed-out'
  | 'request-failed'
  | 'request-id';

export const statusTextAttribute = <N extends StatusText>(name: N) =>
  `data-text-${name}` as const;

export function statusTextAttributes(
  text: Record<StatusText, string>,
): Record<`data-text-${StatusText}`, string> {
  return Object.fromEntries(
    Object.entries(text).map(([name, value]) => [
      statusTextAttribute(name as StatusText),
      value,
    ]),
  ) as Record<`data-text-${StatusText}`, string>;
}

// --- freshness.ts: the stamp under the app bar's title -------------------

/** The app bar's "Updated 3 minutes ago" (AppBar), freshness.ts's to fill. */
export const FRESHNESS_ID = 'freshness';
/**
 * When the server produced what is on screen (epoch ms), kept on
 * #freshness by freshness.ts so htmx's history snapshot keeps it; the
 * outbox dates the page's day from it (src/page-day.ts).
 */
export const FETCHED_AT = 'data-fetched-at';
/** The tag of what is on screen, kept the same way for a history restore. */
export const PAGE_ETAG = 'data-etag';
/** Dispatched on the document when the stamp moves (the outbox re-applies the page's day). */
export const FRESHNESS_CHANGE_EVENT = 'freshness:change';

// --- back.ts: the app bar's back arrow ----------------------------------

/** A link that goes back in history when the entry before is in the app. */
export const HISTORY_BACK = 'data-history-back';
export const historyBack = (when = true) => ({ [HISTORY_BACK]: flag(when) });

/** On the app bar of a form page: done once saved or cancelled. */
export const FORM_PAGE = 'data-form-page';
export const formPage = (when: boolean) => ({ [FORM_PAGE]: flag(when) });

// --- pwa.ts: the page's build, its session ------------------------------

/**
 * On <html>: whether the page is signed in (the cookie is httpOnly) and the
 * build it was rendered with, which pwa.ts answers the worker's BUILD_QUERY
 * with before it claims the page.
 */
export const SIGNED_IN = 'data-signed-in';
export const ASSET_VERSION = 'data-asset-version';
export const pageIdentity = (signedIn: boolean, assetVersion: string) => ({
  [SIGNED_IN]: flag(signedIn),
  [ASSET_VERSION]: assetVersion,
});

/** A PostForm whose post starts or ends a session: pwa.ts tells the worker. */
export const ENDS_SESSION = 'data-ends-session';
export const endsSession = (when: boolean) => ({ [ENDS_SESSION]: flag(when) });

// --- push.ts: <push-settings> -------------------------------------------

/** What <push-settings> knows of this browser; push.ts shows one. */
export type PushState =
  | 'checking'
  | 'on'
  | 'off'
  | 'blocked'
  | 'unsupported'
  | 'install'
  | 'error';
/** The states a part of <push-settings> shows in, space-separated. */
export const PUSH_SHOW = 'data-show';
export const pushShownIn = (...states: PushState[]) => ({
  [PUSH_SHOW]: states.join(' '),
});
/** The tap a <push-settings> button asks for. */
export const PUSH_ACTION = 'data-action';
export type PushAction = 'enable' | 'disable';
export const pushAction = (action: PushAction) => ({ [PUSH_ACTION]: action });
/** The slot this device's reminders are loaded into once the state is on. */
export const PUSH_REMINDERS_ID = 'push-reminders';

// --- search-shortcut.ts --------------------------------------------------

/** The field `/` focuses, one a page (the Wardrobe's search). */
export const SEARCH_SHORTCUT = 'data-search-shortcut';
export const searchShortcut = () => ({ [SEARCH_SHORTCUT]: '' });

// --- locate.ts: the weather's "Use my location" -------------------------

/** The button, hidden until the browser can locate. */
export const LOCATE = 'data-locate';
export const locateButton = () => ({ [LOCATE]: '' });
/** The line saying why it failed, carrying each reason's words. */
export const LOCATE_STATUS = 'data-locate-status';
export const LOCATE_DENIED = 'data-denied';
export const LOCATE_FAILED = 'data-failed';
export const LOCATE_NOT_SAVED = 'data-not-saved';
export const locateStatus = (text: {
  denied: string;
  failed: string;
  notSaved: string;
}) => ({
  [LOCATE_STATUS]: '',
  [LOCATE_DENIED]: text.denied,
  [LOCATE_FAILED]: text.failed,
  [LOCATE_NOT_SAVED]: text.notSaved,
});
/** The hidden form the position posts through. */
export const LOCATE_FORM_ID = 'weather-here-form';
