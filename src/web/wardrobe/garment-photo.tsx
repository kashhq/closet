import { showsCutout } from '../../cutout/state';
import { imageUrl } from '../files/image-url';
import {
  enlargeLabel,
  PhotoSet,
  viewerTrigger,
  type ViewerPhoto,
} from '../files/photo-viewer';
import { PostForm } from '../form';
import { t } from '../i18n';
import { CameraIcon, GarmentSilhouette } from '../layout/parts';
import { sheetOpener } from '../layout/sheet';
import type { GarmentDetail } from './queries';
import { garmentUrl } from './urls';

// A garment's photo and where its cutout stands (#84, #689), drawn in two
// places: the garment page's hero, with its editing tools, and the garment
// form's subject (#1069), the same photo and state without them. The cutout
// poll answers this view again (photo-routes.tsx, GET /wardrobe/:id/cutout),
// in the place its URL names.

/** What the view reads of a garment, its photo as shown (withShownPhoto). */
export type PhotoSubject = Pick<
  GarmentDetail,
  'id' | 'name' | 'category' | 'photo'
>;

type GarmentPhoto = NonNullable<GarmentDetail['photo']>;

/**
 * Where the view is drawn:
 *  - `page`: the garment page's hero; for an editor, Add a photo (the
 *    page's photo sheet), the mask editor's pencil and "Try again".
 *  - `form`: the garment form's subject, shown from lg only (FormPage
 *    `aside`): the photo and its cutout's state, no tools (the form has no
 *    photo sheet or mask editor, and a retry's post would leave what was
 *    typed). Its image loads lazily, so a phone, which never shows the
 *    subject, never fetches it. A pending cutout still polls there: htmx's
 *    trigger conditions need eval, which the CSP refuses, and an edit
 *    opened while a cutout is under way is rare and capped like the page.
 */
export type PhotoPlace = 'page' | 'form';

/**
 * The poll's `place` query as a place: anything but `form` is the page
 * (URL state is a fallback, never a 400; a page cached before the form had
 * a subject sends none).
 */
export function photoPlace(raw: string | undefined): PhotoPlace {
  return raw === 'form' ? 'form' : 'page';
}

/** The garment page's photo sheet, opened by the empty hero's button too. */
export const PHOTO_SHEET_ID = 'garment-photo-sheet';

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
function cutoutPollDelay(
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
 * The cutout (the original when there is none), contained on the plinth at
 * 4:5, and where the cutout stands: pending polls
 * GET /wardrobe/:id/cutout?poll=N on the backoff of cutoutPollDelay (this
 * component again, swapped over itself, in the same `place`; the answer
 * without the trigger ends the polling: ready, failed, or the cap while the
 * model is unavailable, which says it will finish later). Its own
 * hx-indicator keeps the polls off the app bar's spinner. Without a photo,
 * its role's silhouette. The page's tools (`canEdit`, `place` page): the
 * mask editor's pencil, "Try again" on a failed cutout, and the button that
 * opens the photo sheet on an empty hero. `poll`: how many polls led here
 * (0 on the page itself); `modelUnavailable`: the queue's state, read by
 * the poll's route only.
 */
export function GarmentPhotoView(props: {
  garment: PhotoSubject;
  viewOwner: number | undefined;
  /** May change the photo: the tools, where the place has them. */
  canEdit?: boolean;
  /** `page` unless given (PhotoPlace). */
  place?: PhotoPlace;
  poll?: number;
  modelUnavailable?: boolean;
}) {
  const { garment, viewOwner } = props;
  const { place, tools } = placed(props);
  const photo = garment.photo;
  if (!photo) {
    return <NoPhoto category={garment.category} tools={tools} />;
  }
  const status = photo.cutoutStatus;
  const pending = status === 'pending';
  const polling = pending ? nextPoll(props, place) : undefined;
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
            loading={IMAGE_LOADING[place]}
          />
        </button>
        {pending && <PendingStatus polling={polling !== undefined} />}
        {tools && !pending && (
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
            tools
              ? garmentUrl(garment.id, viewOwner, '/cutout/retry')
              : undefined
          }
        />
      )}
    </div>
  );
}

/** The view's place, and whether it draws the tools there. */
function placed(props: { canEdit?: boolean; place?: PhotoPlace }): {
  place: PhotoPlace;
  tools: boolean;
} {
  const place = props.place ?? 'page';
  return { place, tools: props.canEdit === true && place === 'page' };
}

/** The form's subject is never shown on a phone, so it never fetches there. */
const IMAGE_LOADING: Readonly<Record<PhotoPlace, 'lazy' | undefined>> = {
  page: undefined,
  form: 'lazy',
};

/** No photo: its role's silhouette, and with the tools Add a photo. */
function NoPhoto(props: { category: string; tools: boolean }) {
  return (
    <div
      id="garment-photo"
      class="rounded-box bg-base-200 aspect-[4/5] w-full flex flex-col items-center justify-center gap-4 text-faint"
    >
      <GarmentSilhouette
        category={props.category}
        class="size-20"
        strokeWidth="1"
      />
      {props.tools && (
        <button
          type="button"
          class="btn btn-outline btn-sm"
          {...sheetOpener(PHOTO_SHEET_ID)}
        >
          <CameraIcon class="size-4" />
          {t('garment.ADD_PHOTO')}
        </button>
      )}
    </div>
  );
}

// The pending photo's next poll, or undefined past the cap.
function nextPoll(
  props: {
    garment: PhotoSubject;
    viewOwner: number | undefined;
    poll?: number;
    modelUnavailable?: boolean;
  },
  place: PhotoPlace,
) {
  const poll = props.poll ?? 0;
  const delay = cutoutPollDelay(poll, props.modelUnavailable === true);
  if (delay === undefined) return undefined;
  return {
    'hx-get': garmentUrl(props.garment.id, props.viewOwner, '/cutout', {
      poll: poll + 1,
      place: place === 'form' ? place : undefined,
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

function viewerPhotos(garment: PhotoSubject, photo: GarmentPhoto) {
  const alt = garment.name ?? '';
  const original: ViewerPhoto = { photo, alt, variant: 'original' };
  return showsCutout(photo.cutoutStatus)
    ? [{ photo, alt } satisfies ViewerPhoto, original]
    : [original];
}

function EditMaskButton(props: {
  garment: PhotoSubject;
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
