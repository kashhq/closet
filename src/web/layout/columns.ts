/**
 * The column steps of a wide page, named once beside the width tokens
 * (`page-shell.tsx`) so a gallery never copies `grid-cols-*`. Responsive from
 * one markup: CSS breakpoints only, the phone layout is the unprefixed class.
 * Whole class names, so Tailwind finds them.
 *
 *  - `GALLERY_GRID`: photo tiles; three on a phone (the plan's density), six
 *    at `lg`. The Wardrobe grid and the capsule page's members.
 *  - `CARD_COLUMNS`: blocks of mixed height (Insights' cards) flowing down
 *    CSS columns, so a short card leaves no hole: one on a phone (stacked
 *    with the same 1rem gap), two at `lg`, three at `xl`.
 *  - `CANDIDATE_GRID`: large product photos with their price and actions
 *    under them (the inbox's Ready to buy and own items): two on a phone,
 *    four at `lg`.
 *  - `OUTFIT_GRID`: saved-outfit tiles (collage and name); two on a phone,
 *    three at `sm`, four at `lg`, five at `xl` (about 215 px at `lg`,
 *    235 px at 1440).
 *  - `PAIR_GRID`: two side by side from `lg` (Today's rows: the planned
 *    suggestion beside the ideas strip; a lone ideas row spans both and
 *    shows two ideas at a time).
 *  - `MUSE_GRID`: Muse's outfit cards (the Outfits tab, #335), the page's
 *    hero, every piece big: one on a phone, two from `lg` (never three:
 *    the pieces being decided on must stay the largest images on the page,
 *    about 150 px at 1440); a row's cards stretch to the tallest, so their
 *    actions line up at the foot.
 */
export const GALLERY_GRID =
  'grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-6';
export const CARD_COLUMNS =
  'space-y-4 lg:space-y-0 lg:columns-2 lg:gap-4 xl:columns-3 lg:*:mb-4 lg:*:break-inside-avoid';
export const PAIR_GRID = 'grid grid-cols-1 items-start gap-4 lg:grid-cols-2';
export const MUSE_GRID = 'grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2';
export const CANDIDATE_GRID =
  'grid grid-cols-2 items-start gap-x-3 gap-y-4 lg:grid-cols-4';
export const OUTFIT_GRID =
  'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';
