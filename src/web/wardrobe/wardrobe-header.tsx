import type { Child } from 'hono/jsx';
import { PostForm } from '../form';
import { t } from '../i18n';
import { INSIGHTS_PATH, RECAP_PATH } from '../insights/urls';
import { AppBar } from '../layout/app-bar';
import { LinkTabs } from '../layout/link-tabs';
import {
  CameraIcon,
  PHOTO_ACCEPT,
  PhotoLibraryIcon,
  PREPARE_AND_SUBMIT_PHOTO,
  SheetBackdrop,
} from '../layout/parts';
import type { SharedWardrobe } from '../sharing/access';
import { PermissionBadge } from '../sharing/pages';
import { SHARING_PATH } from '../sharing/urls';
import type { ViewContext } from '../view-context';
import { ORDERS_PATH } from './order-mail/urls';
import {
  capsuleUrl,
  destinationParams,
  LAUNDRY_PATH,
  LINK_IMPORT_PATH,
  PHOTO_ADD_PATH,
  TAG_PATH,
  wardrobeUrl,
  WISHLIST_PATH,
} from './urls';

/**
 * The Wardrobe's header and tabs (docs/plans/2026-09-26-redesign.md,
 * section 3, "Wardrobe"): the app bar whose title is the wardrobe switcher,
 * with the ⋯ menu and the ＋ add sheet, and the tabs under it, Closet,
 * Capsules, Laundry and Wishlist (the owner's decision 4 on #43). Every
 * tab page renders both, so moving between them keeps the header. Muse's
 * suggestions live in the Wishlist tab (#333, owner decision 2026-10-05).
 */

export type WardrobeTab = 'closet' | 'capsules' | 'laundry' | 'wishlist';

/**
 * A tab's page in a wardrobe. Laundry is the signed-in user's own (it
 * reads no `?ownerId=`), so a shared wardrobe has no Laundry tab and the
 * switcher takes it to that wardrobe's closet.
 */
function tabUrl(tab: WardrobeTab, viewOwner: number | undefined): string {
  switch (tab) {
    case 'closet':
      return wardrobeUrl(viewOwner);
    case 'capsules':
      return capsuleUrl(undefined, viewOwner);
    case 'laundry':
      return viewOwner === undefined ? LAUNDRY_PATH : wardrobeUrl(viewOwner);
    case 'wishlist':
      return wardrobeUrl(viewOwner, {}, WISHLIST_PATH);
  }
}

export interface WardrobeHeaderProps {
  ctx: ViewContext;
  tab: WardrobeTab;
  /** The shared wardrobe shown; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** The wardrobes shared with the requester: the switcher's choices. */
  sharedWardrobes: SharedWardrobe[];
  /** Adding garments and tagging them: the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** "New capsule" in the add sheet: the owner, on the Capsules tab. */
  newCapsule?: boolean;
  /** The ⋯ menu's Select: the closet grid's select mode, its filters kept. */
  selectUrl?: string;
}

/**
 * The app bar of a Wardrobe tab. Nothing in it varies but with the data
 * (the switcher's wardrobes, what the requester may do), so /wardrobe
 * stays byte-stable as a stale-while-revalidate tab root. The add sheet
 * is a dialog beside the bar, opened by its ＋.
 */
export function WardrobeHeader(props: WardrobeHeaderProps) {
  const { ctx, viewOwner, canEdit } = props;
  const canAdd = canEdit || props.newCapsule === true;
  return (
    <>
      <AppBar
        ctx={ctx}
        title={wardrobeTitle(props.sharedWardrobes, viewOwner)}
        titleMenu={<SwitcherItems {...props} />}
        actions={
          <>
            <WardrobeMenu
              viewOwner={viewOwner}
              canEdit={canEdit}
              selectUrl={props.selectUrl}
              orders={ctx.orderReview}
            />
            {canAdd && (
              <button
                type="button"
                class="btn btn-ghost btn-sm btn-circle"
                aria-label={t('add.TITLE')}
                aria-haspopup="dialog"
                onclick={OPEN_ADD_SHEET}
              >
                <PlusIcon />
              </button>
            )}
          </>
        }
      />
      {canAdd && (
        <AddSheet
          tab={props.tab}
          viewOwner={viewOwner}
          canEdit={canEdit}
          newCapsule={props.newCapsule === true}
        />
      )}
    </>
  );
}

