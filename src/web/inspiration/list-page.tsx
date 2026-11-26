import { inspirationPhotoUrl } from '../files/image-url';
import { t } from '../i18n';
import { OUTFIT_GRID } from '../layout/columns';
import { PageShell } from '../layout/page-shell';
import { PageSentinel } from '../page-sentinel';
import { EmptyState } from '../layout/parts';
import { outfitTabs } from '../outfits/outfit-tabs';
import type { ViewContext } from '../view-context';
import { linkHost, lookName } from './look-name';
import type { InspirationSummary } from './queries';
import {
  inspirationTilesUrl,
  inspirationUrl,
  NEW_INSPIRATION_PATH,
} from './urls';

/** Tiles above the fold on a phone (two rows of two): their images load at once. */
const EAGER_TILES = 4;

/**
 * GET /inspiration, the Outfits page's Inspiration tab (#22): the owner's
 * saved looks, newest first, as a two-column grid like Saved's. A tile is
 * the look's photo (its whole picture, cropped to the tile's 4:5 frame) or,
 * for a link saved without one, the link's site; it opens the look's page.
 * Images come from GET /inspiration/photo/*, served to their owner alone.
 * A page holds LOOK_PAGE_SIZE looks; a sentinel after the last fetches the
 * next (GET /inspiration/tiles, #528).
 */
export function InspirationListPage(props: {
  ctx: ViewContext;
  looks: InspirationSummary[];
  next: number | null;
}) {
  const { ctx, looks, next } = props;
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
        tabs: outfitTabs('inspiration'),
      }}
      width="wide"
      body={{ gap: 3 }}
    >
      {looks.length === 0 ? (
        <EmptyState message={t('inspiration.EMPTY')}>
          <a href={NEW_INSPIRATION_PATH} class="btn btn-primary btn-sm">
            {t('inspiration.ADD_FIRST')}
          </a>
        </EmptyState>
      ) : (
        <ul id="inspiration-looks" class={OUTFIT_GRID}>
          <LookTiles looks={looks} next={next} firstPage={true} />
        </ul>
      )}
    </PageShell>
  );
}

/**
 * The grid's tiles and, while more follow, the sentinel that fetches them
 * (also GET /inspiration/tiles' whole answer). Only the first page's top
 * tiles load eagerly.
 */
export function LookTiles(props: {
  looks: InspirationSummary[];
  next: number | null;
  firstPage: boolean;
}) {
  return (
    <>
      {props.looks.map((look, index) => (
        <li>
          <a
            href={inspirationUrl(look.id)}
            class="flex flex-col gap-1.5"
            data-inspiration-id={look.id}
          >
            <LookTile
              look={look}
              eager={props.firstPage && index < EAGER_TILES}
            />
            <span class="text-sm font-medium truncate px-0.5">
              {lookName(look)}
            </span>
          </a>
        </li>
      ))}
      {props.next !== null && (
        <PageSentinel
          as="li"
          class="col-span-full flex justify-center py-6"
          href={inspirationTilesUrl(props.next)}
          trigger="revealed"
          marker="inspiration"
        />
      )}
    </>
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
