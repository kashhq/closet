import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment, garmentWear } from '../../db/schema';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import {
  type InsightGarment,
  PAIR_MIN_DAYS,
  PAIRS_LIMIT,
  type PairRow,
  RECENT_DAYS,
  type UnwornDays,
  wardrobeInsights,
  type WardrobeInsights,
} from '../../wardrobe/insights';
import {
  RECAP_MIN_WEARS,
  type RecapPeriod,
  yearRecap,
  type YearRecap,
} from '../../wardrobe/recap';
import {
  addDays,
  dateParts,
  formatIsoDate,
  type IsoDate,
} from '../../calendar-date';
import { recapPeriod } from './recap-period';
import { repairCostSql } from '../wardrobe/repairs';
import { type GarmentScope, inScope } from '../wardrobe/status';

/**
 * Insights' two statements (#17): the garments with their wear counts and
 * repair costs, and the pairs most worn together. Both are scoped to
 * `ownerId` (wears and repairs are the owner's records) and read a window
 * of days (InsightsWindow). Wears count
 * distinct days, never rows (a garment in two entries on one day is one
 * wear). Every day count is taken against the window's last day here, in
 * Postgres' date arithmetic (date - date is whole days), so the pure
 * computations (src/wardrobe/insights.ts, src/wardrobe/recap.ts) do none.
 */

/**
 * The days and garments the two statements read. `to` is the last day
 * read: no wear after it counts, and every "days since" is taken to it.
 * `from` starts the recent figures (`recentWearDays`, the pairs). `scope`
 * is which garments: the closet (insights: what one can wear now) or
 * everything owned now or once (a recap looks back, and a garment archived
 * since was still worn that year).
 */
export interface InsightsWindow {
  from: IsoDate;
  to: IsoDate;
  scope: Exclude<GarmentScope, 'wishlist'>;
}

/**
 * Insights' window: the closet over the last RECENT_DAYS, today (the
 * household's, todayIn(APP_TIMEZONE)) and the RECENT_DAYS - 1 days before.
 */
function recentWindow(today: IsoDate): InsightsWindow {
  return {
    from: addDays(today, -(RECENT_DAYS - 1)),
    to: today,
    scope: 'closet',
  };
}

/** One row per garment of the owner's in the window's scope, newest first. */
function insightGarments(
  db: Db,
  ownerId: number,
  window: InsightsWindow,
): Promise<InsightGarment<SignablePhotoRef>[]> {
  const to = sql`${window.to}::date`;
  return (
    db
      .select({
        id: garment.id,
        name: garment.name,
        category: garment.category,
        brand: garment.brand,
        colors: garment.colors,
        quantity: garment.quantity,
        price: garment.price,
        // Repairs dated up to `to`, like wears: a past year's cost per wear
        // is what the garment had cost by its December 31 (#151).
        repairCost: repairCostSql(garment.id, window.to),
        condition: garment.condition,
        photo: photoRefJson,
        acquiredOn: garment.acquiredOn,
        wearDays: sql<number>`count(distinct ${garmentWear.day})::int`,
        recentWearDays: sql<number>`(count(distinct ${garmentWear.day}) filter (where ${garmentWear.day} >= ${window.from}::date))::int`,
        lastWorn: sql<IsoDate | null>`max(${garmentWear.day})::text`,
        daysSinceWorn: sql<number | null>`(${to} - max(${garmentWear.day}))`,
        daysOwned: sql<number | null>`(${to} - ${garment.acquiredOn})`,
      })
      .from(garment)
      .leftJoin(file, eq(file.id, garment.photoId))
      // No wear after the window's last day is read: a past year's recap
      // stops at its December 31. For insights `to` is today, and this caps
      // nothing only because setEntryWorn (src/web/calendar/queries.ts)
      // refuses a future day.
      .leftJoin(
        garmentWear,
        and(
          eq(garmentWear.garmentId, garment.id),
          lte(garmentWear.day, window.to),
        ),
      )
      .where(and(eq(garment.ownerId, ownerId), inScope(window.scope)))
      .groupBy(garment.id, file.id)
      .orderBy(desc(garment.id))
  );
}

/**
 * The pairs of garments in the window's scope worn on the most of the same
 * days in the window (at least PAIR_MIN_DAYS), at most PAIRS_LIMIT, the
 * lower id first in each. Days, not entries: a pair counts once a day
 * whichever outfits held them (the shoes of the office outfit and the
 * dinner jacket that evening are worn together). Bounded by the window:
 * the self-join is over at most a year's (garment, day) pairs of one owner.
 *
 * `garment.owner_id` repeats `garment_wear.owner_id` (a wear's owner is
 * always its garment's: setEntryWorn joins on it) so the garments come
 * from the owner's index, not a scan of every account's closet (#169:
 * about a millisecond at ten accounts of 300 garments; the plan is on #175).
 */
