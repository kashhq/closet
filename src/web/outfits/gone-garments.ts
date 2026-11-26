import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment, outfitSlot } from '../../db/schema';
import type { GarmentStatus } from '../../wardrobe/status';
import { HttpError } from '../errors';
import { joinCopy, t, type Translated } from '../i18n';
import { inCloset, offeredToStyle } from '../wardrobe/status';
import { outfitIsHeld, type PieceToBuy } from './references';
import { NotFound } from '../refusals';

/**
 * A save that names a garment it cannot hold is refused whole (#219):
 * nothing is written and the answer names what is missing. Never a slot
 * stored empty, never a pick that quietly drops a piece.
 *
 * **What an outfit's slots may name is one rule, slotMayNameSql**, judged
 * by the writer (insertSlots, under the owner lock, in its locked read)
 * and read by Styling for what its rows may carry (rowGarmentsSql), so the
 * page and the write never disagree. A pick (pickIdea) takes closet
 * garments only (its own locked read, pickedGarments).
 *
 * `Holdable` names what a read before a save expects, for the refusal's
 * words: `closet` (a pick: garments to wear now), or `wardrobe` (any
 * garment of the owner's: the read that takes a slot write's categories,
 * whose writer then judges with slotMayNameSql).
 */
export type Holdable = 'closet' | 'wardrobe';

function holds(holdable: Holdable, status: GarmentStatus): boolean {
  return holdable === 'wardrobe' || status === 'closet';
}

/**
 * Whether outfit `outfitId` may take a garment not bought yet: while
 * nothing holds it (an incomplete outfit is never planned or packed). The
 * `offered` of slotMayNameSql for the writer (insertSlots) and for
 * Styling's rows that edit the outfit (rowGarmentsSql), so they agree.
 */
export function offeredIntoSql(outfitId: number): SQL {
  return sql`not ${outfitIsHeld(sql`${outfitId}::int`)}`;
}

/**
 * What an outfit's slots may name, over `garment` (#335): a closet
 * garment; one the outfit already holds (`outfitId`: an edit keeps an
 * archived garment, or a pick set aside since); and a garment not owned
 * yet that is offered to style with (offeredToStyle: still wanted, not
 * under a need set aside) where `offered` allows it: the writer allows it
 * while nothing holds the outfit (an incomplete outfit is never planned or
 * packed, src/web/outfits/references.ts), Styling while Include picks is
 * on. Never an archived garment the outfit does not hold, nor a pick set
 * aside. The garment's owner is the caller's to check.
 */
export function slotMayNameSql(options: {
  outfitId: number | undefined;
  offered: SQL | boolean;
}): SQL {
  const { outfitId, offered } = options;
  return or(
    inCloset(),
    offeredClause(offered),
    outfitId === undefined
      ? undefined
      : sql`${garment.id} in (select ${outfitSlot.garmentId} from ${outfitSlot} where ${outfitSlot.outfitId} = ${outfitId}::int)`,
  )!;
}

/** slotMayNameSql's `offered`: never, always, or where that condition holds. */
function offeredClause(offered: SQL | boolean): SQL | undefined {
  if (offered === false) return undefined;
  if (offered === true) return offeredToStyle();
  return and(offeredToStyle(), offered);
}

/** A garment a save named that it cannot hold. */
export interface GoneGarment {
  id: number;
  /**
   * The owner's garment in the wrong state (archived for a pick, on the
   * wishlist): named. Undefined for an id that is no garment of theirs
   * (deleted, another user's, never existed): those are indistinguishable,
   * and naming another user's garment would reveal it. `reason` tells a
   * slot write's refusal of a wishlist garment (slotRefusals): the outfit
   * is planned or packed, or the pick was set aside.
   */
  garment?: {
    name: string | null;
    status: GarmentStatus;
    reason?: 'outfit-held' | 'set-aside';
  };
}

/** An owner's garment as a save judges it: what it may hold, and the slot it fills. */
interface NamedGarment {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
}

/**
 * `ownerId`'s garments among `garmentIds`, by id, whatever their status:
 * one statement. goneGarments' read, and newOutfitSlots', which takes each
 * slot's category from it and judges the save with goneOf, so refusing
 * costs no second read (#172).
 */
