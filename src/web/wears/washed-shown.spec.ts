import { describe, expect, it } from 'vitest';
import { NEVER_WASH } from '../../wardrobe/availability';
import { washedShown } from './wear-section';

// Wore today is always rendered: the page's script shows its undo or the
// calendar's badge on the tap's day (wornState, src/page-day.spec.ts).
describe('washedShown', () => {
  const tee = { category: 'tops', washAfterWears: 1 };

  it('offers Washed for a wear since a wash that is due', () => {
    expect(washedShown(tee, { sinceWash: 1 })).toBe(true);
  });

  it('offers no Washed with nothing worn since a wash', () => {
    expect(washedShown(tee, { sinceWash: 0 })).toBe(false);
  });

  it('offers no Washed for a garment that is never washed', () => {
    const never = { ...tee, washAfterWears: NEVER_WASH };
    expect(washedShown(never, { sinceWash: 3 })).toBe(false);
  });
});
