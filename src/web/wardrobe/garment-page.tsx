import type { Child } from 'hono/jsx';
import { showsCutout } from '../../cutout/state';
import { garmentMarks } from '../../wardrobe/marks';
import { PostForm } from '../auth/form';
import { GarmentCapsules } from '../capsules/garment-capsules';
import type { GarmentCapsule } from '../capsules/queries';
import { DayTime } from '../day-time';
import { imageUrl } from '../files/image-url';
import {
  enlargeLabel,
  PhotoSet,
  viewerTrigger,
  type ViewerPhoto,
} from '../files/photo-viewer';
import { AvoidedPartners } from '../gallery/avoided';
import { GoesWithSection } from '../gallery/goes-with';
import type { GoesWithCloset } from '../gallery/ideas';
import type { AvoidedPartner } from '../gallery/queries';
import { AgentBadge } from '../agent-badge';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { GarmentMark } from '../layout/garment-mark';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import {
  CameraIcon,
  GarmentSilhouette,
  PHOTO_ACCEPT,
  PhotoLibraryIcon,
  PREPARE_AND_SUBMIT_PHOTO,
  SavedToast,
  SheetBackdrop,
  StripFlags,
} from '../layout/parts';
import { GarmentOutfitsStrip } from '../outfits/garment-outfits';
import type { GarmentOutfits } from '../outfits/queries';
import {
  type PublicShare,
  PublicSharePanel,
  ShareLinkButton,
} from '../share/share-button';
import { StyleThisLink } from '../styling/style-this';
import type { ViewContext } from '../view-context';
import {
  type WearPanel,
  WearSection,
  WhereaboutsSection,
} from '../wears/wear-section';
import type { SuggestionContext } from '../wishlist/inbox';
import type { AgentLabel } from '../write-origin';
import type { GarmentRef } from '../wishlist/queries';
import type { DecisionToast } from '../wishlist/suggestion-parts';
import { SuggestionSection } from '../wishlist/suggestion-section';
import type { BrandSize } from '../sizes/queries';
import { BrandSizeNote } from '../sizes/views';
import { categoryLabel, priceLabel } from './garment';
import { GarmentCondition } from './garment-condition';
import { RepairLogSection } from './repair-log';
import type { RepairLog } from './repairs';
import { fabricWeightLabel, valueLabel } from './labels';
import type { GarmentDetail } from './queries';
import {
  destinationParams,
  garmentUrl,
  needUrl,
  wardrobeUrl,
  WISHLIST_PATH,
} from './urls';

export interface GarmentPageModel {
  garment: GarmentDetail;
  /** The wardrobe's capsules, and whether the garment is in each. */
  capsules: GarmentCapsule[];
  /** The shared wardrobe it is in; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** Wears, washes and away: the owner's alone, never a grantee's. */
  wear: WearPanel | undefined;
  /** The garment this one replaces (a wishlist item's, or a bought one's). */
  replaces: GarmentRef | undefined;
  /** Wishlist items that would replace this closet garment. */
  replacedBy: { id: number; name: string | null; category: string }[];
  /**
   * The outfit gallery's side of the garment (#9): "Style this" for a
   * closet garment (anyone's who sees it: Styling browses a shared
   * wardrobe), and the garments it is never paired with (the owner's).
   */
  styling: { canStyle: boolean; avoided: AvoidedPartner[] };
  /**
   * "Goes with my closet" (#18b): a wishlist item against the closet, the
   * owner's alone. Undefined for a grantee and for anything not on the
   * wishlist.
   */
  goesWith: GoesWithCloset | undefined;
  /**
   * The owner's size in a wishlist item's brand (#24), under the facts.
   * Undefined for a grantee and for anything not on the wishlist.
   */
  brandSize: BrandSize | undefined;
  /**
   * "In N outfits" (#84): the owner's outfits that hold it, private like
   * outfits. Undefined for a grantee and for a wishlist item.
   */
  outfits: GarmentOutfits | undefined;
  /**
   * The repair and alteration log (#23), the owner's own record like the
   * wears. Undefined for a grantee and for a wishlist item.
   */
  repairs: RepairLog | undefined;
  /** Edit, photo, mask, condition and "Bought it": the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** Archive, restore and delete: the owner only. */
  canDelete: boolean;
  justCreated: boolean;
  justSavedPhoto: boolean;
  /** A rotate landed here: the photo sheet opens again for the next turn. */
  justRotatedPhoto: boolean;
  justBought: boolean;
  justLoggedRepair: boolean;
  /** "Add a copy" from a new garment's form (#20) landed here. */
  justAddedCopy: boolean;
  /**
   * Muse's suggestion (#333): its note, its need and where it stands
   * (SuggestionSection); undefined for any other garment.
   */
  suggestion: SuggestionContext | undefined;
  /** The agent that made it over MCP, as the viewer may see it (#822). */
  agent: AgentLabel | null;
  /** A Muse decision made on this page landed here: its toast. */
  decided: DecisionToast | undefined;
}

type GarmentPhoto = NonNullable<GarmentDetail['photo']>;

