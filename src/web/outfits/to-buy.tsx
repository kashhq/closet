import { Card } from '../card';
import { t } from '../i18n';
import { GarmentThumb } from '../layout/parts';
import type { OutfitGarment } from './queries';
import { piecesToBuy } from './references';

/**
 * An incomplete outfit as the pages say it (#335; the rule:
 * src/web/outfits/references.ts): it holds pieces not bought yet, so the
 * pickers that plan or pack an outfit show it disabled, the Saved grid
 * says how many pieces it waits for, and its page offers those pieces in
 * place of Plan.
 */

/** Why a picker (a day's, a trip's) cannot take the outfit; undefined when it is complete. */
export function buyFirstNote(
  garments: readonly OutfitGarment[],
): string | undefined {
  const count = piecesToBuy(garments).length;
  if (count === 0) return undefined;
  return count === 1
    ? t('outfits.BUY_FIRST_ONE')
    : t('outfits.BUY_FIRST', { count });
}

/** The Saved grid's line for an incomplete outfit (it has no activity: it was never planned). */
export function toBuyLine(
  garments: readonly OutfitGarment[],
): string | undefined {
  const count = piecesToBuy(garments).length;
  if (count === 0) return undefined;
  return count === 1 ? t('outfits.TO_BUY_ONE') : t('outfits.TO_BUY', { count });
}

/**
 * The outfit page's "To wear this, buy" in place of Plan: each piece not
 * bought yet, opening its page (where Bought it is, and a suggestion's
 * decisions), so the way to a plannable outfit is one tap away.
 */
export function ToBuySection(props: { pieces: readonly OutfitGarment[] }) {
  return (
    <section
      aria-labelledby="outfit-to-buy-title"
      class="flex flex-col gap-2"
      data-outfit-to-buy=""
    >
      <h2 id="outfit-to-buy-title" class="text-sm font-medium">
        {t('outfits.TO_WEAR_TITLE')}
      </h2>
      <ul class="flex flex-col gap-2">
        {props.pieces.map((piece) => (
          <li>
            <Card
              as="a"
              variant="content"
              class="flex-row items-center gap-3 p-2"
              href={`/wardrobe/${piece.id}`}
              data-piece-to-buy={piece.id}
            >
              <GarmentThumb
                garment={piece}
                class="size-14 rounded-field bg-base-200"
              />
              <span class="flex flex-col min-w-0">
                <span class="font-medium truncate">
                  {piece.name ?? t('outfits.UNNAMED_GARMENT')}
                </span>
                <span class="text-xs text-muted">
                  {t('outfits.NOT_BOUGHT')}
                </span>
              </span>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
