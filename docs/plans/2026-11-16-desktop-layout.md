# Desktop layout: a first-class desktop beside the phone

Status: **approved** by the owner on 2026-11-16, with every recommendation (section 7). It builds on the desktop epic
(#307: the left rail, `PageMain` widths, `columns.ts`) and the approved
[desktop Styling and Calendar plan](2026-11-12-desktop-styling-and-calendar.md) (#467, #468). It
changes neither decision. It names the layout system those slices started, so the remaining pages
stop being phone columns centred on a wide screen.

**The phone stays as it is.** Every rule below leaves the 390 px layout unchanged, except where a
slice says otherwise and lists the change.

Evidence: the seeded demo persona (`--anchor 2026-09-26`) at 390×844, 1280×800 and 1440×900, every
main surface plus the open sheets, shot from `main` at `77b2dd7` by a throwaway spec (not committed).
Screenshots are named `<surface>-<width>` below, for example `garment-1440`.

## 1. Audit: what fails at desktop width, ranked

The rail (#309), the Calendar week grid (#467), Styling's aside (#468), Insights' card columns and
the Outfits grid work. **Insights is the best desktop page today**, and the model for the rest. The
problems, worst first:

1. **Carousels centred in half a screen** (`today-1440`, `ideas-1440`). Today's and Ideas' idea
   cards are a `SnapStrip` (`page`/`peek`) capped at `lg:max-w-3xl`, with its first card centred. At
   1440 the left 500 px is the strip's start spacer, a disabled ‹ floats in it, and the second card
   is cut off at about x=1140. The app's front door shows one and a half ideas on a 1440 px screen.
   This is the phone gesture, swipe one at a time, with nothing in its place.
2. **The detail pages are a 512 px column** (`garment-1440`, `outfit-1440`, `trip`, `laundry-1440`,
   `plan-1440`). The garment page's hero photo fills the first screen (580×730 px). Wear stats,
   actions, capsules, outfits and details are all below the fold. The outfit page is a 400 px collage
   with 66 px garment thumbs and 900 px of empty page beside it. The Plan page is one 300 px column
   of 26 saved outfits, 3236 px tall, where a grid would show them all at once.
3. **Phone bars stretched across the viewport.** Laundry's "Mark washed" (`laundry-1440`) and the
   Wardrobe's select bar are `fixed bottom-dock left-rail right-0`. The button sits at the far right
   edge, 400 px from the rows it acts on, and the bar covers the list's end. The same pattern
   puts Today's "Refresh" at the far right, 700 px from its cards.
4. **Modal sheets for things a desktop keeps open** (`wardrobe-filters-1440`, `wardrobe-add-sheet`,
   `calendar-plan-sheet-1440`). The filter sheet is a centred modal over the very grid it filters, so
   to change a filter you open it, scroll it and close it again. Nine of the sixteen `<dialog>`s are
   hand-written `modal modal-bottom sm:modal-middle`, and each one decides its own desktop look.
5. **Sibling tabs jump** (`trips-1440` vs `calendar-week-1440`, `laundry-1440` vs `wishlist-1440`).
   Each tab of a section renders its own `<main>` width, and the section's `LinkTabs` row sits inside
   it. So "Week Month Trips" is left-aligned at x=164 on Week and Month and centred at x=548 on Trips.
   "Closet … Wishlist" moves 40 px between Laundry and Wishlist. On a desktop this reads as broken.
6. **Density is phone density, scaled up.** Wardrobe tiles are 200 px at 1440 (six columns), so
   a screen holds 12 of 80 garments. The Calendar month is 1900 px tall, so a month doesn't fit
   on one screen. A three-occasion week is 1770 px. Styling's seven rows are 1770 px (`styling-1440`),
   so the aside's Shuffle and Save sit beside the first two rows only. Each row also spends its
   first 330 px on the start spacer (the centred "None"), so it shows three garments in an 840 px
   column (`styling-1280`).
7. **Pages without a shell.** 23 pages hand-write
   `<main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">` (18 more use `PageMain`). `pt-20`
   appears 36 times and `pb-24` 34 times. Nothing owns the gutter, the bar offset or a second column, so every desktop improvement so far was a
   per-page `lg:` patch: 193 `lg:` in `src/web`, 47 in `calendar-page.tsx`, 46 in
   `styling-page.tsx`.
8. **Single-column settings and forms** (`profile-1440`, `garment-form-1440`, `profile-sizes-1440`).
   These are readable, and a narrow column is right for a form. But the garment form never shows
   the garment it edits, and each settings page loses its siblings: to go from Weather to Sizes you
   go back to Profile first.

Sign-in (`signin-1440`) is fine as it is: a centred frame is the right desktop sign-in.

## 2. Principles

1. **One information architecture, two kinds of chrome.** The same five sections, the same URLs,
   the same markup and the same tab roots. Only the chrome differs: dock vs rail, bottom sheet vs
   panel, a fixed bar vs a sticky one. The server never knows the width. Tab roots stay byte-stable
   (`layout-rail.spec.ts`), so there is no viewport-dependent HTML and no `?view=`.
2. **Two regimes, one breakpoint.** Below `lg` (1024 px) the layout is compact (the phone). From
   `lg` it is expanded. No layout changes at `sm`/`md`/`xl`. Width beyond 1024 px is absorbed by
   _density_ (auto-filling grids, §3.6), never by a third layout. `sm:` stays for phone polish.
3. **A desktop page gets a second column only when the user consults one thing while acting on
   another.** Filters and the grid; the photo and its details; the outfit and its pieces; the days
   and the packing list; the settings index and a setting; the rows and the preview. A second
   column is never padding. A page without such a pair stays one column, `wide` if it is a gallery
   and `narrow` if it is reading or a form.
4. **More things per screen, not bigger things.** A garment tile tops out near 180 px and a
   collage near 220 px. The target: a page's primary content fits the 900 px fold, or is a
   scrolling grid.
5. **Actions sit next to what they act on.** A desktop has no thumb zone. The bars that sit at
   the bottom on a phone dock to the content column, sticky at its top or in its side panel, never
   across the viewport.
6. **Desktop-only regions cost the phone nothing.** A region shown only from `lg` renders only what
   the page already reads (statement budgets unchanged). Anything that needs a read loads with
   `hx-trigger="intersect once"`, which never fires while the region is `display: none`. This is
   the pattern Styling's fit line already uses (#468b).
7. **Layout is named, never patched.** A page picks a shell variant, a grid, a sheet placement or a
   strip mode by name. Its `lg:` classes live in `src/web/layout/` (the shell, `columns.ts`, the
   sheet), in `snap-strip.tsx`, and in `main.css` under named components. A page file holds no
   layout `lg:` classes.

## 3. The layout system

Six pieces. Each extends something that exists, and each is CSS-first with no layout script.

### 3.1 Navigation: the rail, completed

The rail exists (`.dock` restyled at `lg`, one markup). Two changes finish it:

- **Profile moves into the rail at `lg`.** The `Dock` markup gains a final `<a href="/auth/profile">`
  with the avatar initial, `hidden lg:flex`, pinned to the rail's foot (`mt-auto`). The app bar's
  avatar becomes `lg:hidden`. Both are one markup and live in every body, as today. The rail then
  carries everything that is a _place_, and the app bar carries everything that belongs to _this
  page_ (title, scope, actions).
- **Section tabs join the app bar.** `AppBar` gains `tabs?: LinkTabsProps`. Below `lg` the tabs render
  as the second row of the header. The header grows to two rows by `:has(.app-bar-tabs)` setting
  `--app-bar-h`, which every page offset already reads. From `lg` they sit inline after the title
  on one 4rem row. The tab row is the header's, so it no longer moves with the page's width
  (problem 5). Pages lose their own `<LinkTabs>` and the `pt-16`/`pt-20` split: the shell reads
  `--app-bar-h`.

```
 phone (unchanged look)                    lg
┌──────────────────────────────┐        ┌────┬─────────────────────────────────────────────────┐
│ Wardrobe ▾           ⋯  ＋  D │        │ ☀  │ Wardrobe ▾   Closet Capsules Laundry Wishlist  ⋯ ＋│
│ Closet Capsules Laundry Wish │        │ ⌂  ├─────────────────────────────────────────────────┤
├──────────────────────────────┤        │ ✦  │                                                 │
│            page              │        │ ≡  │                     page                        │
├──────────────────────────────┤        │ ▦  │                                                 │
│ Today Wardrobe Style Outf Cal│        │    │                                                 │
└──────────────────────────────┘        │ D  │                                                 │
                                        └────┴─────────────────────────────────────────────────┘
```

Not proposed: a labelled 14rem sidebar at `xl`. Five icons with labels fit the 5rem rail, and the
width is worth more to the photos (open question 4).

### 3.2 `PageShell`: one frame, named regions

`src/web/layout/page-shell.tsx` replaces the `Layout` + `AppBar` + `PageMain`/raw `<main>` + `Dock`
boilerplate on every page. `FormPage` and `SettingsPage` become thin presets of it.

```tsx
<PageShell
  ctx={ctx}
  bar={{ title, back?, formPage?, scope?, actions?, tabs? }}   // AppBarProps minus ctx
  width="narrow" | "wide" | "agenda"                           // PageMain's tokens, unchanged
  layout="single" | "split" | "panel" | "facets" | "index"     // default "single"
  aside?={<Child/>}              // the second region, required by every layout but single
  actionBar?={<ActionBar/>}      // §3.4
>
  {main content}
</PageShell>
```

It renders `<main class="page-shell" data-layout=…>` with two regions inside it: the page's body and
`aside`. **DOM order is the visual order at `lg`**: a left region precedes the body and a right
region follows it. The phone stacks the regions in that same order, so keyboard, reader and phone
order always agree. The layouts are **CSS grid areas in `main.css`** (`@layer components`,
`.page-shell[data-layout=…]`). They are not utility strings, so a variant is defined once and read
in one place:

| `layout` | below `lg`                                 | from `lg`                                           | for                                                                          |
| -------- | ------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `single` | body                                       | body, at `width`                                    | most pages                                                                   |
| `split`  | subject, then body (as today: photo first) | subject 5fr sticky on the **left**, body 7fr narrow | a subject and its facts: the garment page, the outfit page, the garment form |
| `panel`  | body, then aside                           | body 1fr, aside 20rem sticky on the **right**       | work and its result: Styling, a trip's packing list                          |
| `facets` | body (the aside is the filter sheet, §3.3) | aside 15rem sticky on the **left**, body 1fr        | a filtered gallery: the Wardrobe                                             |
| `index`  | body only (aside `hidden`)                 | `<nav>` 15rem on the **left**, body narrow          | settings: Profile's pages                                                    |

`split`'s subject is a `<section>` (the photo or collage, sticky from `lg`). `panel`'s aside is an
`<aside aria-label>`. Both sit inside `<main>`, so the main landmark holds the page. The rule a
reviewer checks: **a region never holds anything a phone user lacks**, except `index`'s
navigation, which on a phone is the Profile page itself.

The shell owns the gutter (`px-4`), the bar offset (`pt-[calc(var(--app-bar-h)+1rem)]`) and the
dock pad (`pb-dock` + action bar). The 36 copies of `pt-20`/`pb-24` go. `PageMain` and `PageColumn`
stay as the shell's internals and are not exported to pages once the migration ends.

### 3.3 `Sheet`: one dialog, a placement per size

`src/web/layout/sheet.tsx` absorbs the sixteen hand-written `<dialog>`s and `ConfirmSheet`'s box.
`SheetBackdrop` already lives in `parts.tsx`.

```tsx
<Sheet id title kind="choice" | "form" | "filters" | "menu"> … </Sheet>
```

On a phone, every kind is today's bottom sheet (`modal-bottom`). From `lg` the kind decides:

| `kind`    | from `lg`                                                                                   | today's users                                    |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `choice`  | centred, `max-w-md` (as now)                                                                | Plan sheet, confirm, outfit Plan, Styling's Save |
| `form`    | right side panel, full height, `max-w-md` (daisyUI 5 `modal-end`)                           | photo sheet, repair form, selfie                 |
| `menu`    | anchored under its trigger (CSS anchor positioning, `@supports`; centred where unsupported) | Wardrobe's Add (Camera, Library, Link, Blank)    |
| `filters` | **docked**: shown in place in the shell's `facets` aside, not modal                         | Wardrobe filters                                 |

**Docking without a second copy.** A `filters` sheet is one `<dialog>`. At `lg` a `main.css` rule shows
the _closed_ dialog in the `facets` grid area (`.page-shell[data-layout=facets]
dialog[data-sheet=filters]:not([open]) { display: block; position: sticky; … }`) and hides its Close
and its "Filters" opener. Its form is the same element at both sizes, so nothing renders twice and
no ids repeat. A closed `<dialog>` shown by CSS is not inert and is in the accessibility tree, and
it carries `aria-label`. The guard below asserts that it is never `open` at `lg`. This is the one
place where CSS overrides a UA default. It is chosen over JS that calls `show()` on resize, which
would be layout logic in script.

The guard `@sheet` (guards.conf) refuses daisyUI's modal box and bottom-sheet classes outside `sheet.tsx`, the
same pattern as `@sheet-backdrop`.

### 3.4 `ActionBar`: a bar that follows its column

`src/web/layout/action-bar.tsx`. Its body is today's Styling `ActionBar`, generalised. Laundry's
"Mark washed", the Wardrobe's select bar and Styling's Shuffle and Save use it.

- **Below `lg`:** `fixed left-rail bottom-dock`, or `sticky bottom-dock` when its height varies
  (#664's rule, unchanged).
- **From `lg`:** it is the shell's, not the viewport's. In `panel` it renders at the top of the
  aside (Styling, as #468 placed it). Otherwise it is `sticky top-[var(--app-bar-h)]` at the head of
  `main`, aligned to the content column. "Mark washed" then sits above the hamper it washes.

`PageShell actionBar` places it. The scroll-padding rule in `main.css` (#1026) keys off
`.action-bar` instead of each page's `fixed bottom-dock`.

### 3.5 `SnapStrip` desktop modes

The strip is a phone gesture. On a desktop it is right only where the centred item _is the
choice_ (Styling). `SnapStrip` gains `desktop`, typed so a choice cannot lose its strip:

```ts
type StripDesktop =
  | { listbox: true; desktop?: 'strip' } // a choice: Styling's rows
  | { listbox: false; desktop: 'strip' | 'row' | 'grid'; grid?: GridName };
```

- `strip`: today's behaviour (centred, step buttons, arrows).
- `row`: from `lg`, start-aligned with no spacers, `snap-start`. The step buttons page by the visible
  width and the arrows move focus. For short browse rows: Goes-with, Recreate.
- `grid`: from `lg` nothing scrolls. Items flow into a `columns.ts` grid, step buttons hidden, and
  the strip's paging sentinel (`intersect`) loads the next page as the grid's last row scrolls in.
  For Today's and Ideas' cards. It generalises the `options` size, which did exactly this for one
  case (`lg:overflow-x-visible lg:snap-none`). `options` becomes `size="peek" desktop="grid"`.

The classes stay in `SIZES`/a `DESKTOP` table in `snap-strip.tsx`, as whole strings. On a fine
pointer, `snap-strip.js` skips the observer for `row` and `grid` at `lg` (`matchMedia` once per
init). Nothing else changes in the script.

### 3.6 Density: grids that fill, cards that step

`columns.ts` keeps its names. From `lg` its grids become **auto-fill tracks** instead of fixed counts,
so 1024, 1440 and 1920 each get the right number of columns without another breakpoint:

```ts
// phone count unchanged; from lg: repeat(auto-fill, minmax(<min>, 1fr))
GALLERY_GRID   3 cols  →  lg  minmax(9.5rem, 1fr)    // garments: 8 at 1440 (was 6)
OUTFIT_GRID    2 cols  →  lg  minmax(12rem, 1fr)     // outfits, looks, the Plan page
IDEA_GRID      1 col   →  lg  minmax(17rem, 1fr)     // new: Today's and Ideas' cards, 3 at 1440
CANDIDATE_GRID 2 cols  →  lg  minmax(13rem, 1fr)
CARD_GRID      1 col   →  lg  minmax(18rem, 1fr)     // new: trip cards, capsule cards
CARD_COLUMNS, PAIR_GRID, AGENT_GRID                   // unchanged
```

The minimums are `--tile-*` tokens in `main.css` beside `--container-page-*`, read by arbitrary
properties (`lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-garment),1fr))]`), as whole strings.

**Collages step down at `lg`.** `OutfitCollage` sizes (`cell`, `card`, the calendar's) gain one
desktop step in `collage.tsx`. The month cell goes to about 110 px, so the month fits the fold;
the week card goes to about 150 px. `Card` (#727) keeps its two variants. Density is the grid's
and the collage's, never a third card variant.

### 3.7 `FormPage` at desktop

A form stays a `narrow` column: a 40rem measure is right for fields. Two additions:

- `FormPage aside?`: the shell's `split`. The garment form's aside is the garment's photo (the
  same `GarmentLook` and pending-cutout state as the garment page), sticky on the left. You see
  what you edit. Forms without a subject (trip, capsule, "Bought it") pass none and stay `single`.
- `FieldRow` (`form-field.tsx`): two short `FormField`s side by side from `lg` (brand and size;
  date and cost; fabric weight and unit already pair). On a phone it is the stack it is today.
- Cancel and Save become a sticky footer of the form column at `lg`
  (`lg:sticky lg:bottom-0 bg-base-100`) on forms taller than the fold, so Save is always in reach.

## 4. Per-surface designs

Every phone layout is unchanged unless the row says otherwise. Widths: N = `narrow`, W = `wide`.

### Today: `single` W, ideas as a grid

```
┌────┬────────────────────────────────────────────────────────────────────────┐
│rail│ Monday, Nov 16                                                         │
│    ├────────────────────────────────────────────────────────────────────────┤
│    │ ☁ 38–53 °F Fort Greene                                   [Plan my week]│
│    │ All day ───────────────────────────────────────────────────── ↻ Refresh│
│    │ ┌ planned ─────────┐ ┌ idea ──────────┐ ┌ idea ──────────┐ ┌ idea ───┐ │
│    │ │  collage         │ │  collage       │ │  collage       │ │ collage │ │
│    │ │  Wore it ✓       │ │ Fits weather   │ │ Fits weather   │ │ …       │ │
│    │ │                  │ │ [Wear this]    │ │ [Wear this]    │ │         │ │
│    │ └──────────────────┘ └────────────────┘ └────────────────┘ └─────────┘ │
│    │ Workout ───────────────────────────────────────────────────────────────│
│    │ …                                                                      │
└────┴────────────────────────────────────────────────────────────────────────┘
```

Each occasion is a heading row (its Refresh beside it, not at the far edge), then the planned
outfit and the ideas `desktop="grid"` in one `IDEA_GRID`. This replaces `PAIR_GRID` with its
`lg:only:col-span-full` here. "Plan my week" moves up next to the weather.

### Wardrobe (Closet tab): `facets` W

```
┌────┬────────────────────────────────────────────────────────────────────────────┐
│rail│ Wardrobe ▾   Closet Capsules Laundry Wishlist                     ⋯  ＋    │
│    ├──────────────┬─────────────────────────────────────────────────────────────┤
│    │ ⌕ search     │ All garments ▾   4 to wash   Tops ✕                    80   │
│    │ Category     │ ┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐            │
│    │ ◻ Tops    27 │ │    ││    ││    ││    ││    ││    ││    ││    │            │
│    │ ◻ Bottoms 14 │ └────┘└────┘└────┘└────┘└────┘└────┘└────┘└────┘            │
│    │ Color        │ Umbrella Duffel …                                           │
│    │ ● ● ● ● ●    │ ┌────┐┌────┐ …                                              │
│    │ Warmth …     │                                                             │
│    │ [Clear]      │                                                             │
└────┴──────────────┴─────────────────────────────────────────────────────────────┘
```

The filter sheet docks as the left facet column (§3.3). The scope row keeps the capsule menu, the
active chips and the count. Its search and filter buttons are `lg:hidden` because search heads the
facets. `GALLERY_GRID` auto-fills to eight columns at 1440. Select mode's `ActionBar` sticks at the
grid's head. Capsules, Laundry and Wishlist keep their own layouts below, under the same header
row.

**As built (#1067):** search stays in the scope row at the head of the grid column at both sizes (the page's one keyword field, its own form, so Enter submits on the phone and focus order matches the visual order); only the filter button gives way from lg (`docs/decisions.md` 2026-11-16).

### Garment page: `split` (photo left, facts right)

```
┌────┬────────────────────────────────────────────────────────────────────────┐
│rail│ ← Raw selvedge jeans                                               ⋯   │
│    ├────────────────────────────┬───────────────────────────────────────────┤
│    │ ┌────────────────────────┐ │ The Unbranded Brand · Bottoms · 32×32     │
│    │ │                        │ │ Worn once · 1 since washed · $127 a wear  │
│    │ │        cutout          │ │ [Style this] [Wore today]                 │
│    │ │                        │ │ Warm  Casual  Solid  Slim  Denim          │
│    │ │                      ✎ │ │ Capsules  Date night  Office  ●Weekend    │
│    │ └────────────────────────┘ │ In 1 outfit  ▢ ▢ ▢                        │
│    │ (sticky)                   │ Details · Care · Condition · Where it is  │
│    │                            │ Repairs and alterations        Log a repair│
└────┴────────────────────────────┴───────────────────────────────────────────┘
```

The facts column is `narrow` (40rem). Stats and actions are above the fold at 1440 (today they
start at y=840). Goes-with's strip becomes `desktop="row"`.

### Garment form: `FormPage aside` (`split`)

The photo is on the left, sticky, as on the garment page. The fields are on the right, with
`FieldRow` pairs (brand and size; the repair form's date and cost) and a sticky Cancel and Save.
The repair log and its form stay `after`.

### Outfits › Saved and Inspiration: `single` W, unchanged structure

`OUTFIT_GRID` auto-fills (six at 1440). The two tab rows (Saved/Ideas/Inspiration, then Your
outfits/Worn and planned) become one: the section tabs in the app bar (§3.1), the sub-tabs as the
page's first row. Inspiration's grid is the same.

### Outfit page: `split` (collage left, pieces right)

```
│ ← Old weekend jeans                                                    ⋯  │
├──────────────────────────┬────────────────────────────────────────────────┤
│ ┌──────────────────────┐ │ [Plan] [Edit in Styling]                       │
│ │       collage        │ │ Garments in this outfit                        │
│ │                      │ │ ┌────┐ ┌────┐ ┌────┐   (GALLERY_GRID tiles)    │
│ └──────────────────────┘ │ Worn 3× · last Sep 20 · selfies ▢ ▢            │
```

### Ideas: `single` W, `desktop="grid"`

The idea cards flow into `IDEA_GRID` (three or four at 1440) and page by the strip's sentinel as
the last row scrolls in. Save and "Not this" are on every card. Shuffle stays in the app bar.

### Styling: `panel` (as approved in #468), denser

The structure is #468's: rows left, aside right with the preview, the fit line and the
`ActionBar`. It moves onto `PageShell layout="panel"`, which deletes `COMPOSER_COLUMNS` and the
page's 46 `lg:`. The rows use the `small` tile from `lg` (w-28, one size per page as #732 wants).
Seven rows then take about 1150 px instead of 1770, and Shuffle and Save stay beside the rows you
are choosing in. The centred-choice start spacer stays. It is the strip's contract, so whether to
change it is open question 2.

### Calendar week and month: density only

The week grid is #467's. The month and the week cards take the collage's desktop step (§3.6),
so the month fits about 760 px and a three-occasion week about 900. The section tabs move into the
app bar. The **Plan page** (`/calendar/plan`) becomes `single` W with its head (the day, the
occasion chips, "Choose from ideas", "Style a new outfit") as a band, and the saved outfits in
`OUTFIT_GRID` instead of a 26-row list.

### Trips and a trip

The trips list is `single` W with trip cards in `CARD_GRID`. Today it is one card in a 480 px
column under tabs that jump. A trip is `panel`: its days and outfits in `main` and the packing list
in the aside, sticky. You tick off packing while you look at the outfits that need it. On a phone
the packing list follows the outfits, as now.

```
│ ← Austin conference                                                       │
├───────────────────────────────────────────────┬───────────────────────────┤
│ Aug 19 – 21 · Austin, TX · 72–90 °F           │ Packing  9 of 15 packed   │
│ Wed 19  ┌collage┐ ┌collage┐                   │ ☑ Navy blazer             │
│ Thu 20  ┌collage┐                             │ ☐ White oxford  ×2        │
│ Fri 21  ┌collage┐ [+ Add an outfit]           │ …  (sticky)               │
```

### Laundry: `single` N, `ActionBar` at the head

The hamper stays a narrow list, a list of checkboxes. "Mark washed" docks above it, aligned
to the column (§3.4).

### Insights: unchanged

It already uses `CARD_COLUMNS`. It only moves onto `PageShell`.

### Wishlist: `single` W, `CANDIDATE_GRID` auto-fill

A need's decision screen keeps `AGENT_GRID`. Its options strip is already a row at `lg`.

### Profile and its settings: `index`

```
│ Weather                                                                   │
├────────────────────┬──────────────────────────────────────────────────────┤
│ Account            │ Home location                                        │
│ Wardrobe sharing   │ [ Fort Greene, Brooklyn      ] [Change]              │
│ Notifications      │ Temperature offset  …                                │
│ ● Weather          │                                                      │
│ Your week          │                                                      │
│ Style profile      │                                                      │
│ Sizes · Agent      │                                                      │
│ Export · Sign out  │                                                      │
```

Each settings page renders `SettingsNav` as the `index` aside: Profile's rows as **labels only**,
with no subtitles. Subtitles need reads, and principle 6 keeps the statement budget. The current
page is `aria-current`. `/auth/profile` itself stays the full index with subtitles in `main`, and
its aside is empty there (`layout="single"`). On a phone nothing changes: Profile is the index, and
each page has its back arrow.

### Capsules, sign-in, the share page, About

Capsules: `CARD_GRID` of capsule cards (a 512 px list today). Sign-in, register and the invite
landing stay as they are. A centred frame is right there. The share page and About take
`PageShell single N`.

## 5. Interaction on a desktop

- **Pointer:** hover marks what is clickable: a tile's plinth darkens one step (`base-300`), and the
  rail item gets a tint. **Hover never reveals an action**: everything a hover would show is
  already on the page, because the phone has no hover. The snap strips' step buttons stay
  `fine:`-only (#311).
- **Keyboard:** the DOM order is the phone's and the desktop's visual order (§3.2): app bar, then
  the shell's regions left to right, then the rail. A visible skip link
  ("Skip to content") comes first in every body. Sheets keep Escape, initial focus and return focus
  (`confirm-sheet.js`'s rules, applied to every `Sheet`). A docked `filters` sheet is in the normal
  tab order after the scope row. Arrow keys move through strips (unchanged), and in `row` mode they
  move focus, not the choice.
- **Shortcuts:** one, `/` to focus the Wardrobe search (and Ideas' filter). It earns its place on
  the page people search most. Nothing else: no chords and no single-letter actions, which collide
  with screen readers and the browser's find. `Esc` already closes.
- **Focus:** `focus-visible` rings on tiles and cards (`outline-2 outline-offset-2
outline-base-content`), defined once in `main.css` for `[data-tile]`. Today a focused tile is only
  its link's default ring.
- **Accessibility:** the rail stays a `<nav aria-label>` with `aria-current`. `index`'s aside is a
  second `<nav aria-label="Settings">`. A shell aside is `<aside aria-label>` (complementary). The
  docked filters keep their dialog's label. Large text: the rail's labels already yield (#730). The
  shell's areas are in rem, so a 200% root narrows the `split` column before it overflows. The
  breakpoint stays at 1024 CSS px, so a zoomed desktop gets the phone layout, which is the right
  answer.

## 6. Migration plan

Foundations first, then pages by how much they hurt. Every slice: phone screenshots at 390 px are
identical to `main` (`make screenshots`, compared by eye in the PR), the 1440 shots of what it
touched are in the PR, and `layout-rail.spec.ts`' same-bytes check stays green.

| #   | Slice                                                                                                                          | Size | Depends | Deletes                                                      | Keeps it honest                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | ------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| D1  | `PageShell` (`single`, the gutter and offsets) and the 18 `PageMain` pages onto it; `FormPage`, `SettingsPage` as presets      | M    | –       | per-page `p-4 pt-20 pb-24`, `Layout`/`AppBar`/`Dock` triples | `expectFullPage` asserts one `.page-shell` per page, on the whole route table                                         |
| D2  | The 23 raw `<main>`s onto `PageShell` (each `narrow` or `wide` by §4)                                                          | M    | D1      | every `max-w-lg mx-auto` on a main                           | guards.conf `@page-main`: `<main` only in `page-shell.tsx`                                                            |
| D3  | Section tabs in the app bar; `--app-bar-h` two rows below lg; Profile in the rail                                              | S    | D1      | page-level `<LinkTabs>`, `pt-16`                             | `pages.ts`: a tabbed page's `LinkTabs` is inside `.app-bar`; 1440 shots of sibling tabs                               |
| D4  | `Sheet` (kinds `choice`, `form`, `menu`) for the 16 dialogs and ConfirmSheet                                                   | M    | –       | 9 hand-written `modal modal-bottom sm:modal-middle`          | guards.conf `@sheet`: no modal box or bottom-sheet class outside `sheet.tsx`                                          |
| D5  | `ActionBar` primitive: Styling's, Laundry's, the select bar; scroll padding keyed off it                                       | S    | D1      | two `fixed bottom-dock left-rail right-0` bars               | `pages.ts`: at most one `.action-bar`, never inside a page's own fixed element                                        |
| D6  | Density: auto-fill grids and tokens in `columns.ts`, `IDEA_GRID`, `CARD_GRID`, the collage's desktop step                      | S    | –       | –                                                            | ESLint: `grid-cols-*` and `columns-*` only in `columns.ts`, `collage.tsx`, `month-page.tsx`                           |
| D7  | `SnapStrip` `desktop` modes; Today and Ideas on `grid`, Goes-with and Recreate on `row`; `options` folded in                   | M    | D6      | `options` size, Today's and Ideas' `frameClass` `lg:`        | the `StripDesktop` type; `strip.spec` unit: `listbox` strips are `strip` only                                         |
| D8  | The `lg:` ratchet: a count of `lg:` in `src/web` outside `layout/`, `columns.ts`, `snap-strip.tsx`, `collage.tsx`, shrink-only | S    | D1      | –                                                            | `scripts/ci` guard with a `known` count, like `layer-check`'s; fails on growth                                        |
| D9  | Wardrobe `facets`: the filters sheet docked, search in the facets, `/` shortcut                                                | M    | D2, D4  | the scope row's search and filter buttons at `lg`            | integration: the facets form posts what the sheet posted; `pages.ts`: the filter dialog is never `open` in the markup |
| D10 | `split`: the garment page and the outfit page                                                                                  | M    | D1      | –                                                            | 1440 shots; `expectFullPage`: the regions sit in visual order in the DOM                                              |
| D11 | `FormPage aside` and `FieldRow`: the garment form with its photo, sticky actions                                               | S    | D10     | –                                                            | `expectFormPageFlag` unchanged; 1440 shot                                                                             |
| D12 | Calendar: month and week density, the Plan page on `OUTFIT_GRID`, the week's tabs in the bar                                   | S    | D3, D6  | Plan page's `sm:max-w-lg`                                    | statements unchanged (`calendar.spec.ts`)                                                                             |
| D13 | Trips list on `CARD_GRID`, a trip on `panel` with the packing list; Capsules on `CARD_GRID`                                    | S    | D2, D6  | –                                                            | 1440 shots; Trips' Playwright scenario stays green at 390                                                             |
| D14 | Profile `index`: `SettingsNav` on every settings page                                                                          | S    | D2      | –                                                            | `recordQueries`: a settings page's statements unchanged                                                               |
| D15 | Styling onto `panel` and the `small` tile at lg                                                                                | S    | D1, D5  | `COMPOSER_COLUMNS`, most of the page's 46 `lg:`              | `styling.spec.ts` (390) unchanged; 1440 shots                                                                         |

That is 15 slices, all S or M. D1, D4 and D6 can start in parallel. After D8, any slice that adds
a page `lg:` fails the guard instead of review. **The screenshot generator's desktop block** grows
with each slice: one 1440 shot per surface touched (`test/screenshots.spec.ts`, not a gate, as
#307 set). Each slice adds its AGENTS.md lines (Layout's area doc gains the shell, the sheet and
the action bar) and a `docs/decisions.md` entry in the same change. A per-page `lg:` count and the
two guards are what keep the abstractions from eroding. The screenshots are for people.

## 7. Decisions (owner, 2026-11-16)

The owner approved the proposal with every recommendation as written.

1. **Profile is in the rail on desktop**, and the app bar's avatar is hidden from `lg`. Places
   live in the rail, page actions in the bar. The phone keeps the avatar.
2. **Styling keeps the centred strips** (#468) with the `small` tile from `lg`. There is no
   choose-by-click row. Revisit after D15's screenshots.
3. **The Wardrobe filters are docked permanently on desktop** as the `facets` column, not a panel
   opened by a button.
4. **No labelled sidebar at `xl`.** The 5rem rail stays, and the photos get the width.
5. **One keyboard shortcut:** `/` focuses search (the Wardrobe; Ideas' filter). Nothing else.
6. **One breakpoint (`lg`) plus auto-fill density.** There is no separate `xl` layout.
