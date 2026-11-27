import { and, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
  tripOutfit,
} from '../../db/schema';
import { KEPT_ORIGINS } from '../../wardrobe/outfit-origin';
import type { GarmentStatus } from '../../wardrobe/status';
import { onWishlist } from '../wardrobe/status';

/**
 * What holds an outfit: a calendar entry (any day, worn or not) and a trip
 * (#10). The one list, like photoIsReferenced (src/web/files/references.ts)
 * for photos. "Delete an outfit once nothing holds it" (the planner's
 * outfits, removeUnheldOutfits: Undo, the re-plan's swap, Change) asks
 * this, because deleteOutfit cascades every holder: a holder missing here
 * is a row silently deleted with the outfit (a trip lost its outfit and
 * its packing list that way). A new table with an `outfit_id` must be
 * added here (were its column nullable, it would need `is not null` here,
 * or `not in` is null and nothing is ever removed). Its slots
 * (outfit_slot) are its own parts, not holders.
 *
 * Uncorrelated on purpose, for the reason photoIsReferenced gives: in a
 * single-table select drizzle writes a SQL field's columns without their
 * table, so a correlated `outfit_calendar.outfit_id = outfit.id` would
 * compare outfit_calendar's own columns. Both columns are not null, so
 * `not in` is never null.
 */
export function outfitIsHeld(outfitId: AnyPgColumn | SQL): SQL<boolean> {
  return sql<boolean>`(${outfitId} in (select ${outfitCalendar.outfitId} from ${outfitCalendar} union all select ${tripOutfit.outfitId} from ${tripOutfit}))`;
}

/**
 * **An outfit may hold a garment not owned yet (a wishlist item, the agent's
 * pick) only while nothing holds it** (#335, docs/plans/2026-10-05-agent-
 * suggestions.md section 3). Such an outfit is incomplete: it cannot be
 * planned, packed or worn, so a held outfit is always complete. The rule's
 * two halves, each enforced by the writers of its side:
 * - a slot write holds a wishlist garment only into an outfit nothing
 *   holds (slotMayNameSql, src/web/outfits/gone-garments.ts: insertSlots);
 * - a write that makes an outfit held refuses an incomplete one
 *   (OutfitIncomplete): the calendar's upsertEntry, planToWear and
 *   setEntryOutfit (src/web/calendar/queries.ts), and addTripOutfit
 *   (src/web/trips/queries.ts).
 * Wearing needs an entry, and Today, Ideas and the week planner pick only
 * closet garments (pickIdea), so nothing else can reach one; the
 * generator's memory leaves incomplete outfits out (savedSlotsSql), or a
 * pick its drawn roles share with one would never be suggested.
 *
 * Bought it completes an outfit (the garment leaves the wishlist); nothing
 * in the outfit is written. Derived on every read, never stored. Deleting
 * an own wishlist item (Remove) nulls its
 * slot through the foreign key, so the outfit becomes complete with a gap,
 * as a deleted closet garment leaves one (a suggestion is never deleted on
 * the wishlist: a dismissed pick keeps its slot).
 */

/** A piece an outfit holds that is not owned yet, as a refusal or a page names it. */
export interface PieceToBuy {
  id: number;
  name: string | null;
}

/**
 * The outfit's slots holding a piece not owned yet: the one join both
 * readers below share. `outfitId` must render qualified (a parameter, or a
 * column inside a raw `sql` template): in a single-table drizzle select an
 * unqualified `id` would name this subquery's garment.
 */
function piecesToBuyFrom(outfitId: SQL | AnyPgColumn): SQL {
  return sql`from ${outfitSlot}
    inner join ${garment} on ${eq(garment.id, outfitSlot.garmentId)}
    where ${and(eq(outfitSlot.outfitId, outfitId), onWishlist())}`;
}

