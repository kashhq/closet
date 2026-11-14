import type { Occasion } from '../wardrobe/occasions';
import { t, type StringKey } from './i18n';
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

/** Indexed by weekday, 0 = Sunday. */
export const DAY_NAMES: StringKey[] = [
  'CALENDAR_DAY_SUN',
  'CALENDAR_DAY_MON',
  'CALENDAR_DAY_TUE',
  'CALENDAR_DAY_WED',
  'CALENDAR_DAY_THU',
  'CALENDAR_DAY_FRI',
  'CALENDAR_DAY_SAT',
];

export const DAY_LETTERS: StringKey[] = [
  'CALENDAR_CAL_SUN_LETTER',
  'CALENDAR_CAL_MON_LETTER',
  'CALENDAR_CAL_TUE_LETTER',
  'CALENDAR_CAL_WED_LETTER',
  'CALENDAR_CAL_THU_LETTER',
  'CALENDAR_CAL_FRI_LETTER',
  'CALENDAR_CAL_SAT_LETTER',
];

/** Indexed by weekday, 0 = Sunday: "Tue". */
const DAY_SHORT_NAMES: StringKey[] = [
  'calendar.weekday.SUN',
  'calendar.weekday.MON',
  'calendar.weekday.TUE',
  'calendar.weekday.WED',
  'calendar.weekday.THU',
  'calendar.weekday.FRI',
  'calendar.weekday.SAT',
];

/** Indexed by month - 1. */
const MONTH_NAMES: StringKey[] = [
  'MONTH_JAN',
  'MONTH_FEB',
  'MONTH_MAR',
  'MONTH_APR',
  'MONTH_MAY',
  'MONTH_JUN',
  'MONTH_JUL',
  'MONTH_AUG',
  'MONTH_SEP',
  'MONTH_OCT',
  'MONTH_NOV',
  'MONTH_DEC',
];

/** Indexed by month - 1: the month page's title. */
const MONTH_LONG_NAMES: StringKey[] = [
  'calendar.month.JAN',
  'calendar.month.FEB',
  'calendar.month.MAR',
  'calendar.month.APR',
  'calendar.month.MAY',
  'calendar.month.JUN',
  'calendar.month.JUL',
  'calendar.month.AUG',
  'calendar.month.SEP',
  'calendar.month.OCT',
  'calendar.month.NOV',
  'calendar.month.DEC',
];

/** "Tuesday, Sep 29". */
export function dayLabel(date: IsoDate): string {
  const { month, day } = dateParts(date);
  return t('CALENDAR_PLAN_DAY', {
    weekday: t(DAY_NAMES[dayOfWeek(date)]),
    month: t(MONTH_NAMES[month - 1]),
    day,
  });
}

/** "Sep 29". */
export function shortDayLabel(date: IsoDate): string {
  const { month, day } = dateParts(date);
  return t('calendar.SHORT_DAY', { month: t(MONTH_NAMES[month - 1]), day });
}

/** "Sep 29, 2025". */
export function shortDayYearLabel(date: IsoDate): string {
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
export function dateLabel(date: IsoDate, today: IsoDate): string {
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
export function relativeDay(day: IsoDate, today: IsoDate): string {
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
export function weekRangeLabel(first: IsoDate, last: IsoDate): string {
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
export function monthLabel({ year, month }: YearMonth): string {
  return t('calendar.MONTH_TITLE', {
    month: t(MONTH_LONG_NAMES[month - 1]),
    year,
  });
}

/** "Night out". Every occasion has its catalog string: a missing one is a type error. */
export function occasionLabel(occasion: Occasion): string {
  return t(`occasion.${occasion}`);
}
