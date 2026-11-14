import type { Child } from 'hono/jsx';
import type { OutfitCount } from '../../wardrobe/goes-with';
import { unlocksText } from '../gallery/goes-with';
import { AgentBadge } from '../agent-badge';
import { t } from '../i18n';
import { PageSentinel } from '../page-sentinel';
import { CANDIDATE_GRID, PAIR_GRID } from '../layout/columns';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageColumn, PageMain } from '../layout/page-main';
import { EmptyState } from '../layout/parts';
import { PostForm } from '../auth/form';
import type { BrandSizeLookup } from '../sizes/queries';
import { BrandSizeNote } from '../sizes/views';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import {
  destinationParams,
  garmentUrl,
  LINK_IMPORT_PATH,
  needUrl,
  wardrobeUrl,
  WISHLIST_PATH,
} from '../wardrobe/urls';
import { WardrobeHeader, WardrobeTabs } from '../wardrobe/wardrobe-header';
import {
  GROUPS_PAGE_SIZE,
  type Inbox,
  type InboxGroup,
  type NewNeed,
  type MusePick,
  type SetAsideRow,
  sharedUnlocks,
} from './inbox';
import {
  type DecisionToast,
  DecisionToastView,
  FromAgent,
  NeedFacts,
  NeedLink,
  PriceAgainstBudget,
  ProductPhoto,
  reasonText,
  UndoForm,
} from './suggestion-parts';

/** GET /wardrobe/wishlist/more: the next page of need cards. */
export const INBOX_MORE_PATH = `${WISHLIST_PATH}/more`;
/** POST /wardrobe/wishlist/seen: "New from Muse" (markSuggestionsSeen). */
export const INBOX_SEEN_PATH = `${WISHLIST_PATH}/seen`;
/** The slot the seen POST's answer fills, out of band. */
const NEW_SLOT_ID = 'muse-new';
/** Needs a "New from Muse" line names before "and N more". */
const NEW_NAMED = 3;

export interface InboxModel {
  inbox: Inbox;
  /** The shared wardrobe shown; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** Decisions, unlocks and "New from Muse": the owner's alone. */
  isOwner: boolean;
  /** Add and "Bought it": the owner and a MANAGE grantee (a VIEW grantee reads). */
  canEdit: boolean;
  toast: DecisionToast | undefined;
}

const TO_WISHLIST = destinationParams({ to: 'wishlist' });

/**
 * GET /wardrobe/wishlist, the Wishlist tab as Muse's inbox (#333;
 * docs/plans/2026-10-05-muse-suggestions.md, section 4 D), top to bottom:
 * Ready to buy (chosen, not bought), Muse's picks (a card per open need,
 * most unlocks first, paged with the Ideas sentinel), the owner's own
 * wishlist, "Muse is still looking for" and the set-aside list. One
 * primary per card: Bought it, or the need's "Compare and choose". One
 * markup: a phone's single column, two need cards and four product cards
 * across from `lg`. "New from Muse" is never in this HTML (doc section 9):
 * the owner's page asks for it as it loads (INBOX_SEEN_PATH) and the
 * answer fills its slot out of band.
 */
