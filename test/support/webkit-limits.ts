/**
 * What Playwright's WebKit cannot do, as the reasons the Safari projects'
 * skips give (#179, the nightly `webkit` job; docs/testing-webkit.md). Each
 * was seen failing in the `webkit` and `Mobile Safari` projects with the app
 * working; a skip that hides an app bug does not belong here.
 */

/**
 * `context.setOffline(true)` fails a navigation ("WebKit encountered an
 * internal error") instead of letting the service worker answer it, so a
 * cached page can never be opened offline.
 */
export const WEBKIT_CANNOT_NAVIGATE_OFFLINE =
  "Playwright's WebKit fails an offline navigation before the service worker can answer it";

/**
 * `context.route` sees a service worker's own requests (networkSwitch, a
 * held answer) and its console in Chromium only.
 */
export const WEBKIT_CANNOT_WATCH_WORKER =
  "Playwright's WebKit neither routes a service worker's own requests nor reports its console";

/**
 * `context.newCDPSession` exists in Chromium only (WebKit and Firefox have no
 * CDP session), so a spec cannot stop a service worker on demand
 * (`ServiceWorker.stopAllWorkers`) elsewhere.
 */
export const CDP_IS_CHROMIUM_ONLY =
  "Playwright's CDP sessions exist in Chromium only, so a service worker cannot be stopped on demand";

/**
 * `mouse.wheel` throws in mobile WebKit and there is no touch swipe, so a
 * strip cannot be scrolled the way a finger does it (a script's scroll
 * ignores a locked strip's overflow). The `webkit` project runs these specs
 * at the same 390 px with touch.
 */
export const MOBILE_WEBKIT_CANNOT_SWIPE =
  "Playwright's mobile WebKit has no wheel or touch swipe; the webkit project covers it at 390 px";
