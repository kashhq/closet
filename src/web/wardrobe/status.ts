import { and, type Column, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { ownerLockCte, ownerLocked } from '../../db/owner-lock';
import { garment, optionGroup } from '../../db/schema';
import {
  type GarmentStatus,
  type GarmentStatusEvent,
  garmentStatusTransition,
} from '../../wardrobe/status';
import type { IsoDate } from '../../calendar-date';

/**
 * garment.status in queries: the predicates every read uses, and the one
 * writer of a status change (the machine itself is pure,
 * src/wardrobe/status.ts). The status is written at insert (insertGarment,
 * an entry status) and changed only by setGarmentsStatus below (or its
 * one-garment form, setGarmentStatus).
 */

/**
 * "In the closet": owned and in use. The one predicate for every closet
 * read, so a wishlist item or an archived garment never shows up where
 * clothes one can wear do: the grid (without "Include archived"), the outfit
 * Styling's strips, capsules' counts and pages, tagging mode, laundry and
 * the wash counts, availableGarment (src/web/wears/queries.ts), the MCP
 * tools' closet reads, the outfit generator (#9, through availableGarment),
 * insights (src/web/insights/queries.ts) and "Goes with my closet" (#18b:
 * closetGarmentsSql, src/web/gallery/queries.ts, with one wishlist item locked
 * beside it, never mixed in).
 *
 * `status` is the column to test: garment.status, or an alias's (the outfit
 * edit form's peers).
 */
export function inCloset(status: Column = garment.status): SQL {
  return eq(status, 'closet');
}

/**
 * On the wishlist, set aside or not: a wishlist item's own page and what
 * may be done to one ("Bought it", goes-with). A list of things to buy
 * reads wanted instead.
 */
export function onWishlist(): SQL {
  return eq(garment.status, 'wishlist');
}

/**
 * Still wanted: on the wishlist and not set aside (a dismissed suggestion,
 * src/wardrobe/suggestions.ts, stays on the wishlist as the agent's
 * feedback). Every list of things to buy: the Wishlist tab, list_wishlist
 * (MCP), the offline warm, Styling's To-buy row.
 */
export function wanted(): SQL {
  return sql`(${onWishlist()} and ${garment.dismissedAt} is null)`;
}

/**
 * Wanted, and not under a need the owner set aside (Not this need right
 * now: its picks are hidden with it, src/web/wishlist/suggestions.md):
 * what Styling's Include picks offers and its rows may carry (#335,
 * src/web/styling/queries.ts: picksSql, rowGarmentsSql). The owner's own
 * wishlist items too: one "not owned yet" list.
 */
export function offeredToStyle(): SQL {
  return sql`(${wanted()} and not exists (
    select 1 from ${optionGroup}
    where ${optionGroup.id} = ${garment.suggestionGroupId}
      and ${optionGroup.status} = 'dismissed'
  ))`;
}

/**
 * Owned now or once (the closet and the archive), never a wishlist item:
 * the grid's "Include archived", the filter modal's choices, what an outfit
 * slot, a capsule membership or a wash may name.
 */
export function ownedGarment(): SQL {
  return ne(garment.status, 'wishlist');
}

/** Which garments a list shows (GridFilters.scope). */
export type GarmentScope = 'closet' | 'owned' | 'wishlist';

export function inScope(scope: GarmentScope): SQL {
  switch (scope) {
    case 'closet':
      return inCloset();
    case 'owned':
      return ownedGarment();
    case 'wishlist':
      return onWishlist();
  }
}

/** What "Bought it" records with the move: the day and the price paid. */
export interface Purchase {
  acquiredOn: IsoDate | null;
  price: string | null;
}

/** A status change: the machine's event, and for a purchase what it records. */
export type StatusChange =
  | ({ event: 'buy' } & Purchase)
  | { event: Exclude<GarmentStatusEvent, 'buy'> };

export type StatusOutcome =
  | { ok: true; from: GarmentStatus; to: GarmentStatus }
  /** Not in `ownerId`'s wardrobe: a 404 like an unknown id. */
  | { ok: false; reason: 'not-found' }
  /** The garment's status does not take the event (a 409): where it stays. */
  | { ok: false; reason: 'not-allowed'; status: GarmentStatus };

/**
 * The one writer of a garment's status after its insert, for one garment:
 * setGarmentsStatus's answer for `id`. Every archive, restore and "Bought
 * it" (the routes, the seed, buyGarment) comes through here or through the
 * list form below. A savepoint inside a caller's transaction.
 */
export async function setGarmentStatus(
  db: Queryable,
  id: number,
  ownerId: number,
  change: StatusChange,
): Promise<StatusOutcome> {
  const outcomes = await setGarmentsStatus(db, [id], ownerId, change);
  return outcomes.get(id) ?? { ok: false, reason: 'not-found' };
}

/**
 * The status writer itself: locks the listed garments of `ownerId` (the
 * owner lock first, in the same statement; then id order, as every
 * multi-row locker takes them), asks the machine (garmentStatusTransition)
 * for each and writes the moves in one update, with what a purchase
 * records. Answers each garment found; an id outside the wardrobe is
 * absent (a 404 like an unknown id to a caller that named one). Select
 * mode's Archive (#677) and setGarmentStatus. A savepoint inside a
 * caller's transaction.
 */
export function setGarmentsStatus(
  db: Queryable,
  ids: readonly number[],
  ownerId: number,
  change: StatusChange,
): Promise<Map<number, StatusOutcome>> {
  return db.transaction(async (tx) => {
    const lock = ownerLockCte(tx, ownerId);
    const rows = await tx
      .with(lock)
      .select({ id: garment.id, status: garment.status })
      .from(garment)
      .where(
        and(
          inArray(garment.id, [...ids]),
          eq(garment.ownerId, ownerId),
          ownerLocked(tx, lock),
        ),
      )
      .orderBy(garment.id)
      .for('update', { of: garment });
    const outcomes = new Map<number, StatusOutcome>();
    const moved: number[] = [];
    let to: GarmentStatus | undefined;
    for (const row of rows) {
      const move = garmentStatusTransition(row.status, change.event);
      if (move.ok) {
        moved.push(row.id);
        to = move.to;
        outcomes.set(row.id, move);
      } else {
        outcomes.set(row.id, {
          ok: false,
          reason: 'not-allowed',
          status: move.status,
        });
      }
    }
    // One event has one edge, so every move lands in the same status.
    if (to !== undefined) {
      await tx
        .update(garment)
        .set({
          status: to,
          ...(change.event === 'buy' && {
            acquiredOn: change.acquiredOn,
            price: change.price,
            boughtAt: sql`now()`,
          }),
        })
        .where(inArray(garment.id, moved));
    }
    return outcomes;
  });
}

export type BuyOutcome =
  | (StatusOutcome & { ok: false })
  | {
      ok: true;
      /** The replaced garment archived with it; null when not asked or not in the closet. */
      archivedReplaced: number | null;
    };

/**
 * "Bought it": the wishlist item moves to the closet with its purchase,
 * and, only when asked (never silently), the garment it replaces goes to
 * the archive, in one transaction. A replaced garment that is no longer in
 * the closet (archived meanwhile) is left as it is.
 */
export function buyGarment(
  db: Queryable,
  id: number,
  ownerId: number,
  purchase: Purchase & { archiveReplaced: boolean },
): Promise<BuyOutcome> {
  return db.transaction(async (tx) => {
    const bought = await setGarmentStatus(tx, id, ownerId, {
      event: 'buy',
      acquiredOn: purchase.acquiredOn,
      price: purchase.price,
    });
    if (!bought.ok) return bought;
    if (!purchase.archiveReplaced) return { ok: true, archivedReplaced: null };
    const [row] = await tx
      .select({ replaces: garment.replacesGarmentId })
      .from(garment)
      .where(eq(garment.id, id));
    if (row.replaces === null) return { ok: true, archivedReplaced: null };
    const archived = await setGarmentStatus(tx, row.replaces, ownerId, {
      event: 'archive',
    });
    return { ok: true, archivedReplaced: archived.ok ? row.replaces : null };
  });
}
