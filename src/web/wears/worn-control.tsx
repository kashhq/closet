import { queuedTarget } from '../../offline-writes';
import { PostForm } from '../form';
import { t } from '../i18n';
import {
  OutboxAlternate,
  OutboxPending,
  outboxRegion,
  queueForm,
} from '../outbox';

/** POST /calendar/:id/worn (calendar routes): the one write behind every control. */
function entryWornUrl(entryId: number): string {
  return `/calendar/${entryId}/worn`;
}

/**
 * The entry's button, "Wore it" or "Worn?" and its Undo alike: one id in
 * both states, so htmx gives focus back to the replacement after the
 * calendar's in-place swap (#679), and a page landing from a tap can name it.
 */
function entryWornButtonId(entryId: number): string {
  return `entry-${entryId}-worn`;
}

type WornControlTarget =
  /**
   * An entry on the calendar, worn or not: marked and unmarked in place, and
   * queued offline. `label` (the outfit's name) is what the outbox's notices
   * call the mark.
   */
  | { worn: boolean; entryId: number; label: string; createUrl?: undefined }
  /**
   * Not on the calendar yet (a trip's outfit): "Wore it" posts to the
   * caller's create-and-wear route, which plans it today and marks it worn.
   */
  | { worn: false; entryId?: undefined; createUrl: string };

export type WornControlProps = WornControlTarget & {
  /** `pill`: a dense row (the calendar, a trip); `button`: a hero card (Today). */
  size: 'pill' | 'button';
  /**
   * Swapped in place by htmx rather than a native post the page comes back
   * from whole. Only the calendar's pill, inside an OccasionRow: its marks,
   * label and Change read the worn state, so POST /calendar/:id/worn answers
   * htmx with the whole row and the control targets it. Today's Change goes
   * once worn and a trip's create-and-wear route answers only a redirect,
   * so those reload.
   */
  inPlace?: boolean;
  /** A day before today: asks ("Worn?") rather than tells ("Wore it"). */
  past?: boolean;
  /** Where a native post comes back to (safeReturnTo, on the worn route). */
  returnTo: string;
  /**
   * The page lands from a tap on this entry (Today after "Wear this"):
   * focus starts on its button, where the tap left it (#679).
   */
  autofocus?: boolean;
};

type Look = Pick<WornControlProps, 'size' | 'past'>;

/**
 * Marking an outfit worn, the same words, look and undo wherever it is
 * tapped (#359): not worn, "Wore it" ("Worn?" on a past day); worn, a
 * success badge "✓ Worn" and a quiet Undo. Every state posts the state it
 * asks for, so a double tap or a replayed post marks once (setEntryWorn).
 * On an entry it queues offline (#178, src/web/outbox.tsx), its other state
 * beside it; the create-and-wear route plans an entry, so it needs the
 * network (data-needs-network). Used by the calendar's OccasionRow and its
 * worn route, Today's PlannedCard and a trip's outfit rows; a garment's own
 * "Wore today" (wear-section.tsx) is a different record (one garment, no
 * entry) and stays its own control.
 */
export function WornControl(props: WornControlProps) {
  if (props.createUrl !== undefined) {
    return (
      <PostForm action={props.createUrl} class={layoutClass(false, props.size)}>
        <WornBody worn={false} look={props} />
      </PostForm>
    );
  }
  const state = (worn: boolean, autofocus: boolean) => (
    <EntryWornForm
      entryId={props.entryId}
      worn={worn}
      inPlace={props.inPlace === true}
      returnTo={props.returnTo}
      look={props}
      autofocus={autofocus}
    />
  );
  return (
    <div
      class={`flex items-center gap-1 ${props.size === 'pill' ? 'shrink-0' : 'flex-1'}`}
      {...outboxRegion(queuedTarget('entry', props.entryId), props.label)}
    >
      {state(props.worn, props.autofocus === true)}
      <OutboxAlternate>{state(!props.worn, false)}</OutboxAlternate>
      <OutboxPending />
    </div>
  );
}

/** One state of an entry's control: it posts the other. */
function EntryWornForm(props: {
  entryId: number;
  worn: boolean;
  inPlace: boolean;
  returnTo: string;
  look: Look;
  autofocus: boolean;
}) {
  const action = entryWornUrl(props.entryId);
  const layout = layoutClass(props.worn, props.look.size);
  const children = (
    <>
      <input type="hidden" name="worn" value={props.worn ? '0' : '1'} />
      <input type="hidden" name="returnTo" value={props.returnTo} />
      <WornBody
        worn={props.worn}
        look={props.look}
        button={{
          id: entryWornButtonId(props.entryId),
          autofocus: props.autofocus,
        }}
      />
    </>
  );
  if (props.inPlace) {
    return (
      <form
        method="post"
        action={action}
        class={layout}
        hx-post={action}
        hx-target="closest [data-occasion]"
        hx-swap="outerHTML"
        {...queueForm('entry')}
      >
        {children}
      </form>
    );
  }
  return (
    <PostForm action={action} class={layout} offlineQueue="entry">
      {children}
    </PostForm>
  );
}

/** The entry's submit button's identity; the create-and-wear form has none. */
interface WornButton {
  id: string;
  autofocus: boolean;
}

function WornBody(props: { worn: boolean; look: Look; button?: WornButton }) {
  const { size, past } = props.look;
  const { button } = props;
  if (props.worn) {
    return (
      <>
        <span
          class={`badge badge-success gap-1 whitespace-nowrap ${size === 'pill' ? 'badge-sm' : ''}`}
          data-worn=""
        >
          ✓ {t('wear.WORN')}
        </span>
        <button
          type="submit"
          id={button?.id}
          autofocus={button?.autofocus}
          class="btn btn-ghost btn-xs font-normal text-muted hover:text-base-content"
        >
          {t('wear.UNDO_WORN')}
        </button>
      </>
    );
  }
  return (
    <button
      type="submit"
      id={button?.id}
      autofocus={button?.autofocus}
      class={wearClass(size, past === true)}
    >
      {past ? t('wear.WORN_ASK') : t('wear.WORE_IT')}
    </button>
  );
}

function layoutClass(worn: boolean, size: WornControlProps['size']): string {
  if (worn) return 'flex items-center gap-1 shrink-0';
  return size === 'pill' ? 'shrink-0' : 'flex flex-1';
}

function wearClass(size: WornControlProps['size'], past: boolean): string {
  if (size === 'button') {
    return 'btn btn-primary btn-sm flex-1 whitespace-nowrap';
  }
  // The pill: a past day's question stays quiet beside a dense row; today's
  // verb is a call to act.
  return past
    ? 'btn btn-ghost btn-xs rounded-full font-normal italic text-muted hover:text-base-content'
    : 'btn btn-outline btn-xs rounded-full';
}
