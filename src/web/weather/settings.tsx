import type { Child } from 'hono/jsx';
import { AutosaveForm } from '../autosave';
import { t } from '../i18n';
import { SettingsPage } from '../layout/settings-page';
import type { ViewContext } from '../view-context';
import {
  displayDifference,
  OFFSET_LIMIT,
  TEMPERATURE_UNITS,
} from '../../weather/temperature';
import {
  PLACE_QUERY_MAX,
  PLACE_QUERY_MIN,
  type PlaceAnswer,
} from './place-input';
import { LocationFields, PlaceResults, postedPick } from './place-picker';
import {
  activeLocation,
  HERE_FRESH_HOURS,
  type WeatherSettings,
} from './queries';
import { WEATHER_SETTINGS_ID } from './urls';
import { fetchedLabel } from './views';
import {
  LOCATE_FORM_ID,
  locateButton,
  locateStatus,
  needsNetwork,
} from '../page-contract';

/**
 * Profile › Weather (#14; a Profile section until #728, its own page since,
 * WEATHER_SETTINGS_PATH): the home city (a search on
 * Open-Meteo's geocoding, through the server), "Use my location" (the
 * phone's position, rounded to 2 decimals in the browser and again on the
 * server; views/assets/page/locate.ts), the unit, and the personal temperature
 * offset with its "too warm" and "too cold" feedback (the minimal form of
 * #9's "say why not"). Each part answers only itself
 * (src/web/weather/routes.tsx): the location forms `WeatherLocation`, the
 * feedback `OffsetControls`, the unit (an `AutosaveForm`, saved on every
 * change) its status line and the offset out of band, since the offset
 * reads in the unit. None replaces the unit's form: a save queued there
 * would die with it (src/web/autosave.tsx). Each is disabled offline.
 */

const LOCATION_ID = 'weather-location';
const OFFSET_ID = 'weather-offset';

const swapInto = (id: string) =>
  ({
    'hx-target': `#${id}`,
    'hx-swap': 'outerHTML',
    ...needsNetwork(),
  }) as const;
const LOCATION_SWAP = swapInto(LOCATION_ID);
const OFFSET_SWAP = swapInto(OFFSET_ID);

// A fixed module string (never a value): runs each time the location part
// is swapped in, so the new button is wired (an inline module, not a
// <script src>, which would run once per document).
const LOCATE_MODULE = `import { initLocate } from 'locate';
initLocate(document.getElementById('${LOCATION_ID}'));`;

export function WeatherSettingsPage(props: {
  ctx: ViewContext;
  settings: WeatherSettings;
  timeZone: string;
  now: Date;
}) {
  const { ctx, ...location } = props;
  const { settings } = props;
  return (
    <SettingsPage
      ctx={ctx}
      title={t('weather.SETTINGS_HEADING')}
      section={WEATHER_SETTINGS_ID}
      formPage
    >
      <WeatherLocation {...location} />
      <AutosaveForm action="/weather/unit">
        <div class="flex items-center gap-2">
          <span class="text-sm">{t('weather.UNIT')}</span>
          {TEMPERATURE_UNITS.map((unit) => (
            <input
              type="radio"
              name="unit"
              value={unit}
              class="btn btn-sm rounded-full"
              aria-label={t(
                unit === 'celsius' ? 'weather.CELSIUS' : 'weather.FAHRENHEIT',
              )}
              checked={settings.unit === unit}
            />
          ))}
        </div>
      </AutosaveForm>
      <OffsetControls settings={settings} />
    </SettingsPage>
  );
}

/** Profile's Weather row: the home city, or that there is none. */
export function weatherSummary(settings: WeatherSettings): string {
  return settings.home
    ? t('weather.HOME_IS', { name: settings.home.name })
    : t('weather.SUMMARY_NO_HOME');
}

/** Home, the city search and "Use my location": what the location forms answer. */
export function WeatherLocation(props: {
  settings: WeatherSettings;
  timeZone: string;
  now: Date;
}) {
  const { settings, timeZone, now } = props;
  const active = activeLocation(settings, now);
  const here = active?.source === 'here' ? settings.here : null;
  return (
    <div id={LOCATION_ID} class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm">
          {settings.home
            ? t('weather.HOME_IS', { name: settings.home.name })
            : t('weather.NO_HOME')}
        </p>
        {settings.home && (
          <form hx-post="/weather/home/clear" {...LOCATION_SWAP}>
            <button
              type="submit"
              class="btn btn-ghost btn-xs"
              aria-label={t('weather.REMOVE_HOME_LABEL')}
            >
              {t('weather.REMOVE_HOME')}
            </button>
          </form>
        )}
      </div>
      <form
        class="join w-full"
        role="search"
        hx-get="/weather/places"
        hx-target="#weather-places"
        hx-swap="innerHTML"
        {...needsNetwork()}
      >
        <input
          type="search"
          name="q"
          required
          minlength={PLACE_QUERY_MIN}
          maxlength={PLACE_QUERY_MAX}
          autocomplete="address-level2"
          class="input join-item w-full"
          placeholder={t('weather.SEARCH_PLACEHOLDER')}
          aria-label={t('weather.SEARCH_PLACEHOLDER')}
        />
        <button type="submit" class="btn join-item">
          {t('weather.SEARCH')}
        </button>
      </form>
      <div id="weather-places" aria-live="polite"></div>

      <HereControls
        locatedAt={here?.locatedAt ?? null}
        timeZone={timeZone}
        now={now}
      />
      <script
        type="module"
        // A fixed string (LOCATE_MODULE), no value spliced in.
        dangerouslySetInnerHTML={{ __html: LOCATE_MODULE }}
      />
    </div>
  );
}

