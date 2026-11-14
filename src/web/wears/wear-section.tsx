import {
  AWAY_REASONS,
  dirtyCopies,
  washLimit,
} from '../../wardrobe/availability';
import { perWearCost, totalCost } from '../../wardrobe/insights';
import { AutosaveForm } from '../autosave';
import type { IsoDate } from '../../calendar-date';
import { DayTime } from '../day-time';
import { t, tAround } from '../i18n';
import { StyleThisLink } from '../styling/style-this';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import type { GarmentDetail } from '../wardrobe/queries';
import { garmentUrl } from '../wardrobe/urls';
import { CARE_NOTE_MAX } from '../wardrobe/garment-input';
import { markLabel } from '../layout/garment-mark';
import { queuedTarget } from '../../offline-writes';
import {
  OutboxAlternate,
  OutboxPending,
  outboxRegion,
  queueForm,
} from '../outbox';
import type { WearGarment, WearSummary } from './queries';

/** What Wore today and Washed answer: the wear line and the buttons. */
const WEAR_STATUS_ID = 'garment-wear-status';

/** The tap a wear status answers: Wore today (or its undo), or Washed. */
export type WearTap = 'wear' | 'wash';

/**
 * Each tap's button keeps one id in every state (Wore today and its undo
 * share theirs), so htmx gives focus back to the replacement after the swap
 * (#679): it refocuses the element with the focused one's id.
 */
const TAP_BUTTON_ID: Record<WearTap, (garmentId: number) => string> = {
  wear: (garmentId) => `garment-${garmentId}-wore-today`,
  wash: (garmentId) => `garment-${garmentId}-washed`,
};

/** What the section shows: the garment's wash state and away, and its wears. */
export interface WearPanel {
  summary: WearSummary;
  /**
   * The household's date a live answer was rendered on (APP_TIMEZONE): set
   * on the htmx answer of Wore today and Washed alone, never on the page,
   * which must read the same tomorrow (#708). Without it the page's script
   * takes the day from the copy's stamp (views/assets/page-day.ts).
   */
  answeredOn?: IsoDate;
}

// Wore today and Washed answer the wear status (htmx) or, posted without
// script, the garment page (303); never "where it is" (WhereaboutsSection),
// which is autosaved: a save queued there would die with a swap. Offline
// both queue (#178, src/web/outbox.tsx): each is a region with its other
// state beside it, and the wear line's counts stay the server's until the
// sync.
const SWAP = {
  'hx-target': `#${WEAR_STATUS_ID}`,
  'hx-swap': 'outerHTML',
} as const;

/**
 * The garment page's wear line and primary actions (the owner's alone:
 * wears and washes are their own records, like the calendar): "Worn 12
 * times · 2 since washed · last worn yesterday · $4.00 a wear", the wash
 * state ("2 of 3 need a wash"), then Style this, Wore today (or its undo,
 * the same day) and Washed. POST /wardrobe/:id/wear and /washed answer
 * `WearStatus` (src/web/wears/routes.tsx). Where it is sits lower on the
 * page, with the condition (WhereaboutsSection).
 */
export function WearSection(props: { garment: WearGarment; panel: WearPanel }) {
  return (
    <section id="garment-wear" aria-label={t('wear.SECTION')}>
      <WearStatus garment={props.garment} panel={props.panel} />
    </section>
  );
}

/**
 * The wear line, the wash state and the row of primary actions. `after` is
 * the tap this answers: when its button is gone from the answer (Washed,
 * once nothing is worn since), focus moves to the wear line, which then
 * says what changed, rather than dropping to the page's start.
 */
export function WearStatus(props: {
  garment: WearGarment;
  panel: WearPanel;
  after?: WearTap;
}) {
  const { garment, panel } = props;
  const { summary } = panel;
  const limit = washLimit(garment.category, garment.washAfterWears);
  const dirty = dirtyCopies({
    quantity: garment.quantity,
    limit,
    wearsSinceWash: summary.sinceWash,
  });
  const needsWash = limit !== null && dirty > 0;
  const shows = tapsShown(garment, summary);
  const lostFocus = props.after !== undefined && !shows[props.after];
  return (
    <div
      id={WEAR_STATUS_ID}
      class="flex flex-col gap-3"
      tabindex={lostFocus ? -1 : undefined}
      autofocus={lostFocus}
      data-as-of-day={panel.answeredOn}
    >
      <div class="flex flex-col gap-1">
        <p class="text-sm">
          <WornLine garment={garment} summary={summary} />
        </p>
        {(needsWash || garment.lastWashedOn) && (
          <p class="flex flex-wrap items-center gap-2 text-xs text-muted">
            {needsWash && (
              <WashState dirty={dirty} quantity={garment.quantity} />
            )}
            {garment.lastWashedOn && (
              <span>
                <Around text="wear.LAST_WASHED" day={garment.lastWashedOn} />
              </span>
            )}
          </p>
        )}
      </div>
      <div class="flex flex-wrap gap-2">
        {/* Styling takes closet garments only, never an archived one. */}
        {garment.status === 'closet' && (
          <StyleThisLink garmentId={garment.id} viewOwner={undefined} />
        )}
        <WoreToday garment={garment} summary={summary} />
        {shows.wash && <Washed garment={garment} />}
      </div>
    </div>
  );
}