const PHOTO_SHEET_ID = 'garment-photo-sheet';

/** Opens the photo sheet (the ⋯ menu's Photo, the empty hero's button). */
const OPEN_PHOTO_SHEET = `this.closest('details')?.removeAttribute('open'); document.getElementById('${PHOTO_SHEET_ID}').showModal()`;

/**
 * Opens the photo sheet as the page loads, after a rotate (?photoRotated=1),
 * so repeated quarter turns are one tap each. A fixed string, placed after
 * the dialog; StripFlags drops the marker, so a reload does not reopen it.
 */
const REOPEN_PHOTO_SHEET = `document.getElementById('${PHOTO_SHEET_ID}').showModal();`;

/**
 * The mask editor's pencil (mask-editor.js), as an inline module so it runs
 * again after a boosted navigation back here (a fixed string): delegated on
 * #garment-photo-slot, because the cutout polling swaps the pencil.
 */
const MASK_SCRIPT = `import { wireUpEditMask } from 'mask-editor';
wireUpEditMask(document.getElementById('garment-photo-slot'));`;

/** The one-shot flags the garment page's toasts read (GarmentPageQuery). */
const GARMENT_PAGE_FLAGS = [
  'created',
  'photoSaved',
  'photoRotated',
  'bought',
  'repairSaved',
  'copyAdded',
  'decided',
] as const;

/**
 * GET /wardrobe/:id (redesign plan, "Garment page"; #84): the hero, the
 * facts, the wear line with the primary actions, the property chips, the
 * capsules row, "In N outfits", then the details and care; "Shared
 * publicly" under the summary while it has a public link. Everything
 * else (edit, photo, clone, share, archive, delete) is in the app bar's ⋯
 * menu; the photo is taken or chosen in a sheet.
 */
