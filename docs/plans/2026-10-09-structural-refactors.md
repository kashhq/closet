# Expert Panel: Refactor hot spots

*Generated: 2026-10-09 · main @ 11f8fff · input: graphify code-only graph (6,257 nodes, 24,453 edges)*

## Problem Statement

A structural graph of the codebase flagged four kinds of signal: shared primitives in feature dirs (`calendar-date.ts` used by 22 areas), 34 bidirectional feature-area dependencies (wardrobe↔wishlist 47/129, calendar↔outfits 58/62), breadth (`web/mcp` into 25 areas, `wardrobe/routes.tsx` fan-out 39), and churn × size (`schema.ts`, `wardrobe/routes.tsx`, `validation.ts`, `outfits/queries.ts`). The question: which 3–5 refactors most improve the structure, and which signals are legitimate coupling or graph artifacts. Both experts verified every claim against the source.

## Drift vs. Design

**Both experts agreed on what is intentional design:**
- Vertical feature slices and single writers per entity (`setGarmentStatus`, `createOutfit`, `decide`, `deleteOutfit`). Mutual area dependencies follow from one tightly linked domain. Removing every misplaced primitive only takes the mutual-pair count from 35 to 28, so **the cycle count is the wrong metric to optimize**. No file-level import cycles exist.
- `wardrobe/status.ts` predicates (`inCloset`, `onWishlist`) are already the one rule for every query. Depending on the entity's owner is correct.
- `web/mcp` reaching into 25 areas is by design: a second interface over queries and writers, never views.
- `gallery/ideas.ts` `ideasFor` is the documented single suggestion source; `OutfitCollage` and `SnapStrip` are already shared.
- `schema.ts` stays one file (`drizzle.config.ts` takes one path; churn is migrations, and the `_journal.json` collision happens regardless).
- `wardrobe-page.tsx` and `outfits/queries.ts` are large but cohesive.

**Accumulated drift, architecture:**
1. **The "pure layer" rule exists in prose only.** `docs/architecture.md` calls `src/wardrobe/`, `src/weather/`, `src/push/` pure, yet five files import upward into `web/calendar/calendar-date.ts` (`wardrobe/week-planner.ts:6`, `wardrobe/packing.ts:1`, `weather/forecast.ts:1`, `weather/normals.ts:5`, `push/reminders.ts:5`), as do `config.ts:6` and `wardrobe/insights.ts:4` (a type from `web/files`). Nothing enforces it.
2. **`src/web/schemas.ts` exists for cross-feature request pieces**, yet `OwnerQuery`, `GarmentParams`, `choice` and `pick` grew in `wardrobe/validation.ts` (1,482 LOC, four concerns). `styling/routes.tsx:119` re-declares `OwnerQuery`. `wardrobe/urls.ts` imports all of `validation.ts` for `idListValue`.
3. The garment-not-found wrapper (`resolve` / `requireGarment` / `GARMENT_NOT_FOUND`) is re-declared in about 8 places. Authorization itself (`authorizeWardrobe`) is central, so this is cosmetic.
4. `pickIdea` (`gallery/ideas.ts:468`) is an outfit *write* (an owner transaction plus `calendar/queries`) living in the read-only suggestion engine.

**Accumulated drift, user-visible (UX):**
1. **Status is centralized in the predicates but not in the views.** "Archived" uses three different badge variants. "To buy" vs "Wishlist" use separate i18n keys per surface. Worse, `OutfitCollage` knows only `'to-buy'` (`collage.tsx:27,38-53`). A planned outfit on Today with boots at the repair shop or an archived piece shows a clean card with "Wore it". Trips already warns about exactly this (`PackingWarning`), and `src/wardrobe/availability.ts:127 isAvailable` already exists.
2. **"Mark worn" is four controls with four vocabularies**, and the trip page has no undo: calendar `worn-button.tsx:20-44`, `today-page.tsx:220-243`, `trip-page.tsx:300-315`, `wear-section.tsx:176-190`. The server path is one write; `today/CLAUDE.md:6` says so.
3. **Dates:** `relativeDay` lives in `wears/wear-section.tsx:137` and falls back to a raw ISO string, so Insights shows "Last worn 2026-08-14". `garment-page.tsx:789` prints `acquiredOn` raw. `trips/labels.ts:shortDate` duplicates `calendar/labels.ts:shortDayLabel`.
4. **An outfit changes its picture at the moment you plan it.** `SavedOutfitButton` shows only the first 3 garments, cropped (`saved-outfit-button.tsx:8,34-49`), on the calendar plan page and the trip add page. Everywhere else it is the body-shaped collage.
5. There are 3 thumbnail components plus 6 hand-rolled frames with drifting sizes, rounding and tap targets. Today's idea card is a private fork with no "Not this" feedback path.

