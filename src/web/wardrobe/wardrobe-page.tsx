import type { Child } from 'hono/jsx';
import {
  CONDITIONS,
  FITS,
  FORMALITIES,
  GARMENT_COLORS,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  GarmentCategory,
  SLEEVES,
  typesOf,
  WARMTHS,
} from '../../wardrobe/properties';
import { ShownId } from '../checklist';
import { CARE_WASH } from '../../wardrobe/care';
import { garmentMarks } from '../../wardrobe/marks';
import { PostForm } from '../auth/form';
import { Chips } from '../form-field';
import type { CapsuleRef } from '../capsules/queries';
import { type StringKey, t } from '../i18n';
import { PageSentinel } from '../page-sentinel';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { GALLERY_GRID } from '../layout/columns';
import { GarmentMark } from '../layout/garment-mark';
import { PageColumn, PageMain } from '../layout/page-main';
import {
  EmptyState,
  PlinthImage,
  SavedToast,
  SheetBackdrop,
  StripFlags,
} from '../layout/parts';
import type { SharedWardrobe } from '../sharing/access';
import type { ViewContext } from '../view-context';
import { WeatherSlot } from '../weather/views';
import { categoryLabel } from './garment';
import { type LabelledProperty, valueLabel } from './labels';
import { type GridCursor, gridCursorText } from './grid-cursor';
import type { FilterOptions, GarmentTile, GridPage } from './queries';
import {
  capsuleUrl,
  draftUrl,
  garmentUrl,
  idListValue,
  LAUNDRY_PATH,
  TAG_PATH,
  wardrobeUrl,
} from './urls';
import { BULK_PROPERTIES, type BulkProperty } from './grid-schemas';
import { WardrobeHeader, WardrobeMenu, WardrobeTabs } from './wardrobe-header';

/**
 * The grid's filters as the page echoes them into its links and forms. The
 * keys are the query parameters' names ('' for not set).
 */
export interface GridSearch {
  keyword: string;
  category: string;
  color: string;
  size: string;
  /** A type of `category`; '' without one. */
  type: string;
  warmth: string;
  formality: string;
  material: string;
  /** The care label's wash (#23). */
  wash: string;
  /** 'true' when archived garments are shown too; '' otherwise. */
  archived: string;
  /** A capsule's id: its members only. */
  capsule: string;
  /** 'true': a copy needs a wash (the owner's own wardrobe only). */
  needsWash: string;
  /** 'true': condition not good. */
  attention: string;
}

/** No filter at all: the whole closet (the capsule page spreads it with its id). */
export const EMPTY_SEARCH: GridSearch = {
  keyword: '',
  category: '',
  color: '',
  size: '',
  type: '',
  warmth: '',
  formality: '',
  material: '',
  wash: '',
  archived: '',
  capsule: '',
  needsWash: '',
  attention: '',
};

/**
 * The capsule picker (`?pick=`): select mode whose checkboxes are the
 * capsule's membership. Members (each tile's `member`, read with the page)
 * start checked, and every tile says it was shown (a hidden `shown`), so
 * the post changes only what the picker showed (POST /capsules/:id/garments).
 */
export interface Picking {
  capsuleId: number;
}

/**
 * The grid and what surrounds it (GridContext, read in one statement). In
 * select mode and the picker only the tiles and the capsules are read; the
 * rest render nowhere there and are empty.
 */
export interface WardrobeModel {
  search: GridSearch;
  page: GridPage;
  /** Garments matching the filters, all pages together. */
  count: number;
  options: FilterOptions;
  sharedWardrobes: SharedWardrobe[];
  /** The shared wardrobe shown; undefined for the requester's own. */
  viewOwner: number | undefined;
  canEdit: boolean;
  /** The requester's own wardrobe: wash state and away show (never a share's). */
  ownerView: boolean;
  /** Garments still needing their type, warmth or formality (0 for a viewer). */
  toTag: number;
  /** Garments with a copy that needs a wash (0 on a shared wardrobe). */
  toWash: number;
  /** Select mode (?select=1, or the picker): tiles are checkboxes. */
  selecting: boolean;
  /** Select mode as the capsule picker; the capsule's name for the bar's title. */
  picking?: Picking & { name: string };
  /** The wardrobe's capsules: the scope row's choices. */
  capsules: CapsuleRef[];
  /** After one of select mode's verbs: its toast. */
  bulkOutcome?: BulkOutcome;
  /**
   * The requester's drafts waiting for this wardrobe (#200): the prompt
   * to continue them, from the first (someone who can add only).
   */
  drafts?: { count: number; first: string };
  /**
   * Select mode at a batch's end (#200, `?checked=`): the garments the
   * draft queue saved, checked where the first page shows them.
   */
  batchSaved: ReadonlySet<number>;
  /** Select mode after a verb (#677): what it acted on, checked again. */
  selection: Selection;
}

/**
 * Select mode's selection as a verb's redirect brings it back: the ids it
 * acted on, or `all`, every garment of the filters ("Select all N").
 */
export interface Selection {
  ids: ReadonlySet<number>;
  all: boolean;
}

const NO_SELECTION: Selection = { ids: new Set(), all: false };

/** What a select-mode verb did, for its toast (the redirect's flags). */
export type BulkOutcome =
  | { verb: 'set' | 'wash'; count: number; skipped: number }
  | { verb: 'archive' | 'capsule'; count: number };

/** The one-shot flags select mode's verbs' redirects carry (GridQuery). */
const BULK_FLAGS = [
  'bulkUpdated',
  'bulkSkipped',
  'bulkArchived',
  'bulkWashed',
  'bulkAdded',
] as const;

/** The draft queue's end (#200, batchDoneUrl): its garments, checked once. */
const BATCH_FLAGS = ['checked'] as const;

/** Tiles above the fold on a phone load eagerly; the rest when scrolled near. */
const EAGER_TILES = 8;

// Filter links and the search form replace #wardrobe-main and push the URL;
// their href/action keep them working without JavaScript.
const SWAP_MAIN = {
  'hx-target': '#wardrobe-main',
  'hx-swap': 'outerHTML',
  'hx-push-url': 'true',
} as const;

/**
 * The filters as query parameters (empty ones are left out of URLs). It
 * also renders hidden inputs in the search form, so a key added to
 * GridSearch lands in the page: only filters belong there.
 */
export function searchParams(search: GridSearch): Record<string, string> {
  return { ...search };
}

