import { and, eq, isNotNull, ne, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  garment,
  garmentWear,
  optionGroup,
  outfit,
  outfitSlot,
  personalAccessToken,
} from '../../db/schema';
import type { LookReaction } from '../../wardrobe/look-reaction';
import type { GarmentStatus } from '../../wardrobe/status';
import type {
  DismissReason,
  OutfitDismissReason,
} from '../../wardrobe/suggestions';
import { OWNER_LOCK_TIMEOUT_MS } from '../../db/owner-lock';
import { privateColumns } from '../wardrobe/private-fields';

/**
 * What the owner decided about the agent's work since the agent last
 * asked (#337, get_suggestion_feedback; doc section 6): the agent's way to
 * learn, since closet stores no taste model. Read from the rows the
 * decisions left, never a log of its own:
 * - a need's decision at `option_group.decided_at` (chosen, bought, set
 *   aside with its reason and the owner's note);
 * - a pick set aside at `garment.dismissed_at` (Not for me with a reason,
 *   chose another, returned);
 * - a purchase at `garment.bought_at` (setGarmentStatus' buy), with the
 *   price paid: a pick, or "a different one" that settled a need;
 * - an outfit's reaction at `outfit.reacted_at` (Love, Not for me, Undo);
 * - and every bought suggestion's wears, whatever the cursor: the signal
 *   that grows.
 *
 * **The cursor** is the calling token's `feedback_read_at`: null before
 * its first call, so a new token (the agent's rotated one) hears everything.
 * A row whose time is null (the plan looks' reactions 0041 migrated, a
 * purchase before 0042) is older than any cursor: it is told on a first
 * call only, or with `all`.
 *
 * **A pure read: the call never moves the cursor.** It answers `until`,
 * its statement's `now()` less FEEDBACK_MARGIN_MS (twice the owner
 * lock's timeout): a decision stamps its transaction's start (`now()`),
 * which may come before this read while it waits on the owner lock and
 * does its work, and commit after it, so only what is older than the
 * margin is surely in this answer. The agent hands `until` back when it
 * ends its round (finish_round, #337 part A2), which moves the cursor to
 * `greatest(cursor, least(until, now()))`: an answer lost on the way is
 * told again, and a decision committed after the read with a time before
 * `until`'s margin is still after the cursor, so it is told next time,
 * never lost. What falls inside the margin is told twice (ids say
 * which). State, not events: an Undo since leaves the row as it was
 * before the decision, so the agent sees it in list_suggestions. One
 * statement.
 */

interface NeedDecision {
  needId: number;
  need: string;
  /** chosen: a pick to buy; bought: settled by a purchase (a pick or a different one); set_aside: not this need. */
  decision: 'chosen' | 'bought' | 'set_aside';
  /** The pick chosen, or the garment bought for it. */
  garment: { id: number; name: string | null; sourceUrl: string | null } | null;
  reason: DismissReason | null;
  ownerNote: string | null;
  at: string;
}

interface PickSetAside {
  garmentId: number;
  name: string | null;
  sourceUrl: string | null;
  needId: number | null;
  need: string | null;
  reason: DismissReason | null;
  note: string | null;
  at: string;
}

interface Purchase {
  garmentId: number;
  name: string | null;
  sourceUrl: string | null;
  needId: number | null;
  /** Bought for a need, not one of its picks: "Bought a different one". */
  different: boolean;
  pricePaid: string | null;
  boughtOn: string | null;
  /** Null for a purchase made before closet timed them. */
  at: string | null;
}

interface OutfitReaction {
  outfitId: number;
  name: string | null;
  reaction: LookReaction;
  reason: OutfitDismissReason | null;
  ownerNote: string | null;
  garmentIds: number[];
  /** Null for a reaction migrated from a plan look. */
  at: string | null;
}

interface BoughtWears {
  garmentId: number;
  name: string | null;
  status: GarmentStatus;
  boughtOn: string | null;
  wears: number;
  lastWorn: string | null;
}

