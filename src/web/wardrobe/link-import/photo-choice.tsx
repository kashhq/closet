import { imageUrl } from '../../files/image-url';
import { pendingPhotoRef } from '../../files/queries';
import { t } from '../../i18n';
import { LINK_PHOTO_PATH, wardrobeUrl } from '../urls';
import type { PhotoChoice } from './import';
import { THUMB_ROW } from '../../layout/columns';

/**
 * What a new garment form with a pending photo (from a link, or an upload)
 * shows above its fields.
 */
export interface LinkImportView {
  /** The pending photo's stored name (the hidden `linkPhoto`), if any. */
  photo: string | undefined;
  /** The page's photos to pick from; empty unless there are two or more. */
  choices: PhotoChoice[];
  /** What the import found (translated sentences). */
  notices: string[];
  /** What it could not read well: shown as a warning, never as a success. */
  warnings: string[];
}

/**
 * A form with a pending photo and nothing else to say: a refused save's
 * (the photo it posted kept), or one started from an upload (the add
 * sheet's camera or library, GET /wardrobe/new?photo=).
 */
export function pendingPhotoView(photo: string | undefined): LinkImportView {
  return { photo, choices: [], notices: [], warnings: [] };
}

const SLOT_ID = 'link-photo';
const CHOICES_ID = 'link-photo-choices';

/**
 * The top of a garment form prefilled from a link: what the import found,
 * the photo that comes with the garment, and the page's other photos to
 * pick instead (each tap fetches that one and swaps the slot).
 */
export function LinkImportSection(props: {
  link: LinkImportView;
  viewOwner: number | undefined;
  errors?: string[];
}) {
  const { link, viewOwner } = props;
  return (
    <div class="flex flex-col gap-3">
      {link.warnings.map((warning) => (
        <div role="status" class="alert alert-warning alert-soft text-sm">
          {warning}
        </div>
      ))}
      {link.notices.map((notice) => (
        <div role="status" class="alert alert-info alert-soft text-sm">
          {notice}
        </div>
      ))}
      <LinkPhotoSlot photo={link.photo} errors={props.errors} />
      {link.choices.length > 1 && (
        <PhotoChoices choices={link.choices} viewOwner={viewOwner} />
      )}
    </div>
  );
}

/**
 * The photo that is saved with the garment, as its hidden `linkPhoto` and
 * a preview. Also the whole answer of POST /wardrobe/new/from-link/photo,
 * which replaces it (a refusal is the error handler's toast, #642, and
 * leaves it as it was).
 */
export function LinkPhotoSlot(props: { photo?: string; errors?: string[] }) {
  const { photo } = props;
  return (
    <div id={SLOT_ID} class="flex items-center gap-3">
      {photo && (
        <>
          <input type="hidden" name="linkPhoto" value={photo} />
          <img
            src={imageUrl(pendingPhotoRef(photo), 'thumb')}
            alt={t('add.PHOTO_ALT')}
            width="112"
            height="112"
            class="w-28 h-28 object-contain rounded-box bg-base-200"
          />
          <p class="text-sm text-muted">{t('add.PHOTO_CUTOUT_HINT')}</p>
        </>
      )}
      {props.errors?.map((message) => (
        <p class="text-error text-sm" role="alert">
          {message}
        </p>
      ))}
    </div>
  );
}

/**
 * One button per photo the page offered, plus "No photo". The button's
 * `url` and the form's current `linkPhoto` go to the photo route
 * (hx-params keeps the rest of the form out); the answer replaces the slot.
 *
 * The taps share one queue on the group, the latest last: two picks in
 * flight at once would both post the same `linkPhoto`, so only one could
 * discard it and the other's new photo would lose its only reference. A
 * queued request reads the form when it is sent, after the slot has taken
 * the previous answer. Not the form's own queue (autosave's
 * `closest form:queue last`, which a property change would empty of a
 * waiting pick), and never on an element an answer replaces.
 */
function PhotoChoices(props: {
  choices: PhotoChoice[];
  viewOwner: number | undefined;
}) {
  const choose = {
    'hx-post': wardrobeUrl(props.viewOwner, {}, LINK_PHOTO_PATH),
    'hx-params': 'url,linkPhoto',
    'hx-target': `#${SLOT_ID}`,
    'hx-swap': 'outerHTML',
    'hx-sync': `#${CHOICES_ID}:queue last`,
  } as const;
  return (
    <div class="flex flex-col">
      <span class="label">
        <span class="label-text">{t('linkImport.CHOOSE_PHOTO')}</span>
      </span>
      <div id={CHOICES_ID} class={THUMB_ROW}>
        {props.choices.map((choice, index) => (
          <button
            type="button"
            name="url"
            value={choice.url}
            class="btn btn-ghost bg-base-200 h-auto p-1"
            {...choose}
          >
            <img
              src={choice.preview}
              alt={t('linkImport.CHOICE_ALT', { number: index + 1 })}
              width="96"
              height="96"
              class="w-full aspect-square object-contain"
            />
          </button>
        ))}
        <button
          type="button"
          name="url"
          value=""
          class="btn btn-ghost bg-base-200 h-auto min-h-24"
          {...choose}
        >
          {t('linkImport.NO_PHOTO_CHOICE')}
        </button>
      </div>
    </div>
  );
}