**Convention gaps:**
- The rule "a feature lives whole in `src/web/<feature>/`" never says where code goes when *no* feature owns it, so it lands in whichever feature wrote it first.
- `layout/CLAUDE.md` has no rule for garment visuals, status marks or date labels.
- `NOT_OWNED_YET` is hardcoded English outside i18n (`wears/routes.tsx:32`, `wardrobe/repair-routes.tsx:23`).

**The key synthesis:** the two perspectives converge on the same three seams. The architect's dates move is user-neutral alone, but paired with the UX dates fix it removes raw ISO dates. The architect correctly says status *predicates* stay put; the UX finding is that status *rendering* needs the same single home, next to `src/wardrobe/availability.ts`.

## Approaches Considered (ranked)

### 1. Dates to `src/calendar-date.ts`, plus a lint-enforced pure-layer boundary, plus one date-label vocabulary

**Summary:** `git mv src/web/calendar/calendar-date.ts src/calendar-date.ts` (beside `random.ts`), about 137 mechanical import rewrites. Add ESLint `no-restricted-imports` on `src/{wardrobe,weather,push}/**` forbidding `web/`, `db/`, `drizzle-orm`, `node:*`. Make `wardrobe/insights.ts` generic over its photo type. Follow-up: `calendar/labels.ts` becomes `src/web/date-labels.ts`, absorbing `relativeDay` (no ISO fallback), `trips/shortDate`, and a shared `DayHeading`.

| Perspective | Assessment | Verdict |
|---|---|---|
| Architecture | The only signal that is a real layering *violation*. The lint rule is what keeps it fixed. | Strong |
| UX | The move alone does nothing for users; the labels half removes visible raw ISO dates. | Strong (as a pair) |

**DA findings:** Both asked "is this cosmetic?" The architect said no, because of the upward imports and the missing enforcement. The UX designer said yes for the move alone, so they tied it to the labels fix. Risk: a 137-file diff conflicts with open branches. Land it alone, on an empty PR queue.

### 2. A single garment status mark, derived from status plus availability

**Summary:** `garmentMarks(piece, { ownerView })` in `src/wardrobe/` next to `availability.ts` returns ordered typed marks (`to-buy | archived | away:lent|repair | needs-wash | set-aside`). A single `<GarmentMark>` renders them with one daisyUI variant and one i18n key each. `CollagePieceView` changes from its `mark`/`status` pair to `marks[]`. The grid's `TileMarks`, Styling, the garment page's `StatusBadge`, Muse cards and trips all use it.

| Perspective | Assessment | Verdict |
|---|---|---|
| Architecture | Consistent with the verdict that status predicates stay in `wardrobe/status.ts`: this adds the missing *view* half in the pure layer, not a new core module. | Strong (not separately proposed) |
| UX | The only item that prevents a wrong decision (wearing an unavailable piece). Gives one meaning per badge. | Strong |

**DA findings:** The UX risk is clutter. Show blocking marks only on Today and the calendar, and no wash mark on 48 px cells. A viewer of a shared wardrobe must never see away or wash state (it needs the `ownerView` gate). Collage queries must join availability into existing statements, because statement counts are pinned by specs.

### 3. Split `wardrobe/validation.ts`, then `wardrobe/routes.tsx`, with a `garment-access.ts` helper

