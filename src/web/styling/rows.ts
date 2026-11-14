import { DRAWN_ROLES, OUTFIT_ORDER } from '../../wardrobe/generator';
import type { GarmentRole } from '../../wardrobe/properties';
import type { GarmentStatus } from '../../wardrobe/status';
import type { SignablePhotoRef } from '../files/image-url';

/**
 * Styling's rows (#42; docs/plans/2026-09-26-redesign.md, "Styling"), pure:
 * the outfit builder's cycle engine, by role instead of by category. A
 * role's **cycle** is "No garment" and then the addressed wardrobe's closet
 * garments of that role (`inCloset`, within the capsule when one is chosen),
 * newest first: what a row's strip scrolls through. The page reads only a
 * window of each cycle per row (queries.ts: STRIP_PAGE either side of the
 * row's garment, or the first STRIP_PAGE); the strip's sentinels fetch the
 * rest a page at a time, older at its end and newer at its start (#996).
 *
 * A row is a role and its state: which garment is centred (null: "No
 * garment") and whether it is locked (Shuffle leaves it alone). The rows
 * are the state; the browser moves the centred garment by scrolling
 * (public/js/snap-strip.js) and posts the state back for Shuffle and Save.
 */

/** Garments per strip page: one centred at phone width, its neighbours, and room to swipe. */
export const STRIP_PAGE = 10;

/** Rows top to toe: the generator's outfit order, so a saved outfit reads the same everywhere. */
const STYLING_ORDER: readonly GarmentRole[] = OUTFIT_ORDER;

/** The most rows a page carries (a role's second row is an "Add row"). */
export const MAX_ROWS = 20;

/** A garment as a strip shows it. */
export interface RowGarment {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
  photo: SignablePhotoRef | null;
}

/** A garment of a role's cycle with its place in it: 1 is the newest. */
export interface RankedGarment extends RowGarment {
  rank: number;
}

/**
 * What a page read of a role's cycle (of `count`), newest first: the head
 * and the garments around each chosen one, which may be separate runs;
 * each row's strip shows the run around its own garment (windowAround).
 */
export interface RoleWindow {
  role: GarmentRole;
  count: number;
  garments: RankedGarment[];
  /**
   * Include picks' garments of this role (`?picks=1`, status `wishlist`),
   * shown before the cycle on the strip and never chosen by default, nor
   * counted in `count`, nor paged: they are not the cycle (withPicks).
   */
  picks?: RowGarment[];
}

/** What a row holds, as the page posts it back. */
export interface RowState {
  role: GarmentRole;
  garmentId: number | null;
  locked: boolean;
}

export interface StylingRow extends RowState {
  /**
   * The strip after "No garment": a selected garment outside the cycle
   * first (archived since the outfit was saved: it stays chosen, and
   * saving keeps it; its status marks it), then the window of the cycle.
   */
  garments: RowGarment[];
  /** The cycle has older garments past the window: the next page starts before this id. */
  moreBefore?: number;
  /**
   * The cycle has newer garments than the window (its garment is deep in
   * the cycle): the previous page ends after this id, the window's first,
   * and its sentinel sits right before that garment.
   */
  moreAfter?: number;
}

/** A role's order top to toe; a role outside the list (none is) sorts last. */
function rank(role: GarmentRole): number {
  const at = STYLING_ORDER.indexOf(role);
  return at === -1 ? STYLING_ORDER.length : at;
}

/** Rows (or garments) in outfit order; those of one role keep their order. */
export function topToToe<R extends { role: GarmentRole }>(
  rows: readonly R[],
): R[] {
  return [...rows].sort((a, b) => rank(a.role) - rank(b.role));
}

/**
 * What a fresh stack opens on (the dock's Style, a capsule): one row per
 * role the wardrobe has, every one on "No garment" (#665). The newest
 * garment of each role is neither a suggestion nor wearable (it ignores wash
 * and away state: swim trunks under a coat in November), so the page opens
 * empty and Shuffle, its primary action, draws an idea that respects both.
 * Newest first stays the strip's order. Deterministic, never of the day or
 * the wardrobe's contents (the service worker's tab-root rule,
 * page-cache.ts).
 */
export function freshStates(windows: readonly RoleWindow[]): RowState[] {
  return topToToe(windows).map(({ role }) => ({
    role,
    garmentId: null,
    locked: false,
  }));
}

/**
 * `windows` with Include picks' garments on their roles' strips
 * (`?picks=1`), in the order given (a need's options side by side). A role
 * the closet has nothing of gets a window of picks alone, so its row
 * exists to hold them.
 */
export function withPicks(
  windows: readonly RoleWindow[],
  picks: readonly (RowGarment & { role: GarmentRole })[],
): RoleWindow[] {
  const result = windows.map((w): RoleWindow => ({ ...w }));
  for (const { role, ...pick } of picks) {
    let window = result.find((w) => w.role === role);
    if (!window) {
      window = { role, count: 0, garments: [] };
      result.push(window);
    }
    window.picks = [...(window.picks ?? []), pick];
  }
  return result;
}

/**
 * A saved outfit's rows (`?outfit=`): a row per garment, top to toe (two
 * accessories are two accessory rows), then an empty row for each other
 * role the wardrobe has, so any of them can be added.
 */
