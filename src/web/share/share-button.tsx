import { t } from '../i18n';

/**
 * An inline click handler: copies the button's `data-copy` to the clipboard
 * and flashes the button green for a second: `resting`, the class it wears
 * otherwise, becomes its success twin (a button's `btn-success`, a menu
 * item's `text-success`). The copied text reaches the handler as a data
 * attribute, never spliced into its source. Also the wardrobe-share invite
 * link's copy button.
 */
function copyAndFlash(
  resting: 'btn-outline' | 'btn-ghost' | 'text-base-content',
): string {
  const flashed =
    resting === 'text-base-content' ? 'text-success' : 'btn-success';
  return `navigator.clipboard.writeText(this.dataset.copy).then(() => { this.classList.replace('${resting}', '${flashed}'); setTimeout(() => this.classList.replace('${flashed}', '${resting}'), 1000); })`;
}

/**
 * A value in a read-only input plus a copy button: the wardrobe-share invite
 * links, a new personal access token and its connect command. The value
 * reaches the handler as a data attribute, never spliced into its source.
 * `name` is the field's accessible name (what the value is), `label` the
 * button's.
 */
export function CopyableText(props: {
  value: string;
  size: 'xs' | 'sm';
  name: string;
  label: string;
}) {
  return (
    <div class="flex items-center gap-2">
      <input
        type="text"
        class={`input input-bordered input-${props.size} flex-1`}
        value={props.value}
        aria-label={props.name}
        readonly
        onclick="this.select()"
      />
      <button
        type="button"
        class={`btn btn-ghost btn-${props.size}`}
        data-copy={props.value}
        onclick={copyAndFlash('btn-ghost')}
      >
        {props.label}
      </button>
    </div>
  );
}

/**
 * A garment's or outfit's public link as its page offers it (#669): where
 * Share and Stop sharing post, and the link's id, null while not shared.
 */
export interface PublicShare {
  type: 'garment' | 'outfit';
  shareableId: string | null;
  shareUrl: string;
  stopUrl: string;
}

/** A shared item's /share page (src/web/share/routes.tsx), on SITE_URL. */
function publicLink(siteUrl: string, type: string, shareableId: string) {
  const params = new URLSearchParams({ shareableId, type });
  return `${siteUrl}/share?${params}`;
}

/**
 * The ⋯ menu's Share: unshared, it makes the public link (htmx, confirmed;
 * the page comes back with PublicSharePanel); shared, it copies the link
 * and flashes to say so. A `menu` item is a plain button for a daisyUI
 * menu (the garment page's ⋯ menu).
 */
export function ShareLinkButton(props: {
  siteUrl: string;
  share: PublicShare;
  variant?: 'button' | 'menu';
}) {
  const { share } = props;
  const resting =
    props.variant === 'menu' ? 'text-base-content' : 'btn-outline';
  const action =
    share.shareableId === null
      ? {
          'hx-post': share.shareUrl,
          'hx-confirm': t('publicShare.CONFIRM_START'),
        }
      : {
          'data-copy': publicLink(props.siteUrl, share.type, share.shareableId),
          onclick: copyAndFlash(resting),
        };
  return (
    <button
      type="button"
      class={props.variant === 'menu' ? resting : `btn btn-sm ${resting}`}
      {...action}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        class="size-4"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.935-2.185 2.25 2.25 0 0 0-3.935 2.185Z"
        />
      </svg>
      {t('SHARE')}
    </button>
  );
}

/**
 * A shared item's "Shared publicly" panel on its page (#669), for whoever
 * may stop it (the owner, and a MANAGE grantee of a garment): the link to
 * copy and Stop sharing, so a link anyone minted shows until it is
 * stopped. Nothing while not shared.
 */
export function PublicSharePanel(props: {
  siteUrl: string;
  share: PublicShare;
}) {
  const { share } = props;
  if (share.shareableId === null) return null;
  return (
    <section
      class="flex flex-col gap-2 rounded-box border border-base-300 p-3"
      aria-label={t('publicShare.SHARED_PUBLICLY')}
      data-public-share=""
    >
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-semibold">{t('publicShare.SHARED_PUBLICLY')}</h2>
        <button
          type="button"
          class="btn btn-ghost btn-sm text-error"
          hx-post={share.stopUrl}
          hx-confirm={t('publicShare.CONFIRM_STOP')}
        >
          {t('publicShare.STOP')}
        </button>
      </div>
      <p class="text-muted text-sm">{t('publicShare.HINT')}</p>
      <CopyableText
        value={publicLink(props.siteUrl, share.type, share.shareableId)}
        size="sm"
        name={t('publicShare.LINK')}
        label={t('publicShare.COPY')}
      />
    </section>
  );
}
