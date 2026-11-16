import type { Child } from 'hono/jsx';
import type { ViewContext } from '../view-context';
import { AppBar, type AppBarProps } from './app-bar';
import { Dock } from './dock';
import { Layout } from './layout';

/**
 * The page's column width, by name, never a per-page `max-w-*` (the tokens
 * are `--container-page-*` in views/assets/main.css):
 *  - `narrow` (40rem): forms, reading and single-column lists. The default,
 *    so a new page stays a column until it earns more.
 *  - `wide` (80rem): galleries, which fill the width the left rail leaves.
 *  - `agenda`: `narrow` below lg, `wide` from it, for a list a phone reads
 *    as one column and a desktop lays out as a grid (the Calendar week, #467).
 * Below the narrow width the column is the screen, so phones are unchanged.
 */
export type PageWidth = 'narrow' | 'wide' | 'agenda';

// Whole class names, so Tailwind finds them. `w-full` beside `mx-auto`: the
// body is a flex column, and a flex item with auto margins sizes to its
// content instead of stretching (a horizontal scroll strip once widened the
// garment page past a phone, #18b).
const WIDTH_CLASS: Readonly<Record<PageWidth, string>> = {
  narrow: 'w-full mx-auto max-w-page-narrow',
  wide: 'w-full mx-auto max-w-page-wide',
  agenda: 'w-full mx-auto max-w-page-narrow lg:max-w-page-wide',
};

/**
 * How far the body's content sits from the column's edges (main.css,
 * `.page-body[data-gutter]`):
 *  - `page` (the default): 1rem each side and below the bar or the tabs.
 *  - `bleed`: 1rem below, none at the sides, for rows that reach the
 *    screen's edges and pad their own text (Styling's strips).
 *  - `flush`: none, for a first row that sits flush under the bar or the
 *    tabs (the Wardrobe's sticky scope row).
 */
export type PageGutter = 'page' | 'bleed' | 'flush';

/** The body region's own frame: what PageBody and the shell both render. */
export interface PageBodyFrame {
  /** For a body htmx swaps in place (the Wardrobe's `#wardrobe-main`). */
  id?: string;
  gutter?: PageGutter;
  /** The body's own flow (flex, gap); never a padding, width or `lg:` layout. */
  class?: string;
}

/**
 * The page's second region beside the body, by layout (docs/plans/
 * 2026-11-16-desktop-layout.md §3.2; the grid areas are main.css's
 * `.page-shell[data-layout]`). Every layout but `single` needs one, and the
 * landmark it is follows from the layout:
 *  - `split`: a `<section>`, the subject (a photo, a collage), left from lg.
 *  - `panel`: an `<aside>`, the work's result, right from lg.
 *  - `facets`: an `<aside>`, a gallery's filters, left from lg.
 *  - `index`: a `<nav>`, the settings index, left from lg, hidden below it
 *    (on a phone the index is Profile itself).
 */
export type PageLayout =
  | { layout?: 'single'; aside?: never; asideLabel?: never }
  | { layout: 'split'; aside: Child; asideLabel?: never }
  | {
      layout: 'panel' | 'facets' | 'index';
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
  /** The document's `<title>`; the app's name when absent (Layout's). */
  title?: string;
  bar: Omit<AppBarProps, 'ctx'>;
  width?: PageWidth;
  body?: PageBodyFrame;
  /**
   * The section's tabs, flush under the app bar and lined up with the
   * column (the Wardrobe's). D3 (#1058) moves them into the bar.
   */
  tabs?: Child;
  /**
   * The page ends on its own bar sticky above the dock (Styling's, #664):
   * it leaves only the dock's height below it, not the dock and a gutter.
   */
  endsOnBar?: boolean;
  /**
   * What the page opens over itself: its sheets and toasts. After `<main>`,
   * outside the regions, so no layout places them.
   */
  overlays?: Child;
  children?: Child;
};

/**
 * One page's frame (#1059): the document, the app bar, `<main>` with the
 * page's regions, and the dock. The shell owns the bar's offset
 * (`--app-bar-h`), the gutter and the room left for the dock; a page brings
 * its content and picks a width, a layout and a gutter by name. Its `lg:`
 * layout lives in main.css, never on a page. `FormPage` and `SettingsPage`
 * are presets of it. `expectFullPage` (test/integration/pages.ts) holds a
 * page to one `.page-shell`.
 */
export function PageShell(props: PageShellProps) {
  const { ctx, layout = 'single' } = props;
  const aside = layout !== 'single' && (
    <PageAside layout={layout} label={props.asideLabel}>
      {props.aside}
    </PageAside>
  );
  return (
    <Layout ctx={ctx} title={props.title}>
      <AppBar ctx={ctx} {...props.bar} />
      <main
        class={`page-shell ${WIDTH_CLASS[props.width ?? 'narrow']}`}
        data-layout={layout}
        data-end={props.endsOnBar ? 'bar' : undefined}
      >
        {props.tabs && <div class="page-tabs">{props.tabs}</div>}
        {ASIDE_FIRST[layout] && aside}
        <PageBody {...props.body}>{props.children}</PageBody>
        {!ASIDE_FIRST[layout] && aside}
      </main>
      {props.overlays}
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The shell's body region. Rendered alone only as the answer to an htmx
 * request that swaps it in place (the Wardrobe's `#wardrobe-main`), with the
 * same frame the page gave its shell.
 */
export function PageBody(props: PageBodyFrame & { children?: Child }) {
  return (
    <div
      id={props.id}
      class={props.class ? `page-body ${props.class}` : 'page-body'}
      data-gutter={props.gutter ?? 'page'}
    >
      {props.children}
    </div>
  );
}

function PageAside(props: {
  layout: ShellLayout;
  label: string | undefined;
  children: Child;
}) {
  switch (props.layout) {
    case 'split':
      return <section class="page-aside">{props.children}</section>;
    case 'index':
      return (
        <nav class="page-aside" aria-label={props.label}>
          {props.children}
        </nav>
      );
    default:
      return (
        <aside class="page-aside" aria-label={props.label}>
          {props.children}
        </aside>
      );
  }
}