async function wornPairs(
  db: Db,
  ownerId: number,
  window: InsightsWindow,
): Promise<PairRow[]> {
  const result = await db.execute<{ a: number; b: number; days: number }>(sql`
    with worn as (
      select distinct ${garmentWear.garmentId} as garment_id, ${garmentWear.day} as day
      from ${garmentWear}
      join ${garment} on ${garment.id} = ${garmentWear.garmentId}
      where ${garmentWear.ownerId} = ${ownerId}
        and ${garment.ownerId} = ${ownerId}
        and ${inScope(window.scope)}
        and ${gte(garmentWear.day, window.from)}
        and ${lte(garmentWear.day, window.to)}
    )
    select one.garment_id as a, other.garment_id as b, count(*)::int as days
    from worn one
    join worn other on other.day = one.day and other.garment_id > one.garment_id
    group by one.garment_id, other.garment_id
    having count(*) >= ${PAIR_MIN_DAYS}
    order by days desc, a, b
    limit ${PAIRS_LIMIT}`);
  return result.rows;
}

/**
 * Both statements over `window`, at once: insights' and a recap's rows.
 * Concurrent, so one round trip after the session's; they share no rows,
 * so they could be one statement (#169).
 */
export async function readInsightRows(
  db: Db,
  ownerId: number,
  window: InsightsWindow,
): Promise<{ garments: InsightGarment<SignablePhotoRef>[]; pairs: PairRow[] }> {
  const [garments, pairs] = await Promise.all([
    insightGarments(db, ownerId, window),
    wornPairs(db, ownerId, window),
  ]);
  return { garments, pairs };
}

/** The owner's insights: the rows over the recent window, then the computation. */
export async function readInsights(
  db: Db,
  ownerId: number,
  today: IsoDate,
  unwornDays: UnwornDays,
): Promise<WardrobeInsights<SignablePhotoRef>> {
  const { garments, pairs } = await readInsightRows(
    db,
    ownerId,
    recentWindow(today),
  );
  return wardrobeInsights(garments, pairs, unwornDays);
}

/**
 * The owner's year in review: the same rows over the period, every garment
 * owned now or once (one archived since was still that year's). The page
 * and GET /api/v1/insights/recap share it.
 */
export async function readRecap(
  db: Db,
  ownerId: number,
  period: RecapPeriod,
): Promise<YearRecap<SignablePhotoRef>> {
  const { garments, pairs } = await readInsightRows(db, ownerId, {
    from: period.from,
    to: period.to,
    scope: 'owned',
  });
  return yearRecap(garments, pairs, period);
}

/**
 * The latest year before `year` with at least RECAP_MIN_WEARS wears (the
 * recap's unit: distinct garment-days, over every garment owned now or
 * once), or null. One statement, run only when the current year is still
 * the empty state.
 */
async function latestRecapYearBefore(
  db: Db,
  ownerId: number,
  year: number,
): Promise<number | null> {
  const result = await db.execute<{ year: number }>(sql`
    select extract(year from worn.day)::int as year
    from (
      select distinct ${garmentWear.garmentId} as garment_id, ${garmentWear.day} as day
      from ${garmentWear}
      join ${garment} on ${garment.id} = ${garmentWear.garmentId}
      where ${garmentWear.ownerId} = ${ownerId}
        and ${garment.ownerId} = ${ownerId}
        and ${inScope('owned')}
        and ${lte(garmentWear.day, formatIsoDate(year - 1, 12, 31))}
    ) worn
    group by 1
    having count(*) >= ${RECAP_MIN_WEARS}
    order by 1 desc
    limit 1`);
  return result.rows[0]?.year ?? null;
}

/**
 * What GET /wardrobe/recap opens on without `?year=`: this year's recap, or
 * while it is still the empty state (January, a closet new to wearing) the
 * latest earlier year that has enough wears, so the page does not greet
 * the day people open it with nothing (#733). With no such year, this
 * year's empty state. The extra read happens only then.
 */
export async function readDefaultRecap(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<YearRecap<SignablePhotoRef>> {
  const current = dateParts(today).year;
  const recap = await readRecap(db, ownerId, recapPeriod(current, today));
  if (recap.enough) return recap;
  const earlier = await latestRecapYearBefore(db, ownerId, current);
  if (earlier === null) return recap;
  return readRecap(db, ownerId, recapPeriod(earlier, today));
}
