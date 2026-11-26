import type { Child } from 'hono/jsx';
import type { ViewContext } from '../view-context';
import { ActionBar, type ActionBarProps } from './action-bar';
import { AppBar, type AppBarProps } from './app-bar';
import { Dock } from './dock';
import { Layout, type PageMeta } from './layout';

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
 *  - `page` (the default): 1rem each side and below the bar.
 *  - `bleed`: 1rem below, none at the sides, for rows that reach the
 *    screen's edges and pad their own text (Styling's strips).
 *  - `flush`: none, for a first row that sits flush under the bar (the
 *    Wardrobe's sticky scope row); the content pads itself.
 */
export type PageGutter = 'page' | 'bleed' | 'flush';

/**
 * The body's flow, by name: absent, its children flow as blocks; a `gap`
 * stacks them in a column that far apart (Tailwind's steps, in main.css's
 * `.page-body[data-gap]`, where a `split` page's phone stack also leaves it
 * between the subject and the body). Padding and width are the shell's
 * (`gutter`, `width`), so the body takes no class.
 */
export type PageGap = 3 | 4 | 5 | 6 | 8;

/** The body region's own frame: what PageBody and the shell both render. */
export interface PageBodyFrame {
  gutter?: PageGutter;
  gap?: PageGap;
}

/**
 * A page's regions, each with a stable id the shell derives from the page's
 * `name` (`regionId`): the target an htmx fragment swaps (`#wardrobe-body`)
 * or an out-of-band swap names. A fragment swaps only the region it owns,
 * and answers the others it changes out of band (`PageFragment`).
 * `actions` is the action bar (`actionBar`, action-bar.tsx); every page
 * renders it, empty and `hidden` when the page has no bar, so a fragment
 * that brings or drops the bar always finds it.
 */
export type PageRegion = 'body' | 'aside' | 'actions';

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
 *  - `facets`: an `<aside>`, a gallery's filters, left from lg (a `filters`
 *    sheet docks here, §3.3: it goes in `aside`, never in `overlays`; on a
 *    phone the aside takes no room, its sheet closed).
 *  - `index`: a `<nav>`, the settings index, left from lg, hidden below it
 *    (on a phone the index is Profile itself).
 * Only `single` takes a `width`: the others are wide frames whose columns
 * main.css sizes, so a split body cannot be squeezed into a narrow one.
 * `panel`'s aside follows the body; on a phone it continues the body's
 * flow (`asideBelowLg: 'after'`, the body's `gap`, `PageAside`: a trip's
 * packing list) or is the bar riding on the dock (`'bar'`: Styling's
 * outfit, Shuffle and Save). Only `single` takes an `actionBar`: a panel's
 * controls live in its aside, which is already in reach at both sizes.
 *
 * `centred` is the standalone page (sign in, register, the invite landing,
 * the offline page): its body is one column centred in the room the bar and
 * the dock leave, from the top once it is taller than that, with no aside
 * and no width (main.css, `.page-shell[data-layout="centred"]`). `AccountShell`
 * is its preset.
 */
export type PageLayout =
  | {
      layout?: 'single';
      width?: PageWidth;
      aside?: never;
      asideLabel?: never;
      /** The page's action bar, which the shell places (action-bar.tsx). */
      actionBar?: ActionBarProps;
    }
  | {
      layout: 'centred';
      width?: never;
      aside?: never;
      asideLabel?: never;
      actionBar?: never;
    }
  | {
      layout: 'split';
      width?: never;
      aside: Child;
      asideLabel?: never;
      actionBar?: never;
      /**
       * The subject below lg: `first`, stacked above the body (the default:
       * the garment and outfit pages), or `hidden`, the page then the
       * narrow column a `single` page is (FormPage's: a form the phone
       * reached from its subject's page shows only the fields, #1069).
       */
      subjectBelowLg?: 'first' | 'hidden';
    }
  | {
      layout: 'panel';
      width?: never;
      aside: Child;
      /** The landmark's accessible name. */
      asideLabel: string;
      actionBar?: never;
      /**
       * The aside below lg: `after`, the body's flow continued under it
       * (the default: a trip's packing list), or `bar`, the bar above the
       * dock (#664's sticky stack, main.css `[data-aside="bar"]`): sticky
       * in the flow after the body, so it rides on the dock while the body
       * scrolls and lands below its end, covering nothing whatever its
       * height. For an aside the phone keeps in reach (Styling, #1073).
       */
      asideBelowLg?: 'after' | 'bar';
    }
  | {
      layout: 'facets' | 'index';
      width?: never;
      aside: Child;
      /** The landmark's accessible name. */
      asideLabel: string;
      actionBar?: never;
    };

