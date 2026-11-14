import type { Child } from 'hono/jsx';
import { PostForm } from '../auth/form';
import { type DayChoice, plannedNote } from '../calendar/day-choice';
import { shortDayLabel } from '../date-labels';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { OUTFIT_GRID } from '../layout/columns';
import { PageMain } from '../layout/page-main';
import { EmptyState } from '../layout/parts';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import { collagePieces, OutfitCollage } from './collage';
import { DayDestinationLine } from './destination-views';
import type { DayDestination } from './destination';
import { OutfitTabs } from './outfit-tabs';
import { AgentBadge } from '../agent-badge';
import type { OutfitActivity, GarmentOutfit, SavedOutfit } from './queries';
import type { OutfitCount } from '../../wardrobe/goes-with';
import {
  type DecisionToast,
  DecisionToastView,
} from '../wishlist/suggestion-parts';
import { MuseSection } from './muse-cards';
import type { MuseOutfit } from './proposals';
import { buyFirstNote, toBuyLine } from './to-buy';
import { type OutfitList, OutfitListTabs } from './outfit-list';
import { outfitUrl, savedTilesUrl, savedUrl } from './urls';
import { PageSentinel } from '../page-sentinel';

/** Tiles above the fold on a phone (two rows of two): their images load at once. */
const EAGER_TILES = 4;

export interface SavedModel {
  /** A page of the owner's outfits of `list`, newest first (#660: OUTFIT_PAGE_SIZE). */
  outfits: SavedOutfit[];
  /** The id the next page starts below; null on the last. */
  next: number | null;
  /** `?show=` (#659): the kept outfits, or the one-offs ("Worn and planned"). */
  list: OutfitList;
  /** Worn counts and next plans, by outfit id (absent: never planned). */
  activity: Map<number, OutfitActivity>;
  /**
   * `?for=day:` (R5): the grid picks an outfit for that day (the
   * calendar's "Pick a saved outfit"). `destination` carries `replace`
   * only while that entry can still change (pickDestination).
   */
  picking?: { destination: DayDestination; choice: DayChoice };
  /**
   * Muse's outfits not the owner's yet, and what their pieces to buy
   * unlock (#335): the From Muse section above the grid. Never read while
   * picking.
   */
  muse: { outfits: MuseOutfit[]; unlocks: Map<number, OutfitCount> };
  /** A reaction's toast (`?decided=`). */
  toast: DecisionToast | undefined;
}

/** What a page of tiles needs: GET /outfits' grid, and its sentinel's GET /outfits/tiles alone. */
export type SavedTilesModel = Pick<
  SavedModel,
  'outfits' | 'next' | 'list' | 'activity' | 'picking'
>;

/**
 * GET /outfits, the Outfits page's Saved tab (redesign plan, "Outfits"):
 * the outfits as a two-column grid of collage tiles (OutfitCollage `tile`),
 * a page at a time (#660: the sentinel fetches the next, SavedTiles), with
 * its name, how often it was worn and when it is next planned. You
 * search what you saved, so it is a grid; Ideas, one idea at a time, is a
 * strip. A tile opens the outfit, where Plan picks a day; the per-card
 * calendar dropdown is gone (R5).
 *
 * With `?for=day:D&occasion=O[&replace=E]` the grid picks for that day: one
 * native PostForm to POST /calendar (as the plan page's list), each tile a
 * submit button; an outfit already on the day is disabled and says for
 * which occasion, and an incomplete one (a piece not bought yet, #335) says
 * to buy it first. Without a query the page is a stale-while-revalidate tab
 * root: it renders the same bytes while nothing changes (the activity line
 * depends on the day, never the hour).
 */
