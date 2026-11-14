import type { Db } from '../../db/client';
import { DEFAULT_OCCASION, type Occasion } from '../../wardrobe/occasions';
import type { PickedLocation } from '../../weather/location';
import type { IsoDate } from '../../calendar-date';
import type { Actor } from '../sharing/access';
import type { OutfitDestination } from '../outfits/destination';
import { ideasDayOf, type TripRow } from '../trips/queries';
import { requireTrip } from '../trips/trip-actions';

/** Where suggestions are aimed: what a `?for=` resolves to for ideasFor. */
export interface IdeasAim {
  /** The destination as the page carries it on (a trip's stray day dropped). */
  destination: OutfitDestination;
  /** The day and occasion dressed for: today, all day, without a destination. */
  planning: { day: IsoDate; occasion: Occasion };
  /** The trip of `for=trip:ID`, the requester's own. */
  trip?: TripRow;
  /** Where the day's weather is (IdeasInput.place): absent for the person's own. */
  weatherAt: { place?: PickedLocation | null; tripId?: number };
}

/**
 * A parsed `?for=` made concrete for ideasFor: the gallery's Ideas and
 * Styling's Shuffle (#42) aim the same way. `for=trip:ID` names the owner's
 * trip (else a 404 like an unknown id); a day that is not one of its days
 * is dropped for the trip's day (today while it is on, else its first), and
 * its weather is the destination's, or none while it is not located (never
 * home's).
 */
export async function aimIdeas(
  db: Db,
  actor: Actor,
  parsed: OutfitDestination,
  today: IsoDate,
): Promise<IdeasAim> {
  if (parsed.kind === 'day') {
    return {
      destination: parsed,
      planning: { day: parsed.day, occasion: parsed.occasion },
      weatherAt: {},
    };
  }
  if (parsed.kind === 'none') {
    return {
      destination: parsed,
      planning: { day: today, occasion: DEFAULT_OCCASION },
      weatherAt: {},
    };
  }
  // Trips are private, so the requester's own Actor reaches only their
  // trips: a share read ahead never widens what requireTrip reaches.
  const trip = await requireTrip(db, actor, parsed.tripId);
  const day = ideasDayOf(trip, parsed.day, today);
  return {
    destination:
      parsed.day === undefined || parsed.day === day
        ? parsed
        : { kind: 'trip', tripId: parsed.tripId, occasion: parsed.occasion },
    planning: { day, occasion: parsed.occasion ?? DEFAULT_OCCASION },
    trip,
    weatherAt: { place: trip.location, tripId: trip.id },
  };
}
