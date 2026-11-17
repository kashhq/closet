import type { GarmentRole } from '../../wardrobe/properties';
import type { FitProblem } from '../../weather/match';
import { ChipList, fitsChip, problemChip } from '../gallery/chips';
import {
  DEFAULT_OCCASION,
  type Occasion,
  OCCASIONS,
} from '../../wardrobe/occasions';
import { PostForm } from '../form';
import type { IsoDate } from '../../calendar-date';
import { dayLabel, occasionLabel } from '../date-labels';
import type { CapsuleRef } from '../capsules/queries';
import { type StringKey, t } from '../i18n';
import { PageShell } from '../layout/page-shell';
import { BackLink, EmptyState } from '../layout/parts';
import { Sheet, SheetCancel, sheetOpener } from '../layout/sheet';
import {
  DestinationFields,
  destinationQuery,
  type OutfitDestination,
} from '../outfits/destination';
import { destinationPickLabel } from '../outfits/destination-views';
import { OUTFIT_NAME_MAX } from '../outfits/queries';
import { tripUrl } from '../trips/urls';
import type { ViewContext } from '../view-context';
import { garmentUrl } from '../wardrobe/urls';
import type { StylingRow } from './rows';
import {
  GarmentLook,
  ridesAlong,
  type RowContext,
  StylingRowView,
} from './styling-row';
import { roleLabel } from '../wardrobe/labels';
import {
  STYLING_FIT_PATH,
  STYLING_PATH,
  STYLING_ROW_PATH,
  STYLING_SHUFFLE_PATH,
  type StylingState,
  stylingUrl,
} from './urls';
import { FIELD_GRID } from '../layout/columns';

/**
 * GET /styling (#42; docs/plans/2026-09-26-redesign.md, "Styling"): the
 * outfit composer. A row per role top to toe, each a strip to swipe; Lock
 * and Shuffle (the generator fills the unlocked rows); Save opens a sheet
 * (the name, and where the outfit goes: `?for=`'s day or trip, or an
 * optional day). One form, `#styling-form`, holds every row's state and the
 * page's; the sheet's fields join it through their `form` attribute (a
 * dialog's backdrop is a form of its own, and forms do not nest). Over a
 * shared wardrobe (`?ownerId=`) it browses and shuffles but never saves:
 * outfits are private, and an outfit only ever holds its owner's garments.
 */

export interface StylingModel {
  state: StylingState;
  /** The page's destination, resolved (a trip's stray day dropped). */
  destination: OutfitDestination;
  rows: StylingRow[];
  /** The roles the wardrobe (or capsule) has garments of: "Add row"'s choices. */
  roles: GarmentRole[];
  /** Shuffle's next seed; absent until something shuffled (the bare page stays byte-stable). */
  seed?: number;
  capsule?: CapsuleRef;
  /**
   * Include picks may be turned on: one's own wardrobe, no destination,
   * not an edit of a planned or packed outfit (PicksToggle).
   */
  picksOffered: boolean;
  /** The addressed wardrobe's capsules, for the scope menu. */
  capsules: CapsuleRef[];
  /** `?outfit=`: the saved outfit being changed. */
  outfit?: { id: number; name: string | null };
  /** `for=trip:ID`: the trip's name. */
  trip?: { id: number; name: string };
  /** A wardrobe shared with the requester: whose, and that nothing saves. */
  shared?: { ownerId: number; name: string };
  /** What the last Shuffle found: nothing that fits the locks. */
  notice?: 'no-idea';
  /**
   * The outfit rules the last Shuffle's locked rows break between them
   * (brokenRuleLabels): the idea is drawn all the same, and says so.
   */
  broken?: string[];
  /**
   * A Save refused for garments it could not hold (#219): its words, and
   * the sheet as it was posted, so nothing typed is lost.
   */
  refusal?: {
    message: string;
    /**
     * Refused for planning an incomplete outfit (OutfitIncomplete, #335):
     * the rows are kept, so the hint is to buy or save without a day, not
     * to choose again.
     */
    incomplete: boolean;
    draft: SaveDraft;
    /** The wishlist pieces it named: each is saved once bought ("Bought it"). */
    toBuy: { id: number; name: string | null }[];
  };
}

