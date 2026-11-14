/**
 * A bar of section tabs that are plain boosted links (the Wardrobe's, the
 * Outfits page's and the Calendar's): the one writer of their markup and
 * look (`@link-tabs`, scripts/ci/guards.conf). A `<nav>` with the current
 * page as `aria-current="page"`, like the dock: they navigate, so no
 * `role=tab` (a screen reader would promise a tab widget and arrow keys).
 * One underline variant, no class from a caller, so every bar looks the
 * same, spacing included (`mb-4 px-4`: callers add no wrapper); the inactive colour is main.css's (the muted token). `label`
 * names the nav, distinct per bar on a page that has two. A `false` entry
 * is a tab left out (Laundry in a shared wardrobe).
 */
export function LinkTabs<T extends string>(props: {
  active: T;
  label: string;
  tabs: readonly ({ name: T; href: string; label: string } | false)[];
  id?: string;
}) {
  return (
    <nav
      class="tabs tabs-border mb-4 px-4"
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
