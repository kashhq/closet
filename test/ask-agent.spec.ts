import { expect, test } from './support/fixtures';
import { setWritesReachable } from './support/connectivity';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * "Ask your agent" offline (#1286; docs/plans/2026-11-27-mcp-oauth.md
 * section 3.4), as the installed app on a phone: what only a real browser
 * shows is the outbox's half, the sheet's ask queued while the heartbeat
 * fails, its "Waiting to sync" (a reload too), and the replay on reconnect landing on
 * Today. The routes, the replay's idempotence and the markup are
 * test/integration/queued-writes.spec.ts's and authorization-account.spec.ts's.
 */

// The worker blocked, as in offline-writes.spec.ts: connectivity.js runs
// the same without one, and WebKit would send the heartbeat past the route.
test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

test('an ask queued offline syncs on reconnect and shows on Today', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'ask-agent');
  // A closet that dresses: the first-run path offers only adding garments.
  await createGarment(page, 'White tee');
  await createGarment(page, 'Navy chinos', 'bottoms');
  await page.goto('/');
  const ask = page.locator('[data-ask-agent="today"]');
  const sheet = page.getByRole('dialog', { name: 'Ask your agent' });

  await setWritesReachable(page, false);
  await ask.getByRole('button', { name: 'Ask your agent' }).click();
  await sheet
    .getByLabel('What should your agent do?')
    .fill('What should I wear to the dinner tonight?');
  await sheet.getByRole('button', { name: 'Ask', exact: true }).click();
  // Queued: the sheet closes, the region and the banner say it waits.
  await expect(sheet).toBeHidden();
  await expect(ask.getByText('Waiting to sync')).toBeVisible();
  await expect(page.locator('#outbox-banner')).toContainText(
    '1 change waiting to sync',
  );
  // A copy that never saw the tap (its form's client id is the markup's
  // empty one) still finds the queued ask by its sheet.
  await page.reload();
  await expect(ask.getByText('Waiting to sync')).toBeVisible();

  await setWritesReachable(page, true);
  await expect(page.locator('#toast-host')).toContainText('1 change saved');
  await expect(ask.getByText('Waiting to sync')).toBeHidden();
  // Untouched since the reload, the page takes the server's newer copy
  // itself (freshness.js), the card with it.
  const card = page.locator('[data-today-requests="1"]');
  await expect(card).toContainText('What should I wear to the dinner tonight?');
  await expect(card).toContainText('Waiting for your agent');
  await expect(card.locator('[data-no-agent]')).toBeVisible();
  expect(errors).toEqual([]);
});
