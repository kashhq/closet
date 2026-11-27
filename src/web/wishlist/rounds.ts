import { and, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment, agentRound, outfit } from '../../db/schema';
import { ownerTransaction } from '../auth/queries';
import { type AgentLabel, agentLabelSql, OWNER_READS } from '../write-origin';
import { agentOutfitWaiting } from '../outfits/references';
import { moveFeedbackCursor } from './feedback';
import { OPEN_PICKS } from './inbox';

/**
 * The agent's rounds (#337; docs/plans/2026-10-05-muse-suggestions.md section
 * 4 A): the agent ends a round of suggestions with finish_round, which
 * stores when (agent_round) and nothing of what: a round is the agent's
 * outfits proposed and options suggested in (`since`, `finished_at`],
 * counted on every read, so Today's card shrinks as the owner decides and
 * goes at zero, with nothing to dismiss. One writer, finishRound; one
 * read, agentRoundSql (Today's statement). An agent that never calls
 * finish_round has its round closed for it once it has been quiet a while
 * (quietRounds, then round-end.ts's closeQuietRounds on the minute).
 */

/** The agent's one line about a round. */
export const ROUND_SUMMARY_MAX = 140;

/** What a round brought that still waits on the owner. */
export interface RoundCounts {
  /** Its outfits not decided yet (agentOutfitWaiting). */
  outfits: number;
  /** Its options of needs still open, still wanted (OPEN_PICKS). */
  pieces: number;
}

/** The latest round as Today's card shows it. */
export interface AgentRound extends RoundCounts {
  id: number;
  /** The agent: Today is the owner's alone, so its token's name, or "Agent". */
  agent: AgentLabel | null;
  summary: string | null;
}

/** `time` inside the round (`since`, `until`]: a null `since` is the beginning. */
function inRound(time: SQL, since: SQL, until: SQL) {
  return sql`(${time} > coalesce(${since}, '-infinity'::timestamptz) and ${time} <= ${until})`;
}

/** The two counts of a round over (`since`, `until`], for owner `ownerId` (an id, or a column of the caller's). */
function countsSql(ownerId: number | SQL, since: SQL, until: SQL) {
  return {
    outfits: sql<number>`(select count(*)::int from ${outfit} where ${and(
      eq(outfit.ownerId, ownerId),
      agentOutfitWaiting(),
      inRound(sql`${outfit.proposedAt}`, since, until),
    )})`,
    pieces: sql<number>`(select count(*)::int from ${garment} where ${and(
      eq(garment.ownerId, ownerId),
      OPEN_PICKS,
      inRound(sql`${garment.suggestedAt}`, since, until),
    )})`,
  };
}

const latest = sql.identifier('latest');

/**
 * The owner's latest round while any of it still waits (null otherwise),
 * as a scalar subquery: Today reads it beside the day in one statement
 * (todayFor's `needs`, src/web/today/today.ts).
 */
export function agentRoundSql(ownerId: number): SQL<AgentRound | null> {
  const counts = countsSql(
    ownerId,
    sql`${latest}.since`,
    sql`${latest}.finished_at`,
  );
  return sql<AgentRound | null>`(
    select case when counted.outfits + counted.pieces = 0 then null else json_build_object(
      'id', counted.id,
      'agent', counted.agent,
      'summary', counted.summary,
      'outfits', counted.outfits,
      'pieces', counted.pieces
    ) end
    from (
      select ${latest}.id, ${latest}.summary,
        ${agentLabelSql(sql`${latest}.token_id`, OWNER_READS)} as agent,
        ${counts.outfits} as outfits,
        ${counts.pieces} as pieces
      from ${agentRound} as ${latest}
      where ${latest}.owner_id = ${ownerId}
      order by ${latest}.finished_at desc, ${latest}.id desc
      limit 1
    ) as counted
  )`;
}

export type FinishOutcome =
  /** The round stored: what it brought. */
  | ({ ok: true; id: number; agent: AgentLabel | null } & RoundCounts)
  /** Nothing new since the last round: no round, so no card and no notification. */
  | { ok: false; reason: 'empty' };

/** How a round ends: the agent's own call, or the quiet close's. */
export type RoundEnd =
  /** finish_round: the calling token, its one line, its feedback read's `until`. */
  | { tokenId: number; summary: string | null; feedbackUntil: string | null }
  /**
   * The quiet close (closeQuietRounds): the newest write's token (null once
   * deleted), no line, and the cursor left where it is, so the agent hears
   * the feedback again rather than never.
   */
  | { tokenId: number | null; summary: null; feedbackUntil: null };

