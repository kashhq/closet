import type { Child } from 'hono/jsx';
import type { ViewContext } from '../view-context';
import { AppBar, type AppBarProps } from './app-bar';
import { Dock } from './dock';
import { Layout } from './layout';

/**
 * A `single` page's column width, by name, never a per-page `max-w-*` (the
 * tokens are `--container-page-*` in views/assets/main.css):
 *  - `narrow` (40rem): forms, reading and single-column lists. The default,
 *    so a new page stays a column until it earns more.
 *  - `wide` (80rem): galleries, which fill the width the left rail leaves.
 *  - `agenda`: `narrow` below lg, `wide` from it, for a list a phone reads
 *    as one column and a desktop lays out as a grid (the Calendar week, #467).
 * Below the narrow width the column is the screen, so phones are unchanged.
 * Every other layout owns its frame's width in main.css.
 */
export type PageWidth = 'narrow' | 'wide' | 'agenda';

// Whole class names, so Tailwind finds them. `w-full` beside `mx-auto`: the
// body is a flex column, and a flex item with auto margins sizes to its
// content instead of stretching (a horizontal scroll strip once widened the
// garment page past a phone, #18b).
const FRAME_CLASS = 'w-full mx-auto';
const WIDTH_CLASS: Readonly<Record<PageWidth, string>> = {
  narrow: `${FRAME_CLASS} max-w-page-narrow`,
  wide: `${FRAME_CLASS} max-w-page-wide`,
  agenda: `${FRAME_CLASS} max-w-page-narrow lg:max-w-page-wide`,
};

/**
 * How far the body's content sits from the column's edges (main.css,
 * `.page-body[data-gutter]`):
 *  - `page` (the default): 1rem each side and below the bar or the tabs.
 *  - `bleed`: 1rem below, none at the sides, for rows that reach the
 *    screen's edges and pad their own text (Styling's strips).
 *  - `flush`: none, for a first row that sits flush under the bar or the
 *    tabs (the Wardrobe's sticky scope row); the content pads itself.
 */
export type PageGutter = 'page' | 'bleed' | 'flush';

/**
 * The body's flow, by name: absent, its children flow as blocks; a `gap`
 * stacks them in a column that far apart (Tailwind's steps). Padding and
 * width are the shell's (`gutter`, `width`), so the body takes no class.
 */
export type PageGap = 3 | 4 | 5 | 6 | 8;

const GAP_CLASS: Readonly<Record<PageGap, string>> = {
  3: 'flex flex-col gap-3',
  4: 'flex flex-col gap-4',
  5: 'flex flex-col gap-5',
  6: 'flex flex-col gap-6',
  8: 'flex flex-col gap-8',
};

/** The body region's own frame: what PageBody and the shell both render. */
export interface PageBodyFrame {
  gutter?: PageGutter;
  gap?: PageGap;
}

/**
 * A page's regions, each with a stable id the shell derives from the page's
 * `name` (`regionId`): the target an htmx fragment swaps (`#wardrobe-body`)
 * or an out-of-band swap names. A fragment swaps only the region it owns.
 */
export type PageRegion = 'body' | 'aside';

export function regionId(name: string, region: PageRegion): string {
  return `${name}-${region}`;
}

/**
 * The page's second region beside the body, by layout (docs/plans/
 * 2026-11-16-desktop-layout.md §3.2; the grid areas and the frame's width
 * are main.css's `.page-shell[data-layout]`). Every layout but `single`
 * needs one, and the landmark it is follows from the layout:
 *  - `split`: a `<section>`, the subject (a photo, a collage), left from lg.
 *  - `panel`: an `<aside>`, the work's result, right from lg.
 *  - `facets`: an `<aside>`, a gallery's filters, left from lg (a filter
 *    sheet docks here, §3.3: it goes in `aside`, never in `overlays`).
 *  - `index`: a `<nav>`, the settings index, left from lg, hidden below it
 *    (on a phone the index is Profile itself).
 * Only `single` takes a `width`: the others are wide frames whose columns
 * main.css sizes, so a split body cannot be squeezed into a narrow one.
 */
export type PageLayout =
  | {
      layout?: 'single';
      width?: PageWidth;
      aside?: never;
      asideLabel?: never;
    }
  | { layout: 'split'; width?: never; aside: Child; asideLabel?: never }
  | {
      layout: 'panel' | 'facets' | 'index';
      width?: never;
      aside: Child;
      /** The landmark's accessible name. */
      asideLabel: string;
    };

