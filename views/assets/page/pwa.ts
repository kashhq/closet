/**
 * Installed-app plumbing, loaded by the layout when PWA_ENABLED: service
 * worker registration and the update flow, the freshness indicator of pages
 * served from a cache (freshness.ts, with or without a worker), warming the
 * wardrobe for offline reading and Web Push on signed-in pages (push.ts),
 * the install dialog in a browser tab that can install the app,
 * and pull to refresh for iOS standalone (which has none of its own). Lives
 * in the head so hx-boost body swaps never re-run it; anything that touches
 * the body re-applies itself after a swap. The last two libraries are
 * imported only where they do something.
 *
 * Update flow (frontend-pwa.md, "never force-reload"): the worker in
 * views/assets/src-sw.ts no longer calls skipWaiting() on install, so a new
 * build sits in `waiting` until the user taps Reload. The toast then posts
 * SKIP_WAITING and this tab reloads on `controlling`. Other tabs keep their
 * page and the toast, whose Reload then only reloads (the new worker already
 * controls them): the old hard-navigate-on-next-boosted-GET hack existed only
 * because the worker used to seize control mid-session; with the user
 * choosing the moment there is nothing to work around. test/sw-update.spec.ts
 * walks both.
 */
import type { PWAInstallElement } from '@khmyznikov/pwa-install';
import { watchFreshness } from 'freshness';
import { showToast } from 'toast';
import { Workbox } from 'workbox-window';
import {
  APP_STATUS_ID,
  ASSET_VERSION,
  CONNECTIVITY,
  CONNECTIVITY_CHANGE_EVENT,
  ENDS_SESSION,
  SIGNED_IN,
  type StatusText,
  statusTextAttribute,
} from '../../../src/web/page-contract';

const text = (name: StatusText) =>
  document
    .getElementById(APP_STATUS_ID)
    ?.getAttribute(statusTextAttribute(name)) ?? '';

/** The heartbeat's state (connectivity.ts), never navigator.onLine. */
const heartbeatOnline = () =>
  (document.documentElement.getAttribute(CONNECTIVITY) ?? 'online') ===
  'online';

function registerServiceWorker() {
  const wb = new Workbox('/sw.js');
  // What this window knows of an update: 'none'; 'waiting' (a new worker is
  // installed and the toast offers it); 'active' (the new worker already
  // controls this page: another window of the app accepted it, and
  // clientsClaim took this one too, without reloading it). Reload then has
  // nothing left to activate and only reloads; messageSkipWaiting would
  // find no waiting worker and the tap would do nothing.
  let update: 'none' | 'waiting' | 'active' = 'none';
  let reloadRequested = false;
  let toast: ReturnType<typeof showToast> | null = null;

  const showUpdateToast = () => {
    toast?.dismiss();
    toast = showToast({
      text: text('update-available'),
      kind: 'info',
      action: {
        label: text('reload'),
        onClick: () => {
          if (update === 'active') {
            console.info('[pwa] update already active, reloading');
            window.location.reload();
            return;
          }
          reloadRequested = true;
          console.info('[pwa] update accepted, activating new worker');
          wb.messageSkipWaiting();
        },
      },
    });
    guardReload();
  };

  // The waiting worker's Reload needs the server (#656): it activates the
  // new build, whose activation refresh fetches every page an older build
  // stored, and the reload itself is a navigation. Offline, the new build
  // would take over with nothing to fetch them with. Disabled, the toast
  // saying why, while the heartbeat (connectivity.ts's data-connectivity,
  // never navigator.onLine) is not online. An update another window already
  // activated has nothing left to activate: its Reload stays a plain reload.
  const guardReload = () => {
    if (!toast?.button || update !== 'waiting') return;
    const online = heartbeatOnline();
    toast.button.disabled = !online;
    if (online) toast.button.removeAttribute('aria-disabled');
    else toast.button.setAttribute('aria-disabled', 'true');
    toast.label.textContent = online
      ? text('update-available')
      : text('update-needs-network');
  };
  document.addEventListener(CONNECTIVITY_CHANGE_EVENT, guardReload);

  // The worker this window saw waiting: only it taking the page is the update.
  let waitingWorker: ServiceWorker | null = null;
  wb.addEventListener('waiting', (event) => {
    update = 'waiting';
    waitingWorker = event.sw ?? null;
    console.info('[pwa] update waiting');
    showUpdateToast();
  });
  // A new controller is the update only when it is the worker this window
  // saw waiting; any other is the active worker taking the page (the app's
  // first visit, clientsClaim, or its claim on request: claimIfUncontrolled).
  // Workbox fires `controlling` on every controllerchange. Not Workbox's
  // `isUpdate`: that says whether a worker controlled the page when pwa.ts
  // registered, so a page opened before the first worker never reloaded onto
  // a later update.
  wb.addEventListener('controlling', () => {
    if (update === 'none') return;
    if (
      update === 'waiting' &&
      navigator.serviceWorker.controller !== waitingWorker
    ) {
      return;
    }
    if (reloadRequested) {
      window.location.reload();
      return;
    }
    // Accepted in another window: this page keeps running until the user
    // reloads it (never force a reload), so the toast stays on offer.
    update = 'active';
    console.info('[pwa] update activated by another window');
    if (!toast?.element.isConnected) showUpdateToast();
  });
  // The toast lives in the body and is lost on every boosted navigation;
  // keep it until the user acts.
  document.addEventListener('htmx:afterSettle', () => {
    if (update !== 'none' && !toast?.element.isConnected) showUpdateToast();
  });

  // A browser that refuses workers (a policy, some private modes, a test
  // that blocks them) rejects here: the app works on without one.
  wb.register()
    .then(() => console.info('[pwa] service worker registered'))
    .catch((error: unknown) =>
      console.warn('[pwa] service worker registration failed', error),
    );
  claimIfUncontrolled();
}

