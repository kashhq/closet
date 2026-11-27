/**
 * Every grid's columns, named once (#1064): ESLint refuses `grid-cols-*` and
 * `columns-*` anywhere else in `src/`, so a page picks a grid by name and
 * never copies a count. Responsive from one markup: CSS breakpoints only, the
 * phone layout is the unprefixed class, and nothing changes past `lg` but
 * density (docs/plans/2026-11-16-desktop-layout.md §3.6). Whole class names,
 * so Tailwind finds them.
 *
 * **The galleries auto-fill from `lg`**: `repeat(auto-fill, minmax(<tile>,
 * 1fr))`, the minimum a `--tile-*` token in `main.css` beside the page widths,
 * so 1024, 1440 and 1920 each get as many columns as fit, never a third
 * layout. Below `lg` they keep their fixed counts.
 *
 *  - `GALLERY_GRID`: photo tiles; three on a phone (the plan's density), four
 *    at `sm`, from `lg` `--tile-garment` wide: six at 1024, seven at 1280,
 *    eight of about 145 px at 1440 (the design's 9.5rem gave seven). The
 *    Wardrobe grid and the capsule page's members.
 *  - `OUTFIT_GRID`: saved-outfit tiles (collage and name), the Saved tab and
 *    Inspiration's looks; two on a phone, three at `sm`, from `lg`
 *    `--tile-outfit` (five at 1280, six at 1440).
 *  - `IDEA_GRID`: idea cards, from `lg` only: `--tile-idea` wide, four at
 *    1440. Below `lg` the cards are a strip (`SnapStrip desktop="grid"`,
 *    src/web/strip/snap-strip.tsx: Ideas, Today's ideas, an agent need's
 *    options) or the parent's stack (Today's planned cards beside them,
 *    so both sit on the same tracks), so it carries no phone layout.
 *  - `CANDIDATE_GRID`: large product photos with their price and actions
 *    under them (the inbox's Ready to buy and own items): two on a phone,
 *    from `lg` `--tile-candidate`.
 *  - `OUTFIT_ROW_GRID`: outfits drawn as their `row` collage over the name:
 *    a picker's saved outfits (SavedOutfitPicker: the calendar's plan page,
 *    a trip's add page) and a trip day's outfits (#1071). One column of rows
 *    on a phone, from `lg` `--tile-outfit-row`, wide enough for a
 *    seven-piece row at the phone's piece size (four at 1440 in the plan
 *    page's wide column, three in a trip's main column). Not `OUTFIT_GRID`:
 *    its two phone columns would halve the rows a phone has always shown,
 *    and a `row` collage in its 12rem tile scrolls by the fourth piece.
 *  - `CARD_GRID`: a list of cards (the trips list, the capsules list, #1071):
 *    one on a phone, from `lg` `--tile-card`. **No gap of its own**: the
 *    list's spacing is its cards' (a bordered trip card's `gap-2`, a
 *    chromeless capsule entry's `gap-6`), the same at both sizes, so a list
 *    moved onto it keeps its phone pixel for pixel. A card in it is `h-full`,
 *    so a row of them ends on one line.
 *
 * **Fixed steps**, whose count is the content's own:
 *
 *  - `CARD_COLUMNS`: blocks of mixed height (Insights' cards) flowing down
 *    CSS columns, so a short card leaves no hole: one on a phone (stacked
 *    with the same 1rem gap), two at `lg`, three at `xl`.
 *  - `PAIR_GRID`: two side by side from `lg` (the Wishlist inbox's the agent
 *    picks).
 *  - `AGENT_GRID`: the agent's outfit cards (the Outfits tab, #335), the page's
 *    hero, every piece big: one on a phone, two from `lg` (never three:
 *    the pieces being decided on must stay the largest images on the page,
 *    about 150 px at 1440); a row's cards stretch to the tallest, so their
 *    actions line up at the foot. `AGENT_PIECES` is a card's four pieces.
 *  - `WEEK_DAYS`: the Calendar week's seven days, the phone's strip of
 *    letters (`WEEK_STRIP`) and the desktop grid's columns (`WEEK_COLUMNS`,
 *    #467; its rows are `weekRows`, layout/calendar-grid.ts).
 *  - `MONTH_DAY`: a month cell from `lg` (#1070): its date, weather chip,
 *    worn dot and "+N" a narrow column beside the collage, which spans the
 *    cell's rows (`MONTH_CELL`, layout/calendar-grid.ts); the last row takes
 *    the slack so the column stays at the top. Column-major flow keeps the
 *    pieces in column 1 on a day with no collage too (row-major put the
 *    chip beside the date there); a flow, not a `col-start-1` on each, as
 *    the chip's slot is replaced whole by its out-of-band swap. The phone
 *    stacks them.
 *  - `FIELD_GRID`: form fields two to a row (a trip's dates, the repair's
 *    day and cost, body measurements, Styling's day and occasion);
 *    `DENSE_FIELD_GRID` the same with the row gap of a field that carries
 *    its own label row (a saved look's pieces). `FIELD_ROW` (`FieldRow`,
 *    form-field.tsx): two short fields stacked below `lg` as the form's own
 *    column stacks them (its flex column and gap), side by side from it
 *    (the garment form's brand and size, #1069). `BRAND_SIZE_FIELDS`: a
 *    brand's name beside its size, two to one.
 *  - `STAT_GRID`: three figures in a row (Insights' worn shares, the recap's
 *    numbers).
 *  - `THUMB_ROW` / `THUMB_ROW_WIDE`: a card's row of three or four small
 *    photos (the link import's photo choice, a need's best outfits; a
 *    capsule's newest garments, a suggestion's other options);
 *    `OPTION_ROW` the inbox's three options of a need, roomier from `lg`.
 */
