import type { Db, Queryable } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { IsoDate } from '../../calendar-date';
import { DEFAULT_OCCASION, type Occasion } from '../../wardrobe/occasions';
import { tripPhase, wearableToday } from '../../wardrobe/packing';
import type { PickedLocation } from '../../weather/location';
import { type WornOutfit, wearOutfitOn } from '../calendar/queries';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { garmentsGoneError } from '../outfits/gone-garments';
import { outfitNotFound } from '../outfits/outfit-actions';
import type { PickResult } from '../outfits/pick';
import type { OutfitOrigin } from '../../wardrobe/outfit-origin';
import type { OutfitList } from '../outfits/outfit-list';
import {
  type GarmentOutfit,
  type OutfitPage,
  type OutfitPageAsk,
  savedOutfitsSql,
} from '../outfits/queries';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { type TripModel, tripModel, tripPageModel } from './model';
import { type PackedChange, setPacked } from './packed';
import {
  addTripItems,
  addTripOutfit,
  copyTripItems,
  deleteTrip,
  findTrip,
  findTripOutfit,
  type NotATripDay,
  ownTripSql,
  pickForTrip,
  removeTripItem,
  removeTripOutfit,
  setItemsPacked,
  setTripDestination,
  type TripCopySource,
  type TripFields,
  type TripItemRow,
  type TripOutfitAdded,
  type TripOutfitDay,
  tripOutfitDaysSql,
  type TripRefusal,
  type TripRow,
  tripRow,
  type TripSlot,
  updateTrip,
} from './queries';
import type { WriteOrigin } from '../write-origin';

/**
 * The trip path (#188; docs/plans/2026-11-12-json-api.md section 4):
 * every surface's read of one trip and change to one, each taking the
 * Actor and refusing itself, so a page, an MCP tool and the API refuse
 * alike. Trips are private (AGENTS.md): only the actor's own are reached,
 * whatever wardrobe shares they hold, so another's trip, trip outfit or
 * extra is the 404 of an unknown id, never a 403. The owner-scoped queries
 * underneath (queries.ts, packed.ts, model.ts) trust their `ownerId`: only
 * this path reaches them from a surface (the trips list and create aside,
 * which refuse nothing). Refusals carry a `logDetail` where the message
 * alone would not say what was refused, so callers log only what was done.
 */

/** Another's trip or no trip: one refusal for both (ids reveal nothing). */
export function tripNotFound(): NotFound {
  return new NotFound('trip');
}

/** A day outside the trip (400): every surface names the trip's dates. */
function notATripDay(day: IsoDate | undefined, refused: NotATripDay) {
  const { startsOn, endsOn } = refused.notATripDay;
  return new HttpError(400, t('trips.NOT_A_TRIP_DAY', { startsOn, endsOn }), {
    logDetail: `day ${day} is outside ${startsOn} to ${endsOn}`,
  });
}

/** A trip outfit write's refusal, thrown (addTripOutfit, pickForTrip). */
function refuseTripSlot(outcome: TripRefusal, day: IsoDate | undefined): never {
  if (outcome === 'no-trip') throw tripNotFound();
  throw notATripDay(day, outcome);
}

/** The actor's trip (the edit form, the forecast, the place search, a gallery `for=trip:`). */
export async function requireTrip(
  db: Queryable,
  actor: Actor,
  id: number,
): Promise<TripRow> {
  const found = await findTrip(db, id, actor.userId);
  if (!found) throw tripNotFound();
  return found;
}

/** The trip page's read (tripPageModel, one statement). */
export async function requireTripPage(
  db: Db,
  actor: Actor,
  id: number,
  today: IsoDate,
): Promise<TripModel & { copyFrom: TripCopySource[] }> {
  const model = await tripPageModel(db, actor.userId, id, today);
  if (!model) throw tripNotFound();
  return model;
}

/** The trip as get_trip answers it (tripModel, the page's model without "Copy extras from"). */
export async function requireTripModel(
  db: Db,
  actor: Actor,
  id: number,
  today: IsoDate,
): Promise<TripModel> {
  const model = await tripModel(db, actor.userId, id, today);
  if (!model) throw tripNotFound();
  return model;
}

/**
 * The add page's read, one statement: the trip, a page of the actor's
 * saved outfits of `list` (#659, #660) and the trip's outfits with their
 * days. The page's and its sentinel's (GET /trips/:id/outfits/new/more).
 */
