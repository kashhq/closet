import { PostForm } from '../form';
import type { IsoDate } from '../../calendar-date';
import { dayLabel } from '../date-labels';
import { selfieUrl } from '../files/image-url';
import { t } from '../i18n';
import {
  CameraIcon,
  PhotoLibraryIcon,
  PREPARE_AND_SUBMIT_PHOTO,
} from '../layout/parts';
import { Sheet, sheetOpener } from '../layout/sheet';
import type { SelfieRef } from './queries';

/**
 * Outfit selfies (#19) in the pages that show a worn day: the calendar's
 * rows (OccasionRow), Today's planned cards, the outfit page's Worn strip.
 * The owner's own pages only: nothing here is rendered for a grantee, the
 * share page or Open Graph. Images come from GET /selfies/* (selfieUrl),
 * which serves them to their owner alone.
 */

/**
 * How big a selfie's thumbnail is where it shows: a calendar row, a Today
 * card, the outfit page's strip. Portrait, as a mirror photo is.
 */
const THUMB_SIZES = {
  row: 'h-12',
  card: 'h-24',
  strip: 'h-36',
} as const;
export type SelfieThumbSize = keyof typeof THUMB_SIZES;

/**
 * A button that takes a selfie for the entry (the camera, `capture`) or
 * picks one already taken (the library), posting it natively: the answer is
 * a 303 back to `returnTo`, where the entry now shows it, marked worn.
 * Disabled offline (the connectivity guard): an upload needs the server.
 */
function SelfieUpload(props: {
  entryId: number;
  returnTo: string;
  source: 'camera' | 'library';
  /** A labelled button (the dialog) rather than an icon (a row, a card). */
  labelled?: boolean;
}) {
  const { entryId, source } = props;
  const label = t(source === 'camera' ? 'selfie.TAKE' : 'selfie.CHOOSE');
  const action = `/calendar/${entryId}/selfie?returnTo=${encodeURIComponent(props.returnTo)}`;
  const Icon = source === 'camera' ? CameraIcon : PhotoLibraryIcon;
  return (
    <PostForm action={action} multipart class="inline-flex">
      {/* `relative`: the sr-only input is absolutely positioned, and
          without a positioned ancestor it escapes a scroll container (the
          Worn strip) and widens the whole page. */}
      <label
        class={
          props.labelled
            ? 'relative btn btn-sm btn-outline'
            : 'relative btn btn-ghost btn-sm btn-square'
        }
        title={label}
        data-selfie-upload={source}
      >
        <Icon class="size-4" />
        {props.labelled && label}
        <input
          type="file"
          name="photo"
          aria-label={props.labelled ? undefined : label}
          accept="image/*"
          capture={source === 'camera' ? 'environment' : undefined}
          class="sr-only"
          onchange={PREPARE_AND_SUBMIT_PHOTO}
        />
      </label>
    </PostForm>
  );
}

/**
 * A selfie's thumbnail, which opens it whole in a dialog with what can be
 * done to it: take or choose another (an entry's; a look whose outfit was
 * deleted has no entry to replace it on) and remove it. The full photo
 * loads only when the dialog opens (lazy inside a closed dialog).
 */
export function SelfieView(props: {
  selfie: SelfieRef;
  day: IsoDate;
  /** The entry it belongs to; null for a look kept after its outfit went. */
  entryId: number | null;
  returnTo: string;
  size: SelfieThumbSize;
}) {
  const { selfie, day, entryId, returnTo } = props;
  const dialogId = `selfie-${selfie.id}`;
  const alt = t('selfie.ALT', { day: dayLabel(day) });
  return (
    <>
      <button
        type="button"
        class="shrink-0 rounded-box overflow-hidden"
        {...sheetOpener(dialogId)}
        aria-label={t('selfie.VIEW', { day: dayLabel(day) })}
        data-selfie={selfie.id}
      >
        <img
          src={selfieUrl(selfie.photo, 'thumb')}
          alt={alt}
          class={`${THUMB_SIZES[props.size]} aspect-[3/4] w-auto object-cover`}
          width="300"
          height="400"
          loading="lazy"
          decoding="async"
        />
      </button>
      <Sheet
        id={dialogId}
        kind="dialog"
        labelledBy={`${dialogId}-day`}
        boxClass="p-3 max-w-sm"
        dismiss="close"
      >
        <img
          src={selfieUrl(selfie.photo, 'original')}
          alt={alt}
          class="w-full rounded-box"
          loading="lazy"
          decoding="async"
        />
        <p id={`${dialogId}-day`} class="text-sm text-muted mt-2 px-1">
          {dayLabel(day)}
        </p>
        <div class="flex flex-wrap items-center gap-2 mt-3">
          {entryId !== null && (
            <>
              <SelfieUpload
                entryId={entryId}
                returnTo={returnTo}
                source="camera"
                labelled
              />
              <SelfieUpload
                entryId={entryId}
                returnTo={returnTo}
                source="library"
                labelled
              />
            </>
          )}
          <PostForm
            action={`/selfies/${selfie.id}/delete`}
            confirm={t('selfie.REMOVE_CONFIRM')}
          >
            <input type="hidden" name="returnTo" value={returnTo} />
            <button type="submit" class="btn btn-sm btn-error btn-outline">
              {t('selfie.REMOVE')}
            </button>
          </PostForm>
          <form method="dialog" class="ml-auto">
            <button type="submit" class="btn btn-sm btn-ghost">
              {t('selfie.CLOSE')}
            </button>
          </form>
        </div>
      </Sheet>
    </>
  );
}

/**
 * A calendar entry's selfie where the entry is drawn (a calendar row, a
 * Today card): the photo when there is one, else the camera and the library
 * to take it. A day after today shows neither button: it cannot be worn
 * yet (setEntryWorn), so it cannot have a selfie.
 */
export function EntrySelfie(props: {
  entryId: number;
  day: IsoDate;
  selfie: SelfieRef | null;
  /** The day is today or before. */
  canTake: boolean;
  returnTo: string;
  size: SelfieThumbSize;
}) {
  const { entryId, selfie, returnTo } = props;
  if (selfie) {
    return (
      <SelfieView
        selfie={selfie}
        day={props.day}
        entryId={entryId}
        returnTo={returnTo}
        size={props.size}
      />
    );
  }
  if (!props.canTake) return null;
  return (
    // btn-sm squares 2.5 apart: each one's hit area reaches 4.4 px past it
    // on a phone, so a closer pair's areas meet (#1210).
    <div class="flex items-center gap-2.5" data-selfie-take={entryId}>
      <SelfieUpload entryId={entryId} returnTo={returnTo} source="camera" />
      <SelfieUpload entryId={entryId} returnTo={returnTo} source="library" />
    </div>
  );
}
