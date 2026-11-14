/**
 * The page's day (#708): what a page shows of "today" is worded and decided
 * in the page, against the day its copy is of, never baked in by the server,
 * so a page renders byte for byte the same from one day to the next and its
 * ETag holds (send(), src/web/render.ts): the offline warm then refreshes it
 * for the cost of its headers. Pure, for views/assets/outbox.ts, which
 * applies it (src/web/shell/outbox.md); src/web/day-time.tsx and the garment
 * page's Wore today (src/web/wears/wear-section.tsx) are the server's half.
 */

import { daysBetween, type IsoDate, todayIn } from './calendar-date';

/**
 * The household's date of a copy's stamp (`#freshness`'s `data-fetched-at`,
 * epoch ms: when the server produced or last confirmed what is on screen,
 * public/js/freshness.js), or undefined for a missing or unreadable one.
 */
export function dayOfStamp(
  stamp: string | undefined,
  timeZone: string,
): IsoDate | undefined {
  const ms = Number(stamp);
  if (!stamp || !Number.isFinite(ms) || ms <= 0) return undefined;
  return todayIn(timeZone, new Date(ms));
}

/**
 * A day worded against the page's day, as src/web/date-labels.ts's
 * relativeDay ("today", "yesterday", "3 days ago" up to six) and dateLabel
 * ("Tue, Sep 29" in the page's year, else "Sep 29, 2025") word it; "date"
 * is dateLabel alone. Intl's English matches the catalog's words, as
 * age-label.js relies on.
 */
export function dayText(
  day: IsoDate,
  pageDay: IsoDate,
  kind: 'relative' | 'date',
  locale: string,
): string {
  const days = daysBetween(day, pageDay);
  if (kind === 'relative' && days >= 0 && days < 7) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      -days,
      'day',
    );
  }
  const sameYear = day.slice(0, 4) === pageDay.slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? { weekday: 'short' } : { year: 'numeric' }),
  }).format(new Date(`${day}T00:00:00Z`));
}

/**
 * Whether a Wore today tap may queue: only from a page of the tap's day
 * (its state is that day's; a page left open overnight is of yesterday), and
 * never from one whose day is unknown, so nothing queues under no day.
 */
export function wearQueuesOn(
  pageDay: IsoDate | undefined,
  tapDay: IsoDate,
): boolean {
  return pageDay !== undefined && pageDay === tapDay;
}

/** How a garment was worn on the page's day: its Wore today row's state. */
export type WornState = 'unworn' | 'single' | 'entry';

/**
 * The garment's last day worn and how (`data-worn-on`, `data-worn-by`,
 * WearSummary.lastWornBy) read on the page's day: worn by Wore today (the
 * undo shows), by a worn calendar entry (the calendar's badge), or not.
 */
export function wornState(
  wornOn: string | undefined,
  wornBy: string | undefined,
  pageDay: IsoDate,
): WornState {
  if (wornOn !== pageDay) return 'unworn';
  return wornBy === 'single' || wornBy === 'entry' ? wornBy : 'unworn';
}
