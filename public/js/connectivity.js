/**
 * Active connectivity detection (frontend-pwa.md): the app is online when
 * HEAD /health/live answers, not when navigator.onLine says so (captive portals,
 * VPNs and routers without uplink all report true). Probes every 30 s while
 * the tab is visible, immediately after any failed htmx request, and every
 * 5 s while offline.
 *
 * Owns #connectivity-banner (src/web/layout/app-status.tsx): a persistent
 * "offline" banner, "reconnecting" while a retry is in flight, and a short
 * toast when the server answers again. Loaded by the layout on every page,
 * with or without a service worker.
 */
import { isLiveAnswer } from 'live-answer';
import { singleFlight } from 'single-flight';
import { showToast } from 'toast';

const HEARTBEAT_MS = 30_000;
const RETRY_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const BACK_ONLINE_TOAST_MS = 3_000;

/** @type {'online' | 'offline' | 'reconnecting'} */
let state = 'online';
let timer = null;

const strings = () => document.getElementById('app-status')?.dataset ?? {};

function render() {
  const banner = document.getElementById('connectivity-banner');
  if (!banner) return;
  const text = banner.querySelector('[data-role="text"]');
  // The offline fallback page says for itself that nothing is saved here.
  if (state === 'online' || document.querySelector('[data-offline-fallback]')) {
    banner.classList.add('hidden');
    return;
  }
  text.textContent =
    state === 'offline' ? strings().textOffline : strings().textReconnecting;
  banner.classList.remove('hidden');
}

// Controls this module disabled, so reconnecting re-enables exactly those
// and never one disabled for another reason (the empty photo form's Upload).
const GUARD_MARK = 'offlineDisabled';
const CONTROLS = 'button, input, select, textarea';

/**
 * A zone's controls. A form's are its `elements`, which also holds the
 * controls outside it that name it in `form=` (the styling sheet's Save, a
 * lookalike's "Add a copy", the add sheet's photo inputs): guarding the
 * form guards every way to submit it.
 */
function zoneControls(zone) {
  if (zone.matches(CONTROLS)) return [zone];
  if (zone instanceof HTMLFormElement) {
    return Array.from(zone.elements).filter((el) => el.matches(CONTROLS));
  }
  return zone.querySelectorAll(CONTROLS);
}

/**
 * The forms holding a control this module disabled. Counted after the pass,
 * not per zone: an area around a form's control (the add sheet's rows) may
 * have disabled it first.
 */
function guardedForms() {
  return Array.from(
    document.querySelectorAll('form[data-needs-network]'),
  ).filter((form) =>
    Array.from(form.elements).some((el) => GUARD_MARK in el.dataset),
  ).length;
}

/**
 * The writes marked data-needs-network (and the controls inside them) get
 * the real `disabled` while offline or reconnecting, so neither a tap nor
 * the keyboard can submit them; main.css dims them, the banner says why.
 * Run on every state change and after every swap (new content may arrive
 * while offline).
 */
function guardWrites() {
  const offline = state !== 'online';
  if (offline) {
    let guarded = 0;
    for (const zone of document.querySelectorAll('[data-needs-network]')) {
      for (const control of zoneControls(zone)) {
        if (control.disabled) continue;
        control.disabled = true;
        control.setAttribute('aria-disabled', 'true');
        control.dataset[GUARD_MARK] = '';
        guarded += 1;
      }
    }
    // Only newly disabled controls: a page whose writes are not counted
    // here while offline posts into the worker's offline page (#411).
    if (guarded > 0) {
      console.info(
        `[connectivity] ${guarded} write controls disabled (${guardedForms()} forms)`,
      );
    }
    return;
  }
  for (const control of document.querySelectorAll('[data-offline-disabled]')) {
    control.disabled = false;
    control.removeAttribute('aria-disabled');
    delete control.dataset[GUARD_MARK];
  }
}

function setState(next) {
  if (next === state) return;
  const previous = state;
  state = next;
  // On <html>, which boosted navigations never replace: main.css dims the
  // writes marked data-needs-network while offline; guardWrites disables them.
  document.documentElement.dataset.connectivity = state;
  guardWrites();
  console.info(`[connectivity] ${previous} -> ${next}`);
  document.dispatchEvent(
    new CustomEvent('connectivity:change', { detail: { state, previous } }),
  );
  render();
  if (next === 'online' && previous !== 'online') {
    showToast({
      text: strings().textBackOnline,
      kind: 'success',
      ttlMs: BACK_ONLINE_TOAST_MS,
    });
  }
}

