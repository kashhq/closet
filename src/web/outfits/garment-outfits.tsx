import { t } from '../i18n';
import { collagePieces, OutfitCollage } from './collage';
import type { GarmentOutfits } from './queries';

/** How many of the newest outfits the garment page's strip shows. */
export const GARMENT_OUTFITS_SHOWN = 8;

/**
 * The garment page's "In N outfits" (#84; redesign plan, "Garment page",
 * after Indyx): the owner's outfits that hold the garment, counted, and the
 * newest few as small collages in a scroll-snap strip, each opening its
 * outfit. The owner's alone, like outfits: nothing is read or rendered for
 * a grantee or a wishlist item (src/web/wardrobe/garment-routes.tsx), and nothing
 * when no outfit holds it.
 */
export function GarmentOutfitsStrip(props: { outfits: GarmentOutfits }) {
  const { count, outfits } = props.outfits;
  if (count === 0) return null;
  return (
    <section id="garment-outfits" aria-labelledby="garment-outfits-title">
      <h2 id="garment-outfits-title" class="text-sm text-muted mb-2">
        {count === 1
          ? t('garment.IN_OUTFITS_ONE')
          : t('garment.IN_OUTFITS', { count })}
      </h2>
      <ul class="flex gap-2 overflow-x-auto snap-x pb-1">
        {outfits.map((outfit) => (
          <li class="snap-start shrink-0 w-24">
            <a
              href={`/outfits/${outfit.id}`}
              class="flex flex-col gap-1"
              data-garment-outfit={outfit.id}
            >
              <OutfitCollage
                garments={collagePieces(outfit.garments, { warn: false })}
                size="thumb"
                decorative
              />
              <span class="text-xs truncate">
                {outfit.name || t('UNTITLED_OUTFIT')}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
