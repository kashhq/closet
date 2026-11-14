import type { Child } from 'hono/jsx';
import type { QueueableKind } from '../offline-writes';

/**
 * The one native POST form for the web layer (see above): the layout boosts
 * every form and htmx drops a boosted 4xx, so every form that posts natively
 * goes through this (every feature's forms, so it lives beside the web layer's shared modules, not in a feature). test/integration/pages.ts fails any page with a native
 * post that is still boosted. `confirm` asks before submitting; the text
 * travels as a data attribute, so nothing is spliced into the handler.
 * Every PostForm submits once (`data-submit-once`, public/js/submit-once.js):
 * its buttons are disabled after the first submit, until the page returns
 * from the back/forward cache.
 *
 * Every PostForm is disabled offline (`data-needs-network`,
 * public/js/connectivity.js), its controls outside it through `form=`
 * included: a cached copy posting without a connection lands on the
 * worker's offline page and loses what was typed (#411). The default since
 * the owner's call of 2026-10-22; it was each caller's opt-in and 15 forms
 * had left it out. `allowOffline` is the one way out, and guards.conf
 * `@post-form-offline` makes it carry its reason as a literal.
 * `offlineQueue` is the other (#178): a write the page's outbox queues
 * offline and replays (src/web/outbox.tsx), which stays enabled.
 *
 * `endsSession` marks the four posts that change whose session this device
 * has (sign-in, registration, sign-out, account deletion) as
 * `data-ends-session`: public/js/pwa.js tells the service worker as one
 * leaves (SESSION_ENDING), so it drops the session caches first, and the
 * outbox holds a sign-out or deletion to sync or discard what is queued.
 * The worker never relays the post itself (#542).
 */
export function PostForm(props: {
  action: string;
  confirm?: string;
  class?: string;
  /** For buttons outside the form that submit it through their `form` attribute. */
  id?: string;
  /**
   * Why this form may post while offline, which turns the offline guard
   * off. Rendered as `data-allow-offline`, so a reader of the page sees it.
   */
  allowOffline?: string;
  /** Queued offline instead of disabled: the laundry, a worn entry. */
  offlineQueue?: QueueableKind;
  /** Posts a file (multipart/form-data): selfies, garment photos, the add sheet. */
  multipart?: boolean;
  /** Signs in or out (see above): the session caches go as it leaves. */
  endsSession?: boolean;
  children?: Child;
}) {
  return (
    <form
      id={props.id}
      method="post"
      action={props.action}
      enctype={props.multipart ? 'multipart/form-data' : undefined}
      class={props.class}
      hx-boost="false"
      data-confirm={props.confirm}
      data-needs-network={
        props.allowOffline === undefined && props.offlineQueue === undefined
          ? ''
          : undefined
      }
      data-allow-offline={props.allowOffline}
      data-offline-queue={props.offlineQueue}
      data-ends-session={props.endsSession ? '' : undefined}
      // One post per tap: public/js/submit-once.js (the layout loads it).
      data-submit-once=""
    >
      {props.children}
    </form>
  );
}