/**
 * Which taps the row offers: Wore today always (the page's script swaps it
 * for the calendar's badge on a day a worn entry wore it, page-day.ts),
 * Washed once something is worn since a wash that is due. The one decision:
 * the row renders from it and WearStatus's focus follows it, so a button is
 * never gone while focus waits on it.
 */
export function tapsShown(
  garment: Pick<WearGarment, 'category' | 'washAfterWears'>,
  summary: Pick<WearSummary, 'sinceWash'>,
): Record<WearTap, boolean> {
  return {
    wear: true,
    wash:
      summary.sinceWash > 0 &&
      washLimit(garment.category, garment.washAfterWears) !== null,
  };
}

/**
 * "Worn 12 times · 2 since washed · last worn yesterday · $4.00 a wear";
 * "Not worn yet". The cost is the insights' rule (totalCost, repairs
 * included, over perWearCost), shown only with a price and a wear. The day
 * is the client's to word (DayTime).
 */
function WornLine(props: { garment: WearGarment; summary: WearSummary }) {
  const { garment, summary } = props;
  if (summary.worn === 0 || summary.lastWorn === null) {
    return <>{t('wear.NOT_WORN')}</>;
  }
  const cost = totalCost({
    price: garment.price,
    quantity: garment.quantity,
    repairCost: summary.repairCost,
  });
  const perWear = cost === null ? null : perWearCost(cost, summary.worn);
  const counts = [
    summary.worn === 1
      ? t('wear.WORN_ONCE')
      : t('wear.WORN_TIMES', { count: summary.worn }),
    t('wear.SINCE_WASH', { count: summary.sinceWash }),
  ].join(' · ');
  return (
    <>
      {counts} · <Around text="wear.LAST_WORN" day={summary.lastWorn} />
      {perWear !== null &&
        ` · ${t('wear.PER_WEAR', { cost: priceLabel(perWear) })}`}
    </>
  );
}

/** A "{when}" string with its day as a DayTime. */
function Around(props: {
  text: 'wear.LAST_WORN' | 'wear.LAST_WASHED';
  day: IsoDate;
}) {
  const [before, after] = tAround(props.text, 'when');
  return (
    <>
      {before}
      <DayTime day={props.day} kind="relative" />
      {after}
    </>
  );
}

/** "Needs a wash", or "2 of 3 need a wash" for multiples. */
function WashState(props: { dirty: number; quantity: number }) {
  return (
    <span class="badge badge-info">
      {props.quantity > 1
        ? t('wear.COPIES_NEED_WASH', {
            dirty: props.dirty,
            quantity: props.quantity,
          })
        : t('wear.NEEDS_WASH')}
    </span>
  );
}

/**
 * Wore today: logs one wear of this garment alone. Once logged, the same
 * day, it offers the undo instead; a worn calendar entry that day says so
 * and needs no second wear (they would count once anyway: distinct days).
 * Not WornControl (worn-control.tsx), which marks a calendar entry: this is
 * a garment's own record, in the same words ("Wore …", "✓ Worn …", Undo).
 *
 * Which of the three shows is the page's script's (#708,
 * views/assets/page-day.ts): the server renders Wore today with the undo in
 * the template and the badge hidden, and names the last day worn and how
 * (`data-worn-on`, `data-worn-by`); the script shows the undo or the badge
 * when that day is the page's. The region's key has no day either: the
 * outbox adds the page's, and refuses a tap on a page whose day is not the
 * tap's (its state is that day's).
 */