export function savedStates(
  garments: readonly { id: number; role: GarmentRole }[],
  windows: readonly RoleWindow[],
): RowState[] {
  return withEveryRole(
    garments.map((g) => ({ role: g.role, garmentId: g.id, locked: false })),
    windows,
  );
}

/**
 * `states` in outfit order, with an empty, unlocked row added for each role
 * of `windows` that has none: posted rows (Shuffle), a saved outfit's.
 */
export function withEveryRole(
  states: readonly RowState[],
  windows: readonly RoleWindow[],
): RowState[] {
  const missing = windows
    .filter((w) => !states.some((state) => state.role === w.role))
    .map((w): RowState => ({ role: w.role, garmentId: null, locked: false }));
  return topToToe([...states, ...missing]);
}

/**
 * `garmentId` chosen and locked in its role's first row ("Style this",
 * `?with=`): the row every Shuffle keeps.
 */
export function lockedOn(
  states: readonly RowState[],
  garment: { id: number; role: GarmentRole },
): RowState[] {
  const at = states.findIndex((state) => state.role === garment.role);
  const locked: RowState = {
    role: garment.role,
    garmentId: garment.id,
    locked: true,
  };
  if (at === -1) return topToToe([...states, locked]);
  return states.map((state, i) => (i === at ? locked : state));
}

/**
 * Shuffle's answer: the generator's idea in the unlocked rows it fills. A
 * drawn role (layer, one-piece, top, bottom, footwear) takes the idea's
 * garment in its first unlocked row and "No garment" in any other, so a
 * one-piece idea empties the top and bottom rows and an idea without a
 * layer empties the layer's. Locked rows, and rows the generator never
 * fills (accessories, bags, uncategorised), are left as they are.
 */
export function shuffledStates(
  states: readonly RowState[],
  idea: readonly { id: number; role: GarmentRole }[],
): RowState[] {
  const unplaced = [...idea];
  return states.map((state) => {
    if (state.locked || !DRAWN_ROLES.includes(state.role)) return state;
    const at = unplaced.findIndex((g) => g.role === state.role);
    if (at === -1) return { ...state, garmentId: null };
    const [garment] = unplaced.splice(at, 1);
    return { ...state, garmentId: garment.id };
  });
}

/**
 * What the page opens on: a saved outfit's rows (`?outfit=`), else the
 * fresh stack; with "Style this"'s garment chosen and locked (`?with=`),
 * and the day's first idea around it in the other rows.
 */
export function openingStates(
  windows: readonly RoleWindow[],
  opened: {
    saved?: readonly { id: number; role: GarmentRole }[];
    with?: { id: number; role: GarmentRole };
    idea?: readonly { id: number; role: GarmentRole }[];
  },
): RowState[] {
  const base = opened.saved
    ? savedStates(opened.saved, windows)
    : freshStates(windows);
  const locked = opened.with ? lockedOn(base, opened.with) : base;
  return opened.idea ? shuffledStates(locked, opened.idea) : locked;
}

/**
 * The page's rows: each state with its role's window around its garment
 * (windowAround). A selected garment the window does not hold is one
 * outside the cycle (`detached`: archived, the only kind of owned garment
 * no cycle has), shown first; one found in neither is gone (deleted
 * since), and the row falls back to "No garment".
 */
export function stylingRows(
  states: readonly RowState[],
  windows: readonly RoleWindow[],
  detached: readonly RowGarment[],
): StylingRow[] {
  return states.map((state) => {
    const window = windows.find((w) => w.role === state.role);
    const run = window ? windowAround(window, state.garmentId) : [];
    const strip = [...(window?.picks ?? []), ...run];
    const first = run.at(0);
    const last = run.at(-1);
    return {
      ...state,
      ...stripOf(state.garmentId, strip, detached),
      moreBefore:
        window && last && last.rank < window.count ? last.id : undefined,
      moreAfter: first && first.rank > 1 ? first.id : undefined,
    };
  });
}

/**
 * The run of `window` a row's strip shows: STRIP_PAGE either side of the
 * row's garment when the cycle has it, else the head (the first
 * STRIP_PAGE), which roleWindowsSql always reads.
 */
function windowAround(
  window: RoleWindow,
  garmentId: number | null,
): RankedGarment[] {
  const at = window.garments.find((g) => g.id === garmentId)?.rank;
  const [from, to] =
    at === undefined ? [1, STRIP_PAGE] : [at - STRIP_PAGE, at + STRIP_PAGE];
  return window.garments.filter((g) => g.rank >= from && g.rank <= to);
}

/** A row's strip and choice: the cycle's window, led by a detached choice. */
function stripOf(
  garmentId: number | null,
  cycle: RowGarment[],
  detached: readonly RowGarment[],
): Pick<StylingRow, 'garmentId' | 'garments'> {
  if (garmentId === null || cycle.some((g) => g.id === garmentId)) {
    return { garmentId, garments: cycle };
  }
  const outside = detached.find((g) => g.id === garmentId);
  return outside
    ? { garmentId, garments: [outside, ...cycle] }
    : { garmentId: null, garments: cycle };
}
