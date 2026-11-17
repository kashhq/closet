import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import { closeSwitchedContext, networkSwitch } from './service-worker';
import { WEBKIT_HAS_NO_CDP } from './webkit-limits';

/**
 * The contract of closeSwitchedContext (#1104), not a scenario: no app
 * server, a worker of its own. A context whose service worker stopped
 * answering the browser's protocol (stopped here through CDP) hangs every
 * call Playwright fans out to each of the context's pages and workers and
 * awaits without a deadline: `setOffline`, `unrouteAll`. The trips warm step
 * hung in `unrouteAll` that way until its test timeout. Closing the context
 * is the browser's own call and still answers.
 */

const WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
`;

/** Long past a close's few milliseconds, well inside the test's timeout. */
const CLOSE_BOUND_MS = 10_000;

test('a switched context closes when its service worker stops answering', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName === 'webkit', WEBKIT_HAS_NO_CDP);
  const server = createServer((request, response) => {
    const worker = request.url === '/sw.js';
    response.setHeader(
      'content-type',
      worker ? 'text/javascript' : 'text/html',
    );
    response.end(worker ? WORKER : '<p>switched</p>');
  });
  await new Promise<void>((listening) =>
    server.listen(0, '127.0.0.1', listening),
  );
  // localhost, not 127.0.0.1: a secure context, so the worker may register.
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const network = await networkSwitch(context);
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await network('offline');
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');

    let bound: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      closeSwitchedContext(context).then(
        () => 'closed',
        (error: unknown) => `failed: ${String(error)}`,
      ),
      new Promise<string>((hung) => {
        bound = setTimeout(() => hung('still closing'), CLOSE_BOUND_MS);
      }),
    ]).finally(() => clearTimeout(bound));
    expect(outcome).toBe('closed');
  } finally {
    // Already closed unless the assertion failed; close() is idempotent.
    await context.close();
    await new Promise((closed) => server.close(closed));
  }
});
