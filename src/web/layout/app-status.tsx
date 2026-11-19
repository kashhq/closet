import { t } from '../i18n';
import type { ViewContext } from '../view-context';
import { ClockIcon } from './parts';
import { APP_STATUS_ID, role, statusTextAttributes } from '../page-contract';

/**
 * Connectivity banner, the outbox's status and notice, and the toast host,
 * owned by the page's modules (connectivity, the outbox, pwa, freshness,
 * request-failures and toast; the names they read: src/web/page-contract.ts).
 * Lives inside <body>, so every hx-boost swap replaces it with this empty
 * copy; the scripts re-apply their state on htmx:afterSettle. The toast host
 * alone survives a swap (`hx-preserve`). The strings travel as data
 * attributes so the scripts stay free of i18n.
 *
 * Signed in, it also names the account and the household's time zone for
 * the outbox (#178): its records are the account's (`data-account`, the id
 * X-Page-Account sends), and a queued tap is dated in APP_TIMEZONE.
 */
export function AppStatus({ ctx }: { ctx: ViewContext }) {
  const signedIn = ctx.user !== undefined;
  return (
    <div
      id={APP_STATUS_ID}
      {...statusTextAttributes({
        offline: t('OFFLINE_BANNER'),
        reconnecting: t('RECONNECTING'),
        'back-online': t('BACK_ONLINE'),
        'update-available': t('UPDATE_AVAILABLE'),
        'update-needs-network': t('UPDATE_NEEDS_NETWORK'),
        reload: t('RELOAD'),
        // freshness.ts puts "3 minutes ago" (Intl.RelativeTimeFormat) in {ago}.
        'updated-ago': t('UPDATED_AGO', { ago: '{ago}' }),
        'newer-page': t('NEWER_PAGE_AVAILABLE'),
        refresh: t('REFRESH'),
        // request-failures.js: an htmx request with no answer, or one that
        // is not this app's (a proxy's 502); the server's own carry theirs.
        'request-timed-out': t('REQUEST_TIMED_OUT'),
        'request-failed': t('REQUEST_FAILED'),
        'request-id': t('REQUEST_ID'),
      })}
      data-account={ctx.user && String(ctx.user.id)}
      data-time-zone={signedIn ? ctx.timeZone : undefined}
      {...(signedIn ? outboxText() : {})}
    >
      {/* The banners stack under the app bar; the stack itself takes no
          taps, so an empty one never covers the page. */}
      <div class="fixed top-bar left-rail right-0 z-[999] px-4 pt-2 flex flex-col gap-2 pointer-events-none">
        <div
          id="connectivity-banner"
          role="status"
          aria-live="polite"
          class="hidden pointer-events-auto"
        >
          <div class="alert alert-warning alert-soft py-2 text-sm shadow-sm">
            <OfflineIcon class="size-5 shrink-0" />
            <span {...role('text')}></span>
          </div>
        </div>
        {signedIn && <OutboxStatus />}
      </div>
      {/* Above the dock (4rem) so toasts never cover the primary navigation.
          The page's one polite status region (#679): every toast lands
          here (public/js/toast.js), and none has a role of its own, since a
          region inserted with its message is not reliably read. hx-preserve
          keeps this very node across a boosted body swap (htmx moves the old
          one over the new copy), so a landing message is added to a region
          that was already there; its toasts persist with it. No fragment
          swap may target it or anything around it. */}
      <div
        id="toast-host"
        hx-preserve="true"
        role="status"
        aria-live="polite"
        class="toast toast-bottom toast-center mb-20 lg:mb-4 ml-[calc(var(--rail-width)/2)] z-[999]"
      ></div>
    </div>
  );
}

/**
 * The outbox's strings, as `data-text-outbox-*`: the counts come in a one
 * and a many form, `{count}`, `{label}`, `{action}` and `{reason}` filled by
 * the script.
 */
