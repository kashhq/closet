import type { Occasion } from '../wardrobe/occasions';
import { t, type CopyKey, type Translated } from './i18n';
import {
  dateParts,
  dayOfWeek,
  daysBetween,
  type IsoDate,
  type YearMonth,
} from '../calendar-date';

/**
 * The app's one vocabulary for dates (#356): every day a user reads is one
 * of these, never a raw ISO date (`test/integration/date-labels.spec.ts`).
 * A label relative to today takes the household's date
 * (`todayIn(APP_TIMEZONE, now)`), never the server's.
 */

/**
 * Each weekday's strings, Sunday first (a weekday's index, 0 = Sunday): its
 * name ("Tuesday"), its abbreviation ("Tue") and the calendar's column
 * letter ("T"). Every key is a literal, so a missing catalog entry is a type
 * error and src/i18n/unused-keys.spec.ts finds each one used.
 */
const WEEKDAY_KEYS: readonly (readonly [CopyKey, CopyKey, CopyKey])[] = [
  ['CALENDAR_DAY_SUN', 'calendar.weekday.SUN', 'CALENDAR_CAL_SUN_LETTER'],
  ['CALENDAR_DAY_MON', 'calendar.weekday.MON', 'CALENDAR_CAL_MON_LETTER'],
  ['CALENDAR_DAY_TUE', 'calendar.weekday.TUE', 'CALENDAR_CAL_TUE_LETTER'],
  ['CALENDAR_DAY_WED', 'calendar.weekday.WED', 'CALENDAR_CAL_WED_LETTER'],
  ['CALENDAR_DAY_THU', 'calendar.weekday.THU', 'CALENDAR_CAL_THU_LETTER'],
  ['CALENDAR_DAY_FRI', 'calendar.weekday.FRI', 'CALENDAR_CAL_FRI_LETTER'],
  ['CALENDAR_DAY_SAT', 'calendar.weekday.SAT', 'CALENDAR_CAL_SAT_LETTER'],
];

/** Each month's strings, January first (index month - 1): "Sep" and "September". */
const MONTH_KEYS: readonly (readonly [CopyKey, CopyKey])[] = [
  ['MONTH_JAN', 'calendar.month.JAN'],
  ['MONTH_FEB', 'calendar.month.FEB'],
  ['MONTH_MAR', 'calendar.month.MAR'],
  ['MONTH_APR', 'calendar.month.APR'],
  ['MONTH_MAY', 'calendar.month.MAY'],
  ['MONTH_JUN', 'calendar.month.JUN'],
  ['MONTH_JUL', 'calendar.month.JUL'],
  ['MONTH_AUG', 'calendar.month.AUG'],
  ['MONTH_SEP', 'calendar.month.SEP'],
  ['MONTH_OCT', 'calendar.month.OCT'],
  ['MONTH_NOV', 'calendar.month.NOV'],
  ['MONTH_DEC', 'calendar.month.DEC'],
];

export const DAY_NAMES: readonly CopyKey[] = WEEKDAY_KEYS.map(([name]) => name);
export const DAY_LETTERS: readonly CopyKey[] = WEEKDAY_KEYS.map(
  ([, , letter]) => letter,
);
const DAY_SHORT_NAMES: readonly CopyKey[] = WEEKDAY_KEYS.map(
  ([, short]) => short,
);
const MONTH_NAMES: readonly CopyKey[] = MONTH_KEYS.map(([short]) => short);
/** The month page's title. */
const MONTH_LONG_NAMES: readonly CopyKey[] = MONTH_KEYS.map(([, long]) => long);

/** "Tuesday, Sep 29". */
export function dayLabel(date: IsoDate): Translated {
  const { month, day } = dateParts(date);
  return t('CALENDAR_PLAN_DAY', {
    weekday: t(DAY_NAMES[dayOfWeek(date)]),
    month: t(MONTH_NAMES[month - 1]),
    day,
  });
}

/** "Sep 29". */
export function shortDayLabel(date: IsoDate): Translated {
  const { month, day } = dateParts(date);
  return t('calendar.SHORT_DAY', { month: t(MONTH_NAMES[month - 1]), day });
}

/** "Sep 29, 2025". */
export function shortDayYearLabel(date: IsoDate): Translated {
  const { year, month, day } = dateParts(date);
  return t('calendar.SHORT_DAY_YEAR', {
    month: t(MONTH_NAMES[month - 1]),
    day,
    year,
  });
}

/**
 * A date read on its own (the date a garment was acquired): "Tue, Sep 29"
 * in today's year, else "Sep 29, 2025".
 */
export function dateLabel(date: IsoDate, today: IsoDate): Translated {
  if (dateParts(date).year !== dateParts(today).year) {
    return shortDayYearLabel(date);
  }
  const { month, day } = dateParts(date);
  return t('CALENDAR_PLAN_DAY', {
    weekday: t(DAY_SHORT_NAMES[dayOfWeek(date)]),
    month: t(MONTH_NAMES[month - 1]),
    day,
  });
}

/**
 * A past day from today: "today", "yesterday", "3 days ago" up to six, then
 * `dateLabel`. Lower case: it ends a sentence ("Last worn yesterday").
 */
export function relativeDay(day: IsoDate, today: IsoDate): Translated {
  const days = daysBetween(day, today);
  if (days === 0) return t('wear.TODAY');
  if (days === 1) return t('wear.YESTERDAY');
  if (days > 1 && days < 7) return t('wear.DAYS_AGO', { days });
  return dateLabel(day, today);
}

/**
 * The week's heading: "Sep 27 – Oct 3, 2026", or "Dec 29, 2030 – Jan 4,
 * 2031" across a new year. Always with the year: the app bar says only
 * "Calendar", so a `?week=` of another year would otherwise read like this
 * one's. The same for every week, so `/calendar` stays byte-stable.
 */
export function weekRangeLabel(first: IsoDate, last: IsoDate): Translated {
  const from = dateParts(first);
  const to = dateParts(last);
  if (from.year === to.year) {
    return t('calendar.WEEK_RANGE', {
      from: shortDayLabel(first),
      to: shortDayLabel(last),
      year: to.year,
    });
  }
  return t('calendar.WEEK_RANGE_YEARS', {
    from: shortDayYearLabel(first),
    to: shortDayYearLabel(last),
  });
}

/** "September 2026" (a month page's title). */
export function monthLabel({ year, month }: YearMonth): Translated {
  return t('calendar.MONTH_TITLE', {
    month: t(MONTH_LONG_NAMES[month - 1]),
    year,
  });
}

/** "Night out". Every occasion has its catalog string: a missing one is a type error. */
export function occasionLabel(occasion: Occasion): Translated {
  return t(`occasion.${occasion}`);
}
