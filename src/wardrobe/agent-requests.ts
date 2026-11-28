/**
 * "Ask your agent" requests (#681 B1; docs/plans/2026-11-27-mcp-oauth.md
 * sections 3.1 and 3.2): something a household member asks their agent on
 * the phone, which the next of their agent tokens to connect over MCP
 * claims and answers. Stored as agent_request (a check constraint lists
 * REQUEST_STATUSES), inserted `open` by the ask and moved afterwards only
 * by transitionRequest (src/web/requests/request-actions.ts), which holds
 * the asker's owner lock, reads the row, asks requestMove and writes what
 * it answers in one guarded UPDATE. Pure.
 *
 *   event     who                         from                               to
 *   claim     an agent token of the asker open; claimed: by it, or free      claimed
 *   answer    an agent token of the asker open; claimed: by it, or free      answered
 *   withdraw  the asker                   open, claimed                      withdrawn
 *   seen      the asker ("Got it")        answered, not seen yet             answered
 *
 * - A claim is **free** when its lease (CLAIM_LEASE_MINUTES) has run out or
 *   its token is gone (deleted or revoked): it reads as open to the next agent, so no timer
 *   ends a lease. Taking it over stamps the new token.
 * - claim by the token holding it renews the lease (idempotent for the
 *   agent; the lease clock restarts).
 * - answer from open (or a free claim) claims and answers at once.
 * - withdraw twice and seen twice leave the row as it is (`unchanged`), so
 *   a double tap is no error.
 *
 * Refused on purpose:
 * - claim or answer of a claim another token holds while its lease runs
 *   (`held` for a claim, `taken` for an answer: the answering agent lost
 *   it, or never had it).
 * - anything but withdraw after an answer (`answered`), and anything but
 *   withdraw after a withdrawal (`withdrawn`); seen before an answer
 *   (`not-answered`).
 */

export const REQUEST_STATUSES = [
  'open',
  'claimed',
  'answered',
  'withdrawn',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** How long a claim holds a request for its agent before another may take it over. */
export const CLAIM_LEASE_MINUTES = 30;

/** What the asker writes, trimmed (agent_request_body_check). */
export const REQUEST_BODY_MAX = 500;
/** The agent's reply, trimmed (agent_request_answer_check). */
export const REQUEST_ANSWER_MAX = 1000;

/** What a request may be about: one of these, or nothing (Today's sheet). */
export const REQUEST_SUBJECT_KINDS = ['garment', 'trip', 'need'] as const;
export type RequestSubjectKind = (typeof REQUEST_SUBJECT_KINDS)[number];

export interface RequestSubject {
  kind: RequestSubjectKind;
  id: number;
}

/** A move of an existing request; the ask is the insert. */
export type RequestEvent =
  | { kind: 'claim'; tokenId: number }
  | { kind: 'answer'; tokenId: number }
  | { kind: 'withdraw' }
  | { kind: 'seen' };

/** The row as the machine reads it, under the owner lock. */
export interface RequestState {
  status: RequestStatus;
  claimedByTokenId: number | null;
  /** The claiming token was revoked (its row stays), which frees its claim like an expired lease. */
  claimTokenRevoked: boolean;
  /** The claim's lease still runs (claimed_at + the lease is after now). */
  leaseRuns: boolean;
  answerSeen: boolean;
}

export type RequestRefusal =
  | 'held'
  | 'taken'
  | 'answered'
  | 'withdrawn'
  | 'not-answered';

/**
 * What a move does to the claim: `take` (from open), `renew` (its own
 * holder's claim again), `takeover` (a free claim of another token's) each
 * stamp the calling token as claimant, now; `keep` leaves it as it is.
 */
export type ClaimEffect = 'take' | 'renew' | 'takeover' | 'keep';

export type RequestMove =
  /** The row moves to `to` (perhaps its own status: a renewed claim, a seen answer). */
  | { kind: 'move'; from: RequestStatus; to: RequestStatus; claim: ClaimEffect }
  /** Already where the event leads: nothing to write, no error. */
  | { kind: 'unchanged'; status: RequestStatus }
  | { kind: 'refused'; reason: RequestRefusal };

/** Whose the claim is, as `tokenId` sees it. */
function claimOf(
  state: RequestState,
  tokenId: number,
): 'mine' | 'free' | 'held' {
  if (state.claimedByTokenId === tokenId) return 'mine';
  return state.claimedByTokenId === null ||
    state.claimTokenRevoked ||
    !state.leaseRuns
    ? 'free'
    : 'held';
}

const refused = (reason: RequestRefusal): RequestMove => ({
  kind: 'refused',
  reason,
});

/** What `event` does to a request in `state`. */
export function requestMove(
  state: RequestState,
  event: RequestEvent,
): RequestMove {
  switch (event.kind) {
    case 'claim':
    case 'answer':
      return agentMove(state, event);
    case 'withdraw':
      return withdrawMove(state.status);
    case 'seen':
      return seenMove(state);
  }
}

/** claim and answer: the agent's two moves, alike but for the refusal and the lease. */
function agentMove(
  state: RequestState,
  event: Extract<RequestEvent, { kind: 'claim' | 'answer' }>,
): RequestMove {
  const { status } = state;
  const to = event.kind === 'claim' ? 'claimed' : 'answered';
  switch (status) {
    case 'open':
      return { kind: 'move', from: status, to, claim: 'take' };
    case 'claimed': {
      const claim = claimOf(state, event.tokenId);
      if (claim === 'held') {
        return refused(event.kind === 'claim' ? 'held' : 'taken');
      }
      if (claim === 'free') {
        return { kind: 'move', from: status, to, claim: 'takeover' };
      }
      // Its own claim: a claim renews the lease, an answer keeps its time.
      const effect = event.kind === 'claim' ? 'renew' : 'keep';
      return { kind: 'move', from: status, to, claim: effect };
    }
    case 'answered':
      return refused('answered');
    case 'withdrawn':
      return refused('withdrawn');
  }
}

function withdrawMove(status: RequestStatus): RequestMove {
  switch (status) {
    case 'open':
    case 'claimed':
      return { kind: 'move', from: status, to: 'withdrawn', claim: 'keep' };
    case 'withdrawn':
      return { kind: 'unchanged', status };
    case 'answered':
      return refused('answered');
  }
}

function seenMove(state: RequestState): RequestMove {
  const { status } = state;
  switch (status) {
    case 'answered':
      return state.answerSeen
        ? { kind: 'unchanged', status }
        : { kind: 'move', from: status, to: status, claim: 'keep' };
    case 'open':
    case 'claimed':
      return refused('not-answered');
    case 'withdrawn':
      return refused('withdrawn');
  }
}
