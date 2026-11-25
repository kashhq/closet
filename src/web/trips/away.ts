import { type SQL, sql } from 'drizzle-orm';
import { trip } from '../../db/schema';
import type { IsoDate } from '../../calendar-date';

/**
 * The one thing the home calendar knows about trips (#684): which days the
 * owner is away, and on which trip. Trips stay standalone outfit lists
 * (AGENTS.md); this is a read, folded as a scalar subquery into the
 * statements that already read the days: the week page (weekContext), "Plan
 * my week" (planMyWeek) and the daily re-plan's claim (claimAutoEntries,
 * through awayOnSql), which skip the days it names.
 */

/** A trip as the calendar names it on its days ("Away: Lisbon"). */
export interface AwayTrip {
  id: number;
  name: string;
  destination: string | null;
  startsOn: IsoDate;
  endsOn: IsoDate;
}

/**
 * The owner's trips with a day from `first` to `last` (inclusive), by first
 * day, as a scalar subquery (a JSON list). Served by
 * trip_owner_id_starts_on_index.
 */
export function awayTripsSql(
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): SQL<AwayTrip[]> {
  return sql<AwayTrip[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${trip.id},
      'name', ${trip.name},
      'destination', ${trip.destination},
      'startsOn', ${trip.startsOn},
      'endsOn', ${trip.endsOn}
    ) order by ${trip.startsOn}, ${trip.id}), '[]')
    from ${trip}
    where ${trip.ownerId} = ${ownerId}
      and ${trip.startsOn} <= ${last}
      and ${trip.endsOn} >= ${first})`;
}

/**
 * Whether one of the owner's trips covers `day` (a date expression of the
 * statement), as a boolean column: the re-plan's claim marks each auto
 * entry by it, so the entries on days away are removed before the week is
 * read (#862). Served by trip_owner_id_starts_on_index.
 */
export function awayOnSql(ownerId: number, day: SQL): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${trip}
    where ${trip.ownerId} = ${ownerId}
      and ${trip.startsOn} <= ${day}
      and ${trip.endsOn} >= ${day})`;
}

/** The trips `day` is one of, first to start first (two may overlap). */
export function tripsOn(trips: readonly AwayTrip[], day: IsoDate): AwayTrip[] {
  // ISO dates compare correctly as strings.
  return trips.filter((t) => t.startsOn <= day && day <= t.endsOn);
}

/** `days` split by whether a trip covers them: the home days, and the days away. */
export function splitAwayDays(
  days: readonly IsoDate[],
  trips: readonly AwayTrip[],
): { home: IsoDate[]; away: IsoDate[] } {
  const home: IsoDate[] = [];
  const away: IsoDate[] = [];
  for (const day of days) {
    (tripsOn(trips, day).length > 0 ? away : home).push(day);
  }
  return { home, away };
}
