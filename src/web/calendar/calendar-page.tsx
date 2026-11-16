import {
  DEFAULT_OCCASION,
  type Occasion,
  OCCASIONS,
} from '../../wardrobe/occasions';
import { AlreadySavedToast } from '../gallery/already-saved';
import type { AlreadySaved } from '../gallery/urls';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { DayHeading } from '../layout/day-heading';
import { Dock } from '../layout/dock';
import { PageMain } from '../layout/page-main';
import { Layout } from '../layout/layout';
import { SelfieView } from '../selfies/views';
import type { ViewContext } from '../view-context';
import { WeatherDaySlot, WeatherSlot } from '../weather/views';
import type { PlannedBanner } from '../week-plan/plan';
import {
  PlannedWeekBanner,
  PlanWeekForm,
  UndoneToast,
} from '../week-plan/views';
import { dateParts, type IsoDate } from '../../calendar-date';
import type { CalendarDayView, CalendarView } from './calendar-view';
import { CalendarTabs } from './calendar-tabs';
import {
  DAY_LETTERS,
  dayLabel,
  occasionLabel,
  weekRangeLabel,
} from '../date-labels';
import { OccasionRow, OpenSlotRow } from './occasion-row';
import { OPEN_PLAN_SHEET, PlanSheet, planSheetChoice } from './plan-sheet';
import { dayAnchor, weekUrl } from './urls';
import { AwayLink } from '../trips/away-link';
import { WEEK_COLUMNS, WEEK_STRIP } from '../layout/columns';

/**
 * GET /calendar: the week as an agenda (R6; docs/plans/2026-09-26-redesign.md,
 * Calendar). The Week, Month and Trips tabs; today's weather (#14, loaded
 * after the page, src/web/weather/views.tsx); "Plan my week" (#16) and,
 * after it, the banner of what it planned with Undo; the week's ‹ › and its
 * strip of days; then a block per day, Sunday to Saturday: its weather chip,
 * "Away" linking to each trip the day is one of (#684), its entries in occasion order (OccasionRow), the week template's
 * occasions it has no outfit for yet (OpenSlotRow), the selfies kept after
 * their outfit went (DayLooks, #19) and "+ Plan", which opens the day's
 * sheet (PlanSheet), unless an open slot already does. `data-day` on each block is what the specs split days
 * on (test/integration/calendar-page.ts).
 *
 * From lg (#467) the same markup is a grid, CSS alone (the page is a cached
 * tab root, the same bytes for every viewport): the days are columns and
 * the week's occasions (`weekOccasions`) rows lined up across them, each
 * day a subgrid of the week's rows (WEEK_ROWS, ROW_START below).
 */