// The first worker's activation claims only the pages already running
// (clientsClaim, src-sw.ts). A navigation that started while it installed
// (the page after a quick sign-in on a slow phone) commits after that claim,
// uncontrolled, and nothing would claim it later: no controllerchange, so no
// warm, and every boosted tap of the session past the worker, offline
// included, until a full reload (#1140). Once a worker is active, a page it
// does not control asks to be claimed. The worker then asks every
// uncontrolled page for its build (BUILD_QUERY, answered here with
// <html data-asset-version>, what X-Asset-Version says) and claims only when
// all are its own (claimOwnBuildPages): a hard reload after a deploy holds
// the next build's assets, and the update flow, never the old worker, takes
// that page. Answered whenever asked, controlled or not: another page's
// request asks this one too.
function claimIfUncontrolled() {
  const build = document.documentElement.getAttribute(ASSET_VERSION);
  if (!build) return;
  navigator.serviceWorker.addEventListener(
    'message',
    (event: MessageEvent<{ type?: unknown } | null>) => {
      if (event.data?.type !== 'BUILD_QUERY') return;
      event.ports[0]?.postMessage({ build });
    },
  );
  // The worker's query reaches a page before DOMContentLoaded only once
  // its messages are started.
  navigator.serviceWorker.startMessages();
  navigator.serviceWorker.ready
    .then((registration) => {
      if (navigator.serviceWorker.controller) return;
      console.info(
        `[pwa] page of build ${build} not controlled: asking the worker to claim it`,
      );
      registration.active?.postMessage({ type: 'CLAIM_CLIENTS' });
    })
    .catch((error: unknown) =>
      console.warn('[pwa] could not ask the worker to claim the page', error),
    );
}

// The session cookie is httpOnly, so the layout says whether this page is
// signed in (data-signed-in on <html>). push.ts defines the profile page's
// <push-settings> and re-sends an existing subscription; it never asks for
// permission by itself.
function startPush() {
  import('push')
    .then((push) => push.syncSubscription())
    .catch((error: unknown) => console.warn('[pwa] push sync failed', error));
}

// A signed-out login page carries <push-signed-out>, which push.ts defines:
// the browser's subscription goes once nobody is signed in. A boosted tap
// that lands there needs nothing from here (the signed-in page it left has
// push.ts already).
function endPush() {
  import('push').catch((error: unknown) =>
    console.warn('[pwa] push module failed to load', error),
  );
}