/** "Wardrobe" for one's own; "Dana's wardrobe" for a shared one. */
function wardrobeTitle(
  shared: SharedWardrobe[],
  viewOwner: number | undefined,
): string {
  const owner = shared.find((wardrobe) => wardrobe.grantorId === viewOwner);
  return owner ? t('WARDROBE_OF', { name: owner.grantorName }) : t('WARDROBE');
}

/**
 * The switcher (the title's menu): the requester's own wardrobe, each one
 * shared with them with what they may do there, and where sharing is
 * managed (Profile › Sharing). Plain links: switching changes the title,
 * the tabs and what may be done, so it is a whole page, not a swap.
 */
function SwitcherItems(props: WardrobeHeaderProps) {
  const { tab, viewOwner } = props;
  return (
    <>
      <li>
        <a
          href={tabUrl(tab, undefined)}
          aria-current={viewOwner === undefined ? 'true' : undefined}
          class={viewOwner === undefined ? 'menu-active' : undefined}
        >
          {t('MY_WARDROBE')}
        </a>
      </li>
      {props.sharedWardrobes.map((shared) => (
        <li>
          <a
            href={tabUrl(tab, shared.grantorId)}
            aria-current={viewOwner === shared.grantorId ? 'true' : undefined}
            class={`justify-between ${viewOwner === shared.grantorId ? 'menu-active' : ''}`}
          >
            <span class="truncate">{shared.grantorName}</span>
            <PermissionBadge permission={shared.permission} />
          </a>
        </li>
      ))}
      <li class="mt-1 border-t border-base-300 pt-1">
        <a href={SHARING_PATH}>{t('MANAGE_SHARING')}</a>
      </li>
    </>
  );
}

/**
 * The Wardrobe header's ⋯ menu ("Where every route goes"): the wardrobe's
 * less frequent places. Select (the closet grid's, with its filters) and
 * tagging for someone who may edit; Insights (#17), the signed-in user's
 * own, so its link never carries a shared wardrobe's `?ownerId=`. The
 * year in review (#26) is the user's own too, and offered only on their own wardrobe, never in a
 * grantee's view of another. Links only: a form inside a daisyUI menu item
 * loses its styling.
 *
 * `oob` swaps it in beside a filtered grid (GET /wardrobe's fragment), so
 * Select keeps the filters the grid now shows.
 */
export function WardrobeMenu(props: {
  viewOwner: number | undefined;
  canEdit: boolean;
  selectUrl?: string;
  /**
   * "From your orders" (#25): the signed-in user is the order mail's owner
   * (shown on their own wardrobe, like the year in review).
   */
  orders: boolean;
  oob?: boolean;
}) {
  const { viewOwner, canEdit } = props;
  return (
    <details
      class="dropdown dropdown-end"
      id="wardrobe-menu"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      <summary
        class="btn btn-ghost btn-sm btn-circle text-xl"
        aria-label={t('MORE_ACTIONS')}
      >
        ⋯
      </summary>
      <ul class="menu dropdown-content bg-base-100 rounded-box border border-base-300 z-20 w-56 p-2 mt-2">
        {canEdit && props.selectUrl && (
          <li>
            <a href={props.selectUrl}>{t('SELECT')}</a>
          </li>
        )}
        {canEdit && (
          <li>
            <a href={wardrobeUrl(viewOwner, {}, TAG_PATH)}>
              {t('TAG_GARMENTS')}
            </a>
          </li>
        )}
        <li>
          <a href={INSIGHTS_PATH}>{t('insights.TITLE')}</a>
        </li>
        {viewOwner === undefined && (
          <li>
            <a href={RECAP_PATH}>{t('recap.TITLE')}</a>
          </li>
        )}
        {props.orders && viewOwner === undefined && (
          <li>
            <a href={ORDERS_PATH}>{t('orders.TITLE')}</a>
          </li>
        )}
      </ul>
    </details>
  );
}

