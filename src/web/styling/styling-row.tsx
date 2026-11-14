import { garmentMarks } from '../../wardrobe/marks';
import type { GarmentRole } from '../../wardrobe/properties';
import { t } from '../i18n';
import { PageSentinel } from '../page-sentinel';
import { GarmentMark } from '../layout/garment-mark';
import { GarmentPicture } from '../layout/parts';
import { categoryLabel } from '../wardrobe/garment';
import { roleLabel } from '../wardrobe/labels';
import { SnapStrip, snapItem, type SnapSize } from '../strip/snap-strip';
import { garmentUrl } from '../wardrobe/urls';
import type { RowGarment, StylingRow } from './rows';
import { STYLING_GARMENTS_PATH, type StylingState, stylingUrl } from './urls';

/**
 * A Styling row (#42): a role's strip of garments, scroll-snap with the
 * neighbours peeking, "No garment" first; the centred garment is the row's
 * choice. The strip is the shared snap strip (src/web/strip/): swiping is
 * the browser's own scrolling (no touch handlers) and its observer writes
 * the centred item into the row's `garmentId`, which is what Save and
 * Shuffle post, with `role` and `lock`, one of each per row in document
 * order. The server marks the chosen item `data-selected`; the observer
 * centres it on load, after a swap and after a history restore.
 *
 * What the row shows is CSS off that state (#106): the chosen item's plinth
 * wears a ring (PLINTH_STATE), and a locked row is frozen: its strip stops
 * scrolling sideways (`overflow-x: hidden`, `touch-action: pan-y
 * pinch-zoom`, so the page still scrolls under a thumb and still zooms under
 * two; `pan-y` alone turned pinch-zoom off over the strip) and its
 * neighbours fade, until the lock is lifted and the strip swipes again from
 * the same item. The neighbours are also `inert` (#146, see `itemState`).
 */

/** Accessories, bags and the rest ride along: smaller items, so the outfit leads. */
const SMALL: readonly GarmentRole[] = ['accessory', 'bag', 'none'];

/** A role that rides along: a small strip, and a small slot at the preview's foot. */
export function ridesAlong(role: GarmentRole): boolean {
  return SMALL.includes(role);
}

/** The strip's item size; see `SnapSize` for how it and the end spacers go together. */
function sizing(role: GarmentRole): SnapSize {
  return ridesAlong(role) ? 'small' : 'roomy';
}

/**
 * The chosen item's plinth wears an ink ring, inset so the strip's own
 * clipping never cuts it. In a locked row the ring takes the lock's clay
 * accent (the theme's "used sparingly": a locked row is one of its uses)
 * and the neighbours fade, so the frozen row reads as one at a glance.
 */
const PLINTH_STATE =
  'ring-inset group-data-selected/item:ring-2 group-data-selected/item:ring-primary group-data-selected/item:group-has-[.styling-lock:checked]/row:ring-accent group-not-data-selected/item:group-has-[.styling-lock:checked]/row:opacity-40';

/**
 * An item's lock attribute. In a locked row the neighbours are `inert`
 * (#146): a frozen strip cannot scroll to reveal one, so Tab reaching it
 * left the focus off-screen; inert takes them out of the tab order, out of
 * the accessibility tree (they are not choosable, so the listbox offers the
 * chosen garment alone, beside a checked "Lock <role>") and out of hit
 * testing (a tap on one lands on the strip). The server renders it so a row
 * opened locked is right from the first paint; styling.js keeps it in step
 * when the lock is toggled and when a strip's next page arrives
 * (`syncLock`).
 */
function itemInert(props: { selected: boolean; locked: boolean }) {
  return { inert: props.locked && !props.selected } as const;
}

/** What a row's links and sentinel need of the page. */
export interface RowContext {
  state: StylingState;
  /** The shared wardrobe shown (garment links carry it), undefined for one's own. */
  viewOwner: number | undefined;
  /** The rows show the Include picks switch (Wardrobe.picksOffered); a strip's next page does not. */
  picksOffered?: boolean;
}

export function StylingRowView(props: {
  row: StylingRow;
  context: RowContext;
}) {
  const { row, context } = props;
  const label = roleLabel(row.role);
  const size = sizing(row.role);
  return (
    <section
      class="group/row flex flex-col gap-1"
      data-styling-row={row.role}
      aria-label={label}
    >
      <div class="flex items-center justify-between px-4">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </h2>
        <LockToggle locked={row.locked} label={label} />
      </div>
      <SnapStrip
        name="garmentId"
        value={row.garmentId?.toString() ?? ''}
        size={size}
        label={t('styling.STRIP_LABEL', { role: label })}
        frameClass="group-has-[.styling-lock:checked]/row:[&_[data-snap-step]]:hidden"
        class="styling-strip group-has-[.styling-lock:checked]/row:overflow-x-hidden group-has-[.styling-lock:checked]/row:touch-pan-y group-has-[.styling-lock:checked]/row:touch-pinch-zoom"
      >
        <NoGarment
          role={row.role}
          selected={row.garmentId === null}
          locked={row.locked}
        />
        {row.garments.map((garment) => (
          <GarmentItem
            garment={garment}
            role={row.role}
            selected={garment.id === row.garmentId}
            locked={row.locked}
            viewOwner={context.viewOwner}
          />
        ))}
        {row.moreBefore !== undefined && (
          <StripSentinel
            role={row.role}
            before={row.moreBefore}
            context={context}
          />
        )}
      </SnapStrip>
      <input type="hidden" name="role" value={row.role} />
      <input type="hidden" name="lock" value={row.locked ? '1' : ''} />
    </section>
  );
}

