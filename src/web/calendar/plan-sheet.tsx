import {
  DEFAULT_OCCASION,
  type Occasion,
  OCCASIONS,
} from '../../wardrobe/occasions';
import { IDEAS_PATH } from '../gallery/urls';
import { t } from '../i18n';
import { Sheet, sheetOpener } from '../layout/sheet';
import { destinationTarget } from '../outfits/destination';
import { SAVED_PATH } from '../outfits/urls';
import { STYLING_PATH } from '../styling/urls';
import type { IsoDate } from '../../calendar-date';
import { dayLabel, occasionLabel } from '../date-labels';

/**
 * A day's "+ Plan" sheet (R6; docs/plans/2026-09-26-redesign.md, Calendar):
 * the occasion, then the three ways to an outfit (section 1): choose from
 * Ideas (#9), pick a saved outfit (the Outfits page's Saved tab picking for
 * the day, R5) or style a new one (Styling, #42). One GET form whose buttons each name their page
 * (`formaction`), so every way carries `?for=day:D&occasion=O` and comes
 * back to the day, and the occasion needs no script: the form posts the
 * checked radio. Static per day, so `/calendar` stays byte-stable.
 *
 * Opened by the day's open template slots (OpenSlotRow) or, on a day with
 * none, its "+ Plan" (all day): each carries `planSheetOpener`, whose
 * `data-plan` names the occasion's radio, which the one-line handler checks
 * before confirm-sheet.js opens the day's sheet.
 */

const CHOOSE_OCCASION =
  'document.getElementById(this.dataset.plan).checked = true';

/** `day`'s sheet's id. */
export function planSheetId(day: IsoDate): string {
  return `plan-sheet-${day}`;
}

/** What a control opening `day`'s sheet on `occasion` carries. */
export function planSheetOpener(day: IsoDate, occasion: Occasion) {
  return {
    ...sheetOpener(planSheetId(day)),
    'data-plan': planSheetChoice(day, occasion),
    onclick: CHOOSE_OCCASION,
  } as const;
}

/** The radio of `occasion` in `day`'s sheet: what an opener's `data-plan` names. */
function planSheetChoice(day: IsoDate, occasion: Occasion): string {
  return `plan-${day}-${occasion}`;
}

export function PlanSheet({ day }: { day: IsoDate }) {
  const titleId = `${planSheetId(day)}-title`;
  return (
    <Sheet
      id={planSheetId(day)}
      kind="choice"
      labelledBy={titleId}
      gap={4}
      dismiss="cancel"
    >
      <h2 id={titleId} class="font-semibold text-lg">
        {t('calendar.PLAN_SHEET_TITLE', { day: dayLabel(day) })}
      </h2>
      {/* A GET into Ideas whose occasion is the user's radio choice, so
            DestinationFields (which posts a decided destination) cannot
            carry it: the one form writing the destination's field names
            itself; the `for` value is still destinationTarget's. */}
      <form method="get" action={IDEAS_PATH} class="flex flex-col gap-4">
        <input
          type="hidden"
          name="for"
          value={destinationTarget({
            kind: 'day',
            day,
            occasion: DEFAULT_OCCASION,
          })}
        />
        <fieldset>
          <legend class="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
            {t('CALENDAR_PLAN_OCCASION')}
          </legend>
          <div class="chip-row">
            {OCCASIONS.map((occasion) => (
              <input
                type="radio"
                name="occasion"
                value={occasion}
                id={planSheetChoice(day, occasion)}
                class="btn btn-sm rounded-full checked:btn-primary"
                aria-label={occasionLabel(occasion)}
                checked={occasion === DEFAULT_OCCASION}
              />
            ))}
          </div>
        </fieldset>
        <div class="flex flex-col gap-2">
          <button
            type="submit"
            formaction={IDEAS_PATH}
            class="btn btn-primary"
            data-plan-ideas=""
          >
            {t('gallery.PLAN_IDEAS')}
          </button>
          <button
            type="submit"
            formaction={SAVED_PATH}
            class="btn btn-outline"
            data-plan-saved=""
          >
            {t('calendar.PLAN_SAVED')}
          </button>
          <button
            type="submit"
            formaction={STYLING_PATH}
            class="btn btn-outline"
            data-plan-styling=""
          >
            {t('CALENDAR_PLAN_BUILD')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