export function GarmentPage(props: {
  ctx: ViewContext;
  model: GarmentPageModel;
}) {
  const { ctx, model } = props;
  const { garment } = model;
  const title = garment.name ?? categoryLabel(garment.category);
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar
        ctx={ctx}
        title={title}
        back={backUrl(garment, model.viewOwner)}
        actions={<GarmentMenu ctx={ctx} model={model} />}
      />
      <PageMain class="flex flex-col gap-6 px-4 pt-20 pb-24">
        <div id="garment-photo-slot">
          <GarmentPhotoView
            garment={garment}
            viewOwner={model.viewOwner}
            canEdit={model.canEdit}
          />
        </div>
        <Summary model={model} />
        {model.canEdit && (
          <PublicSharePanel
            siteUrl={ctx.siteUrl}
            share={publicShareOf(model)}
          />
        )}
        {model.suggestion && (
          <SuggestionSection
            garment={garment}
            suggestion={model.suggestion}
            isOwner={model.canDelete}
            canEdit={model.canEdit}
            viewOwner={model.viewOwner}
          />
        )}
        <Replacement model={model} />
        {/* A wishlist item is not in the closet: it has no condition, wears,
            capsules or outfits until "Bought it" (the route reads none);
            what it has is how it would go with the closet. */}
        <GoesWithSection goesWith={model.goesWith} />
        {garment.status !== 'wishlist' && (
          <GarmentCapsules
            garmentId={garment.id}
            capsules={model.capsules}
            viewOwner={model.viewOwner}
            canEdit={model.canEdit}
          />
        )}
        {model.outfits && <GarmentOutfitsStrip outfits={model.outfits} />}
        <AvoidedPartners
          garmentId={garment.id}
          partners={model.styling.avoided}
        />
        <GarmentDetails garment={garment} />
        <Care model={model} />
      </PageMain>
      <PhotoTools model={model} />
      <Toasts model={model} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * Under the hero: where it is when not in the closet, the facts, the wear
 * line with the primary actions (the owner's; anyone else's actions
 * alone), and the property chips.
 */
function Summary({ model }: { model: GarmentPageModel }) {
  const { garment } = model;
  return (
    <section class="flex flex-col gap-4" aria-label={t('garment.SUMMARY')}>
      <div class="flex flex-col gap-2">
        <StatusMark model={model} />
        {model.agent && (
          <p>
            <AgentBadge
              agent={model.agent}
              byMuse={model.garment.suggestedAt !== null}
            />
          </p>
        )}
        <FactsLine garment={garment} />
        <BrandSizeNote note={model.brandSize} />
      </div>
      {model.wear ? (
        <WearSection garment={garment} panel={model.wear} />
      ) : (
        <PrimaryActions model={model} />
      )}
      <PropertyChips garment={garment} />
    </section>
  );
}

/**
 * The care label (anyone's who sees the garment: a garment property), then
 * for an owned garment the condition, and the owner's "Where it is" and
 * repair log.
 */
function Care({ model }: { model: GarmentPageModel }) {
  const { garment } = model;
  return (
    <>
      <CareLabelSection garment={garment} />
      {garment.status !== 'wishlist' && (
        <GarmentCondition
          garment={garment}
          viewOwner={model.viewOwner}
          canEdit={model.canEdit}
        />
      )}
      {model.wear && <WhereaboutsSection garment={garment} />}
      {model.repairs && (
        <RepairLogSection garmentId={garment.id} log={model.repairs} />
      )}
    </>
  );
}

/**
 * The care label (#23): each instruction the label gives, in the label's
 * order, and the free-text care notes; nothing when neither is set.
 */
function CareLabelSection({ garment }: { garment: GarmentDetail }) {
  const instructions = (
    [
      ['careWash', garment.careWash],
      ['careBleach', garment.careBleach],
      ['careDry', garment.careDry],
      ['careIron', garment.careIron],
      ['careDryClean', garment.careDryClean],
    ] as const
  ).flatMap(([property, value]) =>
    value === null ? [] : [valueLabel(property, value)],
  );
  if (instructions.length === 0 && !garment.washingDetails) return null;
  return (
    <section id="garment-care" aria-labelledby="garment-care-title">
      <h2 id="garment-care-title" class="text-sm text-muted mb-2">
        {t('care.LABEL')}
      </h2>
      {instructions.length > 0 && (
        <ul class="flex flex-wrap gap-2">
          {instructions.map((instruction) => (
            <li class="badge badge-outline">{instruction}</li>
          ))}
        </ul>
      )}
      {garment.washingDetails && (
        <p class="whitespace-pre-line text-sm mt-2">{garment.washingDetails}</p>
      )}
    </section>
  );
}

/**
 * For whoever may change the photo: the photo sheet, and with a photo the
 * mask editor and the module that wires its pencil.
 */
function PhotoTools({ model }: { model: GarmentPageModel }) {
  if (!model.canEdit) return null;
  const { garment } = model;
  return (
    <>
      <PhotoSheet garment={garment} viewOwner={model.viewOwner} />
      {model.justRotatedPhoto && (
        <script dangerouslySetInnerHTML={{ __html: REOPEN_PHOTO_SHEET }} />
      )}
      {garment.photo && (
        <>
          <MaskEditorDialog />
          <script
            type="module"
            dangerouslySetInnerHTML={{ __html: MASK_SCRIPT }}
          />
        </>
      )}
    </>
  );
}

/** The one-shot toasts after a create, a photo, "Bought it" or a logged repair. */
function Toasts({ model }: { model: GarmentPageModel }) {
  return (
    <>
      {model.justCreated && (
        <SavedToast id="garment-saved-toast" text={t('GARMENT_SAVED')} />
      )}
      {model.justSavedPhoto && (
        <SavedToast id="photo-saved-toast" text={t('PHOTO_SAVED')} />
      )}
      {model.justBought && (
        <SavedToast id="bought-toast" text={t('wishlist.BOUGHT_TOAST')} />
      )}
      {model.justLoggedRepair && (
        <SavedToast id="repair-saved-toast" text={t('care.REPAIR_SAVED')} />
      )}
      {model.justAddedCopy && (
        <SavedToast id="copy-added-toast" text={t('lookalikes.COPY_ADDED')} />
      )}
      {model.decided && (
        <SavedToast
          id="decision-toast"
          text={t(`muse.toast.${model.decided}`)}
        />
      )}
      <StripFlags names={GARMENT_PAGE_FLAGS} />
    </>
  );
}

/**
 * The back arrow: to its need's decision screen for a Muse pick on the
 * wishlist, to the wishlist for any other wishlist item, else the grid.
 */
function backUrl(garment: GarmentDetail, viewOwner: number | undefined) {
  if (garment.status === 'wishlist' && garment.suggestionGroupId !== null) {
    return needUrl(garment.suggestionGroupId, viewOwner);
  }
  return wardrobeUrl(
    viewOwner,
    {},
    garment.status === 'wishlist' ? WISHLIST_PATH : '/wardrobe',
  );
}

/**
 * Where the garment is when it is not the closet: to buy, or archived.
 * Status only: the owner's away and wash state are the wear section's,
 * just below.
 */
function StatusMark({ model }: { model: GarmentPageModel }) {
  const marks = garmentMarks(
    { status: model.garment.status },
    { ownerView: model.wear !== undefined },
  );
  if (marks.length === 0) return null;
  // A block of its own, so the column's stretch never widens the badge.
  return (
    <p>
      <GarmentMark marks={marks} />
    </p>
  );
}

/**
 * The facts line: "Red Wing · Boots · Iron Ranger · 9 · 3 identical", what
 * is set of the brand, the category and type, the size and the copies.
 */
function FactsLine({ garment }: { garment: GarmentDetail }) {
  const facts: Child[] = [
    garment.brand,
    // capitalize is for a custom category stored lower case; a type's
    // label is already written as it should read.
    <span class="capitalize">{categoryLabel(garment.category)}</span>,
    garment.type && valueLabel('type', garment.type),
    garment.size,
    garment.quantity > 1 && t('QUANTITY_VALUE', { quantity: garment.quantity }),
  ].filter(Boolean);
  return (
    <p class="text-muted">
      {facts.map((fact, index) => (
        <>
          {index > 0 && ' · '}
          {fact}
        </>
      ))}
    </p>
  );
}

/**
 * The primary actions for whoever has no wear line (the owner's own is in
 * WearSection, with Wore today and Washed): "Style this" on a closet
 * garment, "Bought it" on a wishlist item for the owner and a MANAGE
 * grantee. Nothing when neither applies.
 */
function PrimaryActions({ model }: { model: GarmentPageModel }) {
  const { garment, viewOwner } = model;
  // The owner decides on a Muse pick in its own section, Bought it among them.
  const buy =
    model.canEdit &&
    garment.status === 'wishlist' &&
    !(model.canDelete && model.suggestion);
  if (!model.styling.canStyle && !buy) return null;
  return (
    <div class="flex flex-wrap gap-2">
      {model.styling.canStyle && (
        <StyleThisLink garmentId={garment.id} viewOwner={viewOwner} />
      )}
      {buy && (
        <a
          href={garmentUrl(garment.id, viewOwner, '/bought')}
          class="btn btn-primary flex-1"
        >
          {t('wishlist.BOUGHT_IT')}
        </a>
      )}
    </div>
  );
}

/** The garment's public link and where Share and Stop post (#669). */
function publicShareOf(model: GarmentPageModel): PublicShare {
  const { garment, viewOwner } = model;
  return {
    type: 'garment',
    shareableId: garment.shareableId,
    shareUrl: garmentUrl(garment.id, viewOwner, '/share'),
    stopUrl: garmentUrl(garment.id, viewOwner, '/share/stop'),
  };
}

/**
 * The ⋯ menu in the app bar: what the requester may do, and nothing else.
 * Edit, the photo sheet and Share for the owner and a MANAGE grantee;
 * Clone for anyone who can see the garment (the copy lands in their own
 * wardrobe); archive or restore, and delete, for the owner
 * (OwnerMenuItems). Buttons and links only: a form inside a daisyUI
 * menu item loses its styling.
 */
function GarmentMenu({
  ctx,
  model,
}: {
  ctx: ViewContext;
  model: GarmentPageModel;
}) {
  const { garment, viewOwner } = model;
  return (
    <details class="dropdown dropdown-end" id="garment-menu">
      <summary
        class="btn btn-ghost btn-circle text-xl"
        aria-label={t('MORE_ACTIONS')}
      >
        ⋯
      </summary>
      <ul class="menu dropdown-content bg-base-100 rounded-box shadow-lg z-20 w-56 p-2">
        {model.canEdit && (
          <li>
            <a href={garmentUrl(garment.id, viewOwner, '/edit')}>
              {t('garment.EDIT')}
            </a>
          </li>
        )}
        {model.canEdit && (
          <li>
            <button type="button" onclick={OPEN_PHOTO_SHEET}>
              {photoActionLabel(garment)}
            </button>
          </li>
        )}
        <li>
          <a href={garmentUrl(garment.id, viewOwner, '/clone')}>
            {t('garment.CLONE')}
          </a>
        </li>
        {model.canEdit && (
          <li>
            <ShareLinkButton
              siteUrl={ctx.siteUrl}
              share={publicShareOf(model)}
              variant="menu"
            />
          </li>
        )}
        {model.canDelete && <OwnerMenuItems model={model} />}
      </ul>
    </details>
  );
}

/**
 * The owner's items of the ⋯ menu: archive (a closet garment) or restore
 * (an archived one), and delete (a wishlist item's is "Remove from
 * wishlist": it has no history to keep). A Muse pick on the wishlist is
 * never deleted (it is Muse's feedback: Not for me sets it aside), and a
 * bought one may be Returned (archived, its need open again; #333).
 */
function OwnerMenuItems({ model }: { model: GarmentPageModel }) {
  const { garment, viewOwner } = model;
  const wishlist = garment.status === 'wishlist';
  const suggestion = garment.suggestedAt !== null;
  return (
    <>
      {garment.status === 'closet' && (
        <li>
          <button
            type="button"
            hx-post={garmentUrl(garment.id, viewOwner, '/archive')}
            hx-confirm={t('CONFIRM_ARCHIVE')}
          >
            {t('ARCHIVE')}
          </button>
        </li>
      )}
      {garment.status === 'closet' && suggestion && (
        <li>
          <button
            type="button"
            hx-post={garmentUrl(garment.id, viewOwner, '/returned')}
            hx-confirm={t('muse.CONFIRM_RETURNED')}
          >
            {t('muse.RETURNED_IT')}
          </button>
        </li>
      )}
      {garment.status === 'archived' && (
        <li>
          <button
            type="button"
            hx-post={garmentUrl(garment.id, viewOwner, '/restore')}
            hx-confirm={t('CONFIRM_RESTORE')}
          >
            {t('RESTORE')}
          </button>
        </li>
      )}
      {!(wishlist && suggestion) && (
        <li>
          <button
            type="button"
            class="text-error"
            hx-delete={garmentUrl(garment.id, viewOwner)}
            hx-confirm={t(
              wishlist ? 'wishlist.CONFIRM_REMOVE' : 'CONFIRM_DELETE',
            )}
          >
            {t(wishlist ? 'wishlist.REMOVE' : 'DELETE')}
          </button>
        </li>
      )}
    </>
  );
}

// The pending photo's poll (#689): every 2 s for its first 30 s (a cutout
// takes 4 to 7 s), then every 10 s. Past 2 min it stops only while the
// queue waits for a model it cannot have: that photo finishes later, and an
// open page must not poll it forever; a working queue that is merely busy
// (a bulk upload) keeps the 10 s poll, so its cutout still lands on the
// page. Counted in polls, which the URL carries (`poll`), so the server
// needs no clock and no per-page state; a reload starts over.
const FAST_POLL_SECONDS = 2;
const FAST_PHASE_SECONDS = 30;
const SLOW_POLL_SECONDS = 10;
const POLL_CAP_SECONDS = 120;
const FAST_POLLS = FAST_PHASE_SECONDS / FAST_POLL_SECONDS;
const MAX_POLL_COUNT = 1000;

/**
 * The `poll` query as a count: anything but digits is 0 (a poll the page
 * never wrote starts the backoff over), and a count past the point where
 * every delay is the same is clamped, so an endless poll never outgrows it.
 */
export function pollCount(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), MAX_POLL_COUNT);
}

