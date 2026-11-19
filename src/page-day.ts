/**
 * The page's day (#708): what a page shows of "today" is worded and decided
 * in the page, against the day its copy is of, never baked in by the server,
 * so a page renders byte for byte the same from one day to the next and its
 * ETag holds (send(), src/web/render.ts): the offline warm then refreshes it
 * for the cost of its headers. Pure, for views/assets/outbox.ts, which
 * applies it (src/web/shell/outbox.md); src/web/day-time.tsx, the garment
 * page's Wore today (src/web/wears/wear-section.tsx) and the outfit page's
 * Plan sheet are the server's half.
 */

import { daysBetween, type IsoDate, todayIn } from './calendar-date';

/**
 * The household's date of a copy's stamp (`#freshness`'s `data-fetched-at`,
 * epoch ms: when the server produced or last confirmed what is on screen,
 * views/assets/page/freshness.ts), or undefined for a missing or unreadable one.
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
 * The day a page's copy is of: its stamp's (dayOfStamp), else the day its
 * body arrived (`arrivedAt`, epoch ms: BodyArrivals). A page without
 * freshness.js (PWA_ENABLED off) never gets a stamp, and one fetched from
 * the network is of its arrival.
 */
export function pageDay(
  stamp: string | undefined,
  arrivedAt: number,
  timeZone: string,
): IsoDate {
  return dayOfStamp(stamp, timeZone) ?? todayIn(timeZone, new Date(arrivedAt));
}

/**
 * When the body on screen arrived from the server, for a page nothing
 * stamps (PWA_ENABLED off, where freshness.js is not loaded; #990, #900). The
 * document's load is only the first page's: a boosted navigation swaps in
 * a body that arrived now, and htmx's history restores a snapshot that
 * arrived when it was first shown, so each arrival is kept by the page's
 * path (htmx's snapshot key). A path pushed by a fragment (the wardrobe's
 * filters) is of the body it was pushed on. A restore of a path never
 * seen keeps the current arrival.
 */
export class BodyArrivals {
  #current: number;
  readonly #byPath = new Map<string, number>();

  constructor(path: string, loadedAt: number) {
    this.#current = loadedAt;
    this.#byPath.set(path, loadedAt);
  }

  /** When the body on screen arrived (epoch ms). */
  get current(): number {
    return this.#current;
  }

  /** A body from the server, now at `path`: a boosted navigation, a history cache miss. */
  arrived(path: string, at: number): void {
    this.#current = at;
    this.#byPath.set(path, at);
  }

  /** The body on screen, now also at `path` (a fragment pushed its URL). */
  pushed(path: string): void {
    this.#byPath.set(path, this.#current);
  }

  /** htmx's snapshot of `path` back on screen. */
  restored(path: string): void {
    this.#current = this.#byPath.get(path) ?? this.#current;
  }
}

/**
 * Whether a Wore today tap may queue: its row's state was judged on the
 * tap's day. `judgedOn` is a live answer's own day (`data-as-of-day`), or
 * undefined for the page's row, judged on the tap's day itself (wornState
 * reads `data-worn-on`, which no day changes, and the server's
 * setWoreToday is idempotent). An answer left on screen overnight is of
 * yesterday: its undo would undo the wrong day.
 */
export function wearQueuesOn(
  judgedOn: IsoDate | undefined,
  tapDay: IsoDate,
): boolean {
  return judgedOn === undefined || judgedOn === tapDay;
}

/** How a garment was worn on the page's day: its Wore today row's state. */
export type WornState = 'unworn' | 'single' | 'entry';

/**
 * The garment's last day worn and how (`data-worn-on`, `data-worn-by`,
 * WearSummary.lastWornBy) read on `day`, the day a tap would log: worn by
 * Wore today (the undo shows), by a worn calendar entry (the calendar's
 * badge), or not.
 */
export function wornState(
  wornOn: string | undefined,
  wornBy: string | undefined,
  day: IsoDate,
): WornState {
  if (wornOn !== day) return 'unworn';
  return wornBy === 'single' || wornBy === 'entry' ? wornBy : 'unworn';
}

/**
 * Whether a Wore today row must flip (swap in its template's form) to show
 * `state`: it shows the undo (`showsUndo`), and a row showing a queued
 * intent (`flipped`) shows the opposite of what the server rendered.
 */
export function wearRowFlips(
  state: WornState,
  showsUndo: boolean,
  flipped: boolean,
): boolean {
  const served = flipped ? !showsUndo : showsUndo;
  return served !== (state === 'single');
}
