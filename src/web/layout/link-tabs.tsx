/** A bar of link tabs: what `LinkTabs` and the app bar's `tabs` take. */
export interface LinkTabsProps<T extends string = string> {
  active: T;
  /** Names the nav, distinct per bar on a page that has two. */
  label: string;
  /** A `false` entry is a tab left out (Laundry in a shared wardrobe). */
  tabs: readonly ({ name: T; href: string; label: string } | false)[];
  id?: string;
}

/**
 * Where a bar of tabs sits, which is all its spacing depends on:
 *  - `page`: a page's own row of sub-tabs (Saved's two lists), in the
 *    body's flow, with room below it.
 *  - `bar`: a section's tabs, which only the app bar renders (its `tabs`,
 *    app-bar.tsx): the header's second row on a phone, inline after the
 *    title from lg (`.app-bar-tabs`, main.css).
 */
type TabsPlacement = 'page' | 'bar';

const PLACEMENT_CLASS: Readonly<Record<TabsPlacement, string>> = {
  page: 'tabs tabs-border mb-4 px-4',
  bar: 'tabs tabs-border app-bar-tabs px-2',
};

/**
 * A bar of tabs that are plain boosted links (a section's: the Wardrobe's,
 * the Outfits page's and the Calendar's; a page's own sub-tabs): the one
 * writer of their markup and look (`@link-tabs`, scripts/ci/guards.conf). A
 * `<nav>` with the current page as `aria-current="page"`, like the dock:
 * they navigate, so no `role=tab` (a screen reader would promise a tab
 * widget and arrow keys). One underline variant, no class from a caller,
 * so every bar looks the same; the spacing is the placement's (callers add
 * no wrapper), the inactive colour main.css's (the muted token).
 */
export function LinkTabs<T extends string>(
  props: LinkTabsProps<T> & { placement?: TabsPlacement },
) {
  return (
    <nav
      class={PLACEMENT_CLASS[props.placement ?? 'page']}
      aria-label={props.label}
      id={props.id}
    >
      {props.tabs.map(
        (tab) =>
          tab && (
            <a
              href={tab.href}
              class={props.active === tab.name ? 'tab tab-active' : 'tab'}
              aria-current={props.active === tab.name ? 'page' : undefined}
            >
              {tab.label}
            </a>
          ),
      )}
    </nav>
  );
}
