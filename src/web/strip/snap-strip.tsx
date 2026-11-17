import type { Child } from 'hono/jsx';
import { t } from '../i18n';
import { IDEA_GRID } from '../layout/columns';

/**
 * The snap strip: a horizontal scroll-snap carousel whose centred item, with
 * its neighbours peeking, is the choice. The browser does the scrolling (no
 * touch handlers); public/js/snap-strip.js watches which item crosses the
 * strip's centre line and writes that item's `data-snap-value` into the
 * strip's hidden input. A page needs no script of its own. See ./AGENTS.md.
 *
 * Used by Styling's rows (src/web/styling/styling-row.tsx), Recreate's
 * pieces, Ideas, Today, Goes-with's best outfits and a Muse need's options.
 */

/**
 * An item's width and the strip's end spacers go together: each spacer is
 * half the strip less half an item and the strip's gap (`gap-3`, 0.75rem,
 * also falls between a spacer and its item), so the first and last items
 * can be centred and the neighbours peek in what is left. Spacers, not
 * padding (#179): WebKit leaves a flex scroller's end padding out of its
 * scrollable width when the items alone fit, so a strip of two items could
 * not scroll at all in Safari and the second was never chosen. The width is
 * fixed, not a percentage: a flex item's percentage would resolve against
 * the strip, not the item's share of it. Whole class strings, for Tailwind.
 *
 * `item` and `ends` are the phone's; `lgItem` and `lgEnds` the size's step
 * from `lg`, which only a `strip` keeps whole (`DESKTOP`: a `row` drops the
 * spacers, a `grid` both).
 */
const SIZES = {
  regular: {
    item: 'w-28',
    gap: 'gap-3',
    ends: 'before:w-[calc(50%-4.25rem)] after:w-[calc(50%-4.25rem)] before:shrink-0 after:shrink-0',
  },
  // Styling's accessory rows: smaller tiles on a phone, where the outfit
  // leads; from `lg` the same tile and spacers as `roomy`, so every row on
  // the page has one tile size and one origin (#732).
  small: {
    item: 'w-20',
    lgItem: 'lg:w-40',
    gap: 'gap-3',
    ends: 'before:w-[calc(50%-3.25rem)] after:w-[calc(50%-3.25rem)] before:shrink-0 after:shrink-0',
    lgEnds: 'lg:before:w-[calc(50%-5.75rem)] lg:after:w-[calc(50%-5.75rem)]',
  },
  // Styling's garment rows: `regular` on a phone, larger from `lg`.
  roomy: {
    item: 'w-28',
    lgItem: 'lg:w-40',
    gap: 'gap-3',
    ends: 'before:w-[calc(50%-4.25rem)] after:w-[calc(50%-4.25rem)] before:shrink-0 after:shrink-0',
    lgEnds: 'lg:before:w-[calc(50%-5.75rem)] lg:after:w-[calc(50%-5.75rem)]',
  },
  // An idea card (#321): the strip's whole width on a phone (no spacers: the
  // negative margins cancel the gap beside the zero-width pseudo-element),
  // a fixed card from `lg`. The percentage resolves against the strip.
  page: {
    item: 'w-full',
    lgItem: 'lg:w-72',
    gap: 'gap-4',
    ends: 'before:w-0 after:w-0 before:-mr-4 after:-ml-4 before:shrink-0 after:shrink-0',
    lgEnds:
      'lg:before:mr-0 lg:after:ml-0 lg:before:w-[calc(50%-10rem)] lg:after:w-[calc(50%-10rem)]',
  },
  // The same card with the next one peeking in on a phone (Today's rows, a
  // Muse need's options), flush left: the first card cannot be centred there.
  peek: {
    item: 'w-[85%]',
    lgItem: 'lg:w-72',
    gap: 'gap-3',
    ends: 'before:w-0 after:w-0 before:-mr-3 after:-ml-3 before:shrink-0 after:shrink-0',
    lgEnds:
      'lg:before:mr-0 lg:after:ml-0 lg:before:w-[calc(50%-9.75rem)] lg:after:w-[calc(50%-9.75rem)]',
  },
  // Goes-with's best outfits: the next card peeks in on a phone (a single
  // one uses `page`, full width, with the same gap).
  pair: {
    item: 'w-11/12',
    lgItem: 'lg:w-72',
    gap: 'gap-3',
    ends: 'before:w-0 after:w-0 before:-mr-3 after:-ml-3 before:shrink-0 after:shrink-0',
    lgEnds:
      'lg:before:mr-0 lg:after:ml-0 lg:before:w-[calc(50%-9.75rem)] lg:after:w-[calc(50%-9.75rem)]',
  },
} as const satisfies Record<string, SizeClasses>;