function WoreToday(props: { garment: WearGarment; summary: WearSummary }) {
  const { garment, summary } = props;
  // The badge is the region's sibling: the outbox's flip swaps every child
  // of a region with its template's.
  return (
    <>
      <div
        class="flex flex-1 flex-col items-center gap-1"
        {...outboxRegion(
          queuedTarget('wear', garment.id),
          garmentName(garment),
        )}
        data-worn-on={summary.lastWorn ?? undefined}
        data-worn-by={summary.lastWornBy ?? undefined}
      >
        <WoreTodayForm garmentId={garment.id} worn={false} />
        <OutboxAlternate>
          <WoreTodayForm garmentId={garment.id} worn />
        </OutboxAlternate>
        <OutboxPending />
      </div>
      <span
        class="badge badge-success self-center"
        hidden
        data-worn-by-entry=""
      >
        ✓ {t('wear.WORN_TODAY_CALENDAR')}
      </span>
    </>
  );
}

/** Wore today, or its undo once worn: each posts the state it asks for. */
function WoreTodayForm(props: { garmentId: number; worn: boolean }) {
  const url = garmentUrl(props.garmentId, undefined, '/wear');
  return (
    <form
      method="post"
      action={url}
      hx-post={url}
      class="flex w-full"
      {...SWAP}
      {...queueForm('wear')}
    >
      <input type="hidden" name="worn" value={props.worn ? '0' : '1'} />
      <button
        type="submit"
        id={TAP_BUTTON_ID.wear(props.garmentId)}
        class={`btn flex-1 whitespace-nowrap ${props.worn ? 'btn-ghost' : 'btn-outline'}`}
      >
        {props.worn ? t('wear.UNDO_WORE_TODAY') : t('wear.WORE_TODAY')}
      </button>
    </form>
  );
}

/**
 * Washed: every copy, today. It has no undo, so queued offline its other
 * state is only what the sync will show, "✓ Washed".
 */
function Washed(props: { garment: WearGarment }) {
  const { garment } = props;
  const url = garmentUrl(garment.id, undefined, '/washed');
  return (
    <div
      class="flex flex-1 flex-col items-center gap-1"
      {...outboxRegion(queuedTarget('wash', garment.id), garmentName(garment))}
    >
      <form
        method="post"
        action={url}
        hx-post={url}
        class="flex w-full"
        {...SWAP}
        {...queueForm('wash')}
      >
        <button
          type="submit"
          id={TAP_BUTTON_ID.wash(garment.id)}
          class="btn btn-outline flex-1"
        >
          {t('wear.WASHED')}
        </button>
      </form>
      <OutboxAlternate>
        <span class="badge badge-success self-center">
          ✓ {t('wear.WASHED')}
        </span>
      </OutboxAlternate>
      <OutboxPending />
    </div>
  );
}

/** What the outbox's notices call the garment. */
function garmentName(garment: Pick<WearGarment, 'name' | 'category'>): string {
  return garment.name ?? categoryLabel(garment.category);
}

/**
 * Where it is: in the closet, lent or at the repair shop, and a note (who
 * has it, which shop), shown by CSS while a reason is checked, so it is
 * there the moment one is tapped. Saved on every change like the capsule
 * toggles (`AutosaveForm`); without script, Save. The owner's alone, like
 * the wears; POST /wardrobe/:id/away answers the form's status line.
 */
export function WhereaboutsSection(props: {
  garment: Pick<GarmentDetail, 'id' | 'away' | 'awayNote'>;
}) {
  const { garment } = props;
  return (
    <section id="garment-away" aria-labelledby="garment-away-title">
      <h2 id="garment-away-title" class="text-sm text-muted mb-2">
        {t('wear.WHERE')}
      </h2>
      <AutosaveForm
        action={garmentUrl(garment.id, undefined, '/away')}
        native
        class="group flex flex-col gap-2"
      >
        <div class="flex flex-wrap gap-2">
          <input
            type="radio"
            name="away"
            value=""
            class="btn btn-sm rounded-full"
            aria-label={t('wear.IN_CLOSET')}
            checked={garment.away === null}
            data-no-note=""
          />
          {AWAY_REASONS.map((reason) => (
            <input
              type="radio"
              name="away"
              value={reason}
              class="btn btn-sm rounded-full checked:btn-warning"
              aria-label={markLabel(`away:${reason}`)}
              checked={garment.away === reason}
            />
          ))}
        </div>
        {/* Posted in the closet too; the server keeps a note only with a
            reason (the away route). */}
        <input
          type="text"
          name="awayNote"
          value={garment.awayNote ?? ''}
          maxlength={CARE_NOTE_MAX}
          placeholder={t('wear.AWAY_NOTE_PLACEHOLDER')}
          aria-label={t('wear.AWAY_NOTE')}
          class="input input-bordered input-sm w-full group-has-[[data-no-note]:checked]:hidden"
        />
        <noscript>
          <button type="submit" class="btn btn-sm self-start">
            {t('SAVE')}
          </button>
        </noscript>
      </AutosaveForm>
    </section>
  );
}