/**
 * The seconds until poll number `poll + 1`, or undefined once the polls so
 * far have waited POLL_CAP_SECONDS while `modelUnavailable` (the queue is
 * waiting-for-model): the fragment then stops polling.
 */
export function cutoutPollDelay(
  poll: number,
  modelUnavailable: boolean,
): number | undefined {
  const waited =
    poll <= FAST_POLLS
      ? poll * FAST_POLL_SECONDS
      : FAST_PHASE_SECONDS + (poll - FAST_POLLS) * SLOW_POLL_SECONDS;
  if (waited < FAST_PHASE_SECONDS) return FAST_POLL_SECONDS;
  if (waited >= POLL_CAP_SECONDS && modelUnavailable) return undefined;
  return SLOW_POLL_SECONDS;
}

/**
 * The hero: the cutout (the original when there is none), contained on the
 * plinth at 4:5, with the mask editor's pencil, and where the cutout
 * stands: pending polls GET /wardrobe/:id/cutout?poll=N on the backoff of
 * cutoutPollDelay (this component again, swapped over itself; the answer
 * without the trigger ends the polling: ready, failed, or the cap while
 * the model is unavailable, which says it will finish later), failed offers
 * "Try again". Its own
 * hx-indicator keeps the polls off the app bar's spinner. Without a photo,
 * its role's silhouette, and for whoever may add one the button that opens
 * the photo sheet. `poll`: how many polls led here (0 on the page itself);
 * `modelUnavailable`: the queue's state, read by the poll's route only.
 */
