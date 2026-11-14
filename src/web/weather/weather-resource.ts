import { CloneType, type Static, Type } from '@sinclair/typebox';
import type { IsoDate } from '../../calendar-date';
import { OCCASIONS, type Occasion } from '../../wardrobe/occasions';
import {
  CONDITIONS,
  conditionOf,
  type DayForecast,
  forecastDay,
  rainFrom,
} from '../../weather/forecast';
import {
  type MatchGarment,
  needsWaterResistance,
  type WeatherNeeds,
  weatherNeeds,
  withRainGear,
} from '../../weather/match';
import { OFFSET_LIMIT, TEMPERATURE_UNITS } from '../../weather/temperature';
import { literals, withoutNulls } from '../api/resource';
import { IsoDateSchema } from '../schemas';
import type { TripTypicalDay } from '../trips/forecast';
import type { Place } from './open-meteo';
import { LocationBody, PlaceBody } from './place-picker';
import { HERE_FRESH_HOURS } from './queries';
import type { UserWeather } from './service';

/**
 * Every weather operation says it exists only with WEATHER_ENABLED: its
 * route is never registered otherwise (`apiPlugin`), and a client reads the
 * switch from `features.weather` on GET /me. A new weather route wraps its
 * description in this.
 */
export function weatherOnly(description?: string): string {
  const condition =
    'Exists only when `features.weather` on GET /me is true; otherwise it is not registered and answers a 404.';
  return description ? `${description} ${condition}` : condition;
}

/**
 * A day's weather and what it asks of an outfit, as the machines read it:
 * MCP's tools (get_weather, get_calendar, get_today, get_trip) and the
 * API's resources (GET /weather, GET /today, GET /trips/{id}/weather), so
 * an agent and a native client read the same numbers. Temperatures are °C,
 * whatever the user's display unit (which the resources carry beside them).
 */

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * What `day` asks of an outfit for `occasion` with the owner's rain gear
 * (rainGearFor, read for these needs) applied: the needs every surface
 * reports, so `takeUmbrella` is one answer (the ideas apply it the same way).
 */
export function needsWithGear(
  day: DayForecast,
  occasion: Occasion,
  offset: number,
  rainGear: readonly MatchGarment[],
): WeatherNeeds | null {
  const needs = weatherNeeds(day, occasion, offset);
  return needs && withRainGear(needs, rainGear);
}

/** A day's needs in the machines' words; `needs` carry the rain gear already. */
function outfitNeeds(needs: WeatherNeeds) {
  return {
    occasion: needs.occasion,
    hours: needs.window,
    feelsLikeC: {
      min: round1(needs.feelsLike.min),
      max: round1(needs.feelsLike.max),
    },
    torsoWarmth: needs.torso,
    torsoWarmthWithoutLayer: needs.torsoWithoutLayer,
    legsAndFeetWarmth: needs.limbs,
    needsLayer: needs.layer,
    rain: needs.rain,
    needsWaterResistance: needsWaterResistance(needs),
    takeUmbrella: needs.umbrella,
  };
}

/**
 * A day's weather and what it asks of an outfit for `occasion`, for someone
 * whose personal offset is `offset`: the matching's needs
 * (src/weather/match.ts). `rainFromHour` and `outfit` are null when the day
 * has no such hour (MCP sends the null, the API leaves the field out).
 */
export function dayWeather(day: DayForecast, needs: WeatherNeeds | null) {
  return {
    day: day.day,
    condition: conditionOf(day.code),
    highC: round1(day.high),
    lowC: round1(day.low),
    precipitationChance: day.precipitationChance,
    rainFromHour: rainFrom(day, 0),
    outfit: needs && outfitNeeds(needs),
  };
}

/**
 * A trip day past the forecast: the destination's climate normals, marked
 * `typical` so no reader takes them for a forecast, and what a typical day
 * asks of an all-day outfit.
 */
export function typicalDayWeather({ day, normals, needs }: TripTypicalDay) {
  return {
    day,
    typical: true as const,
    highC: round1(normals.high),
    lowC: round1(normals.low),
    feelsLikeC: {
      min: round1(normals.feelsLow),
      max: round1(normals.feelsHigh),
    },
    rainChance: normals.rainChance,
    outfit: needs && outfitNeeds(needs),
  };
}

const FeelsLike = Type.Object(
  { min: Type.Number(), max: Type.Number() },
  {
    title: 'FeelsLikeRange',
    description: '°C, your temperature offset included',
  },
);