/** A size's item width, gap and end spacers on a phone, and their step from `lg`. */
interface SizeClasses {
  item: string;
  lgItem?: string;
  gap: string;
  ends: string;
  lgEnds?: string;
}

export type SnapSize = keyof typeof SIZES;

/**
 * What a strip is from `lg` (docs/plans/2026-11-16-desktop-layout.md §3.5).
 * The strip is a phone gesture, right on a desktop only where the centred
 * item is the choice; below `lg` every mode is the same strip.
 *  - `strip`: the strip at every width (centred, step buttons, arrows).
 *  - `row`: start-aligned, no spacers, items snapping to the start; the
 *    step buttons page by the visible width and the arrows move focus.
 *    Short browse rows (Goes-with).
 *  - `grid`: nothing scrolls; the items flow into `IDEA_GRID` and the step
 *    buttons hide. A paging sentinel among the items loads the next page as
 *    the grid's last row scrolls in (Ideas, Today, a Muse need's options).
 * The strip carries it as `data-snap-desktop` (absent for `strip`), and
 * snap-strip.js watches no `row` or `grid` strip at `lg`: nothing there is
 * chosen by scrolling.
 */
export type StripMode = 'strip' | 'row' | 'grid';

/**
 * A strip's role, which bounds its desktop mode. A choice (`listbox`, the
 * default: the centred item is the value written into its input) keeps its
 * strip at every width, so no other mode type-checks; a strip that is not a
 * choice (`listbox: false`: its tiles hold links and forms, which an
 * `option` would hide from screen readers) names its mode.
 */
export type StripDesktop =
  | { listbox?: true; desktop?: 'strip' }
  | { listbox: false; desktop: StripMode };

/**
 * `StripDesktop` with `tapThrough`, which only a strip that is not a choice
 * takes: a click on a tile's button or link works on the first tap, even
 * on a peeking neighbour (Ideas, Today), instead of centring it.
 */
type SnapStripRole =
  | { listbox?: true; desktop?: 'strip'; tapThrough?: never }
  | { listbox: false; desktop: StripMode; tapThrough?: boolean };

/**
 * A mode's classes from `lg` on the strip, its frame, its spacers and each
 * item, and whether the size's own `lg` step (`lgItem`, `lgEnds`) applies.
 */
interface ModeClasses {
  strip?: string;
  frame?: string;
  ends?: string;
  item?: string;
  sizeItem: boolean;
  sizeEnds: boolean;
}

const NO_ENDS = 'lg:before:hidden lg:after:hidden';

const DESKTOP = {
  strip: { sizeItem: true, sizeEnds: true },
  row: {
    ends: NO_ENDS,
    item: 'lg:snap-start',
    sizeItem: true,
    sizeEnds: false,
  },
  // A cell's width is its track's, and spacers left in would be cells.
  grid: {
    strip: `lg:overflow-x-visible lg:snap-none ${IDEA_GRID}`,
    frame: 'lg:[&>[data-snap-step]]:hidden',
    ends: NO_ENDS,
    item: 'lg:w-auto lg:min-w-0',
    sizeItem: false,
    sizeEnds: false,
  },
} as const satisfies Record<StripMode, ModeClasses>;

function modeOf(kind: StripDesktop): StripMode {
  return kind.desktop ?? 'strip';
}

function classList(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * The strip and, right after it, the hidden input the observer writes the
 * chosen item's value into. The observer pairs them by position (the input is
 * the strip's `nextElementSibling`), so any number of strips can share a
 * container. `value` is the item chosen on the
 * server (`data-selected`, see `snapItem`); "" when none is. A strip given no
 * `name` has no input: the observer still marks the centred item and writes
 * nothing.
 *
 * The strip, its input and the step buttons sit in one `relative` frame, so
 * the buttons overlay the strip's edges. `class` adds to the strip (a page's
 * own freezing or hooks); the strip is
 * `relative`, a flex row and `overscroll-x-contain`.
 */