export function GarmentPhotoView(props: {
  garment: GarmentDetail;
  viewOwner: number | undefined;
  canEdit: boolean;
  poll?: number;
  modelUnavailable?: boolean;
}) {
  const { garment, viewOwner, canEdit } = props;
  const photo = garment.photo;
  if (!photo) {
    return (
      <div
        id="garment-photo"
        class="rounded-box bg-base-200 aspect-[4/5] w-full flex flex-col items-center justify-center gap-4 text-faint"
      >
        <GarmentSilhouette
          category={garment.category}
          class="size-20"
          strokeWidth="1"
        />
        {canEdit && (
          <button
            type="button"
            class="btn btn-outline btn-sm"
            onclick={OPEN_PHOTO_SHEET}
          >
            <CameraIcon class="size-4" />
            {t('garment.ADD_PHOTO')}
          </button>
        )}
      </div>
    );
  }
  const status = photo.cutoutStatus;
  const pending = status === 'pending';
  const polling = pending ? nextPoll(props) : undefined;
  return (
    <div id="garment-photo" {...polling}>
      <figure class="relative rounded-box overflow-hidden bg-base-200 aspect-[4/5] w-full">
        {/* The viewer swipes from the cutout to the photo it was cut from. */}
        <PhotoSet id="garment-photos" photos={viewerPhotos(garment, photo)} />
        <button
          type="button"
          class="size-full"
          aria-label={enlargeLabel(garment.name)}
          {...viewerTrigger('garment-photos', photo, viewerVariant(photo))}
        >
          <img
            src={imageUrl(photo, 'nobg')}
            alt={garment.name ?? ''}
            class="object-contain w-full h-full"
          />
        </button>
        {pending && <PendingStatus polling={polling !== undefined} />}
        {canEdit && !pending && (
          <EditMaskButton
            garment={garment}
            photo={photo}
            viewOwner={viewOwner}
          />
        )}
      </figure>
      {status === 'failed' && (
        <CutoutFailed
          retryUrl={
            canEdit
              ? garmentUrl(garment.id, viewOwner, '/cutout/retry')
              : undefined
          }
        />
      )}
    </div>
  );
}