const OutfitNeeds = Type.Object(
  {
    occasion: literals(OCCASIONS),
    hours: Type.Object(
      {
        from: Type.Integer({ minimum: 0, maximum: 23 }),
        to: Type.Integer({ minimum: 1, maximum: 24 }),
      },
      {
        title: 'OccasionHours',
        description:
          "The occasion's hours in the household's zone, `to` exclusive",
      },
    ),
    feelsLikeC: FeelsLike,
    torsoWarmth: Type.Integer({
      minimum: 1,
      maximum: 9,
      description:
        "Top (or one-piece) plus layer combined, for the coolest hours when a layer is needed: a garment's warmth is 1-5, a tee 2, a sweater 4, a parka 5",
    }),
    torsoWarmthWithoutLayer: Type.Integer({
      minimum: 1,
      maximum: 9,
      description: 'The same without the layer, for the warmest hours',
    }),
    legsAndFeetWarmth: Type.Integer({ minimum: 1, maximum: 5 }),
    needsLayer: Type.Boolean({
      description: 'The hours swing enough to want a layer that comes off',
    }),
    rain: Type.Boolean({
      description:
        "Rain is likely (50% or more) in at least one of the occasion's hours, however it is answered",
    }),
    needsWaterResistance: Type.Boolean({
      description:
        'Rain is likely and nothing beside the outfit answers it, so the outfit should include a water-resistant layer, footwear or accessory (not a bag). False when there is no rain, or when takeUmbrella is true',
    }),
    takeUmbrella: Type.Boolean({
      description:
        'Rain is likely and is answered beside the outfit: every rain hour is warm (feels-like above 22 °C), or the closet holds a water-resistant hat or cap. Advice for the day, never asked of the outfit. False when there is no rain',
    }),
  },
  {
    title: 'OutfitWeatherNeeds',
    description: 'What the day asks of an outfit for the occasion',
  },
);

export const DayWeather = Type.Object(
  {
    day: IsoDateSchema,
    condition: literals(CONDITIONS),
    highC: Type.Number(),
    lowC: Type.Number(),
    precipitationChance: Type.Integer({
      minimum: 0,
      maximum: 100,
      description: "The day's highest chance of precipitation, %",
    }),
    rainFromHour: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 23,
        description:
          'The first hour of the day with rain likely; absent for a dry day',
      }),
    ),
    outfit: Type.Optional(OutfitNeeds),
  },
  {
    title: 'DayWeather',
    description: 'A forecast day, temperatures in °C',
  },
);

export const TypicalDayWeather = Type.Object(
  {
    day: IsoDateSchema,
    typical: Type.Literal(true),
    highC: Type.Number(),
    lowC: Type.Number(),
    feelsLikeC: CloneType(FeelsLike, {
      description: "The day's feels-like low and high, °C",
    }),
    rainChance: Type.Integer({
      minimum: 0,
      maximum: 100,
      description: 'The share of those days that were wet, %',
    }),
    outfit: Type.Optional(OutfitNeeds),
  },
  {
    title: 'TypicalDayWeather',
    description:
      "What the place is usually like on that day (the last ten years' average around the date), never a forecast: for a trip's days past the forecast",
  },
);

export function toDayWeather(
  day: DayForecast,
  needs: WeatherNeeds | null,
): Static<typeof DayWeather> {
  return withoutNulls(dayWeather(day, needs));
}

export function toTypicalDayWeather(
  day: TripTypicalDay,
): Static<typeof TypicalDayWeather> {
  return withoutNulls(typicalDayWeather(day));
}

const TemperatureUnit = CloneType(literals(TEMPERATURE_UNITS), {
  description: 'How you read temperatures: only display, everything here is °C',
});

const TemperatureOffset = Type.Number({
  minimum: -OFFSET_LIMIT,
  maximum: OFFSET_LIMIT,
  description:
    "°C added to every feels-like before ideas are matched to it (the temperature feedback's)",
});

const Coordinates = {
  latitude: Type.Number({ description: 'Rounded to 2 decimals (~1 km)' }),
  longitude: Type.Number({ description: 'Rounded to 2 decimals (~1 km)' }),
};

/** A place picked from the search as it is kept: your home, a trip's destination. */
export const KeptPlace = Type.Object(
  { name: Type.String(), ...Coordinates },
  {
    title: 'KeptPlace',
    description:
      'A place picked from the search, as kept: the name trimmed, the coordinates rounded',
  },
);