async function namedGarments(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
): Promise<Map<number, NamedGarment>> {
  const wanted = [...new Set(garmentIds)];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      status: garment.status,
    })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), inArray(garment.id, wanted)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Which of `garmentIds` a save of `ownerId`'s cannot hold, in the order
 * given. One statement. Read after the write refused (or inside its
 * transaction, as insertSlots does), so it names what the refusal saw.
 */
export async function goneGarments(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
  holdable: Holdable,
): Promise<GoneGarment[]> {
  return goneOf(
    await namedGarments(db, ownerId, garmentIds),
    garmentIds,
    holdable,
  );
}

/** goneGarments over garments already read (namedGarments). */
function goneOf(
  found: ReadonlyMap<number, NamedGarment>,
  garmentIds: readonly number[],
  holdable: Holdable,
): GoneGarment[] {
  const wanted = [...new Set(garmentIds)];
  return wanted.flatMap((id): GoneGarment[] => {
    const row = found.get(id);
    if (!row) return [{ id }];
    if (holds(holdable, row.status)) return [];
    return [{ id, garment: { name: row.name, status: row.status } }];
  });
}

/**
 * The garments a slot write refused (`refusedIds`, the ones its locked read
 * left out: slotMayNameSql), named as insertSlots' refusal says them: not
 * the owner's (unnamed), archived, or a wishlist garment refused because
 * the outfit is planned or packed (`heldOutfit`, which the writer read) or
 * because it is not offered any more (set aside). Read in the write's
 * transaction, so it names what the refusal saw.
 */
export async function slotRefusals(
  db: Queryable,
  ownerId: number,
  refusedIds: readonly number[],
  heldOutfit: boolean,
): Promise<GoneGarment[]> {
  const found = await namedGarments(db, ownerId, refusedIds);
  return [...new Set(refusedIds)].flatMap((id): GoneGarment[] => {
    const row = found.get(id);
    if (!row) return [{ id }];
    // In the closet by the lookup (restored meanwhile): nothing to name.
    if (row.status === 'closet') return [];
    const garment = { name: row.name, status: row.status };
    if (row.status !== 'wishlist') return [{ id, garment }];
    const reason = heldOutfit ? 'outfit-held' : 'set-aside';
    return [{ id, garment: { ...garment, reason } }];
  });
}

function goneReason(owned: NonNullable<GoneGarment['garment']>): Translated {
  const name = owned.name ?? t('outfits.UNNAMED_GARMENT');
  if (owned.status !== 'wishlist') return t('outfits.GONE_ARCHIVED', { name });
  switch (owned.reason) {
    case 'outfit-held':
      return t('outfits.GONE_WISHLIST_HELD', { name });
    case 'set-aside':
      return t('outfits.GONE_SET_ASIDE', { name });
    case undefined:
      return t('outfits.GONE_WISHLIST', { name });
  }
}

/** The refusal's words: each named garment, then how many are gone. */
function refusalMessage(gone: readonly GoneGarment[]): Translated {
  const reasons = gone.flatMap((g) =>
    g.garment ? [goneReason(g.garment)] : [],
  );
  const missing = gone.length - reasons.length;
  if (missing === 1) reasons.push(t('outfits.GONE_ONE'));
  if (missing > 1) reasons.push(t('outfits.GONE_MANY', { count: missing }));
  return t('outfits.NOT_SAVED', { reasons: joinCopy(reasons, '; ') });
}

/**
 * The refusal of a save that named garments it cannot hold: nothing was
 * written. A 409 when every one is the owner's (archived, on the
 * wishlist: named, so the person knows which to change); a 404 when any
 * is not a garment of theirs, the answer an unknown id gets everywhere
 * (AGENTS.md, Request security: refusals do not reveal ids), with the
 * same words. Styling answers it with its page, the rows kept
 * (src/web/styling); anywhere else it is the error page or the MCP tool
 * error.
 */
export class OutfitGarmentsGone extends HttpError {
  /** `context` leads the log detail: who was refused, doing what. */
  constructor(
    readonly gone: readonly GoneGarment[],
    context?: string,
  ) {
    super(gone.every((g) => g.garment) ? 409 : 404, refusalMessage(gone), {
      logDetail: `${context ? `${context}: ` : ''}garments ${describeGone(gone)}`,
    });
    this.name = 'OutfitGarmentsGone';
  }
}

