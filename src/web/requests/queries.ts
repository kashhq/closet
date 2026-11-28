import { and, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { isDeletedClientId } from '../../db/errors';
import { OWNER_LOCKED, ownerLockSql } from '../../db/owner-lock';
import {
  agentRequest,
  garment,
  optionGroup,
  personalAccessToken,
  trip,
} from '../../db/schema';
import {
  CLAIM_LEASE_MINUTES,
  type RequestState,
  type RequestStatus,
  type RequestSubject,
} from '../../wardrobe/agent-requests';
import { viewsWardrobeSql } from '../sharing/access';
import { type AgentLabel, agentLabelSql, OWNER_READS } from '../write-origin';

/**
 * agent_request's statements (#681 B1; src/web/requests/AGENTS.md). Every
 * write is request-actions.ts' transitionRequest's: the ask's insert and
 * the moves' guarded update, each under the asker's owner lock. Reads are
 * the asker's own; nothing here takes an id of anyone else's.
 */

/** A request as the asker's surfaces read it (the API, the pages of #1286). */
export interface AgentRequestRow {
  id: number;
  clientId: string | null;
  body: string;
  status: RequestStatus;
  /** Null when it has none, or the asker no longer sees it (a share ended, the garment deleted). */
  subject: RequestSubject | null;
  /** The token holding the claim, as its owner reads it; null once the token is gone. */
  claimedBy: AgentLabel | null;
  claimedAt: Date | null;
  answer: string | null;
  answeredBy: AgentLabel | null;
  answeredAt: Date | null;
  answerSeenAt: Date | null;
  withdrawnAt: Date | null;
  createdAt: Date;
}

/** A request's subject as a check of what the asker sees now: the stored one only while it is. */
const subjectSql = sql<RequestSubject | null>`case
  when ${garment.id} is not null then json_build_object('kind', 'garment', 'id', ${garment.id})
  when ${agentRequest.tripId} is not null then json_build_object('kind', 'trip', 'id', ${agentRequest.tripId})
  when ${agentRequest.optionGroupId} is not null then json_build_object('kind', 'need', 'id', ${agentRequest.optionGroupId})
end`;

const ROW = {
  id: agentRequest.id,
  clientId: agentRequest.clientId,
  body: agentRequest.body,
  status: agentRequest.status,
  subject: subjectSql,
  claimedBy: agentLabelSql(agentRequest.claimedByTokenId, OWNER_READS),
  claimedAt: agentRequest.claimedAt,
  answer: agentRequest.answer,
  answeredBy: agentLabelSql(agentRequest.answeredByTokenId, OWNER_READS),
  answeredAt: agentRequest.answeredAt,
  answerSeenAt: agentRequest.answerSeenAt,
  withdrawnAt: agentRequest.withdrawnAt,
  createdAt: agentRequest.createdAt,
};

/**
 * The asker's requests matching `where`, the garment subject joined only
 * while they still see it (garment_id is a soft reference: schema.ts).
 * Joined, so every column keeps its table (src/db/AGENTS.md).
 */
function readRequests(db: Queryable, ownerId: number, where: SQL | undefined) {
  return db
    .select(ROW)
    .from(agentRequest)
    .leftJoin(
      garment,
      and(
        eq(garment.id, agentRequest.garmentId),
        viewsWardrobeSql(garment.ownerId, ownerId),
      ),
    )
    .where(and(eq(agentRequest.ownerId, ownerId), where));
}

/** One of the asker's requests; undefined for an unknown id or anyone else's. */
export async function requestOf(
  db: Queryable,
  ownerId: number,
  id: number,
): Promise<AgentRequestRow | undefined> {
  const [row] = await readRequests(db, ownerId, eq(agentRequest.id, id));
  return row;
}

/**
 * A page of the asker's requests, newest first (keyset on the id, one row
 * more than `limit` to say there is a next).
 */
export function requestPage(
  db: Queryable,
  ownerId: number,
  page: { before: number | undefined; limit: number },
): Promise<AgentRequestRow[]> {
  return readRequests(
    db,
    ownerId,
    page.before === undefined ? undefined : lt(agentRequest.id, page.before),
  )
    .orderBy(desc(agentRequest.id))
    .limit(page.limit + 1);
}

/** The changes feed's rows (src/web/sync/feed.ts): as stored, one statement for any owners. */
export function agentRequestsByIds(db: Queryable, ids: readonly number[]) {
  return db
    .select({
      id: agentRequest.id,
      body: agentRequest.body,
      status: agentRequest.status,
      garmentId: agentRequest.garmentId,
      tripId: agentRequest.tripId,
      optionGroupId: agentRequest.optionGroupId,
      claimedAt: agentRequest.claimedAt,
      answer: agentRequest.answer,
      answeredAt: agentRequest.answeredAt,
      answerSeenAt: agentRequest.answerSeenAt,
      withdrawnAt: agentRequest.withdrawnAt,
      createdAt: agentRequest.createdAt,
    })
    .from(agentRequest)
    .where(inArray(agentRequest.id, [...ids]));
}
export type SyncedAgentRequestRow = Awaited<
  ReturnType<typeof agentRequestsByIds>
>[number];

/** What the asker asks (the ask's insert). */
export interface NewRequest {
  body: string;
  subject: RequestSubject | null;
  clientId: string | null;
}

/** Whether `ownerId` may name `subject` now: a garment they see, their own trip or need. */
function subjectSeenSql(ownerId: number, subject: RequestSubject | null): SQL {
  if (subject === null) return sql`true`;
  switch (subject.kind) {
    case 'garment':
      return sql`exists (select from ${garment} where ${and(
        eq(garment.id, subject.id),
        viewsWardrobeSql(garment.ownerId, ownerId),
      )})`;
    case 'trip':
      return sql`exists (select from ${trip} where ${and(
        eq(trip.id, subject.id),
        eq(trip.ownerId, ownerId),
      )})`;
    case 'need':
      return sql`exists (select from ${optionGroup} where ${and(
        eq(optionGroup.id, subject.id),
        eq(optionGroup.ownerId, ownerId),
      )})`;
  }
}

const idOf = (subject: RequestSubject | null, kind: RequestSubject['kind']) =>
  subject?.kind === kind ? subject.id : null;

/**
 * The ask (createOnce's contract, src/db/create-once.ts, written out: its
 * `find` must also run when the subject is no longer seen): one statement, the owner lock folded in,
 * inserting only while the asker sees the subject, and saying which. With
 * a client id (the outbox's replay, the API's retry) a request of that id
 * already stored is the answer, `created: false`, whatever this one says;
 * the constraint arbitrates, never a read first. 'unseen': the subject is
 * not the asker's to name (or the account is gone). 'gone': the id of a
 * request deleted since (none today: only the account's cascade deletes,
 * which writes no tombstone).
 */
export async function insertRequest(
  db: Queryable,
  ownerId: number,
  ask: NewRequest,
): Promise<{ id: number; created: boolean } | 'unseen' | 'gone'> {
  let written: { seen: boolean; id: number | null };
  try {
    const { rows } = await db.execute<{ seen: boolean; id: number | null }>(
      sql`
        with ${ownerLockSql(db, ownerId)},
        seen as (
          select ${OWNER_LOCKED} and ${subjectSeenSql(ownerId, ask.subject)} as ok
        ),
        inserted as (
          insert into ${agentRequest}
            (owner_id, body, garment_id, trip_id, option_group_id, client_id)
          select ${ownerId}::int, ${ask.body}::text,
            ${idOf(ask.subject, 'garment')}::int, ${idOf(ask.subject, 'trip')}::int,
            ${idOf(ask.subject, 'need')}::int, ${ask.clientId}::uuid
          from seen where seen.ok
          on conflict (owner_id, client_id) do nothing
          returning id
        )
        select (select ok from seen) as seen, (select id from inserted) as id`,
    );
    written = rows[0];
  } catch (error) {
    if (isDeletedClientId(error)) return 'gone';
    throw error;
  }
  if (written.id !== null) return { id: written.id, created: true };
  // A replay finds its first request even once the subject is unseen: the
  // id names the ask, not what it is about.
  if (ask.clientId !== null) {
    const [first] = await db
      .select({ id: agentRequest.id })
      .from(agentRequest)
      .where(
        and(
          eq(agentRequest.ownerId, ownerId),
          eq(agentRequest.clientId, ask.clientId),
        ),
      );
    if (first) return { id: first.id, created: false };
  }
  // Seen, yet nothing inserted and nothing found: the conflicting row went.
  return written.seen ? 'gone' : 'unseen';
}

/**
 * The request as the machine reads it, row-locked inside the caller's
 * ownerTransaction (the owner first, then the row: src/db/AGENTS.md).
 * The lease is judged by the transaction's `now()`, the clock the move's
 * update stamps with. Undefined for an unknown id or anyone else's.
 */
export async function lockRequestState(
  tx: Queryable,
  ownerId: number,
  id: number,
): Promise<RequestState | undefined> {
  const [row] = await tx
    .select({
      status: agentRequest.status,
      claimedByTokenId: agentRequest.claimedByTokenId,
      claimTokenRevoked: sql<boolean>`exists (select 1 from ${personalAccessToken} where ${personalAccessToken.id} = ${agentRequest.claimedByTokenId} and ${personalAccessToken.revokedAt} is not null)`,
      leaseRuns: sql<boolean>`coalesce(${agentRequest.claimedAt} > now() - make_interval(mins => ${CLAIM_LEASE_MINUTES}::int), false)`,
      answerSeen: sql<boolean>`${agentRequest.answerSeenAt} is not null`,
    })
    .from(agentRequest)
    .where(and(eq(agentRequest.id, id), eq(agentRequest.ownerId, ownerId)))
    .for('update');
  return row;
}

/** The columns a move writes beside its status, by event (transitionRequest's patch). */
export type RequestPatch =
  | { kind: 'claim'; tokenId: number }
  /** `stampsClaim`: answered from open or a free claim, so the answerer claims it too. */
  | { kind: 'answer'; tokenId: number; answer: string; stampsClaim: boolean }
  | { kind: 'withdraw' }
  | { kind: 'seen' };

function patchColumns(patch: RequestPatch) {
  const now = sql`now()`;
  switch (patch.kind) {
    case 'claim':
      return { claimedByTokenId: patch.tokenId, claimedAt: now };
    case 'answer':
      return {
        ...(patch.stampsClaim && {
          claimedByTokenId: patch.tokenId,
          claimedAt: now,
        }),
        answer: patch.answer,
        answeredByTokenId: patch.tokenId,
        answeredAt: now,
      };
    case 'withdraw':
      return { withdrawnAt: now };
    case 'seen':
      return { answerSeenAt: now };
  }
}

/**
 * A move's one write, guarded by the status the machine judged (`from`):
 * under the owner lock nothing else moves the row, so a guard that fails
 * is a writer that skipped the lock, thrown rather than answered.
 */
export async function writeMove(
  tx: Queryable,
  ownerId: number,
  id: number,
  move: { from: RequestStatus; to: RequestStatus },
  patch: RequestPatch,
): Promise<void> {
  const written = await tx
    .update(agentRequest)
    .set({ status: move.to, ...patchColumns(patch) })
    .where(
      and(
        eq(agentRequest.id, id),
        eq(agentRequest.ownerId, ownerId),
        eq(agentRequest.status, move.from),
      ),
    )
    .returning({ id: agentRequest.id });
  if (written.length !== 1) {
    throw new Error(
      `agent_request ${id} left ${move.from} under its owner's lock: a writer without the lock`,
    );
  }
}