function outboxText(): Record<`data-text-outbox-${string}`, string> {
  const count = { count: '{count}' };
  const text = {
    'waiting-one': t('outbox.WAITING_ONE'),
    'waiting-many': t('outbox.WAITING_MANY', count),
    'syncing-one': t('outbox.SYNCING_ONE'),
    'syncing-many': t('outbox.SYNCING_MANY', count),
    'retrying-one': t('outbox.RETRYING_ONE'),
    'retrying-many': t('outbox.RETRYING_MANY', count),
    'saved-one': t('outbox.SAVED_ONE'),
    'saved-many': t('outbox.SAVED_MANY', count),
    'sign-in-one': t('outbox.SIGN_IN_ONE'),
    'sign-in-many': t('outbox.SIGN_IN_MANY', count),
    'discard-one': t('outbox.DISCARD_ONE'),
    'discard-many': t('outbox.DISCARD_MANY', count),
    full: t('outbox.FULL', count),
    'stale-day': t('outbox.STALE_DAY'),
    unavailable: t('outbox.UNAVAILABLE'),
    'not-saved': t('outbox.NOT_SAVED', {
      label: '{label}',
      action: '{action}',
      reason: '{reason}',
    }),
    stuck: t('outbox.STUCK', {
      label: '{label}',
      action: '{action}',
    }),
    'try-again': t('outbox.TRY_AGAIN'),
    'discard-write': t('outbox.DISCARD_WRITE'),
    'tried-again': t('outbox.TRIED_AGAIN', {
      label: '{label}',
      action: '{action}',
    }),
    discarded: t('outbox.DISCARDED', { label: '{label}', action: '{action}' }),
    'action-wear': t('outbox.action.WEAR'),
    'action-wash': t('outbox.action.WASH'),
    'action-entry': t('outbox.action.ENTRY'),
    'action-packed': t('outbox.action.PACKED'),
    'reason-gone': t('outbox.reason.GONE'),
    'reason-too-old': t('outbox.reason.TOO_OLD'),
    'reason-future': t('outbox.reason.FUTURE'),
    'reason-account': t('outbox.reason.ACCOUNT'),
    'reason-refused': t('outbox.reason.REFUSED'),
    'reason-server': t('outbox.reason.SERVER'),
  };
  return Object.fromEntries(
    Object.entries(text).map(([name, value]) => [
      `data-text-outbox-${name}`,
      value,
    ]),
  );
}

/**
 * The outbox's banner ("3 changes waiting to sync", "Syncing 3 changes",
 * "Sign in to save 3 changes") and its notice of the writes that were not
 * saved, which stays until Dismiss. public/js/outbox.js fills both.
 */
function OutboxStatus() {
  return (
    <>
      <div
        id="outbox-banner"
        role="status"
        aria-live="polite"
        class="hidden pointer-events-auto"
      >
        <div class="alert alert-info alert-soft py-2 text-sm shadow-sm">
          <ClockIcon class="size-5 shrink-0" />
          <span {...role('text')}></span>
        </div>
      </div>
      {/* A polite live region, not role="alert": it is on every signed-in
          page, empty and hidden, and pages read an alert as their error. */}
      <div
        id="outbox-notice"
        role="status"
        aria-label={t('outbox.NOTICE')}
        class="hidden pointer-events-auto"
      >
        <div class="alert alert-error alert-soft py-2 text-sm shadow-sm items-start">
          <ul {...role('list')} class="flex flex-col gap-1 flex-1 min-w-0"></ul>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-outbox-dismiss=""
          >
            {t('outbox.DISMISS')}
          </button>
        </div>
      </div>
    </>
  );
}

/** Heroicons "signal-slash"; also on the offline page. */
export function OfflineIcon(props: { class: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class={props.class}
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="m3 3 8.735 8.735m0 0a.374.374 0 1 1 .53.53m-.53-.53.53.53m0 0L21 21M14.652 9.348a3.75 3.75 0 0 1 0 5.304m2.121-7.425a6.75 6.75 0 0 1 0 9.546m2.121-11.667c3.808 3.807 3.808 9.98 0 13.788m-9.546-4.242a3.733 3.733 0 0 1-1.06-2.122m-1.061 4.243a6.75 6.75 0 0 1-1.625-6.929m-.496 9.05c-3.068-3.067-3.664-7.67-1.79-11.334M12 12h.008v.008H12V12Z"
      />
    </svg>
  );
}