type ShellLayout = NonNullable<PageLayout['layout']>;

/**
 * Whether a layout's aside comes before the body. The DOM order is the
 * desktop's visual order (left to right), so keyboard, reader and the
 * phone's stack agree.
 */
const ASIDE_FIRST: Readonly<Record<ShellLayout, boolean>> = {
  single: false,
  split: true,
  panel: false,
  facets: true,
  index: true,
};

export type PageShellProps = PageLayout & {
  ctx: ViewContext;
  /** Prefixes the regions' ids (`regionId`): `<name>-body`, `<name>-aside`. */
  name: string;
  /**
   * The document's `<title>`: the bar's title when that is a string, else
   * the app's name (Layout's). Set it only where the two differ.
   */
  title?: string;
  bar: Omit<AppBarProps, 'ctx'>;
  body?: PageBodyFrame;
  /**
   * The section's tabs, flush under the app bar and lined up with the
   * column (the Wardrobe's). D3 (#1058) moves them into the bar.
   */
  tabs?: Child;
  /**
   * The page ends on its own bar sticky above the dock (Styling's, #664):
   * it leaves only the dock's height below it, not the dock and a gutter.
   * Superseded by `actionBar` in D5 (#1058), which implies it; removed then.
   */
  endsOnBar?: boolean;
  /**
   * What the page opens over itself: its sheets, dialogs and toasts. After
   * `<main>`, outside the regions, so no layout places them. A filter sheet
   * is not one: it goes in `aside` (`facets`), where the desktop docks it.
   */
  overlays?: Child;
  children?: Child;
};

/**
 * One page's frame (#1059): the document, the app bar, `<main>` with the
 * page's regions, and the dock. The shell owns the bar's offset
 * (`--app-bar-h`), the gutter, the room left for the dock and for an action
 * bar fixed above it, and the regions' ids; a page brings its content and
 * picks a layout, a width (`single`), a gutter and a gap by name. Its `lg:`
 * layout lives in main.css, never on a page. `FormPage` and `SettingsPage`
 * are presets of it. `expectFullPage` (test/integration/pages.ts) holds a
 * page to one `.page-shell`; guards.conf `@page-main` holds every `<main>`
 * to this file.
 */
export function PageShell(props: PageShellProps) {
  const { ctx, name, bar, layout = 'single' } = props;
  const aside = layout !== 'single' && (
    <PageAside
      id={regionId(name, 'aside')}
      layout={layout}
      label={props.asideLabel}
    >
      {props.aside}
    </PageAside>
  );
  const title =
    props.title ?? (typeof bar.title === 'string' ? bar.title : undefined);
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} {...bar} />
      <main
        class={`page-shell ${layout === 'single' ? WIDTH_CLASS[props.width ?? 'narrow'] : FRAME_CLASS}`}
        data-layout={layout}
        data-end={props.endsOnBar ? 'bar' : undefined}
      >
        {props.tabs && <div class="page-tabs">{props.tabs}</div>}
        {ASIDE_FIRST[layout] && aside}
        <PageBody name={name} {...props.body}>
          {props.children}
        </PageBody>
        {!ASIDE_FIRST[layout] && aside}
      </main>
      {props.overlays}
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The shell's body region, `#<name>-body`. Rendered alone only as the answer
 * to an htmx request that swaps it in place (the Wardrobe's), with the same
 * name and frame the page gave its shell.
 */
export function PageBody(
  props: PageBodyFrame & { name: string; children?: Child },
) {
  const flow = props.gap === undefined ? '' : ` ${GAP_CLASS[props.gap]}`;
  return (
    <div
      id={regionId(props.name, 'body')}
      class={`page-body${flow}`}
      data-gutter={props.gutter ?? 'page'}
    >
      {props.children}
    </div>
  );
}

function PageAside(props: {
  id: string;
  layout: ShellLayout;
  label: string | undefined;
  children: Child;
}) {
  switch (props.layout) {
    case 'split':
      return (
        <section id={props.id} class="page-aside">
          {props.children}
        </section>
      );
    case 'index':
      return (
        <nav id={props.id} class="page-aside" aria-label={props.label}>
          {props.children}
        </nav>
      );
    default:
      return (
        <aside id={props.id} class="page-aside" aria-label={props.label}>
          {props.children}
        </aside>
      );
  }
}
