import { addDays, instantAt, type IsoDate } from '../../src/calendar-date';
import type { LastWash, WearInstant } from '../../src/wardrobe/availability';

/**
 * The wash rule's case table (#676): wearsSinceWash
 * (src/wardrobe/availability.spec.ts) and its SQL twin wearsSinceWashSql
 * (test/integration/wears.spec.ts) each answer every row, and both must
 * give `count`. Days are offsets from the wash day (0), hours that day's
 * wall clock in the time zone the caller dates them in; a null hour is an
 * instant not known (a backfilled wear, a timeless wash).
 */
export interface WashCase {
  name: string;
  wears: { day: number; hour: number | null }[];
  /** Null: never washed. `instantDay` puts washed_at on another day than its own. */
  wash: { hour: number | null; instantDay?: number } | null;
  count: number;
}

export const WASH_CASES: readonly WashCase[] = [
  {
    name: 'never washed',
    wears: [{ day: -2, hour: null }],
    wash: null,
    count: 1,
  },
  {
    name: 'worn the day before',
    wears: [{ day: -1, hour: 19 }],
    wash: { hour: 9 },
    count: 0,
  },
  {
    name: 'worn the day after',
    wears: [{ day: 1, hour: null }],
    wash: { hour: 9 },
    count: 1,
  },
  {
    name: 'washed 09:00, worn 19:00',
    wears: [{ day: 0, hour: 19 }],
    wash: { hour: 9 },
    count: 1,
  },
  {
    name: 'worn 08:00, washed 21:00',
    wears: [{ day: 0, hour: 8 }],
    wash: { hour: 21 },
    count: 0,
  },
  {
    name: 'backfilled wear on the wash day',
    wears: [{ day: 0, hour: null }],
    wash: { hour: 9 },
    count: 0,
  },
  {
    name: 'timeless wash, wear at 19:00',
    wears: [{ day: 0, hour: 19 }],
    wash: { hour: null },
    count: 0,
  },
  {
    name: 'timeless wash, backfilled wear',
    wears: [{ day: 0, hour: null }],
    wash: { hour: null },
    count: 0,
  },
  {
    name: 'worn at the wash instant',
    wears: [{ day: 0, hour: 9 }],
    wash: { hour: 9 },
    count: 0,
  },
  {
    name: 'worn before and after the wash, one day',
    wears: [
      { day: 0, hour: 8 },
      { day: 0, hour: 19 },
    ],
    wash: { hour: 9 },
    count: 1,
  },
  {
    name: 'worn that evening and the next day',
    wears: [
      { day: 0, hour: 19 },
      { day: 1, hour: 12 },
    ],
    wash: { hour: 9 },
    count: 2,
  },
  {
    // markWashed never writes one (instantOnDay); the twins compare
    // instants alone, so a washed_at the day before reads as earlier than
    // every wear of the wash day.
    name: 'washed_at on the day before its last_washed_on',
    wears: [{ day: 0, hour: 8 }],
    wash: { hour: 20, instantDay: -1 },
    count: 1,
  },
];

/** A case's wears and wash, dated from `washDay` in `timeZone`. */
export function washCaseRows(
  c: WashCase,
  washDay: IsoDate,
  timeZone: string,
): { wears: WearInstant[]; lastWash: LastWash | null } {
  const at = (day: number, hour: number | null) =>
    hour === null
      ? null
      : instantAt(addDays(washDay, day), hour, timeZone).getTime();
  return {
    wears: c.wears.map((w) => ({
      day: addDays(washDay, w.day),
      wornAt: at(w.day, w.hour),
    })),
    lastWash: c.wash && {
      day: washDay,
      washedAt: at(c.wash.instantDay ?? 0, c.wash.hour),
    },
  };
}

/**
 * Whether a wash replaces the stored last wash (#793): washMoves
 * (src/wardrobe/availability.spec.ts) and markWashed's update
 * (test/integration/wears.spec.ts) each answer every row, and both must
 * give `moves`. `stored` is the garment's last wash (null: never washed),
 * `next` the wash posted; days and hours as in WashCase.
 */
export interface WashMoveCase {
  name: string;
  stored: { day: number; hour: number | null } | null;
  next: { day: number; hour: number | null };
  moves: boolean;
}

export const WASH_MOVE_CASES: readonly WashMoveCase[] = [
  {
    name: 'never washed',
    stored: null,
    next: { day: 0, hour: null },
    moves: true,
  },
  {
    name: 'a later day, timeless over known',
    stored: { day: -1, hour: 21 },
    next: { day: 0, hour: null },
    moves: true,
  },
  {
    name: 'an earlier day',
    stored: { day: 0, hour: null },
    next: { day: -1, hour: 21 },
    moves: false,
  },
  {
    name: 'the same day, a later known instant',
    stored: { day: 0, hour: 9 },
    next: { day: 0, hour: 21 },
    moves: true,
  },
  {
    name: 'the same day, an earlier known instant',
    stored: { day: 0, hour: 21 },
    next: { day: 0, hour: 9 },
    moves: false,
  },
  {
    name: 'the same day and instant (a repeat)',
    stored: { day: 0, hour: 9 },
    next: { day: 0, hour: 9 },
    moves: false,
  },
  {
    // An old client's replay must not uncount the evening's wear.
    name: 'the same day, timeless over known',
    stored: { day: 0, hour: 9 },
    next: { day: 0, hour: null },
    moves: false,
  },
  {
    // The timeless one may have been at 21:00: 09:00 would count a 19:00 wear after it.
    name: 'the same day, known over timeless',
    stored: { day: 0, hour: null },
    next: { day: 0, hour: 9 },
    moves: false,
  },
  {
    name: 'the same day, timeless over timeless',
    stored: { day: 0, hour: null },
    next: { day: 0, hour: null },
    moves: false,
  },
];

/** A move case's stored and posted washes, dated from `day0` in `timeZone`. */
export function washMoveRows(
  c: WashMoveCase,
  day0: IsoDate,
  timeZone: string,
): { stored: LastWash | null; next: LastWash & { day: IsoDate } } {
  const wash = ({ day, hour }: { day: number; hour: number | null }) => ({
    day: addDays(day0, day),
    washedAt:
      hour === null
        ? null
        : instantAt(addDays(day0, day), hour, timeZone).getTime(),
  });
  return { stored: c.stored && wash(c.stored), next: wash(c.next) };
}
