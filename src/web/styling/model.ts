import type { Idea } from '../../wardrobe/generator';
import type { GarmentRole } from '../../wardrobe/properties';
import type { CapsuleRef } from '../capsules/queries';
import type { IdeasAim } from '../gallery/aim';
import type { PoolGarment } from '../gallery/queries';
import { parseDestination } from '../outfits/destination';
import {
  describeGone,
  type OutfitGarmentsGone,
  OutfitIncomplete,
} from '../outfits/gone-garments';
import { safeReturnTo } from '../security/return-to';
import {
  openingStates,
  type RoleWindow,
  type RowState,
  type StylingRow,
  stylingRows,
  topToToe,
  withEveryRole,
} from './rows';
import type { Chosen, RoledGarment, SavedOutfit } from './queries';
import type { StripsReads, StylingScope } from './reads';
import type { SaveDraft, StylingModel } from './styling-page';
import type { StylingState } from './urls';

/**
 * Styling's model (#719): pure builders over what the reads found
 * (reads.ts), from the scope a request resolved to the page's model and
 * the rows a fragment answers. No reads and no refusals: the actions
 * (styling-actions.ts) read and refuse, routes.tsx parses and renders.
 */

/** The wardrobe a Styling request addresses, resolved. */
export interface Wardrobe {
  ownerId: number;
  /** A shared wardrobe's owner (links carry it); undefined for one's own. */
  viewOwner: number | undefined;
  capsule?: CapsuleRef;
  /** Include picks is on (`?picks=1`, StylingScope.picks). */
  picks: boolean;
  /**
   * Include picks may be turned on here: one's own wardrobe, no
   * destination, and not an edit of a planned or packed outfit (which
   * takes no pick). The switch shows only then.
   */
  picksOffered: boolean;
}

/**
 * A request's scope (reads.ts) with the owner its links carry, and whether
 * Include picks may be offered before the reads (the route's scopeOf).
 */
export type Scope = StylingScope &
  Pick<Wardrobe, 'viewOwner'> & { picksOffered: boolean };

/**
 * The wardrobe once the reads checked its capsule and whether the outfit
 * the rows edit is held (StripsReads.editingHeld): then no pick. Nor
 * while the closet cannot be dressed as an outfit (StripsReads.canDress,
 * the first-run gate, #666), unless picks are on already, so the switch
 * is there to turn them off.
 */
export function wardrobeOf(
  scope: Scope,
  capsule: CapsuleRef | undefined,
  { canDress, editingHeld }: Pick<StripsReads, 'canDress' | 'editingHeld'>,
): Wardrobe {
  const picks = scope.picks === true && !editingHeld;
  return {
    ownerId: scope.ownerId,
    viewOwner: scope.viewOwner,
    capsule,
    picks,
    picksOffered: scope.picksOffered && !editingHeld && (picks || canDress),
  };
}

/** What the page was opened with: a saved outfit (`?outfit=`), "Style this"'s garment (`?with=`). */
export interface Opened {
  saved?: SavedOutfit;
  with?: { id: number; role: GarmentRole };
}

/** "Style this"'s opening idea (openStyling); empty without `?with=`. */
export interface StyledOpening {
  idea?: Idea<PoolGarment>;
  /** Shuffle's next seed. */
  seed?: number;
  /** Nothing fits around the garment: the page says so. */
  missed?: boolean;
}

/** What GET /styling (or a refused Save) read to open the page (openStyling, refusedOpening). */
export interface Opening {
  wardrobe: Wardrobe;
  aim: IdeasAim;
  opened: Opened;
  styled: StyledOpening;
  reads: StripsReads;
  /** A refused Save: its rows as posted, instead of the opening ones. */
  refused?: RefusedSave;
}

/**
 * A Save refused for its garments (OutfitGarmentsGone), or for planning an
 * outfit with pieces not bought yet (OutfitIncomplete, #335), as the page
 * shows it again.
 */
export interface RefusedSave {
  error: OutfitGarmentsGone | OutfitIncomplete;
  /** The posted rows, those holding a gone garment back to "No garment". */
  states: RowState[];
  /** The posted garments the requester still owns (an archived one an edit keeps). */
  held: RoledGarment[];
  /** The sheet as it was posted. */
  draft: SaveDraft;
}

/** Back, and where a saved edit goes: a same-site path only, else none. */
export function returnToOf(value: string | undefined): string | undefined {
  return safeReturnTo(value, '') || undefined;
}

/** The page's model from what an opening read. */
export function pageModel(
  opening: Opening,
  returnTo: string | undefined,
): StylingModel {
  const { wardrobe, aim, opened, styled, reads, refused } = opening;
  return {
    state: {
      destination: aim.destination,
      capsuleId: wardrobe.capsule?.id,
      picks: wardrobe.picks,
      withId: opened.with?.id,
      outfitId: opened.saved?.id,
      ownerId: wardrobe.viewOwner,
      returnTo,
    },
    destination: aim.destination,
    rows: modelRows(opening),
    roles: rolesOf(reads.windows),
    seed: styled.seed,
    notice: styled.missed ? 'no-idea' : undefined,
    capsule: wardrobe.capsule,
    picksOffered: wardrobe.picksOffered,
    capsules: reads.capsules,
    outfit: opened.saved,
    trip: aim.trip,
    shared:
      reads.owner === undefined
        ? undefined
        : { ownerId: wardrobe.ownerId, name: reads.owner },
    refusal: refused && {
      message: refused.error.message,
      incomplete: refused.error instanceof OutfitIncomplete,
      draft: refused.draft,
      toBuy:
        refused.error instanceof OutfitIncomplete
          ? [...refused.error.pieces]
          : refused.error.gone.flatMap((g) =>
              g.garment?.status === 'wishlist'
                ? [{ id: g.id, name: g.garment.name }]
                : [],
            ),
    },
  };
}

