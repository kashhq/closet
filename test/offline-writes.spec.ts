import { type Page, type Request, type Route } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { createGarment, createOutfit } from './support/e2e-data';
import {
  APP_ORIGIN,
  E2E_PASSWORD,
  SAME_ORIGIN,
  signIn,
  signUpHeaders,
} from './support/e2e-session';
import { householdToday } from './support/household-today';
import { pageErrors } from './support/page-errors';
import {
  cachePage,
  closeSwitchedContext,
  networkSwitch,
  waitForServiceWorker,
  withoutWarming,
} from './support/service-worker';
import { WEBKIT_CANNOT_WATCH_WORKER } from './support/webkit-limits';
import { addDays } from '../src/calendar-date';
import { queueableKindOf, REPLAY_TIMEOUT_MS } from '../src/offline-writes';
import { CACHED_AT_HEADER } from '../src/web/page-cache';

/**
 * Every PostForm is disabled offline (#411; owner, 2026-10-22): when
 * connectivity.js's heartbeat fails, every control that can submit a
 * `data-needs-network` form is `disabled`, those outside it through `form=`
 * included (the add sheet's photo inputs), and coming back online re-enables
 * exactly those. Its log line counts them. The forms are found on the page,
 * not listed; the integration tier's expectFullPage holds every page's
 * PostForms to the marker.
 *
 * Except the writes the outbox queues (#178, public/js/gen/outbox.js): Wore
 * today and a packing tick stay enabled offline, show their other state and
 * "Waiting to sync", and save on reconnect; a write the server refuses is a
 * notice until dismissed or signed out; another account's page never sends
 * them. A tap behind a record still waiting (backing off, or in flight, in
 * this tab or another) goes through the outbox too, so the older one never
 * lands after it; a tap that never reached the server, a replay that never
 * answers and a refusal each end where the user can see. With the service
 * worker (its own context: the rest blocks it), a sync refetches the cached
 * pages it changed, and signing out deletes the queue.
 * Their markup is test/integration/queued-writes.spec.ts's.
 */

// The worker blocked: once it controls the page, WebKit sends the heartbeat
// through it and page.route never sees it (docs/testing-webkit.md, #436).
// connectivity.js runs the same with or without one, so nothing is lost.
test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

/** Each guarded form's controls: how many, and how many are disabled. */
function guardedControls(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLFormElement>('form[data-needs-network]'),
      (form) => {
        const controls = Array.from(form.elements).filter(
          (el): el is HTMLButtonElement | HTMLInputElement =>
            el.matches('button, input, select, textarea'),
        );
        return {
          action: form.getAttribute('action'),
          controls: controls.length,
          disabled: controls.filter((el) => el.disabled).length,
          outside: controls.filter((el) => !form.contains(el)).length,
          // connectivity.js's mark on the controls it disabled.
          marked: controls.filter((el) => 'offlineDisabled' in el.dataset)
            .length,
        };
      },
    ),
  );
}

/**
 * Offline for writes too: every POST the page sends fails like the
 * heartbeat, so a queued write can only wait. Pages still load (GET), as a
 * cached copy would.
 */
async function setWritesReachable(page: Page, reachable: boolean) {
  if (reachable) {
    await page.unroute('**/*');
  } else {
    await page.route('**/*', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.fallback(),
    );
  }
  await setReachable(page, reachable);
}

/** The worker's copy of a page: when it was cached (0: none). */
function cachedAtOf(page: Page, path: string): Promise<number> {
  return page.evaluate(
    async ([key, header]) => {
      const copy = await (await caches.open('pages-v2')).match(key);
      return Number(copy?.headers.get(header) ?? 0);
    },
    [path, CACHED_AT_HEADER],
  );
}

