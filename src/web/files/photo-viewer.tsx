import { t } from '../i18n';
import { imageUrl, type SignablePhotoRef } from './image-url';
import { Icon } from '../layout/icon';

/**
 * The shared photo viewer (#313, epic #308): tap a photo, see it large,
 * swipe or step through its set, zoom. The server renders the set and which
 * photos open it; public/js/photo-viewer.js, loaded by every page, owns
 * the one `<dialog id="photo-viewer">` (PhotoViewer, in Layout) and a
 * document-level listener, so a page needs no script and htmx-swapped
 * content needs no re-binding.
 *
 * A page that wants it renders a `PhotoSet` (the photos, in the order they
 * are swiped) and gives each tappable photo `viewerTrigger(setId, photo)`
 * on a `<button>` (or, where the photo sits in a container that is not
 * itself a control, on the `<img>` with `role="button" tabindex="0"`).
 * Never nest the trigger in a link or button: use a sibling button over the
 * photo instead. Set ids are unique per page.
 */

type Variant = 'nobg' | 'original';

export interface ViewerPhoto {
  photo: SignablePhotoRef;
  alt: string;
  /** The cutout by default: the best stored resolution drawn on the plinth. */
  variant?: Variant;
}

/**
 * A set's photos, in a `<template>` so nothing is fetched until the viewer
 * opens (the large image loads then). The thumb the page already holds is
 * `data-fallback`, shown only when the large image cannot load (offline),
 * never as a placeholder before it: a cutout's thumb is trimmed to the
 * garment (#373), so the swap would shrink it.
 */
export function PhotoSet(props: {
  id: string;
  photos: readonly ViewerPhoto[];
}) {
  return (
    <template data-photo-set={props.id}>
      {props.photos.map(({ photo, alt, variant = 'nobg' }) => (
        <img
          src={imageUrl(photo, variant)}
          data-fallback={imageUrl(photo, 'thumb')}
          alt={alt}
        />
      ))}
    </template>
  );
}

/** The attributes that make an element open `setId` at `photo`. */
export function viewerTrigger(
  setId: string,
  photo: SignablePhotoRef,
  variant: Variant = 'nobg',
) {
  return {
    'data-photo-open': setId,
    'data-photo-large': imageUrl(photo, variant),
    'aria-haspopup': 'dialog',
  } as const;
}

/** "Enlarge photo of White tee": the trigger's accessible name. */
export function enlargeLabel(name: string | null | undefined): string {
  return name
    ? t('photoViewer.ENLARGE_NAMED', { name })
    : t('photoViewer.ENLARGE');
}

/**
 * The viewer's shell, once per page (Layout). The strings travel as data
 * attributes, as AppStatus's do, so the script stays free of i18n.
 */
export function PhotoViewer() {
  return (
    <dialog
      id="photo-viewer"
      aria-label={t('photoViewer.TITLE')}
      class="m-0 h-dvh w-dvw max-h-none max-w-none bg-neutral p-0 text-neutral-content backdrop:bg-transparent"
      data-text-position={t('photoViewer.POSITION', {
        current: '{current}',
        total: '{total}',
      })}
      data-text-smaller-copy={t('photoViewer.SMALLER_COPY')}
    >
      <div class="relative size-full">
        <div data-photo-track class="photo-viewer-track absolute inset-0"></div>
        <div class="absolute inset-x-0 top-0 z-10 flex justify-between p-3">
          <button
            type="button"
            class="btn btn-circle btn-ghost"
            data-photo-close
            autofocus
            aria-label={t('CLOSE')}
          >
            <Icon paths="M6 18 18 6M6 6l12 12" class="size-6" weight="2" />
          </button>
          <button
            type="button"
            class="btn btn-circle btn-ghost"
            data-photo-zoom
            aria-label={t('photoViewer.ZOOM')}
            aria-pressed="false"
          >
            <Icon
              paths="m21 21-5.2-5.2M10.5 7.5v6M7.5 10.5h6M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"
              class="size-6"
              weight="2"
            />
          </button>
        </div>
        <button
          type="button"
          class="btn btn-circle btn-ghost absolute left-2 top-1/2 z-10 -translate-y-1/2"
          data-photo-step="-1"
          aria-label={t('photoViewer.PREVIOUS')}
        >
          <Icon paths="m15 19-7-7 7-7" class="size-6" weight="2" />
        </button>
        <button
          type="button"
          class="btn btn-circle btn-ghost absolute right-2 top-1/2 z-10 -translate-y-1/2"
          data-photo-step="1"
          aria-label={t('photoViewer.NEXT')}
        >
          <Icon paths="m9 5 7 7-7 7" class="size-6" weight="2" />
        </button>
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-0.5 p-4 text-center text-sm"
          role="status"
          aria-live="polite"
        >
          <span data-photo-caption class="font-medium"></span>
          <span data-photo-notice class="text-xs"></span>
          <span data-photo-position class="text-xs"></span>
        </div>
      </div>
    </dialog>
  );
}
