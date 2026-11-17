import type { Child } from 'hono/jsx';

/**
 * A page's action bar (#1063; docs/plans/2026-11-16-desktop-layout.md §3.4):
 * the controls that act on the page's content, kept in reach while it
 * scrolls. A page never renders one: it hands `PageShell` its `actionBar`,
 * and the shell places it in its own region (`#<name>-actions`) beside the
 * body, at most one a page. Its box, its places and the room it takes are
 * main.css's (`.action-bar`, beside `--action-bar-h`), never a page's
 * classes. The kind is #664's rule, by whether its height is known:
 *  - `row` (the default): one row of `btn-sm` controls and short text
 *    (Laundry's Mark washed, select mode's count and verbs, the capsule
 *    picker's Save). Below lg it is fixed above the dock; from lg it sticks
 *    at the head of `<main>` under the app bar, aligned to the content
 *    column, above the rows it acts on. Its height is `--action-bar-h` at
 *    every text size: the row never wraps (at large text it scrolls
 *    sideways), so the scroll padding and the shell's reservation, which
 *    read the same token, always match it (#1030). It follows the body in
 *    the DOM, the phone's visual order, so Tab reaches the rows before it;
 *    from lg main.css moves it to the head (`order`), not the markup.
 *  - `stack`: content whose height varies (Styling's preview, fit line,
 *    Shuffle and Save). Below lg it is sticky above the dock in the flow
 *    after the body: it rides on the dock while the body scrolls and lands
 *    below its end, so it covers nothing and needs no reservation. From lg
 *    it is the column beside the body, sticky under the app bar.
 * `align` places a row's controls: `end` (one action) or `between` (a
 * status at the start, the actions at the end).
 */
export type ActionBarProps =
  | {
      kind?: 'row';
      align?: 'end' | 'between';
      children: Child;
    }
  | { kind: 'stack'; align?: never; children: Child };

/**
 * Rendered by page-shell.tsx only (`PageShell`, `PageFragment`), which gives
 * it the region's id and, in a fragment, marks it out of band.
 */
export function ActionBar(
  props: ActionBarProps & { id: string; oob?: boolean },
) {
  const kind = props.kind ?? 'row';
  return (
    <div
      id={props.id}
      hx-swap-oob={props.oob ? 'true' : undefined}
      class="action-bar"
      data-kind={kind}
      data-align={kind === 'row' ? (props.align ?? 'end') : undefined}
    >
      {props.children}
    </div>
  );
}