/**
 * Lock: the row is frozen (no swiping, see the header) and Shuffle leaves
 * it as it is. The checkbox has no name: styling.js (`setLocked`) writes
 * the row's `lock` field, which posts in step with its `role` and
 * `garmentId` (an unchecked box would post nothing and shift the lists),
 * mirrors its state into its `checked` attribute, which htmx's history
 * snapshot (innerHTML) keeps, so a row restored by Back is still frozen and
 * still reads locked, and makes the neighbours inert or not.
 */
function LockToggle(props: { locked: boolean; label: string }) {
  return (
    // daisyUI's swap: the label is the control (its input has no box), so
    // it shows the keyboard focus its checkbox has.
    <label class="swap btn btn-ghost btn-xs btn-circle has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
      <input
        type="checkbox"
        class="styling-lock"
        checked={props.locked}
        aria-label={t('styling.LOCK', { role: props.label })}
      />
      {/* Heroicons' lock-closed and lock-open, outline. */}
      <svg
        class="swap-on size-4 text-accent"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
      <svg
        class="swap-off size-4 text-muted"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
    </label>
  );
}

/** The builder's position 0: the row adds nothing to the outfit. */
function NoGarment(props: {
  role: GarmentRole;
  selected: boolean;
  locked: boolean;
}) {
  return (
    <button
      type="button"
      {...snapItem({
        value: '',
        selected: props.selected,
        size: sizing(props.role),
        class: 'styling-item flex flex-col gap-1',
      })}
      {...itemInert(props)}
    >
      <span
        class={`aspect-square w-full rounded-box border border-dashed border-base-300 flex items-center justify-center text-faint text-2xl ${PLINTH_STATE}`}
      >
        —
      </span>
      <span class="text-xs text-muted truncate">{t('styling.NO_GARMENT')}</span>
    </button>
  );
}

/**
 * A garment on the plinth, its cutout contained (never cropped). A tap on
 * the centred one opens its page; a tap on a neighbour centres it
 * (snap-strip.js). The strips show the 400 px thumb, made from the cutout.
 */
function GarmentItem(props: {
  garment: RowGarment;
  role: GarmentRole;
  selected: boolean;
  locked: boolean;
  viewOwner: number | undefined;
}) {
  const { garment } = props;
  return (
    <a
      href={garmentUrl(garment.id, props.viewOwner)}
      {...snapItem({
        value: String(garment.id),
        selected: props.selected,
        size: sizing(props.role),
        class: 'styling-item flex flex-col gap-1 no-underline',
      })}
      {...itemInert(props)}
    >
      <span
        class={`aspect-square w-full rounded-box bg-base-200 flex items-center justify-center p-2 ${PLINTH_STATE}`}
        data-styling-plinth=""
      >
        <GarmentLook
          garment={garment}
          loading={props.selected ? 'eager' : 'lazy'}
        />
      </span>
      <span class="text-xs truncate">
        {garment.name ?? categoryLabel(garment.category)}
      </span>
      <GarmentMark
        marks={garmentMarks(garment, {
          ownerView: props.viewOwner === undefined,
        })}
      />
    </a>
  );
}

/**
 * A garment's picture, its cutout's thumb contained, or the hanger without
 * a photo: what its plinth holds and what the preview's slot shows. One
 * markup for both, since styling.js copies a chosen item's plinth children
 * into its slot (`data-styling-plinth`) and the server draws the slot with
 * this on first paint and in every rows answer.
 */
export function GarmentLook(props: {
  garment: RowGarment;
  loading: 'eager' | 'lazy';
}) {
  return <GarmentPicture photo={props.garment.photo} loading={props.loading} />;
}

/**
 * The end of the strip's window: fetches the next page of the role's cycle
 * when it scrolls into view and is replaced by it (and its own sentinel).
 * `intersect`, not `revealed`: that one watches the window's scroll, never
 * a horizontal strip's (AGENTS.md, Gotchas).
 */
function StripSentinel(props: {
  role: GarmentRole;
  before: number;
  context: RowContext;
}) {
  const url = stylingUrl(props.context.state, STYLING_GARMENTS_PATH, [
    `role=${props.role}`,
    `before=${props.before}`,
  ]);
  return (
    <PageSentinel
      as="span"
      class="snap-center shrink-0 w-12 flex items-center justify-center"
      href={url}
      trigger="intersect once"
      marker="strip"
      label={t('LOADING_MORE')}
      size="sm"
    />
  );
}

/**
 * GET /styling/garments: the next page of a strip, and its sentinel when
 * more follow. Never chosen and never inert: the request does not carry the
 * row's lock, so styling.js makes them inert as they land in a locked row.
 */
export function StripPage(props: {
  role: GarmentRole;
  garments: RowGarment[];
  more: boolean;
  context: RowContext;
}) {
  const last = props.garments.at(-1);
  return (
    <>
      {props.garments.map((garment) => (
        <GarmentItem
          garment={garment}
          role={props.role}
          selected={false}
          locked={false}
          viewOwner={props.context.viewOwner}
        />
      ))}
      {props.more && last && (
        <StripSentinel
          role={props.role}
          before={last.id}
          context={props.context}
        />
      )}
    </>
  );
}
