import { Card } from '../card';
import type { BestOutfits } from '../../wardrobe/goes-with';
import { PhotoSet, viewerTrigger, enlargeLabel } from '../files/photo-viewer';
import type { ClosetGarment } from '../gallery/queries';
import { ideaName } from '../gallery/ideas';
import { t } from '../i18n';
import { museName } from '../write-origin';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import { OutfitCollage } from '../outfits/collage';
import { BrandSizeNote } from '../sizes/views';
import { SnapStrip, SnapStripsInit, snapItem } from '../strip/snap-strip';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import {
  garmentUrl,
  needUrl,
  wardrobeUrl,
  WISHLIST_PATH,
} from '../wardrobe/urls';
import { type MusePick, type NeedDetail, sharedUnlocks } from './inbox';
import { Unlocks } from './inbox-page';
import {
  ChooseForm,
  type DecisionToast,
  DecisionToastView,
  FromAgent,
  NeedFacts,
  NotForMe,
  PriceAgainstBudget,
  ProductPhoto,
  reasonText,
  UndoForm,
} from './suggestion-parts';
import { THUMB_ROW } from '../layout/columns';

export interface NeedPageModel {
  detail: NeedDetail;
  viewOwner: number | undefined;
  /** Every decision, unlocks and best outfits: the owner's alone. */
  isOwner: boolean;
  /** "Bought it" on the chosen pick: the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** `?option=`: the option centred first (a thumb tapped in the inbox). */
  option: number | undefined;
  toast: DecisionToast | undefined;
}

const PHOTO_SET = 'need-options';

/** The viewer's set: the options' photos in strip order. */
function viewerPhotos(options: readonly MusePick[]) {
  return options.flatMap((pick) =>
    pick.photo
      ? [
          {
            photo: pick.photo,
            alt: pickName(pick),
            variant: 'original' as const,
          },
        ]
      : [],
  );
}

function pickName(pick: { name: string | null; category: string }): string {
  return pick.name ?? categoryLabel(pick.category);
}

/** The chosen pick alone; else an open need's options; else none. */
function shownPicks(
  { need, options }: NeedDetail,
  chosen: MusePick | undefined,
): NeedDetail['options'] {
  if (chosen) return [chosen];
  return need.status === 'open' ? options : [];
}

/**
 * GET /wardrobe/wishlist/needs/:id, a need's decision screen (#333;
 * docs/plans/2026-10-05-muse-suggestions.md, section 4 C): the need, its
 * budget and Muse's reasoning behind a tap, then its options. On a phone a
 * snap strip, one card centred with the next peeking; from `lg` the same
 * markup as columns side by side (the strip's `options` size), so options
 * compare directly. Each card: the photo (the shared viewer), price
 * against the budget, Unlocks N, the brand size note, Muse's note, **This
 * one** (the card's one primary), then View product, Details and Not for
 * me in place, and its best outfits with the closet under it. A chosen
 * need shows its pick with Bought it; a need set aside, Undo. Every
 * decision is a PostForm back here (suggestion-routes.tsx, decide()).
 */
