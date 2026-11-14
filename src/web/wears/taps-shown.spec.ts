import { describe, expect, it } from 'vitest';
import { NEVER_WASH } from '../../wardrobe/availability';
import { tapsShown } from './wear-section';

// Wore today is always rendered: the page's script shows its undo or the
// calendar's badge on the page's day (wornState, src/page-day.spec.ts).
describe('tapsShown', () => {
  const tee = { category: 'tops', washAfterWears: 1 };

  it('offers both taps for a wear since a wash that is due', () => {
    expect(tapsShown(tee, { sinceWash: 1 })).toEqual({
      wear: true,
      wash: true,
    });
  });

  it('offers no Washed with nothing worn since a wash', () => {
    expect(tapsShown(tee, { sinceWash: 0 }).wash).toBe(false);
  });

  it('offers no Washed for a garment that is never washed', () => {
    const never = { ...tee, washAfterWears: NEVER_WASH };
    expect(tapsShown(never, { sinceWash: 3 }).wash).toBe(false);
  });
});