export async function requireAddOutfitPage(
  db: Db,
  actor: Actor,
  id: number,
  list: OutfitList,
  page: OutfitPageAsk,
): Promise<{
  trip: TripRow;
  outfits: OutfitPage<GarmentOutfit>;
  onTrip: TripOutfitDay[];
}> {
  const found = await selectScalars(db, {
    trip: ownTripSql(id, actor.userId),
    outfits: savedOutfitsSql(actor.userId, list, page),
    onTrip: tripOutfitDaysSql(id, actor.userId),
  });
  if (!found.trip) throw tripNotFound();
  return {
    trip: tripRow(found.trip),
    outfits: found.outfits,
    onTrip: found.onTrip,
  };
}

/** The trip form's save of the actor's trip (updateTrip). */
export async function editTrip(
  db: Db,
  actor: Actor,
  id: number,
  fields: TripFields,
  today: IsoDate,
): Promise<{ undated: number; locationCleared: boolean; away: number }> {
  const saved = await updateTrip(db, id, actor.userId, fields, today);
  if (saved === 'not-found') throw tripNotFound();
  return saved;
}

/** Deletes the actor's trip; its outfits stay (deleteTrip). */
export async function removeTrip(
  db: Db,
  actor: Actor,
  id: number,
): Promise<void> {
  if (!(await deleteTrip(db, id, actor.userId))) throw tripNotFound();
}

/** The destination picked from the geocoding search (setTripDestination). */
export async function locateTrip(
  db: Db,
  actor: Actor,
  id: number,
  place: { name: string; location: PickedLocation },
): Promise<void> {
  if (!(await setTripDestination(db, id, actor.userId, place))) {
    throw tripNotFound();
  }
}

/**
 * The actor's saved outfit on their trip (the add page, plan_trip_outfit):
 * addTripOutfit, refused in the order it checks, the trip, the day, the
 * outfit (an incomplete one is its own 409, OutfitIncomplete).
 */
export async function planTripOutfit(
  db: Db,
  actor: Actor,
  input: { tripId: number; outfitId: number } & TripSlot,
  madeBy: WriteOrigin,
): Promise<TripOutfitAdded> {
  const outcome = await addTripOutfit(db, {
    ...input,
    ownerId: actor.userId,
    madeBy,
  });
  if (outcome === 'no-outfit') throw outfitNotFound();
  if (outcome === 'added' || outcome === 'already') return outcome;
  return refuseTripSlot(outcome, input.day);
}

/**
 * An idea's garments as an outfit on the actor's trip (the gallery's pick
 * for a trip, plan_trip_outfit with garments): pickForTrip. Garments it
 * could not hold are named as every pick names them (garmentsGoneError).
 */
export async function pickIdeaForTrip(
  db: Db,
  actor: Actor,
  input: {
    tripId: number;
    garmentIds: readonly number[];
    name?: string;
    /** `idea` for a picked idea, `person` for Styling's composed save (#659). */
    origin: OutfitOrigin;
    /** The person or the agent's token (#682): the outfit's and the trip outfit's stamp. */
    madeBy: WriteOrigin;
  } & TripSlot,
): Promise<{ outfit: PickResult; added: TripOutfitAdded }> {
  const outcome = await pickForTrip(db, actor.userId, input);
  if (outcome === 'not-found') {
    throw await garmentsGoneError(db, actor.userId, input.garmentIds, 'closet');
  }
  if (outcome === 'no-trip' || 'notATripDay' in outcome) {
    return refuseTripSlot(outcome, input.day);
  }
  return outcome;
}

/** Takes an outfit off the actor's trip, its orphaned packed marks with it (removeTripOutfit). */
export async function takeOffTrip(
  db: Db,
  actor: Actor,
  input: { tripId: number; tripOutfitId: number },
): Promise<{ outfitId: number; unpacked: number }> {
  const removed = await removeTripOutfit(db, {
    ...input,
    ownerId: actor.userId,
  });
  if (removed === 'not-found') throw tripNotFound();
  return removed;
}

/**
 * A trip's "Wore it": through the calendar's writers (wearOutfitOn:
 * planned today and marked worn, once), so the calendar stays the one
 * history of what was worn. Only while the trip is on, and only an outfit
 * for today or for no day (wearableToday, which the page's button reads
 * too); else a 409, as a page left open past midnight posts yesterday's.
 */
