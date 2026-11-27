import { describe, expect, it } from 'vitest';
import { SAVED_PATH } from '../outfits/urls';
import { WISHLIST_PATH } from '../wardrobe/urls';
import { roundReviewPath, roundWhat } from './round-text';

// Every shape of a round here, not only the ones the integration specs'
// rounds happen to reach: a round of outfits alone was covered only when the
// gate's clock shift closed an earlier round first (agent-round-close.spec.ts).
describe('roundWhat', () => {
  it.each([
    [{ outfits: 3, pieces: 7 }, '3 outfits, 7 pieces'],
    [{ outfits: 1, pieces: 1 }, '1 outfit, 1 piece'],
    [{ outfits: 2, pieces: 0 }, '2 outfits'],
    [{ outfits: 1, pieces: 0 }, '1 outfit'],
    [{ outfits: 0, pieces: 7 }, '7 pieces'],
    [{ outfits: 0, pieces: 1 }, '1 piece'],
  ])('says %o as "%s"', (counts, text) => {
    expect(roundWhat(counts)).toBe(text);
  });
});

describe('roundReviewPath', () => {
  it('leads to the outfits when the round brought any, else the wishlist', () => {
    expect(roundReviewPath({ outfits: 1, pieces: 4 })).toBe(SAVED_PATH);
    expect(roundReviewPath({ outfits: 0, pieces: 4 })).toBe(WISHLIST_PATH);
  });
});
