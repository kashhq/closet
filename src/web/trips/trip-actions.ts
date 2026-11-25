import type { FastifyRequest } from 'fastify';
import type { Db, Queryable } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { IsoDate } from '../../calendar-date';
import type { Logger } from '../../logger';
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
import { type ActionDeps, logOp } from '../op-log';
import { NotFound } from '../refusals';
import { type RateLimitChecker, withinLimit } from '../security/rate-limit';
import type { Actor } from '../sharing/access';
import type { PickedPlace } from '../weather/place-input';
import { type TripModel, tripModel, tripPageModel } from './model';
import { type PackedChange, setPacked } from './packed';
import {
  addTripItems,
  addTripOutfit,
  copyTripItems,
  createTripAt,
  createTripOnce,
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
 * alone would not say what was refused. Each write logs its own outcome,
 * once, as one `trip.*` line (logOp, #712): its callers log nothing.
 */

/** Another's trip or no trip: one refusal for both (ids reveal nothing). */
function tripNotFound(): NotFound {
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

/**
 * A new trip's picked place, as addTrip takes it: the place and the
 * destination budget it is charged against (WEATHER_LOCATION_LIMIT: a
 * located trip is a forecast to fetch and a cached row). The budget is the
 * request's, so the route builds it (newTripPlace).
 */
export interface PlaceAsk {
  place: PickedPlace;
  /** Counts the place against the budget: false once it is spent. */
  charge: () => Promise<boolean>;
}

/**
 * The page's and the API's create's place (#861): none without
 * WEATHER_ENABLED, whose search is the only source of one (the form shows
 * no picker), so posted coordinates are neither stored nor charged there.
 */
export function newTripPlace(
  place: PickedPlace | null,
  {
    weatherEnabled,
    budget,
    request,
    logger,
    who,
  }: {
    weatherEnabled: boolean;
    budget: RateLimitChecker;
    request: FastifyRequest;
    logger: Logger;
    who: string;
  },
): PlaceAsk | null {
  if (!place || !weatherEnabled) return null;
  return {
    place,
    charge: () => withinLimit(budget, request, { logger, who }),
  };
}

/**
 * A new trip of the actor's (the form, POST /api/v1/trips): createTripAt,
 * or with the API's `clientId` createTripOnce, whose retry answers the
 * first trip (`created` false) and whose id of a trip deleted since is a
 * 410. A place past its budget is dropped, never the trip (#863): the trip
 * is created unlocated and `placeDeferred` says why, so the person can
 * find the place again from the trip page. Logs whether it was located,
 * never the place: where someone travels is theirs.
 */
export async function addTrip(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: {
    fields: TripFields;
    place: PlaceAsk | null;
    today: IsoDate;
    clientId?: string;
  },
): Promise<{ id: number; created: boolean; placeDeferred: boolean }> {
  const { today, clientId } = input;
  const { fields, place } = await placeToStore(input.fields, input.place);
  const once = clientId
    ? await createTripOnce(db, actor.userId, fields, place, today, clientId)
    : {
        row: await createTripAt(db, actor.userId, fields, place, today),
        created: true,
      };
  if (once === 'gone') throw new HttpError(410, t('TRIP_DELETED'));
  const { id, away } = once.row;
  // A retry answers the first trip as it was saved: nothing deferred now.
  const placeDeferred = once.created && input.place !== null && !place;
  logOp(logger, actor, 'trip.created', {
    tripId: id,
    changed: once.created,
    startsOn: fields.startsOn,
    endsOn: fields.endsOn,
    located: once.created ? place !== null : undefined,
    placeDeferred: placeDeferred || undefined,
    autoEntriesRemoved: away,
    clientId: clientId?.slice(0, 8),
  });
  return { id, created: once.created, placeDeferred };
}

/**
 * addTrip's place once its budget is charged: the place to store, or null
 * when none was asked or the budget is spent. The asked place names the
 * destination either way (setTripDestination's rule), so a deferred one
 * keeps its label for the person's Find.
 */
async function placeToStore(
  fields: TripFields,
  ask: PlaceAsk | null,
): Promise<{ fields: TripFields; place: PickedPlace | null }> {
  if (!ask) return { fields, place: null };
  const named = { ...fields, destination: ask.place.name };
  return { fields: named, place: (await ask.charge()) ? ask.place : null };
}

/** The trip form's save of the actor's trip (updateTrip). */
export async function editTrip(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  fields: TripFields,
  today: IsoDate,
): Promise<{ undated: number; locationCleared: boolean }> {
  const saved = await updateTrip(db, id, actor.userId, fields, today);
  if (saved === 'not-found') throw tripNotFound();
  logOp(logger, actor, 'trip.updated', {
    tripId: id,
    startsOn: fields.startsOn,
    endsOn: fields.endsOn,
    undated: saved.undated,
    locationCleared: saved.locationCleared,
    autoEntriesRemoved: saved.away,
  });
  return { undated: saved.undated, locationCleared: saved.locationCleared };
}

/** Deletes the actor's trip; its outfits stay (deleteTrip). */
export async function removeTrip(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
): Promise<void> {
  if (!(await deleteTrip(db, id, actor.userId))) throw tripNotFound();
  logOp(logger, actor, 'trip.deleted', { tripId: id });
}

/**
 * The destination picked from the geocoding search (setTripDestination),
 * logged without the place, as a new trip is.
 */
export async function locateTrip(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  place: { name: string; location: PickedLocation },
): Promise<void> {
  if (!(await setTripDestination(db, id, actor.userId, place))) {
    throw tripNotFound();
  }
  logOp(logger, actor, 'trip.located', { tripId: id });
}

/**
 * The actor's saved outfit on their trip (the add page, plan_trip_outfit):
 * addTripOutfit, refused in the order it checks, the trip, the day, the
 * outfit (an incomplete one is its own 409, OutfitIncomplete).
 */
export async function planTripOutfit(
  { db, logger }: ActionDeps,
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
  if (outcome !== 'added' && outcome !== 'already') {
    return refuseTripSlot(outcome, input.day);
  }
  logOp(logger, actor, 'trip.outfit.added', {
    tripId: input.tripId,
    outfitId: input.outfitId,
    day: input.day ?? null,
    occasion: input.occasion ?? null,
    changed: outcome === 'added',
  });
  return outcome;
}

/**
 * An idea's garments as an outfit on the actor's trip (the gallery's pick
 * for a trip, plan_trip_outfit with garments): pickForTrip. Garments it
 * could not hold are named as every pick names them (garmentsGoneError).
 */
export async function pickIdeaForTrip(
  { db, logger }: ActionDeps,
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
  // A saved outfit's op: one query finds every outfit a trip gained.
  logOp(logger, actor, 'trip.outfit.added', {
    tripId: input.tripId,
    outfitId: outcome.outfit.id,
    day: input.day ?? null,
    occasion: input.occasion ?? null,
    changed: outcome.added === 'added',
    garmentIds: input.garmentIds,
    outfitCreated: !outcome.outfit.alreadySaved,
  });
  return outcome;
}

/** Takes an outfit off the actor's trip, its orphaned packed marks with it (removeTripOutfit). */
export async function takeOffTrip(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: { tripId: number; tripOutfitId: number },
): Promise<{ outfitId: number; unpacked: number }> {
  const removed = await removeTripOutfit(db, {
    ...input,
    ownerId: actor.userId,
  });
  if (removed === 'not-found') throw tripNotFound();
  logOp(logger, actor, 'trip.outfit.removed', {
    ...input,
    outfitId: removed.outfitId,
    unpacked: removed.unpacked,
  });
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
  { db, logger }: ActionDeps,
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
  logOp(logger, actor, 'trip.outfit.worn', {
    ...input,
    outfitId: found.outfitId,
    day: today,
    occasion,
    entryId: worn.entryId,
    entryPlanned: worn.scheduled === 'scheduled',
    changed: worn.worn.changed,
    wears: worn.worn.wears,
  });
  return { outfitId: found.outfitId, day: found.day, occasion, worn };
}

/** A checklist autosave's ticks: checked packed, shown and unchecked not. */
export interface ChecklistTicks {
  tripId: number;
  packed: readonly number[];
  unpacked: readonly number[];
}

/** The packing marks the ticks moved, unlogged: packTrip's and tickTripGarment's. */
async function setTripPacked(
  db: Db,
  actor: Actor,
  ticks: ChecklistTicks,
): Promise<PackedChange & { onList: number }> {
  const change = await setPacked(db, { ...ticks, ownerId: actor.userId });
  if (change === 'not-found') throw tripNotFound();
  return change;
}

/** The extras' marks the ticks moved, unlogged: packTripItems' and tickTripItem's. */
async function setTripItemsPacked(
  db: Db,
  actor: Actor,
  ticks: ChecklistTicks,
): Promise<PackedChange & { items: TripItemRow[] }> {
  const change = await setItemsPacked(db, { ...ticks, ownerId: actor.userId });
  if (change === 'not-found') throw tripNotFound();
  return change;
}

/** The packing list's autosave on the actor's trip (setPacked). */
export async function packTrip(
  { db, logger }: ActionDeps,
  actor: Actor,
  ticks: ChecklistTicks,
): Promise<PackedChange & { onList: number }> {
  const change = await setTripPacked(db, actor, ticks);
  logOp(logger, actor, 'trip.packing.set', {
    tripId: ticks.tripId,
    packed: change.packed,
    unpacked: change.unpacked,
  });
  return change;
}

/** The extras' autosave on the actor's trip (setItemsPacked), with the extras as they now are. */
export async function packTripItems(
  { db, logger }: ActionDeps,
  actor: Actor,
  ticks: ChecklistTicks,
): Promise<PackedChange & { items: TripItemRow[] }> {
  const change = await setTripItemsPacked(db, actor, ticks);
  logOp(logger, actor, 'trip.extras.set', {
    tripId: ticks.tripId,
    packed: change.packed,
    unpacked: change.unpacked,
  });
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
  { db, logger }: ActionDeps,
  actor: Actor,
  tick: Tick & { garmentId: number },
): Promise<{ changed: boolean }> {
  const change = await setTripPacked(db, actor, ticksOf(tick.garmentId, tick));
  if (change.onList === 0) {
    throw new NotFound('garment', {
      logDetail: `garment ${tick.garmentId} is not on trip ${tick.tripId}'s packing list`,
    });
  }
  logOp(logger, actor, 'trip.packing.set', {
    tripId: tick.tripId,
    garmentId: tick.garmentId,
    packed: change.packed,
    unpacked: change.unpacked,
  });
  return { changed: change.packed + change.unpacked > 0 };
}

/**
 * One extra of the actor's trip packed or not (setItemsPacked), set-state:
 * the extra as it now is; one not on the trip is the trip's 404, as its
 * removal is.
 */
export async function tickTripItem(
  { db, logger }: ActionDeps,
  actor: Actor,
  tick: Tick & { itemId: number },
): Promise<{ item: TripItemRow; changed: boolean }> {
  const change = await setTripItemsPacked(
    db,
    actor,
    ticksOf(tick.itemId, tick),
  );
  const item = change.items.find((row) => row.id === tick.itemId);
  if (!item) {
    throw new NotFound('trip', {
      logDetail: `extra ${tick.itemId} is not on trip ${tick.tripId}`,
    });
  }
  logOp(logger, actor, 'trip.extras.set', {
    tripId: tick.tripId,
    itemId: tick.itemId,
    packed: change.packed,
    unpacked: change.unpacked,
  });
  return { item, changed: change.packed + change.unpacked > 0 };
}

/**
 * An extra on the actor's trip; the count added (0: the label is there
 * already). Logged without the label, the person's own text.
 */
export async function addTripItem(
  { db, logger }: ActionDeps,
  actor: Actor,
  tripId: number,
  label: string,
): Promise<number> {
  const added = await addTripItems(db, tripId, actor.userId, [label]);
  if (added === 'not-found') throw tripNotFound();
  logOp(logger, actor, 'trip.extra.added', { tripId, changed: added > 0 });
  return added;
}

/** Removes one extra of the actor's trip (removeTripItem). */
export async function removeTripExtra(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: { tripId: number; itemId: number },
): Promise<void> {
  if (!(await removeTripItem(db, { ...input, ownerId: actor.userId }))) {
    throw tripNotFound();
  }
  logOp(logger, actor, 'trip.extra.removed', input);
}

/**
 * "Copy extras from a previous trip": both trips the actor's, and not the
 * same one (copyTripItems); the count added.
 */
export async function copyTripExtras(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: { fromTripId: number; toTripId: number },
): Promise<number> {
  const copied = await copyTripItems(db, { ...input, ownerId: actor.userId });
  if (copied === 'not-found') {
    throw new NotFound('trip', {
      logDetail: `copy from trip ${input.fromTripId} to ${input.toTripId}`,
    });
  }
  logOp(logger, actor, 'trip.extras.copied', {
    tripId: input.toTripId,
    fromTripId: input.fromTripId,
    added: copied,
  });
  return copied;
}
