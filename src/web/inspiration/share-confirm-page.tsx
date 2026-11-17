import { t } from '../i18n';
import { FormPage } from '../layout/form-page';
import type { ViewContext } from '../view-context';
import { INSPIRATION_TITLE_MAX } from './queries';
import {
  SHARE_NOT_OPENED,
  SHARE_PHOTO_FIELD,
  SHARE_PHOTO_MAX_BYTES,
  SHARE_STASH_CACHE,
  SHARE_STASH_KEY_PREFIX,
  SHARE_STASH_MAX_AGE_MS,
  SHARE_TOO_LARGE,
  SHARED_AT_HEADER,
  SHARED_NAME_HEADER,
  SHARED_TITLE_HEADER,
  SHARED_URL_HEADER,
} from './share-target';
import { INSPIRATION_PATH } from './urls';

// public/js/share-confirm.js, through the importmap: an inline module, so
// it runs again on a page a boosted navigation brings. A fixed string with
// nothing interpolated.
const SHARE_CONFIRM_INIT = `import { confirmShare } from 'share-confirm';
confirmShare(document.getElementById('share-confirm'));`;

/**
 * GET /inspiration/share/confirm (#22d): a photo shared into the app,
 * saved only by this page's Save look, a native post to POST /inspiration
 * like the add page's upload. The photo never left the device: the service
 * worker kept it (share-target.ts) and the URL's fragment names it, so the
 * server renders the same page for every share. Its module reads the
 * stash (named here, so the worker's names are said once), puts the photo
 * in the form's file input (its link and title in the hidden fields),
 * shows it and enables Save; Cancel discards it. Every state is rendered
 * hidden and shown by the module: the photo, a share that is gone (an hour
 * old, replaced, another session's, or never kept), one too large to keep,
 * and one the server's fallback saw because no worker took it.
 */
export function ShareConfirmPage(props: { ctx: ViewContext }) {
  return (
    <FormPage
      ctx={props.ctx}
      title={t('inspiration.SHARE_TITLE')}
      back={INSPIRATION_PATH}
      action={INSPIRATION_PATH}
      multipart
      submitLabel={t('inspiration.SAVE_SHARED')}
      submitDisabled
      after={
        <script
          type="module"
          dangerouslySetInnerHTML={{ __html: SHARE_CONFIRM_INIT }}
        />
      }
    >
      <div
        id="share-confirm"
        class="flex flex-col gap-3"
        data-stash-cache={SHARE_STASH_CACHE}
        data-stash-key-prefix={SHARE_STASH_KEY_PREFIX}
        data-stash-max-age-ms={String(SHARE_STASH_MAX_AGE_MS)}
        data-shared-at-header={SHARED_AT_HEADER}
        data-shared-name-header={SHARED_NAME_HEADER}
        data-shared-url-header={SHARED_URL_HEADER}
        data-shared-title-header={SHARED_TITLE_HEADER}
        data-title-max={String(INSPIRATION_TITLE_MAX)}
        data-notices={`${SHARE_TOO_LARGE} ${SHARE_NOT_OPENED}`}
      >
        <p class="text-sm text-muted">{t('inspiration.SHARE_HINT')}</p>
        <img
          alt={t('inspiration.SHARE_PHOTO_ALT')}
          class="hidden w-full rounded-box bg-base-200"
          data-share-preview=""
        />
        <p class="hidden text-sm text-muted break-all" data-share-link="">
          {t('inspiration.SHARE_WITH_LINK')} <span data-share-link-text="" />
        </p>
        <p
          class="text-sm text-muted"
          data-share-state="loading"
          aria-live="polite"
        >
          {t('inspiration.SHARE_LOADING')}
        </p>
        <div
          role="status"
          class="hidden alert alert-warning alert-soft text-sm"
          data-share-state="missing"
        >
          {t('inspiration.SHARE_MISSING')}
        </div>
        <div
          role="status"
          class="hidden alert alert-warning alert-soft text-sm"
          data-share-state={SHARE_TOO_LARGE}
        >
          {t('inspiration.SHARE_TOO_LARGE', {
            max: SHARE_PHOTO_MAX_BYTES / (1024 * 1024),
          })}
        </div>
        <div
          role="status"
          class="hidden alert alert-warning alert-soft text-sm"
          data-share-state={SHARE_NOT_OPENED}
        >
          {t('inspiration.SHARE_NOT_OPENED')}
        </div>
        {/* Before the file: the browser posts fields in document order, so
            the link and title never depend on a reader going past the photo. */}
        <input type="hidden" name="url" value="" />
        <input type="hidden" name="title" value="" />
        {/* Filled by the module from the stash, never by a tap. */}
        <input
          type="file"
          name={SHARE_PHOTO_FIELD}
          accept="image/*"
          // eslint-disable-next-line closet/no-hidden-control -- the module fills it from the stash; no one picks a file here
          class="hidden"
          tabindex={-1}
          aria-hidden="true"
        />
      </div>
    </FormPage>
  );
}