type ShellLayout = NonNullable<PageLayout['layout']>;

/** The layouts that have a second region beside the body. */
type AsideLayout = Exclude<ShellLayout, 'single' | 'centred'>;

/**
 * Whether a layout's aside comes before the body. The DOM order is the
 * desktop's visual order (left to right), so keyboard, reader and the
 * phone's stack agree.
 */
const ASIDE_FIRST: Readonly<Record<ShellLayout, boolean>> = {
  single: false,
  centred: false,
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
  /** The page's own link preview (og tags), passed to `Layout`. */
  meta?: PageMeta;
  bar: Omit<AppBarProps, 'ctx'>;
  body?: PageBodyFrame;
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
 * (`--app-bar-h`), the gutter, the room left for the dock and for its
 * action bar (main.css keys it off `.action-bar`), the bar's place and the
 * regions' ids; a page brings its content and picks a layout, a width
 * (`single`), a gutter and a gap by name. Its `lg:`
 * layout lives in main.css, never on a page. `FormPage` and `SettingsPage`
 * are presets of it. `expectFullPage` (test/integration/pages.ts) holds a
 * page to one `.page-shell`; guards.conf `@page-main` holds every `<main>`
 * to this file.
 */
export function PageShell(props: PageShellProps) {
  const { ctx, bar, layout = 'single' } = props;
  return (
    <Layout ctx={ctx} title={documentTitle(props)} {...props.meta}>
      <AppBar ctx={ctx} {...bar} />
      <main
        class={`page-shell ${layout === 'single' ? WIDTH_CLASS[props.width ?? 'narrow'] : FRAME_CLASS}`}
        data-layout={layout}
        data-subject={
          props.layout === 'split' && props.subjectBelowLg === 'hidden'
            ? 'lg'
            : undefined
        }
        data-aside={asideBar(props) ? 'bar' : undefined}
      >
        {mainRegions(props, layout)}
      </main>
      {props.overlays}
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * `<main>`'s regions in DOM order: a left aside precedes the body and a
 * right one follows it (the desktop's left to right, also the phone's
 * stack), and the action bar comes last, the phone's visual order (fixed
 * above the dock), so Tab reaches the content before the controls acting on
 * it. From lg main.css lifts the bar to the head of the column by `order`,
 * never the markup.
 */
function mainRegions(props: PageShellProps, layout: ShellLayout): Child[] {
  const { name } = props;
  const asideFirst = ASIDE_FIRST[layout];
  const aside = layout !== 'single' && layout !== 'centred' && (
    <PageAside
      id={regionId(name, 'aside')}
      layout={layout}
      label={props.asideLabel}
      gap={asideFirst || asideBar(props) ? undefined : props.body?.gap}
    >
      {props.aside}
    </PageAside>
  );
  return [
    asideFirst && aside,
    <PageBody name={name} {...props.body}>
      {props.children}
    </PageBody>,
    !asideFirst && aside,
    <ActionsRegion name={name} bar={props.actionBar} />,
  ];
}

/** A `panel` whose aside is the phone's bar above the dock (`asideBelowLg`). */
function asideBar(props: PageShellProps): boolean {
  return props.layout === 'panel' && props.asideBelowLg === 'bar';
}

/** A page's aside as its shell renders it: what `PageFragment` answers too. */
export interface PageAsideFrame {
  layout: AsideLayout;
  /** The landmark's accessible name (`asideLabel`); `split`'s section has none. */
  label?: string;
  content: Child;
}

/**
 * The answer to an htmx request that swaps a page's body in place (the
 * Wardrobe's filtering targets `#<name>-body`, outerHTML): the body with the
 * same name and frame the page gave its shell, and the actions region out
 * of band, so the bar follows the body it acts on. Filtering select mode
 * to no tiles drops the bar, back to some brings it, and its controls'
 * `form=` names the form in this answer. A page with a swapped body answers
 * through this, never a bare body, so no fragment leaves a stale bar.
 *
 * `aside` sends the aside region out of band too, its content only
 * (`innerHTML`): the region element stays, so its scroll (a docked facet
 * column scrolls inside itself) and the focus htmx restores by id survive,
 * and its content always shows the state the answer's URL asks for. A
 * history snapshot serialises attributes, never a checked radio's
 * property, so an aside kept across a pushed answer restored Back with the
 * wrong choices beside a grid filtered by the right ones (#1067).
 */
export function PageFragment(
  props: PageBodyFrame & {
    name: string;
    actionBar: ActionBarProps | undefined;
    aside?: PageAsideFrame;
    children?: Child;
  },
) {
  const { name, actionBar, aside, children, ...frame } = props;
  return (
    <>
      <PageBody name={name} {...frame}>
        {children}
      </PageBody>
      {aside && (
        <PageAside
          id={regionId(name, 'aside')}
          layout={aside.layout}
          label={aside.label}
          oob
        >
          {aside.content}
        </PageAside>
      )}
      <ActionsRegion name={name} bar={actionBar} oob />
    </>
  );
}

/** `#<name>-actions`: the page's bar, else its empty place (PageRegion). */
function ActionsRegion(props: {
  name: string;
  bar: ActionBarProps | undefined;
  oob?: boolean;
}) {
  const id = regionId(props.name, 'actions');
  if (props.bar) return <ActionBar id={id} oob={props.oob} {...props.bar} />;
  return <div id={id} hidden hx-swap-oob={props.oob ? 'true' : undefined} />;
}

/** The document's `<title>`: the page's own, else the bar's when it is a string. */
function documentTitle(props: PageShellProps): string | undefined {
  if (props.title !== undefined) return props.title;
  return typeof props.bar.title === 'string' ? props.bar.title : undefined;
}

/** The shell's body region, `#<name>-body` (PageShell, PageFragment). */
function PageBody(props: PageBodyFrame & { name: string; children?: Child }) {
  return (
    <div
      id={regionId(props.name, 'body')}
      class="page-body"
      data-gutter={props.gutter ?? 'page'}
      data-gap={props.gap}
    >
      {props.children}
    </div>
  );
}

/**
 * The shell's second region, `#<name>-aside`. One that follows the body
 * (`panel`'s) continues the body's flow on a phone, where it stacks under
 * it: the body's `gap` inside it and before it (main.css), so a page whose
 * last sections move into it keeps its phone pixel for pixel.
 */
function PageAside(props: {
  id: string;
  layout: AsideLayout;
  label: string | undefined;
  /** In a fragment (PageFragment): its content swapped into the region in place. */
  oob?: boolean;
  /** `panel`'s: the body's, as its phone flow continues here (mainRegions); none for a bar. */
  gap?: PageGap;
  children: Child;
}) {
  const region = {
    id: props.id,
    class: 'page-aside',
    'data-gap': props.gap,
    'hx-swap-oob': props.oob ? 'innerHTML' : undefined,
  };
  switch (props.layout) {
    case 'split':
      return <section {...region}>{props.children}</section>;
    case 'index':
      return (
        <nav {...region} aria-label={props.label}>
          {props.children}
        </nav>
      );
    default:
      return (
        <aside {...region} aria-label={props.label}>
          {props.children}
        </aside>
      );
  }
}