/** The page's rows: a refused Save's as posted, else the opening ones. */
function modelRows(opening: Opening): StylingRow[] {
  const { opened, reads, refused } = opening;
  const { windows } = reads;
  if (refused) {
    const states = withEveryRole(refused.states, windows);
    return stylingRows(states, windows, refused.held);
  }
  const states = openingStates(windows, {
    saved: opened.saved?.garments,
    with: opened.with,
    idea: opening.styled.idea?.garments,
  });
  return stylingRows(states, windows, opened.saved?.garments ?? []);
}

/** A garment in its role's row, as the strips' windows reach it. */
export function chosen(garment: { id: number; role: GarmentRole }): Chosen {
  return { role: garment.role, garmentId: garment.id };
}

/** The rows' garments, each in its row's role (roleWindowsSql). */
export function chosenOf(states: readonly RowState[]): Chosen[] {
  return states.flatMap(({ role, garmentId }) =>
    garmentId === null ? [] : [{ role, garmentId }],
  );
}

/** The garments the rows hold. */
export function heldIdsOf(states: readonly RowState[]): number[] {
  return states.flatMap((state) => state.garmentId ?? []);
}

/** The garments the locked rows hold. */
export function lockedIdsOf(states: readonly RowState[]): number[] {
  return heldIdsOf(states.filter((state) => state.locked));
}

/**
 * The posted rows, checked against `held` (the wardrobe's owned garments
 * among theirs): a garment that is not one of its owned garments, or not
 * of its row's role (recategorised meanwhile), leaves the row at "No
 * garment", unlocked. An archived garment an edited outfit still holds
 * stays (a detached row).
 */
export function checkedStates(
  posted: readonly RowState[],
  held: readonly RoledGarment[],
): RowState[] {
  return posted.map((state) => {
    if (state.garmentId === null) return state;
    const garment = held.find((g) => g.id === state.garmentId);
    // The lock was on that garment: gone, the row is free again.
    return garment?.role === state.role
      ? state
      : { ...state, garmentId: null, locked: false };
  });
}

/**
 * A refused Save's rows: those holding a gone garment back to "No
 * garment", unlocked. An incomplete outfit's refusal keeps every row:
 * nothing in them is gone.
 */
export function clearedStates(
  states: readonly RowState[],
  error: OutfitGarmentsGone | OutfitIncomplete,
): RowState[] {
  const gone = new Set(
    error instanceof OutfitIncomplete ? [] : error.gone.map((g) => g.id),
  );
  return states.map((state) =>
    state.garmentId !== null && gone.has(state.garmentId)
      ? { ...state, garmentId: null, locked: false }
      : state,
  );
}

/** A refused Save's account for its log line: the pieces to buy, or the garments gone. */
export function refusalReason(
  error: OutfitGarmentsGone | OutfitIncomplete,
): string {
  return error instanceof OutfitIncomplete
    ? `outfit ${error.outfitId} not planned, ${error.pieces.length} piece(s) to buy`
    : `garments ${describeGone(error.gone)}`;
}

/** The debug line's account of what a page or a shuffle was over. */
export function describeScope(wardrobe: Wardrobe, opened: Opened = {}): string {
  return [
    wardrobe.viewOwner === undefined
      ? 'own wardrobe'
      : `wardrobe ${wardrobe.ownerId} (shared)`,
    wardrobe.capsule && `capsule ${wardrobe.capsule.id}`,
    wardrobe.picks && 'picks',
    opened.saved && `outfit ${opened.saved.id}`,
    opened.with && `with garment ${opened.with.id}`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The roles the wardrobe has garments of, top to toe: "Add row"'s choices. */
function rolesOf(windows: readonly RoleWindow[]): GarmentRole[] {
  return topToToe(windows).map((w) => w.role);
}

/**
 * The state a fragment's links carry on (the sentinel's, the Include
 * picks switch's pushed address), from a posted query.
 */
export function postedState(
  query: {
    for?: string;
    occasion?: string;
    replace?: string;
    with?: number;
    outfit?: number;
    returnTo?: string;
  },
  wardrobe: Wardrobe,
): StylingState {
  const own = wardrobe.viewOwner === undefined;
  return {
    destination: parseDestination(query),
    capsuleId: wardrobe.capsule?.id,
    picks: wardrobe.picks,
    withId: query.with,
    outfitId: own ? query.outfit : undefined,
    ownerId: wardrobe.viewOwner,
    returnTo: returnToOf(query.returnTo),
  };
}
