import type { Queryable } from '../../db/client';
import {
  MAX_OPTIONS_PER_GROUP,
  type SuggestionDecision,
} from '../../wardrobe/suggestions';
import { HttpError } from '../errors';
import { type ActionDeps, logOp } from '../op-log';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { NotFound, type Resource } from '../refusals';
import {
  type Actor,
  type AuthorizedWardrobe,
  authorizeWardrobe,
} from '../sharing/access';
import {
  createOptionGroup,
  decide,
  markSuggestedProduct,
  type NeedInput,
  type Provenance,
  type SuggestedProduct,
  suggestionRoom,
} from './decisions';
import {
  markSuggestionsSeen,
  type NeedDetail,
  type NewNeed,
  readNeed,
} from './inbox';
import { type FinishOutcome, finishRound, type RoundEnd } from './rounds';

type Db = WebOptions['db'];

/**
 * The suggestion access path (#188; docs/plans/2026-11-12-json-api.md
 * section 4): a need read, every decision the owner makes on Muse's
 * suggestions, and the agent's writes of them, each taking the Actor and
 * enforcing access itself, so a page, an MCP tool and the API refuse alike.
 * A need is read by whoever reads the wishlist (a VIEW grantee sees Muse's
 * notes, owner decision 2026-10-05); every decision is the owner's alone.
 * Muse's writes are the caller's own wardrobe (no ownerId: a token acts as
 * its user). The writers underneath (decisions.ts) trust their `ownerId`.
 * "Bought it" is purchase.ts's, "Bought a different one" destination.ts's.
 */

/** A need as a page's `/needs/:id` and `?ownerId=` address it. */
export interface NeedAddress {
  id: number;
  ownerId: number | '' | undefined;
}

/**
 * The need `address` names, for whoever may read the wishlist; the owner's
 * read judges each option against the closet (readNeed). One statement
 * after the share's, which a page's read ahead answers.
 */
export async function requireNeed(
  db: Db,
  actor: Actor,
  address: NeedAddress,
): Promise<AuthorizedWardrobe & { detail: NeedDetail & { searchMs: number } }> {
  const wardrobe = await authorizeWardrobe(
    db,
    actor,
    address.ownerId,
    'view',
    'need',
  );
  const detail = await readNeed(db, {
    ownerId: wardrobe.access.ownerId,
    groupId: address.id,
    viewerId: actor.userId,
    isOwner: wardrobe.access.isOwner,
  });
  if (!detail) throw new NotFound('need');
  return { ...wardrobe, detail };
}

/** A decision the owner makes on a page; "Bought it" settles its need itself (purchase.ts). */
export type OwnerDecision = Exclude<SuggestionDecision, { kind: 'bought' }>;

/** What a decision names: a pick (a garment) or a need. */
function subjectOf(decision: OwnerDecision): {
  resource: Resource;
  label: string;
} {
  return 'garmentId' in decision
    ? { resource: 'garment', label: `garment ${decision.garmentId}` }
    : { resource: 'need', label: `need ${decision.groupId}` };
}

/**
 * decide() for the owner of the wardrobe `ownerId` names (a grantee is a
 * 403, an unseen wardrobe or another's pick or need the 404 of what the
 * decision names), else a 409 for a page gone stale or a double tap.
 * Answers what it set aside and restored.
 */
export async function makeDecision(
  { db, logger }: ActionDeps,
  actor: Actor,
  ownerId: number | '' | undefined,
  decision: OwnerDecision,
): Promise<
  AuthorizedWardrobe & {
    groupId: number | null;
    dismissed: number[];
    restored: number[];
  }
> {
  const subject = subjectOf(decision);
  const wardrobe = await authorizeWardrobe(
    db,
    actor,
    ownerId,
    'own',
    subject.resource,
  );
  const outcome = await decide(db, wardrobe.access.ownerId, decision);
  if (!outcome.ok) {
    const logDetail = `${decision.kind} on ${subject.label}: ${outcome.reason}`;
    if (outcome.reason === 'not-found') {
      throw new NotFound(subject.resource, { logDetail });
    }
    throw new HttpError(409, t('muse.STALE'), { logDetail });
  }
  logOp(logger, actor, 'suggestion.decided', {
    decision: decision.kind,
    garmentId: 'garmentId' in decision ? decision.garmentId : undefined,
    needId: outcome.groupId,
    ownerId: wardrobe.access.ownerId,
    dismissed: outcome.dismissed.length,
    restored: outcome.restored.length,
  });
  return {
    ...wardrobe,
    groupId: outcome.groupId,
    dismissed: outcome.dismissed,
    restored: outcome.restored,
  };
}

/**
 * "New from Muse" (markSuggestionsSeen): the open needs with picks the
 * owner has not looked at, and their marker moved. One line only when
 * there was something new.
 */
