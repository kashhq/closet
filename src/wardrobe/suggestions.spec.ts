import { describe, expect, it } from 'vitest';
import {
  budgetFit,
  decideSuggestion,
  type GroupState,
  type PickState,
  productUrlKey,
} from './suggestions';

const AT = new Date('2026-10-05T12:00:00.000Z');
const EARLIER = new Date('2026-10-04T09:00:00.000Z');

const open: GroupState = {
  status: 'open',
  resolvedGarmentId: null,
  decidedAt: null,
};

function pick(id: number, extra: Partial<PickState> = {}): PickState {
  return {
    id,
    wanted: true,
    dismissedAt: null,
    dismissedReason: null,
    ...extra,
  };
}

/** Three options: 1 and 2 open, 3 set aside by the owner earlier. */
const picks = [
  pick(1),
  pick(2),
  pick(3, { dismissedAt: EARLIER, dismissedReason: 'colour' }),
];

describe('decideSuggestion', () => {
  it('This one resolves an open group and sets the other open picks aside', () => {
    expect(
      decideSuggestion(open, picks, { kind: 'choose', garmentId: 1 }),
    ).toEqual({
      ok: true,
      group: {
        status: 'resolved',
        resolvedGarmentId: 1,
        decided: true,
        dismissedReason: null,
      },
      dismiss: [{ garmentId: 2, reason: 'chose_another', note: null }],
      restore: [],
    });
  });

  it('refuses This one on a decided group, a dismissed pick, or a garment not in the group', () => {
    const resolved: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 1,
      decidedAt: AT,
    };
    expect(
      decideSuggestion(resolved, picks, { kind: 'choose', garmentId: 2 }),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
    expect(
      decideSuggestion(open, picks, { kind: 'choose', garmentId: 3 }),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
    expect(
      decideSuggestion(open, picks, { kind: 'choose', garmentId: 9 }),
    ).toEqual({ ok: false, refusal: 'not-in-group' });
  });

  it('Not for me on a pick records the owner’s reason; on the chosen one it reopens the group', () => {
    const decision = {
      kind: 'dismiss-pick',
      garmentId: 2,
      reason: 'too_pricey',
      note: 'over budget',
    } as const;
    expect(decideSuggestion(open, picks, decision)).toEqual({
      ok: true,
      group: undefined,
      dismiss: [{ garmentId: 2, reason: 'too_pricey', note: 'over budget' }],
      restore: [],
    });
    const chosen: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 2,
      decidedAt: AT,
    };
    const outcome = decideSuggestion(chosen, picks, decision);
    expect(outcome.ok && outcome.group?.status).toBe('open');
    // A suggestion outside any group is set aside alone.
    expect(decideSuggestion(undefined, [pick(2)], decision).ok).toBe(true);
  });

  it('Undo of a pick only inside an open group, never of a return', () => {
    expect(
      decideSuggestion(open, picks, { kind: 'undo-pick', garmentId: 3 }),
    ).toEqual({ ok: true, group: undefined, dismiss: [], restore: [3] });
    const dismissed: GroupState = {
      status: 'dismissed',
      resolvedGarmentId: null,
      decidedAt: AT,
    };
    expect(
      decideSuggestion(dismissed, picks, { kind: 'undo-pick', garmentId: 3 }),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
    expect(
      decideSuggestion(open, picks, { kind: 'undo-pick', garmentId: 1 }),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
    const returned = pick(4, {
      wanted: false,
      dismissedAt: AT,
      dismissedReason: 'returned',
    });
    expect(
      decideSuggestion(open, [returned], { kind: 'undo-pick', garmentId: 4 }),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
  });

  it('Not for me on the need dismisses an open group with its reason and note, picks untouched', () => {
    expect(
      decideSuggestion(open, picks, {
        kind: 'dismiss-group',
        groupId: 7,
        reason: 'not_now',
        note: 'next spring',
      }),
    ).toEqual({
      ok: true,
      group: {
        status: 'dismissed',
        resolvedGarmentId: null,
        decided: true,
        dismissedReason: 'not_now',
        ownerNote: 'next spring',
      },
      dismiss: [],
      restore: [],
    });
  });

  it('Undo of a choice restores exactly the siblings it set aside', () => {
    const chosen: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 1,
      decidedAt: AT,
    };
    const after = [
      pick(1),
      pick(2, { dismissedAt: AT, dismissedReason: 'chose_another' }),
      // Set aside by an earlier choice that was undone, then by the owner:
      // neither is this choice's doing.
      pick(3, { dismissedAt: EARLIER, dismissedReason: 'chose_another' }),
      pick(5, { dismissedAt: EARLIER, dismissedReason: 'style' }),
    ];
    expect(
      decideSuggestion(chosen, after, { kind: 'undo-group', groupId: 7 }),
    ).toEqual({
      ok: true,
      group: {
        status: 'open',
        resolvedGarmentId: null,
        decided: false,
        dismissedReason: null,
      },
      dismiss: [],
      restore: [2],
    });
  });

  it('Undo reopens a dismissed need, but never undoes a purchase', () => {
    const dismissed: GroupState = {
      status: 'dismissed',
      resolvedGarmentId: null,
      decidedAt: AT,
    };
    const reopened = decideSuggestion(dismissed, picks, {
      kind: 'undo-group',
      groupId: 7,
    });
    expect(reopened.ok && reopened.group?.status).toBe('open');
    const bought: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 1,
      decidedAt: AT,
    };
    expect(
      decideSuggestion(bought, [pick(1, { wanted: false }), pick(2)], {
        kind: 'undo-group',
        groupId: 7,
      }),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
    expect(
      decideSuggestion(open, picks, { kind: 'undo-group', groupId: 7 }),
    ).toEqual({
      ok: false,
      refusal: 'not-allowed',
    });
  });

  it('Bought it resolves the group by the garment, a pick or a different one, setting the open picks aside', () => {
    const chosen: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 1,
      decidedAt: AT,
    };
    // A different one: the chosen pick 1 and the open 2 both go.
    expect(
      decideSuggestion(chosen, picks, { kind: 'bought', garmentId: 42 }),
    ).toEqual({
      ok: true,
      group: {
        status: 'resolved',
        resolvedGarmentId: 42,
        decided: true,
        dismissedReason: null,
      },
      dismiss: [
        { garmentId: 1, reason: 'chose_another', note: null },
        { garmentId: 2, reason: 'chose_another', note: null },
      ],
      restore: [],
    });
    expect(
      decideSuggestion(undefined, [pick(1)], { kind: 'bought', garmentId: 1 }),
    ).toEqual({ ok: false, refusal: 'not-in-group' });
  });

  it('records a pick bought after another purchase settled the need, keeping the first resolver', () => {
    const settled: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 42,
      decidedAt: AT,
    };
    const after = [
      pick(42, { wanted: false }),
      pick(1, { dismissedAt: AT, dismissedReason: 'chose_another' }),
      pick(2, { dismissedAt: AT, dismissedReason: 'chose_another' }),
    ];
    expect(
      decideSuggestion(settled, after, { kind: 'bought', garmentId: 1 }),
    ).toEqual({ ok: true, group: undefined, dismiss: [], restore: [1] });
    // Settled by a resolver deleted since: the same, nothing to overwrite.
    expect(
      decideSuggestion(
        { ...settled, resolvedGarmentId: null },
        after.slice(1),
        { kind: 'bought', garmentId: 2 },
      ),
    ).toEqual({ ok: true, group: undefined, dismiss: [], restore: [2] });
  });

  it('takes a different one only for a need still to buy for: open, or its choice unbought', () => {
    const different = { kind: 'bought', garmentId: 42, groupId: 7 } as const;
    const boughtFirst: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 41,
      decidedAt: AT,
    };
    // Settled by another different one already (a second phone, a double post).
    expect(
      decideSuggestion(
        boughtFirst,
        [...picks, pick(41, { wanted: false })],
        different,
      ),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
    // Settled by a pick bought.
    const pickBought: GroupState = { ...boughtFirst, resolvedGarmentId: 1 };
    expect(
      decideSuggestion(
        pickBought,
        [pick(1, { wanted: false }), pick(2)],
        different,
      ),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
    // Set aside.
    const dismissed: GroupState = {
      status: 'dismissed',
      resolvedGarmentId: null,
      decidedAt: AT,
    };
    expect(decideSuggestion(dismissed, picks, different)).toEqual({
      ok: false,
      refusal: 'not-allowed',
    });
    // Open, or chosen and unbought: taken.
    expect(decideSuggestion(open, picks, different).ok).toBe(true);
    expect(
      decideSuggestion(
        { ...boughtFirst, resolvedGarmentId: 1 },
        picks,
        different,
      ).ok,
    ).toBe(true);
  });

  it('Returned sets the bought garment aside and reopens the need it settled', () => {
    const bought: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 1,
      decidedAt: AT,
    };
    const owned = [pick(1, { wanted: false }), pick(2)];
    expect(
      decideSuggestion(bought, owned, { kind: 'returned', garmentId: 1 }),
    ).toEqual({
      ok: true,
      group: {
        status: 'open',
        resolvedGarmentId: null,
        decided: false,
        dismissedReason: null,
      },
      dismiss: [{ garmentId: 1, reason: 'returned', note: null }],
      restore: [],
    });
    // Not bought yet: nothing to return.
    expect(
      decideSuggestion(bought, owned, { kind: 'returned', garmentId: 2 }),
    ).toEqual({ ok: false, refusal: 'not-allowed' });
  });

  it('a group whose resolving garment was deleted can still be undone', () => {
    const orphaned: GroupState = {
      status: 'resolved',
      resolvedGarmentId: null,
      decidedAt: AT,
    };
    const after = [
      pick(2, { dismissedAt: AT, dismissedReason: 'chose_another' }),
    ];
    expect(
      decideSuggestion(orphaned, after, { kind: 'undo-group', groupId: 7 }),
    ).toMatchObject({ ok: true, group: { status: 'open' }, restore: [2] });
  });

  it('buying a pick that was set aside restores it, and sets the chosen one aside', () => {
    const chosen: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 1,
      decidedAt: AT,
    };
    const after = [
      pick(1),
      pick(2, {
        wanted: false,
        dismissedAt: AT,
        dismissedReason: 'chose_another',
      }),
    ];
    expect(
      decideSuggestion(chosen, after, { kind: 'bought', garmentId: 2 }),
    ).toMatchObject({
      ok: true,
      group: { status: 'resolved', resolvedGarmentId: 2 },
      dismiss: [{ garmentId: 1, reason: 'chose_another', note: null }],
      restore: [2],
    });
  });

  it('Not for me on the chosen pick restores the siblings its choice set aside', () => {
    const chosen: GroupState = {
      status: 'resolved',
      resolvedGarmentId: 1,
      decidedAt: AT,
    };
    const after = [
      pick(1),
      pick(2, { dismissedAt: AT, dismissedReason: 'chose_another' }),
      pick(3, { dismissedAt: EARLIER, dismissedReason: 'colour' }),
    ];
    expect(
      decideSuggestion(chosen, after, {
        kind: 'dismiss-pick',
        garmentId: 1,
        reason: 'fit_size',
        note: null,
      }),
    ).toEqual({
      ok: true,
      group: {
        status: 'open',
        resolvedGarmentId: null,
        decided: false,
        dismissedReason: null,
      },
      dismiss: [{ garmentId: 1, reason: 'fit_size', note: null }],
      restore: [2],
    });
  });
});

