import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment, trip } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import type { GarmentStatus } from '../../wardrobe/status';
import { addDays, type IsoDate } from '../../calendar-date';
import { LAUNDRY_PAGE } from '../../offline-writes';
import { weekOf } from '../calendar/calendar-view';
import { weekUrl } from '../calendar/urls';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import {
  heldOneOffsSql,
  ownOutfitIdsSql,
  savedOutfitsSql,
} from '../outfits/queries';
import { outfitUrl } from '../outfits/urls';
import { tripUrl } from '../trips/urls';
import { GRID_PAGE_SIZE } from '../wardrobe/grid-page-size';
import { inCloset, onWishlist, wanted } from '../wardrobe/status';
import { garmentUrl, needUrl, WISHLIST_PATH } from '../wardrobe/urls';
import { inboxNeedIdsSql } from '../wishlist/inbox';
import { EMPTY_SEARCH, tilesUrl } from '../wardrobe/wardrobe-page';
import {
  WARM_GARMENT_CAP,
  WARM_IMAGE_CAP,
  WARM_OUTFIT_CAP,
  WARM_TRIP_CAP,
  WARM_WISHLIST_CAP,
  type WarmList,
} from './offline-warm';

/**
 * The warm list of `ownerId`'s own wardrobe (#286): next week, every closet
 * garment's page and every outfit's (capped: the one-offs this week and
 * next hold first, since Today and the calendar open them, then the kept
 * ones newest first, #659; the other one-offs are only kept), the pages with
 * queueable controls (#657: the laundry and the trips ahead or on, nearest
 * first, right after next week, since they are few and what a phone offline
 * needs most), the Muse inbox
 * (#333: the Wishlist tab, its needs' decision screens and the pages of
 * what is still wanted, capped), the closet grid's later pages, and the
 * thumbs they show. Never a tab root
 * (TAB_ROOTS): they open stale-while-revalidate, so a warmed copy would open
 * stale after the user's own edits; they are cached when first opened.
 * Always the requester's own: a grantee's device never warms a wardrobe
 * shared with them. One statement: the garments still owned or wished for,
 * the newest WARM_OUTFIT_CAP kept outfits and the one-offs the near-term
 * entries hold with their garments' photos (the Saved tab's reader, #660),
 * every other outfit's id alone (`keep` needs no more), and the needs the
 * inbox shows.
 */