export function SnapStrip(
  props: SnapStripRole & {
    /** The hidden input's name; none when nothing reads the choice. */
    name?: string;
    value?: string;
    size: SnapSize;
    label: string;
    /**
     * True when no tile holds a focusable control (Goes-with's display-only
     * outfit cards): the strip itself takes focus, so the
     * arrow keys can reach it. Off where tiles are buttons or links, which
     * would only add a second tab stop.
     */
    focusable?: boolean;
    class?: string;
    /** Extra attributes on the strip itself (an `id` a page's test or script finds it by). */
    attributes?: Readonly<Record<string, string>>;
    /** Classes on the frame around the strip and its step buttons (a page hides the buttons while it freezes the strip). */
    frameClass?: string;
    children?: Child;
  },
) {
  const size: SizeClasses = SIZES[props.size];
  const mode = modeOf(props);
  const desktop: ModeClasses = DESKTOP[mode];
  const classes = classList(
    'snap-strip relative flex rounded-box focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary overflow-x-auto snap-x snap-mandatory overscroll-x-contain',
    size.gap,
    size.ends,
    desktop.sizeEnds && size.lgEnds,
    desktop.ends,
    desktop.strip,
    props.class,
  );
  return (
    <div
      class={classList(
        'snap-strip-frame relative',
        desktop.frame,
        props.frameClass,
      )}
    >
      <div
        class={classes}
        role={props.listbox === false ? 'group' : 'listbox'}
        aria-label={props.label}
        tabindex={props.focusable ? 0 : undefined}
        data-snap-strip=""
        data-snap-desktop={mode === 'strip' ? undefined : mode}
        data-snap-tap-through={props.tapThrough ? '' : undefined}
        {...props.attributes}
      >
        {props.children}
      </div>
      {props.name !== undefined && (
        <input type="hidden" name={props.name} value={props.value ?? ''} />
      )}
      <StepButton step={-1} label={props.label} />
      <StepButton step={1} label={props.label} />
    </div>
  );
}

/**
 * The inline module a page with strips renders once (Styling's is its own,
 * `initStyling`): a boosted navigation brings new
 * strips and a `<script src>` module runs only once, so the page asks for
 * the observer on every visit. A fixed string, nothing interpolated.
 */
export function SnapStripsInit() {
  return (
    <script
      type="module"
      dangerouslySetInnerHTML={{
        __html: `import { initSnapStrips } from 'snap-strip';
initSnapStrips(document);`,
      }}
    />
  );
}

/**
 * Previous / next, for a mouse (#311): hidden except where the primary input
 * hovers and is precise (the `fine` variant, views/assets/main.css), so one
 * markup serves every device. Wired by public/js/snap-strip.js. They follow
 * the hidden input in the frame, which keeps it the strip's
 * `nextElementSibling`. Rendered disabled: nothing steps until the script
 * runs, and its `syncSteps` enables each where a step can go. Disabled is
 * `aria-disabled` (daisyUI's `btn-disabled` look), never the attribute,
 * which would drop a focused button's focus at an end (#469).
 */
function StepButton(props: { step: -1 | 1; label: string }) {
  const previous = props.step < 0;
  return (
    <button
      type="button"
      class={`btn btn-circle btn-sm aria-disabled:btn-disabled absolute top-1/2 z-10 hidden -translate-y-1/2 fine:inline-flex ${previous ? 'left-1' : 'right-1'}`}
      data-snap-step={props.step}
      aria-disabled="true"
      aria-label={t(previous ? 'strip.PREVIOUS' : 'strip.NEXT', {
        label: props.label,
      })}
    >
      <span aria-hidden="true">{previous ? '‹' : '›'}</span>
    </button>
  );
}

/**
 * The attributes of one item (spread onto its element): snap-centred, one
 * at a time (`snap-always`), the size's fixed width, an option of the
 * strip's listbox carrying the value it chooses. `group/item` lets the
 * item's children style off `data-selected`. The page adds the element, its
 * look and its own classes. Its `listbox` and `desktop` are its strip's.
 */
export function snapItem(
  props: StripDesktop & {
    value: string;
    selected: boolean;
    size: SnapSize;
    class?: string;
  },
) {
  const option = props.listbox !== false;
  const selected = props.selected ? 'true' : 'false';
  const size: SizeClasses = SIZES[props.size];
  const desktop: ModeClasses = DESKTOP[modeOf(props)];
  return {
    class: classList(
      'snap-item group/item snap-center snap-always shrink-0',
      size.item,
      desktop.sizeItem && size.lgItem,
      desktop.item,
      props.class,
    ),
    role: option ? 'option' : undefined,
    'data-snap-item': '',
    'data-snap-value': props.value,
    'data-selected': props.selected ? '' : undefined,
    'aria-selected': option ? selected : undefined,
  } as const;
}