/** A trip's destination as kept: the place and the zone saved with it. */
export const KeptDestination = Type.Object(
  {
    ...KeptPlace.properties,
    timeZone: Type.Union([Type.String(), Type.Null()], {
      description:
        "The IANA time zone kept with the destination; null when the one sent was absent or unknown, so the trip's days are the household's",
    }),
  },
  {
    title: 'KeptDestination',
    description:
      "A trip's destination as kept: the name trimmed, the coordinates rounded, the zone as saved",
  },
);

export const HerePlace = Type.Object(
  {
    ...Coordinates,
    locatedAt: Type.String({ format: 'date-time' }),
  },
  {
    title: 'WeatherHere',
    description: `The phone's position as kept (rounded) and when it was sent: it stands in for home for ${HERE_FRESH_HOURS} hours`,
  },
);

/** The person's weather: GET /weather, and GET /today's for today. */
export const WeatherResource = Type.Object(
  {
    unit: TemperatureUnit,
    temperatureOffset: TemperatureOffset,
    home: Type.Optional(KeptPlace),
    here: Type.Optional(HerePlace),
    source: Type.Optional(
      CloneType(literals(['home', 'here'] as const), {
        description:
          'Which location the forecast is for; absent without one (set a home with PUT /weather/home)',
      }),
    ),
    fetchedAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description:
          'When the forecast was fetched: its "as of". Absent with no forecast for the location yet',
      }),
    ),
    days: Type.Array(DayWeather, {
      description:
        'The forecast days asked for that it reaches (16 from today), in order; empty without a location or a forecast',
    }),
  },
  {
    title: 'Weather',
    description:
      'Your weather settings and the forecast where you are: the home city, or the phone while its location is fresh',
  },
);
type WeatherResource = Static<typeof WeatherResource>;

/**
 * `own`'s settings and its forecast for those of `days` it reaches, each
 * with what it asks of an outfit for `occasion`.
 */
export function toWeatherResource(
  own: UserWeather,
  days: readonly IsoDate[],
  occasion: Occasion,
  rainGear: readonly MatchGarment[],
): WeatherResource {
  const { settings, active, cached } = own;
  const forecastDays = cached
    ? days.flatMap((day) => {
        const found = forecastDay(cached.forecast, day);
        return found
          ? [
              toDayWeather(
                found,
                needsWithGear(found, occasion, settings.offset, rainGear),
              ),
            ]
          : [];
      })
    : [];
  return {
    unit: settings.unit,
    temperatureOffset: settings.offset,
    ...(settings.home && {
      home: { name: settings.home.name, ...settings.home.location },
    }),
    ...(settings.here && {
      here: {
        ...settings.here.location,
        locatedAt: settings.here.locatedAt.toISOString(),
      },
    }),
    ...(active && { source: active.source }),
    ...(cached && { fetchedAt: cached.fetchedAt.toISOString() }),
    days: forecastDays,
  };
}

const PlaceResource = Type.Object(
  {
    label: Type.String({
      description:
        'Its full name, "Brooklyn, New York, United States": send it as the `name` you set',
    }),
    ...Coordinates,
    timeZone: Type.Union([Type.String(), Type.Null()], {
      description:
        'Its IANA time zone ("Asia/Tokyo"); null when the search named none. Send it as the `timeZone` you set: a trip\'s days and hours are asked in it',
    }),
  },
  { title: 'Place', description: 'A place the search found' },
);

export const PlaceList = Type.Object(
  { data: Type.Array(PlaceResource, { description: 'Best match first' }) },
  {
    title: 'PlaceList',
    description:
      "The geocoding search's places for the name: a handful, never paged",
  },
);

export function toPlaceResource(place: Place): Static<typeof PlaceResource> {
  return { label: place.label, ...place.location, timeZone: place.timeZone };
}

/** PUT /weather/home and a trip's destination: a place from the search. */
export const PlaceInput = CloneType(PlaceBody, {
  title: 'PlaceInput',
  description:
    "A place from GET /weather/places: its label as the name, its coordinates (rounded to ~1 km before they are kept) and its `timeZone` (a trip reads its days in it; one omitted or unknown is the household's)",
});

/** PUT /weather/here: the phone's position. */
export const LocationInput = CloneType(LocationBody, {
  title: 'LocationInput',
  description:
    "The phone's position, rounded to ~1 km before it is kept or sent anywhere",
});

export const UnitInput = Type.Object(
  { unit: TemperatureUnit },
  { title: 'TemperatureUnitInput' },
);