/**
 * GET /wardrobe: the Closet tab (docs/plans/2026-09-26-redesign.md, section
 * 3, "Wardrobe"). Browsing, it is the Wardrobe's header (the switcher in
 * the title, ⋯ and ＋), the tabs, today's weather (#14; outside
 * #wardrobe-main, so filtering never reloads it) and the swappable main.
 * Select mode and the capsule picker are tasks, not the closet: their own
 * bar (the task's title and Cancel) over the checkbox grid, no tabs.
 */
export function WardrobePage(props: {
  ctx: ViewContext;
  model: WardrobeModel;
}) {
  const { ctx, model } = props;
  return (
    <Layout ctx={ctx} title={t('WARDROBE')}>
      {model.selecting ? (
        <TaskBar ctx={ctx} model={model} />
      ) : (
        <WardrobeHeader
          ctx={ctx}
          tab="closet"
          viewOwner={model.viewOwner}
          sharedWardrobes={model.sharedWardrobes}
          canEdit={model.canEdit}
          selectUrl={selectUrl(model)}
        />
      )}
      <div class="pt-16">
        {!model.selecting && (
          <PageColumn width="wide">
            <WardrobeTabs active="closet" viewOwner={model.viewOwner} />
            <div class="px-2 pt-3">
              <WeatherSlot ctx={ctx} />
            </div>
          </PageColumn>
        )}
        <WardrobeMain model={model} />
      </div>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * GET /wardrobe's answer to a fragment request (the scope row's search,
 * chips and scope menu, the filter modal): the main, and the ⋯ menu out
 * of band, so its Select keeps the filters the grid now shows.
 */
export function WardrobeFragment({
  ctx,
  model,
}: {
  ctx: ViewContext;
  model: WardrobeModel;
}) {
  return (
    <>
      <WardrobeMain model={model} />
      {!model.selecting && (
        <WardrobeMenu
          viewOwner={model.viewOwner}
          canEdit={model.canEdit}
          selectUrl={selectUrl(model)}
          orders={ctx.orderReview}
          oob
        />
      )}
    </>
  );
}

/** The ⋯ menu's Select: into select mode on the grid as filtered. */
function selectUrl(model: WardrobeModel): string | undefined {
  if (!model.canEdit || model.page.tiles.length === 0) return undefined;
  return wardrobeUrl(model.viewOwner, {
    ...searchParams(model.search),
    select: '1',
  });
}

/**
 * Select mode's and the picker's bar: what the task is, and Cancel back
 * to where it began (the grid as filtered, or the picker's capsule).
 */
function TaskBar(props: { ctx: ViewContext; model: WardrobeModel }) {
  const { search, viewOwner, picking } = props.model;
  const cancel = picking
    ? capsuleUrl(picking.capsuleId, viewOwner)
    : wardrobeUrl(viewOwner, searchParams(search));
  return (
    <AppBar
      ctx={props.ctx}
      title={
        picking
          ? t('PICK_GARMENTS_FOR', { name: picking.name })
          : t('SELECT_GARMENTS')
      }
      actions={
        <a href={cancel} class="btn btn-ghost btn-sm">
          {t('CANCEL')}
        </a>
      }
    />
  );
}

/**
 * The swappable part of the Closet tab: the sticky scope row (the capsule
 * scope, the active filters, search, the filter sheet and the count), the
 * slim prompts, the first page of the grid and the filter modal; in select
 * mode the checkbox grid and its bar. GET /wardrobe answers htmx fragment
 * requests with this element (WardrobeFragment), so filtering and searching
 * never re-render the app bar, the tabs and the dock, and always start
 * again from the first page.
 */
function WardrobeMain({ model }: { model: WardrobeModel }) {
  const { viewOwner, selecting } = model;
  return (
    <PageMain id="wardrobe-main" width="wide" class="pb-24">
      {!selecting && <ScopeRow model={model} />}
      <div class="px-4 pt-3">
        {!selecting && <Prompts model={model} />}
        <Tiles model={model} />
      </div>
      {model.selecting && !model.picking && <BulkDialog />}
      {!selecting && (
        <FilterModal
          search={model.search}
          options={model.options}
          viewOwner={viewOwner}
          ownerView={model.ownerView}
        />
      )}
      {model.selecting && !model.picking && <BulkActions model={model} />}
      {model.bulkOutcome && <BulkToast outcome={model.bulkOutcome} />}
    </PageMain>
  );
}

/**
 * The slim prompts above the grid (the plan's "slim banner"): "4 photos
 * waiting to be added · Continue" for someone with drafts here (#200), "12
 * garments need details · Tag them" for someone who can tag, "3 garments
 * need a wash · Laundry" for the owner.
 */
function Prompts({ model }: { model: WardrobeModel }) {
  const { toTag, toWash, drafts } = model;
  return (
    <>
      {drafts && (
        <Prompt
          text={
            drafts.count === 1
              ? t('drafts.WAITING_ONE')
              : t('drafts.WAITING', { count: drafts.count })
          }
          href={draftUrl(model.viewOwner, drafts.first, [])}
          action={t('drafts.CONTINUE')}
        />
      )}
      {toTag > 0 && (
        <Prompt
          text={
            toTag === 1
              ? t('TAG_PROMPT_ONE')
              : t('TAG_PROMPT', { count: toTag })
          }
          href={wardrobeUrl(model.viewOwner, {}, TAG_PATH)}
          action={t('TAG_PROMPT_ACTION')}
        />
      )}
      {toWash > 0 && (
        <Prompt
          text={
            toWash === 1
              ? t('wear.LAUNDRY_PROMPT_ONE')
              : t('wear.LAUNDRY_PROMPT', { count: toWash })
          }
          href={LAUNDRY_PATH}
          action={t('wear.LAUNDRY')}
        />
      )}
    </>
  );
}

/** The first page: links, or checkboxes inside select mode's form (bulk or picker). */
function Tiles({ model }: { model: WardrobeModel }) {
  const { picking } = model;
  if (model.page.tiles.length === 0) return <NoTiles model={model} />;
  if (picking) {
    return (
      <PickForm model={model} picking={picking}>
        <Grid model={model} />
      </PickForm>
    );
  }
  if (model.selecting) {
    const batch = model.page.tiles.filter((tile) =>
      model.batchSaved.has(tile.id),
    ).length;
    const shown = new Set(model.page.tiles.map((tile) => tile.id));
    // A kept selection's garments this page does not show (a later page, or
    // a filter a verb's change moved them out of) still count and post.
    const carried = model.selection.all
      ? []
      : [...model.selection.ids].filter((id) => !shown.has(id));
    const checked = model.selection.all
      ? model.count
      : model.page.tiles.filter((tile) => isChecked(tile, model)).length +
        carried.length;
    return (
      <>
        {batch > 0 && (
          <>
            <p
              role="status"
              class="alert alert-success alert-soft text-sm mb-3"
            >
              {batch === 1
                ? t('drafts.DONE_ONE')
                : t('drafts.DONE', { count: batch })}
            </p>
            <StripFlags names={BATCH_FLAGS} />
          </>
        )}
        <BulkForm model={model} checked={checked}>
          <SelectAll count={model.count} checked={model.selection.all} />
          {carried.map((id) => (
            <input type="hidden" name="ids" value={id} data-carried="true" />
          ))}
          <Grid model={model} />
        </BulkForm>
      </>
    );
  }
  return <Grid model={model} />;
}

/** A select-mode tile checked as the page renders it: a batch's garment (#200), or the selection a verb kept. */
function isChecked(
  tile: GarmentTile,
  model: { batchSaved?: ReadonlySet<number>; selection?: Selection },
): boolean {
  const selection = model.selection ?? NO_SELECTION;
  return (
    selection.all ||
    selection.ids.has(tile.id) ||
    (model.batchSaved?.has(tile.id) ?? false)
  );
}

/** Whether anything but the capsule scope narrows the grid. */
function filtered(search: GridSearch): boolean {
  return Object.entries(searchParams(search)).some(
    ([name, value]) => name !== 'capsule' && value !== '',
  );
}

/**
 * No tiles: nothing matches the filters (say so, offer to clear them and
 * keep the capsule scope), or the wardrobe (or the capsule) is empty:
 * offer the first garment.
 */
function NoTiles({ model }: { model: WardrobeModel }) {
  const { search, viewOwner } = model;
  if (filtered(search)) {
    const clear = wardrobeUrl(viewOwner, { capsule: search.capsule });
    return (
      <EmptyState message={t('NO_GARMENTS_MATCH')}>
        <a href={clear} hx-get={clear} {...SWAP_MAIN} class="btn btn-sm">
          {t('CLEAR_FILTERS')}
        </a>
      </EmptyState>
    );
  }
  return (
    <EmptyState message={t('NO_GARMENTS')}>
      {model.canEdit && (
        <a
          href={wardrobeUrl(viewOwner, {}, '/wardrobe/new')}
          class="btn btn-primary btn-sm"
        >
          {t('ADD_FIRST_GARMENT')}
        </a>
      )}
    </EmptyState>
  );
}

/** One prompt: what needs doing, and the link that does it. */
function Prompt(props: { text: string; href: string; action: string }) {
  return (
    <p
      role="status"
      class="mb-3 flex items-center justify-between gap-3 rounded-box bg-base-200 px-3 py-2 text-sm"
    >
      <span>{props.text}</span>
      <a href={props.href} class="link font-medium shrink-0">
        {props.action}
      </a>
    </p>
  );
}

/**
 * The tile grid: three columns on a phone (the plan's density), more on a
 * wider screen. The capsule page draws its members in the same grid.
 */
export function GarmentGrid(props: { id: string; children: Child }) {
  return (
    <div id={props.id} class={GALLERY_GRID}>
      {props.children}
    </div>
  );
}

function Grid({ model }: { model: WardrobeModel }) {
  return (
    <GarmentGrid id="wardrobe-grid">
      <GarmentTiles
        page={model.page}
        search={model.search}
        viewOwner={model.viewOwner}
        selecting={model.selecting}
        picking={model.picking}
        batchSaved={model.batchSaved}
        selection={model.selection}
        firstPage
      />
    </GarmentGrid>
  );
}

/**
 * One page of tiles and, when there are more, the sentinel that fetches the
 * next: when it scrolls into view htmx requests GET /wardrobe/tiles with the
 * same filters and `before` where the last tile left off (GridCursor), and replaces the sentinel
 * with that page (whose own sentinel continues). The tiles route answers
 * with this component alone.
 */
export function GarmentTiles(props: {
  page: GridPage;
  search: GridSearch;
  viewOwner: number | undefined;
  /** Select mode: checkbox tiles, and the next page asked for as such. */
  selecting: boolean;
  /** The capsule picker: members checked, every tile marked shown. */
  picking?: Picking;
  /** Select mode at a batch's end: its garments checked (the first page only). */
  batchSaved?: ReadonlySet<number>;
  /** Select mode after a verb: what it acted on, checked on every page. */
  selection?: Selection;
  firstPage?: boolean;
}) {
  const { page, search, viewOwner, selecting, picking } = props;
  return (
    <>
      {page.tiles.map((tile, index) => {
        const eager = props.firstPage === true && index < EAGER_TILES;
        return selecting ? (
          <SelectTile
            tile={tile}
            eager={eager}
            checked={tile.member === true || isChecked(tile, props)}
            shown={picking !== undefined}
          />
        ) : (
          <Tile tile={tile} viewOwner={viewOwner} eager={eager} />
        );
      })}
      {page.before !== undefined && (
        <PageSentinel
          as="div"
          class="col-span-full flex justify-center py-6"
          href={tilesUrl(viewOwner, search, page.before, {
            selecting,
            picking,
            selection: props.selection,
          })}
          trigger="revealed"
          marker="wardrobe"
          label={t('LOADING_MORE')}
        />
      )}
    </>
  );
}

/**
 * The grid's next page after `before`, with the same filters: the
 * sentinel's GET, and the warm list's for the closet's later pages
 * (src/web/shell/warm-list.ts), which must be the same URL for the service
 * worker's copy to answer the scroll offline.
 */
export function tilesUrl(
  viewOwner: number | undefined,
  search: GridSearch,
  before: GridCursor,
  mode: { selecting: boolean; picking?: Picking; selection?: Selection } = {
    selecting: false,
  },
): string {
  const selection = mode.selection ?? NO_SELECTION;
  return wardrobeUrl(
    viewOwner,
    {
      ...searchParams(search),
      select: mode.selecting && !mode.picking ? '1' : undefined,
      pick: mode.picking?.capsuleId,
      // A kept selection reaches the later pages too (#677).
      selected: idListValue([...selection.ids]),
      all: selection.all ? '1' : undefined,
      before: gridCursorText(before),
    },
    '/wardrobe/tiles',
  );
}

/** A tile's one line: its name, else its category. */
function tileName(tile: GarmentTile): string {
  return tile.name ?? categoryLabel(tile.category);
}

/**
 * A tile: the garment on the plinth, 4:5, no card chrome, its marks small
 * over the corners, and one line of name under it. The name is the link's
 * text, so the photo's alt is empty rather than said twice.
 */
function Tile(props: {
  tile: GarmentTile;
  viewOwner: number | undefined;
  eager: boolean;
}) {
  const { tile } = props;
  return (
    <a
      href={garmentUrl(tile.id, props.viewOwner)}
      class="block min-w-0"
      data-tile=""
    >
      <TileContent tile={tile} eager={props.eager} class="" />
    </a>
  );
}

/**
 * A tile in select mode: a checkbox of the bulk form or the picker
 * (`ids`), the whole tile its label, the plinth ringed while checked. No
 * link: a tap selects. In the picker a hidden `shown` says the tile was on
 * screen.
 */
function SelectTile(props: {
  tile: GarmentTile;
  eager: boolean;
  checked: boolean;
  shown: boolean;
}) {
  const { tile } = props;
  return (
    <label class="group relative block min-w-0 cursor-pointer" data-tile="">
      <input
        type="checkbox"
        name="ids"
        value={String(tile.id)}
        checked={props.checked}
        class="checkbox checkbox-primary checkbox-sm absolute top-1.5 left-1.5 z-10 not-checked:bg-base-100"
        aria-label={tileName(tile)}
      />
      {props.shown && <ShownId id={tile.id} />}
      <TileContent
        tile={tile}
        eager={props.eager}
        class="group-has-[:checked]:ring-2 group-has-[:checked]:ring-primary"
      />
    </label>
  );
}

function TileContent(props: {
  tile: GarmentTile;
  eager: boolean;
  /** The plinth's extra classes (select mode's ring). */
  class: string;
}) {
  const { tile } = props;
  // An archived garment's photo (or placeholder, the plinth's first child)
  // is dimmed and badged; its name keeps its contrast (#88: dimming the
  // whole tile took the text below AA).
  const archived = tile.status === 'archived';
  return (
    <>
      <PlinthImage
        photo={tile.photo}
        category={tile.category}
        alt=""
        eager={props.eager}
        class={`aspect-[4/5] rounded-box ${archived ? '[&>:first-child]:opacity-50' : ''} ${props.class}`}
      >
        <TileMarks tile={tile} />
      </PlinthImage>
      <p class="mt-1 truncate text-xs" data-tile-name="">
        {tileName(tile)}
      </p>
    </>
  );
}

/**
 * What a tile says over its photo, small: "×3" for identical copies in the
 * bottom corner; in the top one its status mark (archived, and to the
 * owner alone away and the wash, "Wash 2/3" of a multiple: `care` is the
 * owner's grid's only), then
 * the condition when it is not good.
 */
function TileMarks({ tile }: { tile: GarmentTile }) {
  const marks = garmentMarks(
    {
      status: tile.status,
      away: tile.care?.away,
      needsWash: tile.care !== undefined && tile.care.dirty > 0,
    },
    { ownerView: tile.care !== undefined },
  );
  const worn = tile.condition !== 'good';
  return (
    <>
      {(marks.length > 0 || worn) && (
        <div class="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
          <GarmentMark
            marks={marks}
            wash={
              tile.care && { dirty: tile.care.dirty, copies: tile.quantity }
            }
          />
          {worn && (
            <span class="badge badge-xs badge-warning badge-outline bg-base-100">
              {valueLabel('condition', tile.condition)}
            </span>
          )}
        </div>
      )}
      {tile.quantity > 1 && (
        <span class="badge badge-xs badge-neutral absolute bottom-1.5 left-1.5">
          {t('QUANTITY_BADGE', { quantity: tile.quantity })}
        </span>
      )}
    </>
  );
}

/** An active filter as a pill; the link drops it and keeps the rest. */
function FilterPill(props: {
  search: GridSearch;
  viewOwner: number | undefined;
  drop: keyof GridSearch;
  class: string;
  label: string;
}) {
  const href = wardrobeUrl(props.viewOwner, {
    ...searchParams(props.search),
    [props.drop]: undefined,
  });
  return (
    <a
      href={href}
      hx-get={href}
      {...SWAP_MAIN}
      class={`badge badge-sm shrink-0 gap-1 whitespace-nowrap cursor-pointer no-underline ${props.class}`}
    >
      {props.label} &times;
    </a>
  );
}

/** The property filters' pills (a type's pill only with its category's). */
function PropertyPills(props: {
  search: GridSearch;
  viewOwner: number | undefined;
}) {
  const { search } = props;
  const pills: { drop: keyof GridSearch; label: string }[] = [];
  if (search.type) {
    pills.push({ drop: 'type', label: valueLabel('type', search.type) });
  }
  if (search.warmth) {
    pills.push({
      drop: 'warmth',
      label: `${t('PROPERTY_WARMTH')}: ${valueLabel('warmth', search.warmth)}`,
    });
  }
  if (search.formality) {
    pills.push({
      drop: 'formality',
      label: valueLabel('formality', search.formality),
    });
  }
  if (search.material) {
    pills.push({
      drop: 'material',
      label: valueLabel('materials', search.material),
    });
  }
  if (search.wash) {
    pills.push({ drop: 'wash', label: valueLabel('careWash', search.wash) });
  }
  return (
    <>
      {pills.map((pill) => (
        <FilterPill
          search={search}
          viewOwner={props.viewOwner}
          drop={pill.drop}
          class="badge-primary"
          label={pill.label}
        />
      ))}
    </>
  );
}

// The filter modal's form and its "Clear" send the search box's keyword
// along, typed or not yet searched.
const INCLUDE_KEYWORD = "#search-form [name='keyword']";

/**
 * The scope row, sticky under the app bar (the plan's replacement for the
 * fixed bar above the dock): the capsule scope, the active filters as
 * chips (each drops itself), search, the filter sheet and the count.
 * Search expands in place over the chips while it has the focus, and stays
 * open while it holds a keyword. Every filter's chip is one tone (primary,
 * as its checked choice in the modal); only the care filters keep the
 * colour of the tile mark they find (wash, attention) and archived its
 * warning.
 */
function ScopeRow({ model }: { model: WardrobeModel }) {
  const { search, viewOwner } = model;
  return (
    <div
      id="scope-row"
      class="group/scope sticky top-16 z-10 flex items-center gap-2 border-b border-base-300 bg-base-100 px-4 py-2"
    >
      {model.capsules.length > 0 && (
        <CapsuleScope
          search={search}
          viewOwner={viewOwner}
          capsules={model.capsules}
        />
      )}
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto group-has-[#search-form:focus-within]/scope:hidden">
        <FilterChips search={search} viewOwner={viewOwner} />
      </div>
      <SearchForm search={search} viewOwner={viewOwner} />
      <button
        type="button"
        onclick="document.getElementById('filter-modal').showModal()"
        class="btn btn-ghost btn-sm btn-square shrink-0"
        aria-label={t('FILTERS')}
        aria-haspopup="dialog"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          class="size-5"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75"
          />
        </svg>
      </button>
      {/* The number alone on screen; "64 results" to a screen reader. */}
      <span class="shrink-0 text-sm tabular-nums text-muted">
        <span aria-hidden="true">{model.count}</span>
        <span class="sr-only">
          {model.count} {t('RESULTS')}
        </span>
      </span>
    </div>
  );
}

/**
 * The capsule scope (plan section 1: "a capsule is a scope, not a place";
 * one control): the closet or one capsule, each swapping the grid with the
 * other filters kept, and the Capsules tab to manage them. Outside the
 * chips' scroller, which would clip its menu.
 */
function CapsuleScope(props: {
  search: GridSearch;
  viewOwner: number | undefined;
  capsules: CapsuleRef[];
}) {
  const { search, viewOwner } = props;
  const current = props.capsules.find(
    (capsule) => String(capsule.id) === search.capsule,
  );
  const scoped = (capsule: string) => {
    const href = wardrobeUrl(viewOwner, {
      ...searchParams(search),
      capsule,
    });
    return { href, 'hx-get': href, ...SWAP_MAIN };
  };
  return (
    <details class="dropdown shrink-0" id="capsule-scope">
      <summary
        class={`btn btn-sm rounded-full max-w-32 flex-nowrap ${current ? 'btn-primary' : 'btn-outline'}`}
        aria-label={t('CAPSULE')}
      >
        <span class="truncate">{current ? current.name : t('CLOSET')}</span>
        <span aria-hidden="true">▾</span>
      </summary>
      <ul class="dropdown-content menu bg-base-100 rounded-box border border-base-300 z-20 w-56 mt-1 p-2">
        <li>
          <a
            {...scoped('')}
            aria-current={current ? undefined : 'true'}
            class={current ? undefined : 'menu-active'}
          >
            {t('CLOSET')}
          </a>
        </li>
        {props.capsules.map((capsule) => (
          <li>
            <a
              {...scoped(String(capsule.id))}
              aria-current={capsule === current ? 'true' : undefined}
              class={capsule === current ? 'menu-active' : undefined}
            >
              {capsule.name}
            </a>
          </li>
        ))}
        <li class="mt-1 border-t border-base-300 pt-1">
          <a href={capsuleUrl(undefined, viewOwner)}>{t('MANAGE_CAPSULES')}</a>
        </li>
      </ul>
    </details>
  );
}

/** The active filters (the capsule is the scope's), each a chip that drops itself. */
function FilterChips(props: {
  search: GridSearch;
  viewOwner: number | undefined;
}) {
  const { search } = props;
  const pill = props;
  return (
    <>
      {search.category && (
        <FilterPill
          {...pill}
          drop="category"
          class="badge-primary capitalize"
          label={categoryLabel(search.category)}
        />
      )}
      {search.color && (
        <FilterPill
          {...pill}
          drop="color"
          class="badge-primary capitalize"
          label={search.color}
        />
      )}
      {search.size && (
        <FilterPill
          {...pill}
          drop="size"
          class="badge-primary"
          label={search.size}
        />
      )}
      <PropertyPills {...pill} />
      {search.needsWash && (
        <FilterPill
          {...pill}
          drop="needsWash"
          class="badge-info"
          label={t('wear.FILTER_NEEDS_WASH')}
        />
      )}
      {search.attention && (
        <FilterPill
          {...pill}
          drop="attention"
          class="badge-warning"
          label={t('FILTER_ATTENTION')}
        />
      )}
      {search.archived && (
        <FilterPill
          {...pill}
          drop="archived"
          class="badge-warning"
          label={t('ARCHIVED')}
        />
      )}
    </>
  );
}

/**
 * Search, collapsed to its icon until tapped: the field grows over the
 * chips while it has the focus (the row's group-has rule hides them) and
 * keeps some width while it holds a keyword. Enter submits; every other
 * filter rides along as a hidden field.
 */
function SearchForm(props: {
  search: GridSearch;
  viewOwner: number | undefined;
}) {
  const { search, viewOwner } = props;
  return (
    <form
      method="get"
      action="/wardrobe"
      hx-get="/wardrobe"
      {...SWAP_MAIN}
      id="search-form"
      role="search"
      class="flex shrink-0 justify-end focus-within:flex-1"
    >
      {Object.entries(searchParams(search))
        .filter(([name, value]) => name !== 'keyword' && value !== '')
        .map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
      {viewOwner !== undefined && (
        <input type="hidden" name="ownerId" value={viewOwner} />
      )}
      <label class="input input-sm w-9 gap-1 px-2 transition-[width] duration-150 focus-within:w-full has-[input:not(:placeholder-shown)]:w-32 motion-reduce:transition-none">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          class="size-4 shrink-0"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
        <input
          type="text"
          name="keyword"
          value={search.keyword}
          maxlength={200}
          placeholder={t('SEARCH_PLACEHOLDER')}
          aria-label={t('SEARCH')}
          enterkeyhint="search"
          class="min-w-0 grow"
        />
      </label>
    </form>
  );
}

/**
 * The filters as a GET form of their own: applying submits it into
 * #wardrobe-main like the search form (the swap takes the open dialog with
 * it), with the search box's keyword; "Clear" asks for the grid with only
 * the keyword and the capsule scope. Without JavaScript it is a plain GET
 * to /wardrobe.
 */
function FilterModal(props: {
  search: GridSearch;
  options: FilterOptions;
  viewOwner: number | undefined;
  ownerView: boolean;
}) {
  const { search, options, viewOwner } = props;
  return (
    <dialog
      id="filter-modal"
      class="modal modal-bottom sm:modal-middle"
      aria-labelledby="filter-modal-title"
    >
      {/* group/filter: the chosen category reveals its type chips (TYPE_GROUP_REVEAL). */}
      <form
        method="get"
        action="/wardrobe"
        hx-get="/wardrobe"
        hx-include={INCLUDE_KEYWORD}
        {...SWAP_MAIN}
        class="modal-box group/filter"
      >
        <h3 id="filter-modal-title" class="font-bold text-lg mb-4">
          {t('FILTERS')}
        </h3>
        {viewOwner !== undefined && (
          <input type="hidden" name="ownerId" value={viewOwner} />
        )}
        {/* The capsule is the scope row's: it rides along, kept by Clear too. */}
        {search.capsule && (
          <input type="hidden" name="capsule" value={search.capsule} />
        )}
        <FilterGroup id="filter-category" title={t('CATEGORY')}>
          <Chips
            name="category"
            options={options.categories}
            selected={search.category}
            label={(category) => sentenceCase(categoryLabel(String(category)))}
          />
        </FilterGroup>
        <FilterGroup id="filter-color" title={t('COLOR')}>
          <Chips
            name="color"
            options={GARMENT_COLORS}
            selected={search.color}
            label={(color) => sentenceCase(String(color))}
          />
        </FilterGroup>
        {options.sizes.length > 0 && (
          <FilterGroup id="filter-size" title={t('SIZE')}>
            <Chips
              name="size"
              options={options.sizes}
              selected={search.size}
              label={String}
            />
          </FilterGroup>
        )}
        <PropertyFilterGroups search={search} options={options} />
        <FilterGroup id="filter-care" title={t('CARE')}>
          {/* Wears are the owner's own: a share offers no wash filter. */}
          {props.ownerView && (
            <Toggle
              name="needsWash"
              checked={search.needsWash !== ''}
              label={t('wear.FILTER_NEEDS_WASH')}
            />
          )}
          <Toggle
            name="attention"
            checked={search.attention !== ''}
            label={t('FILTER_ATTENTION')}
          />
        </FilterGroup>
        <FilterGroup id="filter-archived" title={t('ARCHIVED')}>
          <Toggle
            name="archived"
            checked={search.archived !== ''}
            label={t('SHOW_ARCHIVED')}
          />
        </FilterGroup>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            hx-get={wardrobeUrl(viewOwner, { capsule: search.capsule })}
            hx-include={INCLUDE_KEYWORD}
            {...SWAP_MAIN}
          >
            {t('CLEAR_FILTERS')}
          </button>
          <button type="submit" class="btn btn-primary btn-sm">
            {t('APPLY_FILTERS')}
          </button>
        </div>
      </form>
      <SheetBackdrop label={t('CLOSE')} />
    </dialog>
  );
}

// Each built-in category's type group shows while that category's chip is
// checked: a :has() on the form (`group/filter`), no script, so "Tops, Shirt"
// takes no Apply between. Tailwind reads whole class strings, hence the
// literal table; the Record makes a new category a type error here.
const TYPE_GROUP_REVEAL: Record<GarmentCategory, string> = {
  [GarmentCategory.ACCESSORIES]:
    'group-has-[input[name=category][value=accessories]:checked]/filter:block',
  [GarmentCategory.BAGS]:
    'group-has-[input[name=category][value=bags]:checked]/filter:block',
  [GarmentCategory.OUTERWEAR]:
    'group-has-[input[name=category][value=outerwear]:checked]/filter:block',
  [GarmentCategory.DRESSES]:
    'group-has-[input[name=category][value=dresses]:checked]/filter:block',
  [GarmentCategory.TOPS]:
    'group-has-[input[name=category][value=tops]:checked]/filter:block',
  [GarmentCategory.BOTTOMS]:
    'group-has-[input[name=category][value=bottoms]:checked]/filter:block',
  [GarmentCategory.FOOTWEAR]:
    'group-has-[input[name=category][value=footwear]:checked]/filter:block',
  [GarmentCategory.OTHER]:
    'group-has-[input[name=category][value=other]:checked]/filter:block',
};

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The property filters, each offering only the values the wardrobe holds
 * (FilterOptions). Every category's types are rendered, in the form's
 * order, and the chosen category's group is revealed by CSS; a type its
 * category lacks is dropped by `gridSearch`. The type groups share the
 * radio name `type`, so one type is chosen at a time.
 */
function PropertyFilterGroups(props: {
  search: GridSearch;
  options: FilterOptions;
}) {
  const { search, options } = props;
  const groups: {
    name: keyof GridSearch;
    property: LabelledProperty;
    title: string;
    values: readonly (string | number)[];
  }[] = [
    {
      name: 'warmth',
      property: 'warmth',
      title: t('PROPERTY_WARMTH'),
      values: WARMTHS.filter((w) => options.warmths.includes(w)),
    },
    {
      name: 'formality',
      property: 'formality',
      title: t('PROPERTY_FORMALITY'),
      values: FORMALITIES.filter((f) => options.formalities.includes(f)),
    },
    {
      name: 'material',
      property: 'materials',
      title: t('PROPERTY_MATERIALS'),
      values: MATERIALS.filter((m) => options.materials.includes(m)),
    },
    {
      name: 'wash',
      property: 'careWash',
      title: t('care.WASH'),
      values: CARE_WASH.filter((w) => options.washes.includes(w)),
    },
  ];
  return (
    <>
      {Object.values(GarmentCategory).map((category) => {
        const types = typesOf(category)
          .map((type) => type.value)
          .filter((type) => options.types.includes(type));
        if (types.length === 0) return null;
        return (
          <FilterGroup
            id={`filter-type-${category}`}
            title={`${t('PROPERTY_TYPE')} · ${categoryLabel(category)}`}
            class={`hidden ${TYPE_GROUP_REVEAL[category]}`}
          >
            <Chips
              name="type"
              options={types}
              selected={
                search.category === String(category) &&
                types.includes(search.type)
                  ? search.type
                  : ''
              }
              label={(type) => valueLabel('type', type)}
            />
          </FilterGroup>
        );
      })}
      {groups
        .filter((group) => group.values.length > 0)
        .map((group) => (
          <FilterGroup id={`filter-${group.name}`} title={group.title}>
            <Chips
              name={group.name}
              options={group.values}
              selected={search[group.name]}
              label={(value) => valueLabel(group.property, value)}
            />
          </FilterGroup>
        ))}
    </>
  );
}

function FilterGroup(props: {
  id: string;
  title: string;
  class?: string;
  children: Child;
}) {
  return (
    <div
      role="group"
      aria-labelledby={`${props.id}-title`}
      class={`mb-5 ${props.class ?? ''}`}
    >
      <h4
        id={`${props.id}-title`}
        class="font-medium text-sm text-muted uppercase tracking-wide mb-2"
      >
        {props.title}
      </h4>
      <div class="flex flex-wrap gap-2">{props.children}</div>
    </div>
  );
}

// A yes-or-no filter: its query parameter is 'true' when checked.
function Toggle(props: {
  name: keyof GridSearch;
  checked: boolean;
  label: string;
}) {
  return (
    <label class="cursor-pointer flex items-center gap-2">
      <input
        type="checkbox"
        name={props.name}
        value="true"
        class="checkbox checkbox-sm"
        checked={props.checked}
      />
      <span class="text-sm">{props.label}</span>
    </label>
  );
}

const BULK_FORM_ID = 'bulk-form';

/**
 * Select mode's form: the grid's checkbox tiles (later pages arrive inside
 * it too) and the bar above the dock with the live count and the mode's
 * action. A native post carrying what the page needs back in its action's
 * query. The count is the one line of script: it re-counts the checked
 * boxes on every change, and once when it loads.
 */
const SELECT_COUNT_IMPORT = "import 'select-count';";

function SelectForm(props: {
  id: string;
  action: string;
  /** Boxes checked as rendered (the picker's members on this page). */
  checked: number;
  button: Child;
  children: Child;
}) {
  return (
    <PostForm id={props.id} action={props.action}>
      {/* The count follows toggles and the pages the sentinel appends
          (public/js/select-count.js, through the importmap for its versioned
          URL). A fixed string with nothing interpolated. */}
      <script
        type="module"
        dangerouslySetInnerHTML={{ __html: SELECT_COUNT_IMPORT }}
      />
      <div data-select-count>
        {props.children}
        <div class="fixed bottom-dock left-rail right-0 bg-base-100 border-t border-base-300 z-20 px-4 py-3 flex items-center justify-between gap-2">
          <span class="text-sm">
            <span
              id="selected-count"
              class="font-semibold"
              data-select-count-value
            >
              {props.checked}
            </span>{' '}
            {t('SELECTED')}
          </span>
          {props.button}
        </div>
      </div>
    </PostForm>
  );
}

/**
 * Select mode's form (#677: one selection, several verbs): POST
 * /wardrobe/bulk ("Set…") by default, and each verb of the Actions sheet
 * its own `formaction`, all with the filters in the query, so the redirect
 * lands back in select mode on the same grid.
 */
function BulkForm(props: {
  model: WardrobeModel;
  /** Boxes checked as rendered (a batch's garments, #200, or a kept selection). */
  checked: number;
  children: Child;
}) {
  const { search, viewOwner } = props.model;
  return (
    <SelectForm
      id={BULK_FORM_ID}
      action={wardrobeUrl(viewOwner, searchParams(search), '/wardrobe/bulk')}
      checked={props.checked}
      button={
        <div class="flex gap-2">
          <button
            type="button"
            class="btn btn-sm"
            onclick="document.getElementById('bulk-actions').showModal()"
          >
            {t('BULK_ACTIONS')}
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onclick="document.getElementById('bulk-dialog').showModal()"
          >
            {t('BULK_SET')}
          </button>
        </div>
      }
    >
      {props.children}
    </SelectForm>
  );
}

/**
 * "Select all N": every garment of the current filters, loaded or not. The
 * post carries `all=1` and the filters (the action's query), never the ids,
 * and the server resolves them as the grid does (gridIds). Checking it
 * checks every tile shown, and unchecking a tile unchecks it
 * (public/js/select-count.js); without script it still posts `all`.
 */
function SelectAll(props: { count: number; checked: boolean }) {
  return (
    <label class="flex items-center gap-2 text-sm mb-3 cursor-pointer w-fit">
      <input
        type="checkbox"
        name="all"
        value="1"
        checked={props.checked}
        class="checkbox checkbox-sm"
        data-select-all=""
        data-total={String(props.count)}
      />
      {t('SELECT_ALL', { count: props.count })}
    </label>
  );
}

/**
 * The verbs beside "Set…": Add to capsule (owner and MANAGE: the
 * wardrobe's capsules, the first chosen, so the field always posts), and
 * on one's own wardrobe Mark washed and Archive (wears and the status are
 * the owner's). Outside the form, like the "Set…" dialog, each button
 * joins it through `form` and posts to its own `formaction`. Online only
 * (data-needs-network): "Select all" is resolved by the server, so none
 * of them is queued like the laundry's batch.
 */
function BulkActions({ model }: { model: WardrobeModel }) {
  const { search, viewOwner, capsules } = model;
  const verbUrl = (verb: string) =>
    wardrobeUrl(viewOwner, searchParams(search), `/wardrobe/bulk/${verb}`);
  return (
    <dialog id="bulk-actions" class="modal modal-bottom sm:modal-middle">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-4">{t('BULK_ACTIONS_TITLE')}</h3>
        <p class="text-sm text-muted mb-3" data-offline-note="">
          {t('BULK_NEEDS_NETWORK')}
        </p>
        <div class="flex flex-col gap-4" data-needs-network="">
          {capsules.length > 0 && (
            <div class="flex items-end gap-2">
              <label class="flex-1 min-w-0">
                <span class="label text-sm mb-1">{t('CAPSULE')}</span>
                <select
                  name="capsuleId"
                  form={BULK_FORM_ID}
                  class="select select-sm w-full"
                >
                  {capsules.map((capsule) => (
                    <option value={String(capsule.id)}>{capsule.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                form={BULK_FORM_ID}
                formaction={verbUrl('capsule')}
                class="btn btn-sm"
              >
                {t('BULK_ADD_TO_CAPSULE')}
              </button>
            </div>
          )}
          {model.ownerView && (
            <div class="flex gap-2">
              <button
                type="submit"
                form={BULK_FORM_ID}
                formaction={verbUrl('washed')}
                class="btn btn-sm flex-1"
              >
                {t('BULK_MARK_WASHED')}
              </button>
              <button
                type="submit"
                form={BULK_FORM_ID}
                formaction={verbUrl('archive')}
                class="btn btn-sm flex-1"
              >
                {t('BULK_ARCHIVE')}
              </button>
            </div>
          )}
        </div>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onclick="this.closest('dialog').close()"
          >
            {t('CANCEL')}
          </button>
        </div>
      </div>
      <SheetBackdrop label={t('CLOSE')} />
    </dialog>
  );
}

/** The capsule picker: Save posts the membership and returns to the capsule. */
function PickForm(props: {
  model: WardrobeModel;
  picking: Picking;
  children: Child;
}) {
  const { model, picking } = props;
  return (
    <SelectForm
      id="pick-form"
      action={capsuleUrl(picking.capsuleId, model.viewOwner, '/garments')}
      checked={model.page.tiles.filter((tile) => tile.member).length}
      button={
        <button type="submit" class="btn btn-primary btn-sm">
          {t('SAVE')}
        </button>
      }
    >
      {props.children}
    </SelectForm>
  );
}

// Each bulk property's choices: the value field the garment form uses and
// its values ('' clears; materials add one; water resistance is yes or no).
const BULK_CHOICES: Record<
  BulkProperty,
  {
    field: string;
    label: StringKey;
    values: readonly (string | number)[];
    labelOf: (value: string | number) => string;
    clearable: boolean;
  }
> = {
  warmth: labelled('warmth', 'warmth', 'PROPERTY_WARMTH', WARMTHS),
  formality: labelled(
    'formality',
    'formality',
    'PROPERTY_FORMALITY',
    FORMALITIES,
  ),
  materials: {
    ...labelled('material', 'materials', 'PROPERTY_MATERIALS', MATERIALS),
    clearable: false,
  },
  pattern: labelled('pattern', 'pattern', 'PROPERTY_PATTERN', PATTERNS),
  fit: labelled('fit', 'fit', 'PROPERTY_FIT', FITS),
  sleeve: labelled('sleeve', 'sleeve', 'PROPERTY_SLEEVE', SLEEVES),
  length: labelled('length', 'length', 'PROPERTY_LENGTH', LENGTHS),
  waterResistant: {
    field: 'waterResistant',
    label: 'PROPERTY_WATER_RESISTANT',
    values: ['true', 'false'],
    labelOf: (value) =>
      t(value === 'true' ? 'WATER_RESISTANT_YES' : 'WATER_RESISTANT_NO'),
    clearable: false,
  },
  // Good is the reset, so no "Not set" chip.
  condition: {
    ...labelled('condition', 'condition', 'CONDITION', CONDITIONS),
    clearable: false,
  },
};

function labelled(
  field: string,
  property: LabelledProperty,
  label: StringKey,
  values: readonly (string | number)[],
) {
  return {
    field,
    label,
    values,
    labelOf: (value: string | number) => valueLabel(property, value),
    clearable: true,
  };
}

/**
 * "Set…": one property for every selected garment. The tabs are the
 * `property` radio (daisyUI radio tabs: the checked tab shows its values,
 * no script); each tab's chips are that property's field. Outside the form
 * (forms cannot nest, and the backdrop is a dialog form of its own), its
 * inputs join the bulk form through their `form` attribute.
 */
function BulkDialog() {
  return (
    <dialog id="bulk-dialog" class="modal modal-bottom sm:modal-middle">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-2">{t('BULK_TITLE')}</h3>
        <p class="text-sm text-muted mb-4">{t('BULK_HINT')}</p>
        <p class="text-sm text-muted mb-4" data-offline-note="">
          {t('BULK_NEEDS_NETWORK')}
        </p>
        <div role="tablist" class="tabs tabs-box tabs-sm flex-wrap">
          {BULK_PROPERTIES.map((property, index) => {
            const choice = BULK_CHOICES[property];
            return (
              <>
                <input
                  type="radio"
                  name="property"
                  value={property}
                  form={BULK_FORM_ID}
                  role="tab"
                  class="tab"
                  aria-label={t(choice.label)}
                  checked={index === 0}
                />
                <div class="tab-content pt-4">
                  {property === 'materials' && (
                    <p class="text-xs text-muted mb-2">
                      {t('BULK_MATERIALS_ADD')}
                    </p>
                  )}
                  <div class="flex flex-wrap gap-2">
                    {choice.clearable && (
                      <input
                        type="radio"
                        name={choice.field}
                        value=""
                        form={BULK_FORM_ID}
                        class="btn btn-sm btn-ghost rounded-full"
                        aria-label={t('NOT_SET')}
                      />
                    )}
                    {choice.values.map((value) => (
                      <input
                        type="radio"
                        name={choice.field}
                        value={String(value)}
                        form={BULK_FORM_ID}
                        class="btn btn-sm rounded-full"
                        aria-label={choice.labelOf(value)}
                      />
                    ))}
                  </div>
                </div>
              </>
            );
          })}
        </div>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onclick="this.closest('dialog').close()"
          >
            {t('CANCEL')}
          </button>
          <button
            type="submit"
            form={BULK_FORM_ID}
            class="btn btn-primary btn-sm"
            data-needs-network=""
          >
            {t('APPLY')}
          </button>
        </div>
      </div>
      <SheetBackdrop label={t('CLOSE')} />
    </dialog>
  );
}

/** What a select-mode verb did, once (StripFlags drops its flags from the URL). */
function BulkToast(props: { outcome: BulkOutcome }) {
  return (
    <>
      <SavedToast id="bulk-toast" text={bulkOutcomeText(props.outcome)} />
      <StripFlags names={BULK_FLAGS} />
    </>
  );
}

/** Each verb's toast, for one garment and for `{count}` (never "1 garments"). */
const BULK_TOASTS: Record<
  BulkOutcome['verb'] | 'setSkipped' | 'washSkipped',
  { one: StringKey; many: StringKey }
> = {
  set: { one: 'BULK_RESULT_ONE', many: 'BULK_RESULT' },
  setSkipped: { one: 'BULK_RESULT_ONE_SKIPPED', many: 'BULK_RESULT_SKIPPED' },
  archive: { one: 'BULK_ARCHIVED_ONE', many: 'BULK_ARCHIVED' },
  wash: { one: 'BULK_WASHED_ONE', many: 'BULK_WASHED' },
  washSkipped: {
    one: 'BULK_WASHED_ONE_SKIPPED',
    many: 'BULK_WASHED_SKIPPED',
  },
  capsule: { one: 'BULK_ADDED_ONE', many: 'BULK_ADDED' },
};

function bulkOutcomeText(outcome: BulkOutcome): string {
  const { count } = outcome;
  const skipped =
    outcome.verb === 'set' || outcome.verb === 'wash' ? outcome.skipped : 0;
  const keys =
    BULK_TOASTS[
      skipped > 0 && (outcome.verb === 'set' || outcome.verb === 'wash')
        ? (`${outcome.verb}Skipped` as const)
        : outcome.verb
    ];
  return count === 1
    ? t(keys.one, { skipped })
    : t(keys.many, { count, skipped });
}