/** What the Save sheet held when its post was refused. */
export interface SaveDraft {
  name?: string;
  scheduleDate?: IsoDate;
  scheduleOccasion?: Occasion;
}

const ALL_GARMENTS_KEY = 'ALL_GARMENTS' satisfies StringKey;
const SAVE_CHANGES_KEY = 'styling.SAVE_CHANGES' satisfies StringKey;

// The page's own script (public/js/styling.js, through the importmap): an
// inline module, so it runs again after a boosted navigation brings a new
// page (a <script src> module runs once per document). A fixed string with
// nothing interpolated.
const STYLING_INIT = `import { initStyling } from 'styling';
initStyling(document.getElementById('styling-rows'));`;

export function StylingPage(props: { ctx: ViewContext; model: StylingModel }) {
  const { ctx, model } = props;
  const viewOwner = model.shared?.ownerId;
  const context: RowContext = {
    state: model.state,
    viewOwner,
    picksOffered: model.picksOffered,
  };
  return (
    <PageShell
      ctx={ctx}
      name="styling"
      bar={{
        title: t('styling.TITLE'),
        back: model.state.returnTo,
        // Save posts natively and lands elsewhere (the outfit, a week); on a
        // shared wardrobe nothing saves.
        formPage: !model.shared,
        scope: (
          <ScopeMenu
            capsule={model.capsule}
            capsules={model.capsules}
            state={model.state}
          />
        ),
      }}
      width="wide"
      // The strips reach the screen's edges; the header pads its own text.
      body={{ gutter: 'bleed', gap: 3 }}
      actionBar={
        model.rows.length > 0
          ? {
              kind: 'stack',
              children: <StylingAside ctx={ctx} model={model} />,
            }
          : undefined
      }
      overlays={
        model.rows.length > 0 && !model.shared && <SaveSheet model={model} />
      }
    >
      <Header model={model} />
      {model.rows.length > 0 ? (
        <>
          {/* Not guarded as a whole: guarding it would dim and freeze the
                strips it wraps, and "choosing still works" offline
                (styling.OFFLINE). Every network control around it
                (Shuffle, picks, + Add row, the sheet's Save) carries its
                own data-needs-network. */}
          <PostForm
            id="styling-form"
            action={STYLING_PATH}
            allowOffline="choosing a look works offline; Save is guarded in the sheet"
          >
            <StateFields model={model} />
            <StylingRows model={model} context={context} />
          </PostForm>
          <AddRow model={model} />
          <script
            type="module"
            dangerouslySetInnerHTML={{ __html: STYLING_INIT }}
          />
        </>
      ) : (
        <Empty model={model} />
      )}
    </PageShell>
  );
}

/**
 * The rows, and what Shuffle carries on: the page renders it inside the
 * form, and Shuffle and "Add row" answer it alone (outerHTML), so the seed,
 * the notice and the broken rules change with the rows.
 */
