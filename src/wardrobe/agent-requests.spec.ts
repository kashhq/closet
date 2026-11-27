import { describe, expect, it } from 'vitest';
import {
  type RequestEvent,
  requestMove,
  type RequestState,
  type RequestStatus,
} from './agent-requests';

const ME = 7;
const OTHER = 8;

const state = (
  status: RequestStatus,
  claim: { by?: number | null; runs?: boolean; seen?: boolean } = {},
): RequestState => ({
  status,
  claimedByTokenId: claim.by ?? null,
  leaseRuns: claim.runs ?? false,
  answerSeen: claim.seen ?? false,
});

const claim: RequestEvent = { kind: 'claim', tokenId: ME };
const answer: RequestEvent = { kind: 'answer', tokenId: ME };
const withdraw: RequestEvent = { kind: 'withdraw' };
const seen: RequestEvent = { kind: 'seen' };

const move = (from: RequestStatus, to: RequestStatus, claimEffect: string) => ({
  kind: 'move',
  from,
  to,
  claim: claimEffect,
});
const refused = (reason: string) => ({ kind: 'refused', reason });
const unchanged = (status: RequestStatus) => ({ kind: 'unchanged', status });

describe('requestMove', () => {
  // Every event from every status, and the claim's three readings.
  it.each([
    ['claim open', state('open'), claim, move('open', 'claimed', 'take')],
    [
      'claim my own, renewed',
      state('claimed', { by: ME, runs: true }),
      claim,
      move('claimed', 'claimed', 'renew'),
    ],
    [
      "claim another's live claim",
      state('claimed', { by: OTHER, runs: true }),
      claim,
      refused('held'),
    ],
    [
      "claim another's expired claim",
      state('claimed', { by: OTHER, runs: false }),
      claim,
      move('claimed', 'claimed', 'takeover'),
    ],
    [
      'claim one whose token is gone',
      state('claimed', { by: null, runs: true }),
      claim,
      move('claimed', 'claimed', 'takeover'),
    ],
    ['claim answered', state('answered'), claim, refused('answered')],
    ['claim withdrawn', state('withdrawn'), claim, refused('withdrawn')],
    ['answer open', state('open'), answer, move('open', 'answered', 'take')],
    [
      'answer my own claim, lease run out',
      state('claimed', { by: ME, runs: false }),
      answer,
      move('claimed', 'answered', 'keep'),
    ],
    [
      "answer another's live claim",
      state('claimed', { by: OTHER, runs: true }),
      answer,
      refused('taken'),
    ],
    [
      "answer another's expired claim",
      state('claimed', { by: OTHER, runs: false }),
      answer,
      move('claimed', 'answered', 'takeover'),
    ],
    ['answer twice', state('answered'), answer, refused('answered')],
    ['answer withdrawn', state('withdrawn'), answer, refused('withdrawn')],
    [
      'withdraw open',
      state('open'),
      withdraw,
      move('open', 'withdrawn', 'keep'),
    ],
    [
      'withdraw claimed',
      state('claimed', { by: OTHER, runs: true }),
      withdraw,
      move('claimed', 'withdrawn', 'keep'),
    ],
    ['withdraw twice', state('withdrawn'), withdraw, unchanged('withdrawn')],
    ['withdraw answered', state('answered'), withdraw, refused('answered')],
    [
      'seen answered',
      state('answered'),
      seen,
      move('answered', 'answered', 'keep'),
    ],
    [
      'seen twice',
      state('answered', { seen: true }),
      seen,
      unchanged('answered'),
    ],
    ['seen open', state('open'), seen, refused('not-answered')],
    [
      'seen claimed',
      state('claimed', { by: ME, runs: true }),
      seen,
      refused('not-answered'),
    ],
    ['seen withdrawn', state('withdrawn'), seen, refused('withdrawn')],
  ] as const)('%s', (_name, from, event, expected) => {
    expect(requestMove(from, event)).toEqual(expected);
  });
});