export function InboxPage(props: { ctx: ViewContext; model: InboxModel }) {
  const { ctx, model } = props;
  const { inbox, viewOwner, canEdit } = model;
  // Nothing to buy or decide; what was set aside still shows, to be undone.
  const empty =
    inbox.readyToBuy.length === 0 &&
    inbox.groups.length === 0 &&
    inbox.own.length === 0 &&
    inbox.stillLooking.length === 0;
  const returnTo = wardrobeUrl(viewOwner, {}, WISHLIST_PATH);
  return (
    <Layout ctx={ctx} title={t('wishlist.TITLE')}>
      <WardrobeHeader
        ctx={ctx}
        tab="wishlist"
        viewOwner={viewOwner}
        sharedWardrobes={inbox.sharedWardrobes}
        canEdit={canEdit}
      />
      <div class="pt-16">
        <PageColumn width="wide">
          <WardrobeTabs active="wishlist" viewOwner={viewOwner} />
        </PageColumn>
        <PageMain width="wide" class="flex flex-col gap-8 px-4 pt-4 pb-24">
          {empty ? (
            <EmptyState
              message={t(canEdit ? 'wishlist.EMPTY' : 'wishlist.EMPTY_SHARED')}
            >
              {canEdit && <AddButtons viewOwner={viewOwner} />}
            </EmptyState>
          ) : (
            <>
              <ReadyToBuy model={model} />
              <MusePicks model={model} />
              <OwnWishlist model={model} />
              <StillLooking model={model} returnTo={returnTo} />
            </>
          )}
          <SetAside model={model} returnTo={returnTo} />
        </PageMain>
      </div>
      <DecisionToastView toast={model.toast} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The empty wishlist's way to its first item: by hand, or from a product
 * link. Once it has items, the header's add sheet adds more.
 */
function AddButtons({ viewOwner }: { viewOwner: number | undefined }) {
  return (
    <div class="flex gap-2">
      <a
        href={wardrobeUrl(viewOwner, TO_WISHLIST, LINK_IMPORT_PATH)}
        class="btn btn-outline btn-sm"
      >
        {t('wishlist.ADD_FROM_LINK')}
      </a>
      <a
        href={wardrobeUrl(viewOwner, TO_WISHLIST, '/wardrobe/new')}
        class="btn btn-primary btn-sm"
      >
        + {t('wishlist.ADD')}
      </a>
    </div>
  );
}

function SectionHeading(props: { id: string; text: string }) {
  return (
    <h2
      id={props.id}
      class="text-xs font-semibold uppercase tracking-wide text-muted px-1 mb-2"
    >
      {props.text}
    </h2>
  );
}

function itemName(item: { name: string | null; category: string }): string {
  return item.name ?? categoryLabel(item.category);
}

/**
 * A product as a card of a CANDIDATE_GRID: its photo and name (a link to
 * its page), the lines under them with the product link, then Bought it,
 * the card's one primary, the card's width.
 */
function ProductCard(props: {
  item: {
    id: number;
    name: string | null;
    category: string;
    sourceUrl: string | null;
    photo: MusePick['photo'];
  };
  viewOwner: number | undefined;
  canBuy: boolean;
  /** Bought it as the solid primary (Ready to buy), else outlined (one's own wishlist). */
  primary: boolean;
  children?: Child;
  attributes?: Record<string, string>;
}) {
  const { item, viewOwner } = props;
  return (
    <li class="flex flex-col gap-1" {...props.attributes}>
      <a
        href={garmentUrl(item.id, viewOwner)}
        class="flex flex-col gap-1 no-underline"
      >
        <ProductPhoto photo={item.photo} alt="" />
        <span class="text-sm font-medium line-clamp-2">{itemName(item)}</span>
      </a>
      <div class="text-xs text-muted flex flex-col gap-0.5">
        {props.children}
        {item.sourceUrl && (
          // http(s) only (the column's check); a new tab, as on the garment page.
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="link link-hover text-base-content self-start py-1"
          >
            {t('VIEW_PRODUCT')} ↗
          </a>
        )}
      </div>
      {props.canBuy && (
        <a
          href={garmentUrl(item.id, viewOwner, '/bought')}
          class={`btn btn-primary btn-sm btn-block mt-auto${props.primary ? '' : ' btn-outline'}`}
        >
          {t('wishlist.BOUGHT_IT')}
        </a>
      )}
    </li>
  );
}

function BrandNote(props: {
  brandSizes: BrandSizeLookup | undefined;
  brand: string | null;
}) {
  return props.brandSizes ? (
    <BrandSizeNote note={props.brandSizes(props.brand)} size="text-xs" clamp />
  ) : null;
}

/** Chosen picks not yet bought (owner decision on #333: the top of the inbox). */
function ReadyToBuy({ model }: { model: InboxModel }) {
  const { readyToBuy, brandSizes } = model.inbox;
  if (readyToBuy.length === 0) return null;
  return (
    <section aria-labelledby="inbox-ready">
      <SectionHeading id="inbox-ready" text={t('muse.READY')} />
      <ul class={CANDIDATE_GRID} data-inbox-section="ready">
        {readyToBuy.map(({ need, pick }) => (
          <ProductCard
            item={pick}
            viewOwner={model.viewOwner}
            canBuy={model.canEdit}
            primary
            attributes={{ 'data-ready': String(pick.id) }}
          >
            <NeedLink
              name={need.name}
              href={needUrl(need.id, model.viewOwner)}
            />
            {pick.brand && <span>{pick.brand}</span>}
            <PriceAgainstBudget
              price={pick.price}
              budget={need.budget}
              class="text-xs text-base-content"
            />
            <BrandNote brandSizes={brandSizes} brand={pick.brand} />
          </ProductCard>
        ))}
      </ul>
    </section>
  );
}

function MusePicks({ model }: { model: InboxModel }) {
  const { groups } = model.inbox;
  if (groups.length === 0) return null;
  return (
    <section aria-labelledby="inbox-picks">
      <SectionHeading id="inbox-picks" text={t('muse.PICKS')} />
      {/* Filled out of band by the seen POST's answer, never in this HTML (doc section 9). */}
      {model.isOwner && (
        <div
          id={NEW_SLOT_ID}
          hx-post={INBOX_SEEN_PATH}
          hx-trigger="load"
          hx-swap="none"
        ></div>
      )}
      <ul class={PAIR_GRID} data-inbox-section="groups">
        <GroupCards groups={groups} page={1} viewOwner={model.viewOwner} />
      </ul>
    </section>
  );
}

/**
 * One page of need cards and, when there are more, the sentinel that
 * fetches the next as it comes into view (the Ideas page's pattern). GET
 * INBOX_MORE_PATH answers with this alone.
 */
export function GroupCards(props: {
  groups: readonly InboxGroup[];
  page: number;
  viewOwner: number | undefined;
}) {
  const { page, viewOwner } = props;
  const start = (page - 1) * GROUPS_PAGE_SIZE;
  const shown = props.groups.slice(start, start + GROUPS_PAGE_SIZE);
  const more = props.groups.length > start + GROUPS_PAGE_SIZE;
  return (
    <>
      {shown.map((group) => (
        <GroupCard group={group} viewOwner={viewOwner} />
      ))}
      {more && (
        <PageSentinel
          as="li"
          class="flex justify-center py-4 lg:col-span-2"
          href={wardrobeUrl(viewOwner, { page: page + 1 }, INBOX_MORE_PATH)}
          trigger="intersect once"
          marker="inbox"
          label={t('LOADING_MORE')}
        />
      )}
    </>
  );
}

/**
 * A need: its name, budget and how many options, then each option's
 * photo (the link named for a screen reader: the card's title is the need) with
 * its price and, when the options differ, "Unlocks N". The card is one link to the
 * decision screen (stretched over it, its one primary); a thumb opens the
 * screen with that option centred.
 */
function GroupCard(props: {
  group: InboxGroup;
  viewOwner: number | undefined;
}) {
  const { group, viewOwner } = props;
  const { need, options } = group;
  // The same count on every option decides nothing: said once, above them.
  const shared = sharedUnlocks(options, group.unlocks);
  return (
    <li
      class="card bg-base-100 border border-base-300 relative"
      data-need={String(need.id)}
    >
      <div class="card-body p-4 gap-3">
        <div class="min-w-0">
          <h3 class="font-semibold break-words">{need.name}</h3>
          <NeedFacts
            budget={need.budget}
            options={options.length}
            unlocks={shared}
          />
        </div>
        <ul class="grid grid-cols-3 gap-2 lg:gap-3">
          {options.map((pick) => (
            <li>
              <a
                href={needUrl(need.id, viewOwner, '', { option: pick.id })}
                class="relative z-10 flex flex-col gap-1 no-underline"
                aria-label={itemName(pick)}
                data-option={String(pick.id)}
              >
                <ProductPhoto photo={pick.photo} alt="" />
                <PriceAgainstBudget
                  price={pick.price}
                  budget={need.budget}
                  class="text-xs"
                  compact
                />
                {!shared && <Unlocks count={group.unlocks?.get(pick.id)} />}
              </a>
            </li>
          ))}
        </ul>
        {/* `static`: the theme's touch hit area makes a btn-sm its own
            containing block (views/assets/main.css), which would shrink the
            stretched ::after to the button. */}
        <a
          href={needUrl(need.id, viewOwner)}
          class="btn btn-primary btn-sm static self-start after:absolute after:inset-0"
        >
          {t('muse.DECIDE')}
        </a>
      </div>
    </li>
  );
}

/** "Unlocks 23 outfits": the owner's closet decides between options; nothing for a grantee. */
export function Unlocks({ count }: { count: OutfitCount | undefined }) {
  if (!count) return null;
  return (
    <span
      class="text-xs text-muted"
      data-unlocks={`${count.outfits}${count.capped ? '+' : ''}`}
    >
      {unlocksText(count)}
    </span>
  );
}

function OwnWishlist({ model }: { model: InboxModel }) {
  const { own, brandSizes } = model.inbox;
  if (own.length === 0) return null;
  return (
    <section aria-labelledby="inbox-own">
      <SectionHeading id="inbox-own" text={t('muse.OWN')} />
      <ul class={CANDIDATE_GRID} id="wishlist" data-inbox-section="own">
        {own.map((item) => (
          <ProductCard
            item={item}
            viewOwner={model.viewOwner}
            canBuy={model.canEdit}
            primary={false}
            attributes={{ 'data-own': String(item.id) }}
          >
            {item.suggested && <FromAgent agent={null} />}
            <AgentBadge agent={item.agent} byMuse={item.suggested} />
            {[item.brand, categoryLabel(item.category)]
              .filter(Boolean)
              .join(' · ')}
            <PriceAgainstBudget
              price={item.price}
              budget={null}
              class="text-xs text-base-content"
            />
            <BrandNote brandSizes={brandSizes} brand={item.brand} />
            {item.replaces && (
              <span>
                {t('wishlist.REPLACES', { name: itemName(item.replaces) })}
              </span>
            )}
          </ProductCard>
        ))}
      </ul>
    </section>
  );
}

/**
 * Needs Muse has no option for yet (owner decision on #333): one compact
 * line at the bottom, each with a one-tap "not now" (Not for me on the
 * need, reason not_now).
 */
function StillLooking(props: { model: InboxModel; returnTo: string }) {
  const { stillLooking } = props.model.inbox;
  if (stillLooking.length === 0) return null;
  return (
    <section class="flex flex-col gap-2" data-inbox-section="still-looking">
      <p class="text-sm text-muted px-1">{t('muse.STILL_LOOKING')}</p>
      <ul class="flex flex-wrap gap-2">
        {stillLooking.map((need) => (
          <li
            class="badge badge-outline h-auto gap-1 py-1 pl-3 pr-1"
            data-looking={String(need.id)}
          >
            <span>{need.name}</span>
            {props.model.isOwner && (
              <PostForm action={needUrl(need.id, undefined, '/dismiss')}>
                <input type="hidden" name="returnTo" value={props.returnTo} />
                <button
                  type="submit"
                  name="reason"
                  value="not_now"
                  class="btn btn-ghost btn-xs btn-circle"
                  aria-label={t('muse.NOT_NOW_NEED', { need: need.name })}
                >
                  ×
                </button>
              </PostForm>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What was set aside, collapsed under one count (doc section 4 D): a need
 * set aside, or a pick of an open need, each with its reason and Undo (the
 * owner's). Picks a choice set aside come back with its own Undo, on the
 * need's screen.
 */
function SetAside(props: { model: InboxModel; returnTo: string }) {
  const { setAside } = props.model.inbox;
  if (setAside.length === 0) return null;
  return (
    <details
      class="collapse collapse-arrow bg-base-100 border border-base-300"
      data-inbox-section="set-aside"
    >
      <summary class="collapse-title text-sm font-medium">
        {setAside.length === 1
          ? t('muse.SET_ASIDE_ONE')
          : t('muse.SET_ASIDE_COUNT', { count: setAside.length })}
      </summary>
      <ul class="collapse-content flex flex-col divide-y divide-base-300">
        {setAside.map((row) => (
          <SetAsideItem
            row={row}
            isOwner={props.model.isOwner}
            viewOwner={props.model.viewOwner}
            returnTo={props.returnTo}
          />
        ))}
      </ul>
    </details>
  );
}

function SetAsideItem(props: {
  row: SetAsideRow;
  isOwner: boolean;
  viewOwner: number | undefined;
  returnTo: string;
}) {
  const { row, viewOwner } = props;
  const [href, name, detail, reason, undo] =
    row.kind === 'need'
      ? [
          needUrl(row.need.id, viewOwner),
          row.need.name,
          t('muse.SET_ASIDE_NEED'),
          reasonText(row.need.dismissedReason),
          needUrl(row.need.id, undefined, '/undo'),
        ]
      : [
          garmentUrl(row.pick.id, viewOwner),
          itemName(row.pick),
          row.need ? row.need.name : '',
          reasonText(row.pick.dismissedReason),
          garmentUrl(row.pick.id, undefined, '/undo'),
        ];
  return (
    <li
      class="flex items-center gap-3 py-2"
      data-set-aside={`${row.kind}:${row.kind === 'need' ? row.need.id : row.pick.id}`}
    >
      <div class="min-w-0 flex-1">
        <a href={href} class="link link-hover text-sm font-medium break-words">
          {name}
        </a>
        <p class="text-xs text-muted">
          {[detail, reason].filter(Boolean).join(' · ')}
        </p>
      </div>
      {props.isOwner && (
        <UndoForm
          action={undo}
          returnTo={props.returnTo}
          ariaLabel={`${t('muse.UNDO')}: ${name}`}
        />
      )}
    </li>
  );
}

/**
 * The seen POST's answer: the slot, out of band, naming the needs with
 * picks new since the owner last looked (each a link to its screen), or
 * empty when there are none.
 */
export function NewFromMuse({ needs }: { needs: readonly NewNeed[] }) {
  const named = needs.slice(0, NEW_NAMED);
  const rest = needs.length - named.length;
  return (
    <div id={NEW_SLOT_ID} hx-swap-oob="true">
      {needs.length > 0 && (
        <p
          class="alert alert-info alert-soft block py-2 text-sm mb-3"
          role="status"
          data-new-from-muse=""
        >
          <span class="font-medium">{t('muse.NEW')}</span>{' '}
          {named.map((need, index) => (
            <>
              {index > 0 && ', '}
              <a href={needUrl(need.id, undefined)} class="link">
                {need.name}
              </a>
            </>
          ))}
          {rest > 0 && ` ${t('muse.NEW_MORE', { count: rest })}`}
        </p>
      )}
    </div>
  );
}