export function NeedPage(props: { ctx: ViewContext; model: NeedPageModel }) {
  const { ctx, model } = props;
  const { need, options, setAside } = model.detail;
  const self = needUrl(need.id, model.viewOwner);
  const chosen =
    need.status === 'resolved'
      ? need.picks.find((pick) => pick.id === need.resolvedGarmentId)
      : undefined;
  const shown = shownPicks(model.detail, chosen);
  // The same count on every option decides nothing: said once, in the facts.
  const shared = sharedUnlocks(shown, model.detail.judged);
  return (
    <Layout ctx={ctx} title={need.name}>
      <AppBar
        ctx={ctx}
        title={need.name}
        back={wardrobeUrl(model.viewOwner, {}, WISHLIST_PATH)}
      />
      <PageMain width="wide" class="flex flex-col gap-5 px-4 pt-20 pb-24">
        <header class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <FromAgent agent={need.agent} />
            <NeedState model={model} chosen={chosen} />
          </div>
          <NeedFacts
            budget={need.budget}
            options={options.length}
            unlocks={shared}
          />
          {need.note && (
            <details class="text-sm">
              <summary class="link link-hover text-muted">
                {t('muse.WHY', { agent: museName(need.agent) })}
              </summary>
              <p class="pt-1 whitespace-pre-line" data-need-note="">
                {need.note}
              </p>
            </details>
          )}
        </header>
        {shown.length > 0 && (
          <>
            <PhotoSet id={PHOTO_SET} photos={viewerPhotos(shown)} />
            <SnapStrip
              size="options"
              label={t('muse.OPTIONS_LABEL', { need: need.name })}
              listbox={false}
              tapThrough
              class="pb-2"
              attributes={{ 'data-need-options': '' }}
            >
              {shown.map((pick, index) => (
                <OptionCard
                  model={model}
                  pick={pick}
                  chosen={pick === chosen}
                  selected={
                    model.option === undefined
                      ? index === 0
                      : pick.id === model.option
                  }
                  self={self}
                  showUnlocks={!shared}
                />
              ))}
            </SnapStrip>
            <SnapStripsInit />
          </>
        )}
        {need.status === 'open' && options.length === 0 && (
          <p class="text-sm text-muted" data-no-options="">
            {t('muse.NO_OPTIONS_LEFT')}
          </p>
        )}
        <SetAsidePicks model={model} picks={setAside} self={self} />
        {model.isOwner && need.status === 'open' && (
          <footer class="flex flex-wrap items-start gap-2 border-t border-base-300 pt-4">
            <BoughtDifferent needId={need.id} />
            <NotForMe
              action={needUrl(need.id, undefined, '/dismiss')}
              returnTo={self}
              label={t('muse.NOT_THIS_NEED')}
            />
          </footer>
        )}
      </PageMain>
      <DecisionToastView toast={model.toast} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * "Bought a different one": the closet form for this need (`?forNeed=`).
 * The need's, so on C only: in its foot while open, beside Bought it once
 * a pick is chosen.
 */
function BoughtDifferent({ needId }: { needId: number }) {
  return (
    <a
      href={wardrobeUrl(undefined, { forNeed: needId }, '/wardrobe/new')}
      class="btn btn-ghost btn-sm self-start"
    >
      {t('muse.BOUGHT_DIFFERENT')}
    </a>
  );
}

/** Where the need stands when it is not open: chosen, bought, or set aside (with Undo). */
function NeedState(props: {
  model: NeedPageModel;
  chosen: MusePick | undefined;
}) {
  const { model, chosen } = props;
  const { need } = model.detail;
  const self = needUrl(need.id, model.viewOwner);
  if (need.status === 'dismissed') {
    return (
      <div
        class="flex flex-wrap items-center gap-2 w-full"
        data-need-state="dismissed"
      >
        <span class="badge badge-soft badge-neutral">
          {t('muse.NEED_SET_ASIDE', {
            reason: reasonText(need.dismissedReason),
          })}
        </span>
        {model.isOwner && (
          <UndoForm
            action={needUrl(need.id, undefined, '/undo')}
            returnTo={self}
            primary
          />
        )}
      </div>
    );
  }
  if (need.status !== 'resolved') return null;
  if (chosen) {
    return (
      <span class="badge badge-soft badge-success" data-need-state="chosen">
        {t('muse.CHOSEN')}
      </span>
    );
  }
  // Settled by a purchase: the garment bought, a pick or a different one.
  return need.resolver ? (
    <a
      href={garmentUrl(need.resolver.id, model.viewOwner)}
      class="badge badge-soft badge-success"
      data-need-state="bought"
    >
      {t('muse.BOUGHT', { name: pickName(need.resolver) })}
    </a>
  ) : null;
}

function OptionCard(props: {
  model: NeedPageModel;
  pick: MusePick;
  chosen: boolean;
  selected: boolean;
  self: string;
  showUnlocks: boolean;
}) {
  const { model, pick, chosen, self } = props;
  const { need, judged, brandSizes } = model.detail;
  const best = judged?.get(pick.id);
  return (
    <Card
      as="article"
      variant="content"
      bodyClass="p-3 gap-2 flex-1"
      {...snapItem({
        value: String(pick.id),
        selected: props.selected,
        size: 'options',
        listbox: false,
      })}
      data-option={String(pick.id)}
    >
      {pick.photo ? (
        <button
          type="button"
          class="block w-full"
          aria-label={enlargeLabel(pick.name)}
          {...viewerTrigger(PHOTO_SET, pick.photo, 'original')}
        >
          <ProductPhoto
            photo={pick.photo}
            alt={pickName(pick)}
            eager={props.selected}
          />
        </button>
      ) : (
        <ProductPhoto photo={null} alt="" />
      )}
      <div>
        <h2 class="font-semibold break-words">{pickName(pick)}</h2>
        {pick.brand && <p class="text-sm text-muted">{pick.brand}</p>}
      </div>
      <PriceAgainstBudget price={pick.price} budget={need.budget} />
      {model.isOwner && props.showUnlocks && <Unlocks count={best} />}
      {brandSizes && (
        <BrandSizeNote note={brandSizes(pick.brand)} size="text-xs" clamp />
      )}
      {pick.note && (
        <p class="text-sm line-clamp-2" data-pick-note="">
          {pick.note}
        </p>
      )}
      {/* At the card's foot, so This one lines up across the columns. */}
      <div class="mt-auto flex flex-col gap-2">
        <OptionActions model={model} pick={pick} chosen={chosen} self={self} />
        {best && <BestOutfitRows best={best} pickId={pick.id} />}
      </div>
    </Card>
  );
}

/**
 * The card's one primary (This one, or Bought it once chosen) and its
 * secondaries in a row: the product, its page, and Not for me in place.
 * A VIEW grantee reads; a MANAGE grantee may buy the chosen one.
 */
function OptionActions(props: {
  model: NeedPageModel;
  pick: MusePick;
  chosen: boolean;
  self: string;
}) {
  const { model, pick, chosen, self } = props;
  const { need } = model.detail;
  return (
    <div class="flex flex-col gap-2 pt-1">
      {model.isOwner && !chosen && (
        <ChooseForm
          action={garmentUrl(pick.id, undefined, '/choose')}
          returnTo={self}
        />
      )}
      {chosen && model.canEdit && (
        <a
          href={garmentUrl(pick.id, model.viewOwner, '/bought')}
          class="btn btn-primary btn-block"
        >
          {t('wishlist.BOUGHT_IT')}
        </a>
      )}
      {chosen && model.isOwner && <BoughtDifferent needId={need.id} />}
      <div class="flex flex-wrap items-start gap-1">
        {pick.sourceUrl && (
          <a
            href={pick.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-ghost btn-sm"
          >
            {t('VIEW_PRODUCT')} ↗
          </a>
        )}
        <a
          href={garmentUrl(pick.id, model.viewOwner)}
          class="btn btn-ghost btn-sm"
        >
          {t('muse.DETAILS')}
        </a>
        {model.isOwner && !chosen && (
          <NotForMe
            action={garmentUrl(pick.id, undefined, '/dismiss')}
            returnTo={self}
          />
        )}
        {model.isOwner && chosen && (
          <UndoForm
            action={needUrl(need.id, undefined, '/undo')}
            returnTo={self}
            label={t('muse.UNDO_CHOICE')}
          />
        )}
      </div>
    </div>
  );
}

/** Its best outfits with the closet, the pick marked to buy: rows under the card. */
function BestOutfitRows(props: {
  best: BestOutfits<ClosetGarment>;
  pickId: number;
}) {
  if (props.best.best.length === 0) return null;
  return (
    <div class="flex flex-col gap-1 pt-1">
      <p class="text-xs text-muted">{t('muse.BEST_LABEL')}</p>
      <ul class={THUMB_ROW} data-best-outfits="">
        {props.best.best.map((idea) => (
          <li title={ideaName(idea.garments)}>
            <OutfitCollage
              size="cell"
              garments={idea.garments.map((garment) =>
                garment.id === props.pickId
                  ? { ...garment, marks: ['to-buy' as const] }
                  : garment,
              )}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The need's picks set aside, each with its reason, and Undo while the need is open. */
function SetAsidePicks(props: {
  model: NeedPageModel;
  picks: readonly MusePick[];
  self: string;
}) {
  const { model, picks, self } = props;
  if (picks.length === 0) return null;
  const open = model.detail.need.status === 'open';
  return (
    <details
      class="collapse collapse-arrow bg-base-100 border border-base-300"
      data-need-set-aside=""
    >
      <summary class="collapse-title text-sm font-medium">
        {picks.length === 1
          ? t('muse.SET_ASIDE_ONE')
          : t('muse.SET_ASIDE_COUNT', { count: picks.length })}
      </summary>
      <ul class="collapse-content flex flex-col divide-y divide-base-300">
        {picks.map((pick) => (
          <li
            class="flex items-center gap-3 py-2"
            data-set-aside={`pick:${pick.id}`}
          >
            <div class="min-w-0 flex-1">
              <a
                href={garmentUrl(pick.id, model.viewOwner)}
                class="link link-hover text-sm font-medium break-words"
              >
                {pickName(pick)}
              </a>
              <p class="text-xs text-muted">
                {reasonText(pick.dismissedReason)}
                {pick.dismissedNote && ` · ${pick.dismissedNote}`}
              </p>
            </div>
            {model.isOwner && open && (
              <UndoForm
                action={garmentUrl(pick.id, undefined, '/undo')}
                returnTo={self}
                ariaLabel={`${t('muse.UNDO')}: ${pickName(pick)}`}
              />
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