/** A type, not an interface: it is the statement's raw row (execute). */
export type SuggestionFeedback = {
  /** The cursor this call read: null for everything. */
  since: string | null;
  /** This read's time less FEEDBACK_MARGIN_MS: what finish_round takes to move the cursor (part A2). */
  until: string;
  needs: NeedDecision[];
  picksSetAside: PickSetAside[];
  purchases: Purchase[];
  outfits: OutfitReaction[];
  wears: BoughtWears[];
};

/**
 * How far behind its statement's time a read's `until` is: twice the
 * owner lock's timeout, the lock's wait and the work after it (see above).
 */
export const FEEDBACK_MARGIN_MS = 2 * OWNER_LOCK_TIMEOUT_MS;

/** The calling token's cursor. */
const cursor = sql.identifier('cursor');

/** `time` after the cursor; with no cursor (a first call, `all`) any row, a null time included. */
function after(since: SQL, time: SQL): SQL {
  return sql`(${since} is null or ${time} > ${since})`;
}

/** A garment the owner bought for one of the agent's needs: a pick, or the different one that settled it. */
function boughtForAgent(ownerId: number): SQL {
  return and(
    eq(garment.ownerId, ownerId),
    ne(garment.status, 'wishlist'),
    sql`(${isNotNull(garment.suggestedAt)} or ${garment.id} in (
      select ${optionGroup.resolvedGarmentId} from ${optionGroup}
      where ${eq(optionGroup.ownerId, ownerId)}
    ))`,
  )!;
}

function needsSql(ownerId: number, since: SQL): SQL<NeedDecision[]> {
  return sql<NeedDecision[]>`(
    select coalesce(json_agg(json_build_object(
      'needId', ${optionGroup.id},
      'need', ${optionGroup.name},
      'decision', case
        when ${optionGroup.status} = 'dismissed' then 'set_aside'
        when ${garment.status} = 'wishlist' then 'chosen'
        else 'bought'
      end,
      'garment', case when ${garment.id} is null then null else json_build_object(
        'id', ${garment.id}, 'name', ${garment.name}, 'sourceUrl', ${garment.sourceUrl}
      ) end,
      'reason', ${optionGroup.dismissedReason},
      'ownerNote', ${optionGroup.ownerNote},
      'at', ${optionGroup.decidedAt}
    ) order by ${optionGroup.decidedAt}, ${optionGroup.id}), '[]')
    from ${optionGroup}
    left join ${garment} on ${eq(garment.id, optionGroup.resolvedGarmentId)}
    where ${and(
      eq(optionGroup.ownerId, ownerId),
      ne(optionGroup.status, 'open'),
      after(since, sql`${optionGroup.decidedAt}`),
    )}
  )`;
}

function picksSetAsideSql(ownerId: number, since: SQL): SQL<PickSetAside[]> {
  return sql<PickSetAside[]>`(
    select coalesce(json_agg(json_build_object(
      'garmentId', ${garment.id},
      'name', ${garment.name},
      'sourceUrl', ${garment.sourceUrl},
      'needId', ${optionGroup.id},
      'need', ${optionGroup.name},
      'reason', ${garment.dismissedReason},
      'note', ${garment.dismissedNote},
      'at', ${garment.dismissedAt}
    ) order by ${garment.dismissedAt}, ${garment.id}), '[]')
    from ${garment}
    left join ${optionGroup} on ${eq(optionGroup.id, garment.suggestionGroupId)}
    where ${and(
      eq(garment.ownerId, ownerId),
      isNotNull(garment.suggestedAt),
      isNotNull(garment.dismissedAt),
      after(since, sql`${garment.dismissedAt}`),
    )}
  )`;
}

function purchasesSql(ownerId: number, since: SQL): SQL<Purchase[]> {
  return sql<Purchase[]>`(
    select coalesce(json_agg(json_build_object(
      'garmentId', ${garment.id},
      'name', ${garment.name},
      'sourceUrl', ${garment.sourceUrl},
      'needId', coalesce(${garment.suggestionGroupId}, (
        select ${optionGroup.id} from ${optionGroup}
        where ${eq(optionGroup.resolvedGarmentId, garment.id)}
      )),
      'different', ${garment.suggestedAt} is null,
      'pricePaid', ${privateColumns('OWN').price}::text,
      'boughtOn', ${garment.acquiredOn}::text,
      'at', ${garment.boughtAt}
    ) order by ${garment.boughtAt} nulls first, ${garment.id}), '[]')
    from ${garment}
    where ${and(boughtForAgent(ownerId), after(since, sql`${garment.boughtAt}`))}
  )`;
}