export function CalendarPage(props: {
  ctx: ViewContext;
  view: CalendarView;
  /** The gallery's pick or a save found its outfit already saved (?alreadySaved=). */
  alreadySaved?: AlreadySaved;
  /** After "Plan my week" (#16, ?planned=). */
  banner?: PlannedBanner;
  /** After its Undo (?undone=N): the entries removed. */
  undone?: number;
  /** The first-run gate (#666): without an outfit's worth of closet, no "Plan my week". */
  canDress: boolean;
}) {
  const { ctx, view } = props;
  const first = view.days[0].date;
  const last = view.days[view.days.length - 1].date;
  return (
    <Layout ctx={ctx} title={t('CALENDAR_PAGE_TITLE')}>
      <AppBar ctx={ctx} title={t('CALENDAR')} />
      <PageMain width="agenda" class="p-4 pt-20 pb-24">
        <CalendarTabs active="week" />
        <WeatherSlot ctx={ctx} days={{ from: first, to: last }} />
        {props.banner && (
          <PlannedWeekBanner banner={props.banner} shown={{ first, last }} />
        )}
        {props.canDress && <PlanWeekForm class="mb-3" small />}
        <nav
          class="flex items-center justify-between gap-2"
          aria-label={t('calendar.WEEK_NAV')}
        >
          <a
            href={weekUrl(view.prevWeek)}
            class="btn btn-ghost btn-sm btn-square"
            aria-label={t('calendar.PREV_WEEK')}
          >
            ‹
          </a>
          <p class="font-semibold" data-week={first}>
            {weekRangeLabel(first, last)}
          </p>
          <a
            href={weekUrl(view.nextWeek)}
            class="btn btn-ghost btn-sm btn-square"
            aria-label={t('calendar.NEXT_WEEK')}
          >
            ›
          </a>
        </nav>
        <WeekStrip view={view} />
        <div
          class={`${WEEK_COLUMNS} lg:mt-3 ${WEEK_ROWS[view.weekOccasions.length]}`}
        >
          {view.days.map((day) => (
            <DaySection
              ctx={ctx}
              day={day}
              occasions={view.weekOccasions}
              canDress={props.canDress}
            />
          ))}
        </div>
        {/* Outside the day blocks: each is a form of its own, and the
            specs read a day's block for its entries alone. */}
        {view.days.map((day) => (
          <PlanSheet day={day.date} />
        ))}
      </PageMain>
      <AlreadySavedToast kind={props.alreadySaved} />
      <UndoneToast removed={props.undone} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The week's days at a glance, each a link down to its block: the letter,
 * the date (today filled) and a dot when something is planned.
 */
function WeekStrip({ view }: { view: CalendarView }) {
  return (
    <ol class={`${WEEK_STRIP} my-2 text-center select-none lg:hidden`}>
      {view.days.map((day) => (
        <li>
          <a
            href={`#${dayAnchor(day.date)}`}
            class="flex flex-col items-center gap-0.5 py-1 rounded-field hover:bg-base-200"
            aria-label={dayLabel(day.date)}
            aria-current={day.isToday ? 'date' : undefined}
          >
            <span class="text-xs text-muted">
              {t(DAY_LETTERS[day.weekday])}
            </span>
            <span
              class={`flex items-center justify-center size-8 rounded-full text-sm font-semibold ${day.isToday ? 'bg-primary text-primary-content' : ''}`}
            >
              {dateParts(day.date).day}
            </span>
            <span
              class={`size-1 rounded-full ${day.entries.length > 0 ? 'bg-accent' : ''}`}
            ></span>
          </a>
        </li>
      ))}
    </ol>
  );
}

/**
 * The desktop grid's rows (#467): the day's heading, one per week occasion,
 * its looks, then its "+ Plan". Indexed by the number of week occasions
 * (0 to all six); whole class names, so Tailwind finds them.
 */
const WEEK_ROWS = [
  'lg:grid-rows-[repeat(3,auto)]',
  'lg:grid-rows-[repeat(4,auto)]',
  'lg:grid-rows-[repeat(5,auto)]',
  'lg:grid-rows-[repeat(6,auto)]',
  'lg:grid-rows-[repeat(7,auto)]',
  'lg:grid-rows-[repeat(8,auto)]',
  'lg:grid-rows-[repeat(9,auto)]',
] as const;

/** The grid row a day's piece sits on from lg, 1-based (WEEK_ROWS' order). */
const ROW_START = [
  'lg:row-start-1',
  'lg:row-start-2',
  'lg:row-start-3',
  'lg:row-start-4',
  'lg:row-start-5',
  'lg:row-start-6',
  'lg:row-start-7',
  'lg:row-start-8',
  'lg:row-start-9',
] as const;

function rowStart(row: number): string {
  return ROW_START[row - 1];
}

/**
 * One day: a block of the agenda on a phone, a column of the grid from lg.
 * Its pieces keep the phone's order (entries, then open slots, both in
 * occasion order; looks; "+ Plan") and are placed on the week's rows by
 * `lg:row-start-*`, so the phone's box tree is the one it always had: the
 * cell wrappers are `contents` below lg. A week occasion the day has nothing
 * for is a desktop-only cell, from today on an opener of the day's sheet
 * with that occasion chosen (the phone keeps one way in per day). The
 * desktop's focus order is therefore the phone's, not the grid's, where an
 * open slot sits above an entry of a later occasion.
 */
function DaySection({
  ctx,
  day,
  occasions,
  canDress,
}: {
  ctx: ViewContext;
  day: CalendarDayView;
  occasions: readonly Occasion[];
  /** The first-run gate (#666): an empty closet has nothing to plan with. */
  canDress: boolean;
}) {
  const occasionRow = (occasion: Occasion) =>
    rowStart(occasions.indexOf(occasion) + 2);
  const filled = new Set<Occasion>([
    ...day.entries.map((entry) => entry.occasion),
    ...day.openSlots,
  ]);
  return (
    <section
      id={dayAnchor(day.date)}
      class="scroll-mt-20 py-3 border-t border-base-300 lg:grid lg:grid-rows-subgrid lg:row-span-full lg:content-start lg:p-1 lg:border-t-0 lg:rounded-box lg:target:ring-2 lg:target:ring-primary"
      data-day={day.date}
      aria-labelledby={`${dayAnchor(day.date)}-title`}
    >
      <div
        class={`flex flex-wrap items-baseline gap-x-2 lg:flex-col lg:flex-nowrap lg:gap-0.5 lg:pb-1 lg:border-b lg:border-base-300 ${rowStart(1)}`}
      >
        <DayHeading
          as="h2"
          id={`${dayAnchor(day.date)}-title`}
          date={day.date}
          isToday={day.isToday}
        />
        <WeatherDaySlot ctx={ctx} day={day.date} />
        {day.away.map((trip) => (
          // In the heading's row, so the desktop grid needs no row of its
          // own; on a phone it wraps under the date.
          <AwayLink trip={trip} class="basis-full lg:basis-auto" />
        ))}
      </div>
      {OCCASIONS.filter((occasion) =>
        day.entries.some((entry) => entry.occasion === occasion),
      ).map((occasion) => (
        <div
          class={`contents lg:flex lg:flex-col lg:gap-2 ${occasionRow(occasion)}`}
          data-cell={occasion}
        >
          {day.entries
            .filter((entry) => entry.occasion === occasion)
            .map((entry) => (
              <OccasionRow
                entry={entry}
                future={day.isFuture}
                past={!day.isToday && !day.isFuture}
              />
            ))}
        </div>
      ))}
      {day.openSlots.map((occasion) => (
        <div
          class={`contents lg:flex lg:flex-col ${occasionRow(occasion)}`}
          data-cell={occasion}
        >
          <OpenSlotRow day={day.date} occasion={occasion} />
        </div>
      ))}
      {/* Past days get nothing: there is nothing left to plan there. */}
      {(day.isToday || day.isFuture) &&
        occasions
          .filter((occasion) => !filled.has(occasion))
          .map((occasion) => (
            <div
              class={`hidden lg:flex lg:flex-col ${occasionRow(occasion)}`}
              data-cell={occasion}
            >
              <EmptyCellPlan day={day.date} occasion={occasion} />
            </div>
          ))}
      {day.looks.length > 0 && (
        <DayLooks day={day} class={rowStart(occasions.length + 2)} />
      )}
      {/* One way into the sheet per day: an open slot opens the same sheet
          (every occasion on it), so the day's own button would say it
          twice. */}
      {canDress && day.openSlots.length === 0 && (
        <button
          type="button"
          class={`btn btn-ghost btn-sm mt-1 -ms-3 font-normal text-muted lg:ms-0 lg:justify-start ${rowStart(occasions.length + 3)}`}
          data-plan={planSheetChoice(day.date, DEFAULT_OCCASION)}
          data-day-plan={day.date}
          onclick={OPEN_PLAN_SHEET}
        >
          +{' '}
          {day.entries.length > 0
            ? t('CALENDAR_ANOTHER_OUTFIT')
            : t('CALENDAR_PLAN')}
        </button>
      )}
    </section>
  );
}

/**
 * The desktop grid's empty cell from today on (#467): a quiet "+" naming
 * the row's occasion, opening the day's sheet with it chosen. Not an
 * OpenSlotRow: the template did not ask for it, so it neither says "Plan"
 * like a slot nor counts as one (`data-open-slot`).
 */
function EmptyCellPlan(props: { day: IsoDate; occasion: Occasion }) {
  const { day, occasion } = props;
  return (
    <button
      type="button"
      class="btn btn-ghost btn-sm w-full font-normal text-muted border border-dashed border-base-300"
      data-plan={planSheetChoice(day, occasion)}
      data-cell-plan={occasion}
      aria-label={t('calendar.PLAN_CELL', {
        occasion: occasionLabel(occasion),
        day: dayLabel(day),
      })}
      onclick={OPEN_PLAN_SHEET}
    >
      + {occasionLabel(occasion)}
    </button>
  );
}

/**
 * The day's selfies no entry holds any more, their outfit deleted (#19) or
 * the entry changed to another (#69): kept as the record of
 * what was worn, like the day's wears, with nothing left to edit but the
 * photo itself.
 */
function DayLooks(props: { day: CalendarDayView; class: string }) {
  const { day } = props;
  return (
    <div
      class={`flex flex-col gap-0.5 py-2 ${props.class}`}
      data-looks={day.date}
    >
      <span class="text-xs font-semibold uppercase tracking-wide text-muted">
        {t('selfie.DETACHED')}
      </span>
      <div class="flex flex-wrap gap-1">
        {day.looks.map((look) => (
          <SelfieView
            selfie={look}
            day={look.day}
            entryId={null}
            returnTo={weekUrl(day.date)}
            size="row"
          />
        ))}
      </div>
    </div>
  );
}
