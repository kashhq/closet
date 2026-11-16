import type { Occasion } from '../../wardrobe/occasions';
import { AgentBadge } from '../agent-badge';
import { t } from '../i18n';
import { OutfitCollage, outfitLabel } from '../outfits/collage';
import { EntrySelfie } from '../selfies/views';
import { WornControl } from '../wears/worn-control';
import { stylingUrl } from '../styling/urls';
import type { IsoDate } from '../../calendar-date';
import type { CalendarEntry, EntryView } from './calendar-view';
import { occasionLabel } from '../date-labels';
import { planSheetOpener } from './plan-sheet';
import { removalAsksFirst } from './removal';
import { dayUrl, planPageUrl } from './urls';

/**
 * One calendar entry as a row of its day's agenda: the occasion's label
 * (Auto while "Plan my week"'s pick stands untouched, #16) and the Change
 * menu (another outfit in its place, #69, not once worn; and unscheduling
 * it, #636); then the
 * outfit as a small OutfitCollage with its name, a kept outfit's only
 * (#659: a one-off's name is its garments' list; tap to edit it in
 * Styling), its selfie (or the buttons that take one, #19) and the worn
 * pill. The one way a day's entries are drawn: the week agenda stacks them
 * in occasion order, and Today (#15) draws the same entries larger through
 * the same worn route (docs/plans/2026-09-26-redesign.md, section 5).
 * `data-occasion` is what the specs read the order from, and what the worn
 * control swaps: POST /calendar/:id/worn answers with this row whole.
 * From lg (#467) it is a card in its column of the week grid: the collage
 * at the column's width with the name under it, the selfie and pill
 * wrapping below; the same markup, so the worn swap keeps the look.
 */
export function OccasionRow(props: {
  entry: EntryView;
  /** The day is after today: no worn pill (setEntryWorn refuses it). */
  future: boolean;
  /** The day is before today: the pill asks "Worn?" rather than "Wore it". */
  past: boolean;
}) {
  const { entry, future, past } = props;
  const name = entry.outfit.name || t('UNTITLED_OUTFIT');
  // Back from Styling (#42) and from a selfie lands on this entry's day
  // (`#day-D`), not the top of its week: a later day is a long scroll down.
  const back = dayUrl(entry.day);
  const editUrl = stylingUrl({ outfitId: entry.outfit.id, returnTo: back });
  return (
    <div
      class="flex flex-col gap-1 py-2 lg:p-2 lg:rounded-box lg:border lg:border-base-300"
      data-occasion={entry.occasion}
    >
      <div class="flex items-center gap-1 min-h-6 lg:flex-wrap">
        <OccasionLabel occasion={entry.occasion} />
        {entry.plannedBy === 'auto' && (
          <span
            class="badge badge-ghost badge-xs"
            title={t('weekPlan.AUTO_TITLE')}
            data-auto
          >
            {t('weekPlan.AUTO')}
          </span>
        )}
        <AgentBadge agent={entry.agent} />
        <EntryMenu entry={entry} name={name} />
      </div>
      <div class="flex items-center gap-2 lg:flex-wrap">
        <a
          href={editUrl}
          class="flex items-center gap-3 min-w-0 flex-1 lg:basis-full lg:flex-col lg:items-stretch lg:gap-1"
          aria-label={outfitLabel(name, entry.pieces)}
        >
          <span class="w-16 shrink-0 lg:w-full">
            <OutfitCollage garments={entry.pieces} size="cell" decorative />
          </span>
          {entry.outfit.kept && (
            <span class="text-sm font-medium line-clamp-2">{name}</span>
          )}
        </a>
        <EntrySelfie
          entryId={entry.id}
          day={entry.day}
          selfie={entry.selfie}
          canTake={!future}
          returnTo={back}
          size="row"
        />
        {/* A planned day has no pill (it cannot be worn yet), unless an
            entry there was marked before that rule, which can still be
            unmarked. */}
        {(!future || entry.worn) && (
          <WornControl
            entryId={entry.id}
            worn={entry.worn}
            label={name}
            size="pill"
            inPlace
            past={past}
            returnTo={back}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A template occasion the day has no outfit for yet (#16), as a row that
 * opens the day's "+ Plan" sheet with the occasion chosen. From lg a
 * dashed card in its cell of the week grid.
 */
export function OpenSlotRow(props: { day: IsoDate; occasion: Occasion }) {
  const { day, occasion } = props;
  return (
    <button
      type="button"
      class="flex items-center gap-3 w-full py-2 text-start lg:flex-col lg:items-start lg:gap-1 lg:p-2 lg:rounded-box lg:border lg:border-dashed lg:border-base-300 lg:hover:bg-base-200"
      {...planSheetOpener(day, occasion)}
      data-open-slot={occasion}
    >
      <span class="w-16 h-12 shrink-0 rounded-field border border-dashed border-base-300 lg:hidden"></span>
      <OccasionLabel occasion={occasion} />
      <span class="ms-auto text-sm text-muted lg:ms-0">
        + {t('CALENDAR_PLAN')}
      </span>
    </button>
  );
}

function OccasionLabel({ occasion }: { occasion: Occasion }) {
  return (
    <span class="text-xs font-semibold uppercase tracking-wide text-muted">
      {occasionLabel(occasion)}
    </span>
  );
}

/**
 * The row's one menu, at its end (#636): a phone row carries two direct
 * actions (this and the worn pill), not a 24 px × above the pill's Undo.
 * "Change outfit" (not once worn: a worn entry is the record of that day
 * and keeps its outfit), then Remove: at once with Undo in the toast
 * when that restores it exactly, else asked first by the confirm sheet
 * (removalAsksFirst, #686); htmx swaps in the week it was on. Buttons only: a form inside a daisyUI menu item loses
 * its styling (the outfit page's ⋯ menu).
 */
function EntryMenu(props: { entry: CalendarEntry; name: string }) {
  const { entry } = props;
  const remove = `/calendar/${entry.id}/delete`;
  const asks = removalAsksFirst({
    ...entry,
    takesOutfit: entry.outfit.createdOneOff,
  });
  return (
    <details class="dropdown dropdown-end ms-auto" data-entry-menu={entry.id}>
      <summary
        class="btn btn-ghost btn-xs font-normal text-muted"
        aria-label={t('changeEntry.ACTION_LABEL', { name: props.name })}
      >
        {t('changeEntry.ACTION')}
      </summary>
      <ul class="menu dropdown-content bg-base-100 rounded-box border border-base-300 z-20 w-56 p-2">
        {!entry.worn && (
          <li>
            <a
              href={planPageUrl({
                kind: 'day',
                day: entry.day,
                occasion: entry.occasion,
                replace: entry.id,
              })}
              data-change-entry={entry.id}
            >
              {t('changeEntry.TITLE')}
            </a>
          </li>
        )}
        <li>
          <button
            type="button"
            class="text-error"
            hx-post={remove}
            hx-vals={JSON.stringify({
              week: entry.day,
              // The row asks in the sheet, so its yes is the confirmation (#686).
              ...(asks && { confirmed: '1' }),
            })}
            hx-confirm={asks ? t('CALENDAR_DELETE_CONFIRM') : undefined}
            data-needs-network=""
            data-remove-entry={entry.id}
          >
            {t('CALENDAR_REMOVE')}
          </button>
        </li>
      </ul>
    </details>
  );
}