export async function warmList(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<WarmList> {
  const thisWeekStart = weekOf(today).start;
  const nextWeekEnd = weekOf(addDays(thisWeekStart, 7)).end;
  const { garments, kept, nearTerm, outfitIds, needs, trips } =
    await selectScalars(db, {
      garments: ownGarmentsSql(ownerId),
      // No more kept ones can be warmed: the near-term one-offs come first.
      kept: savedOutfitsSql(ownerId, 'kept', {
        before: undefined,
        limit: WARM_OUTFIT_CAP,
      }),
      nearTerm: heldOneOffsSql(ownerId, thisWeekStart, nextWeekEnd),
      outfitIds: ownOutfitIdsSql(ownerId),
      needs: inboxNeedIdsSql(ownerId),
      trips: ownTripsSql(ownerId, today),
    });
  const aheadTrips = trips.filter((row) => row.ahead);
  const warmedTrips = aheadTrips.slice(0, WARM_TRIP_CAP);
  const closet = garments.filter((row) => row.status === 'closet');
  const warmed = closet.slice(0, WARM_GARMENT_CAP);
  // The inbox, then its needs, then what is still wanted, within the cap.
  const inboxPages = [
    WISHLIST_PATH,
    ...needs.map((id) => needUrl(id, undefined)),
  ].slice(0, WARM_WISHLIST_CAP);
  const stillWanted = garments
    .filter((row) => row.wanted)
    .slice(0, WARM_WISHLIST_CAP - inboxPages.length);
  const warmedIds = new Set([...warmed, ...stillWanted].map((row) => row.id));
  const warmedOutfits = [...nearTerm, ...kept.outfits].slice(
    0,
    WARM_OUTFIT_CAP,
  );
  const warmedOutfitIds = new Set(warmedOutfits.map((row) => row.id));

  const thumbs = new Set<string>();
  const addThumb = (photo: SignablePhotoRef | null) => {
    if (photo) thumbs.add(imageUrl(photo, 'thumb'));
  };
  warmed.forEach((row) => addThumb(row.photo));
  warmedOutfits.forEach((row) =>
    row.garments.forEach((g) => addThumb(g.photo)),
  );
  const closetThumbs = [...thumbs].slice(0, WARM_IMAGE_CAP - WARM_WISHLIST_CAP);
  const wantedThumbs = stillWanted.flatMap((row) =>
    row.photo ? [imageUrl(row.photo, 'thumb')] : [],
  );

  return {
    pages: [
      weekUrl(addDays(thisWeekStart, 7)),
      LAUNDRY_PAGE,
      ...warmedTrips.map((row) => tripUrl(row.id)),
      ...warmed.map((row) => garmentUrl(row.id, undefined)),
      ...warmedOutfits.map((row) => outfitUrl(row.id)),
      ...inboxPages,
      ...stillWanted.map((row) => garmentUrl(row.id, undefined)),
    ],
    fragments: gridPageCursors(
      closet.map((row) => row.id),
      warmed.length,
      // The closet's unranked order: every cursor is rank 0, the bare id.
    ).map((id) => tilesUrl(undefined, EMPTY_SEARCH, { rank: 0, id })),
    // The garments' thumbs come first (warmed before the outfits'), so a
    // cut falls on outfit pieces the closet pages never show; the inbox's
    // products have their own share of the cap.
    images: [...new Set([...closetThumbs, ...wantedThumbs])],
    keep: [
      ...garments
        .filter((row) => !warmedIds.has(row.id))
        .map((row) => garmentUrl(row.id, undefined)),
      ...outfitIds
        .filter((id) => !warmedOutfitIds.has(id))
        .map((id) => outfitUrl(id)),
      // Trips past the cap and the ended ones still exist: their visited
      // copies stay.
      ...[
        ...aheadTrips.slice(WARM_TRIP_CAP),
        ...trips.filter((row) => !row.ahead),
      ].map((row) => tripUrl(row.id)),
    ],
  };
}

interface OwnTrip {
  id: number;
  /** Ahead or on: the last day is not before today. */
  ahead: boolean;
}

/**
 * The owner's trips, nearest first, each with whether it is ahead or on
 * (the last day not past `today`): a past trip has nothing left to pack, so
 * it is only kept, like a garment past its cap.
 */
function ownTripsSql(ownerId: number, today: IsoDate): SQL<OwnTrip[]> {
  return sql<OwnTrip[]>`(
    select coalesce(
      json_agg(
        json_build_object('id', ${trip.id}, 'ahead', ${trip.endsOn} >= ${today})
        order by ${trip.startsOn}, ${trip.id}
      ),
      '[]'
    )
    from ${trip}
    where ${eq(trip.ownerId, ownerId)}
  )`;
}

interface OwnGarment {
  id: number;
  status: GarmentStatus;
  /** Still wanted (wanted(): on the wishlist, not set aside): warmed; a set-aside one is only kept. */
  wanted: boolean;
  photo: SignablePhotoRef | null;
}

/**
 * The owner's closet and wishlist garments, newest first, with their
 * photos. Archived ones are left out, so their cached pages go.
 */
function ownGarmentsSql(ownerId: number): SQL<OwnGarment[]> {
  return sql<OwnGarment[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'status', ${garment.status},
          'wanted', ${wanted()},
          'photo', ${photoRefJson}
        )
        order by ${garment.id} desc
      ),
      '[]'
    )
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(eq(garment.ownerId, ownerId), or(inCloset(), onWishlist()))}
  )`;
}

/**
 * Each later grid page's `before`, as gridPage pages the closet: newest
 * first, GRID_PAGE_SIZE a page, and a page after every full one that has
 * more behind it. `ids` is the whole closet, newest first; only pages whose
 * every tile is among the first `warmed` are listed, so an offline scroll
 * never shows a tile whose page and thumb were not warmed (it stops at the
 * last whole page, its sentinel failing like any uncached fragment).
 */
function gridPageCursors(ids: number[], warmed: number): number[] {
  const cursors: number[] = [];
  for (
    let end = GRID_PAGE_SIZE;
    end < ids.length && Math.min(end + GRID_PAGE_SIZE, ids.length) <= warmed;
    end += GRID_PAGE_SIZE
  ) {
    cursors.push(ids[end - 1]);
  }
  return cursors;
}