// The <pwa-install> dialog (@khmyznikov/pwa-install 0.7, 160 KB, 45 KB
// compressed) shows itself wherever it is mounted and can install, and
// mounting it costs the bundle, /manifest.json (once: 0.5 read it again when
// handed the prompt event) and the manifest's first icon (192 px, 5 KB). So
// only a load that can offer an install pays for it: never the installed app
// (the caller checks), in Chromium only once the browser offers installing
// (beforeinstallprompt: installable and not installed yet), and elsewhere
// only where the element has instructions to give (manualInstallPlatform).
// No screenshots in the dialog (issue #4: the household's phones already
// have the app).
// Mounted once per document on <html>, outside the body htmx swaps: in the
// body every navigation re-mounted it, and every mount fetched the manifest.
function offerInstall() {
  const mount = async (promptEvent?: Event) => {
    await import('pwa-install');
    const dialog = document.createElement('pwa-install') as PWAInstallElement;
    dialog.id = 'pwa-install';
    dialog.setAttribute('manifest-url', '/manifest.json');
    dialog.setAttribute('disable-screenshots', 'true');
    if (promptEvent) {
      dialog.externalPromptEvent =
        promptEvent as PWAInstallElement['externalPromptEvent'];
    }
    document.documentElement.append(dialog);
    console.info(
      `[pwa] install dialog mounted (${promptEvent ? 'browser prompt' : 'instructions'})`,
    );
  };
  const failed = (error: unknown) =>
    console.warn('[pwa] install dialog failed to load', error);
  if ('BeforeInstallPromptEvent' in window) {
    window.addEventListener(
      'beforeinstallprompt',
      (event) => {
        // The element shows its own dialog in place of the browser's.
        event.preventDefault();
        mount(event).catch(failed);
      },
      { once: true },
    );
  } else if (manualInstallPlatform()) {
    mount().catch(failed);
  }
}

// Where a browser without beforeinstallprompt can still install the app, the
// platforms @khmyznikov/pwa-install gives instructions for: Add to Home
// Screen on iPhone and iPad (every browser there is WebKit), Add to Dock in
// Safari on macOS, the browser menu on Android. Anywhere else (Firefox on a
// desktop) the element would fetch everything and show nothing.
function manualInstallPlatform() {
  const ua = navigator.userAgent;
  // iPadOS asks for the desktop site by default: a "Macintosh" with touch.
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const macSafari = /Macintosh/.test(ua) && /Version\/[\d.]+ Safari\//.test(ua);
  return /iPhone|iPad|iPod|Android/.test(ua) || touchMac || macSafari;
}

// https://stackoverflow.com/questions/75972895/ios-pwa-how-to-re-enable-pull-to-refresh
// pulltorefresh binds to the page's <main> and inserts its indicator into
// the body, so a navigation (a swap of the whole body) needs it bound again;
// a fragment swap (a filter, an outfit row) leaves both in place.
async function installPullToRefresh() {
  const { default: PullToRefresh } = await import('pulltorefreshjs');
  const bind = () => {
    PullToRefresh.destroyAll();
    PullToRefresh.init({
      mainElement: 'main',
      onRefresh() {
        location.reload();
      },
    });
  };
  bind();
  document.addEventListener('htmx:afterSettle', (event) => {
    if (
      (event as CustomEvent<{ target: Element }>).detail.target ===
      document.body
    ) {
      bind();
    }
  });
  document.addEventListener('htmx:historyRestore', bind);
}

