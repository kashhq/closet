import type { Db } from '../../db/client';
import type { IsoDate } from '../../calendar-date';
import type { LookReaction } from '../../wardrobe/look-reaction';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { type ActionDeps, logOp } from '../op-log';
import { NotFound } from '../refusals';
import { type ShareableIdAfter, setPublicShare } from '../share/queries';
import type { Actor } from '../sharing/access';
import { newOutfitSlots } from './gone-garments';
import { type OutfitContext, outfitContext } from './page-context';
import {
  type CreateResult,
  createOutfit,
  deleteOutfit,
  findOutfit,
  type OutfitEdit,
  type OutfitInput,
  type OutfitProposalInput,
  proposeOutfit,
  type SaveResult,
  type ToolOutfit,
  updateOutfit,
} from './queries';
import {
  type OutfitReaction,
  type ReactOutcome,
  reactToOutfit,
} from './reactions';

/**
 * The outfit path (#188; docs/plans/2026-11-12-json-api.md section 4):
 * every surface's read of one outfit and change to one, each taking the
 * Actor and refusing itself, so a page, an MCP tool and the API refuse
 * alike. Outfits are private (AGENTS.md): only the actor's own are
 * reached, whatever wardrobe shares they hold, so another's outfit is the
 * 404 of an unknown id, never a 403. The owner-scoped queries underneath
 * (queries.ts, reactions.ts, page-context.ts) trust their `ownerId`: only
 * this path reaches them from a surface. Refusals carry a `logDetail`, so
 * callers log only what was done.
 */

/**
 * Another's outfit or no outfit: one refusal for both (here, the calendar's
 * planOutfit, Styling's `?outfit=`).
 */
export function outfitNotFound(): NotFound {
  return new NotFound('outfit');
}

/** The outfit page's read (outfitContext: the outfit and its entries, one statement). */
export async function requireOutfitPage(
  db: Db,
  actor: Actor,
  id: number,
  today: IsoDate,
): Promise<OutfitContext> {
  const found = await outfitContext(db, id, actor.userId, today);
  if (!found) throw outfitNotFound();
  return found;
}

/** The actor's outfit as the MCP tools answer it (get_outfit). */
export async function requireOutfit(
  db: Db,
  actor: Actor,
  id: number,
): Promise<ToolOutfit> {
  const found = await findOutfit(db, id, actor.userId);
  if (!found) throw outfitNotFound();
  return found;
}

/**
 * A new outfit of the actor's garments (the outfit form, Styling's Save
 * with picks, POST /outfits, create_outfit), once per garment set: the
 * outfit its garments already were is the answer, `changed: false` on the
 * line (createOutfit; the API's `clientId` rides along). A pick's save (pickIdea) is its own line.
 */
export async function saveOutfit(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: OutfitInput,
  clientId?: string,
): Promise<CreateResult> {
  const saved = await createOutfit(db, actor.userId, input);
  logOp(logger, actor, 'outfit.created', {
    outfitId: saved.id,
    changed: !saved.alreadySaved,
    slots: saved.slots,
    day: input.plan?.day,
    schedule: saved.schedule,
    adopted: saved.adopted,
    clientId,
  });
  return saved;
}

/** An edit of the actor's outfit (the outfit form, Styling's Save in place, the API's PATCH): updateOutfit. */
export async function editOutfit(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  input: OutfitEdit,
): Promise<SaveResult> {
  const saved = await updateOutfit(db, id, actor.userId, input);
  if (saved === 'not-found') throw outfitNotFound();
  logOp(logger, actor, 'outfit.updated', {
    outfitId: id,
    slots: input.slots ? saved.slots : undefined,
    name: input.name !== undefined,
    notes: input.notes !== undefined,
    schedule: saved.schedule,
    entriesClaimed: saved.entriesClaimed ?? 0,
  });
  return saved;
}

/**
 * Share (`shared`) or Stop sharing the actor's outfit's public link (#669,
 * setPublicShare): the owner's alone, as every outfit write. Answers the
 * link's id after the write. Pages and the API (PUT and DELETE
 * /outfits/{id}/share) alike, idempotent as setGarmentPublicShare.
 */