function outfitsSql(ownerId: number, since: SQL): SQL<OutfitReaction[]> {
  return sql<OutfitReaction[]>`(
    select coalesce(json_agg(json_build_object(
      'outfitId', ${outfit.id},
      'name', ${outfit.name},
      'reaction', ${outfit.reaction},
      'reason', ${outfit.dismissedReason},
      'ownerNote', ${outfit.ownerNote},
      'garmentIds', (
        select coalesce(json_agg(${outfitSlot.garmentId} order by ${outfitSlot.position}), '[]')
        from ${outfitSlot}
        where ${and(eq(outfitSlot.outfitId, outfit.id), isNotNull(outfitSlot.garmentId))}
      ),
      'at', ${outfit.reactedAt}
    ) order by ${outfit.reactedAt} nulls first, ${outfit.id}), '[]')
    from ${outfit}
    where ${and(
      eq(outfit.ownerId, ownerId),
      isNotNull(outfit.proposedAt),
      // Untouched since the agent proposed it: nothing to tell.
      sql`(${outfit.reaction} <> 'proposed' or ${outfit.reactedAt} is not null)`,
      after(since, sql`${outfit.reactedAt}`),
    )}
  )`;
}

function wearsSql(ownerId: number): SQL<BoughtWears[]> {
  return sql<BoughtWears[]>`(
    select coalesce(json_agg(json_build_object(
      'garmentId', ${garment.id},
      'name', ${garment.name},
      'status', ${garment.status},
      'boughtOn', ${garment.acquiredOn}::text,
      'wears', (select count(distinct ${garmentWear.day})::int from ${garmentWear} where ${eq(garmentWear.garmentId, garment.id)}),
      'lastWorn', (select max(${garmentWear.day})::text from ${garmentWear} where ${eq(garmentWear.garmentId, garment.id)})
    ) order by ${garment.id}), '[]')
    from ${garment}
    where ${boughtForAgent(ownerId)}
  )`;
}

/**
 * The owner's decisions since token `tokenId`'s cursor (or all of them),
 * writing nothing. The token is the caller's own (the MCP endpoint
 * authenticated it), so it names its user's rows only.
 */
export async function readSuggestionFeedback(
  db: Queryable,
  { ownerId, tokenId, all }: { ownerId: number; tokenId: number; all: boolean },
): Promise<SuggestionFeedback> {
  const since = all
    ? sql`null::timestamptz`
    : sql`(select since from ${cursor})`;
  const { rows } = await db.execute<SuggestionFeedback>(sql`
    with ${cursor} as (
      select ${personalAccessToken.feedbackReadAt} as since
      from ${personalAccessToken} where ${eq(personalAccessToken.id, tokenId)}
    )
    select
      -- As JSON, as the lists' times: an ISO string, not the driver's Date.
      to_json(${since}) #>> '{}' as since,
      to_json(now() - ${`${FEEDBACK_MARGIN_MS} milliseconds`}::interval) #>> '{}' as until,
      ${needsSql(ownerId, since)} as needs,
      ${picksSetAsideSql(ownerId, since)} as "picksSetAside",
      ${purchasesSql(ownerId, since)} as purchases,
      ${outfitsSql(ownerId, since)} as outfits,
      ${wearsSql(ownerId)} as wears`);
  return rows[0];
}

/**
 * The one writer of the cursor (finishRound, #337 part A2): moved to the
 * `until` of the agent's last feedback read, never past now and never
 * back, `greatest(cursor, least(until, now()))`. What the agent was told
 * stays told; what it was not (an answer lost, a decision that committed
 * after its read) is after `until`, told next time.
 */
export async function moveFeedbackCursor(
  tx: Queryable,
  tokenId: number,
  until: string,
): Promise<void> {
  await tx
    .update(personalAccessToken)
    .set({
      feedbackReadAt: sql`greatest(${personalAccessToken.feedbackReadAt}, least(${until}::timestamptz, now()))`,
    })
    .where(eq(personalAccessToken.id, tokenId));
}