/**
 * The slots of a new outfit of `garmentIds` (MCP create_outfit and
 * suggest_outfit): each its garment's category, as Styling saves them,
 * read for every garment in one statement (#172: it was one per garment).
 * A garment not `holdable` (another's, deleted, archived) refuses the
 * save, named from the same read, as the pages refuse it (#219).
 */
export async function newOutfitSlots(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
  holdable: Holdable,
): Promise<{ category: string; garmentId: number }[]> {
  const garments = await namedGarments(db, ownerId, garmentIds);
  const gone = goneOf(garments, garmentIds, holdable);
  if (gone.length > 0) throw new OutfitGarmentsGone(gone);
  // Nothing gone: every id was read.
  return garmentIds.map((garmentId) => ({
    category: garments.get(garmentId)!.category,
    garmentId,
  }));
}

/** The gone garments for a log line: `12 (archived), 14 (not theirs)`. */
export function describeGone(gone: readonly GoneGarment[]): string {
  return gone
    .map((g) => `${g.id} (${g.garment ? g.garment.status : 'not theirs'})`)
    .join(', ');
}

/**
 * The refusal for garments a pick or a save could not hold, as goneGarments
 * read them. Should none be gone by then (restored between the refusal and
 * the lookup), the plain 404 a pick has always answered.
 */
export function garmentsGoneRefusal(
  gone: readonly GoneGarment[],
  context?: string,
): HttpError {
  return gone.length > 0
    ? new OutfitGarmentsGone(gone, context)
    : new NotFound('garment', { logDetail: context });
}

/**
 * The refusal of a pick or a save that found garments it cannot hold,
 * named as they are now (garmentsGoneRefusal over goneGarments).
 */
export async function garmentsGoneError(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
  holdable: Holdable,
): Promise<HttpError> {
  return garmentsGoneRefusal(
    await goneGarments(db, ownerId, garmentIds, holdable),
  );
}

/**
 * The refusal of a write that would plan, pack or wear an incomplete
 * outfit (src/web/outfits/references.ts): a 409 naming the pieces to buy
 * first. Thrown by the writers themselves (upsertEntry, planToWear,
 * setEntryOutfit, addTripOutfit) after a statement that wrote nothing, so
 * a caller's transaction rolls back whole: a save planned on a day saves
 * nothing either. Pages answer the error page, the MCP tools the tool
 * error, with the same words.
 */
export class OutfitIncomplete extends HttpError {
  constructor(
    readonly outfitId: number,
    readonly pieces: readonly PieceToBuy[],
  ) {
    super(
      409,
      t('outfits.INCOMPLETE', {
        pieces: pieces
          .map((piece) => piece.name ?? t('outfits.UNNAMED_GARMENT'))
          .join(', '),
      }),
      {
        logDetail: `outfit ${outfitId} holds ${pieces.length} piece(s) not bought yet: ${pieces.map((p) => p.id).join(', ')}`,
      },
    );
    this.name = 'OutfitIncomplete';
  }
}

/**
 * The refusal of a write that would plan, pack or wear one of Muse's
 * proposals the owner has not made theirs (#335): a 409. Save (or Love)
 * makes it theirs; nothing was written.
 */
class OutfitNotYours extends HttpError {
  constructor(readonly outfitId: number) {
    super(409, t('outfits.muse.NOT_YOURS_YET'), {
      logDetail: `outfit ${outfitId} is a proposal not the owner's yet`,
    });
    this.name = 'OutfitNotYours';
  }
}

/**
 * The hold writers' refusal (outfitMayBeHeld false: their write wrote
 * nothing), from holdRefusalColumns read in the same statement: pieces to
 * buy first (OutfitIncomplete), else a proposal not the owner's yet
 * (OutfitNotYours). Nothing to refuse: the write went through.
 */
export function refuseUnholdable(
  outfitId: number,
  why: { toBuy: readonly PieceToBuy[]; pending: boolean },
): void {
  if (why.toBuy.length > 0) throw new OutfitIncomplete(outfitId, why.toBuy);
  if (why.pending) throw new OutfitNotYours(outfitId);
}
