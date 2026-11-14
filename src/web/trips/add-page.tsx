import { type Occasion, OCCASIONS } from '../../wardrobe/occasions';
import type { IsoDate } from '../../calendar-date';
import { dayLabel, occasionLabel, shortDayLabel } from '../date-labels';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import type { GarmentOutfit } from '../outfits/queries';
import type { OutfitList } from '../outfits/outfit-list';
import {
  SavedOutfitButtons,
  SavedOutfitPicker,
} from '../outfits/saved-outfit-button';
import type { ViewContext } from '../view-context';
import type { TripRow } from './queries';
import {
  addOutfitMoreUrl,
  addOutfitUrl,
  dayAnchor,
  tripIdeasUrl,
  tripUrl,
} from './urls';

export interface AddOutfitModel {
  trip: TripRow;
  /** The trip's days, first to last. */
  days: IsoDate[];
  /** The chosen day (one of `days`) and occasion; both optional. */
  day: IsoDate | undefined;
  occasion: Occasion | undefined;
  /** A page of the owner's outfits of `list` (#659, #660), newest first. */
  outfits: GarmentOutfit[];
  /** The id the next page starts below; null on the last. */
  next: number | null;
  list: OutfitList;
  /** Outfits already on the trip for the chosen day (or without one): adding again changes nothing. */
  onTrip: ReadonlySet<number>;
}

/**
 * GET /trips/:id/outfits/new?day=&occasion= (#10): add a saved outfit to the
 * trip, the calendar plan page's shape. The day and the occasion first, as
 * chip links (the choice is the URL's), then the gallery's Ideas for the
 * same, then the saved outfits as buttons of one native PostForm to
 * POST /trips/:id/outfits; one already on the trip for that day is
 * disabled.
 */
export function AddOutfitPage(props: {
  ctx: ViewContext;
  model: AddOutfitModel;
}) {
  const { ctx, model } = props;
  const { trip, day, occasion } = model;
  const back = `${tripUrl(trip.id)}#${dayAnchor(day ?? null)}`;
  const chip = (href: string, chosen: boolean, label: string) => (
    <li>
      <a
        href={href}
        class={`btn btn-sm rounded-full ${chosen ? 'btn-primary' : 'btn-outline'}`}
        aria-current={chosen ? 'true' : undefined}
      >
        {label}
      </a>
    </li>
  );
  return (
    <Layout ctx={ctx} title={t('trips.ADD_TITLE')}>
      <AppBar ctx={ctx} title={t('trips.ADD_TITLE')} back={back} formPage />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-5">
        <p class="text-sm text-muted truncate">{trip.name}</p>

        <nav aria-label={t('trips.DAY')}>
          <p class="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
            {t('trips.DAY')}
          </p>
          <ul class="flex flex-wrap gap-2">
            {chip(
              addOutfitUrl(trip.id, { occasion }),
              day === undefined,
              t('trips.ANY_DAY'),
            )}
            {model.days.map((option) =>
              chip(
                addOutfitUrl(trip.id, { day: option, occasion }),
                option === day,
                shortDayLabel(option),
              ),
            )}
          </ul>
        </nav>

        <nav aria-label={t('OCCASION')}>
          <p class="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
            {t('OCCASION')}
          </p>
          <ul class="flex flex-wrap gap-2">
            {chip(
              addOutfitUrl(trip.id, { day }),
              occasion === undefined,
              t('trips.NO_OCCASION'),
            )}
            {OCCASIONS.map((option) =>
              chip(
                addOutfitUrl(trip.id, { day, occasion: option }),
                option === occasion,
                occasionLabel(option),
              ),
            )}
          </ul>
        </nav>

        <a
          href={tripIdeasUrl(trip.id, { day, occasion })}
          class="btn btn-primary w-full"
        >
          {t('gallery.PLAN_IDEAS')}
        </a>

        <SavedOutfitPicker
          heading={
            <>
              {day ? dayLabel(day) : t('trips.ANY_DAY')} ·{' '}
              {t('CALENDAR_PLAN_SAVED')}
            </>
          }
          action={tripUrl(trip.id, '/outfits')}
          list={model.list}
          href={addOutfitUrl(trip.id, { day, occasion })}
          outfits={model.outfits}
          noteOf={(outfit) => onTripNote(model, outfit)}
          more={moreUrl(model)}
        >
          <input type="hidden" name="day" value={day ?? ''} />
          <input type="hidden" name="occasion" value={occasion ?? ''} />
        </SavedOutfitPicker>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

type AddOutfitsModel = Pick<
  AddOutfitModel,
  'trip' | 'day' | 'occasion' | 'outfits' | 'next' | 'list' | 'onTrip'
>;

/** Already on the trip for the chosen day (or without one): adding again changes nothing. */
function onTripNote(
  model: AddOutfitsModel,
  outfit: GarmentOutfit,
): string | undefined {
  return model.onTrip.has(outfit.id) ? t('trips.ALREADY_ON_TRIP') : undefined;
}

function moreUrl(model: AddOutfitsModel): string | undefined {
  const { trip, day, occasion, next } = model;
  return next === null
    ? undefined
    : addOutfitMoreUrl(trip.id, { day, occasion }, model.list, next);
}

/**
 * A next page of the add page's saved outfits (GET
 * /trips/:id/outfits/new/more, #660): its buttons and the next sentinel,
 * landing in the page's form.
 */
export function AddOutfitButtons({ model }: { model: AddOutfitsModel }) {
  return (
    <SavedOutfitButtons
      outfits={model.outfits}
      noteOf={(outfit) => onTripNote(model, outfit)}
      more={moreUrl(model)}
    />
  );
}