**Summary:**
- Shared request pieces (`OwnerQuery`, `choice`, `pick`, `readIdList`, `idListValue`) move to `src/web/schemas.ts`; delete styling's copy.
- The garment input model (`GarmentBody`, `readGarmentForm`, the field-group readers, presets, `*_MAX`) moves to `wardrobe/garment-input.ts`. This is the parser the form, MCP and the seed share.
- Grid and garment route schemas move beside their routes.
- `garment-access.ts` (the 404 wrapper) is adopted at 6 sites.
- `routes.tsx` (24 routes, edited by about 20 unrelated features since July) splits into `grid-routes`, `garment-routes` and `photo-routes`, following the existing `repair-routes` / `lookalike-routes` / `export-routes` precedent.

| Perspective | Assessment | Verdict |
|---|---|---|
| Architecture | `style` and `week-plan` lose their only dependency on wardrobe; `urls.ts` becomes a leaf. The case for the split is the number of features editing one file, which causes rebase churn under strict up-to-date protection, not the line count. | Strong |
| UX | No user payoff. | n/a |

**DA findings:** `schemas.ts` must not become a junk drawer: admit only pieces with two or more consumers. Each split plugin must be registered, or the route falls through to `/:id` (`plugin.ts:159`).

### 4. One Worn control

**Summary:** `WornControl` `{entryId, worn, size: pill|button, past?, returnTo}` gives one verb ("Wore it", then "✓ Worn today · Undo"), htmx in place with a native-post fallback, and a create-and-wear mode for trips. It replaces the calendar, Today and trip variants. Remove the dead `CALENDAR_WORN_RECENTLY` key and its siblings.

| Perspective | Assessment | Verdict |
|---|---|---|
| Architecture | Moves a primitive out of `calendar/` that three areas copy. Small. | (aligned) |
| UX | The everyday action gets one name and one undo rule; fixes the missing undo on trips. | Strong |

**DA findings:** Hero size vs dense size is legitimate context. Keep a size variant, but vocabulary and undo are not context.

### 5. Smaller, ownership-correct moves

- **`pickIdea` to `outfits/pick.ts`** (architecture, Viable–Strong). Move it verbatim; the ordering of the owner lock and the `FOR SHARE` lock is subtle.
- **Outfit row in `SavedOutfitButton`** (UX, Strong for this half): `OutfitCollage size="row"` that never drops footwear. The thumbnail merge across 9 frame variants is Viable, and only when someone is touching those files.
- **Shared `IdeaActions`, one "Bought it" placement** (UX, Viable). Confirm Today's need for feedback first.
- **Split `outfits/queries.ts` into reads and writes** (Weak). Only when a feature reworks the file anyway.

## Explicitly not recommended
- Pulling a "garment core" or "outfit core" out of `web/wardrobe` / `web/outfits`: about 60 files moved, cycle count 35 to 28, ownership currently correct.
- Splitting `schema.ts`; narrowing MCP's reach; splitting `wardrobe-page.tsx`, beyond pulling out `FilterModal`/`BulkDialog` opportunistically.
- Chasing the 34 mutual area pairs as a metric. The invariants worth holding are: no file-level cycles (holds), no upward imports from pure layers (Approach 1), and a home for code no feature owns.

## Cross-Cutting Concerns
- **Both DA checks reached the same conclusion: move-only refactors must pay back.** Pair the dates move with the label fix, and pair status predicates staying put with one status *view*.
- **Blind spot neither expert covered:** Approach 2 changes what Today, the calendar and the outfit page render, and the tab roots are served from the offline page cache. Adding availability marks means those cached pages can show stale away or wash state while offline. Marks should follow the existing freshness indicator (`frontend-pwa.md`: cached reads show freshness).
- None of these touch migrations, so the parallel-branch journal collision does not apply. Approach 1 does collide with every open branch's imports.

