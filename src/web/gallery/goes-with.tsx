import { Card } from '../card';
import type { OutfitCount } from '../../wardrobe/goes-with';
import { t, type Translated } from '../i18n';
import { OutfitCollage } from '../outfits/collage';
import { SnapStrip, SnapStripsInit, snapItem } from '../strip/snap-strip';
import { categoryLabel } from '../wardrobe/garment';
import { roleGroupLabel } from '../wardrobe/labels';
import { garmentUrl } from '../wardrobe/urls';
import { type GoesWithCloset, ideaName, type NearDuplicate } from './ideas';

/**
 * "Goes with my closet" (#18b) on a wishlist item's page, the owner's
 * alone (goesWithCloset reads their closet and clashes): how many outfits
 * it makes, the near-identical garments they already own, the best few as
 * the gallery's OutfitCollage cards in a scroll-snap strip, and the roles
 * it is worn with. Display only: nothing here posts, since an outfit with
 * something not yet bought cannot be saved (pickIdea takes closet
 * garments); "Bought it" makes it one.
 */

const GOES_WITH_ID = 'goes-with';

/** "Makes 12 outfits with your closet", or the card's shorter "Unlocks 12 outfits". */
function countText(count: OutfitCount, card: boolean): Translated {
  const { outfits, capped } = count;
  if (outfits === 0)
    return t(card ? 'goesWith.CARD_NONE' : 'goesWith.COUNT_NONE');
  if (capped) {
    return t(card ? 'goesWith.CARD_CAPPED' : 'goesWith.COUNT_CAPPED', {
      count: outfits,
    });
  }
  if (outfits === 1)
    return t(card ? 'goesWith.CARD_ONE' : 'goesWith.COUNT_ONE');
  return t(card ? 'goesWith.CARD' : 'goesWith.COUNT', { count: outfits });
}

/** A card's "Unlocks 12 outfits": the Muse inbox and a need's options. */
export function unlocksText(count: OutfitCount): Translated {
  return countText(count, true);
}

function GarmentLink(props: {
  garment: { id: number; name: string | null; category: string };
}) {
  const { garment } = props;
  return (
    <a href={garmentUrl(garment.id, undefined)} class="link link-hover">
      {garment.name ?? categoryLabel(garment.category)}
    </a>
  );
}

function Links(props: {
  garments: readonly { id: number; name: string | null; category: string }[];
}) {
  return (
    <>
      {props.garments.map((garment, index) => (
        <>
          {index > 0 && ', '}
          <GarmentLink garment={garment} />
        </>
      ))}
    </>
  );
}

/** Nothing without an answer: a grantee's view, or a garment not on the wishlist. */
export function GoesWithSection({
  goesWith,
}: {
  goesWith: GoesWithCloset | undefined;
}) {
  if (!goesWith) return null;
  const { best, roles } = goesWith;
  return (
    <Card
      as="section"
      variant="content"
      bodyClass="gap-3"
      id={GOES_WITH_ID}
      aria-labelledby="goes-with-title"
    >
      <h2 id="goes-with-title" class="card-title text-base">
        {t('goesWith.TITLE')}
      </h2>
      <div>
        <p class="text-lg font-semibold" data-goes-with-count="">
          {countText(goesWith, false)}
        </p>
        <p class="text-xs text-muted">{t('goesWith.JUDGED')}</p>
      </div>
      <NearDuplicates duplicates={goesWith.nearDuplicates} />
      {best.length > 0 && (
        <>
          {/* Display only, no control in a card: the strip itself takes focus. */}
          <SnapStrip
            size={best.length > 1 ? 'pair' : 'page'}
            label={t('goesWith.BEST_LABEL')}
            listbox={false}
            focusable
            class="pb-1"
            attributes={{ 'data-goes-with-strip': '' }}
          >
            {best.map((idea, index) => (
              <article
                {...snapItem({
                  value: idea.garments.map((g) => g.id).join(','),
                  selected: index === 0,
                  size: best.length > 1 ? 'pair' : 'page',
                  listbox: false,
                  class: 'flex flex-col gap-1',
                })}
                data-goes-with-idea={idea.garments.map((g) => g.id).join(',')}
              >
                <OutfitCollage garments={idea.garments} />
                <p class="text-sm font-medium line-clamp-2">
                  {ideaName(idea.garments)}
                </p>
              </article>
            ))}
          </SnapStrip>
          <SnapStripsInit />
          <p class="text-xs text-muted">{t('goesWith.DISPLAY_ONLY')}</p>
        </>
      )}
      {roles.length > 0 && (
        <div>
          <h3 class="text-sm font-semibold mb-1">
            {t('goesWith.PAIRS_HEADING')}
          </h3>
          <ul class="flex flex-col gap-1 text-sm">
            {roles.map((role) => (
              <li data-goes-with-role={role.role}>
                <span class="font-medium">{roleGroupLabel(role.role)}</span>{' '}
                <span class="text-muted">
                  {role.goes === 0
                    ? t('goesWith.NO_LAYER')
                    : t('goesWith.ROLE_COUNT', {
                        goes: role.goes,
                        of: role.of,
                      })}
                </span>
                {role.best.length > 0 && (
                  <>
                    {' · '}
                    <Links garments={role.best.map((p) => p.garment)} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/**
 * The closet garments near-identical to the item: the one it replaces is
 * like for like (info); any other is a second of something owned
 * (a warning: "do I need this?").
 */
function NearDuplicates({ duplicates }: { duplicates: NearDuplicate[] }) {
  const replaced = duplicates.filter((d) => d.replaced);
  const others = duplicates.filter((d) => !d.replaced);
  return (
    <>
      {replaced.length > 0 && (
        <p class="text-sm" data-goes-with-replaces="">
          {t('goesWith.REPLACES_LIKE_FOR_LIKE')} <Links garments={replaced} />
        </p>
      )}
      {others.length > 0 && (
        <div
          role="note"
          class="alert alert-warning alert-soft py-2 text-sm flex flex-col items-start gap-0"
          data-goes-with-duplicates=""
        >
          <p>
            {t('goesWith.DUPLICATES')} <Links garments={others} />
          </p>
          <p class="text-xs">{t('goesWith.DUPLICATES_HINT')}</p>
        </div>
      )}
    </>
  );
}
