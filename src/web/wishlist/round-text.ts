import { t, type Translated } from '../i18n';
import { SAVED_PATH } from '../outfits/urls';
import { WISHLIST_PATH } from '../wardrobe/urls';
import type { RoundCounts } from './rounds';

/**
 * How a round of Muse's is said and where it leads (#337), the same on
 * Today's card and in its notification: "3 outfits, 7 pieces", and the
 * Outfits tab (Muse's outfits first) when it brought any, else the
 * Wishlist inbox.
 */

/** "3 outfits, 7 pieces", "1 outfit", "7 pieces": only what there is. */
export function roundWhat({ outfits, pieces }: RoundCounts): Translated {
  const outfitText =
    outfits === 1
      ? t('muse.round.OUTFITS_ONE')
      : t('muse.round.OUTFITS', { count: outfits });
  const pieceText =
    pieces === 1
      ? t('muse.round.PIECES_ONE')
      : t('muse.round.PIECES', { count: pieces });
  if (pieces === 0) return outfitText;
  if (outfits === 0) return pieceText;
  return t('muse.round.BOTH', { outfits: outfitText, pieces: pieceText });
}

/** Where Review goes: the outfits first (doc section 1), else the options. */
export function roundReviewPath({ outfits }: RoundCounts): string {
  return outfits > 0 ? SAVED_PATH : WISHLIST_PATH;
}