export async function markNeedsSeen(
  { db, logger }: ActionDeps,
  actor: Actor,
): Promise<NewNeed[]> {
  const needs = await markSuggestionsSeen(db, actor.userId);
  if (needs.length > 0) {
    logOp(logger, actor, 'suggestions.seen', {
      needs: needs.map((need) => need.id),
    });
  }
  return needs;
}

/** The refusal of a link the owner set aside, or one suggested already. */
function sameProductRefusal(same: SuggestedProduct): HttpError {
  return new HttpError(
    409,
    same.dismissed
      ? `The owner set this product aside (garment ${same.id}, ${same.dismissedReason ?? 'with a note'}): never propose it again`
      : `This product is suggested already (garment ${same.id})`,
  );
}

/** A need full of open options: suggest_garment's refusal before and in the write. */
const FULL = `That need has ${MAX_OPTIONS_PER_GROUP} open options already`;
const DECIDED =
  'That need is decided (chosen, bought or set aside): list_suggestions shows the open ones';

/**
 * A new pick's refusals before its product is fetched (suggestionRoom:
 * one statement, no lock): another's or an unknown need is a 404, a need
 * decided or full and a product proposed before a 409. The writer judges
 * again under the owner lock (markSuggestedPick).
 */
export async function checkSuggestionRoom(
  db: Db,
  actor: Actor,
  groupId: number,
  url: string,
): Promise<void> {
  const room = await suggestionRoom(db, actor.userId, groupId, url);
  if (room.group === 'missing') throw new NotFound('need');
  if (room.group === 'closed') throw new HttpError(409, DECIDED);
  if (room.group === 'full') throw new HttpError(409, FULL);
  if (room.same) throw sameProductRefusal(room.same);
}

/**
 * The agent's new garment marked as its pick for a need, in the garment's
 * own transaction (`tx`): a refusal throws, which rolls the garment back
 * (a need decided or filled during the fetch, the same link marked by a
 * call alongside). It writes no line, since the transaction can still roll
 * back: the caller that owns it calls `logSuggestedPick` after the commit.
 */
export async function markSuggestedPick(
  tx: Queryable,
  actor: Actor,
  garmentId: number,
  provenance: Provenance,
  url: string,
): Promise<void> {
  const marked = await markSuggestedProduct(
    tx,
    actor.userId,
    garmentId,
    provenance,
    url,
  );
  if (typeof marked === 'object') throw sameProductRefusal(marked.same);
  if (marked === 'full') throw new HttpError(409, FULL);
  if (marked === 'refused') throw new HttpError(409, DECIDED);
}

/** The line `garment.suggested`, once the garment's transaction (markSuggestedPick) has committed. */
export function logSuggestedPick(
  { logger }: Pick<ActionDeps, 'logger'>,
  actor: Actor,
  garmentId: number,
  provenance: Provenance,
): void {
  logOp(logger, actor, 'garment.suggested', {
    garmentId,
    needId: provenance.groupId,
    tokenId: provenance.tokenId,
    rank: provenance.rank,
  });
}

/**
 * A need the agent states for the actor's wardrobe (createOptionGroup):
 * its id, or a 409 naming the need of that name already open, chosen, or
 * set aside (never proposed again).
 */
export async function createNeed(
  { db, logger }: ActionDeps,
  actor: Actor,
  need: NeedInput,
): Promise<number> {
  const created = await createOptionGroup(db, actor.userId, need);
  if (created.ok) {
    logOp(logger, actor, 'need.created', {
      needId: created.id,
      tokenId: need.tokenId,
    });
    return created.id;
  }
  if (created.reason === 'chosen') {
    throw new HttpError(409, t('refusal.need.chosen', { id: created.id }));
  }
  if (created.reason === 'open') {
    throw new HttpError(409, t('refusal.need.open', { id: created.id }));
  }
  throw new HttpError(
    409,
    t('refusal.need.setAside', {
      id: created.id,
      reason: created.dismissedReason ?? t('refusal.need.withANote'),
    }),
  );
}

/**
 * The agent's finish_round (finishRound): a round stored, or none when
 * nothing is new (`changed: false`; the feedback cursor may still have
 * moved). The caller notifies the owner after (notifyRounds).
 */
export async function finishAgentRound(
  { db, logger }: ActionDeps,
  actor: Actor,
  round: Extract<RoundEnd, { tokenId: number }>,
): Promise<FinishOutcome> {
  const finished = await finishRound(db, actor.userId, round);
  logOp(logger, actor, 'round.finished', {
    roundId: finished.ok ? finished.id : null,
    changed: finished.ok,
    outfits: finished.ok ? finished.outfits : 0,
    pieces: finished.ok ? finished.pieces : 0,
    tokenId: round.tokenId,
    feedbackRead: round.feedbackUntil !== null,
  });
  return finished;
}
