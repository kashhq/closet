import { Card } from '../card';
import type { Child } from 'hono/jsx';
import {
  type SignablePhotoRef,
  imageUrl,
  type PlinthPhoto,
} from '../files/image-url';
import { categoryRole, type GarmentRole } from '../../wardrobe/properties';
import { jsonForScript } from '../html';
import { t } from '../i18n';

/**
 * Small pieces the garment, outfit and share pages have in common: the
 * placeholder for a garment without a photo, a garment thumbnail, the back
 * link and an empty-list state.
 */

/**
 * The hanger's paths (hugeicons' hanger-stroke-rounded), drawn in the
 * text's colour: the dock's Wardrobe tab and HangerIcon, one drawing.
 */
export const HANGER_PATHS = (
  <>
    <path
      d="M4.12572 15.3668L10.1284 11.9903C10.7234 11.6556 11.3252 11.5 12 11.5C12.6748 11.5 13.2766 11.6556 13.8716 11.9903L19.8743 15.3668C20.5697 15.7579 21 16.4937 21 17.2916C21 18.5113 20.0113 19.5 18.7916 19.5H5.20841C3.98874 19.5 3 18.5113 3 17.2916C3 16.4937 3.43034 15.7579 4.12572 15.3668Z"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M10 6.40476C10 5.35279 10.8954 4.5 12 4.5C13.1046 4.5 14 5.35279 14 6.40476C14 7.12453 13.5808 7.75106 12.9623 8.07498C12.473 8.33119 12 8.75724 12 9.30952V11.5"
      stroke-linecap="round"
    />
  </>
);

/**
 * The hanger: a garment in general (EmptyState, the first-run card) and
 * the stand-in for one whose role is none (GarmentSilhouette).
 */
export function HangerIcon(props: { class: string; strokeWidth: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width={props.strokeWidth}
      stroke="currentColor"
      class={props.class}
      aria-hidden="true"
    >
      {HANGER_PATHS}
    </svg>
  );
}

/**
 * Each role's outline (24 box, the text's colour), so a closet of garments
 * without photos still reads as tops, trousers and shoes (#666). `none`
 * (other and custom categories) is the hanger.
 */
const SILHOUETTES: Readonly<Record<Exclude<GarmentRole, 'none'>, string>> = {
  top: 'M8.5 3.75 4 5.75 2.25 10l3 1.25L7 9.5v10.75h10V9.5l1.75 1.75 3-1.25L20 5.75l-4.5-2c-.5 1.5-1.9 2.5-3.5 2.5s-3-1-3.5-2.5Z',
  bottom:
    'M6.5 3.75h11l1.25 16.5h-4.5L12 9.5l-2.25 10.75h-4.5L6.5 3.75Zm0 3h11',
  'one-piece': 'M9.5 3.75h5l-.75 4.5 4.75 12h-13l4.75-12-.75-4.5Zm.75 4.5h3.5',
  layer:
    'M8.75 3.75 4 6l-1.5 14.25h3.75l1-8.5v8.5h9.5v-8.5l1 8.5h3.75L20 6l-4.75-2.25L12 8.5 8.75 3.75ZM12 8.5v11.75',
  footwear:
    'M3 17.25V8.25h4.75l1.5 3c3 1 7 1.5 9.25 2.75 1.25.7 2.25 1.75 2.25 3.25H3Zm0 3h18',
  accessory: 'M3 17.25h18M6 17.25c0-5 2.5-8.5 6-8.5s6 3.5 6 8.5',
  bag: 'M5.25 8.25h13.5l-1 12H6.25l-1-12Zm3.75 0v-1.5a3 3 0 0 1 6 0v1.5',
};

/**
 * A photoless garment's stand-in: its role's outline (categoryRole), the
 * hanger for none. `data-silhouette` names the role drawn.
 */
export function GarmentSilhouette(props: {
  category: string;
  class: string;
  strokeWidth: string;
}) {
  const role = categoryRole(props.category);
  if (role === 'none') {
    return <HangerIcon class={props.class} strokeWidth={props.strokeWidth} />;
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width={props.strokeWidth}
      stroke="currentColor"
      class={props.class}
      aria-hidden="true"
      data-silhouette={role}
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d={SILHOUETTES[role]}
      />
    </svg>
  );
}

/**
 * The frame of a Heroicons outline icon (24 box, 1.5 stroke in the text's
 * colour), decorative: the control it sits in carries the name.
 */
