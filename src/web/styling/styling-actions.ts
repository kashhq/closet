import type { Db } from '../../db/client';
import type { IsoDate } from '../../calendar-date';
import type { Idea } from '../../wardrobe/generator';
import { DEFAULT_OCCASION, type Occasion } from '../../wardrobe/occasions';
import { assessOutfit, type FitProblem } from '../../weather/match';
import type { GarmentRole } from '../../wardrobe/properties';
import type { WeatherService } from '../weather/service';
import type { CapsuleRef } from '../capsules/queries';
import { capsuleNotFound } from '../capsules/capsule-actions';
import { HttpError } from '../errors';
import { aimIdeas, type IdeasAim } from '../gallery/aim';
import { dailySeed, ideaName, shuffledSeed } from '../gallery/ideas';
import { pickToPath, savedOutfitPath } from '../gallery/pick';
import type { PoolGarment } from '../gallery/queries';
import { t } from '../i18n';
import {
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import {
  garmentsGoneError,
  type OutfitGarmentsGone,
  type OutfitIncomplete,
} from '../outfits/gone-garments';
import {
  editOutfit,
  outfitNotFound,
  saveOutfit,
} from '../outfits/outfit-actions';
import type { ActionDeps } from '../op-log';
import { safeReturnTo } from '../security/return-to';
import type { Actor } from '../sharing/access';
import { garmentNotFound } from '../wardrobe/garment-access';
import { BY_PERSON } from '../write-origin';
import {
  checkedStates,
  chosen,
  chosenOf,
  clearedStates,
  heldIdsOf,
  lockedIdsOf,
  type Opening,
  type Scope,
  type Wardrobe,
  wardrobeOf,
} from './model';
import { MAX_ROWS, type RowState, topToToe } from './rows';
import { type RoledGarment, type SavedOutfit, savedGarments } from './queries';
import { fitReads, ideaReads, type StripsReads, stripsReads } from './reads';
import type { SaveDraft } from './styling-page';

/**
 * Styling's actions (#719; #188's pattern, trip-actions.ts): every read the
 * composer's routes answer and its Save, each taking the Actor and refusing
 * itself (capsuleNotFound, outfitNotFound, garmentNotFound: NotFound from
 * refusals.ts, or a 400 for a post the page never makes), so routes.tsx
 * only parses, calls and renders. The scope arrives authorized (the
 * route's wardrobeGuard); the checks ride in the reads' statements and are
 * judged here, after them (reads.ts). Save logs its op once through the
 * action it ends in, the API twins' own (operations.ts): pickGarments or
 * replaceEntryOutfit (pickToPath), saveOutfit with Include picks on,
 * editOutfit for an edit; nothing here logs a second line.
 */

/** What Styling's reads take: the database, and the weather Shuffle and the fit line aim with. */
export interface StylingDeps {
  db: Db;
  weather: WeatherService | undefined;
}

/** The page's `?for=` as posted or asked: where the outfit goes. */
interface DestinationAsk {
  for?: string;
  occasion?: string;
  replace?: string;
}

/** The capsule a request named, as the reads found it: a 404 outside the wardrobe. */
function checkedCapsule(
  found: CapsuleRef | null | undefined,
): CapsuleRef | undefined {
  if (found === null) throw capsuleNotFound();
  return found;
}

/** The outfit a request named (`asked`), as the reads found it: a 404 unless the requester's. */
function checkedOutfit(
  asked: number | undefined,
  found: SavedOutfit | undefined,
): SavedOutfit | undefined {
  if (asked !== undefined && !found) throw outfitNotFound();
  return found;
}

/** A settled promise's value; its refusal, thrown. */
function valueOf<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/**
 * Where Shuffle's ideas are aimed: the page's `?for=` (its day's weather
 * and occasion, a trip's destination) on one's own wardrobe; over a
 * shared one, nowhere (browseIdea reads none of the owner's days).
 */
function aimOf(
  db: Db,
  actor: Actor,
  shared: boolean,
  ask: DestinationAsk,
  today: IsoDate,
): Promise<IdeasAim> {
  const none: OutfitDestination = { kind: 'none' };
  return aimIdeas(db, actor, shared ? none : parseDestination(ask), today);
}

/** What GET /styling asks for beyond the scope. */
export interface OpenAsk extends DestinationAsk {
  /** `?outfit=` as asked: checked, a 404 unless the requester's. */
  outfit?: number;
  /** `?with=`: "Style this"'s garment. */
  with?: number;
  /** The outfit the page reads: `?outfit=` on one's own wardrobe, else none. */
  outfitId: number | undefined;
}

/** GET /styling's read: "Style this" with `?with=`, the plain page without. */
export function openStyling(
  deps: StylingDeps,
  actor: Actor,
  scope: Scope,
  ask: OpenAsk,
  today: IsoDate,
): Promise<Opening> {
  return ask.with === undefined
    ? plainOpening(deps.db, actor, scope, ask, today)
    : styledOpening(deps, actor, scope, ask, today, ask.with);
}

/**
 * The page without "Style this": the fresh stack, or a saved outfit's
 * rows (`?outfit=`, the requester's own, never opened over a shared
 * wardrobe), in one statement beside the aim (a trip's lookup): the
 * windows reach the outfit's garments through its id. The capsule is
 * refused before the trip or the outfit, as it always was.
 */
async function plainOpening(
  db: Db,
  actor: Actor,
  scope: Scope,
  ask: OpenAsk,
  today: IsoDate,
): Promise<Opening> {
  const { outfitId } = ask;
  const [aimed, read] = await Promise.allSettled([
    aimOf(db, actor, scope.shared, ask, today),
    stripsReads(db, scope, {
      checkCapsule: true,
      outfitId,
      chosen: [],
      chosenOutfit: outfitId,
      menu: true,
    }),
  ]);
  const reads = valueOf(read);
  const capsule = checkedCapsule(reads.capsule);
  const aim = valueOf(aimed);
  const saved = checkedOutfit(ask.outfit, reads.outfit);
  return {
    wardrobe: wardrobeOf(scope, capsule, reads),
    aim,
    opened: { saved },
    styled: {},
    reads,
  };
}

/**
 * "Style this" (`?with=`, a closet garment of the wardrobe: else a 404)
 * opens on the day's first idea around the garment, locked; the page
 * then carries the next seed for Shuffle. Nothing else reads the day:
 * the bare page's fresh stack stays byte-stable (page-cache.ts). The
 * garment, the outfit and the capsule are checked in the idea's
 * statement (ideaReads); then the windows reach the idea (stripsReads).
 */
async function styledOpening(
  deps: StylingDeps,
  actor: Actor,
  scope: Scope,
  ask: OpenAsk,
  today: IsoDate,
  withId: number,
): Promise<Opening> {
  const { db } = deps;
  const aim = await aimOf(db, actor, scope.shared, ask, today);
  const seed = dailySeed(today);
  const read = await ideaReads(deps, scope, {
    checkCapsule: true,
    outfitId: ask.outfitId,
    lockIds: [withId],
    aim,
    today,
    seed,
    now: new Date(),
  });
  const capsule = checkedCapsule(read.capsule);
  const saved = checkedOutfit(ask.outfit, read.outfit);
  const [garment] = read.lockable;
  if (!garment) throw garmentNotFound();
  const idea = await read.draw([garment]);
  const reads = await stripsReads(db, scope, {
    chosen: [
      ...(saved?.garments ?? []),
      garment,
      ...(idea?.garments ?? []),
    ].map(chosen),
    menu: true,
  });
  return {
    wardrobe: wardrobeOf(scope, capsule, reads),
    aim,
    opened: { saved, with: garment },
    styled: { idea, seed: shuffledSeed(seed), missed: !idea },
    reads,
  };
}

/** What a Shuffle drew over the posted rows. */
export interface Shuffled {
  wardrobe: Wardrobe;
  /** The posted rows, checked (checkedStates), before the idea fills them. */
  states: RowState[];
  strips: StripsReads;
  held: RoledGarment[];
  idea: Idea<PoolGarment> | undefined;
  /** The garments of the rows that stayed locked. */
  lockedIds: number[];
}

/**
 * Shuffle: the generator's idea around the posted rows' locked garments.
 * The rows are checked in the idea's statement (ideaReads), then the
 * windows reach the idea (stripsReads). The ideas draw from the closet
 * alone: a pick is never drawn, and a row the rows may carry it in
 * (rowGarmentsSql) keeps it while locked.
 */
export async function shuffleStyling(
  deps: StylingDeps,
  actor: Actor,
  scope: Scope,
  ask: DestinationAsk & { posted: RowState[]; seed: number },
  today: IsoDate,
): Promise<Shuffled> {
  const { db } = deps;
  const { posted, seed } = ask;
  const aim = await aimOf(db, actor, scope.shared, ask, today);
  const read = await ideaReads(deps, scope, {
    checkCapsule: true,
    heldIds: heldIdsOf(posted),
    lockIds: lockedIdsOf(posted),
    aim,
    today,
    seed,
    now: new Date(),
  });
  const capsule = checkedCapsule(read.capsule);
  const states = checkedStates(posted, read.held);
  const lockedIds = lockedIdsOf(states);
  const idea = await read.draw(
    read.lockable.filter((g) => lockedIds.includes(g.id)),
  );
  const strips = await stripsReads(db, scope, {
    chosen: [...chosenOf(states), ...(idea?.garments ?? []).map(chosen)],
  });
  return {
    wardrobe: wardrobeOf(scope, capsule, strips),
    states,
    strips,
    held: read.held,
    idea,
    lockedIds,
  };
}

/**
 * "Add row": the posted rows, checked, with one more (empty) of `add`
 * while there is room, top to toe. One statement: the windows reach each
 * posted garment in its row's role, which is what checkedStates keeps.
 */
export async function addStylingRow(
  db: Db,
  scope: Scope,
  posted: RowState[],
  add: GarmentRole | undefined,
): Promise<{ wardrobe: Wardrobe; states: RowState[]; reads: StripsReads }> {
  const reads = await stripsReads(db, scope, {
    checkCapsule: true,
    heldIds: heldIdsOf(posted),
    chosen: chosenOf(posted),
    capsules: true,
  });
  const wardrobe = wardrobeOf(scope, checkedCapsule(reads.capsule), reads);
  const states = checkedStates(posted, reads.held);
  if (add !== undefined && states.length < MAX_ROWS) {
    states.push({ role: add, garmentId: null, locked: false });
  }
  return { wardrobe, states: topToToe(states), reads };
}

/** The fit line's answer: the outfit's problems on the aimed day, or none without a forecast. */
export interface StylingFit {
  fit: { problems: FitProblem[]; typical: boolean } | undefined;
  garments: number;
  aim: IdeasAim;
}

/**
 * The fit line (#468b): how the rows' garments (`heldIds`, those the rows
 * may carry: fitReads) meet the aimed day's weather, assessOutfit in the
 * gallery's words. One's own wardrobe only (the route answers nothing
 * over a share or without a garment); one statement, a trip's lookup
 * before it.
 */
export async function stylingFit(
  deps: StylingDeps & { weather: WeatherService },
  actor: Actor,
  scope: Scope,
  ask: DestinationAsk & { heldIds: number[] },
  now: Date,
  today: IsoDate,
): Promise<StylingFit> {
  const aim = await aimOf(deps.db, actor, false, ask, today);
  const read = await fitReads(deps, scope, {
    heldIds: ask.heldIds,
    aim,
    today,
    now,
  });
  const fit =
    read.weather && read.garments.length > 0
      ? {
          problems: assessOutfit(read.weather.needs, read.garments).problems,
          typical: read.weather.typical,
        }
      : undefined;
  return { fit, garments: read.garments.length, aim };
}

/** A day on the calendar: the sheet's "Add to calendar", or the page's `?for=day:`. */
interface Plan {
  day: IsoDate;
  occasion: Occasion;
}

/** Save's post, parsed: its garments once each (at least one), its name trimmed, its destination checked. */
export interface StylingSave {
  garmentIds: number[];
  name: string | undefined;
  destination: OutfitDestination;
  /** `outfit`: the saved outfit the rows edit, in place. */
  outfitId: number | undefined;
  /** Include picks was on: a new outfit is a slot write (saveWithPicks). */
  picks: boolean;
  /** The sheet's "Add to calendar" without a destination. */
  scheduleDate: IsoDate | undefined;
  scheduleOccasion: Occasion | undefined;
  returnTo: string | undefined;
}

/** The sheet's "Add to calendar" (no destination): a day, all day without an occasion. */
function scheduled(save: StylingSave): Plan | undefined {
  return save.scheduleDate
    ? {
        day: save.scheduleDate,
        occasion: save.scheduleOccasion ?? DEFAULT_OCCASION,
      }
    : undefined;
}

/**
 * Save, answering the path it lands on (the route's 303). A saved outfit
 * (`outfitId`) is changed in place (editStyled); with Include picks on a
 * new one is a slot write (saveWithPicks; a destination is a 400); else
 * it goes where the page is going, through the gallery's pick (pickToPath:
 * planned, added to a trip, or in an entry's place, once however often it
 * is tapped), or on the sheet's day. A garment it cannot hold refuses the
 * whole save (OutfitGarmentsGone, or OutfitIncomplete for a pick planned),
 * nothing written: the route answers the page again (refusedOpening).
 */
export function saveStyled(
  deps: ActionDeps,
  actor: Actor,
  save: StylingSave,
): Promise<string> {
  const schedule = scheduled(save);
  if (save.outfitId !== undefined) {
    return editStyled(deps, actor, save.outfitId, save, schedule);
  }
  const { destination } = save;
  if (save.picks) {
    if (destination.kind !== 'none') {
      throw new HttpError(400, t('refusal.styling.picksNeedNoDestination'));
    }
    return saveWithPicks(deps, actor, save, schedule);
  }
  const planned: OutfitDestination =
    destination.kind === 'none' && schedule
      ? { kind: 'day', ...schedule }
      : destination;
  return pickToPath(deps, actor, planned, save.garmentIds, {
    source: 'styling',
    name: save.name,
  });
}

/**
 * The posted garments, the requester's own, top to toe, for their
 * categories (savedGarments, in posted order): any not theirs refuses the
 * save (OutfitGarmentsGone, a 404, nothing written). What the outfit may
 * hold of them is the writer's to judge under the owner lock (insertSlots:
 * slotMayNameSql).
 */
async function ownGarments(
  db: Db,
  actor: Actor,
  garmentIds: number[],
): Promise<RoledGarment[]> {
  const garments = topToToe(await savedGarments(db, actor.userId, garmentIds));
  if (garments.length !== garmentIds.length) {
    throw await garmentsGoneError(db, actor.userId, garmentIds, 'wardrobe');
  }
  return garments;
}

function slotsOf(garments: readonly RoledGarment[]) {
  return garments.map((g) => ({ category: g.category, garmentId: g.id }));
}

/**
 * A saved outfit changed in Styling: its slots replaced by the rows'
 * garments top to toe, its name (blank: named for its garments), and
 * planned on a day when asked, in one transaction (updateOutfit, which
 * also makes the week planner's entries of it the person's and prunes
 * the packed marks of garments it no longer holds). The garments must
 * all be the requester's own (ownGarments); what the outfit may hold of
 * them is updateOutfit's to judge (an archived one it holds stays, a
 * piece to buy while nothing holds the outfit, #335), and it refuses
 * whole, named, as the page answers. It changes in place, so a trip or
 * an entry to replace is a 400. Lands on `returnTo`, else the outfit.
 */
async function editStyled(
  deps: ActionDeps,
  actor: Actor,
  outfitId: number,
  save: StylingSave,
  schedule: Plan | undefined,
): Promise<string> {
  const { destination } = save;
  if (
    destination.kind === 'trip' ||
    (destination.kind === 'day' && destination.replace !== undefined)
  ) {
    throw new HttpError(400, t('refusal.styling.editInPlace'));
  }
  const plan =
    destination.kind === 'day'
      ? { day: destination.day, occasion: destination.occasion }
      : schedule;
  const garments = await ownGarments(deps.db, actor, save.garmentIds);
  await editOutfit(deps, actor, outfitId, {
    name: save.name ?? ideaName(garments),
    slots: slotsOf(garments),
    plan,
  });
  return safeReturnTo(save.returnTo, `/outfits/${outfitId}`);
}

/**
 * A new outfit's Save with Include picks on (#335): a slot write through
 * the outfit writer (saveOutfit), not a pick, so a pick in the rows is
 * held and the outfit is incomplete (src/web/outfits/references.ts);
 * once however often it is posted (createOutfit reuses an outfit of the
 * same garments). An archived garment or a pick set aside meanwhile
 * refuses it, nothing written. Planned on the sheet's day only when
 * complete: an incomplete one is refused whole (OutfitIncomplete), the
 * page again with its pieces.
 */
async function saveWithPicks(
  deps: ActionDeps,
  actor: Actor,
  save: StylingSave,
  schedule: Plan | undefined,
): Promise<string> {
  const garments = await ownGarments(deps.db, actor, save.garmentIds);
  const saved = await saveOutfit(deps, actor, {
    name: save.name ?? ideaName(garments),
    slots: slotsOf(garments),
    plan: schedule,
    origin: 'person',
    madeBy: BY_PERSON,
  });
  return savedOutfitPath(saved, schedule?.day);
}

/** What a refused Save's page reads again beyond the refusal. */
export interface RefusedAsk {
  posted: StylingSave;
  /** The page's capsule, posted only to show the page again. */
  capsuleId: number | undefined;
  /** The sheet as posted. */
  draft: SaveDraft;
}

/**
 * A refused Save's page: Styling as it was posted (its destination,
 * capsule, outfit and sheet), the rows holding a gone garment back to
 * "No garment" (clearedStates). Always the requester's own wardrobe: Save
 * takes nothing else, so a garment of another's is cleared like a deleted
 * one and never shown. One statement beside the aim, as the page without
 * "Style this" reads (plainOpening); the windows reach the rows, not the
 * outfit's garments.
 */
export async function refusedOpening(
  db: Db,
  actor: Actor,
  refusal: {
    error: OutfitGarmentsGone | OutfitIncomplete;
    states: RowState[];
  },
  ask: RefusedAsk,
  today: IsoDate,
): Promise<Opening> {
  const { userId } = actor;
  const { posted } = ask;
  const cleared = clearedStates(refusal.states, refusal.error);
  const own = posted.destination.kind === 'none';
  const scope: Scope = {
    userId,
    ownerId: userId,
    shared: false,
    viewOwner: undefined,
    capsuleId: ask.capsuleId,
    picksOffered: own,
    picks: posted.picks && own,
    editingOutfitId: posted.outfitId,
  };
  const [aimed, read] = await Promise.allSettled([
    aimIdeas(db, actor, posted.destination, today),
    stripsReads(db, scope, {
      checkCapsule: true,
      outfitId: posted.outfitId,
      heldIds: heldIdsOf(cleared),
      chosen: chosenOf(cleared),
      menu: true,
    }),
  ]);
  const reads = valueOf(read);
  const capsule = checkedCapsule(reads.capsule);
  const aim = valueOf(aimed);
  const saved = checkedOutfit(posted.outfitId, reads.outfit);
  return {
    wardrobe: wardrobeOf(scope, capsule, reads),
    aim,
    opened: { saved },
    styled: {},
    reads,
    refused: {
      error: refusal.error,
      states: checkedStates(cleared, reads.held),
      held: reads.held,
      draft: ask.draft,
    },
  };
}
