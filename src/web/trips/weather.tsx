import type { Child } from 'hono/jsx';
import { conditionOf, rainFrom } from '../../weather/forecast';
import { NORMAL_YEARS } from '../../weather/normals';
import {
  displayTemperature,
  type TemperatureUnit,
} from '../../weather/temperature';
import { PostForm } from '../form';
import { dayLabel, shortDayLabel } from '../date-labels';
import { t, type Translated } from '../i18n';
import { type PlaceAnswer } from '../weather/place-input';
import { PlaceResults, postedPick } from '../weather/place-picker';
import {
  ConditionIcon,
  fetchedLabel,
  hourLabel,
  OpenMeteoCredit,
  UNIT_SYMBOLS,
} from '../weather/views';
import type { TripForecast, TripTypicalDay, TripWeatherDay } from './forecast';
import { tripIdeasUrl, tripUrl } from './urls';

/**
 * The trip page's weather fragment (GET /trips/:id/weather): the
 * destination's forecast for the trip's days the forecast reaches, each day
 * with its range, rain and what it asks of an outfit, and a link to ideas
 * for it (the gallery with the destination's forecast); past the forecast,
 * from when the rest arrives and, meanwhile, each day's typical weather
 * (climate normals, labelled as such) with its own ideas link. The page
 * loads it after itself, so a slow Open-Meteo never holds the trip up.
 */
export function TripWeather(props: {
  tripId: number;
  forecast: TripForecast;
  timeZone: string;
  now: Date;
}) {
  const { forecast } = props;
  switch (forecast.kind) {
    case 'over':
      return <p class="text-sm text-muted">{t('trips.WEATHER_OVER')}</p>;
    case 'no-location':
      return (
        <p class="text-sm text-muted" data-trip-weather="no-location">
          {t('trips.WEATHER_NO_PLACE')}
        </p>
      );
    case 'forecast':
      return (
        <div class="flex flex-col gap-1" data-trip-weather="forecast">
          {forecast.unavailable && (
            <p class="text-sm text-muted" data-forecast-unavailable="">
              {t('trips.WEATHER_UNAVAILABLE')}
            </p>
          )}
          <ul class="flex flex-col divide-y divide-base-200">
            {forecast.days.map((day) => (
              <TripWeatherRow
                tripId={props.tripId}
                day={day}
                unit={forecast.unit}
              />
            ))}
          </ul>
          {forecast.fetchedAt && (
            <p class="text-xs text-muted">
              {t('weather.AS_OF', {
                time: fetchedLabel(
                  forecast.fetchedAt,
                  props.timeZone,
                  props.now,
                ),
              })}
            </p>
          )}
          {forecast.later && (
            <p class="text-xs text-muted" data-forecast-from="">
              {t(
                // No day within the forecast (not one that failed): the
                // whole trip waits for it.
                forecast.days.length === 0 && !forecast.unavailable
                  ? 'trips.FORECAST_FROM'
                  : 'trips.FORECAST_LATER',
                {
                  day: shortDayLabel(forecast.later.day),
                  from: shortDayLabel(forecast.later.from),
                },
              )}
            </p>
          )}
          {forecast.typical.length > 0 && (
            <>
              <p class="text-xs text-muted pt-1">
                {t('trips.TYPICAL_NOTE', { years: NORMAL_YEARS })}
              </p>
              <ul
                class="flex flex-col divide-y divide-base-200"
                data-trip-typical=""
              >
                {forecast.typical.map((day) => (
                  <TripTypicalRow
                    tripId={props.tripId}
                    day={day}
                    unit={forecast.unit}
                  />
                ))}
              </ul>
            </>
          )}
          <OpenMeteoCredit class="block" />
        </div>
      );
  }
}

/** "12–18 °C" from Celsius, in the person's unit. */
function rangeLabel(
  low: number,
  high: number,
  unit: TemperatureUnit,
): Translated {
  return t('weather.RANGE', {
    low: displayTemperature(low, unit),
    high: displayTemperature(high, unit),
    unit: UNIT_SYMBOLS[unit],
  });
}

function TripWeatherRow(props: {
  tripId: number;
  day: TripWeatherDay;
  unit: TemperatureUnit;
}) {
  const { forecast, needs } = props.day;
  const { unit } = props;
  const rain = rainFrom(forecast, 0);
  const notes = [
    rain !== null ? t('weather.RAIN_FROM', { hour: hourLabel(rain) }) : null,
    needs?.layer ? t('weather.TAKE_LAYER') : null,
  ].filter((note) => note !== null);
  return (
    <li class="flex items-center gap-2 py-1.5" data-weather-day={forecast.day}>
      <ConditionIcon condition={conditionOf(forecast.code)} />
      <span class="flex flex-col min-w-0 flex-1">
        <span class="text-sm">
          <span class="font-medium">{dayLabel(forecast.day)}</span>{' '}
          {rangeLabel(forecast.low, forecast.high, unit)}
        </span>
        {(needs || notes.length > 0) && (
          <span class="text-xs text-muted">
            {needs &&
              t('gallery.FEELS', {
                range: rangeLabel(
                  needs.feelsLike.min,
                  needs.feelsLike.max,
                  unit,
                ),
              })}
            {notes.map((note) => (
              <span> · {note}</span>
            ))}
          </span>
        )}
      </span>
      <a
        href={tripIdeasUrl(props.tripId, { day: forecast.day })}
        class="btn btn-ghost btn-xs"
      >
        {t('trips.DAY_IDEAS')}
      </a>
    </li>
  );
}

/**
 * A day past the forecast: the destination's typical range and rain chance,
 * worded as typical so it never reads as a forecast (no condition icon: a
 * normal has no weather of its own), with what a typical day asks.
 */
function TripTypicalRow(props: {
  tripId: number;
  day: TripTypicalDay;
  unit: TemperatureUnit;
}) {
  const { day, normals, needs } = props.day;
  const { unit } = props;
  return (
    <li class="flex items-center gap-2 py-1.5" data-typical-day={day}>
      <span class="flex flex-col min-w-0 flex-1">
        <span class="text-sm">
          <span class="font-medium">{dayLabel(day)}</span>{' '}
          {t('trips.TYPICAL_DAY', {
            range: rangeLabel(normals.low, normals.high, unit),
            chance: normals.rainChance,
          })}
        </span>
        {needs?.layer && (
          <span class="text-xs text-muted">{t('weather.TAKE_LAYER')}</span>
        )}
      </span>
      <a
        href={tripIdeasUrl(props.tripId, { day })}
        class="btn btn-ghost btn-xs"
      >
        {t('trips.DAY_IDEAS')}
      </a>
    </li>
  );
}

/**
 * GET /trips/:id/places's answer: a button per place the geocoding search
 * found, each a native post setting it as the trip's destination (name and
 * rounded location), back to the trip.
 */
export function TripPlaceResults(props: {
  tripId: number;
  answer: PlaceAnswer;
}) {
  const Form = (form: { children: Child }) => (
    <PostForm action={tripUrl(props.tripId, '/destination')}>
      {form.children}
    </PostForm>
  );
  return <PlaceResults answer={props.answer} Pick={postedPick(Form)} />;
}
