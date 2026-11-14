import type { IsoDate } from '../calendar-date';
import { shortDayYearLabel } from './date-labels';

/**
 * How the page's script words a day (views/assets/page-day.ts, which mirrors
 * date-labels.ts's relativeDay and dateLabel): "relative" reads "today",
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
