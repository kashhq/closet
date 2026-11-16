import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState, PlinthImage } from '../layout/parts';
import type { SharedWardrobe } from '../sharing/access';
import type { ViewContext } from '../view-context';
import { capsuleUrl, wardrobeUrl } from '../wardrobe/urls';
import { WardrobeHeader, WardrobeTabs } from '../wardrobe/wardrobe-header';
import type { CapsuleCard, StripGarment } from './queries';
import { THUMB_ROW_WIDE } from '../layout/columns';

export interface CapsulesModel {
  /** The closet (inCloset): the first and permanent capsule. */
  closet: { count: number; strip: StripGarment[] };
  capsules: CapsuleCard[];
  /** The shared wardrobe shown; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** The wardrobes shared with the requester: the header's switcher. */
  sharedWardrobes: SharedWardrobe[];
  /** Adding garments (the header's add sheet): the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** New capsule: the owner only. */
  isOwner: boolean;
}

/** "1 garment", "12 garments". */
export function garmentCount(count: number): string {
  return count === 1 ? t('GARMENT_COUNT_ONE') : t('GARMENT_COUNT', { count });
}

/**
 * GET /capsules: the Wardrobe's Capsules tab. The closet comes first, as
 * the capsule every other is carved from (it is not a row: it links to the
 * grid), then the wardrobe's capsules by name, each its name, its count
 * and its newest garments on the plinth, like the grid's tiles: no card
 * chrome, the garments are the colour. "New capsule" is the add sheet's.
 */
export function CapsulesPage(props: {
  ctx: ViewContext;
  model: CapsulesModel;
}) {
  const { ctx, model } = props;
  const { viewOwner } = model;
  return (
    <Layout ctx={ctx} title={t('CAPSULES')}>
      <WardrobeHeader
        ctx={ctx}
        tab="capsules"
        viewOwner={viewOwner}
        sharedWardrobes={model.sharedWardrobes}
        canEdit={model.canEdit}
        newCapsule={model.isOwner}
      />
      <div class="pt-16">
        <WardrobeTabs active="capsules" viewOwner={viewOwner} />
        <main class="px-4 pt-4 pb-24 w-full max-w-lg mx-auto">
          <ul class="flex flex-col gap-6" id="capsule-list">
            <CapsuleEntry
              href={wardrobeUrl(viewOwner)}
              name={t('ALL_GARMENTS')}
              count={model.closet.count}
              strip={model.closet.strip}
            />
            {model.capsules.map((capsule) => (
              <CapsuleEntry
                href={capsuleUrl(capsule.id, viewOwner)}
                name={capsule.name}
                count={capsule.count}
                strip={capsule.strip}
              />
            ))}
          </ul>
          {model.capsules.length === 0 && (
            <EmptyState
              message={t(model.isOwner ? 'NO_CAPSULES' : 'NO_CAPSULES_SHARED')}
            >
              {model.isOwner && (
                <a href="/capsules/new" class="btn btn-primary btn-sm">
                  {t('ADD_FIRST_CAPSULE')}
                </a>
              )}
            </EmptyState>
          )}
        </main>
      </div>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * One capsule: its name and count over a row of its newest garments (four
 * fit a phone's width, 4:5 as in the grid). The whole entry is the link.
 */
function CapsuleEntry(props: {
  href: string;
  name: string;
  count: number;
  strip: StripGarment[];
}) {
  return (
    <li>
      <a href={props.href} class="block">
        <div class="flex items-baseline justify-between gap-2 mb-2">
          <h2 class="text-lg font-semibold truncate">{props.name}</h2>
          <span class="text-sm text-muted shrink-0">
            {garmentCount(props.count)}
          </span>
        </div>
        {props.strip.length > 0 && (
          <div class={THUMB_ROW_WIDE}>
            {props.strip.map((garment) => (
              <PlinthImage
                photo={garment.photo}
                category={garment.category}
                alt={garment.name ?? ''}
                class="aspect-[4/5] rounded-box"
              />
            ))}
          </div>
        )}
      </a>
    </li>
  );
}
