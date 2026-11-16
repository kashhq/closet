import { ideasUrl } from '../gallery/urls';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import { EmptyState, SavedToast, StripFlags } from '../layout/parts';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import type { GridPage } from '../wardrobe/queries';
import { capsuleUrl, wardrobeUrl } from '../wardrobe/urls';
import {
  EMPTY_SEARCH,
  GarmentGrid,
  GarmentTiles,
  // eslint-disable-next-line closet/no-foreign-page-import -- a capsule shows the wardrobe grid; GarmentGrid and GarmentTiles move to a shared view piece (#718)
} from '../wardrobe/wardrobe-page';
import { garmentCount } from './list-page';
import type { CapsuleDetail } from './queries';

export interface CapsulePageModel {
  capsule: CapsuleDetail;
  /** The first page of its members in the closet (inCloset), newest first. */
  page: GridPage;
  count: number;
  /** The shared wardrobe it is in; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** Choose garments (the picker): the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** Edit, delete and Build an outfit (outfits are the owner's own): the owner only. */
  isOwner: boolean;
  /** One-shot flags: after a create, after the picker saved. */
  created: boolean;
  saved?: { added: number; removed: number };
}

/** The capsule page's one-shot flags (CapsulePageQuery). */
const CAPSULE_PAGE_FLAGS = ['created', 'added', 'removed'] as const;

/**
 * GET /capsules/:id: the capsule's garments as the wardrobe grid shows them
 * (the same tiles and keyset pages: the sentinel asks /wardrobe/tiles with
 * `capsule`), archived members left out; what the requester may do with
 * it; and where it leads: the grid filtered to it, the picker, and
 * Styling (#42) cycling only its garments.
 */
export function CapsulePage(props: {
  ctx: ViewContext;
  model: CapsulePageModel;
}) {
  const { ctx, model } = props;
  const { capsule, viewOwner } = model;
  const search = { ...EMPTY_SEARCH, capsule: String(capsule.id) };
  return (
    <Layout ctx={ctx} title={capsule.name}>
      <AppBar
        ctx={ctx}
        title={capsule.name}
        back={capsuleUrl(undefined, viewOwner)}
        actions={
          model.isOwner && (
            <a
              href={capsuleUrl(capsule.id, viewOwner, '/edit')}
              class="btn btn-ghost btn-sm"
            >
              {t('EDIT_CAPSULE')}
            </a>
          )
        }
      />
      <PageMain width="wide" class="p-4 pt-20 pb-24">
        {capsule.notes && (
          <p class="text-sm whitespace-pre-line text-base-content/70 mb-2 px-2">
            {capsule.notes}
          </p>
        )}
        <p class="text-sm text-muted mb-4 px-2">{garmentCount(model.count)}</p>
        <CapsuleActions model={model} />
        {model.page.tiles.length === 0 ? (
          <EmptyState message={t('CAPSULE_EMPTY')}>
            {model.canEdit && (
              <a href={pickerUrl(model)} class="btn btn-primary btn-sm">
                {t('CHOOSE_GARMENTS')}
              </a>
            )}
          </EmptyState>
        ) : (
          <GarmentGrid id="capsule-grid">
            <GarmentTiles
              page={model.page}
              search={search}
              viewOwner={viewOwner}
              selecting={false}
              firstPage
            />
          </GarmentGrid>
        )}
      </PageMain>
      {model.created && (
        <SavedToast id="capsule-created-toast" text={t('CAPSULE_CREATED')} />
      )}
      {model.saved && (
        <SavedToast
          id="capsule-saved-toast"
          text={t('CAPSULE_MEMBERS_SAVED', model.saved)}
        />
      )}
      <StripFlags names={CAPSULE_PAGE_FLAGS} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

function pickerUrl({ capsule, viewOwner }: CapsulePageModel): string {
  return wardrobeUrl(viewOwner, { pick: capsule.id });
}

/**
 * Where the capsule leads, for whoever may go there: the picker (owner and
 * MANAGE), the grid filtered to it, and the outfit builder (the owner's
 * own outfits only).
 */
function CapsuleActions({ model }: { model: CapsulePageModel }) {
  const { capsule, viewOwner } = model;
  return (
    <div class="flex flex-wrap gap-2 mb-6 px-2">
      {model.canEdit && (
        <a href={pickerUrl(model)} class="btn btn-primary btn-sm">
          {t('CHOOSE_GARMENTS')}
        </a>
      )}
      {model.count > 0 && (
        <a
          href={wardrobeUrl(viewOwner, { capsule: capsule.id })}
          class="btn btn-outline btn-sm"
        >
          {t('FILTER_WARDROBE_BY_CAPSULE')}
        </a>
      )}
      {/* Styling from the capsule (#42): every row cycles its garments.
          A grantee styles the shared wardrobe too, browsing only. */}
      {model.count > 0 && (
        <a
          href={stylingUrl({ capsuleId: capsule.id, ownerId: viewOwner })}
          class="btn btn-outline btn-sm"
        >
          {t('BUILD_OUTFIT_FROM_CAPSULE')}
        </a>
      )}
      {/* The gallery's Ideas drawn from this capsule alone (#9; its pool
          filters through inCapsule). The owner's: outfits are private. */}
      {model.isOwner && model.count > 0 && (
        <a
          href={ideasUrl({
            destination: { kind: 'none' },
            capsuleId: capsule.id,
          })}
          class="btn btn-outline btn-sm"
        >
          {t('gallery.SWIPE_OUTFITS')}
        </a>
      )}
    </div>
  );
}