// The pending photo's next poll, or undefined past the cap.
function nextPoll(props: {
  garment: GarmentDetail;
  viewOwner: number | undefined;
  poll?: number;
  modelUnavailable?: boolean;
}) {
  const poll = props.poll ?? 0;
  const delay = cutoutPollDelay(poll, props.modelUnavailable === true);
  if (delay === undefined) return undefined;
  return {
    'hx-get': garmentUrl(props.garment.id, props.viewOwner, '/cutout', {
      poll: poll + 1,
    }),
    'hx-trigger': `every ${delay}s`,
    'hx-swap': 'outerHTML',
    'hx-indicator': '#garment-photo-status',
  };
}

/**
 * A pending cutout's line over the photo: removing, while the page polls;
 * past the poll's cap, queued for later, without the spinner.
 */
function PendingStatus(props: { polling: boolean }) {
  return (
    <div
      id="garment-photo-status"
      role="status"
      class="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-base-100/80 p-2 text-sm"
    >
      {props.polling ? (
        <>
          <span class="loading loading-spinner loading-xs"></span>
          {t('REMOVING_BACKGROUND')}
        </>
      ) : (
        t('CUTOUT_QUEUED')
      )}
    </div>
  );
}

/** A failed cutout, and "Try again" for whoever may change the photo. */
function CutoutFailed(props: { retryUrl: string | undefined }) {
  return (
    <div
      role="alert"
      class="alert alert-warning alert-soft mt-2 w-full flex justify-between"
    >
      <span>{t('CUTOUT_FAILED')}</span>
      {props.retryUrl && (
        <PostForm action={props.retryUrl}>
          <button type="submit" class="btn btn-sm">
            {t('CUTOUT_RETRY')}
          </button>
        </PostForm>
      )}
    </div>
  );
}

/**
 * The pencil: mask-editor.js reads what it edits and where it saves from
 * the data attributes at the tap (the button is swapped with the photo),
 * and writes the new version back into them after a save.
 */
/** The photo viewer opens on the cutout while one is shown, else on the photo itself. */
function viewerVariant(photo: GarmentPhoto): 'nobg' | 'original' {
  return showsCutout(photo.cutoutStatus) ? 'nobg' : 'original';
}

function viewerPhotos(garment: GarmentDetail, photo: GarmentPhoto) {
  const alt = garment.name ?? '';
  const original: ViewerPhoto = { photo, alt, variant: 'original' };
  return showsCutout(photo.cutoutStatus)
    ? [{ photo, alt } satisfies ViewerPhoto, original]
    : [original];
}

function EditMaskButton(props: {
  garment: GarmentDetail;
  photo: GarmentPhoto;
  viewOwner: number | undefined;
}) {
  return (
    <button
      id="editMaskBtn"
      type="button"
      class="btn btn-circle absolute bottom-3 right-3 btn-neutral opacity-80 hover:opacity-100"
      title={t('MASK_EDITOR_TITLE')}
      aria-label={t('MASK_EDITOR_TITLE')}
      data-original-url={imageUrl(props.photo, 'original')}
      data-nobg-url={imageUrl(props.photo, 'nobg')}
      data-save-url={garmentUrl(props.garment.id, props.viewOwner, '/nobg')}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        class="size-5"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
        />
      </svg>
    </button>
  );
}

/**
 * The set properties as one row of chips ("Warmth: Light · Casual · 6 oz ·
 * 203 gsm · Cotton · Short sleeve"); nothing when none is set.
 */
function PropertyChips({ garment }: { garment: GarmentDetail }) {
  const words = (
    [
      ['formality', garment.formality],
      ['pattern', garment.pattern],
      ['fit', garment.fit],
      ['sleeve', garment.sleeve],
      ['length', garment.length],
    ] as const
  ).flatMap(([property, value]) =>
    value === null ? [] : [valueLabel(property, value)],
  );
  const chips = [
    ...(garment.warmth === null
      ? []
      : [`${t('PROPERTY_WARMTH')}: ${valueLabel('warmth', garment.warmth)}`]),
    ...words,
    ...(garment.fabricWeight === null
      ? []
      : [fabricWeightLabel(garment.fabricWeight)]),
    ...(garment.materials ?? []).map((material) =>
      valueLabel('materials', material),
    ),
    ...(garment.waterResistant ? [t('WATER_RESISTANT_YES')] : []),
  ];
  if (chips.length === 0) return null;
  return (
    <ul class="flex flex-wrap gap-2" aria-label={t('MORE_DETAILS')}>
      {chips.map((chip) => (
        <li class="badge badge-outline">{chip}</li>
      ))}
    </ul>
  );
}

/**
 * The rest, a plain list: what the facts line leaves out (colours, price,
 * when it was acquired, notes) and the product link. Nothing when none is
 * set. The care notes are the care label's (CareLabelSection).
 */
