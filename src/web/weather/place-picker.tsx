import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import type { Location, PickedLocation } from '../../weather/location';
import { t } from '../i18n';
import type { Place } from './open-meteo';
import type { PlaceAnswer } from './place-input';

/**
 * The place pickers' markup (the profile's home city,
 * src/web/weather/settings.tsx, a trip's destination,
 * src/web/trips/weather.tsx, and the new-trip form's, form-page.tsx, #684):
 * the list of places with their posted fields. The schemas those posts are
 * read with are place-input.ts. `@place-fields` (scripts/ci/guards.conf)
 * keeps the posted coordinates in these two files; each picker brings only
 * where a pick goes.
 */

/**
 * A position's hidden fields, empty for locate.js to fill when `location`
 * is absent.
 */
export function LocationFields(props: { location?: Location }) {
  const { location } = props;
  return (
    <>
      <input
        type="hidden"
        name="latitude"
        value={location && String(location.latitude)}
      />
      <input
        type="hidden"
        name="longitude"
        value={location && String(location.longitude)}
      />
    </>
  );
}

/** A picked place's coordinates and zone as hidden fields, without its name (each picker posts that as it names it). */
export function PlaceLocationFields(props: { location: PickedLocation }) {
  const { location } = props;
  return (
    <>
      <LocationFields location={location} />
      {location.timeZone && (
        <input type="hidden" name="timeZone" value={location.timeZone} />
      )}
    </>
  );
}

/** How a picker offers one place of the search's answer. */
export type PlacePick = (props: { place: Place }) => JSX.Element;

/**
 * The search's answer (a 200 either way, so htmx shows it): a control per
 * place, the picker's `Pick`.
 */
export function PlaceResults(props: { answer: PlaceAnswer; Pick: PlacePick }) {
  const { answer, Pick } = props;
  if ('failed' in answer) {
    return <p class="text-sm text-error">{t('weather.SEARCH_FAILED')}</p>;
  }
  if (answer.places.length === 0) {
    return <p class="text-sm">{t('weather.NO_PLACES')}</p>;
  }
  return (
    <ul class="flex flex-col gap-1">
      {answer.places.map((place) => (
        <li>
          <Pick place={place} />
        </li>
      ))}
    </ul>
  );
}

const PICK_BUTTON = 'btn btn-ghost btn-sm justify-start w-full';

/** A pick that posts PlaceBody's fields in the picker's own form. */
export function postedPick(
  Form: (props: { children: Child }) => JSX.Element,
): PlacePick {
  return ({ place }) => (
    <Form>
      <input type="hidden" name="name" value={place.label} />
      <PlaceLocationFields
        location={{ ...place.location, timeZone: place.timeZone }}
      />
      <button type="submit" class={PICK_BUTTON}>
        {place.label}
      </button>
    </Form>
  );
}

/**
 * A pick for a picker inside a form of its own, which cannot nest one (the
 * new-trip form): a button asking `path` by GET with PlaceBody's fields as
 * the query, its answer swapped over `target`. Writes nothing: the form's
 * post carries the place.
 */
export function fetchedPick(path: string, target: string): PlacePick {
  return ({ place }) => {
    const query = new URLSearchParams({
      name: place.label,
      latitude: String(place.location.latitude),
      longitude: String(place.location.longitude),
    });
    if (place.timeZone) query.set('timeZone', place.timeZone);
    return (
      <button
        type="button"
        class={PICK_BUTTON}
        hx-get={`${path}?${query}`}
        hx-target={target}
        hx-swap="outerHTML"
      >
        {place.label}
      </button>
    );
  };
}
