import { type Static, Type } from '@sinclair/typebox';
import {
  type Location,
  type PickedLocation,
  roundedLocation,
} from '../../weather/location';
import { canonicalTimeZone } from '../../calendar-date';
import type { Place } from './open-meteo';
import type { WeatherService } from './service';

/**
 * The place-search protocol's data, shared by the pickers' pages
 * (place-picker.tsx), the weather routes and the API (api-routes.ts,
 * weather-resource.ts, and the trips' api-routes.ts): the search field's
 * bounds and its query schema, the answer, and the schemas a posted place is
 * read with. No view here, so the API never imports one.
 * `@place-fields` (scripts/ci/guards.conf) keeps the posted coordinates in
 * this file and place-picker.tsx.
 */

/** The search field's `minlength`/`maxlength`, which PlaceQuery holds the server to. */
export const PLACE_QUERY_MIN = 2;
export const PLACE_QUERY_MAX = 100;
const PLACE_NAME_MAX = 200;
// The longest IANA name is about 30 characters ("America/Argentina/ComodRivadavia").
const TIME_ZONE_MAX = 64;

export const PlaceQuery = Type.Object({
  q: Type.String({ minLength: PLACE_QUERY_MIN, maxLength: PLACE_QUERY_MAX }),
});

/** A position as posted: the phone's (public/js/locate.js) or a picked place's. */
export const LocationBody = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
});

/** A place picked from the search's answer (PlaceResults' fields). */
export const PlaceBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: PLACE_NAME_MAX }),
  ...LocationBody.properties,
  // The search answer's zone (#678): a trip's days are asked in it. Absent
  // (a form cached before it), null (the search's answer for a place that
  // named none, which API clients send back as it came, #807) or a name
  // Intl does not know is no zone, never a 400: the weather reads
  // APP_TIMEZONE then, as it did before.
  timeZone: Type.Optional(
    Type.Union([Type.String({ maxLength: TIME_ZONE_MAX }), Type.Null()]),
  ),
});

export function postedLocation(body: Static<typeof LocationBody>): Location {
  // In range by the schema, so never null.
  return roundedLocation(body.latitude, body.longitude)!;
}

/** A place as a picker keeps it: the trip's destination, the profile's home. */
export interface PickedPlace {
  name: string;
  location: PickedLocation;
}

export function pickedPlace(body: Static<typeof PlaceBody>): PickedPlace {
  const timeZone =
    body.timeZone == null ? null : canonicalTimeZone(body.timeZone);
  return {
    name: body.name.trim(),
    location: { ...postedLocation(body), timeZone },
  };
}

/**
 * A picked place as the API answers it kept (KeptPlace, the home's PUT and
 * a trip destination's): the name and the rounded coordinates. Not the zone:
 * the home is always read in APP_TIMEZONE (#678).
 */
export function keptPlace(place: PickedPlace): {
  name: string;
  latitude: number;
  longitude: number;
} {
  const { latitude, longitude } = place.location;
  return { name: place.name, latitude, longitude };
}

/**
 * A trip destination as the API answers it kept: KeptPlace plus the zone as
 * saved, null when the sent one was absent, null or unknown (so the caller
 * sees the fallback to APP_TIMEZONE, #808).
 */
export function keptDestination(place: PickedPlace) {
  return { ...keptPlace(place), timeZone: place.location.timeZone };
}

export type PlaceAnswer = { places: Place[] } | { failed: true };

/** The geocoding search's answer; a failure (logged by the service) is an answer too. */
export async function placeAnswer(
  weather: WeatherService,
  query: Static<typeof PlaceQuery>,
): Promise<PlaceAnswer> {
  try {
    return { places: await weather.searchPlaces(query.q.trim()) };
  } catch {
    return { failed: true };
  }
}
