import type { IsoDate } from '../calendar-date';
import { shortDayYearLabel } from './date-labels';

/**
 * How the page's script words a day (src/page-day.ts's dayText, which
 * mirrors date-labels.ts's relativeDay and dateLabel): "relative" reads "today",
 * "yesterday", "3 days ago" up to six, then as "date" does, "Tue, Sep 29" in
 * the page's year, else "Sep 29, 2025".
 */
export type DayLabelKind = 'relative' | 'date';

/**
 * A day worded against the page's day by the client, never the server's
 * today (#708): a page must render byte for byte the same from one day to
 * the next, or its ETag (send(), src/web/render.ts) changes daily and the
 * offline warm downloads it again. The server's text, "Sep 29, 2025", is
 * what shows before the script runs.
 */
export function DayTime(props: { day: IsoDate; kind: DayLabelKind }) {
  return (
    <time datetime={props.day} data-day-label={props.kind}>
      {shortDayYearLabel(props.day)}
    </time>
  );
}

/**
 * A date input whose default is the household's today, set by the client
 * (showPageDay, views/assets/outbox.ts) for the same reason as DayTime: the
 * outfit page's Plan sheet. Without the script the field starts empty and
 * `required` asks for a day.
 */
export const defaultsToToday = { 'data-value-today': '' } as const;