export function OutfitsPage(props: { ctx: ViewContext; model: SavedModel }) {
  const { ctx, model } = props;
  const destination = model.picking?.destination;
  return (
    <Layout ctx={ctx} title={t('OUTFITS')}>
      <AppBar
        ctx={ctx}
        title={t('OUTFITS')}
        actions={
          <a href={stylingUrl({ destination })} class="btn btn-primary btn-sm">
            + {t('styling.NEW')}
          </a>
        }
      />
      <PageMain width="wide" class="p-4 pt-20 pb-24 flex flex-col gap-3">
        <OutfitTabs active="saved" destination={destination} />
        {model.picking && (
          <PickingHeader destination={model.picking.destination} />
        )}
        {!model.picking && <MuseSection {...model.muse} />}
        {!model.picking && model.muse.outfits.length > 0 && (
          <h2 class="font-semibold px-1 pt-2">{t('outfits.muse.YOURS')}</h2>
        )}
        <OutfitListTabs
          list={model.list}
          href={savedUrl(destination ?? { kind: 'none' })}
        />
        <SavedGrid model={model} destination={destination} />
      </PageMain>
      <DecisionToastView toast={model.toast} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** The Saved grid: none yet, the pick for a day, or the first page of tiles. */
function SavedGrid({
  model,
  destination,
}: {
  model: SavedModel;
  destination: DayDestination | undefined;
}) {
  if (model.outfits.length === 0) {
    return model.list === 'kept' ? (
      <NoOutfits destination={destination} />
    ) : (
      <p class="text-sm text-muted px-2">{t('outfits.NO_ONE_OFFS')}</p>
    );
  }
  if (model.picking) {
    return <PickingGrid model={model} picking={model.picking} />;
  }
  return (
    <ul id="saved-outfits" class={OUTFIT_GRID}>
      <SavedTiles model={model} firstPage />
    </ul>
  );
}

/**
 * One page of the grid's tiles and, when there are more, the sentinel that
 * fetches the next (GET /outfits/tiles, which answers with this alone, so
 * the page lands inside the same list and, while picking, the same form).
 * Each tile opens its outfit, or while picking for a day is that form's
 * submit button.
 */
export function SavedTiles(props: {
  model: SavedTilesModel;
  firstPage: boolean;
}) {
  const { model } = props;
  const { picking } = model;
  return (
    <>
      {model.outfits.map((outfit, index) => {
        const eager = props.firstPage && index < EAGER_TILES;
        return picking ? (
          <PickingTile
            outfit={outfit}
            eager={eager}
            picking={picking}
            activity={model.activity.get(outfit.id)}
          />
        ) : (
          <li>
            <a
              href={outfitUrl(outfit.id)}
              class="flex flex-col gap-1.5"
              data-outfit-id={outfit.id}
            >
              <OutfitTile
                outfit={outfit}
                eager={eager}
                line={
                  toBuyLine(outfit.garments) ??
                  activityLine(model.activity.get(outfit.id))
                }
              />
            </a>
          </li>
        );
      })}
      {model.next !== null && (
        <PageSentinel
          as="li"
          class="col-span-full flex justify-center py-6"
          href={savedTilesUrl(
            picking?.destination ?? { kind: 'none' },
            model.list,
            model.next,
          )}
          trigger="revealed"
          marker="saved"
          label={t('outfits.LOADING_MORE')}
        />
      )}
    </>
  );
}

/** What the grid is picking for, the way back, and that picking needs a connection. */
function PickingHeader({ destination }: { destination: DayDestination }) {
  return (
    <div class="flex flex-col gap-2 px-2">
      <DayDestinationLine destination={destination} />
      <p class="text-sm text-muted">{t('outfits.PICK_PROMPT')}</p>
      <p
        data-offline-note=""
        class="alert alert-warning alert-soft py-2 text-sm"
        role="note"
      >
        {t('outfits.OFFLINE_PICK')}
      </p>
    </div>
  );
}

/**
 * The grid as one form: a tap on a tile posts its outfit for the day, and
 * POST /calendar answers with the week (or, with `replace`, puts it in that
 * entry's place, replaceEntryOutfit). Each tile is its name's submit
 * button stretched over the tile (the stretched-link pattern: a button may
 * hold only phrasing content, and the collage is blocks).
 */
function PickingGrid(props: {
  model: SavedModel;
  picking: NonNullable<SavedModel['picking']>;
}) {
  const { destination } = props.picking;
  return (
    <PostForm action="/calendar">
      <input type="hidden" name="date" value={destination.day} />
      <input type="hidden" name="occasion" value={destination.occasion} />
      <input type="hidden" name="week" value={destination.day} />
      {destination.replace !== undefined && (
        <input
          type="hidden"
          name="replace"
          value={String(destination.replace)}
        />
      )}
      <ul id="saved-outfits" class={OUTFIT_GRID}>
        <SavedTiles model={props.model} firstPage />
      </ul>
    </PostForm>
  );
}

/** A tile of the picking grid: its name the submit button, disabled saying why when it cannot be picked. */
function PickingTile(props: {
  outfit: SavedOutfit;
  eager: boolean;
  picking: NonNullable<SavedModel['picking']>;
  activity: OutfitActivity | undefined;
}) {
  const { outfit } = props;
  // Already on the day, or incomplete (#335): it cannot be picked.
  const note =
    plannedNote(props.picking.choice, outfit.id) ??
    buyFirstNote(outfit.garments);
  return (
    <li class="relative" data-outfit-id={outfit.id}>
      <OutfitTile
        outfit={outfit}
        eager={props.eager}
        line={note ?? activityLine(props.activity)}
        dimmed={note !== undefined}
        name={
          <button
            type="submit"
            name="outfitId"
            value={String(outfit.id)}
            class="block w-full text-left truncate after:absolute after:inset-0 after:rounded-box focus-visible:after:outline-2 focus-visible:after:outline-primary"
            disabled={note !== undefined}
          >
            {outfitName(outfit)}
          </button>
        }
      />
    </li>
  );
}

/**
 * One tile: the collage on the plinth, the name and a line under it (the
 * activity, or why it cannot be picked). `name` replaces the plain name
 * where the name is the control (the picking grid's button). A disabled
 * tile dims its collage only: text is never dimmed (Conventions).
 */
function OutfitTile(props: {
  outfit: SavedOutfit;
  eager: boolean;
  line: string | undefined;
  dimmed?: boolean;
  name?: Child;
}) {
  const { outfit, line } = props;
  return (
    <>
      <div class={props.dimmed ? 'opacity-50' : undefined}>
        <OutfitCollage
          garments={collagePieces(outfit.garments, { warn: false })}
          size="tile"
          eager={props.eager}
        />
      </div>
      <span class="flex flex-col min-w-0 px-0.5">
        <span class="text-sm font-medium truncate">
          {props.name ?? outfitName(outfit)}
        </span>
        {line && <span class="text-xs text-muted truncate">{line}</span>}
        {outfit.agent && !outfit.proposed && (
          <span class="flex">
            <AgentBadge agent={outfit.agent} byMuse={outfit.proposed} />
          </span>
        )}
      </span>
    </>
  );
}

/** "Planned Oct 3 · Worn 4×", what is known; undefined for neither. */
function activityLine(
  activity: OutfitActivity | undefined,
): string | undefined {
  if (!activity) return undefined;
  const parts = [
    activity.nextPlanned &&
      t('outfits.PLANNED_ON', { day: shortDayLabel(activity.nextPlanned) }),
    activity.wornCount > 0 &&
      t('outfits.WORN_TIMES', { count: activity.wornCount }),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function outfitName(outfit: GarmentOutfit): string {
  return outfit.name || t('UNTITLED_OUTFIT');
}

/** No outfit saved yet: the way to style the first (for the day being planned, if any). */
function NoOutfits({
  destination,
}: {
  destination: DayDestination | undefined;
}) {
  return (
    <EmptyState
      message={t('NO_OUTFITS')}
      icon={
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1"
          stroke="currentColor"
          class="size-16"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
          />
        </svg>
      }
    >
      <a href={stylingUrl({ destination })} class="btn btn-primary btn-sm">
        {t('ADD_FIRST_OUTFIT')}
      </a>
    </EmptyState>
  );
}
