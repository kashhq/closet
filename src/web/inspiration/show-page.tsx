import { PostForm } from '../form';
import { AutosaveForm } from '../autosave';
import { inspirationPhotoUrl } from '../files/image-url';
import { FormField, inputAttributes } from '../form-field';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import type { ViewContext } from '../view-context';
import { REFUSALS } from '../wardrobe/link-import/import';
import { linkHost, lookName } from './look-name';
import { LookPhotoUpload } from './photo-upload';
import { PieceList } from './piece-form';
import { pieceHints } from './piece-hints';
import {
  INSPIRATION_NOTE_MAX,
  INSPIRATION_TITLE_MAX,
  type InspirationDetail,
} from './queries';
import {
  deleteInspirationPath,
  INSPIRATION_PATH,
  inspirationPhotoPath,
  inspirationUrl,
  LOOK_PIECES_ID,
  recreateLookUrl,
} from './urls';
import type { UnreadReason } from './writes';

// public/js/share-saved.js: a share confirmation's Save lands here, so the
// shared photo it posted leaves the device now that it is saved. An inline
// module, so it runs again on a page a boosted navigation brings. A fixed
// string with nothing interpolated.
const FORGET_SAVED_SHARE = `import { forgetSavedShare } from 'share-saved';
forgetSavedShare();`;

/**
 * GET /inspiration/:id, a saved look's page (#22): its photo (or the way to
 * add one: a link saved without its photo says once why, `?unread=`), its
 * link, its title and note saved as they change (AutosaveForm), the pieces
 * the owner reads in it (piece-form.tsx, with hints from the title) and,
 * once there is one, "Recreate this look", and Delete.
 */
export function InspirationPage(props: {
  ctx: ViewContext;
  look: InspirationDetail;
  unread: UnreadReason | undefined;
}) {
  const { ctx, look, unread } = props;
  const name = lookName(look);
  const photoAction = inspirationPhotoPath(look.id);
  return (
    <Layout ctx={ctx} title={name}>
      <AppBar ctx={ctx} title={name} back={INSPIRATION_PATH} />
      <PageMain class="p-4 pt-20 pb-24 flex flex-col gap-4">
        {unread && <UnreadNote reason={unread} />}
        {look.photo ? (
          <section class="flex flex-col gap-2">
            <img
              src={inspirationPhotoUrl(look.photo, 'original')}
              alt={t('inspiration.PHOTO_ALT', { title: name })}
              class="w-full rounded-box bg-base-200"
              decoding="async"
            />
            <LookPhotoUpload
              action={photoAction}
              source="library"
              label={t('inspiration.CHANGE_PHOTO')}
            />
          </section>
        ) : (
          <section
            class="flex flex-col gap-3 rounded-box bg-base-200 p-4"
            aria-labelledby="look-no-photo"
          >
            <p id="look-no-photo" class="text-sm text-muted">
              {t('inspiration.NO_PHOTO')}
            </p>
            <div class="flex gap-2">
              <LookPhotoUpload action={photoAction} source="camera" />
              <LookPhotoUpload action={photoAction} source="library" />
            </div>
          </section>
        )}
        {look.sourceUrl && (
          // Only ever http(s) (linkIn, and the column's check). A new tab, so
          // the app stays where it was; noopener keeps the page from
          // reaching back into this one, noreferrer from learning its URL.
          <a
            href={look.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="link link-primary text-sm self-start"
          >
            {t('inspiration.OPEN_LINK', { host: linkHost(look.sourceUrl) })}
          </a>
        )}
        <AutosaveForm
          action={inspirationUrl(look.id)}
          native
          class="flex flex-col gap-3"
        >
          <FormField id="look-title" label={t('inspiration.TITLE')}>
            <input
              {...inputAttributes('look-title', 'w-full')}
              type="text"
              name="title"
              value={look.title ?? ''}
              maxlength={INSPIRATION_TITLE_MAX}
              placeholder={t('inspiration.UNTITLED')}
            />
          </FormField>
          <FormField id="look-note" label={t('inspiration.NOTE')}>
            <textarea
              id="look-note"
              name="note"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={INSPIRATION_NOTE_MAX}
              placeholder={t('inspiration.NOTE_PLACEHOLDER')}
            >
              {look.note ?? ''}
            </textarea>
          </FormField>
        </AutosaveForm>
        <section
          id={LOOK_PIECES_ID}
          class="flex flex-col gap-3 scroll-mt-20"
          aria-labelledby="look-pieces-title"
        >
          <div>
            <h2 id="look-pieces-title" class="font-semibold">
              {t('inspiration.PIECES')}
            </h2>
            <p class="text-xs text-muted">{t('inspiration.PIECES_HINT')}</p>
          </div>
          <PieceList
            lookId={look.id}
            pieces={look.pieces}
            hints={pieceHints(look.title, look.pieces)}
          />
          {look.pieces.length > 0 && (
            <a href={recreateLookUrl(look.id)} class="btn btn-primary">
              {t('inspiration.RECREATE')}
            </a>
          )}
        </section>
        <PostForm
          action={deleteInspirationPath(look.id)}
          confirm={t('inspiration.DELETE_CONFIRM')}
          class="mt-6"
        >
          <button type="submit" class="btn btn-error btn-outline btn-sm w-full">
            {t('inspiration.DELETE')}
          </button>
        </PostForm>
        <script
          type="module"
          dangerouslySetInnerHTML={{ __html: FORGET_SAVED_SHARE }}
        />
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** Why a pasted link came without its photo, and the way round it. */
function UnreadNote({ reason }: { reason: UnreadReason }) {
  return (
    <div role="status" class="alert alert-warning alert-soft text-sm">
      <span class="flex flex-col gap-1">
        <span>
          {reason === 'no-photo'
            ? t('inspiration.UNREAD_NO_PHOTO')
            : `${t('inspiration.UNREAD')} ${t(REFUSALS[reason].message)}`}
        </span>
        <span>{t('inspiration.UNREAD_HINT')}</span>
      </span>
    </div>
  );
}
