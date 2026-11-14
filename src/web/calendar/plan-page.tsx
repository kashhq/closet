import { type Occasion, OCCASIONS } from '../../wardrobe/occasions';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { ideasUrl } from '../gallery/urls';
import type { GarmentOutfit } from '../outfits/queries';
import type { OutfitList } from '../outfits/outfit-list';
import {
  SavedOutfitButtons,
  SavedOutfitPicker,
} from '../outfits/saved-outfit-button';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import type { IsoDate } from '../../calendar-date';
import { type DayChoice, plannedNote } from './day-choice';
import { dayLabel, occasionLabel } from '../date-labels';
import type { DayDestination } from '../outfits/destination';
import { dayUrl, planMoreUrl, planPageUrl } from './urls';

/** The day's DayChoice (what is on it, the entry `replace` names). */
export interface PlanModel extends DayChoice {
  day: IsoDate;
  occasion: Occasion;
  /** A page of the owner's own outfits of `list`, newest first (savedOutfitsSql, #660). */
  outfits: GarmentOutfit[];
  /** The id the next page starts below; null on the last. */
  next: number | null;
  /** `?show=` (#659): the kept outfits, or the one-offs. */
  list: OutfitList;
}

/**
 * GET /calendar/plan?for=day:D&occasion=O: plan one more outfit on a day.
 * The occasion first (links, so the choice is the URL's and every way on
 * carries it), then the three ways to an outfit: choose a generated idea
 * (the gallery's Ideas with the same `?for=`, #9), style a new one
 * (Styling with the same `?for=`, #42) or pick a saved one (POST
 * /calendar). The week's "+ Plan" sheet (plan-sheet.tsx, R6) offers the
 * same three ways; its "Pick a saved outfit" is the Saved tab with `?for=`
 * (R5). This page is Change's (#69) and the links cached before R6.
 *
 * Opened to change an entry (`&replace=`, the calendar row's Change, #69),
 * it is "Change outfit": the occasion is the entry's (no chips), and ideas,
 * Styling and saved outfits all carry `replace`, so the choice takes the
 * entry's place (replaceEntryOutfit).
 */
export function PlanPage(props: { ctx: ViewContext; model: PlanModel }) {
  const { ctx, model } = props;
  const day = {
    kind: 'day',
    day: model.day,
    occasion: model.occasion,
  } as const;
  // A worn entry keeps its outfit: the page plans one more beside it.
  const changing =
    model.replacing?.worn === false ? model.replacing : undefined;
  const destination = changing ? { ...day, replace: changing.entryId } : day;
  const build = stylingUrl({ destination });
  const ideas = ideasUrl({ destination });
  const title = changing ? t('changeEntry.TITLE') : t('CALENDAR_PLAN_TITLE');
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={dayUrl(model.day)} />
      <main class="p-4 pt-20 pb-24 w-full sm:max-w-lg sm:mx-auto flex flex-col gap-5">
        <PlanHeading model={model} changing={changing} />
        {!changing && <OccasionChips day={model.day} chosen={model.occasion} />}

        <div class="flex flex-col gap-2">
          <a href={ideas} class="btn btn-primary w-full" data-plan-ideas="">
            {t('gallery.PLAN_IDEAS')}
          </a>
          <a href={build} class="btn btn-outline w-full" data-plan-styling="">
            + {t('CALENDAR_PLAN_BUILD')}
          </a>
        </div>

        <SavedOutfitPicker
          heading={t('CALENDAR_PLAN_SAVED')}
          action="/calendar"
          list={model.list}
          href={planPageUrl(destination)}
          outfits={model.outfits}
          noteOf={(outfit) => plannedNote(model, outfit.id)}
          more={moreUrl(destination, model.list, model.next)}
        >
          <input type="hidden" name="date" value={model.day} />
          <input type="hidden" name="occasion" value={model.occasion} />
          <input type="hidden" name="week" value={model.day} />
          {changing && (
            <input
              type="hidden"
              name="replace"
              value={String(changing.entryId)}
            />
          )}
        </SavedOutfitPicker>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** The next page's address, carrying the entry being changed: its buttons are the same form's. */
function moreUrl(
  destination: DayDestination,
  list: OutfitList,
  next: number | null,
): string | undefined {
  return next === null ? undefined : planMoreUrl(destination, list, next);
}

/**
 * A next page of the plan page's saved outfits (GET /calendar/plan/more,
 * #660): its buttons and the next sentinel, landing in the page's form.
 */
export function PlanOutfits(props: {
  destination: DayDestination;
  list: OutfitList;
  outfits: GarmentOutfit[];
  next: number | null;
  choice: DayChoice;
}) {
  return (
    <SavedOutfitButtons
      outfits={props.outfits}
      noteOf={(outfit) => plannedNote(props.choice, outfit.id)}
      more={moreUrl(props.destination, props.list, props.next)}
    />
  );
}

type Replacing = NonNullable<PlanModel['replacing']>;

/**
 * Under the app bar's title: the day (and, when changing an entry, its
 * occasion and outfit), and why a worn entry is not being changed.
 */
function PlanHeading(props: {
  model: PlanModel;
  changing: Replacing | undefined;
}) {
  const { model, changing } = props;
  const worn = model.replacing?.worn ? model.replacing : undefined;
  return (
    <>
      <div class="min-w-0">
        <p class="text-sm text-muted">
          {dayLabel(model.day)}
          {changing && <> · {occasionLabel(model.occasion)}</>}
        </p>
        {changing && (
          <p class="text-sm truncate" data-replacing={changing.entryId}>
            {t('changeEntry.INSTEAD_OF', { name: outfitName(changing) })}
          </p>
        )}
      </div>
      {worn && (
        <p class="alert alert-info alert-soft py-2 text-sm" role="note">
          {t('changeEntry.WORN_NOTE', { name: outfitName(worn) })}
        </p>
      )}
    </>
  );
}

function outfitName(replacing: Replacing): string {
  return replacing.outfitName || t('UNTITLED_OUTFIT');
}

/** The occasion as links: the choice lives in the URL. */
function OccasionChips(props: { day: IsoDate; chosen: Occasion }) {
  return (
    <nav aria-label={t('OCCASION')}>
      <p class="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
        {t('CALENDAR_PLAN_OCCASION')}
      </p>
      <ul class="flex flex-wrap gap-2">
        {OCCASIONS.map((occasion) => {
          const chosen = occasion === props.chosen;
          return (
            <li>
              <a
                href={planPageUrl({ kind: 'day', day: props.day, occasion })}
                class={`btn btn-sm rounded-full ${chosen ? 'btn-primary' : 'btn-outline'}`}
                aria-current={chosen ? 'true' : undefined}
              >
                {occasionLabel(occasion)}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