/** The outfit's pieces not owned yet, in slot order, as a JSON list; empty when it is complete. */
function piecesToBuySql(outfitId: SQL | AnyPgColumn): SQL<PieceToBuy[]> {
  return sql<PieceToBuy[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${garment.id}, 'name', ${garment.name}
    ) order by ${outfitSlot.position}), '[]')
    ${piecesToBuyFrom(outfitId)}
  )`;
}

/** Whether the outfit holds only owned garments (piecesToBuyFrom's caveat on `outfitId`). */
export function outfitIsComplete(outfitId: SQL | AnyPgColumn): SQL<boolean> {
  return sql<boolean>`not exists (select 1 ${piecesToBuyFrom(outfitId)})`;
}

/**
 * piecesToBuySql over garments a page already read with their status (the
 * outfit's garments, slot order): the same rule, for the views and the MCP
 * tools.
 */
export function piecesToBuy<T extends { status: GarmentStatus }>(
  garments: readonly T[],
): T[] {
  return garments.filter(isPieceToBuy);
}

/** One garment of an outfit by piecesToBuy's rule: not owned yet. */
export function isPieceToBuy(garment: { status: GarmentStatus }): boolean {
  return garment.status === 'wishlist';
}

/**
 * The owner's own outfits, as the Saved grid, the pickers (a day's, a
 * trip's), the garment page's strip and MCP's list_outfits list them:
 * never proposed, or one of the agent's proposals loved while complete ("Save"
 * is Love on a complete outfit, #335; src/web/outfits/proposals.ts).
 * The agent's others are the Outfits tab's own section. `outfitId` defaults to
 * the `outfit` row's own id, rendered qualified (a raw `sql` template's);
 * a single-table select passes it as a parameter (piecesToBuyFrom).
 */
export function ownersOutfit(
  outfitId: SQL | AnyPgColumn = outfit.id,
): SQL<boolean> {
  return sql<boolean>`(${outfit.proposedAt} is null or (${outfit.reaction} = 'loved' and ${outfitIsComplete(outfitId)}))`;
}

/**
 * An outfit someone chose to keep (#659, src/wardrobe/outfit-origin.ts):
 * the one rule of what the Saved tab and the pickers (a day's, a trip's)
 * list by default; `not` it is their "Worn and planned" one-offs. Read
 * only by savedOutfitsSql and listOutfitsPage, so the surfaces never
 * disagree.
 */
export function keptOutfit(): SQL {
  return inArray(outfit.origin, KEPT_ORIGINS);
}

/** The agent's proposals still waiting on the owner, and those set aside: not the owner's. */
export function agentOutfit(): SQL {
  return sql`(${isNotNull(outfit.proposedAt)} and not ${ownersOutfit()})`;
}

/**
 * One of the agent's outfits still waiting on the owner: not theirs yet, and
 * not set aside (the From the agent section's cards). What a round's Today card
 * counts (src/web/wishlist/rounds.ts) and GET /api/v1/outfits?proposed=true.
 */
export function agentOutfitWaiting(): SQL {
  return sql`(${agentOutfit()} and ${outfit.reaction} <> 'declined')`;
}

/**
 * One of the agent's proposals not the owner's yet (proposed, sent back, set
 * aside): never planned, packed or worn, complete or not (#335). By id, a
 * parameter.
 */
function outfitIsPendingProposal(outfitId: SQL): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${outfit} as pending
    where pending.id = ${outfitId} and pending.proposed_at is not null
      and pending.reaction <> 'loved'
  )`;
}

/**
 * **THE rule for what may be held** (a calendar entry, a trip, a wear):
 * complete, and the owner's (#335). Every write that makes an outfit held
 * writes only where it holds (the calendar's upsertEntry, planToWear and
 * setEntryOutfit; addTripOutfit) and reads why not in the same statement
 * (holdRefusalColumns), refusing with refuseUnholdable
 * (src/web/outfits/gone-garments.ts). By id, a parameter.
 */
export function outfitMayBeHeld(outfitId: SQL): SQL<boolean> {
  return sql<boolean>`(${outfitIsComplete(outfitId)} and not ${outfitIsPendingProposal(outfitId)})`;
}

/** Why outfitMayBeHeld is false, as select columns: `toBuy` (piecesToBuySql) and `pending`. */
export function holdRefusalColumns(outfitId: SQL): SQL {
  return sql`${piecesToBuySql(outfitId)} as "toBuy", ${outfitIsPendingProposal(outfitId)} as "pending"`;
}