## Convention Compliance
- Add to `docs/web-layer.md`, with one line in the root `CLAUDE.md` Web layer section, a rule for code no feature owns:
  - pure → `src/` root (precedent: `random.ts`);
  - web-only → `src/web/` root (`schemas.ts`, `render.ts`);
  - one feature imports another's queries, writers, urls and status basics, never its pages.
- `docs/architecture.md`: state that `src/web/` is effectively the application layer (services built in `app.ts`, reused by CLIs). Make the pure-layer rule enforceable by lint rather than prose.
- `layout/CLAUDE.md`: add rules for garment visuals (`PlinthImage` scale), `GarmentMark` and date labels. Fix `PlinthImage`'s stale "used only by grid and capsules" doc.
- Move `NOT_OWNED_YET` into i18n.

## Recommendation

**Order, one PR each:**
1. **Dates move + pure-layer ESLint boundary + generic `insights.ts`.** Land it alone, on an empty queue.
2. **Date labels:** `src/web/date-labels.ts` with `relativeDay`, `DayHeading`, no raw ISO. This is the user payoff of #1.
3. **`GarmentMark` derived from status + availability**, including on the collage, with the offline-freshness caveat. The highest user value.
4. **Split `validation.ts`** into `schemas.ts` + `garment-input.ts` + route-local schemas.
5. **`garment-access.ts`, then split `wardrobe/routes.tsx`** into grid / garment / photo plugins.
6. **`WornControl`.**
7. **`pickIdea` to `outfits/pick.ts`; outfit row in `SavedOutfitButton`.**

Items 1, 4 and 5 fix the architecture (layering, cohesion, merge contention). Items 2, 3 and 6 fix what users see. Item 3 is the only one that prevents a wrong action.

## Decisions (owner delegated, 2026-10-09)
1. **Today warns, never auto-swaps.** An unavailable piece in a planned outfit gets a blocking `GarmentMark` and the user taps the existing Change. The daily re-plan keeps fixing only the planner's own entries (`week-plan/CLAUDE.md:10`): replacing a hand-picked outfit would override the user.
2. **No "Not this" on Today.** Today's job is one tap to dressed; no evidence the feedback is wanted there. Approach 5's `IdeaActions` is dropped.
3. **Won't do:** splitting `outfits/queries.ts` into reads and writes, and merging the nine thumbnail frames (no user-visible payoff). The outfit-row half of Approach 5 stays.
4. The dates move (R1) lands first and alone, on an empty PR queue.

## Slices (epic issue lists them; one PR each)

Lane A, behavior-preserving refactors (proof: integration specs unchanged and green):
- **R1** Dates move + pure-layer ESLint boundary + generic `insights.ts` + the "code no feature owns" rule in `docs/web-layer.md` and root `CLAUDE.md` + this doc. Alone.
- **R2** Split `wardrobe/validation.ts` (after R1).
- **R3** `garment-access.ts`, then split `wardrobe/routes.tsx` into grid / garment / photo plugins (after R2).
- **R4** `pickIdea` to `outfits/pick.ts`, verbatim (after R1).

Lane B, user-visible (each PR: screenshots at 390 px and 1440 px with real-shaped seed data, and a UX review against this doc):
- **U1** `src/web/date-labels.ts`: absorbs `calendar/labels.ts`, `relativeDay` without the ISO fallback, `trips/shortDate`, a shared `DayHeading`; `acquiredOn` formatted (after R1).
- **U2a** `garmentMarks()` in `src/wardrobe/` + `<GarmentMark>`: one variant and one i18n key per mark, adopted by the grid tiles, Styling rows, the garment page `StatusBadge` and Muse cards. No new data reads.
- **U2b** Availability marks on `OutfitCollage` (Today, calendar, outfit page): blocking marks only (away, archived), `ownerView`-gated, statement counts unchanged, marks shown with the page's freshness when served from cache (after U2a).
- **U3** `WornControl`: one verb family and undo everywhere, the trip page gains undo, dead `CALENDAR_*WORN*` keys removed (after U1).
- **U4** `OutfitCollage size="row"` in `SavedOutfitButton` and the trip outfit rows: every piece, footwear never dropped.