function schedule(delayMs) {
  clearTimeout(timer);
  timer = setTimeout(() => probe('timer'), delayMs);
}

async function serverReachable() {
  try {
    // /health/live checks nothing, so a down dependency is never shown as
    // "offline" (src/web/health). HEAD, not GET: an unread body keeps the
    // request open until the abort signal fires, 5 s per probe
    // (Playwright's networkidle waited on it). Only an answer with the
    // route's own header counts: a captive portal's 200 is not online.
    const res = await fetch('/health/live', {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return isLiveAnswer(res);
  } catch {
    return false;
  }
}

/**
 * One probe at a time, and a call made while one is in flight probes once
 * more after it (single-flight.js): an `offline` event or a failed request is
 * newer than the probe already running, so it must not take that probe's
 * answer (#436: the page-load probe's 200 hid an outage for 30 s).
 */
export const probe = singleFlight(async (reason) => {
  if (state === 'offline') setState('reconnecting');
  if (reason !== 'timer') {
    console.debug(`[connectivity] probe (${reason})`);
  }
  const reachable = await serverReachable();
  setState(reachable ? 'online' : 'offline');
  if (document.visibilityState === 'visible') {
    schedule(reachable ? HEARTBEAT_MS : RETRY_MS);
  }
  return reachable;
});

export const getState = () => state;

// A native form post cancels any htmx request in flight (WebKit hardest,
// #241): the resulting htmx:sendError is not evidence the server is
// unreachable, it's the page leaving. pagehide/beforeunload catch a
// navigation actually starting; document.hidden also covers a backgrounded
// tab, where a cancelled request is just as unreliable and the banner is
// not shown anyway.
// A cancelled beforeunload (the user dismisses a confirm dialog) leaves this
// true with no unload to clear it; bounded on purpose, since the heartbeat
// (HEARTBEAT_MS) still probes while visible either way.
let leaving = false;
function isPageLeaving() {
  return leaving || document.hidden;
}
window.addEventListener('pagehide', () => {
  leaving = true;
});
window.addEventListener('beforeunload', () => {
  leaving = true;
});
window.addEventListener('pageshow', (event) => {
  leaving = false;
  // bfcache restores this module's state exactly as it was at pagehide
  // (#241): a request cancelled by the navigation may have left `state`
  // 'offline' with the banner shown, frozen until unfrozen. Probe now
  // instead of waiting for the next heartbeat or visibilitychange.
  if (event.persisted) probe('pageshow');
});

// Browser events are hints that something changed; the probe decides.
window.addEventListener('online', () => probe('online-event'));
window.addEventListener('offline', () => probe('offline-event'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') probe('visible');
  else clearTimeout(timer);
});
// A request that never reached the server is the strongest offline signal,
// unless the page itself is what cancelled it.
document.addEventListener('htmx:sendError', () => {
  if (!isPageLeaving()) probe('htmx:sendError');
});
document.addEventListener('htmx:responseError', () => {
  if (!isPageLeaving()) probe('htmx:responseError');
});
// No answer within htmx's timeout (HTMX_CONFIG): a dead link looks like this
// too. request-failures.js toasts it; the probe says whether we are offline.
document.addEventListener('htmx:timeout', () => {
  if (!isPageLeaving()) probe('htmx:timeout');
});
// hx-boost replaces the whole body, banner included.
document.addEventListener('htmx:afterSettle', () => {
  render();
  guardWrites();
});

probe('load');

/**
 * The offline fallback page is precached, so it cannot know which tab roots
 * this device saved: it renders their links hidden (src/web/shell/offline-page.tsx)
 * and this shows those whose full page is in the worker's page cache, which
 * stores a page under its absolute URL. Nothing is opened, so a cache that
 * does not exist is not created.
 */
async function revealSavedPages() {
  const list = document.querySelector('[data-saved-pages]');
  if (!list || !('caches' in window)) return;
  const cacheName = list.dataset.savedPages;
  let saved = 0;
  for (const item of list.querySelectorAll('li')) {
    const url = new URL(item.querySelector('a').href, location.origin).href;
    if (await caches.match(url, { cacheName })) {
      item.hidden = false;
      saved += 1;
    }
  }
  document.querySelector('[data-saved-pages-none]').hidden = saved > 0;
  console.info(`[connectivity] offline page: ${saved} saved tab roots`);
}

document.addEventListener('htmx:afterSettle', revealSavedPages);
revealSavedPages();
