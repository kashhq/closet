import {
  REQUEST_ANSWER_MAX,
  REQUEST_BODY_MAX,
  type RequestEvent,
  type RequestMove,
  type RequestRefusal,
  requestMove,
  type RequestStatus,
  type RequestSubject,
  storedText,
} from '../../wardrobe/agent-requests';
import type { Queryable } from '../../db/client';
import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import { t, type StringKey, type Translated } from '../i18n';
import { type ActionDeps, logOp } from '../op-log';
import { NotFound, type Resource } from '../refusals';
import type { Actor } from '../sharing/access';
import {
  type AgentRequestRow,
  claimableRequests,
  insertRequest,
  lockRequestState,
  type NewRequest,
  type RequestPatch,
  requestOf,
  requestPage,
  writeMove,
} from './queries';

/**
 * Every surface's way to an agent request (#681 B1; src/web/requests/
 * AGENTS.md): its reads, and transitionRequest, the one writer of every
 * move (src/wardrobe/agent-requests.ts' machine). A request is the
 * asker's alone: the actor's own, answered by their own agent tokens, so
 * anyone else's id is the unknown id's NotFound on every surface.
 */

/**
 * A move of the machine as a surface asks it. `ask` is the insert; the
 * rest act on the actor's request `id`. The agent's two carry the calling
 * token (`ToolContext.tokenId`, #1287).
 */
export type RequestTransition =
  | ({ kind: 'ask' } & NewRequest)
  | { kind: 'claim'; id: number; tokenId: number }
  | { kind: 'answer'; id: number; tokenId: number; answer: string }
  | { kind: 'withdraw'; id: number }
  | { kind: 'seen'; id: number };

/** What a transition left: the request, where it is, and whether this call changed it. */
export interface TransitionOutcome {
  id: number;
  status: RequestStatus;
  /** False for an ask replayed (its client id stored already), a second withdraw or Got it. */
  changed: boolean;
}

/** Each refusal's words, said once for every surface (a tool error, the API's 409). */
const REFUSAL = {
  held: 'refusal.agentRequest.held',
  taken: 'refusal.agentRequest.taken',
  answered: 'refusal.agentRequest.answered',
  withdrawn: 'refusal.agentRequest.withdrawn',
  'not-answered': 'refusal.agentRequest.notAnswered',
} as const satisfies Record<RequestRefusal, StringKey>;

/** The resource an unseen subject reads as: the unknown id's 404 of its kind. */
const SUBJECT_RESOURCE: Record<RequestSubject['kind'], Resource> = {
  garment: 'garment',
  trip: 'trip',
  need: 'need',
};

function requestNotFound(actor: Actor, id: number): NotFound {
  return new NotFound('agentRequest', {
    logDetail: `agent request ${id} is not user ${actor.userId}'s`,
  });
}

/**
 * The machine's one door: the ask's insert, or a move judged under the
 * asker's owner lock (lockRequestState, requestMove) and written in one
 * guarded update (writeMove). Refusals throw: an unknown id or anyone
 * else's is NotFound('agentRequest'), an unseen subject its kind's
 * NotFound, a move the machine refuses a 409 in its words. One `logOp`
 * line per change, after the commit, naming the request, the token on an
 * agent's move and the surface; never the body or the answer.
 */
export function transitionRequest(
  deps: ActionDeps<Queryable>,
  actor: Actor,
  transition: RequestTransition,
): Promise<TransitionOutcome> {
  return transition.kind === 'ask'
    ? askAgent(deps, actor, transition)
    : moveRequest(deps, actor, transition);
}

type Move = Exclude<RequestTransition, { kind: 'ask' }>;

async function askAgent(
  { db, logger }: ActionDeps<Queryable>,
  actor: Actor,
  { body, subject, clientId }: Extract<RequestTransition, { kind: 'ask' }>,
): Promise<TransitionOutcome> {
  const asked = await insertRequest(db, actor.userId, {
    body: checkedText(body, BODY_RULE),
    subject,
    clientId,
  });
  if (asked === 'unseen') {
    throw new NotFound(subject ? SUBJECT_RESOURCE[subject.kind] : 'wardrobe', {
      logDetail: `ask about ${subjectLabel(subject)}: not seen`,
    });
  }
  if (asked === 'gone') throw new HttpError(410, t('REQUEST_DELETED'));
  logOp(logger, actor, 'agent.request.asked', {
    requestId: asked.id,
    changed: asked.created,
    subject: subject?.kind ?? null,
    clientId: clientId ?? undefined,
  });
  return { id: asked.id, status: asked.status, changed: asked.created };
}