function GarmentDetails({ garment }: { garment: GarmentDetail }) {
  const rows = [
    garment.colors && (
      <Detail label={t('COLOR')}>
        <span class="capitalize">{garment.colors.join(', ')}</span>
      </Detail>
    ),
    garment.price && (
      <Detail label={t('PRICE')}>{priceLabel(garment.price)}</Detail>
    ),
    garment.acquiredOn && (
      <Detail label={t('DATE_ACQUIRED')}>
        <DayTime day={garment.acquiredOn} kind="date" />
      </Detail>
    ),
    garment.notes && (
      <Detail label={t('NOTES')} block>
        <p class="whitespace-pre-line">{garment.notes}</p>
      </Detail>
    ),
  ].filter(Boolean);
  if (rows.length === 0 && !garment.sourceUrl) return null;
  return (
    <section aria-labelledby="garment-details-title">
      <h2 id="garment-details-title" class="text-sm text-muted mb-2">
        {t('garment.DETAILS')}
      </h2>
      <dl class="flex flex-col divide-y divide-base-300 text-sm">{rows}</dl>
      {garment.sourceUrl && (
        // Only ever http(s) (readSourceUrl, and the column's check). A new
        // tab, so the app stays where it was; noopener keeps the shop's page
        // from reaching back into this one, noreferrer from learning its URL.
        <a
          href={garment.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="link link-primary text-sm inline-block mt-2"
        >
          {t('VIEW_PRODUCT')}
        </a>
      )}
    </section>
  );
}

function Detail(props: { label: string; block?: boolean; children: Child }) {
  return (
    <div
      class={
        props.block
          ? 'flex flex-col gap-1 py-2'
          : 'flex justify-between gap-4 py-2'
      }
    >
      <dt class="text-muted">{props.label}</dt>
      <dd class={props.block ? '' : 'text-right'}>{props.children}</dd>
    </div>
  );
}

/**
 * The replacement links: what this garment replaces, the wishlist items that
 * would replace it, and on a garment marked "replace soon", for whoever may
 * add to the wishlist, "Find a replacement" (the wishlist's new form,
 * prefilled from this garment).
 */
function Replacement({ model }: { model: GarmentPageModel }) {
  const { garment, viewOwner, replaces, replacedBy } = model;
  const findable =
    model.canEdit &&
    garment.status === 'closet' &&
    garment.condition === 'replace_soon';
  if (!replaces && replacedBy.length === 0 && !findable) return null;
  const link = (ref: { id: number; name: string | null; category: string }) => (
    <a href={garmentUrl(ref.id, viewOwner)} class="link link-primary">
      {ref.name ?? categoryLabel(ref.category)}
    </a>
  );
  return (
    <section
      id="garment-replacement"
      class="flex flex-col gap-2 text-sm"
      aria-label={t('wishlist.REPLACEMENT')}
    >
      {replaces && (
        <p>
          {t('wishlist.REPLACEMENT_FOR')} {link(replaces)}
        </p>
      )}
      {replacedBy.length > 0 && (
        <p>
          {t('wishlist.ON_WISHLIST_TO_REPLACE')}{' '}
          {replacedBy.map((item, index) => (
            <>
              {index > 0 && ', '}
              {link(item)}
            </>
          ))}
        </p>
      )}
      {findable && (
        <a
          href={wardrobeUrl(
            viewOwner,
            destinationParams({ to: 'wishlist', replaces: garment.id }),
            '/wardrobe/new',
          )}
          class="btn btn-sm btn-outline self-start"
        >
          {t('wishlist.FIND_REPLACEMENT')}
        </a>
      )}
    </section>
  );
}

/** The photo sheet's title and the menu item that opens it. */
function photoActionLabel(garment: GarmentDetail): string {
  return t(garment.photo ? 'garment.CHANGE_PHOTO' : 'garment.ADD_PHOTO');
}

/**
 * The photo sheet (the ⋯ menu's Photo): take one with the camera or choose
 * one from the library. Choosing uploads at once: the photo is prepared on
 * the phone (PREPARE_AND_SUBMIT_PHOTO), posted as a native multipart post
 * to POST /wardrobe/:id/photo, and its 303 reloads this page with
 * ?photoSaved=1, its cutout pending. Native, as the add sheet's and the
 * selfies': a refused photo (too large, not an image) is the error page,
 * where an htmx post dropped the 4xx and the sheet failed silently.
 * "Uploading…" shows while one is submitting (submit-once marks it
 * `data-submitting`; the two are the `upload` group, so the rotate form's
 * submit does not show it). With a photo, ↺ and ↻ too. The camera has an
 * input of its own: some Chrome/Android versions drop the Camera option
 * from the library input's chooser depending on its accept value
 * (upstream issue 99).
 */
function PhotoSheet(props: {
  garment: GarmentDetail;
  viewOwner: number | undefined;
}) {
  const action = garmentUrl(props.garment.id, props.viewOwner, '/photo');
  return (
    <dialog
      id={PHOTO_SHEET_ID}
      class="modal modal-bottom sm:modal-middle"
      aria-labelledby="garment-photo-sheet-title"
    >
      <div class="modal-box flex flex-col gap-3 pb-8">
        <h2 id="garment-photo-sheet-title" class="font-bold text-lg">
          {photoActionLabel(props.garment)}
        </h2>
        <p class="text-sm text-muted">{t('garment.PHOTO_HINT')}</p>
        <div class="group/upload flex flex-col gap-3">
          <PhotoSource action={action} source="camera" />
          <PhotoSource action={action} source="library" />
          <p
            class="hidden items-center gap-2 text-sm group-has-[form[data-submitting]]/upload:flex"
            role="status"
          >
            <span class="loading loading-spinner loading-sm"></span>
            {t('garment.PHOTO_UPLOADING')}
          </p>
        </div>
        {props.garment.photo && (
          <RotateButtons
            action={garmentUrl(
              props.garment.id,
              props.viewOwner,
              '/photo/rotate',
            )}
          />
        )}
        <div class="modal-action mt-0">
          <button
            type="button"
            class="btn btn-ghost"
            onclick="this.closest('dialog').close()"
          >
            {t('CANCEL')}
          </button>
        </div>
      </div>
      <SheetBackdrop label={t('CLOSE')} />
    </dialog>
  );
}

/**
 * One way in to the sheet: a button-styled label over its file input
 * (`relative`: the sr-only input must not escape the sheet, see Gotchas),
 * in a form of its own, so an empty input never posts beside the chosen
 * one. Disabled offline, like every PostForm.
 */
function PhotoSource(props: { action: string; source: 'camera' | 'library' }) {
  const camera = props.source === 'camera';
  const Icon = camera ? CameraIcon : PhotoLibraryIcon;
  return (
    <PostForm action={props.action} multipart>
      <label
        class="relative btn btn-outline w-full justify-start gap-3"
        data-photo-source={props.source}
      >
        <Icon class="size-5" />
        {t(camera ? 'garment.PHOTO_CAMERA' : 'garment.PHOTO_LIBRARY')}
        <input
          type="file"
          id={camera ? 'photoCaptureInput' : 'photoInput'}
          name="photo"
          accept={PHOTO_ACCEPT}
          capture={camera ? 'environment' : undefined}
          class="sr-only"
          onchange={PREPARE_AND_SUBMIT_PHOTO}
        />
      </label>
    </PostForm>
  );
}

/**
 * ↺ and ↻ (#199): one native post whose submitter names the direction
 * (submit-once disables the buttons a tick after the submit, so its
 * `direction` still posts), 303 back to the page with the turned photo
 * and this sheet open again (?photoRotated=1, REOPEN_PHOTO_SHEET).
 * "Rotating…" while it submits (submit-once's `data-submitting` on the
 * form, the `rotate` group). Disabled offline.
 */
function RotateButtons(props: { action: string }) {
  const turns = [
    { direction: 'left', glyph: '↺', label: t('garment.ROTATE_LEFT') },
    { direction: 'right', glyph: '↻', label: t('garment.ROTATE_RIGHT') },
  ] as const;
  return (
    <PostForm action={props.action} class="group/rotate flex flex-col gap-3">
      <div class="flex gap-3">
        {turns.map((turn) => (
          <button
            type="submit"
            name="direction"
            value={turn.direction}
            class="btn btn-outline flex-1 gap-2"
            data-rotate={turn.direction}
          >
            <span aria-hidden="true" class="text-lg leading-none">
              {turn.glyph}
            </span>
            {turn.label}
          </button>
        ))}
      </div>
      <p
        class="hidden items-center gap-2 text-sm group-data-submitting/rotate:flex"
        role="status"
      >
        <span class="loading loading-spinner loading-sm"></span>
        {t('garment.PHOTO_ROTATING')}
      </p>
    </PostForm>
  );
}

/** The mask editor (public/js/mask-editor.js), opened by the pencil on the photo. */
function MaskEditorDialog() {
  return (
    <dialog id="maskEditorDialog" class="modal">
      <div class="modal-box w-full max-w-lg p-4 flex flex-col gap-4">
        <h3 class="font-bold text-lg">{t('MASK_EDITOR_TITLE')}</h3>
        <div class="flex flex-wrap items-center gap-3">
          <div class="join">
            <button id="maskBrushErase" class="btn btn-sm join-item">
              {t('MASK_BRUSH_ERASE')}
            </button>
            <button id="maskBrushRestore" class="btn btn-sm join-item">
              {t('MASK_BRUSH_RESTORE')}
            </button>
          </div>
          <div class="flex items-center gap-2 flex-1 min-w-32">
            <span class="text-xs text-muted shrink-0">
              {t('MASK_BRUSH_SIZE')}
            </span>
            <input
              id="maskBrushSize"
              type="range"
              min="4"
              max="80"
              value="20"
              class="range range-xs flex-1"
            />
          </div>
        </div>
        <div class="overflow-auto rounded-box border border-base-300 bg-base-200">
          <canvas
            id="maskEditorCanvas"
            class="mask-checkerboard block max-w-full mx-auto cursor-crosshair"
          ></canvas>
        </div>
        <div class="modal-action mt-0">
          <button id="maskEditorSkip" class="btn btn-ghost btn-sm">
            {t('MASK_EDITOR_SKIP')}
          </button>
          <button id="maskEditorAccept" class="btn btn-primary btn-sm">
            {t('MASK_EDITOR_ACCEPT')}
          </button>
        </div>
      </div>
      <SheetBackdrop label={t('CLOSE')} />
    </dialog>
  );
}
