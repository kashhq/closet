/**
 * The "load more" sentinel at the end of a paged list (the wardrobe
 * grid's, lifted here by #660): as it comes into view it GETs `href`, the next
 * page, and is replaced (`outerHTML`) by that page and its own sentinel,
 * none after the last. Every paged list uses it: the wardrobe grid, the
 * Saved tab and the outfit pickers, the Ideas strip, Styling's rows and
 * the Muse inbox. `revealed` watches the window's scroll, which a list in
 * the page's flow needs; a sentinel inside a scroll container (a strip)
 * must use `intersect once`, as `revealed` never fires there
 * (src/web/gallery/AGENTS.md). Offline, a page never fetched before fails
 * as `htmx:sendError` (the worker's catch handler), which connectivity.js
 * turns into the offline banner; the sentinel stays, and the list ends
 * where the cache does. `marker` names it for the specs
 * (`data-<marker>-more`); `label` says what is loading.
 */
export function PageSentinel(props: {
  href: string;
  trigger: 'revealed' | 'intersect once';
  as: 'div' | 'li' | 'span';
  class: string;
  marker: string;
  label: string;
  size?: 'sm' | 'md';
}) {
  const Element = props.as;
  const marker = { [`data-${props.marker}-more`]: '' };
  return (
    <Element
      class={props.class}
      hx-get={props.href}
      hx-trigger={props.trigger}
      hx-swap="outerHTML"
      {...marker}
    >
      <span
        class={`loading loading-dots ${props.size === 'sm' ? 'loading-sm' : 'loading-md'} text-muted`}
        aria-label={props.label}
      ></span>
    </Element>
  );
}