function OutlineIcon(props: { class: string; children: Child }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      class={props.class}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

/** Waiting: a queued write's "Waiting to sync" (src/web/outbox.tsx). */
export function ClockIcon(props: { class: string }) {
  return (
    <OutlineIcon class={props.class}>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </OutlineIcon>
  );
}

/** Taking a photo with the camera: the garment photo form, outfit selfies. */
export function CameraIcon(props: { class: string }) {
  return (
    <OutlineIcon class={props.class}>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.174C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-6.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
      />
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"
      />
    </OutlineIcon>
  );
}

/**
 * What a garment photo input offers (the garment page's photo sheet, the
 * add sheet's camera and library): what Photos decodes, HEIC named by its
 * extension too (some pickers send it as application/octet-stream).
 */
export const PHOTO_ACCEPT =
  'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif';

/**
 * The `onchange` of a file input that uploads as soon as a photo is chosen
 * (the garment page's photo sheet, outfit selfies): the photo is prepared
 * on the phone first (photo-input.js: a 24 MP photo becomes a 1600 px JPEG
 * of a few hundred KB, HEIC left for the server), then its form submitted;
 * nothing is posted when the choice came back empty. A dynamic import from
 * the handler, so the module loads only when a photo is chosen, and no page
 * script has to run again after a boosted navigation or an htmx swap.
 */
export const PREPARE_AND_SUBMIT_PHOTO =
  "import('photo-input').then((m) => m.preparePhoto(this)).then((file) => { if (file) this.form.requestSubmit(); })";

/** Choosing a photo already taken (the library): the photo sheet, outfit selfies. */
export function PhotoLibraryIcon(props: { class: string }) {
  return (
    <OutlineIcon class={props.class}>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
      />
    </OutlineIcon>
  );
}

/** An 80px garment tile: the thumb variant, or the placeholder. */
export function GarmentThumb(props: {
  garment: { name: string | null; photo: SignablePhotoRef | null };
  class: string;
}) {
  const { garment } = props;
  return garment.photo ? (
    <img
      src={imageUrl(garment.photo, 'thumb')}
      alt={garment.name ?? ''}
      class={`size-20 object-cover ${props.class}`}
      width="80"
      height="80"
      loading="lazy"
      decoding="async"
    />
  ) : (
    <div
      class={`size-20 bg-base-200 flex items-center justify-center ${props.class}`}
    >
      <HangerIcon class="size-6 text-faint" strokeWidth="1.5" />
    </div>
  );
}

/**
 * A garment's thumb contained in the frame that holds it, or the hanger
 * without a photo: Styling's plinths and preview slots (GarmentLook, one
 * markup styling.js copies between them) and a recreated look's matches
 * (src/web/inspiration/recreate-page.tsx, whose own modules never sign a
 * photo URL: photo-ref-guard.spec.ts).
 */
export function GarmentPicture(props: {
  photo: SignablePhotoRef | null;
  loading: 'eager' | 'lazy';
}) {
  return props.photo ? (
    <img
      src={imageUrl(props.photo, 'thumb')}
      alt=""
      class="max-h-full max-w-full object-contain"
      width="200"
      height="200"
      loading={props.loading}
      decoding="async"
    />
  ) : (
    <HangerIcon class="size-10 text-faint" strokeWidth="1" />
  );
}

/**
 * A garment's photo on the plinth (base-200), as the redesign draws a
 * garment in a frame (docs/plans/2026-09-26-redesign.md, section 4,
 * "Imagery"): its cutout contained, never cropped, or, until it has one,
 * the photo as taken covering the frame; without a photo, its role's
 * silhouette (GarmentSilhouette, from `category`). The frame's shape
 * (aspect, rounding) is the caller's `class`; `children` draw over it (the
 * grid's marks). Used by the wardrobe grid's tiles and the Capsules tab's
 * strips.
 */
export function PlinthImage(props: {
  photo: PlinthPhoto | null;
  category: string;
  alt: string;
  class: string;
  /** Above the fold on a phone: loaded at once, not when scrolled near. */
  eager?: boolean;
  children?: Child;
}) {
  const { photo } = props;
  return (
    <figure class={`relative overflow-hidden bg-base-200 ${props.class}`}>
      {photo ? (
        <img
          src={imageUrl(photo, 'thumb')}
          alt={props.alt}
          class={`size-full ${photo.cutout ? 'object-contain p-1' : 'object-cover'}`}
          width="400"
          height="400"
          decoding="async"
          loading={props.eager ? undefined : 'lazy'}
        />
      ) : (
        <div class="flex size-full items-center justify-center text-faint">
          <GarmentSilhouette
            category={props.category}
            class="size-1/3"
            strokeWidth="1"
          />
        </div>
      )}
      {props.children}
    </figure>
  );
}

/**
 * A back arrow to `href`. With `historyBack` (the app bar's) it goes back in
 * history instead whenever the page before is in the app, and follows
 * `href` only on a cold entry (public/js/back.js); without, it is a plain
 * link to a fixed place (a Styling or Ideas destination's way back to it).
 */
export function BackLink(props: { href: string; historyBack?: boolean }) {
  return (
    <a
      href={props.href}
      class="btn btn-ghost btn-sm btn-circle"
      aria-label={t('BACK')}
      data-history-back={props.historyBack ? '' : undefined}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="2"
        stroke="currentColor"
        class="size-4"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
        />
      </svg>
    </a>
  );
}

/**
 * A form page's Cancel: a back arrow in words (public/js/back.js). It goes
 * back to the page the form was opened from, as history holds it, and to
 * `href` (the app bar's `back`) only on a cold entry; either way the form
 * is left done, so the page reached never goes back into it.
 */
export function CancelLink(props: { href: string; class?: string }) {
  return (
    <a
      href={props.href}
      class={`btn btn-ghost${props.class ? ` ${props.class}` : ''}`}
      data-history-back=""
    >
      {t('CANCEL')}
    </a>
  );
}

/**
 * A sheet's tap-outside close (daisyUI's `modal-backdrop`, a `method="dialog"`
 * form), the last child of every `<dialog class="modal">`. `label` is its
 * accessible name: Close on a sheet that shows, Cancel on one that asks for
 * a choice (the plan sheet, Styling's save).
 */
export function SheetBackdrop(props: { label: string }) {
  return (
    <form method="dialog" class="modal-backdrop">
      <button>{props.label}</button>
    </form>
  );
}

/** A page with nothing to list yet: an icon, a message and what to do about it. */
export function EmptyState(props: {
  message: string;
  icon?: Child;
  children: Child;
}) {
  return (
    <div class="flex flex-col items-center justify-center gap-4 pt-20 text-muted">
      {props.icon ?? <HangerIcon class="size-16" strokeWidth="1" />}
      <p class="text-center text-sm px-4">{props.message}</p>
      {props.children}
    </div>
  );
}

/**
 * A success message said once after a redirect that carries a flag in the
 * URL (`?created=1`, `?bulkUpdated=3`). Inert here: public/js/toast.js
 * moves its text into `#toast-host`, the page's one polite status region
 * (#679), once the page has loaded or a swap brought it, as the htmx
 * writes' STATUS_EVENT (src/web/announce.ts) does. A live region of its own,
 * inserted with the page, was not reliably read. Pair it with StripFlags so
 * a reload or a shared link does not say it again; specs find it by `id`.
 */
export function SavedToast(props: { id: string; text: string }) {
  return (
    <template id={props.id} data-status-message="">
      {props.text}
    </template>
  );
}

/**
 * Drops one-shot flags from the address bar once the page has read them,
 * so a reload or a copied URL does not replay their toast. `names` are the
 * page's own constants; jsonForScript keeps them inert in the script anyway.
 */
export function StripFlags(props: { names: readonly string[] }) {
  const script = `(() => {
  const names = ${jsonForScript(props.names)};
  const url = new URL(window.location.href);
  if (names.some((name) => url.searchParams.has(name))) {
    for (const name of names) url.searchParams.delete(name);
    window.history.replaceState({}, '', url);
  }
})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

/**
 * One card of Profile (src/web/auth/pages.tsx): Account, Export, Sign out,
 * an anchor their pages go back to (`/auth/profile#sign-out`), its heading
 * and its content. A feature's settings have their own page since #728
 * (layout/settings-page.tsx), never a section here. `scroll-mt-under-bar` keeps
 * the heading clear of the fixed app bar when the anchor is followed.
 */
export function ProfileSection(props: {
  id: string;
  heading: string;
  children: Child;
}) {
  const headingId = `${props.id}-heading`;
  return (
    <Card
      as="section"
      variant="content"
      class="w-full scroll-mt-under-bar"
      bodyClass="gap-3"
      id={props.id}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} class="card-title">
        {props.heading}
      </h2>
      {props.children}
    </Card>
  );
}