const TO_WISHLIST = destinationParams({ to: 'wishlist' });

/** The `onclick` of a control opening the add sheet: the header's ＋, Today's first-run button. */
export const OPEN_ADD_SHEET =
  "document.getElementById('add-sheet').showModal()";

/**
 * The add sheet (plan: "+" in the Wardrobe header): a garment for the
 * closet from the camera, the photo library, a product link or entered by
 * hand; for the wishlist from a link or by hand; on the owner's Capsules
 * tab a new capsule first. The Wishlist tab lists its own first. Today's
 * first-run path (#666) renders it too, for the requester's own closet.
 */
export function AddSheet(props: {
  tab: WardrobeTab;
  viewOwner: number | undefined;
  canEdit: boolean;
  newCapsule: boolean;
}) {
  const { viewOwner } = props;
  const closet = (
    <AddGroup title={t('add.TO_CLOSET')}>
      <PhotoItem source="camera" />
      <PhotoItem source="library" />
      <AddItem
        href={wardrobeUrl(viewOwner, {}, LINK_IMPORT_PATH)}
        icon={LINK_ICON}
      >
        {t('add.FROM_LINK')}
      </AddItem>
      <AddItem
        href={wardrobeUrl(viewOwner, {}, '/wardrobe/new')}
        icon={PENCIL_ICON}
      >
        {t('add.BY_HAND')}
      </AddItem>
    </AddGroup>
  );
  const wishlist = (
    <AddGroup title={t('add.TO_WISHLIST')}>
      <AddItem
        href={wardrobeUrl(viewOwner, TO_WISHLIST, LINK_IMPORT_PATH)}
        icon={LINK_ICON}
      >
        {t('add.FROM_LINK')}
      </AddItem>
      <AddItem
        href={wardrobeUrl(viewOwner, TO_WISHLIST, '/wardrobe/new')}
        icon={PENCIL_ICON}
      >
        {t('add.BY_HAND')}
      </AddItem>
    </AddGroup>
  );
  return (
    <dialog
      id="add-sheet"
      class="modal modal-bottom sm:modal-middle"
      aria-labelledby="add-sheet-title"
    >
      <div class="modal-box group flex flex-col gap-4">
        <h2 id="add-sheet-title" class="font-bold text-lg">
          {t('add.TITLE')}
        </h2>
        {props.newCapsule && (
          <AddGroup title={t('CAPSULES')}>
            <AddItem href="/capsules/new" icon={CAPSULE_ICON}>
              {t('NEW_CAPSULE')}
            </AddItem>
          </AddGroup>
        )}
        {props.canEdit &&
          (props.tab === 'wishlist' ? (
            <>
              {wishlist}
              {closet}
            </>
          ) : (
            <>
              {closet}
              {wishlist}
            </>
          ))}
        {props.canEdit && <PhotoForms viewOwner={viewOwner} />}
      </div>
      <SheetBackdrop label={t('CLOSE')} />
    </dialog>
  );
}

function AddGroup(props: { title: string; children: Child }) {
  return (
    <section>
      <h3 class="text-sm text-muted mb-1">{props.title}</h3>
      <ul class="menu w-full p-0">{props.children}</ul>
    </section>
  );
}

/**
 * The sheet's camera or library row: its file input's label, joined to its
 * own form (PhotoForms) through the `form` attribute, since a form inside
 * a daisyUI menu item loses the item's styling. Choosing a photo prepares
 * it on the phone and submits (PREPARE_AND_SUBMIT_PHOTO). The camera has
 * an input of its own, as on the garment page's photo sheet: some
 * Chrome/Android versions drop the Camera option from a library input's
 * chooser. The library takes several photos at once (#200): each is
 * prepared, and two or more become a batch of drafts (stagePhotoUploads).
 * `relative`: the sr-only input must not escape the sheet (Gotchas).
 * Disabled offline (data-needs-network on the row).
 */
