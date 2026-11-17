import type { Child } from 'hono/jsx';

/**
 * A page's head as a band (#1070; docs/plans/2026-11-16-desktop-layout.md §4,
 * the Plan page): what the page is for and the ways on, above the content
 * they lead to. Below lg its pieces stack in the body's own flow, the body's
 * `--page-gap` apart (PageShell's `body.gap`), so a page moved into a band
 * keeps its phone pixel for pixel. From lg it is one band across the wide
 * column: the `lead` lines (the subject, a note) span it, and the controls
 * (`children`: chips, then `BandActions`) share the row under them, the
 * actions at its end. The lead's wrapper is `contents` below lg, so its
 * lines are the band's own flex items there. Used by the calendar's plan
 * page.
 */
export function PageBand(props: { lead: Child; children: Child }) {
  return (
    <div class="flex flex-col gap-(--page-gap) lg:flex-row lg:flex-wrap lg:items-end lg:gap-x-8 lg:gap-y-3">
      <div class="contents lg:flex lg:flex-col lg:gap-3 lg:basis-full">
        {props.lead}
      </div>
      {props.children}
    </div>
  );
}

/**
 * A band's actions: a column of full-width buttons on a phone (the buttons
 * bring their own `w-full`), one row of buttons at the band's end from lg,
 * each as wide as its words.
 */
export function BandActions(props: { children: Child }) {
  return (
    <div class="flex flex-col gap-2 lg:flex-row lg:ms-auto lg:*:w-auto">
      {props.children}
    </div>
  );
}