// Asks the worker to warm this account's whole wardrobe for offline reading
// (WARM_PAGES, #286; src/web/shell/offline-warm.md). The worker decides
// whether a run is due (at most one a day, its warmed-at record) and what it
// lacks, so asking is cheap: after load, and again whenever the app comes
// back to the foreground or online (iOS has no background sync, so a warm
// only runs while the app is open, and resumes where it stopped), and when
// a worker takes control: the app's first load has no controller to ask.
// Never in the background, offline (the heartbeat's state, never
// navigator.onLine) or when the user asked to save data.
function warmForOffline() {
  const ask = () => {
    if (document.visibilityState !== 'visible' || !heartbeatOnline()) return;
    if (navigator.connection?.saveData) return;
    navigator.serviceWorker.controller?.postMessage({ type: 'WARM_PAGES' });
  };
  if (document.readyState === 'complete') ask();
  else window.addEventListener('load', ask, { once: true });
  document.addEventListener('visibilitychange', ask);
  navigator.serviceWorker.addEventListener('controllerchange', ask);
  document.addEventListener(CONNECTIVITY_CHANGE_EVENT, (event) => {
    if (event.detail.state === 'online') ask();
  });
}

const WORKER_TELL_MS = 1_000;

/** Posts to the registration's active worker, giving up after WORKER_TELL_MS. */
async function tellActiveWorker(message: { type: string }) {
  let gaveUp: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    gaveUp = setTimeout(resolve, WORKER_TELL_MS);
  });
  try {
    const registration = await Promise.race([
      navigator.serviceWorker.getRegistration(),
      timeout,
    ]);
    registration?.active?.postMessage(message);
  } finally {
    clearTimeout(gaveUp);
  }
}

// A sign-in, a registration, a sign-out or an account deletion leaving this
// page: the PostForms marked data-ends-session (src/web/form.tsx). The
// worker never sees the post itself (#542: it would launder a cross-site
// one's Origin), so the page tells it as the post leaves and it drops the
// session caches before the landing page is asked for (SESSION_ENDING,
// src-sw.ts). Bubbling, after submit-once.js and the form's own confirm: a
// cancelled submit (a declined confirm, a second tap, the outbox holding a
// sign-out to drain) is defaultPrevented and says nothing. A page the
// worker does not control (a hard reload) is held while the registration's
// active worker is told (tellActiveWorker); without one nothing is cached.
function announceSessionBoundaries() {
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      !form.hasAttribute(ENDS_SESSION)
    ) {
      return;
    }
    if (event.defaultPrevented) return;
    const message = { type: 'SESSION_ENDING' };
    const { controller } = navigator.serviceWorker;
    if (controller) {
      controller.postMessage(message);
    } else {
      // The registration is read asynchronously, and the native post would
      // unload the page before the worker heard: held until it is told
      // (bounded), then posted as it was (form.submit() skips the submit
      // event, so the form's confirm is not asked again).
      event.preventDefault();
      tellActiveWorker(message)
        .catch((error: unknown) =>
          console.warn('[pwa] could not tell the worker of a sign-out', error),
        )
        .finally(() => form.submit());
    }
    console.info(
      `[pwa] ${form.getAttribute('action')} posted: worker told to drop the session caches`,
    );
  });
}

// A Home Screen app asks once per launch to be kept out of the browser's
// eviction (WebKit grants it to an installed web app by heuristics), so a
// warmed wardrobe survives storage pressure. The answer is only logged.
async function persistStorage() {
  // Optional: the DOM lib types navigator.storage as always there.
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage?.persist || (await storage.persisted())) {
    return;
  }
  const granted = await storage.persist();
  console.info(`[pwa] persistent storage ${granted ? 'granted' : 'refused'}`);
}

const standalone =
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
const signedIn = document.documentElement.hasAttribute(SIGNED_IN);

// Also without a service worker (an http: origin): history snapshots are
// cached reads too, and a synced page still takes the server's copy.
watchFreshness();
if ('serviceWorker' in navigator) {
  registerServiceWorker();
  announceSessionBoundaries();
  if (signedIn) warmForOffline();
}
if (standalone && signedIn) {
  persistStorage().catch((error: unknown) =>
    console.warn('[pwa] persistent storage request failed', error),
  );
}
// Also without a service worker (an http: origin): the profile page then
// says this browser cannot receive notifications.
if (signedIn) startPush();
else if (document.querySelector('push-signed-out')) endPush();
if (!standalone) offerInstall();
if (window.navigator.standalone === true) {
  installPullToRefresh().catch((error: unknown) =>
    console.warn('[pwa] pull to refresh failed to load', error),
  );
}