/**
 * The one writer of a round (finish_round, the quiet close): under the
 * owner lock, the owner's previous round's end, what was proposed and
 * suggested since, and the round inserted only when that is something, in
 * one statement; then, when the agent hands back its feedback read's
 * `until`, its cursor moved past what it was told (moveFeedbackCursor),
 * round or not, so a conversation that only read the feedback still ends
 * it. The lock makes the two ends of one round harmless to each other:
 * the second finds nothing since the first and inserts nothing. The
 * caller notifies after the commit (notifyRounds).
 */
export function finishRound(
  db: Queryable,
  ownerId: number,
  round: RoundEnd,
): Promise<FinishOutcome> {
  return ownerTransaction(db, ownerId, 'finishRound', async (tx) => {
    const since = sql`(select finished_at from previous)`;
    const counts = countsSql(ownerId, since, sql`now()`);
    const { rows } = await tx.execute<{
      id: number | null;
      agent: AgentLabel | null;
      outfits: number;
      pieces: number;
    }>(sql`
      with previous as (
        select ${agentRound.finishedAt} as finished_at from ${agentRound}
        where ${eq(agentRound.ownerId, ownerId)}
        order by ${agentRound.finishedAt} desc, ${agentRound.id} desc
        limit 1
      ),
      counted as (
        select ${counts.outfits} as outfits, ${counts.pieces} as pieces
      ),
      created as (
        insert into ${agentRound} (owner_id, token_id, since, summary)
        select ${ownerId}::int, ${round.tokenId}::int, ${since}, ${round.summary}::text
        from counted where counted.outfits + counted.pieces > 0
        returning id
      )
      select (select id from created) as id,
        ${agentLabelSql(sql`${round.tokenId}::int`, OWNER_READS)} as agent,
        counted.outfits, counted.pieces
      from counted`);
    const [row] = rows;
    if (round.feedbackUntil !== null) {
      await moveFeedbackCursor(tx, round.tokenId, round.feedbackUntil);
    }
    if (row.id === null) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      id: row.id,
      agent: row.agent,
      outfits: row.outfits,
      pieces: row.pieces,
    };
  });
}

/** An owner whose agent's round is open and quiet: who closes it, and as which token. */
export interface QuietRound {
  ownerId: number;
  /** The newest write's token; null once it was deleted. */
  tokenId: number | null;
}

const writes = sql.identifier('writes');
const newest = sql.identifier('newest');
const last = sql.identifier('last');

/**
 * The owners with an open round gone quiet, in one statement across
 * owners (the quiet close's minutely read): their newest the agent write (a
 * garment's `suggested_at`, an outfit's `proposed_at`; each table's
 * partial index on the owner and the time, so only the agent's rows are read;
 * of writes at one instant, a token that still exists, then the highest)
 * is after their last round's end, or there is no round, and at or before
 * `quietSince`; and the round finishRound would store is not empty (what
 * the owner has decided already makes no round), so an owner who decided
 * everything is not found again every minute. Each tick reads every agent
 * write of every owner: fine at a household's scale, not a pattern for a
 * table that grows without bound.
 */
export async function quietRounds(
  db: Queryable,
  quietSince: Date,
): Promise<QuietRound[]> {
  const counts = countsSql(
    sql`${newest}.owner_id`,
    sql`${last}.finished_at`,
    sql`now()`,
  );
  const { rows } = await db.execute<{
    owner_id: number;
    token_id: number | null;
  }>(sql`
    with ${writes} as (
      select ${garment.ownerId} as owner_id, ${garment.suggestedAt} as at,
        ${garment.addedByTokenId} as token_id
      from ${garment} where ${isNotNull(garment.suggestedAt)}
      union all
      select ${outfit.ownerId}, ${outfit.proposedAt}, ${outfit.addedByTokenId}
      from ${outfit} where ${isNotNull(outfit.proposedAt)}
    ),
    ${newest} as (
      select distinct on (owner_id) owner_id, at, token_id from ${writes}
      order by owner_id, at desc, token_id desc nulls last
    )
    select ${newest}.owner_id, ${newest}.token_id
    from ${newest}
    left join lateral (
      select ${agentRound.finishedAt} as finished_at from ${agentRound}
      where ${agentRound.ownerId} = ${newest}.owner_id
      order by ${agentRound.finishedAt} desc
      limit 1
    ) as ${last} on true
    where ${newest}.at <= ${quietSince}::timestamptz
      and ${newest}.at > coalesce(${last}.finished_at, '-infinity'::timestamptz)
      and ${counts.outfits} + ${counts.pieces} > 0
    order by ${newest}.owner_id`);
  return rows.map((row) => ({ ownerId: row.owner_id, tokenId: row.token_id }));
}
