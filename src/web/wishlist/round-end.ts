import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { OwnerLockTimeout } from '../errors';
import type { AgentLabel } from '../write-origin';
import type { DeviceMessage, PushSender } from '../push/sender';
import { roundCard, roundPushTitle, roundReviewPath } from './round-text';
import { finishRound, quietRounds, type RoundCounts } from './rounds';

/**
 * How a round of Muse's ends (#337): its one notification, the same
 * whichever end it had, and the quiet close. The agent ends a round with
 * finish_round (src/web/mcp/tools/suggestions.ts), but an agent with its
 * own prompt may never call it (2026-10-06: 7 picks and 3 outfits, then
 * nothing, so no card and no notification). So the minute timer closes a
 * round the agent left open once it has been quiet for QUIET_PERIOD_MS,
 * through the same writer (finishRound) and the same notification.
 */

/**
 * How long an open round must go without a Muse write before the server
 * closes it. Long enough that an agent between two writes (a slow product
 * page, its own research) is not cut off mid-round. An agent calling
 * finish_round later finds its round closed already: round: null, its
 * summary unsaid.
 */
export const QUIET_PERIOD_MS = 30 * 60_000;

/** A newer round's notification replaces an unread one (the reminders' tags are today-morning, today-evening). */
const ROUND_TAG = 'muse-round';
/** A round's notification is worth a day: past it, Today's card says it. */
const ROUND_TTL_SECONDS = 24 * 60 * 60;

/** A stored round, as finishRound answers it, and whose. */
export interface EndedRound extends RoundCounts {
  ownerId: number;
  id: number;
  agent: AgentLabel | null;
}

function roundMessage(round: EndedRound): DeviceMessage {
  return {
    userId: round.ownerId,
    devices: 'muse-rounds',
    payload: {
      title: roundPushTitle(round.agent),
      body: roundCard(round.agent, round),
      url: roundReviewPath(round),
      tag: ROUND_TAG,
    },
    options: { ttlSeconds: ROUND_TTL_SECONDS },
  };
}

/**
 * Each round's one notification (doc section 4 A), in one batch
 * (sendEach: one read of the devices): to its owner's devices taking
 * the agent's rounds, tagged so a newer round replaces an unread one, kept a
 * day by the push service. After the rounds' commit: a failed send never
 * undoes a round, it is logged (the sender's own lines say which device).
 * How many devices each reached, in the rounds' order; none without
 * PWA_ENABLED.
 */
export async function notifyRounds(
  push: PushSender | undefined,
  logger: Logger,
  rounds: readonly EndedRound[],
): Promise<number[]> {
  if (!push || rounds.length === 0) return rounds.map(() => 0);
  try {
    const reports = await push.sendEach(rounds.map(roundMessage));
    return reports.map((report) => report.delivered);
  } catch (error) {
    logger.error(
      { err: error },
      `Round(s) ${rounds.map((round) => `${round.id} of user ${round.ownerId}`).join(', ')}: notification not sent`,
    );
    return rounds.map(() => 0);
  }
}

export interface RoundCloseDeps {
  db: Db;
  /** Undefined without PWA_ENABLED: rounds close, nobody is told. */
  push: PushSender | undefined;
  /** Context `Muse`. */
  logger: Logger;
}

/**
 * One minute's quiet close: the owners whose round has been open and
 * quiet since `now` less QUIET_PERIOD_MS (quietRounds, one statement,
 * nothing logged when it finds none), each round stored by finishRound
 * as the newest write's token, with no summary and the feedback cursor
 * unmoved, then every notification in one batch. An owner's failure is
 * logged and the others still close, and then the run throws
 * (QuietCloseFailed), so the job's metric records a failure; a busy owner
 * lock defers that one to the next minute, no failure. Started by
 * server.ts only; a spec calls it with the instant it wants. How many
 * rounds it closed.
 */
export async function closeQuietRounds(
  deps: RoundCloseDeps,
  now: Date,
): Promise<number> {
  const open = await quietRounds(
    deps.db,
    new Date(now.getTime() - QUIET_PERIOD_MS),
  );
  const closed: (EndedRound & { tokenId: number | null })[] = [];
  const failed: number[] = [];
  for (const { ownerId, tokenId } of open) {
    try {
      const finished = await finishRound(deps.db, ownerId, {
        tokenId,
        summary: null,
        feedbackUntil: null,
      });
      // Only when its agent's finish_round, or the owner's decisions, came
      // between the read and the lock.
      if (!finished.ok) {
        deps.logger.info(
          `Quiet round of user ${ownerId} had nothing left to close`,
        );
        continue;
      }
      closed.push({ ...finished, ownerId, tokenId });
    } catch (error) {
      if (error instanceof OwnerLockTimeout) {
        deps.logger.warn(
          `Quiet round of user ${ownerId} deferred: ${error.logDetail}`,
        );
        continue;
      }
      deps.logger.error(
        { err: error },
        `Quiet round of user ${ownerId} not closed`,
      );
      failed.push(ownerId);
    }
  }
  const notified = await notifyRounds(deps.push, deps.logger, closed);
  closed.forEach((round, index) => {
    deps.logger.info(
      `Round ${round.id} of user ${round.ownerId} closed after ${QUIET_PERIOD_MS / 60_000} quiet minutes (token ${round.tokenId ?? 'deleted'}): ${round.outfits} outfits, ${round.pieces} pieces, ${notified[index]} devices notified`,
    );
  });
  if (failed.length > 0) throw new QuietCloseFailed(failed, open.length);
  return closed.length;
}

/** A run in which some owners' rounds failed to close (each logged with its error); the others closed. */
export class QuietCloseFailed extends Error {
  constructor(
    readonly ownerIds: readonly number[],
    open: number,
  ) {
    super(
      `${ownerIds.length} of ${open} quiet round(s) not closed (users ${ownerIds.join(', ')})`,
    );
    this.name = 'QuietCloseFailed';
  }
}