export function StylingRows(props: {
  model: Pick<StylingModel, 'rows' | 'seed' | 'notice' | 'broken'>;
  context: RowContext;
}) {
  const { model, context } = props;
  return (
    <div id="styling-rows" class="flex flex-col gap-4">
      <PicksToggle context={context} />
      {model.notice === 'no-idea' && (
        <p class="alert alert-info alert-soft mx-4 py-2 text-sm" role="status">
          {t('styling.NO_IDEA')}
        </p>
      )}
      {model.broken && model.broken.length > 0 && (
        // The Ideas cards' problem chips (Reasons), said as Shuffle answers.
        <div role="status" class="mx-4">
          <ul class="flex flex-wrap gap-1">
            {model.broken.map((text) => (
              <li class="badge badge-sm badge-soft badge-warning h-auto py-0.5">
                {text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {model.rows.map((row) => (
        <StylingRowView row={row} context={context} />
      ))}
      {model.seed !== undefined && (
        <input type="hidden" name="seed" value={String(model.seed)} />
      )}
      {context.state.picks && <input type="hidden" name="picks" value="1" />}
    </div>
  );
}

/**
 * The outfit as it stands and the way to keep it: the preview and the fit
 * line, then Shuffle and Save, the page's `stack` action bar
 * (layout/action-bar.tsx, `#styling-actions`). On a phone (#664) it is the
 * bar above the dock, sticky in the flow after the rows and "Add row": it
 * rides on the dock while they scroll and lands below the last one at their
 * end, so it never covers a row whatever its height (the fit's chips wrap,
 * the preview opens). Over the rows (a strip's step buttons are z-10 and
 * come first), under "Add row"'s z-20 menu. From lg (#468) it is the
 * column beside the rows, sticky under the app bar. In DOM order after the
 * rows, so Tab reaches Shuffle and Save last on both. `group/bar` (a box-less
 * wrapper inside the bar's flex column) is what Shuffle and Save read the
 * preview's state from.
 */
function StylingAside(props: { ctx: ViewContext; model: StylingModel }) {
  const { model } = props;
  return (
    <div class="group/bar contents">
      {/* A tap opens the strip into the whole outfit (CSS off `open`, the
          PREVIEW_* classes). The open panel scrolls inside the space between
          the app bar (`--app-bar-h`) and the dock, so a tall outfit never
          slides under either. From lg the outfit is always whole (every
          `group-open:` class has its `lg:` twin, so `open` is never touched
          there); styling.js takes the summary out of the tab order
          (`syncPreviewToggle`). The summary is named by its sr-only text, as
          the preview inside is aria-hidden (each strip says its choice). The
          fit line stays outside it, so it is read on its own. */}
      <details
        class="group min-h-0 overflow-y-auto lg:overflow-visible"
        data-preview-toggle=""
      >
        <summary class="relative flex cursor-pointer list-none flex-col px-4 pt-2 lg:cursor-auto lg:p-0 [&::-webkit-details-marker]:hidden">
          <span class="sr-only">{t('styling.PREVIEW')}</span>
          <StylingPreview rows={model.rows} />
          <span
            class="absolute right-4 top-4 text-muted group-open:rotate-180 lg:hidden"
            aria-hidden="true"
          >
            ▴
          </span>
        </summary>
      </details>
      {props.ctx.weatherEnabled && !model.shared && (
        <div class="px-4 pt-1 lg:p-0">
          <StylingFit />
        </div>
      )}
      <StylingActions model={model} />
    </div>
  );
}

/**
 * The fit line's slot (#468b), under the preview: on a phone (#664) the
 * chips under the bar's strip, its 1.5 rem kept only while a request is out
 * or chips are shown (an answer without a judgement collapses it; the one
 * frame before the first request is the only shift). Empty in the page, so /styling stays
 * byte-stable (a tab root, OPENS_STALE): GET /styling/fit answers into it
 * with the rows (`hx-include`). It loads on `intersect` (the bar is on
 * screen on load at every width), again on `styling:outfit-changed`, which
 * styling.js sends it when a choice changes the preview (debounced, the
 * last ask wins); and a rows answer (Shuffle, "Add row", the picks switch)
 * sends this slot again out of band, which loads afresh. Only with
 * WEATHER_ENABLED (no route without it) and never over a shared wardrobe
 * (the owner's weather is theirs). Offline the line dims and the note says
 * why.
 */
export function StylingFit(props: { oob?: boolean }) {
  return (
    <div
      id="styling-fit"
      hx-swap-oob={props.oob ? 'true' : undefined}
      class="flex flex-col gap-1"
    >
      <div
        id="styling-fit-line"
        class="min-h-6 [&:empty:not(.htmx-request)]:min-h-0"
        hx-get={STYLING_FIT_PATH}
        hx-include="#styling-form"
        hx-trigger="intersect once, styling:outfit-changed delay:500ms"
        hx-sync="this:replace"
        hx-swap="innerHTML"
        hx-indicator="#styling-fit-line"
        aria-live="polite"
        data-needs-network=""
      ></div>
      <p class="text-xs text-muted" data-offline-note="">
        {t('styling.FIT_OFFLINE')}
      </p>
    </div>
  );
}

/**
 * GET /styling/fit's answer: the gallery's words for how the outfit meets
 * the day (a chip per problem, else "Fits the weather"); nothing without a
 * judgement (no garment, no forecast, a shared wardrobe).
 */
export function FitLine(props: {
  fit?: { problems: readonly FitProblem[]; typical: boolean };
}) {
  const { fit } = props;
  if (!fit) return null;
  return (
    <ChipList
      chips={
        fit.problems.length > 0
          ? fit.problems.map(problemChip)
          : [fitsChip(fit)]
      }
    />
  );
}

/** A button that leads when `primary`, else its outline. */
const emphasis = (primary: boolean) =>
  primary ? 'btn-primary' : 'btn-outline';

/*
 * The preview's two shapes, from one markup (#664): the phone's closed bar
 * draws it as a strip, every piece in one line top to toe (a long outfit
 * scrolls inside it); open, and always from lg, it is the whole outfit
 * stacked (#468). Each class pair below is that shape, spelled twice
 * because `group-open:` (the bar's <details>) and `lg:` are separate
 * variants; they agree, so neither wins over the other.
 */
const PREVIEW_FRAME =
  'flex min-w-0 items-center gap-1 overflow-x-auto pr-8 group-open:flex-col group-open:items-stretch group-open:gap-2 group-open:overflow-visible group-open:rounded-box group-open:bg-base-200 group-open:p-4 lg:flex-col lg:items-stretch lg:gap-2 lg:overflow-visible lg:rounded-box lg:bg-base-200 lg:p-4';
const PREVIEW_HEADING =
  'hidden text-xs font-semibold uppercase tracking-wide text-muted group-open:block lg:block';
const PREVIEW_WORN =
  'flex items-center gap-1 group-open:flex-col group-open:gap-2 lg:flex-col lg:gap-2';
const PREVIEW_WORN_SLOT =
  'size-12 group-open:h-24 group-open:w-full lg:h-24 lg:w-full';
const PREVIEW_ALONG =
  'flex gap-1 group-open:flex-wrap group-open:justify-center group-open:gap-2 lg:flex-wrap lg:justify-center lg:gap-2';
const PREVIEW_ALONG_SLOT = 'size-10 group-open:size-16 lg:size-16';

/**
 * The outfit as it stands (#468), top to toe: a slot per row in row order
 * (`data-preview-slot`, its index among the rows), the worn roles first
 * and the ones riding along (accessory, bag, none) after them, each the
 * chosen garment's look or nothing for "No garment" (an empty slot
 * collapses). On a phone it is the bar's strip (#664, PREVIEW_FRAME), from
 * lg the aside's stack. Not `OutfitCollage`: that lays out by the roles
 * present, which only the server knows, and the choice moves in the
 * browser. The server draws it from the rows' states (so `?with=`,
 * `?outfit=` and a refused Save open right) and every rows answer sends it
 * again out of band (`oob`); between them styling.js copies each choice in
 * (`snap-strip:chosen`), so it follows a swipe offline too. `aria-hidden`:
 * each strip's listbox already says what is chosen.
 */
export function StylingPreview(props: {
  rows: readonly StylingRow[];
  oob?: boolean;
}) {
  const slots = props.rows.map((row, index) => ({ row, index }));
  return (
    <div
      id="styling-preview"
      hx-swap-oob={props.oob ? 'true' : undefined}
      class={PREVIEW_FRAME}
      aria-hidden="true"
    >
      <p class={PREVIEW_HEADING}>{t('styling.PREVIEW')}</p>
      {/* Shown only while no slot holds a garment (the bare page, #665): CSS
          off `data-preview-garment`, the one chosen-state attribute the
          server draws, a rows answer redraws and styling.js keeps, so it
          follows Shuffle and a swipe. A look without a photo still counts. */}
      <p class="whitespace-nowrap text-sm text-muted group-has-[[data-preview-garment]:not([data-preview-garment=''])]/bar:hidden">
        {t('styling.PREVIEW_EMPTY')}
      </p>
      <div class={PREVIEW_WORN}>
        {slots
          .filter(({ row }) => !ridesAlong(row.role))
          .map((slot) => (
            <PreviewSlot {...slot} class={PREVIEW_WORN_SLOT} />
          ))}
      </div>
      <div class={PREVIEW_ALONG}>
        {slots
          .filter(({ row }) => ridesAlong(row.role))
          .map((slot) => (
            <PreviewSlot {...slot} class={PREVIEW_ALONG_SLOT} />
          ))}
      </div>
    </div>
  );
}

/** A row's slot: `data-preview-garment` is the chosen id ('' for none), which styling.js compares and keeps. */
function PreviewSlot(props: { row: StylingRow; index: number; class: string }) {
  const { row } = props;
  const garment = row.garments.find((one) => one.id === row.garmentId);
  return (
    <div
      class={`flex shrink-0 items-center justify-center empty:hidden ${props.class}`}
      data-preview-slot={String(props.index)}
      data-preview-garment={garment ? String(garment.id) : ''}
    >
      {garment && <GarmentLook garment={garment} loading="lazy" />}
    </div>
  );
}

/** The page's state as form fields: Save and Shuffle post it back. */
function StateFields({ model }: { model: StylingModel }) {
  const { state, destination } = model;
  return (
    <>
      <DestinationFields destination={destination} />
      {state.capsuleId !== undefined && (
        <input type="hidden" name="capsule" value={String(state.capsuleId)} />
      )}
      {state.ownerId !== undefined && (
        <input type="hidden" name="ownerId" value={String(state.ownerId)} />
      )}
      {state.outfitId !== undefined && (
        <input type="hidden" name="outfit" value={String(state.outfitId)} />
      )}
      {state.withId !== undefined && (
        <input type="hidden" name="with" value={String(state.withId)} />
      )}
      {state.returnTo !== undefined && (
        <input type="hidden" name="returnTo" value={state.returnTo} />
      )}
    </>
  );
}

/**
 * Under the app bar (which carries the title, the way back and the capsule
 * scope): the outfit being edited, the destination, and the notes.
 */
function Header({ model }: { model: StylingModel }) {
  return (
    <div class="flex flex-col gap-2 px-4">
      {model.refusal && (
        <div
          class="alert alert-warning alert-soft flex-col items-start gap-1 text-sm"
          role="alert"
          data-styling-refused=""
        >
          <p>{model.refusal.message}</p>
          <p>
            {t(
              model.refusal.incomplete
                ? 'styling.INCOMPLETE_HINT'
                : 'styling.REFUSED_HINT',
            )}
          </p>
          {model.refusal.toBuy.length > 0 && (
            <ul class="flex flex-col gap-1" data-styling-refused-buy="">
              {model.refusal.toBuy.map((piece) => (
                <li>
                  <a
                    href={garmentUrl(piece.id, undefined, '/bought')}
                    class="link"
                  >
                    {t('styling.BOUGHT_IT', {
                      name: piece.name ?? t('outfits.UNNAMED_GARMENT'),
                    })}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {model.outfit && (
        <p class="text-sm" data-styling-outfit={model.outfit.id}>
          {t('styling.EDITING', {
            name: model.outfit.name ?? t('UNTITLED_OUTFIT'),
          })}
        </p>
      )}
      <DestinationLine model={model} />
      {model.shared && (
        <p
          class="alert alert-info alert-soft py-2 text-sm"
          role="note"
          data-styling-shared=""
        >
          {t('styling.SHARED', { name: model.shared.name })}
        </p>
      )}
      <p
        data-offline-note=""
        class="alert alert-warning alert-soft py-2 text-sm"
        role="note"
      >
        {t('styling.OFFLINE')}
      </p>
    </div>
  );
}

/**
 * Include picks (#335): a switch over the rows that answers them again
 * with the picks on or off, as "Add row" does (the rows posted through
 * `hx-include`, `picks` set by `hx-vals`, which htmx lets override the
 * form's own), so the composition and its locks stay. It pushes the
 * page's own address with `picks` flipped (and "Style this"'s garment),
 * so a reload or a shared link opens the same way. The bare page (off)
 * stays byte-stable. On, every strip leads with the garments not bought
 * yet that are offered to style with (picksSql), badged "To buy", and
 * Save keeps them: the outfit is incomplete until they are bought. Only
 * where `picksOffered`: never over a shared wardrobe, while the page picks
 * for a day or a trip, or in an edit of a planned or packed outfit, where
 * Save plans, packs or keeps a held outfit and a piece to buy would refuse
 * it. With no rows to keep (an empty closet or capsule), PicksLink.
 */
function PicksToggle({ context }: { context: RowContext }) {
  const { state } = context;
  if (!context.picksOffered) return null;
  const on = state.picks === true;
  return (
    <div class="px-4">
      <button
        type="button"
        class={`btn btn-sm rounded-full ${emphasis(on)}`}
        role="switch"
        aria-checked={on ? 'true' : 'false'}
        hx-get={STYLING_ROW_PATH}
        hx-include="#styling-form"
        hx-vals={JSON.stringify({ picks: on ? '' : '1' })}
        hx-target="#styling-rows"
        hx-swap="outerHTML"
        hx-push-url={stylingUrl({ ...state, picks: !on })}
        data-needs-network=""
        data-styling-picks={on ? 'on' : 'off'}
      >
        {on && <span aria-hidden="true">✓</span>}
        {t('styling.INCLUDE_PICKS')}
      </button>
    </div>
  );
}

/** Where Save plans the outfit (`?for=`), with the way back to where it came from. */
function DestinationLine({ model }: { model: StylingModel }) {
  const { destination } = model;
  if (destination.kind === 'day') {
    return (
      <div class="flex items-center gap-2" data-styling-for="day">
        <BackLink href={`/calendar/plan?${destinationQuery(destination)}`} />
        <p class="text-sm">{destinationSummary(model, destination)}</p>
      </div>
    );
  }
  if (destination.kind === 'trip' && model.trip) {
    return (
      <div class="flex items-center gap-2" data-styling-for="trip">
        <BackLink href={tripUrl(model.trip.id)} />
        <p class="text-sm min-w-0">{destinationSummary(model, destination)}</p>
      </div>
    );
  }
  return null;
}

/**
 * The capsule scope: every row, and Shuffle's pool, only its garments. Its
 * links carry the page's state (Include picks among it), so the switch's
 * answer replaces it out of band (`oob`, the rows fragment of
 * GET /styling/row): no link outside the rows keeps a stale state. Its
 * wrapper is there without capsules too, so the swap always finds it.
 */
export function ScopeMenu(props: {
  capsule: CapsuleRef | undefined;
  capsules: readonly CapsuleRef[];
  state: StylingState;
  oob?: boolean;
}) {
  return (
    <div id="styling-scope" hx-swap-oob={props.oob ? 'true' : undefined}>
      <CapsuleLinks {...props} />
    </div>
  );
}

function CapsuleLinks(props: {
  capsule: CapsuleRef | undefined;
  capsules: readonly CapsuleRef[];
  state: StylingState;
}) {
  const { capsule, capsules, state } = props;
  if (capsules.length === 0) return null;
  return (
    <details class="dropdown dropdown-end">
      <summary class="btn btn-sm btn-outline rounded-full max-w-36">
        <span class="truncate">
          {capsule ? capsule.name : t(ALL_GARMENTS_KEY)}
        </span>{' '}
        ▾
      </summary>
      <ul class="dropdown-content menu bg-base-100 rounded-box shadow-md z-20 w-56 mt-1">
        <li>
          <a href={stylingUrl({ ...state, capsuleId: undefined })}>
            {t(ALL_GARMENTS_KEY)}
          </a>
        </li>
        {capsules.map((option) => (
          <li>
            <a
              href={stylingUrl({ ...state, capsuleId: option.id })}
              aria-current={option.id === capsule?.id ? 'true' : undefined}
            >
              {option.name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Another row of a role (two accessories, a shirt over a tee): the rows
 * come back in order with the new one empty. Posts the form's state like
 * Shuffle, so nothing chosen is lost.
 */
function AddRow({ model }: { model: StylingModel }) {
  return (
    <details class="dropdown px-4">
      <summary class="btn btn-ghost btn-sm">+ {t('styling.ADD_ROW')}</summary>
      <ul class="dropdown-content menu bg-base-100 rounded-box shadow-md z-20 w-56 mt-1">
        {model.roles.map((role) => (
          <li>
            <button
              type="button"
              hx-get={`${STYLING_ROW_PATH}?add=${role}`}
              hx-include="#styling-form"
              hx-target="#styling-rows"
              hx-swap="outerHTML"
              data-needs-network=""
              onclick="this.closest('details').open = false"
            >
              {roleLabel(role)}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Shuffle, which leads while the preview holds no garment, then Save
 * (the sheet), which takes over once it does (the `group/bar` classes), or over a shared wardrobe the reason there
 * is no Save: in a line at the foot of the phone's bar (StylingAside), and
 * from lg under the preview, its buttons stacked full width.
 */
function StylingActions({ model }: { model: StylingModel }) {
  return (
    <div class="flex w-full items-center gap-2 px-4 py-2 max-w-page-narrow mx-auto lg:flex-col lg:items-stretch lg:p-0 lg:max-w-none">
      <button
        type="button"
        class="btn btn-primary group-has-[[data-preview-garment]:not([data-preview-garment=''])]/bar:btn-outline"
        hx-get={STYLING_SHUFFLE_PATH}
        hx-include="#styling-form"
        hx-target="#styling-rows"
        hx-swap="outerHTML"
        data-needs-network=""
        data-styling-shuffle=""
      >
        ⤮ {t('gallery.SHUFFLE')}
      </button>
      {model.shared ? (
        <p class="text-xs text-muted flex-1">{t('styling.SHARED_NO_SAVE')}</p>
      ) : (
        <button
          type="button"
          class="btn btn-primary flex-1 lg:flex-none group-not-has-[[data-preview-garment]:not([data-preview-garment=''])]/bar:btn-outline"
          {...sheetOpener(SAVE_SHEET_ID)}
        >
          {t(model.outfit ? SAVE_CHANGES_KEY : 'SAVE')}
        </button>
      )}
    </div>
  );
}

/** Save's primary action, by where the outfit goes. */
function saveLabel(model: StylingModel): string {
  const { destination } = model;
  if (model.outfit) return t(SAVE_CHANGES_KEY);
  return destination.kind === 'none'
    ? t('styling.SAVE_OUTFIT')
    : destinationPickLabel(destination);
}

const SAVE_SHEET_ID = 'styling-save';

/**
 * The Save sheet: the name (the outfit's own when changing one; blank names
 * it for its garments), then where it goes. With `?for=` that is decided
 * (the day and occasion, the entry it replaces, the trip); without, an
 * optional day and occasion, as the builder's "Add to calendar" was.
 */
function SaveSheet({ model }: { model: StylingModel }) {
  const { destination } = model;
  return (
    <Sheet
      id={SAVE_SHEET_ID}
      kind="choice"
      labelledBy="styling-save-title"
      gap={3}
      dismiss="cancel"
    >
      <h2 id="styling-save-title" class="font-bold text-lg">
        {t(model.outfit ? SAVE_CHANGES_KEY : 'styling.SAVE_TITLE')}
      </h2>
      <label class="flex flex-col gap-1">
        <span class="label-text">{t('NAME')}</span>
        <input
          type="text"
          name="name"
          form="styling-form"
          class="input input-bordered w-full"
          value={model.refusal?.draft.name ?? model.outfit?.name ?? ''}
          maxlength={OUTFIT_NAME_MAX}
          placeholder={t('styling.NAME_PLACEHOLDER')}
        />
      </label>
      {destination.kind === 'none' ? (
        <ScheduleFields
          day={model.refusal?.draft.scheduleDate}
          occasion={model.refusal?.draft.scheduleOccasion}
        />
      ) : (
        <p class="text-sm" data-styling-save-for="">
          {destinationSummary(model, destination)}
        </p>
      )}
      <div class="modal-action mt-2">
        <SheetCancel />
        <button
          type="submit"
          form="styling-form"
          class="btn btn-primary"
          data-needs-network=""
          data-styling-save=""
        >
          {saveLabel(model)}
        </button>
      </div>
    </Sheet>
  );
}

function destinationSummary(
  model: StylingModel,
  destination: Exclude<OutfitDestination, { kind: 'none' }>,
): string {
  if (destination.kind === 'trip') {
    const parts = [
      t('gallery.FOR_TRIP', { name: model.trip?.name ?? '' }),
      destination.day && dayLabel(destination.day),
      destination.occasion && occasionLabel(destination.occasion),
    ].filter(Boolean);
    return parts.join(' · ');
  }
  return `${
    destination.replace === undefined
      ? t('gallery.FOR_DAY', { day: dayLabel(destination.day) })
      : t('changeEntry.FOR_DAY', { day: dayLabel(destination.day) })
  } · ${occasionLabel(destination.occasion)}`;
}

/**
 * "Add to calendar" without a destination: a day (empty: not planned) and
 * the occasion it is for. An outfit already on that day keeps its entry
 * and occasion (insertEntry).
 */
function ScheduleFields(props: { day?: IsoDate; occasion?: Occasion }) {
  const occasion = props.occasion ?? DEFAULT_OCCASION;
  return (
    <div class={FIELD_GRID}>
      <label class="flex flex-col gap-1">
        <span class="label-text">{t('ADD_TO_CALENDAR')}</span>
        <input
          type="date"
          name="scheduleDate"
          form="styling-form"
          class="input input-bordered w-full"
          value={props.day}
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="label-text">{t('OCCASION')}</span>
        <select
          name="scheduleOccasion"
          form="styling-form"
          class="select select-bordered w-full"
        >
          {OCCASIONS.map((value) => (
            <option value={value} selected={value === occasion}>
              {occasionLabel(value)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The switch with no rows to keep (an empty closet or capsule, picks off):
 * a plain link turning Include picks on, which may bring rows of picks
 * alone. PicksToggle's conditions.
 */
function PicksLink({ model }: { model: StylingModel }) {
  if (!model.picksOffered) return null;
  const on = model.state.picks === true;
  return (
    <a
      href={stylingUrl({ ...model.state, picks: !on })}
      class={`btn btn-sm rounded-full ${emphasis(on)}`}
      role="switch"
      aria-checked={on ? 'true' : 'false'}
      data-styling-picks={on ? 'on' : 'off'}
    >
      {on && <span aria-hidden="true">✓</span>}
      {t('styling.INCLUDE_PICKS')}
    </a>
  );
}

function Empty({ model }: { model: StylingModel }) {
  if (model.capsule) {
    return (
      <EmptyState message={t('styling.EMPTY_CAPSULE')}>
        <PicksLink model={model} />
        <a
          href={stylingUrl({ ...model.state, capsuleId: undefined })}
          class="btn btn-primary btn-sm"
        >
          {t(ALL_GARMENTS_KEY)}
        </a>
      </EmptyState>
    );
  }
  return (
    <EmptyState message={t('styling.EMPTY')}>
      <PicksLink model={model} />
      {!model.shared && (
        <a href="/wardrobe/new" class="btn btn-primary btn-sm">
          {t('NEW_GARMENT')}
        </a>
      )}
    </EmptyState>
  );
}
