import type { Child } from 'hono/jsx';
import type { QueueableKind } from '../offline-writes';
import { t } from './i18n';
import { needsNetwork } from './page-contract';

/**
 * Save-on-change ("autosave") controls: every form or control that posts on
 * `change` is built here (`AutosaveForm`, or `autosaveAttributes` for
 * controls inside a larger form), so none of them loses a quick edit.
 * `expectAutosaveControls` (test/integration/pages.ts) fails a page with a
 * change-triggered post built any other way. Found on #62's reminders form;
 * test/autosave.spec.ts (retired 2026-10-13) changes each family on a slow network.
 *
 * What went wrong before, in htmx 2: a change made while the form's save was
 * in flight is queued on the element that issued it and re-issued when the
 * save's answer has been swapped in, reading the form at that moment; an
 * answer that replaced that element (`outerHTML` on the form's section)
 * dropped the queued save with it, and an answer that re-rendered the
 * controls put back what the person had changed since. The rules:
 *
 * 1. **One queue per form, the latest last** (`hx-sync="closest form:queue
 *    last"`, the form itself for an `AutosaveForm`): nothing is in flight
 *    twice, so the server applies saves in order, and a change made while one
 *    is in flight replaces any save still waiting.
 * 2. **Each save posts the whole form**, read when it is sent (htmx includes
 *    the enclosing form in every non-GET request): the last save carries every
 *    change, those whose own requests were replaced in the queue included.
 * 3. **The answer never replaces the element that posts**, where htmx keeps
 *    the queue and its listeners (a swapped-in trigger listens only after the
 *    settle delay). It goes into the form's status line (`AutosaveStatus`,
 *    the default: the controls are the person's and the server only confirms)
 *    or, where the server must redraw controls (a type's presets), into a
 *    region's contents (`innerHTML`). And an answer overtaken by an edit is
 *    not swapped in at all (public/js/autosave.js): the edit's own save is
 *    queued behind it and its answer lands instead, built from the whole
 *    latest form. So no answer is ever older than the controls it redraws.
 *
 * Other swaps must not replace an autosave form either: a queued save dies
 * with its element. Sibling writes answer regions beside it (the wear
 * section's buttons, the weather's other forms).
 */

/**
 * The htmx attributes of a control that posts its form on every change,
 * answered into `target`'s contents: a region the server redraws, never the
 * control itself. For controls inside a form that is not saved as a whole
 * (the garment form's properties); a form saved on change is `AutosaveForm`.
 */
export function autosaveAttributes(url: string, target: string) {
  return {
    'hx-post': url,
    'hx-trigger': 'change',
    'hx-sync': 'closest form:queue last',
    'hx-target': target,
    'hx-swap': 'innerHTML',
    // Edits under it overtake its form's answers in flight (autosave.js).
    'data-autosave': '',
  } as const;
}

/**
 * A form saved on every change (and on submit: Enter in a note, a submit
 * button such as tagging's Next). By default the route answers
 * `<AutosaveSaved />`, which fills the form's status line; with `region`
 * (an element inside the form) it answers that region's contents.
 * `native`: the form also posts without script to `action` (the route
 * answers a plain post with a redirect). Every save needs the network
 * (data-needs-network, connectivity.js), unless it is `offlineQueue`'s: a
 * checklist whose ticks the page's outbox queues offline, one record per
 * row (#178, src/web/outbox.tsx).
 */
export function AutosaveForm(props: {
  action: string;
  /** An htmx target whose contents the answer replaces, instead of the status line. */
  region?: string;
  native?: boolean;
  offlineQueue?: QueueableKind;
  class?: string;
  children: Child;
}) {
  const region = props.region;
  return (
    <form
      method={props.native ? 'post' : undefined}
      action={props.native ? props.action : undefined}
      class={props.class ?? 'flex flex-col gap-1'}
      {...autosaveAttributes(
        props.action,
        region ?? 'find [data-autosave-status]',
      )}
      hx-trigger="change, submit"
      {...needsNetwork(props.offlineQueue === undefined)}
      data-offline-queue={props.offlineQueue}
    >
      {props.children}
      {region === undefined && <AutosaveStatus />}
    </form>
  );
}

/** The status line an `AutosaveForm`'s answers fill. */
function AutosaveStatus() {
  return (
    <p class="text-xs min-h-4" aria-live="polite" data-autosave-status=""></p>
  );
}

/** The answer of a save that went through: the status line's text. */
export function AutosaveSaved() {
  return <span class="text-success">{t('SAVED')}</span>;
}