async function moveRequest(
  { db, logger }: ActionDeps<Queryable>,
  actor: Actor,
  transition: Move,
): Promise<TransitionOutcome> {
  const { id } = transition;
  const answer =
    transition.kind === 'answer'
      ? checkedText(transition.answer, ANSWER_RULE)
      : undefined;
  const moved: RequestMove | 'missing' = await ownerTransaction(
    db,
    actor.userId,
    'transitionRequest',
    async (tx) => {
      const state = await lockRequestState(tx, actor.userId, id);
      if (!state) return 'missing';
      const move = requestMove(state, eventOf(transition));
      if (move.kind === 'move') {
        await writeMove(
          tx,
          actor.userId,
          id,
          move,
          patchFor(transition, move, answer),
        );
      }
      return move;
    },
  );
  if (moved === 'missing') throw requestNotFound(actor, id);
  switch (moved.kind) {
    case 'refused':
      throw new HttpError(409, t(REFUSAL[moved.reason]), {
        logDetail: `${transition.kind} of agent request ${id}: ${moved.reason}`,
      });
    case 'unchanged':
      return { id, status: moved.status, changed: false };
    case 'move':
      logOp(logger, actor, `agent.request.${PAST[transition.kind]}`, {
        requestId: id,
        from: moved.from,
        to: moved.to,
        tokenId: 'tokenId' in transition ? transition.tokenId : undefined,
        claim: moved.claim === 'keep' ? undefined : moved.claim,
      });
      return { id, status: moved.to, changed: true };
  }
}

/** Each move's op name (`agent.request.<past participle>`, docs/conventions.md#logging). */
const PAST = {
  claim: 'claimed',
  answer: 'answered',
  withdraw: 'withdrawn',
  seen: 'seen',
} as const satisfies Record<RequestEvent['kind'], string>;

/** A move as the machine reads it: the event, without its id or answer. */
function eventOf(transition: Move): RequestEvent {
  switch (transition.kind) {
    case 'claim':
    case 'answer':
      return { kind: transition.kind, tokenId: transition.tokenId };
    case 'withdraw':
    case 'seen':
      return { kind: transition.kind };
  }
}

/** The columns the move writes: an answer takes the claim only from open or a free claim. */
function patchFor(
  transition: Move,
  move: Extract<RequestMove, { kind: 'move' }>,
  answer: string | undefined,
): RequestPatch {
  switch (transition.kind) {
    case 'claim':
      return { kind: 'claim', tokenId: transition.tokenId };
    case 'answer':
      return {
        kind: 'answer',
        tokenId: transition.tokenId,
        answer: answer ?? '',
        stampsClaim: move.claim !== 'keep',
      };
    case 'withdraw':
      return { kind: 'withdraw' };
    case 'seen':
      return { kind: 'seen' };
  }
}

/** A text's limit and its refusals' words (checkedText). */
interface TextRule {
  max: number;
  blank: () => Translated;
  tooLong: () => Translated;
}

const BODY_RULE: TextRule = {
  max: REQUEST_BODY_MAX,
  blank: () => t('refusal.agentRequest.bodyBlank'),
  tooLong: () =>
    t('refusal.agentRequest.bodyTooLong', { max: REQUEST_BODY_MAX }),
};

const ANSWER_RULE: TextRule = {
  max: REQUEST_ANSWER_MAX,
  blank: () => t('refusal.agentRequest.answerBlank'),
  tooLong: () =>
    t('refusal.agentRequest.answerTooLong', { max: REQUEST_ANSWER_MAX }),
};

/**
 * The body or answer as stored (storedText), 1..max code points, as
 * agent_request_body_check and _answer_check count: the one check of
 * either, on every surface, before the write, so a bad one is a 400, never
 * the constraint's 500. The route schemas only bound what is sent.
 */
function checkedText(raw: string, rule: TextRule): string {
  const text = storedText(raw);
  if (text.length === 0) throw new HttpError(400, rule.blank());
  if ([...text].length > rule.max) throw new HttpError(400, rule.tooLong());
  return text;
}

function subjectLabel(subject: RequestSubject | null): string {
  return subject ? `${subject.kind} ${subject.id}` : 'nothing';
}

/** The actor's request `id`, or NotFound('agentRequest'). */
export async function requireRequest(
  { db }: Pick<ActionDeps<Queryable>, 'db'>,
  actor: Actor,
  id: number,
): Promise<AgentRequestRow> {
  const row = await requestOf(db, actor.userId, id);
  if (!row) throw requestNotFound(actor, id);
  return row;
}

/**
 * The requests the actor's agent token may claim or already holds, oldest
 * first (at most `limit`): list_agent_requests. Judged by the same lease
 * rule as a claim, so what it lists is what a claim would take.
 */
export function listClaimableRequests(
  { db }: Pick<ActionDeps<Queryable>, 'db'>,
  actor: Actor,
  tokenId: number,
  limit: number,
): Promise<AgentRequestRow[]> {
  return claimableRequests(db, actor.userId, tokenId, limit);
}

/** A page of the actor's requests, newest first: `more` says there is a next. */
export async function listRequests(
  { db }: Pick<ActionDeps<Queryable>, 'db'>,
  actor: Actor,
  page: { before: number | undefined; limit: number },
): Promise<{ rows: AgentRequestRow[]; more: boolean }> {
  const rows = await requestPage(db, actor.userId, page);
  return { rows: rows.slice(0, page.limit), more: rows.length > page.limit };
}
