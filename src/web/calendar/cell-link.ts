/**
 * A calendar day cell's link (the week strip's days, the month's cells,
 * #1210): the link wraps only the date, the text its aria-label starts from,
 * and its ::after stretches over the cell, so the whole cell is the tap and
 * the rest of the cell (the weekday letter, the weather chip, the collage,
 * "+N") is not part of the link's visible text: a voice-control user says
 * what the label says (axe's label-content-name-mismatch). The cell is
 * `relative isolate`: the ::after's z-index lifts it over the cell's
 * positioned collage, inside the cell's own stacking context. The focus ring
 * is the ::after's, drawn inside the cell, whose overflow may clip.
 */
export const CELL_LINK =
  'after:absolute after:inset-0 after:z-10 after:rounded-field focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary';

/** The cell around a CELL_LINK. */
export const LINKED_CELL = 'relative isolate rounded-field hover:bg-base-200';