export async function wearTripOutfit(
  db: Db,
  actor: Actor,
  input: { tripId: number; tripOutfitId: number },
  when: { at: Date; today: IsoDate },
): Promise<{
  outfitId: number;
  day: IsoDate | null;
  occasion: Occasion;
  worn: WornOutfit;
}> {
  const found = await findTripOutfit(db, { ...input, ownerId: actor.userId });
  if (!found) throw tripNotFound();
  const { today } = when;
  if (!wearableToday(found.trip, found.day, today)) {
    throw new HttpError(
      409,
      t(
        tripPhase(found.trip, today) === 'current'
          ? 'trips.WEAR_OTHER_DAY'
          : 'trips.WEAR_NOT_ON',
      ),
      {
        logDetail: `outfit ${found.outfitId} for ${found.day ?? 'any day'} of ${found.trip.startsOn} to ${found.trip.endsOn}, today ${today}`,
      },
    );
  }
  const occasion = found.occasion ?? DEFAULT_OCCASION;
  const worn = await wearOutfitOn(db, {
    ownerId: actor.userId,
    outfitId: found.outfitId,
    day: today,
    occasion,
    at: when.at,
    today,
  });
  // The day is today, never after it.
  if (worn === 'future') throw new Error('Today is after today');
  return { outfitId: found.outfitId, day: found.day, occasion, worn };
}

/** A checklist autosave's ticks: checked packed, shown and unchecked not. */
export interface ChecklistTicks {
  tripId: number;
  packed: readonly number[];
  unpacked: readonly number[];
}

/** The packing list's autosave on the actor's trip (setPacked). */
export async function packTrip(
  db: Db,
  actor: Actor,
  ticks: ChecklistTicks,
): Promise<PackedChange & { onList: number }> {
  const change = await setPacked(db, { ...ticks, ownerId: actor.userId });
  if (change === 'not-found') throw tripNotFound();
  return change;
}

/** The extras' autosave on the actor's trip (setItemsPacked), with the extras as they now are. */
export async function packTripItems(
  db: Db,
  actor: Actor,
  ticks: ChecklistTicks,
): Promise<PackedChange & { items: TripItemRow[] }> {
  const change = await setItemsPacked(db, { ...ticks, ownerId: actor.userId });
  if (change === 'not-found') throw tripNotFound();
  return change;
}

/** A one-row tick (the API's): packed or not, and whether it moved. */
interface Tick {
  tripId: number;
  packed: boolean;
}

function ticksOf(id: number, { tripId, packed }: Tick): ChecklistTicks {
  return {
    tripId,
    packed: packed ? [id] : [],
    unpacked: packed ? [] : [id],
  };
}

/**
 * One garment of the actor's trip packed or not (setPacked), set-state: a
 * garment the list does not hold (no outfit of the trip has it, or it left
 * with one) is the garment's 404, which a queued tick may drop.
 */
export async function tickTripGarment(
  db: Db,
  actor: Actor,
  tick: Tick & { garmentId: number },
): Promise<{ changed: boolean }> {
  const change = await packTrip(db, actor, ticksOf(tick.garmentId, tick));
  if (change.onList === 0) {
    throw new NotFound('garment', {
      logDetail: `garment ${tick.garmentId} is not on trip ${tick.tripId}'s packing list`,
    });
  }
  return { changed: change.packed + change.unpacked > 0 };
}

/**
 * One extra of the actor's trip packed or not (setItemsPacked), set-state:
 * the extra as it now is; one not on the trip is the trip's 404, as its
 * removal is.
 */
export async function tickTripItem(
  db: Db,
  actor: Actor,
  tick: Tick & { itemId: number },
): Promise<{ item: TripItemRow; changed: boolean }> {
  const change = await packTripItems(db, actor, ticksOf(tick.itemId, tick));
  const item = change.items.find((row) => row.id === tick.itemId);
  if (!item) {
    throw new NotFound('trip', {
      logDetail: `extra ${tick.itemId} is not on trip ${tick.tripId}`,
    });
  }
  return { item, changed: change.packed + change.unpacked > 0 };
}

/** An extra on the actor's trip; the count added (0: the label is there already). */
export async function addTripItem(
  db: Db,
  actor: Actor,
  tripId: number,
  label: string,
): Promise<number> {
  const added = await addTripItems(db, tripId, actor.userId, [label]);
  if (added === 'not-found') throw tripNotFound();
  return added;
}

/** Removes one extra of the actor's trip (removeTripItem). */
export async function removeTripExtra(
  db: Db,
  actor: Actor,
  input: { tripId: number; itemId: number },
): Promise<void> {
  if (!(await removeTripItem(db, { ...input, ownerId: actor.userId }))) {
    throw tripNotFound();
  }
}

/**
 * "Copy extras from a previous trip": both trips the actor's, and not the
 * same one (copyTripItems); the count added.
 */
export async function copyTripExtras(
  db: Db,
  actor: Actor,
  input: { fromTripId: number; toTripId: number },
): Promise<number> {
  const copied = await copyTripItems(db, { ...input, ownerId: actor.userId });
  if (copied === 'not-found') {
    throw new NotFound('trip', {
      logDetail: `copy from trip ${input.fromTripId} to ${input.toTripId}`,
    });
  }
  return copied;
}
