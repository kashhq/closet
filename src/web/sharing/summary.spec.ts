import { describe, expect, it } from 'vitest';
import { sharingSummary } from './pages';
import type { ShareView } from './queries';

// Only what the summary reads: whether a share was accepted and has expired.
const share = (
  state: Partial<Pick<ShareView, 'acceptedAt' | 'expired'>> = {},
) => ({ acceptedAt: null, expired: false, ...state }) as ShareView;
const accepted = () => share({ acceptedAt: new Date() });

describe("Profile's Sharing row", () => {
  it('says nothing is shared with no shares at all', () => {
    expect(sharingSummary({ outbound: [], inbound: [], pending: [] })).toBe(
      'Not shared',
    );
  });

  it('counts the invites to answer, one or many, never an expired one', () => {
    const summary = (pending: ShareView[]) =>
      sharingSummary({ outbound: [], inbound: [], pending });
    expect(summary([share()])).toBe('1 invite to answer');
    expect(summary([share(), share(), share()])).toBe('3 invites to answer');
    expect(summary([share(), share({ expired: true })])).toBe(
      '1 invite to answer',
    );
    expect(summary([share({ expired: true })])).toBe('Not shared');
  });

  it('tells the invites to answer from the links still open', () => {
    expect(
      sharingSummary({
        outbound: [accepted(), share(), share({ expired: true })],
        inbound: [accepted()],
        pending: [share(), share()],
      }),
    ).toBe(
      'Shared with 1 · 1 shared with you · 2 invites to answer · 1 link open',
    );
  });
});