describe('productUrlKey', () => {
  const key = (url: string) => productUrlKey(url);

  it.each([
    [
      'the fragment and a trailing slash',
      'https://shop.example/p/blazer/#reviews',
    ],
    ['http for https', 'http://shop.example/p/blazer'],
    ['www.', 'https://www.shop.example/p/blazer'],
    ['m.', 'https://m.shop.example/p/blazer'],
    ['the host’s case', 'https://Shop.Example/p/blazer'],
    ['utm_*', 'https://shop.example/p/blazer?utm_source=agent&utm_medium=x'],
    [
      'gclid, fbclid, msclkid',
      'https://shop.example/p/blazer?gclid=a&fbclid=b&msclkid=c',
    ],
    ['srsltid, igshid', 'https://shop.example/p/blazer?srsltid=a&igshid=b'],
    ['mc_cid, mc_eid', 'https://shop.example/p/blazer?mc_cid=a&mc_eid=b'],
    ['_ga, spm', 'https://shop.example/p/blazer?_ga=1.2&spm=a.b'],
  ])('ignores %s', (_what, url) => {
    expect(key(url)).toBe('shop.example/p/blazer');
  });

  it('sorts the parameters it keeps, which may name the variant', () => {
    expect(
      key('https://shop.example/p/blazer?size=40&color=navy&utm_x=1'),
    ).toBe('shop.example/p/blazer?color=navy&size=40');
    expect(key('https://shop.example/p/blazer?color=navy&size=40')).toBe(
      key('https://shop.example/p/blazer?size=40&color=navy'),
    );
    expect(key('https://shop.example/p/blazer?color=navy')).not.toBe(
      key('https://shop.example/p/blazer?color=black'),
    );
  });

  it('keeps a ref parameter: some shops name the product with it', () => {
    expect(key('https://shop.example/product?ref=SKU-1234')).toBe(
      'shop.example/product?ref=SKU-1234',
    );
    expect(key('https://shop.example/product?ref=SKU-1234')).not.toBe(
      key('https://shop.example/product?ref=SKU-5678'),
    );
  });

  it('drops Amazon’s /ref= segment after the product', () => {
    expect(
      key(
        'https://www.amazon.com/Wool-Blazer/dp/B0ABC12345/ref=sr_1_3?keywords=blazer&qid=1',
      ),
    ).toBe('amazon.com/Wool-Blazer/dp/B0ABC12345?keywords=blazer&qid=1');
    expect(key('https://www.amazon.com/dp/B0ABC12345/ref=cm_sw')).toBe(
      key('https://amazon.com/dp/B0ABC12345'),
    );
  });

  it('answers nothing for what is not a URL', () => {
    expect(productUrlKey('not a link')).toBeUndefined();
  });
});

describe('budgetFit', () => {
  it('compares in cents, the budget inclusive, and knows nothing without both', () => {
    expect(budgetFit('49.90', '49.90')).toBe('within');
    expect(budgetFit('0.30', '0.29')).toBe('over');
    expect(budgetFit(null, '50.00')).toBe('unknown');
    expect(budgetFit('50.00', null)).toBe('unknown');
  });
});
