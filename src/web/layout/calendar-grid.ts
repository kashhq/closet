import { MONTH_DAY, WEEK_COLUMNS, WEEK_STRIP } from './columns';

/**
 * The Calendar's desktop step, by role (#1070): the week grid (#467) and the
 * month's cells. A calendar page writes its phone classes and appends the
 * role's string here, so its markup reads as the phone sees it and every
 * `lg:` of the Calendar lives in this one file, where lg-check counts it
 * (a feature's map, not an exempt primitive: scripts/ci/lg_count.conf).
 * Used by calendar-page.tsx, occasion-row.tsx and month-page.tsx.
 * Whole class names, so Tailwind finds them.
 *
 * The week is one markup for every viewport (a cached tab root): below lg
 * an agenda of day blocks, from lg a grid whose columns are the days and
 * whose rows are the week's occasions. Each day is a subgrid of the
 * wrapper's rows (`weekRows`) and places its pieces with `weekRow`; the
 * cell wrappers are `contents` below lg, so the phone's box tree is the one
 * it always had.
 */
export const WEEK_GRID = {
  /** The phone's strip of days, linking down to each block: the grid's columns say it from lg. */
  strip: `${WEEK_STRIP} lg:hidden`,
  /** A day: a block of the agenda, a column of the grid from lg; `:target` rings the day a link lands on. */
  day: 'lg:grid lg:grid-rows-subgrid lg:row-span-full lg:content-start lg:p-1 lg:border-t-0 lg:rounded-box lg:target:ring-2 lg:target:ring-primary',
  /** The day's heading row: the date, its weather and "Away" stacked in the column. */
  head: 'lg:flex-col lg:flex-nowrap lg:gap-0.5 lg:pb-1 lg:border-b lg:border-base-300',
  /** A trip link in the heading, its own line on a phone. */
  away: 'basis-full lg:basis-auto',
  /** An occasion's cell: its entries (or its open slot) as one grid item. */
  // `flex-col gap-2` apply only once the cell is a box (from lg).
  cell: 'contents flex-col gap-2 lg:flex',
  /** A week occasion the day has nothing for: a cell the phone never draws. */
  emptyCell: 'hidden lg:flex lg:flex-col',
  /** The day's "+ Plan" at the column's foot, flush with the cards above it. */
  dayAction: 'lg:ms-0 lg:justify-start',
} as const;

/**
 * An entry of the week (OccasionRow): a row of its day's block on a phone,
 * from lg a card in its cell, the collage at the column's width with the
 * name under it, the selfie and pill wrapping below. An open slot
 * (OpenSlotRow) is the same card, dashed, without the phone's placeholder
 * thumb.
 */
export const WEEK_CARD = {
  entry: 'lg:p-2 lg:rounded-box lg:border lg:border-base-300',
  labels: 'lg:flex-wrap',
  body: 'lg:flex-wrap',
  link: 'lg:basis-full lg:flex-col lg:items-stretch lg:gap-1',
  thumb: 'lg:w-full',
  slot: 'lg:flex-col lg:items-start lg:gap-1 lg:p-2 lg:rounded-box lg:border lg:border-dashed lg:border-base-300 lg:hover:bg-base-200',
  slotThumb: 'lg:hidden',
  slotAction: 'lg:ms-0',
} as const;

/**
 * A month cell (#1070): stacked on a phone (the date, the weather chip, the
 * collage, the worn dot, "+N"); from lg the collage takes the room beside
 * the date (`MONTH_DAY`): the others are a narrow column at the cell's
 * start and the collage spans its rows, so a week of the month is one
 * collage tall. The collage stays `month` size, the phone's pieces
 * (collage.tsx: a desktop step never draws a garment smaller), which is
 * what keeps the month at about 790 px at 1440 rather than a smaller piece.
 */
export const MONTH_CELL = {
  day: `${MONTH_DAY} lg:gap-x-1 lg:justify-items-center lg:content-start`,
  collage: 'lg:col-start-2 lg:row-start-1 lg:row-span-5',
} as const;

/**
 * The week wrapper's rows: the day's heading, one per week occasion, its
 * looks, then its "+ Plan". Indexed by the number of week occasions (0 to
 * all six).
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

/** The week's wrapper, with a row per occasion the week shows. */
export function weekRows(occasions: number): string {
  return `${WEEK_COLUMNS} lg:mt-3 ${WEEK_ROWS[occasions]}`;
}

/** The grid row a day's piece sits on from lg, 1-based (`weekRows`' order). */
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

export function weekRow(row: number): string {
  return ROW_START[row - 1];
}