function PhotoItem(props: { source: 'camera' | 'library' }) {
  const camera = props.source === 'camera';
  const Icon = camera ? CameraIcon : PhotoLibraryIcon;
  return (
    <li data-needs-network="">
      <label class="relative py-3 gap-3" data-photo-source={props.source}>
        <Icon class="size-5" />
        {t(camera ? 'garment.PHOTO_CAMERA' : 'garment.PHOTO_LIBRARY')}
        <input
          type="file"
          name="photo"
          form={photoFormId(props.source)}
          accept={PHOTO_ACCEPT}
          capture={camera ? 'environment' : undefined}
          multiple={!camera}
          class="sr-only"
          onchange={PREPARE_AND_SUBMIT_PHOTO}
        />
      </label>
    </li>
  );
}

function photoFormId(source: 'camera' | 'library'): string {
  return `add-photo-${source}`;
}

/**
 * The camera's and the library's forms, one each so an empty input never
 * posts beside the chosen one: native multipart posts (PostForm) to POST
 * /wardrobe/new/photo, answered with a 303 to the new garment form holding
 * the photo. "Uploading…" shows while one is submitting (submit-once marks
 * it `data-submitting`; the sheet is the `group`).
 */
function PhotoForms(props: { viewOwner: number | undefined }) {
  const action = wardrobeUrl(props.viewOwner, {}, PHOTO_ADD_PATH);
  return (
    <>
      <PostForm id={photoFormId('camera')} action={action} multipart />
      <PostForm id={photoFormId('library')} action={action} multipart />
      <p
        class="hidden items-center gap-2 text-sm group-has-[form[data-submitting]]:flex"
        role="status"
      >
        <span class="loading loading-spinner loading-sm"></span>
        {t('garment.PHOTO_UPLOADING')}
      </p>
    </>
  );
}

/** A row of the sheet: 44 px or more to tap, its icon before its words. */
function AddItem(props: { href: string; icon: string; children: Child }) {
  return (
    <li>
      <a href={props.href} class="py-3 gap-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          class="size-5"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d={props.icon} />
        </svg>
        {props.children}
      </a>
    </li>
  );
}

// The sheet's icons (Heroicons outline paths): a link, a pencil, a stack.
const LINK_ICON =
  'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244';
const PENCIL_ICON =
  'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10';
const CAPSULE_ICON =
  'M6.429 9.75 2.25 12l4.179 2.25m0-4.5 5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0 4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0-5.571 3-5.571-3';

/**
 * The Wardrobe's tabs, underlined: plain boosted links, so the dock keeps
 * its size (plan section 2). All carry `?ownerId=` in a shared wardrobe,
 * so a grantee moves between the grantor's closet, capsules and wishlist;
 * Laundry, the requester's own, is left out there.
 */
export function WardrobeTabs(props: {
  active: WardrobeTab;
  viewOwner: number | undefined;
}) {
  const { viewOwner } = props;
  const tab = (name: WardrobeTab, label: string) => ({
    name,
    href: tabUrl(name, viewOwner),
    label,
  });
  return (
    <LinkTabs
      active={props.active}
      class="tabs tabs-border px-2"
      id="wardrobe-tabs"
      tabs={[
        tab('closet', t('CLOSET')),
        tab('capsules', t('CAPSULES')),
        viewOwner === undefined && tab('laundry', t('wear.LAUNDRY')),
        tab('wishlist', t('wishlist.TAB')),
      ]}
    />
  );
}

function PlusIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="2"
      stroke="currentColor"
      class="size-5"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 4.5v15m7.5-7.5h-15"
      />
    </svg>
  );
}
