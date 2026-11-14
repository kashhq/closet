import type { Child } from 'hono/jsx';
import type { QueueableKind, QueuedTarget } from '../offline-writes';
import { t } from './i18n';
import { ClockIcon } from './layout/parts';

/**
 * The markup of the writes the installed app queues offline (#178, plan
 * section 5; the kinds in src/offline-writes.ts). The page's outbox
 * (views/assets/outbox.ts) only reads it: which state to show is drawn here,
 * never by script.
 *
 * - A queueable form carries `data-offline-queue="<kind>"` instead of
 *   `data-needs-network` (`queueForm`), so connectivity.js leaves it enabled
 *   offline and the outbox takes its submit.
 * - A region (`outboxRegion`) is one record: its key, the path it replays
 *   to and the name the notices give it. Around a form it is that form's
 *   write; inside a form (the laundry's rows, the packing lists' rows) each
 *   row is one, posted by itself.
 * - `OutboxAlternate` holds the control's other state (Wore today ↔ Undo,
 *   Wore it ↔ ✓ Worn), which the outbox swaps in when it queues the tap and
 *   again when a cached page reopens with the record waiting; a checkbox is
 *   its own other state.
 * - `OutboxPending` is the region's "Waiting to sync", shown by main.css
 *   while the outbox marks the region `data-outbox="pending"`.
 */

/** The attributes of a form whose write queues offline. */
export function queueForm(kind: QueueableKind) {
  return { 'data-offline-queue': kind } as const;
}

/**
 * A queued write's region. It names no day: a page reads the same from one
 * day to the next (#708). Wore today's day is the page's, which the outbox
 * reads from the copy's stamp (views/assets/page-day.ts).
 */
export function outboxRegion(target: QueuedTarget, label: string) {
  return {
    'data-outbox-key': target.key,
    'data-outbox-path': target.path,
    'data-outbox-label': label,
  } as const;
}

/** The region's other state, inert until the outbox swaps it in. */
export function OutboxAlternate(props: { children: Child }) {
  return <template data-outbox-state="">{props.children}</template>;
}

/** "Waiting to sync", hidden unless the region is pending (main.css). */
export function OutboxPending(props: { class?: string }) {
  return (
    <span
      class={`items-center gap-1 text-xs text-muted whitespace-nowrap ${props.class ?? ''}`}
      data-outbox-chip=""
    >
      <ClockIcon class="size-3.5 shrink-0" />
      {t('outbox.WAITING')}
    </span>
  );
}
