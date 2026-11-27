import { t, type Translated } from '../i18n';
import { SAVED_PATH } from '../outfits/urls';
import { WISHLIST_PATH } from '../wardrobe/urls';
import { type AgentLabel, agentName } from '../write-origin';
import type { RoundCounts } from './rounds';

/**
 * How an agent's round is said and where it leads (#337), the same on
 * Today's card and in its notification: "3 outfits, 7 pieces", and the
 * Outfits tab (the agent's outfits first) when it brought any, else the
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

/**
 * "Dana’s agent: 3 outfits to consider" on Today's card and in the push
 * body. Sentence-initial, so an agent with no token ("Your agent") has its
 * own key rather than a capitalised fallback name.
 */
export function roundCard(
  agent: AgentLabel | null,
  counts: RoundCounts,
): Translated {
  const what = roundWhat(counts);
  return agent
    ? t('muse.round.CARD', { agent: agentName(agent), what })
    : t('muse.round.CARD_UNNAMED', { what });
}

/** The push title: the same two-key split as roundCard. */
export function roundPushTitle(agent: AgentLabel | null): Translated {
  return agent
    ? t('muse.round.PUSH_TITLE', { agent: agentName(agent) })
    : t('muse.round.PUSH_TITLE_UNNAMED');
}

/** Where Review goes: the outfits first (doc section 1), else the options. */
export function roundReviewPath({ outfits }: RoundCounts): string {
  return outfits > 0 ? SAVED_PATH : WISHLIST_PATH;
}
