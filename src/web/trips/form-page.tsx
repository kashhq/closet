import type { FieldErrors } from '../auth/validation';
import { FormField, inputAttributes } from '../form-field';
import { t } from '../i18n';
import { FormPage } from '../layout/form-page';
import type { ViewContext } from '../view-context';
import { type PickedPlace, type PlaceAnswer } from '../weather/place-input';
import {
  fetchedPick,
  PlaceLocationFields,
  PlaceResults,
} from '../weather/place-picker';
import { TRIPS_PATH, tripUrl } from './urls';
import {
  TRIP_DESTINATION_MAX,
  TRIP_NAME_MAX,
  TRIP_NOTES_MAX,
  type TripField,
} from './validation';
import { FIELD_GRID } from '../layout/columns';

export interface TripFormModel {
  /** Absent for a new trip. */
  tripId?: number;
  /**
   * A new trip's destination picker (WEATHER_ENABLED, #684), with the place
   * picked; absent, the destination is plain text.
   */
  picker?: { place: PickedPlace | null };
  values: {
    name: string;
    destination: string;
    startsOn: string;
    endsOn: string;
    notes: string;
  };
  errors?: FieldErrors<TripField>;
}

/**
 * GET /trips/new and /trips/:id/edit, and their re-render with the messages
 * when a post is refused (400), in the shared add/edit frame (`FormPage`:
 * a native post, disabled offline). A new trip's destination can be found
 * on the map here (DestinationPicker), so its page shows the forecast at
 * once; the edit form's is a name, which the trip page finds, and a new name
 * clears the old location. The edit form also deletes the trip (its outfits
 * stay).
 */
export function TripFormPage(props: {
  ctx: ViewContext;
  model: TripFormModel;
}) {
  const { ctx, model } = props;
  const { tripId, values, errors = {} } = model;
  const editing = tripId !== undefined;
  return (
    <FormPage
      ctx={ctx}
      title={t(editing ? 'trips.EDIT' : 'trips.NEW')}
      back={editing ? tripUrl(tripId) : TRIPS_PATH}
      action={editing ? tripUrl(tripId) : TRIPS_PATH}
      submitLabel={t('SAVE')}
      remove={
        editing
          ? {
              url: tripUrl(tripId),
              confirm: t('trips.CONFIRM_DELETE'),
              label: t('trips.DELETE'),
            }
          : undefined
      }
    >
      <FormField
        id="trip-name"
        label={t('NAME')}
        required
        messages={errors.name}
      >
        <input
          {...inputAttributes('trip-name', 'w-full', errors.name)}
          type="text"
          name="name"
          value={values.name}
          maxlength={TRIP_NAME_MAX}
          required
          placeholder={t('trips.NAME_PLACEHOLDER')}
        />
      </FormField>
      {model.picker ? (
        <DestinationPicker
          destination={values.destination}
          place={model.picker.place}
        />
      ) : (
        <FormField id={DESTINATION_ID} label={t('trips.DESTINATION')}>
          <DestinationInput value={values.destination} sizing="w-full" />
        </FormField>
      )}
      <div class={FIELD_GRID}>
        <DateField
          field="startsOn"
          label={t('trips.STARTS')}
          value={values.startsOn}
          errors={errors.startsOn}
        />
        <DateField
          field="endsOn"
          label={t('trips.ENDS')}
          value={values.endsOn}
          errors={errors.endsOn}
        />
      </div>
      <FormField id="trip-notes" label={t('NOTES')}>
        <textarea
          id="trip-notes"
          name="notes"
          class="textarea textarea-bordered w-full"
          rows={3}
          maxlength={TRIP_NOTES_MAX}
        >
          {values.notes}
        </textarea>
      </FormField>
    </FormPage>
  );
}

/** The trip's first or last day: required, so marked. */
function DateField(props: {
  field: 'startsOn' | 'endsOn';
  label: string;
  value: string;
  errors: string[] | undefined;
}) {
  const id = `trip-${props.field}`;
  return (
    <FormField id={id} label={props.label} required messages={props.errors}>
      <input
        {...inputAttributes(id, 'w-full', props.errors)}
        type="date"
        name={props.field}
        value={props.value}
        required
      />
    </FormField>
  );
}

const DESTINATION_ID = 'trip-destination';
const PICKER_ID = 'trip-destination-picker';
const PLACES_ID = 'trip-new-places';
export const NEW_TRIP_PLACES_PATH = `${TRIPS_PATH}/new/places`;
export const NEW_TRIP_PLACE_PATH = `${TRIPS_PATH}/new/place`;
export const NEW_TRIP_DESTINATION_PATH = `${TRIPS_PATH}/new/destination`;

function DestinationInput(props: {
  value: string;
  sizing: string;
  readonly?: boolean;
}) {
  return (
    <input
      {...inputAttributes(DESTINATION_ID, props.sizing)}
      type="text"
      name="destination"
      value={props.value}
      maxlength={TRIP_DESTINATION_MAX}
      autocomplete="off"
      readonly={props.readonly}
      placeholder={t('trips.DESTINATION_PLACEHOLDER')}
    />
  );
}

/**
 * The new-trip form's destination (#684), swapped whole by its own GETs
 * (none writes: the form's post carries the pick): typed, with Find asking
 * NEW_TRIP_PLACES_PATH (the weather's search, WEATHER_SEARCH_LIMIT) for
 * the places under it; a place picked (NEW_TRIP_PLACE_PATH), its name
 * read-only so the text cannot drift from the coordinates posted beside
 * it, and Change back to the text (NEW_TRIP_DESTINATION_PATH). Saving
 * without a pick creates the trip unlocated: its page offers Find.
 */
export function DestinationPicker(props: {
  destination: string;
  place: PickedPlace | null;
}) {
  const { place } = props;
  const swap = { 'hx-target': `#${PICKER_ID}`, 'hx-swap': 'outerHTML' };
  return (
    <div id={PICKER_ID} class="flex flex-col gap-1">
      <FormField id={DESTINATION_ID} label={t('trips.DESTINATION')}>
        <div class="join w-full">
          {place ? (
            <>
              <DestinationInput
                value={place.name}
                sizing="join-item flex-1"
                readonly
              />
              <button
                type="button"
                class="btn join-item"
                hx-get={`${NEW_TRIP_DESTINATION_PATH}?${new URLSearchParams({ destination: place.name })}`}
                {...swap}
              >
                {t('trips.CHANGE_PLACE')}
              </button>
            </>
          ) : (
            <>
              <DestinationInput
                value={props.destination}
                sizing="join-item flex-1"
              />
              <button
                type="button"
                class="btn join-item"
                hx-get={NEW_TRIP_PLACES_PATH}
                hx-include={`#${DESTINATION_ID}`}
                hx-target={`#${PLACES_ID}`}
                hx-swap="innerHTML"
              >
                {t('trips.FIND')}
              </button>
            </>
          )}
        </div>
      </FormField>
      {place ? (
        <PlaceLocationFields location={place.location} />
      ) : (
        <div id={PLACES_ID} aria-live="polite"></div>
      )}
    </div>
  );
}

/** NEW_TRIP_PLACES_PATH's answer: a button per place, each picking it into the form. */
export function NewTripPlaceResults(props: { answer: PlaceAnswer }) {
  return (
    <PlaceResults
      answer={props.answer}
      Pick={fetchedPick(NEW_TRIP_PLACE_PATH, `#${PICKER_ID}`)}
    />
  );
}