export async function setOutfitPublicShare<Shared extends boolean>(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  shared: Shared,
): Promise<{ shareableId: ShareableIdAfter<Shared> }> {
  const written = await setPublicShare(db, 'outfit', id, actor.userId, shared);
  if (!written) throw outfitNotFound();
  logOp(logger, actor, 'outfit.share.set', { outfitId: id, shared });
  return written;
}

/**
 * Deletes the actor's outfit (deleteOutfit: its wears kept as day-level
 * wears). One of Muse's proposals not loved is refused (409): Not for me
 * sets it aside, and its reaction is feedback a delete would lose (#335).
 */
export async function removeOutfit(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
): Promise<{ wearsKept: number }> {
  const deleted = await deleteOutfit(db, id, actor.userId);
  if (!deleted) throw outfitNotFound();
  if (deleted === 'a-proposal') {
    throw new HttpError(409, t('outfits.muse.DELETE_REFUSED'), {
      logDetail: `outfit ${id} is a proposal not loved`,
    });
  }
  logOp(logger, actor, 'outfit.deleted', {
    outfitId: id,
    wearsKept: deleted.wearsKept,
  });
  return deleted;
}

export type Reacted = Extract<ReactOutcome, { ok: true }>;

/**
 * The actor's reaction to one of Muse's outfits (reactToOutfit): another's
 * outfit, or one Muse did not propose, is NotFound; one that is the
 * owner's already, or a move its reaction does not take (a stale page, a
 * double tap), a 409.
 */
export async function reactToProposal(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  change: OutfitReaction,
): Promise<Reacted> {
  const outcome = await reactToOutfit(db, actor.userId, id, change);
  if (outcome.ok) {
    logOp(logger, actor, 'outfit.reacted', {
      outfitId: id,
      event: change.event,
      from: outcome.from,
      to: outcome.to,
      reason: change.event === 'decline' ? change.reason : undefined,
    });
    return outcome;
  }
  const logDetail = `reaction ${change.event} on outfit ${id}: ${outcome.reason}`;
  if (outcome.reason === 'not-found') {
    throw new NotFound('outfit', { logDetail });
  }
  throw new HttpError(
    409,
    t(
      outcome.reason === 'owners' ? 'outfits.muse.ALREADY_YOURS' : 'muse.STALE',
    ),
    { logDetail },
  );
}

export type Proposed =
  | { id: number; slots: number }
  /** These garments were proposed already and not set aside: nothing written. */
  | { id: number; alreadyProposed: LookReaction };

/**
 * The agent's outfit for the actor (suggest_outfit, #337): the garments'
 * slots (a garment the actor's wardrobe cannot hold refuses it, named:
 * newOutfitSlots), then proposeOutfit, which judges them again as it
 * writes. Garments that are an outfit of the owner's own, or one they
 * declined, are a 409 saying which; a proposal already made is the answer.
 */
export async function proposeOutfitTo(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: { garmentIds: readonly number[]; name: string | null },
  proposal: OutfitProposalInput,
): Promise<Proposed> {
  const slots = await newOutfitSlots(
    db,
    actor.userId,
    input.garmentIds,
    'wardrobe',
  );
  const proposed = await proposeOutfit(
    db,
    actor.userId,
    { name: input.name, slots },
    proposal,
  );
  if (proposed.ok) {
    logOp(logger, actor, 'outfit.proposed', {
      outfitId: proposed.id,
      changed: !('alreadyProposed' in proposed),
      slots: 'slots' in proposed ? proposed.slots : undefined,
      tokenId: proposal.tokenId,
    });
    return proposed;
  }
  if (proposed.reason === 'owners') {
    throw new HttpError(
      409,
      t('refusal.outfit.ownersAlready', { id: proposed.id }),
    );
  }
  throw new HttpError(
    409,
    t('refusal.outfit.declined', {
      id: proposed.id,
      reason: proposed.dismissedReason ?? t('refusal.outfit.noReason'),
    }),
  );
}