/** Fails the heartbeat (or lets it through) and tells the page to probe. */
async function setReachable(page: Page, reachable: boolean) {
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

// One scenario, in steps: the e2e tier holds ten (test/AGENTS.md), and a new
// one replaces one. The page's own clock ticks as usual, so the replay
// timeout can be jumped past instead of waited for.
test('offline: PostForms are guarded, and queued writes wait, save and stay ordered', async ({
  page,
  browser,
  browserName,
}) => {
  await page.clock.install();
  const errors = pageErrors(page);

  await test.step('every PostForm on a page is disabled offline and restored online', async () => {
    await signIn(page, 'offline-writes');
    let outside = 0;
    for (const url of ['/wardrobe', '/auth/profile/week', '/auth/tokens']) {
      await page.goto(url);
      const online = await guardedControls(page);
      expect(online.length, url).toBeGreaterThan(0);

      const logged = page.waitForEvent('console', (message) =>
        message.text().includes('write controls disabled'),
      );
      await setReachable(page, false);
      const offline = await guardedControls(page);
      for (const form of offline) {
        expect(form, url).toMatchObject({ disabled: form.controls });
      }
      const forms = offline.filter((form) => form.marked > 0).length;
      expect(forms, url).toBeGreaterThan(0);
      expect((await logged).text()).toContain(`(${forms} forms)`);
      outside += offline.reduce((sum, form) => sum + form.outside, 0);

      await setReachable(page, true);
      await expect.poll(() => guardedControls(page)).toEqual(online);
    }
    // The add sheet's camera and library inputs name their forms in `form=`.
    expect(outside).toBeGreaterThanOrEqual(2);

    // The capsule picker's Save sits in the action bar, outside #pick-form
    // (`form=`): disabled offline beside the banner's reason, and online a
    // double tap posts once (submit-once.js reads the form's `elements`).
    await createGarment(page, 'Picked tee');
    const made = await page.request.post('/capsules', {
      form: { name: 'Picked' },
      headers: SAME_ORIGIN,
    });
    const capsuleId = /^\/capsules\/(\d+)/.exec(
      new URL(made.url()).pathname,
    )![1];
    const capsule = `/capsules/${capsuleId}`;
    await page.goto(`/wardrobe?pick=${capsuleId}`);
    const save = page.locator('#wardrobe-actions').getByRole('button', {
      name: 'Save',
      exact: true,
    });
    await setReachable(page, false);
    await expect(save).toBeDisabled();
    await expect(page.locator('#connectivity-banner')).toContainText(
      'Dimmed controls need a connection.',
    );
    await setReachable(page, true);
    await expect(save).toBeEnabled();
    const picks: string[] = [];
    const countPick = (request: Request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && pathname === `${capsule}/garments`) {
        picks.push(pathname);
      }
    };
    page.on('request', countPick);
    await save.dblclick();
    await page.waitForURL((url) => url.pathname === capsule);
    page.off('request', countPick);
    expect(picks).toHaveLength(1);
  });

  await test.step('wears and ticks queue offline, save on reconnect, and stay their account’s', async () => {
    const email = await signIn(page, 'outbox');
    const chinos = await createGarment(page, 'Navy chinos');
    const gone = await createGarment(page, 'Gone tee');
    const today = householdToday();
    const created = await page.request.post('/trips', {
      form: {
        name: 'Queued trip',
        destination: '',
        startsOn: today,
        endsOn: addDays(today, 1),
        notes: '',
      },
      headers: SAME_ORIGIN,
    });
    const tripUrl = new URL(created.url()).pathname;
    expect(
      (
        await page.request.post(`${tripUrl}/outfits`, {
          form: {
            outfitId: String(await createOutfit(page, 'Trip look', chinos)),
            day: '',
            occasion: '',
          },
          headers: SAME_ORIGIN,
        })
      ).ok(),
    ).toBe(true);
    // Queued writes that reached the server, and every one attempted.
    const saved: string[] = [];
    const attempted: string[] = [];
    const queued = (url: string) => queueableKindOf(new URL(url).pathname);
    page.on('requestfinished', (request) => {
      if (queued(request.url())) saved.push(request.url());
    });
    page.on('request', (request) => {
      if (queued(request.url())) attempted.push(request.url());
    });
    const offlineBanner = page.locator('#connectivity-banner');
    const banner = page.locator('#outbox-banner');
    const pendingChips = page.locator(
      '[data-outbox="pending"] [data-outbox-chip]',
    );
    const wore = page.getByRole('button', { name: 'Wore today', exact: true });
    const undo = page.getByRole('button', { name: 'Undo “Wore today”' });

    // Offline: the tap shows its other state and waits, nothing sent.
    await page.goto(`/wardrobe/${chinos}`);
    await setWritesReachable(page, false);
    await expect(wore).toBeEnabled();
    await wore.click();
    await expect(undo).toBeVisible();
    await expect(pendingChips).toHaveCount(1);
    await expect(banner).toHaveText('1 change waiting to sync');
    await page.goto(`/wardrobe/${gone}`);
    await expect(offlineBanner).toBeVisible();
    await wore.click();
    await expect(banner).toHaveText('2 changes waiting to sync');

    // Reopened offline, the page shows what waits, from the records.
    await page.goto(`/wardrobe/${chinos}`);
    await expect(undo).toBeVisible();
    await expect(pendingChips).toHaveCount(1);

    // The tick is the last tap, and its page stays on screen through the sync.
    await page.goto(tripUrl);
    await expect(offlineBanner).toBeVisible();
    const tick = page.getByRole('checkbox', { name: /Navy chinos/ });
    const summary = page.locator('#trip-packed-summary');
    await expect(summary).toContainText('0 of 1 packed');
    await tick.check();
    await expect(pendingChips).toHaveCount(1);
    await expect(summary).toContainText('1 of 1 packed');
    await expect(banner).toHaveText('3 changes waiting to sync');
    expect(saved).toEqual([]);

    // The tee goes meanwhile (elsewhere): its wear cannot be saved.
    expect(
      (
        await page.request.delete(`/wardrobe/${gone}`, { headers: SAME_ORIGIN })
      ).ok(),
    ).toBe(true);

    // Back online: saved, said once, and the refusal stays.
    await setWritesReachable(page, true);
    await expect(page.getByText('2 changes saved')).toBeVisible();
    await expect(pendingChips).toHaveCount(0);
    await expect(banner).toBeHidden();
    const notice = page.locator('#outbox-notice');
    await expect(notice).toContainText(
      'Gone tee, Wore today: not saved, it was deleted.',
    );
    // The synced tick keeps its count (#823: not the page-load 0), and the
    // page, touched and with no worker to renew it, is offered the server's
    // copy, which brings the same (#900).
    await expect(summary).toContainText('1 of 1 packed');
    await expect(tick).toBeChecked();
    // Marked so the server's copy is told apart from the outbox's drawing.
    await summary.evaluate((element) => {
      element.dataset.drawn = '';
    });
    await page
      .locator('#toast-host > div', { hasText: 'Newer version of this page' })
      .getByRole('button', { name: 'Refresh' })
      .click();
    await expect(page.locator('#trip-packed-summary[data-drawn]')).toHaveCount(
      0,
    );
    await expect(summary).toContainText('1 of 1 packed');
    await expect(tick).toBeChecked();
    await page.goto(`/wardrobe/${chinos}`);
    await expect(undo).toBeVisible();
    await expect(notice).toBeVisible();

    // A declined deletion keeps it: the form's own confirm comes after the
    // outbox's hold, which must not have discarded anything yet.
    await page.goto('/auth/delete-account');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    // The sheet is asked after the outbox's hold, the form's own confirm.
    const confirmSheet = page.locator('#confirm-sheet');
    await page.getByRole('button', { name: 'Delete account' }).click();
    await expect(confirmSheet).toContainText(
      'Are you sure you want to delete your account?',
    );
    await confirmSheet.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page).toHaveURL(/\/auth\/delete-account$/);
    await page.goto(tripUrl);
    await expect(notice).toBeVisible();

    // Signing out with the refusal unsynced asks before discarding it.
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    await page
      .locator('#sign-out')
      .getByRole('button', { name: 'Sign out' })
      .click();
    await expect(confirmSheet).toContainText(
      '1 change has not synced. Sign out and discard it?',
    );
    await confirmSheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);

    // Queued as one account, the page of another deletes it unsent.
    expect(
      (
        await page.request.post('/auth/login', {
          form: { email, password: E2E_PASSWORD },
          headers: signUpHeaders(),
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/wardrobe/${chinos}`);
    await setWritesReachable(page, false);
    await undo.click();
    await expect(banner).toHaveText('1 change waiting to sync');
    // Signed out (a revoked session) and in as someone else before it could
    // sync: still offline, so only the new page's own rule can act on it.
    await page.context().clearCookies();
    await signIn(page, 'outbox-other');
    attempted.length = 0;
    const deleted = page.waitForEvent('console', (message) =>
      message.text().includes('of another account dropped unsent'),
    );
    await page.goto('/wardrobe');
    expect((await deleted).text()).toContain('[outbox] 1 queued change(s)');
    await setWritesReachable(page, true);
    await expect(banner).toBeHidden();
    expect(attempted).toEqual([]);
  });

  await test.step('a tap behind a waiting replay replaces it and lands last', async () => {
    await signIn(page, 'outbox-order');
    const chinos = await createGarment(page, 'Order chinos');
    const wore = page.getByRole('button', { name: 'Wore today', exact: true });
    const undo = page.getByRole('button', { name: 'Undo “Wore today”' });
    const waiting = page.locator('[data-outbox="pending"]');
    const notice = page.locator('#outbox-notice');
    const wearPath = `/wardrobe/${chinos}/wear`;
    const worn = (route: Route) =>
      new URLSearchParams(route.request().postData() ?? '').get('worn');
    const replayed = (value: string, on = page) =>
      on.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === wearPath &&
          response.request().headers()['x-closet-queued'] !== undefined &&
          new URLSearchParams(response.request().postData() ?? '').get(
            'worn',
          ) === value &&
          response.status() === 204,
      );
    // How the wear route answers: every worn=1 a 503 (backing off for as
    // long as the test needs); the first request held until released, failed
    // as unreachable, never answered, or refused as too old; else the server.
    let answer:
      | 'refuse-worn'
      | 'hold'
      | 'abort-once'
      | 'hang'
      | 'conflict-once'
      | 'pass' = 'refuse-worn';
    let release: (() => Promise<void>) | undefined;
    let reached: () => void = () => undefined;
    const reachedOnce = () =>
      new Promise<void>((resolve) => {
        reached = resolve;
      });
    let held = reachedOnce();
    // Opened by a boosted tap, whose answer's ETag names the copy on screen:
    // page.clock replaces `performance`, so a full load's tag (Navigation
    // Timing's Server-Timing) cannot be read under it.
    await page.goto('/wardrobe');
    await page.locator(`main a[href="/wardrobe/${chinos}"]`).first().click();
    await expect(wore).toBeVisible();
    await page.route(`**${wearPath}`, async (route) => {
      const now = answer;
      if (now === 'refuse-worn' && worn(route) === '1') {
        await route.fulfill({ status: 503 });
        return;
      }
      if (now === 'refuse-worn' || now === 'pass') {
        await route.fallback();
        return;
      }
      answer = 'pass';
      reached();
      if (now === 'hold') release = () => route.fallback();
      else if (now === 'abort-once') await route.abort();
      else if (now === 'conflict-once') {
        await route.fulfill({
          status: 409,
          headers: { 'X-Closet-Outcome': 'too-old' },
        });
      }
      // 'hang': never answered.
    });

    // Backing off: Wore today queued, its replay a 503; the Undo tapped
    // online replaces it and is the only one sent.
    await setWritesReachable(page, false);
    await wore.click();
    await expect(undo).toBeVisible();
    const backingOff = page.waitForEvent('console', (message) =>
      message.text().includes('unreachable, retry 1'),
    );
    await setWritesReachable(page, true);
    await backingOff;
    const undone = replayed('0');
    // The Undo leaves the server as the page was loaded: the sync's server
    // copy answers 304 to the page's tag, and nothing is offered (#900).
    const unchanged = page.waitForEvent('console', (message) =>
      message.text().includes('server copy after a sync unchanged'),
    );
    await undo.click();
    await undone;
    await expect(waiting).toHaveCount(0);
    await unchanged;
    await expect(
      page.locator('#toast-host > div', {
        hasText: 'Newer version of this page',
      }),
    ).toHaveCount(0);
    await page.reload();
    await expect(wore).toBeVisible();
    await expect(waiting).toHaveCount(0);

    // In flight: Wore today's replay held at the server's door; the Undo
    // tapped meanwhile waits for it, then lands after it.
    await setWritesReachable(page, false);
    await wore.click();
    await expect(undo).toBeVisible();
    answer = 'hold';
    await setWritesReachable(page, true);
    await held;
    await undo.click();
    const undoneAfter = replayed('0');
    await release?.();
    await undoneAfter;
    await expect(waiting).toHaveCount(0);
    await page.reload();
    await expect(wore).toBeVisible();

    // Online, the tap never reaches the server and the heartbeat still
    // answers (no connectivity change): queued, and drained without a reload.
    answer = 'abort-once';
    held = reachedOnce();
    const woreReplayed = replayed('1');
    await wore.click();
    await held;
    await woreReplayed;
    await expect(waiting).toHaveCount(0);
    await expect(undo).toBeVisible();

    // A replay that never answers gives up after the timeout, so the drain
    // lock comes back: a tap made meanwhile is sent.
    await setWritesReachable(page, false);
    await undo.click();
    await expect(wore).toBeVisible();
    answer = 'hang';
    held = reachedOnce();
    await setWritesReachable(page, true);
    await held;
    await wore.click();
    await expect(undo).toBeVisible();
    const woreAfterHang = replayed('1');
    await page.clock.fastForward(REPLAY_TIMEOUT_MS);
    await woreAfterHang;
    await expect(waiting).toHaveCount(0);
    await page.reload();
    await expect(undo).toBeVisible();

    // Refused (409): the notice says so and the control shows the server's
    // state again, not the unsaved one.
    await setWritesReachable(page, false);
    await undo.click();
    await expect(wore).toBeVisible();
    answer = 'conflict-once';
    await setWritesReachable(page, true);
    await expect(notice).toContainText('Order chinos');
    await expect(undo).toBeVisible();
    await expect(waiting).toHaveCount(0);
    await notice.getByRole('button').click();
    await expect(notice).toBeHidden();

    // Two tabs: A queues Undo offline; B is told and shows it, and drains it
    // into a 503 (so it stays pending); B's Wore today goes through the
    // outbox in place of A's record, so the older Undo never lands after it.
    const other = await page.context().newPage();
    const otherErrors = pageErrors(other);
    await other.goto(`/wardrobe/${chinos}`);
    await other.route(`**${wearPath}`, (route) =>
      worn(route) === '0' ? route.fulfill({ status: 503 }) : route.fallback(),
    );
    const otherBackingOff = other.waitForEvent('console', (message) =>
      message.text().includes('unreachable, retry 1'),
    );
    const otherUndo = other.getByRole('button', { name: 'Undo “Wore today”' });
    const otherWore = other.getByRole('button', {
      name: 'Wore today',
      exact: true,
    });
    await expect(otherUndo).toBeVisible();
    await setWritesReachable(page, false);
    await undo.click();
    await expect(wore).toBeVisible();
    await expect(otherWore).toBeVisible();
    await expect(other.locator('[data-outbox="pending"]')).toHaveCount(1);
    await otherBackingOff;
    const fromOther = replayed('1', other);
    await otherWore.click();
    await fromOther;
    await expect(other.locator('[data-outbox="pending"]')).toHaveCount(0);
    await setWritesReachable(page, true);
    await expect(waiting).toHaveCount(0);
    await page.reload();
    await expect(undo).toBeVisible();
    expect(otherErrors).toEqual([]);
  });

  await test.step('a write the server keeps failing ends stuck, never dropped, and the one behind it saves', async () => {
    await signIn(page, 'outbox-poison');
    const poisoned = await createGarment(page, 'Poison chinos');
    const neighbour = await createGarment(page, 'Behind shirt');
    const wore = page.getByRole('button', { name: 'Wore today', exact: true });
    const undo = page.getByRole('button', { name: 'Undo “Wore today”' });
    const banner = page.locator('#outbox-banner');
    const notice = page.locator('#outbox-notice');
    // Every wear of the first garment is a handler bug: a 500, deterministically.
    await page.route(`**/wardrobe/${poisoned}/wear`, (route) =>
      route.fulfill({ status: 500 }),
    );

    await page.goto(`/wardrobe/${poisoned}`);
    await setWritesReachable(page, false);
    await wore.click();
    await expect(undo).toBeVisible();
    await page.goto(`/wardrobe/${neighbour}`);
    await wore.click();
    await expect(undo).toBeVisible();
    // Each reconnect drains at once (no backoff is waited for); the third 5xx
    // makes the record stuck.
    for (const round of [1, 2, 3]) {
      const answered = page.waitForEvent('console', (message) =>
        message
          .text()
          .includes(round === 3 ? 'stuck, retry' : 'server-error, retry'),
      );
      await setWritesReachable(page, true);
      await answered;
      if (round < 3) {
        // Online and backing off: the banner says the server is not answering.
        await expect(banner).toContainText('not saved yet');
        await setWritesReachable(page, false);
      }
    }

    // Named in the notice with its two actions; the neighbour was sent.
    await expect(notice).toContainText('Poison chinos');
    await expect(notice).toContainText(
      'the server keeps answering with an error',
    );
    await expect(banner).toBeHidden();
    await page.goto(`/wardrobe/${neighbour}`);
    await expect(undo).toBeVisible();
    await expect(page.locator('[data-outbox="pending"]')).toHaveCount(0);
    await page.goto(`/wardrobe/${poisoned}`);
    await expect(page.locator('[data-outbox="pending"]')).toHaveCount(1);
    await expect(
      notice.getByRole('button', { name: 'Try again' }),
    ).toBeVisible();

    // Discard deletes it and the control shows the server's state again.
    await notice.getByRole('button', { name: 'Discard' }).click();
    await expect(notice).toBeHidden();
    await expect(wore).toBeVisible();
    await expect(page.locator('[data-outbox="pending"]')).toHaveCount(0);
  });

  await test.step('a native post (the laundry’s Mark washed) is held, queued a wash per row, and replays on reconnect', async () => {
    await signIn(page, 'outbox-laundry');
    const ids = [
      await createGarment(page, 'Hamper tee'),
      await createGarment(page, 'Hamper shirt'),
    ];
    for (const id of ids) {
      expect(
        (
          await page.request.post(`/wardrobe/${id}/wear`, {
            form: { worn: '1' },
            headers: SAME_ORIGIN,
          })
        ).ok(),
      ).toBe(true);
    }
    const banner = page.locator('#outbox-banner');
    const posted: string[] = [];
    const washes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const { pathname } = new URL(request.url());
      // Only the laundry's own post and the washes it queues: the vitals and
      // error-tracking beacons are POSTs too.
      if (pathname === '/laundry') posted.push(pathname);
      else if (/^\/wardrobe\/\d+\/washed$/.test(pathname)) {
        washes.push(pathname);
      }
    });

    await page.goto('/laundry');
    await setWritesReachable(page, false);
    await page.getByRole('button', { name: 'Mark washed' }).click();
    // Held at the capture-phase submit: the form never posts, so the page
    // stays on the hamper and each row is its own pending wash.
    await expect(banner).toHaveText('2 changes waiting to sync');
    await expect(page).toHaveURL(/\/laundry$/);
    expect(posted).toEqual([]);

    await setWritesReachable(page, true);
    await expect(page.getByText('2 changes saved')).toBeVisible();
    await expect(banner).toBeHidden();
    expect(posted).toEqual([]);
    expect(washes.sort()).toEqual(
      ids.map((id) => `/wardrobe/${id}/washed`).sort(),
    );
    await page.reload();
    await expect(page.getByText('Nothing needs a wash.')).toBeVisible();
  });

  await test.step('the worker refetches what a sync saved, and the queue ends with the session', async (step) => {
    step.skip(
      process.env.PWA_ENABLED !== 'true',
      'needs a server started with PWA_ENABLED=true',
    );
    // networkSwitch routes the worker's own fetches, and a refetch is one.
    step.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    step.skip(
      browserName === 'firefox',
      'service workers are untested in Firefox here',
    );
    const context = await browser.newContext({
      baseURL: APP_ORIGIN,
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'allow',
    });
    try {
      // The caches hold this step's visits alone, so only the sync's
      // refetch can renew the garment page's copy.
      await withoutWarming(context);
      const network = await networkSwitch(context);
      const app = await context.newPage();
      const appErrors = pageErrors(app);
      await signIn(app, 'outbox-worker');
      const chinos = await createGarment(app, 'Synced chinos');
      const shirt = await createGarment(app, 'Synced shirt');
      const garmentPage = `/wardrobe/${chinos}`;
      const shirtPage = `/wardrobe/${shirt}`;
      const wore = app.getByRole('button', { name: 'Wore today', exact: true });
      const undo = app.getByRole('button', { name: 'Undo “Wore today”' });
      // Every open tab hears it, so none drains behind the switch's back.
      const goOnline = async (online: boolean) => {
        await network(online ? 'online' : 'offline');
        for (const tab of context.pages()) {
          await tab.evaluate(
            (event) => window.dispatchEvent(new Event(event)),
            online ? 'online' : 'offline',
          );
          await expect(tab.locator('#connectivity-banner')).toBeVisible({
            visible: !online,
          });
        }
      };
      await waitForServiceWorker(app);
      await cachePage(app, '/auth/profile');
      await cachePage(app, garmentPage);

      // Worn offline, then the app left for a page the sync does not touch.
      await goOnline(false);
      await wore.click();
      await expect(undo).toBeVisible();
      await app.goto('/auth/profile');
      await expect(app.locator('#outbox-banner')).toHaveText(
        '1 change waiting to sync',
      );
      const cachedBefore = await cachedAtOf(app, garmentPage);
      expect(cachedBefore).toBeGreaterThan(0);
      await goOnline(true);
      await expect(app.getByText('1 change saved')).toBeVisible();
      await expect
        .poll(() => cachedAtOf(app, garmentPage))
        .toBeGreaterThan(cachedBefore);

      // Reopened offline, the garment page is the synced one: worn, from
      // the server's markup, with nothing waiting.
      await goOnline(false);
      await app.goto(garmentPage);
      await expect(undo).toBeVisible();
      await expect(app.locator('[data-outbox="pending"]')).toHaveCount(0);

      // Worn offline and kept on screen through the sync, with a second tab
      // on the same page: the worker renews the copy the sender shows too,
      // and the untouched tab swaps the server's in (its worn line is only
      // ever the server's; the outbox draws the button alone).
      await goOnline(true);
      const other = await context.newPage();
      const otherErrors = pageErrors(other);
      await cachePage(other, shirtPage);
      await expect(other.getByText('Not worn yet')).toBeVisible();
      // The sender's load stores the copy last: the one the sync must renew.
      const otherCopy = await cachedAtOf(other, shirtPage);
      await app.goto(shirtPage);
      await expect
        .poll(() => cachedAtOf(app, shirtPage))
        .toBeGreaterThan(otherCopy);
      const shirtCachedBefore = await cachedAtOf(app, shirtPage);
      await goOnline(false);
      await wore.click();
      await expect(undo).toBeVisible();
      await goOnline(true);
      await expect(app.locator('[data-outbox="pending"]')).toHaveCount(0);
      await expect
        .poll(() => cachedAtOf(app, shirtPage))
        .toBeGreaterThan(shirtCachedBefore);
      await expect(other.getByText('Worn once')).toBeVisible();
      await expect(
        other.getByRole('button', { name: 'Undo “Wore today”' }),
      ).toBeVisible();
      await other.close();
      expect(otherErrors).toEqual([]);
      // The sender's renewed copy, reopened offline: worn, by the server.
      await goOnline(false);
      await app.goto(shirtPage);
      await expect(app.getByText('Worn once')).toBeVisible();
      await expect(undo).toBeVisible();
      await expect(app.locator('[data-outbox="pending"]')).toHaveCount(0);

      expect(appErrors).toEqual([]);
    } finally {
      await closeSwitchedContext(context);
    }
  });

  expect(errors).toEqual([]);
});
