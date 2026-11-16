import { t } from '../i18n';
import { bodyOf, OutfitCollage, outfitLabel } from '../outfits/collage';
import { hiddenBlocking } from './month-cell';
import { GarmentMark } from '../layout/garment-mark';
import type { ViewContext } from '../view-context';
import {
  OpenMeteoCredit,
  WeatherCellSlot,
  weatherDayId,
  WeatherMonthLoader,
} from '../weather/views';
import type { MonthDayView, MonthView } from './calendar-view';
import { PageShell } from '../layout/page-shell';
import { calendarTabs } from './calendar-tabs';
import { DAY_LETTERS, dayLabel, monthLabel } from '../date-labels';
import { dayUrl, monthUrl } from './urls';

/**
 * GET /calendar/month[?month=YYYY-MM]: the history view (R6;
 * docs/plans/2026-09-26-redesign.md, Calendar: "what did I wear in
 * August"). A Sunday-to-Saturday grid of the month's days, each with its
 * first entry's collage (occasion order) and how many more; a worn day has
 * the accent's dot. A day links to its week, scrolled to it: the
 * agenda is where an entry is changed. Network first like any page with a
 * query; the Month tab itself carries none and opens this month. The days
 * the forecast reaches keep room for a weather chip under the date, loaded
 * after the page (#201, WeatherMonthLoader), never rendered in it.
 */
export function MonthPage(props: { ctx: ViewContext; view: MonthView }) {
  const { ctx, view } = props;
  const title = monthLabel(view.month);
  return (
    <PageShell
      ctx={ctx}
      name="month"
      title={t('CALENDAR_PAGE_TITLE')}
      bar={{ title: t('CALENDAR'), tabs: calendarTabs('month') }}
      width="wide"
    >
      <WeatherMonthLoader ctx={ctx} days={view.forecast} />
      <nav
        class="flex items-center justify-between gap-2 mb-2"
        aria-label={t('calendar.MONTH_NAV')}
      >
        <a
          href={monthUrl(view.prev)}
          class="btn btn-ghost btn-sm btn-square"
          aria-label={t('calendar.PREV_MONTH')}
        >
          ‹
        </a>
        <h2 class="font-semibold">{title}</h2>
        <a
          href={monthUrl(view.next)}
          class="btn btn-ghost btn-sm btn-square"
          aria-label={t('calendar.NEXT_MONTH')}
        >
          ›
        </a>
      </nav>
      <table class="w-full table-fixed border-separate border-spacing-1 -mx-1">
        <caption class="sr-only">{title}</caption>
        <thead>
          <tr>
            {DAY_LETTERS.map((key) => (
              <th scope="col" class="text-xs font-medium text-muted">
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.weeks.map((week) => (
            <tr>
              {week.map((day) => (
                <td class="p-0 align-top">
                  {day && <MonthDay ctx={ctx} day={day} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {ctx.weatherEnabled && view.forecast && (
        <p class="px-2 pt-2">
          <OpenMeteoCredit />
        </p>
      )}
    </PageShell>
  );
}

/**
 * A day's cell. From lg (#1064) the date, the chip, the worn dot and "+N"
 * share one line over the collage (`lg:order-last`, a full-width line of
 * its own) at the collage's `month` step (the phone's piece size); the phone keeps
 * them stacked.
 */
function MonthDay({ ctx, day }: { ctx: ViewContext; day: MonthDayView }) {
  const [first] = day.entries;
  // The link's aria-label stands in for its content, so the chip is read as
  // its description instead.
  const weather = ctx.weatherEnabled && day.inForecast;
  const more = day.entries.length - 1;
  const worn = isWorn(day);
  return (
    <a
      href={dayUrl(day.date)}
      class="flex flex-col items-center gap-0.5 min-h-16 p-0.5 lg:flex-row lg:flex-wrap lg:content-start lg:gap-x-1 lg:min-h-27 rounded-field overflow-hidden hover:bg-base-200"
      aria-label={cellLabel(day)}
      aria-current={day.isToday ? 'date' : undefined}
      aria-describedby={weather ? weatherDayId(day.date) : undefined}
      data-month-day={day.date}
      data-worn={worn ? '' : undefined}
    >
      <span
        class={`flex items-center justify-center size-6 rounded-full text-xs font-semibold ${day.isToday ? 'bg-primary text-primary-content' : ''}`}
      >
        {day.dayNum}
      </span>
      {weather && <WeatherCellSlot ctx={ctx} day={day.date} />}
      {first && <CellCollage first={first} entries={day.entries} />}
      {worn && <span class="size-1 rounded-full bg-accent"></span>}
      {more > 0 && (
        <span class="text-xs text-muted">
          {t('calendar.MORE', { count: more })}
        </span>
      )}
    </a>
  );
}

/**
 * The cell draws its first entry's body only (bodyOf): a blocking mark on
 * any other piece of the day shows as one dot (hiddenBlocking), the same look and corner as a
 * drawn piece's. aria-hidden: the cell link's label already says it
 * (outfitLabel).
 */
function CellCollage({
  first,
  entries,
}: {
  first: MonthDayView['entries'][number];
  entries: MonthDayView['entries'];
}) {
  const drawn = bodyOf(first.pieces);
  const hidden = hiddenBlocking(entries, drawn);
  return (
    <span class="relative w-full lg:order-last">
      <OutfitCollage garments={drawn} size="month" decorative />
      {hidden && (
        <span class="absolute bottom-0 right-0" aria-hidden="true">
          <GarmentMark marks={[hidden]} dot />
        </span>
      )}
    </span>
  );
}

function isWorn(day: MonthDayView): boolean {
  return day.entries.some((entry) => entry.worn);
}

/** "Wednesday, Mar 14, Linen, Worn": the day, its outfits, and whether worn. */
function cellLabel(day: MonthDayView): string {
  return [
    dayLabel(day.date),
    ...day.entries.map((entry) =>
      outfitLabel(entry.outfit.name || t('UNTITLED_OUTFIT'), entry.pieces),
    ),
    ...(isWorn(day) ? [t('wear.WORN')] : []),
  ].join(', ');
}
