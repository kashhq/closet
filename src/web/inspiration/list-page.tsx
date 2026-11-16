import { inspirationPhotoUrl } from '../files/image-url';
import { t } from '../i18n';
import { OUTFIT_GRID } from '../layout/columns';
import { PageShell } from '../layout/page-shell';
import { EmptyState } from '../layout/parts';
import { OutfitTabs } from '../outfits/outfit-tabs';
import type { ViewContext } from '../view-context';
import { linkHost, lookName } from './look-name';
import type { InspirationSummary } from './queries';
import { inspirationUrl, NEW_INSPIRATION_PATH } from './urls';

/** Tiles above the fold on a phone (two rows of two): their images load at once. */
const EAGER_TILES = 4;

/**
 * GET /inspiration, the Outfits page's Inspiration tab (#22): the owner's
 * saved looks, newest first, as a two-column grid like Saved's. A tile is
 * the look's photo (its whole picture, cropped to the tile's 4:5 frame) or,
 * for a link saved without one, the link's site; it opens the look's page.
 * Images come from GET /inspiration/photo/*, served to their owner alone.
 */
export function InspirationListPage(props: {
  ctx: ViewContext;
  looks: InspirationSummary[];
}) {
  const { ctx, looks } = props;
  return (
    <PageShell
      ctx={ctx}
      name="inspiration"
      bar={{
        title: t('OUTFITS'),
        actions: (
          <a href={NEW_INSPIRATION_PATH} class="btn btn-primary btn-sm">
            + {t('inspiration.ADD')}
          </a>
        ),
      }}
      width="wide"
      body={{ gap: 3 }}
    >
      <OutfitTabs active="inspiration" />
      {looks.length === 0 ? (
        <EmptyState message={t('inspiration.EMPTY')}>
          <a href={NEW_INSPIRATION_PATH} class="btn btn-primary btn-sm">
            {t('inspiration.ADD_FIRST')}
          </a>
        </EmptyState>
      ) : (
        <ul id="inspiration-looks" class={OUTFIT_GRID}>
          {looks.map((look, index) => (
            <li>
              <a
                href={inspirationUrl(look.id)}
                class="flex flex-col gap-1.5"
                data-inspiration-id={look.id}
              >
                <LookTile look={look} eager={index < EAGER_TILES} />
                <span class="text-sm font-medium truncate px-0.5">
                  {lookName(look)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

/** The tile's picture: the look's thumb, or its link's site on a plain card. */
function LookTile(props: { look: InspirationSummary; eager: boolean }) {
  const { look } = props;
  if (look.photo) {
    return (
      <img
        src={inspirationPhotoUrl(look.photo, 'thumb')}
        alt=""
        class="aspect-[4/5] w-full rounded-box object-cover bg-base-200"
        width="400"
        height="500"
        loading={props.eager ? 'eager' : 'lazy'}
        decoding="async"
      />
    );
  }
  return (
    <span class="aspect-[4/5] w-full rounded-box bg-base-200 flex flex-col items-center justify-center gap-1 p-3 text-center">
      <span class="text-sm font-medium break-all">
        {look.sourceUrl && linkHost(look.sourceUrl)}
      </span>
      <span class="text-xs text-muted">{t('inspiration.LINK_ONLY')}</span>
    </span>
  );
}
