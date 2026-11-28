import type { Page } from '@playwright/test';
import { expect } from './fixtures';

/**
 * Connectivity as the page's heartbeat sees it (connectivity.js), for the
 * Playwright specs that go offline with the service worker blocked
 * (test/offline-writes.spec.ts, test/ask-agent.spec.ts).
 */

/** Fails the heartbeat (or lets it through) and tells the page to probe. */
export async function setReachable(page: Page, reachable: boolean) {
  if (reachable) await page.unroute('**/health/live');
  else await page.route('**/health/live', (route) => route.abort());
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    reachable ? 'online' : 'offline',
  );
  await expect(page.locator('#connectivity-banner')).toBeVisible({
    visible: !reachable,
  });
}

/**
 * Offline for writes too: every POST the page sends fails like the
 * heartbeat, so a queued write can only wait. Pages still load (GET), as a
 * cached copy would.
 */
export async function setWritesReachable(page: Page, reachable: boolean) {
  if (reachable) {
    await page.unroute('**/*');
  } else {
    await page.route('**/*', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.fallback(),
    );
  }
  await setReachable(page, reachable);
}
