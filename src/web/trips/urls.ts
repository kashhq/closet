import type { Occasion } from '../../wardrobe/occasions';
import type { IsoDate } from '../../calendar-date';
import { ideasUrl } from '../gallery/urls';
import { type OutfitList, withOutfitList } from '../outfits/outfit-list';

/**
 * Where trips live (#10): the Calendar's Trips tab (the redesign's "Calendar
 * › Trips", docs/plans/2026-09-26-redesign.md; sections.ts marks /trips as
 * the Calendar). Every link is built here from parsed values.
 */

export const TRIPS_PATH = '/trips';

export function tripUrl(id: number, suffix = ''): string {
  return `${TRIPS_PATH}/${id}${suffix}`;
}

/** The add page: a saved outfit for the trip, for a day and occasion when given. */
export function addOutfitUrl(
  tripId: number,
  slot: { day?: IsoDate; occasion?: Occasion } = {},
): string {
  const query = [
    slot.day && `day=${slot.day}`,
    slot.occasion && `occasion=${slot.occasion}`,
  ].filter(Boolean);
  return tripUrl(
    tripId,
    `/outfits/new${query.length > 0 ? `?${query.join('&')}` : ''}`,
  );
}

/** The add page's saved outfits of `list` below `before` (#660): its sentinel's GET, always a fragment. */
export function addOutfitMoreUrl(
  tripId: number,
  slot: { day?: IsoDate; occasion?: Occasion },
  list: OutfitList,
  before: number,
): string {
  const query = [
    slot.day && `day=${slot.day}`,
    slot.occasion && `occasion=${slot.occasion}`,
    `before=${before}`,
  ].filter(Boolean);
  return withOutfitList(
    tripUrl(tripId, `/outfits/new/more?${query.join('&')}`),
    list,
  );
}

/** The gallery's Ideas for the trip (for one of its days and an occasion when given). */
export function tripIdeasUrl(
  tripId: number,
  slot: { day?: IsoDate; occasion?: Occasion } = {},
): string {
  return ideasUrl({ destination: { kind: 'trip', tripId, ...slot } });
}

/** A day's section on the trip page, for the writes to come back to. */
export function dayAnchor(day: IsoDate | null): string {
  return day ? `day-${day}` : 'any-day';
}
