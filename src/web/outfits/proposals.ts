import { and, eq, type SQL, sql } from 'drizzle-orm';
import { file, garment, outfit, outfitSlot } from '../../db/schema';
import type { GarmentStatus } from '../../wardrobe/status';
import { photoRefJson } from '../files/queries';
import type { SignablePhotoRef } from '../files/image-url';
import type { OutfitCount } from '../../wardrobe/goes-with';
import type { LookReaction } from '../../wardrobe/look-reaction';
import type { OutfitDismissReason } from '../../wardrobe/suggestions';
import { unlocksOf } from '../gallery/ideas';
import {
  goesWithManyInputsSql,
  type ManyGoesWithInputsJson,
  readManyGoesWithInputs,
} from '../gallery/queries';
import { privateColumns } from '../wardrobe/private-fields';
import { onWishlist } from '../wardrobe/status';
import { agentOutfit } from './references';
import { type AgentLabel, agentLabelSql, OWNER_READS } from '../write-origin';

/**
 * The agent's outfits (#335, docs/plans/2026-10-05-agent-suggestions.md section
 * 4 B): ordinary outfits the owner's agent proposed (outfit.proposed_at),
 * with its note and the owner's reaction (src/wardrobe/look-reaction.ts,
 * reused from plan looks: proposed, loved, revise, declined). Which list an
 * outfit is on is derived, never stored:
 * - **the owner's** (`ownersOutfit`): never proposed, or a proposal loved
 *   while complete ("Save" is Love on a complete outfit). The Saved grid,
 *   the pickers, the garment page's strip.
 * - **from the agent** (`awaitingOwner`): proposed or sent back, or loved but
 *   still holding a piece to buy. The Outfits tab's first section.
 * - **set aside**: declined, with a reason. Collapsed under it, to undo.
 * Bought it moves a loved outfit from the agent's to the owner's by itself.
 */

/** A piece of an agent outfit as its card shows it: what it is, and if to buy, its price and whether it was set aside. */
export interface AgentPiece {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
  price: string | null;
  /** A pick the owner set aside: the outfit "needs a replacement". */
  setAside: boolean;
  photo: SignablePhotoRef | null;
}

/** An agent outfit as its card shows it. */
export interface AgentOutfit {
  id: number;
  name: string | null;
  note: string | null;
  reaction: LookReaction;
  ownerNote: string | null;
  dismissedReason: OutfitDismissReason | null;
  /** The agent: outfits are their owner's alone, so its token's name, or "Agent". */
  agent: AgentLabel | null;
  pieces: AgentPiece[];
}

/** An outfit's pieces in slot order (empty slots show nothing), for a scalar subquery over `outfit`. */
function agentPiecesSql(): SQL<AgentPiece[]> {
  return sql<AgentPiece[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${garment.id},
      'name', ${garment.name},
      'category', ${garment.category},
      'status', ${garment.status},
      'price', ${privateColumns('OWN').price},
      'setAside', ${garment.dismissedAt} is not null,
      'photo', ${photoRefJson}
    ) order by ${outfitSlot.position}), '[]')
    from ${outfitSlot}
    inner join ${garment} on ${eq(garment.id, outfitSlot.garmentId)}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${eq(outfitSlot.outfitId, outfit.id)}
  )`;
}

/**
 * The owner's the agent outfits not theirs yet (awaiting them, or set aside),
 * newest proposal first, as one scalar subquery for savedContext's
 * statement. Raw SQL, so `outfit` renders qualified (references.ts).
 */
export function agentOutfitsSql(ownerId: number): SQL<AgentOutfit[]> {
  return sql<AgentOutfit[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfit.id},
      'name', ${outfit.name},
      'note', ${outfit.proposalNote},
      'reaction', ${outfit.reaction},
      'ownerNote', ${outfit.ownerNote},
      'dismissedReason', ${outfit.dismissedReason},
      'agent', ${agentLabelSql(outfit.addedByTokenId, OWNER_READS)},
      'pieces', ${agentPiecesSql()}
    ) order by ${outfit.proposedAt} desc, ${outfit.id} desc), '[]')
    from ${outfit}
    where ${and(eq(outfit.ownerId, ownerId), agentOutfit())}
  )`;
}

/**
 * The pieces to buy of the owner's the agent outfits, with the closet and the
 * avoided pairs once, to count what each unlocks (unlocksOf: the inbox's
 * "Unlocks N", #333). For savedContext's statement.
 */
export function agentUnlocksInputsSql(
  ownerId: number,
): SQL<ManyGoesWithInputsJson> {
  return goesWithManyInputsSql(
    ownerId,
    sql`${garment.id} in (select ${outfitSlot.garmentId} from ${outfitSlot} inner join ${outfit} on ${eq(outfit.id, outfitSlot.outfitId)} where ${and(eq(outfit.ownerId, ownerId), agentOutfit(), onWishlist())})`,
  );
}

/** agentUnlocksInputsSql's answer: each piece to buy's count. */
export function readAgentUnlocks(
  json: ManyGoesWithInputsJson,
): Map<number, OutfitCount> {
  return unlocksOf(readManyGoesWithInputs(json));
}

/** Which of the agent's outfits a section shows: awaiting the owner, or set aside. */
export function isSetAside(item: Pick<AgentOutfit, 'reaction'>): boolean {
  return item.reaction === 'declined';
}
