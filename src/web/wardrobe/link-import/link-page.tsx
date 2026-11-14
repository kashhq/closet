import { PostForm } from '../../form';
import { FormField, inputAttributes } from '../../form-field';
import { t } from '../../i18n';
import { AppBar } from '../../layout/app-bar';
import { Dock } from '../../layout/dock';
import { Layout } from '../../layout/layout';
import { INSPIRATION_LINK_PATH } from '../../inspiration/urls';
import type { ViewContext } from '../../view-context';
import {
  type Destination,
  destinationParams,
  LINK_IMPORT_PATH,
  wardrobeUrl,
  WISHLIST_PATH,
} from '../urls';
import { LINK_INPUT_MAX } from './link-text';

export interface LinkPageModel {
  /** The link in the field: shared into the app, or as last typed. */
  link: string;
  viewOwner: number | undefined;
  /** Where the garment lands: carried to the form in the post's URL. */
  destination: Destination;
  /** Why the last try was refused (a sentence without hosts or addresses). */
  error?: string;
}

/**
 * GET /wardrobe/new/from-link (and where the manifest's share target sends
 * a link), and the same page again with the message when the link was
 * refused. A native post (PostForm): a refusal answers 4xx or 5xx with
 * this page again, and success is the whole garment form page. On the
 * person's own closet (a share lands there) the same field can instead be
 * saved as a look (#22d, "Save as inspiration": POST /inspiration/link,
 * the Inspiration tab's paste); never on a wishlist's or a shared
 * wardrobe's page, since looks are the signed-in person's own.
 */
export function LinkPage(props: { ctx: ViewContext; model: LinkPageModel }) {
  const { ctx, model } = props;
  const { viewOwner, destination } = model;
  const messages = model.error ? [model.error] : undefined;
  const wishlist = destination.to === 'wishlist';
  const offersInspiration = !wishlist && viewOwner === undefined;
  const title = t(
    wishlist ? 'wishlist.ADD_FROM_LINK_TITLE' : 'linkImport.TITLE',
  );
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar
        ctx={ctx}
        title={title}
        back={wardrobeUrl(
          viewOwner,
          {},
          wishlist ? WISHLIST_PATH : '/wardrobe/new',
        )}
        formPage
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <p class="text-sm text-muted mb-4">{t('linkImport.INTRO')}</p>
        <PostForm
          action={wardrobeUrl(
            viewOwner,
            destinationParams(destination),
            LINK_IMPORT_PATH,
          )}
          class="flex flex-col gap-4"
        >
          <FormField
            id="link-url"
            label={t('linkImport.URL_LABEL')}
            messages={messages}
          >
            {/* Text, not type="url": a pasted "Product title https://…" is
                valid input (linkIn finds the link), and the browser's URL
                validation would refuse it before the post. */}
            <input
              {...inputAttributes('link-url', 'w-full', messages)}
              type="text"
              name="url"
              inputmode="url"
              value={model.link}
              maxlength={LINK_INPUT_MAX}
              placeholder={t('linkImport.URL_PLACEHOLDER')}
              autocomplete="off"
              required
            />
          </FormField>
          <button type="submit" class="btn btn-primary">
            {t('linkImport.FETCH')}
          </button>
          <p class="text-xs text-muted text-center">
            {t('linkImport.FETCH_HINT')}
          </p>
          {offersInspiration && (
            <>
              {/* After Fetch, so Enter still fetches (the form's default
                  button is its first). */}
              <button
                type="submit"
                formaction={INSPIRATION_LINK_PATH}
                class="btn btn-outline"
              >
                {t('linkImport.SAVE_AS_INSPIRATION')}
              </button>
              <p class="text-xs text-muted text-center">
                {t('linkImport.SAVE_AS_INSPIRATION_HINT')}
              </p>
            </>
          )}
        </PostForm>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