export const GALLERY_GRID =
  'grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-garment),1fr))]';
export const OUTFIT_GRID =
  'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-outfit),1fr))]';
export const IDEA_GRID =
  'lg:grid lg:gap-4 lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-idea),1fr))]';
export const CANDIDATE_GRID =
  'grid grid-cols-2 items-start gap-x-3 gap-y-4 lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-candidate),1fr))]';
export const OUTFIT_ROW_GRID =
  'grid grid-cols-1 gap-2 lg:gap-3 lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-outfit-row),1fr))]';
export const CARD_GRID =
  'grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-card),1fr))]';

export const CARD_COLUMNS =
  'space-y-4 lg:space-y-0 lg:columns-2 lg:gap-4 xl:columns-3 lg:*:mb-4 lg:*:break-inside-avoid';
export const PAIR_GRID = 'grid grid-cols-1 items-start gap-4 lg:grid-cols-2';
export const AGENT_GRID = 'grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2';
export const AGENT_PIECES = 'grid grid-cols-4 gap-1.5';
export const WEEK_STRIP = 'grid grid-cols-7 gap-1';
export const WEEK_COLUMNS = 'lg:grid lg:grid-cols-7 lg:gap-2';
export const MONTH_DAY =
  'lg:grid lg:grid-flow-col lg:grid-cols-[auto_minmax(0,1fr)] lg:grid-rows-[repeat(4,auto)_1fr]';
export const FIELD_GRID = 'grid grid-cols-2 gap-3';
export const DENSE_FIELD_GRID = 'grid grid-cols-2 gap-x-3 gap-y-1';
export const FIELD_ROW = 'flex flex-col gap-4 lg:grid lg:grid-cols-2';
export const BRAND_SIZE_FIELDS = 'grid grid-cols-[2fr_1fr] gap-2';
export const STAT_GRID = 'grid grid-cols-3 gap-2';
export const THUMB_ROW = 'grid grid-cols-3 gap-2';
export const THUMB_ROW_WIDE = 'grid grid-cols-4 gap-2';
export const OPTION_ROW = 'grid grid-cols-3 gap-2 lg:gap-3';