function HereControls(props: {
  locatedAt: Date | null;
  timeZone: string;
  now: Date;
}) {
  const { locatedAt, timeZone, now } = props;
  if (locatedAt) {
    const until = new Date(locatedAt.getTime() + HERE_FRESH_HOURS * 3_600_000);
    return (
      <div class="flex flex-col gap-1">
        <p class="text-sm">
          {t('weather.USING_HERE', {
            since: fetchedLabel(locatedAt, timeZone, now),
            until: fetchedLabel(until, timeZone, now),
          })}
        </p>
        <form hx-post="/weather/here/clear" {...LOCATION_SWAP}>
          <button type="submit" class="btn btn-ghost btn-xs">
            {t('weather.STOP_HERE')}
          </button>
        </form>
      </div>
    );
  }
  // locate.js shows the button where the browser can locate (a secure
  // context with Geolocation) and posts the rounded position through the
  // hidden form.
  return (
    <div class="flex flex-col gap-1" {...needsNetwork()}>
      <button
        type="button"
        class="btn btn-outline btn-sm self-start"
        {...locateButton()}
        hidden
      >
        {t('weather.USE_HERE')}
      </button>
      <p
        class="text-xs text-error"
        role="alert"
        {...locateStatus({
          denied: t('weather.HERE_DENIED'),
          failed: t('weather.HERE_FAILED'),
          notSaved: t('weather.HERE_NOT_SAVED'),
        })}
        hidden
      ></p>
      <form
        id={LOCATE_FORM_ID}
        hx-post="/weather/here"
        {...LOCATION_SWAP}
        hidden
      >
        <LocationFields />
      </form>
    </div>
  );
}

function offsetLabel(settings: WeatherSettings): string {
  if (settings.offset === 0) return t('weather.OFFSET_NONE');
  // "as if it were 1.5° colder": the direction is in the words.
  const degrees = `${Math.abs(displayDifference(settings.offset, settings.unit))}°`;
  return t(
    settings.offset > 0 ? 'weather.OFFSET_WARM' : 'weather.OFFSET_COLD',
    {
      degrees,
    },
  );
}

/**
 * The personal offset and its feedback: what the feedback forms answer, and
 * what a unit save sends out of band (`oob`), since it reads in the unit.
 */
export function OffsetControls(props: {
  settings: WeatherSettings;
  oob?: boolean;
}) {
  const { settings } = props;
  return (
    <div
      id={OFFSET_ID}
      class="flex flex-col gap-2"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      <p class="text-sm">{offsetLabel(settings)}</p>
      <div class="chip-row">
        {(['too-warm', 'too-cold'] as const).map((feeling) => (
          <form hx-post="/weather/feedback" {...OFFSET_SWAP}>
            <input type="hidden" name="feeling" value={feeling} />
            <button
              type="submit"
              class="btn btn-sm btn-outline"
              disabled={
                feeling === 'too-warm'
                  ? settings.offset >= OFFSET_LIMIT
                  : settings.offset <= -OFFSET_LIMIT
              }
            >
              {t(
                feeling === 'too-warm'
                  ? 'weather.TOO_WARM'
                  : 'weather.TOO_COLD',
              )}
            </button>
          </form>
        ))}
        {settings.offset !== 0 && (
          <form hx-post="/weather/offset/reset" {...OFFSET_SWAP}>
            <button type="submit" class="btn btn-sm btn-ghost">
              {t('weather.OFFSET_RESET')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** GET /weather/places's answer: a button per place, each setting it as home. */
export function HomePlaceResults(props: { answer: PlaceAnswer }) {
  return <PlaceResults answer={props.answer} Pick={postedPick(HomeForm)} />;
}

function HomeForm(props: { children: Child }) {
  return (
    <form hx-post="/weather/home" {...LOCATION_SWAP}>
      {props.children}
    </form>
  );
}
