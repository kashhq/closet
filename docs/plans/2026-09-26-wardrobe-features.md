# Wardrobe features plan (2026-09-26)

Status: **approved 2026-09-26**, every section. The backlog is GitHub issues (one per section, in
milestones by phase, ordered in the pinned Roadmap issue, #27); this document holds the design and the
reasons, and each issue links to its section. Build order, each feeding the next: garment
properties (6), adding garments from a link (0), wears and washes with multiples (1), outfits by
occasion (8), capsules (2), weather (7), the outfit gallery (3), Today (9), trips (4), weekly auto-plan (12),
insights (10), wishlist (11), outfit selfies (13), AI guidance (5, optional). The owner wants the app full-featured: features seen in Cladwell, Whering, ALTA and
others are welcome and are collected under "Candidate features" as research finds them.
The original design doc (since retired) listed wear tracking and packing lists / capsules as out of scope for v0.1; this
is that next step.

## Owner decisions (2026-09-26)

- **Trips are a standalone outfit list**, not a date range over the calendar.
- **The gallery shows generated combinations and saved outfits.** A generated one becomes an outfit
  only when picked.
- **AI sees metadata only** (category, colours, brand, name, notes, wear counts). No photos, emails
  or share data leave the homelab. Off unless configured. One exception (#90, 2026-09-27): garment
  thumbnails, pulled by the owner's own authenticated MCP client (section 14, Photos for tagging).
- **Capsules are carved out of one default closet.** The closet is every unarchived garment; a
  capsule (summer, office, festival) is a subset of it.
- **Multiples are built in**: three identical white tees are one garment with a quantity of 3.
- **Garments can be added from a link**: a product page (scraped, reviewed before saving) or a
  direct image URL (photo only, the rest typed in).
- **Features before bulk onboarding.** Production holds 1 garment, 0 outfits and 0 calendar entries,
  so no migration has live data to convert. Onboarding stays a candidate for later.

## Principles that hold across every feature

- **Private per owner, like outfits.** Capsules, trips, wears and washes are scoped to the signed-in
  user. Shares never reach them, and another user's id is a 404 (Request security, "Refusals do not
  reveal ids"). A capsule or trip only ever holds the owner's own garments and outfits; the write
  drops any other id, as the outfit form does.
- **One writer per state.** Each new piece of state has one function that changes it. The calendar
  entry's worn toggle and its wear rows change together in one transaction, never from two places.
- **Counts are derived, never stored.** Wear counts, wears since the last wash and "needs a wash" are
  computed from `garment_wear` rows. Household-sized data makes this free, and a stored counter
  would drift the first time an entry is unmarked.
- **Category roles.** The generator, the laundry defaults and the packing list group garments by what
  they do in an outfit. `categoryRole(category)` in `src/web/wardrobe/garment.ts` (pure) maps the
  built-in categories: `tops` to top, `bottoms` to bottom, `dresses` to one-piece, `footwear` to
  footwear, `outerwear` to layer, `accessories` and `bags` to accessory, `other` and every custom
  category to none. A garment with role none is never generated into an outfit, but can still be
  put in one by hand.
- **Offline.** Every new page reads from the network with the cache as a fallback, like the others.
  Writes (pick, pack, wore, washed) are disabled offline with the explanation `frontend-pwa.md`
  requires. The gallery needs the server to generate, so offline it shows only what the cache holds.

## 0. Adding a garment from a link

One flow for both kinds of link: `/wardrobe/new/from-link` takes a URL and ends on the normal garment
form, prefilled, for review. Nothing is saved until the form is posted.

- **A direct image URL** (the response is an image): the photo is fetched and the form opens with it
  and blank fields. This is the basic version, and it is step one of the full one.
- **A product page** (HTML): extracted in order of reliability. schema.org `Product` JSON-LD (name,
  brand, colour, images, sku, price), then Open Graph (`og:title`, `og:image`), then `<title>`. Colour
  text is mapped onto `GARMENT_COLORS` where it matches ("Navy" to blue, else left for review), and
  the category is guessed from the name ("tee" to tops) and always confirmed by the user. When a
  page offers several images, the form shows them as choices (product shots on a plain background
  cut out best).
- **Best effort, by design.** Some retailers render client-side or block bots. When extraction finds
  nothing, the form opens with the URL kept and says so, so the user can paste an image link. The
  optional AI (section 5) can later read a page the extractor could not. A retailer's product page is
  not personal data, so that stays within the metadata-only rule.
- **The photo goes through the existing pipeline**: `Photos` (the `MAX_INPUT_PIXELS` decode bound,
  WebP variants), then the cutout queue, exactly like an upload. The fetched bytes are held as a
  pending photo until the form is saved and deleted if it never is (the nightly reconciliation's
  day-old rule already covers orphans).
- **New columns**: `garment.source_url` (the product page, a link back from the garment page) and
  `garment.price` (optional, numeric). Price is filled by extraction or by hand, and with wear counts
  it gives cost per wear, which the original design doc listed as future work.
- **Share to Closet.** The manifest gets a `share_target`, so on Android "Share" on a product page
  in any app sends its link straight to this flow. iOS does not support share targets for web apps;
  there it is copy the link, then paste.

**Outbound fetch is an SSRF surface, and the production host can reach the NAS, pgvault and the router.**
Push's guard is an allow-list of push services and does not fit arbitrary retailer hosts. A new
`src/web/security/outbound-fetch.ts` is the only way the server fetches a user-supplied URL:

- http(s) only, default ports.
- Resolve the name and refuse loopback, private, link-local, CGNAT/Tailscale (100.64.0.0/10) and <!-- topology example -->
  IPv6 unique-local addresses. Then connect to **the address that was checked** (a pinned lookup),
  so DNS rebinding cannot swap it afterwards.
- Follow at most 3 redirects, each re-checked the same way.
- Caps: 10 s total, 2 MB for HTML, 15 MB for an image, content type checked.
- No cookies or credentials sent, and a plain identifying user agent.
- Rate-limited per user. One log line per fetch with the host only, never the full URL (it can
  carry tokens).

## 1. Wears and washes

**Problem.** "Worn" is only `outfit_calendar.worn_at`, and composition is `outfit_slot`, which
changes when the outfit is edited. A count computed by joining the two rewrites history: swap the
shoes in March and January's wears move to the new shoes. Wears need their own record, snapshotted
at the moment they happen.

**Schema**

- `garment_wear`: `id`, `garment_id` (FK, cascade), `owner_id` (FK, cascade), `day date`,
  `outfit_calendar_id` (FK nullable, cascade), `created_at`. Unique
  `(outfit_calendar_id, garment_id)`, so one entry cannot count a garment twice. Index
  `(garment_id, day)` for the counts.
- `garment.last_washed_on date` (nullable) and `garment.wash_after_wears smallint` (nullable: null
  means the role's default).
- `garment.quantity smallint not null default 1` (check `>= 1`): identical copies (see Multiples).
- `garment.away text` (nullable, check `lent` or `repair`) and `garment.away_note`: out of the
  closet for now. A manual state, separate from the derived wash state. Unavailable garments are
  skipped by the generator and flagged on packing lists. Returning one clears it.

**Rules**

- **Marking a calendar entry worn** snapshots the outfit's non-empty slots into `garment_wear` rows
  for that entry's day. Unmarking deletes them. Deleting the entry cascades to them. It is one
  function, `setEntryWorn` (replacing today's toggle), one transaction.
- **Logging one garment** ("Wore today", garment page) inserts a row with `outfit_calendar_id` null.
  It can be undone the same day.
- **Wearing an outfit off the calendar** (from a trip or the gallery: "Wearing this today") schedules
  it for today and marks that entry worn. The calendar stays the one history of which outfit was
  worn when.
- **Since last wash** = wears with `day > last_washed_on` (all wears when it was never washed). A wear
  on the wash day counts as before the wash: you wash what you wore.
- **Needs a wash** when wears since the last wash reach `wash_after_wears`, or the role default: top
  1, one-piece 1, bottom 3, layer 10, footwear and accessory never. The defaults live in one table in
  `garment.ts`.
- **Washed** sets `last_washed_on` to today (`APP_TIMEZONE`). No wash history table until something
  needs one.

**Multiples.** A garment with quantity N is N interchangeable copies. Which copy you wore is not
tracked, because for identical tees it does not matter. Copies that differ (another size, a worn-out
pair) are separate garments, which the existing Clone button makes quickly.

- The wash rules count copies: with limit k, **dirty copies = ceil(wears since last wash / k)**, capped
  at N, and **clean copies = N minus that**. It **needs a wash** only when no clean copy is left. Three
  white tees (k = 1) stay available for three wears.
- Washed washes every copy (laundry day). Laundry and the grid show "2 of 3 need a wash".
- The generator uses a garment while a clean copy remains. The trip packing list needs one copy per
  k outfits that use it, up to N: "White tee x3". When a trip needs more than the wardrobe owns, the
  list says so.
- The grid shows a "x3" badge. The garment form has a quantity stepper.

**UI**

- Garment page: "Worn 12 times, 2 since washed, last worn Tue". Buttons: Wore today, Washed.
  "Wash after N wears" goes in the garment form.
- Wardrobe grid: a "Needs a wash" filter, and a small mark on those tiles.
- `/laundry`: the garments that need a wash as a checkbox grid, with "Mark washed" for the whole
  load in one post.

## 2. Capsules

A named set of the owner's garments (seasonal, work, a trip's pool) that the rest of the app filters by.

**The default closet is implicit, not a row.** "Closet" is every unarchived garment, and it is what
every page already shows when no capsule is chosen. The UI presents it as the first, permanent
capsule, and new capsules are picked from it. It is deliberately not a stored capsule containing
every garment: that would need a second write on every garment insert and a rule that the two
always agree, which would drift. "In the closet" already has a single definition (owned and not
archived), and removing a garment from the closet is archiving it. Capsule membership never includes
an archived garment in what it shows.

**Schema.** `capsule` (`id`, `owner_id`, `name`, `notes`, `created_at`) and `capsule_garment`
(`capsule_id`, `garment_id`, primary key both, cascade both, index on `garment_id`). A garment may
be in any number of capsules. Archiving a garment keeps its membership; it is filtered out like
everywhere else.

**Routes and UI**

- `/capsules`: a list, each card showing a strip of cutout thumbs and a garment count. `/capsules/new`,
  `/capsules/:id` (its garments as a grid, plus a "Swipe outfits" button into the gallery),
  `/capsules/:id/edit`.
- **Membership is edited with a picker**: the wardrobe grid in select mode (checkbox tiles, the same
  keyset paging and filters), posting the whole selection. The garment page also gets an "In
  capsules" row of toggles.
- The wardrobe grid and the outfit builder take `?capsule=`, so building from a capsule only cycles
  its garments.
- Navigation: a Capsules tab on the wardrobe page, not a new dock item. The dock stays at its current
  size.

## 3. Outfit gallery (the swipe picker)

**Layout.** Full-width outfit cards in a horizontal CSS scroll-snap strip
(`overflow-x-auto snap-x snap-mandatory`, cards `snap-center shrink-0 w-full`). Swiping is native
scrolling, with no JS library and no touch handlers. Each card stacks the cutouts the way you would
lay clothes on a bed: layer and top above, then bottom, then footwear, with accessories beside them.
The last card is followed by a sentinel (`hx-trigger="intersect"`) that loads the next page and
replaces itself, as the wardrobe grid does.

**Sources.** Two tabs. **Ideas** holds generated combinations and **Saved** holds the owner's outfits,
both limited to a capsule when one is chosen.

**Generator** (`src/web/gallery/generate.ts`, pure, unit-tested):

- Pool: the capsule's garments or all unarchived ones, minus those that need a wash.
- Templates: top + bottom + footwear, or one-piece + footwear, each optionally with a layer.
  Accessories are not generated.
- Ordering: a seeded shuffle, weighted toward garments worn least recently, so the gallery rotates
  the wardrobe instead of showing the favourites. It also avoids more than two non-neutral colours in
  one outfit (neutrals: black, white, grey, beige, navy, brown, as `GARMENT_COLORS` names them) and
  skips combinations identical to a saved outfit.
- Paging: the seed and an offset in the URL, so a page is stable and reproducible. A new seed is
  "Shuffle".
- Scale: combinations are enumerated lazily from the seed. Even 40 tops, 20 bottoms and 10 shoes
  (8,000) is sampled, never materialized.

**Style this item.** `?with=<garmentId>` generates only outfits that contain that garment
(reached from the garment page and from the insights' unworn list).

**Say why not.** A card can be dismissed with a reason: too warm, too cold, clashes, not today.
Too warm and too cold adjust the personal temperature offset (section 7). Clashes stores the
garment pair in `generator_avoid` (owner, garment a, garment b), which the generator never combines
again (undo from the garment page).

**Picking.** A card's primary action depends on where the gallery was opened from, carried as
`?for=`:

- From the calendar (`for=day:YYYY-MM-DD`): "Wear on Tue". A generated card becomes an outfit (slots
  in role order) and is scheduled, in one transaction.
- From a trip (`for=trip:ID`): "Add to trip". The same, but added to the trip.
- With no context: "Save". Also on every card: "Wearing this today".

A picked generated outfit gets a name you can change later (for example "Navy tee, jeans, white
sneakers"), built from its garments' names or categories.

## 4. Trips (standalone outfit list)

**Schema**

- `trip`: `id`, `owner_id`, `name`, `destination` (text, optional), `starts_on` and `ends_on`
  (dates, optional; informational, for the AI and the list, not the calendar), `notes`,
  `created_at`.
- `trip_outfit`: `trip_id`, `outfit_id`, `position`. Primary key `(trip_id, outfit_id)`, cascade
  both.
- `trip_item`: `id`, `trip_id`, `label`, `packed`, `position`. The extras: charger, toiletries,
  passport.
- `trip_garment_packed`: `trip_id`, `garment_id`. A row means packed. Rows whose garment has left
  the list (the outfit was removed) are ignored and cleaned up on that removal.

**Packing list** (derived, never stored): the distinct garments across the trip's outfits, grouped
by role, each with "in 3 outfits" and the number of copies to pack (Multiples, section 1), then the
extras. Checkboxes toggle packed through htmx (like the
worn pill), with a count of how much is packed. A garment that needs a wash is flagged on the list,
since it has to be washed before packing.

**UI.** `/trips` (upcoming first), `/trips/new`, `/trips/:id` (outfits strip, packing list), add
outfits from the saved list (checkboxes) or through the gallery with `for=trip:ID`, and "Copy
extras from a previous trip". On the trip, "Wearing this today" on an outfit records the wear
through the calendar (section 1).

## 5. AI guidance (optional)

- **Config**: `ANTHROPIC_API_KEY` (optional, no default; unset means every AI control is absent),
  plus a model setting whose default is picked at implementation from the current Claude models. It
  goes through `loadConfig()` and the README table like every variable.
- **Data sent**: garment id, category, role, colours, brand, name, notes, wear count, last worn.
  Trip name, destination, dates and outfit count. Never photos, emails, share data or other users'
  data.
- **Uses**, each a lazy htmx fragment that loads after the page, so a slow or failed call never
  blocks one:
  - Gallery: rank the page's candidates and give each card a one-line "why this works".
  - Trip: suggest how many outfits the dates need, the extras to add (as one-tap `trip_item`s), and
    gaps ("no layer for 12°C evenings"). Weather is out of scope here (upstream issue #120 is the
    place for it).
  - Capsule: gaps and redundancies.
- **Logging and cost**: one line per call (use, model, tokens in and out, ms). An in-memory cache per
  input hash, so repeated views do not repeat calls. Failures are a quiet "Suggestions unavailable",
  never an error page.
- It is advisory only: AI output never writes anything without the user tapping.

## 6. Garment properties

**Goal:** store a lot about each garment without making the form a chore. The heavy tee versus the
light tee is the example: two garments with the same category and colour that belong to different
weather.

**Model: typed, nullable columns on `garment`, never a key/value or JSON bag.** Every property is
optional, has a fixed value set enforced by a check constraint (as the colours are), and is added by
a migration, which drizzle-kit makes cheap. The generator, the weather matching and the filters read
them as plain columns. A JSON bag would let values drift from the code's list with nothing to catch
it. That is how the free-text colours became a stored XSS.

| Property | Values | Applies to | Drives |
|---|---|---|---|
| `type` (subcategory) | a fixed list per category: tops = t-shirt, shirt, polo, blouse, sweater, cardigan, hoodie, sweatshirt, tank, ...; bottoms = jeans, chinos, trousers, shorts, skirt, joggers, ...; outerwear = jacket, coat, parka, trench, blazer, vest, rain jacket, ...; footwear = sneakers, boots, sandals, loafers, dress shoes, ...; accessories = hat, cap, beanie, scarf, belt, ... (upstream issue #130) | all | presets, grouping, AI |
| `warmth` | 1 very light, 2 light, 3 medium, 4 warm, 5 very warm | tops, bottoms, one-piece, layers, footwear | weather matching |
| `formality` | 1 lounge, 2 casual, 3 smart casual, 4 dressy | all | occasion matching |
| `materials` | a set: cotton, linen, wool, merino, cashmere, silk, denim, leather, suede, polyester, nylon, fleece, down, knit, synthetic, other | all | care, warmth hints, AI |
| `pattern` | solid, stripes, check, print, graphic, floral, other | tops, bottoms, one-piece, layers | generator (at most one loud pattern) |
| `fit` | slim, regular, relaxed, oversized | tops, bottoms, one-piece, layers | AI, filters |
| `sleeve` | sleeveless, short, three-quarter, long | tops, one-piece | weather matching |
| `length` | short, knee, midi, full | bottoms, one-piece | weather matching |
| `water_resistant` | boolean | layers, footwear, accessories | rain |

No `season` property: seasons follow from warmth, and a "summer" set of garments is a capsule
(section 2). That is one field fewer to fill.

**Keeping it light.** The rules that decide which fields a garment shows live in one table in code
(`GARMENT_PROPERTIES`: property, value set, the roles it applies to, the default per type).

- **Pick a type and the rest fills in.** Choosing "t-shirt" presets warmth 2, sleeve short, formality
  casual and pattern solid, shown as pre-selected chips you can change. A type's presets are
  suggestions and never overwrite a value you set.
- **The form asks only what applies.** Sleeve appears for tops, `water_resistant` for layers and
  footwear. Everything past photo, category, type and colour sits in a collapsed "Details" section
  of tap chips, never selects or free text.
- **Machines fill what they can**: link import (section 0) maps JSON-LD `material` and
  descriptions like "heavyweight", "linen" or "240 gsm", and the optional AI suggests from the
  name and type. Suggestions arrive pre-selected for review, never saved blind.
- **Bulk edit:** select mode on the grid (the capsule picker's) sets one property on every selected
  garment in one post.
- **A tagging mode:** `/wardrobe/tag` swipes through garments missing warmth or formality, one card
  at a time with big buttons. Filling in forty garments is a few minutes, not forty form visits.
- **Nothing is required.** A garment with no properties still works everywhere, and the generator
  treats unknown warmth as the type's preset.

## 7. Weather

- **Provider: Open-Meteo** (free, no API key or account, 16-day hourly forecast with apparent
  temperature, precipitation probability, wind and UV, plus a geocoding API and a historical
  archive for dates further out). The server fetches from its fixed host, which is an allow-list, not the
  user-URL path of section 0. The PWA itself still makes no external requests.
- **Location:**
  - A **home location** per user, set in the profile by searching a city (Open-Meteo geocoding).
  - **"Use my location"** in the installed app (Geolocation, which needs the https name), stored
    per user rounded to about 1 km and used while fresh.
  - A trip's destination, geocoded, gives that trip its forecast.
  - Coordinates go from the server to Open-Meteo rounded, and no other identifier is sent.
- **Cache:** one fetch per rounded location per hour, and the last good answer is kept for offline
  pages, shown with its time. Built as a table (`weather_forecast`), not memory: restarts and
  overlapping deploys start warm.
- **Where it shows:**
  - Today's summary on the wardrobe and calendar headers ("9 to 17°C, rain after 3 pm").
  - The next 16 days on the calendar: an icon plus high and low per day.
  - A trip's forecast for its dates. Past 16 days it shows climate normals labelled "typical"
    ("Typically 50–65 °F, 24% rain chance"), and ideas for those days are matched to a typical day.
- **Climate normals** (built after #10, part of #14): each calendar day's average over the last ten
  whole years at the place, from Open-Meteo's historical archive (ERA5, observed weather), not its
  climate API (CMIP6 model runs, whose average carries a model's bias): daily highs and lows, the
  feels-like range, and the share of days with 1 mm of rain or more, averaged over a week either
  side of the date. One archive request per location covers every day of the year; cached as one
  row per location (`weather_normals`) for 30 days, with the forecast's last-good and single-flight
  rules. A typical day for the matching is a clear day's curve from the normal feels-like low to
  high, with the rain chance every hour. Normals are for a trip's far days only: Today, the
  calendar and the weekly plan and its re-plan stay forecast-only.
- **How it drives suggestions:** each occasion of the day (section 8) has a time window. Its
  apparent-temperature range sets a target warmth for the outfit (the warmths of its layers
  combined). A large swing between morning and evening asks for a layer. Rain asks for
  water-resistant outerwear or footwear, and the card says so. The optional AI gets the same summary.
- **Personal temperature offset** (Acloset): per user, in degrees, added to the apparent
  temperature before matching. It is set in the profile and nudged by the gallery's "too warm" and
  "too cold" (half a degree each, capped at plus or minus 5).
- **Config:** `WEATHER_ENABLED` (default true). Off means no location is ever sent anywhere and no
  weather is shown.

## 8. Several outfits a day (occasions)

A vacation day is often three outfits: day, dinner, a night out. Office day, then change for dinner,
is common at home too.

- **The calendar already allows it**: its unique key is (owner, day, outfit), not (owner, day). What
  is missing is saying which part of the day each outfit is for.
- **`outfit_calendar.occasion`**: all day (the default), work, daytime, workout, evening, night out.
  Fixed, so each can carry defaults: a time window for the weather (work 8 am to 6 pm, evening 6 to
  11 pm) and a formality hint (work at least smart casual, workout lounge). A day's entries show in
  occasion order.
- **UI:** a calendar day stacks its outfits as chips labelled by occasion, with "+ Another outfit"
  and an occasion picker. The gallery opens with `for=day:YYYY-MM-DD&occasion=evening`, so its
  suggestions use evening temperatures and the evening formality.
- **Wears count days, not outfits.** Jeans worn in the day outfit and again at dinner are one wear
  for washing. The `garment_wear` rows stay one per entry and garment (so unmarking an entry
  removes exactly its rows), and the counts and wash rules count **distinct days**. Because the
  counts are derived, this is a query rule, not extra data to keep in step.
- **Trips:** a trip outfit gets an optional day of the trip and an occasion ("Day 2, dinner"). The
  list stays standalone (owner decision), but the packing list can then see that the jeans for Day
  2's daytime and dinner are one wear, and that a 5-day trip with 2 outfits a day needs a different
  count of tees than 5 outfits. Unassigned outfits still count one wear each.

## 9. Today (the home screen)

`GET /` becomes Today instead of redirecting to the wardrobe (Cladwell's daily outfit).

- The weather for the day at the top (section 7).
- A row per occasion planned for today, or one "all day" row. Each shows the planned outfit if there
  is one, otherwise up to 3 generated suggestions (section 3's generator, with that occasion's
  window and formality), with Refresh and "Wear this".
- "Wear this" schedules and marks worn in one tap (section 1's path).
- **Push**, opt-in per device in the profile (this is issue #5's answer):
  - A morning "today's outfit" at a chosen time: the planned outfit or the first suggestion, and
    the weather line.
  - An evening "What did you wear?" when nothing is marked worn today. It opens Today with the
    day's entries ready to mark.
  - Sent by a scheduler in `server.ts` beside the nightly timers (`APP_TIMEZONE`), through the
    existing sender.

## 10. Insights

`/wardrobe/insights` (built in #17; the Wardrobe's ⋯ menu): queries over `garment_wear`, `garment` and prices. Nothing stored.

- % of the closet worn in the last 30, 90 and 365 days.
- **Unworn in N days**, each with "Style this item" (section 3's `?with=`).
- Most and least worn. Cost per wear (price ÷ wear days), with the best and worst values.
- The pairs worn together most often.
- A colour palette strip, and category and brand breakdowns.
- It is computed on request; at household size each query is a few milliseconds. A yearly recap
  is a later addition.

## 11. Wishlist

Things you are thinking of buying, added the same way as garments (a link: section 0) and judged
against what you own.

- **`garment.archived boolean` becomes `garment.status`**: `wishlist`, `closet`, `archived`. That
  is three states with defined transitions: bought (wishlist to closet), archive (closet to
  archived), restore (archived to closet), drop (delete a wishlist item). One `setGarmentStatus` is
  the only writer, and a pure `garmentStatusTransition` (unit-tested, like the cutout state
  machine) decides the legal moves.
- "In the closet" becomes `status = 'closet'`: one predicate (`inCloset`) used by every closet read
  (the grid, the builder, the generator, capsules, insights). An integration spec proves that a
  wishlist garment appears in none of them.
- The migration converts `archived` (true to archived, false to closet) and rebuilds the grid's
  `(owner_id, archived, id desc)` index on status.
- **"Goes with my closet"**: a wishlist item's page runs the generator with `?with=` over the
  closet plus that item. It shows how many outfits it would make and the best few. "No layer goes
  with this" is an answer too.
- "Bought it" moves it into the closet, keeping its photo, properties and price, and sets
  `acquired_on` to today.

## 12. Weekly auto-plan

Built in #16 (CLAUDE.md, Weekly auto-plan, has the rules in full).

- **A week template** per user (`week_template`: weekday, occasion; for example Monday to Friday
  work, Saturday daytime and evening). Set once in the profile (its "Your week" section): per weekday
  one outfit for the day (all day, work or daytime) and any occasions around it (a workout, an
  evening, a night out). **It is the one model of the week**: #34a's rhythm counts ("work 3 a week",
  section 15) are derived from it, not stored, and the migration spread the stored weekly counts onto
  weekdays (monthly ones, which no weekday holds, were dropped: occasional evenings are planned by
  hand).
- **"Plan my week"** on the calendar (and Today) fills every template slot of the next 7 days that has
  no entry, using the forecast for each slot. It never repeats a garment beyond its wash limit across
  the week (the plan counts its own future wears, and those of entries already planned) and never
  reuses a whole outfit within the week. It shows what it planned, with Undo for the batch.
- **Auto entries are marked** (`outfit_calendar.planned_by`: `user` or `auto`). A daily job
  (06:00, once per user per day by a claim) compares each future auto entry's forecast with the one it
  was planned for. When the target warmth or the rain need changed and its outfit no longer fits, it
  re-plans that entry and sends a push ("Thursday turned cold: swapped in the wool coat") to the
  devices with the morning reminder on. Entries you placed, edited or wore are `user` and never
  touched.
- Generated outfits it picks are saved like gallery picks; Undo, and a swap, remove the ones it made
  that nothing else uses.

## 13. Outfit selfies

- A calendar entry can carry a mirror photo (`outfit_calendar.photo_id`, nullable FK to `file`,
  set null on delete), through the existing `Photos` pipeline, with no cutout requested.
- Taking one from Today or the calendar marks the entry worn.
- The calendar and the outfit page show the looks as you actually wore them. An outfit page gets a
  "Worn" strip of its selfies.
- **This breaks the rule that calendar entries own no files** (Gotchas, "The DB cascade deletes rows,
  never bytes"). Deleting an entry, or a user, must unlink its photo through `Photos` after commit,
  and `reconcileStorage` must count `outfit_calendar.photo_id` as a reference, or the nightly run
  would delete every selfie as an orphan. Both are specified and tested with the feature, and the
  gotcha is updated in CLAUDE.md.
- **Built (#19)** as a `selfie` table rather than the column: deleting an outfit detaches its wears
  (#7), and a selfie is the record of the same day, so it is kept as a look on its day
  (`outfit_calendar_id` set null) instead of going with the entry. Selfies are served to their owner
  only (`/selfies/*`), never by name on the public `/file/**`. CLAUDE.md, Outfit selfies.

## 14. MCP server

The owner's own Claude (Code, Desktop, mobile) works on the wardrobe through MCP (#33): searches it,
adds pieces from links, builds outfits and capsules, plans days, and compares it with a shared
wardrobe (the demo persona's, #32) to talk through what to buy. With it the owner's Claude is the
stylist, so section 5 may shrink to what must run without anyone asking.

- **Inside the app, not beside it.** `POST /mcp`, a Streamable HTTP endpoint on the official
  `@modelcontextprotocol/sdk` in **stateless** mode (a server and transport per request, JSON
  answers, no SSE and no session id; `GET` and `DELETE` are 405). Every tool calls the query and
  write functions the pages use, so the one-writer rules, role applicability, presets and
  `authorizeWardrobe` hold. There is no second path to the database for a write.
- **Auth: personal access tokens.** `personal_access_token` (user, name, SHA-256 of the token,
  a display prefix, `created_at`, `last_used_at`, `revoked_at`). A token is `closet_` plus 32
  random bytes in base64url, shown once when created. Creating one asks for the current password
  (it outlives signing out, like a password change would); revoking does not. A fast hash is right for 256 random bits:
  nothing to brute-force, and a lookup by the hash's unique index. Created, listed and revoked
  on the profile's "Agent access" page (native-post forms). A token acts exactly as its user,
  shares included (VIEW reads Theo's wardrobe, MANAGE writes its garments, wears stay the
  owner's). A new password revokes every token, as it ends every session.
- **An API, not a page.** `Authorization: Bearer` only; a session cookie never authenticates it.
  The same-origin check lets a request without Origin through (Claude sends none; a browser
  cannot add the header cross-site without a CORS preflight, which is never answered) and still
  refuses a foreign Origin (the MCP spec's DNS-rebinding rule). No page context, so errors are
  JSON. The service worker never handles `/mcp`. A missing, unknown or revoked token is the same
  401 with `WWW-Authenticate: Bearer`.
- **Rate limits.** 120 calls a minute per token; `add_garment_from_link` has the link import's
  budget too (10 a minute per user, whichever token), because it fetches a stranger's site.
- **Tools.** Read: `search_garments` (the grid's filters, capsule, condition, needs-wash for
  one's own), `get_garment`, `list_capsules`, `get_capsule`, `list_outfits`, `get_outfit`,
  `get_calendar` (a date range, up to 62 days), `laundry_status` (own), `list_shared_wardrobes`,
  `compare_with_shared_wardrobe` (own vs a shared wardrobe by role and type: gaps, overlaps;
  pure and unit-tested). Write, each description saying so: `add_garment_from_link` (#6's
  import and extraction, saved straight to the closet), `update_garment` (properties,
  condition), `set_capsule_membership`, `create_outfit`, `schedule_outfit`, `mark_worn`,
  `mark_washed`. Nothing deletes; there is no delete or archive tool.
- **Metadata, not photos or emails.** Tools answer with ids, names, categories, properties,
  colours, prices and counts; never photo URLs, never a selfie, and a shared wardrobe is named by
  its owner's first name as the switcher names it.
- **Photos for tagging: the one exception** (#90, from #11's re-scope, 2026-09-27). The owner's own
  Claude tags garments from their photos, with no API key in the app: `get_garment_photo` answers a
  garment's 400px thumbnail (not the original) as an MCP image content block, for the caller's own
  garments and a wardrobe shared with them (VIEW or more), never a selfie and never another user's
  unshared garment; `search_garments` takes `needsTagging` (tagging mode's own queue) to find what
  needs tags, and `update_garment` writes them (MANAGE or owner). So "no photos leave the homelab"
  now reads: except garment thumbnails, pulled by the owner's own authenticated MCP client. Rate
  limited and logged like every tool, never the bytes.
- **Logging** (context `Mcp`): one line per call with the tool, the user, the token's row id,
  the outcome (ok, refused with its status, error) and the time. Never the token, its prefix,
  the arguments or a URL.
- **Deferred, with a hook each:** `plan_week` (#16), `wardrobe_stats` (#17), the wishlist and the
  shopping loop (#18, #34: `add_garment_from_link` lands in the closet until the wishlist exists),
  occasions (#13: `schedule_outfit` refuses a day that already has an outfit until an entry can
  say which part of the day it is for). OAuth for Claude's connectors UI is not built: a token
  in a header covers Claude Code and Desktop, and the app is reachable over the tailnet only.

## 15. Wardrobe plans

The owner's idea (#34): the questions that shaped the demo persona (style, budget, how the week is
spent) become data, so the owner and their Claude (section 14) can say what the wardrobe should be,
see what it lacks, and iterate. Theo's wardrobe is the owner's target: "start from the demo" copies it
as a plan.

- **The model.** Private per owner, like outfits: shares never reach it, another user's plan is a 404.
  - `style_profile` (one row per user): `styles` and `palette` as `text[]` sets (the values of
    `src/wardrobe/style.ts` and `GARMENT_COLORS`, check constraints as `garment.materials`), a
    `budget` band (budget, mid, premium, luxury), notes. The week's rhythm per calendar occasion
    ("work 3 a week") was a `style_rhythm` table here in 34a; since #16 it is derived from the week
    template (section 12), the one model of the week, and shown read-only. **No city**: the
    home city is the weather's (`user_weather`, #14); the style page shows it read-only, with a
    link to Profile › Weather, and never copies it.
  - `wardrobe_plan` (owner, name unique per owner in any case, notes, `active`; a partial unique
    index keeps one active per owner). A first plan is active; `setActivePlan` moves it.
  - `plan_item` (plan, optional name, category, type, `colors` and `materials` sets, warmth and
    formality **ranges** (min and max, both or neither, like `OCCASION_HINTS`' formality), quantity,
    priority high/medium/low, budget per piece, a note on why, `proposed`). Every constraint but the
    category is optional: empty is "any". Typed columns with the garment's own check constraints.
  - **Nothing links items to garments.** The issue sketched `plan_item_garment`; matching is derived
    on every read instead (counts are derived, never stored), so buying, archiving or retagging a
    garment moves the gap view with no write to keep in step. 34b's "Bought it fulfils an item" is
    this: the bought garment enters the closet and matches. An explicit pin can come later if
    matching ever misses a purchase.
- **Matching** (`matchPlan`, `src/wardrobe/plans.ts`, pure, unit-tested) against the closet only
  (`inCloset`: archived and wishlist garments are not owned clothes):
  - A garment matches an item with the same category, the item's type if it names one, every colour
    and material the item names (a Breton stripe is a blue top), and warmth and formality inside its
    ranges (a garment without the value is outside one).
  - Quantity is copies: a ×3 tee is 3 toward "white tee ×3". **Owned** when the copies reach the
    quantity, **partly** below it, **missing** with none.
  - **One garment fulfils one item**, all its copies (a row is one thing on a shelf). Greedy, not an
    optimal matching, and deterministic: items choose in order of fewest candidates, then priority,
    then id (a specific "white heavyweight tee" chooses before "any tee" could take its only
    garment); an item takes its closest candidates (fewest colours and materials beyond its own, good
    before needs_repair, oldest first) until the quantity is reached.
  - **Condition** (#7's comment on #34): `replace_soon` never fulfils; it is the gap to refill, and
    the item says so. `needs_repair` fulfils, flagged: still in the closet and worn (condition is not
    availability). Away and dirty copies are owned all the same.
  - **Why** an item is short, the first that applies: replace-soon, too-few-copies (partly),
    taken-by-other-items (missing, though garments match: each fulfils another item), nothing-matches.
- **The gap view** (`/wardrobe/plans/:id`, phone-first): the items grouped missing, partly, owned (the
  gaps first), each with the garments that fulfil it and why it is short; the agent's proposals apart.
  Plans live in the Wardrobe header's ⋯ menu (redesign plan); the style profile is a section of the
  Profile (`/auth/profile/style`).
- **Iterating**: a new plan, **duplicate** (every item, "(copy)", "(copy 2)"), make active, rename,
  delete. **Start from a wardrobe**: a closet the requester can view (their own, or a share: Theo's)
  grouped by category, type and colour set, quantities added up, budget the dearest piece, the source
  garments in the note; warmth, formality and materials left open.
- **MCP tools** (section 14): read `get_style_profile`, `list_plans` (tallies), `get_plan_gaps` (a
  plan, the active one by default, as data: status, copies, fulfilling garments, the reason and a
  sentence why, "only replace_soon copies: Grey merino (garment 12)"); write, each described as
  WRITES, `propose_plan_item` and `update_plan_item`. **The agent proposes, the owner decides**: an
  item the agent adds or changes is `proposed`, shown apart and left out of matching until the owner
  accepts it (Accept, or saving it in the form) or dismisses it.
- **Seed**: Theo gets a style profile, his week (the week table, since #16) and "NYC minimal" (19 items, active), which his
  closet mostly fulfils: the replace-soon grey merino and the padded shirt jacket he wants are
  missing, the third oxford partly. The bible's tables are the data, through the forms' readers.
- **The shopping loop (34b)**: plan, gaps, shopping list, buy, "Bought it" fulfils the item.
  - **Candidates** are wishlist garments linked to an item in `plan_item_candidate` (item, garment;
    both cascade). A link rather than a `plan_item_id` on the garment: one product can stand for the
    same item in two plans (a duplicate keeps the links), and the wishlist is shared with MANAGE
    grantees while plans are private, so no garment row a grantee reads or edits carries plan data.
    One writer (`changeCandidates`) keeps both sides the owner's and adds only wishlist garments;
    every reader goes through `onWishlist`. Added from the item (by link and by photo through the
    wishlist's own add carrying `planItem`, linked in the garment's transaction; or ticking what is
    on the wishlist) and from the wishlist item ("For plan item…"). A candidate link is not a
    proposal: it changes nothing the plan asks for and counts for nothing.
  - **The shopping list** (`/wardrobe/shopping`, in the Wardrobe's ⋯ menu beside Plans, per the
    redesign; also from the gap view and the wishlist): the active plan's missing and partly items,
    highest priority first, each with the copies to buy, the budget per piece and its candidates
    (photo, price against the budget, link, "Bought it"), a candidate that is not the kind the item
    asks for saying how ("blue vs black"), and the totals (pieces, budget, the cheapest matching
    candidates). Adding a candidate by photo in a store is the wishlist's normal add.
  - **"Bought it" fulfils**, derived: the wishlist's `buy` moves the candidate into the closet and,
    when it is the kind the item asks for, matching counts it. When it is not, the owner's Bought it
    page says so and offers "Change the item to match" (only what differs), unticked: the item stays
    a gap unless asked. The item's other candidates are offered for removal from the wishlist,
    ticked only when the purchase leaves the item owned. The bought garment's link is kept and stops
    mattering. A grantee who buys sees and sends none of the plan part.
  - **Comparing two plans** (`/wardrobe/plans/compare`): accepted items paired by kind (category,
    type and colour set), what B adds and drops, what changed (quantity, priority, details), what is
    the same, each with its status in its own plan.
  - **MCP**: `get_shopping_list`, `add_candidate` (a wishlist item by id, or a product link imported
    onto the wishlist), `compare_plans`, and `get_plan_gaps` lists each item's candidates.
  - **Seed**: Theo's two gaps pair with W01 (the merino, $49.90 of $50) and W02 (the padded shirt
    jacket, $89.90 of $90): the plan table's `Candidates` column.
- **Slices.** **34a**: the model, matching, the gap view, the style profile, iterating, the agent's
  proposals. **34b**: the shopping loop above.

## 16. Measurements and per-brand sizes (#24)

Stylebook's idea, from "Later" below: what fits you, kept beside the wardrobe so a product link or a
wishlist item can say "your size in Uniqlo: M, runs big" at the moment you choose a size. Small on
purpose: one table of numbers, one of notes, and the places a brand is already on screen.

- **Stored.** Private per user, like the style profile: no route takes `?ownerId=`.
  - `body_measurements` (one row per user): height, neck, shoulders, chest, sleeve, waist, hips,
    inseam, each optional, **stored in centimetres** (numeric, two decimals, 1 to 300 by a check
    constraint), and the `unit` the person reads and types them in (`in` or `cm`; `in` by default,
    for the NYC household). The weather's temperature pattern (`src/weather/temperature.ts`): one
    canonical unit stored, the unit only how it is read (`src/wardrobe/measurements.ts`, pure). Its
    own preference, not the temperature's: that one exists only with the weather on, and a person
    may read °F and measure in cm. No weight: nothing here needs it, and it is the most sensitive
    number a profile could hold.
  - `brand_size` (user, brand, size, note): **one row per brand** (unique per user whatever the
    case, the capsules' `lower(name)` rule), the size worn there (normalized like a garment's:
    `XL` is `X-Large`) and a note ("runs small, size up"; "shirts M, jackets L"), at least one of the
    two. The brand is stored as typed, trimmed and with runs of spaces made one.
- **Brand matching** is one pure function, `brandKey` (`src/wardrobe/brands.ts`: trimmed, spaces
  collapsed, lower case), which insights' brand breakdown already did inline and now shares: "UNIQLO",
  "Uniqlo " and "uniqlo" are one brand everywhere.
- **Where it shows.**
  - **Profile › Sizes** (`#sizes`): the measurements in the person's unit and the brand notes,
    read-only, with "Edit sizes" to `/auth/profile/sizes` (the style profile's shape: a section that
    links its editor). The editor: the unit (two buttons, a native post), the measurements (one
    form, one Save, the numbers in the unit shown; a number saved unchanged keeps its stored value,
    so switching units never drifts it), each brand's row (Save, Remove) and "Add a brand". Native
    posts, 303 back; a refusal re-renders the editor 400 with the field's message.
  - **The garment form** (new, edit, clone, the wishlist's, and the link import's prefilled form,
    which is the same form): under Size, the brand's note for the brand in the field, rendered with
    the page and refreshed as the brand is typed (`GET /auth/profile/sizes/hint?brand=`, a fragment).
  - **The wishlist**: each item's card on the Wishlist tab and the item's page.
  - **MCP**: `get_sizes` (read): the measurements in both units and the brand notes, or one brand's;
    the owner's Claude reads it when shopping. No write tool: sizes are edited in the app.
- **Privacy.** The owner's own, everywhere: shown only on the owner's own wardrobe (on a shared
  wardrobe's form, wishlist and item page there is no hint at all, neither the owner's nor the
  grantee's own, which would describe the wrong body), never on the share page, the hint route
  answers the requester's own notes only, and `get_sizes` is the token's user's. A grantee posting
  to another's brand row gets a 404. Account deletion cascades.
- **Seed.** Theo's bible gets a Measurements table and a Brand sizes table (Uniqlo, Allbirds and the
  brands of his closet), posted through the editor's own readers, so his Wishlist (two Uniqlo items,
  the Allbirds) shows notes. Dana has never opened the profile and Riley just signed up: both empty.
- **Out of scope.** Recommending a size from the measurements or a brand's size chart; a note per
  category within a brand (the note says it); measurement history; sharing sizes with a grantee (a
  gift-giver's use: later, if asked); notes on closet garments' pages and the shopping list; MCP
  writes.

## 17. Care label and repair log (#23)

Save Your Wardrobe's idea, from "Later" below: what the label inside says, and what has been mended or
altered, kept with the garment so the laundry pile and the tailor's ticket have a home.

- **The care label is five garment properties**, section 6's model: typed, nullable `garment` columns,
  each a fixed set checked by a constraint built from `src/wardrobe/care.ts`. The five are the symbol
  groups every care label carries (ISO 3758, and the US labels read the same way): **wash** (machine hot
  60 °C, warm 40 °C, cold 30 °C, hand, do not wash), **bleach** (any, non-chlorine only, do not),
  **dry** (tumble, tumble low, do not tumble, line, flat), **iron** (hot, warm, cool, do not) and **dry
  cleaning** (can be, only, never). Research supported all five; five small chip rows are still one
  screen on a phone. Shoes and bags have none (`propertyApplies`: the label roles are the worn ones,
  accessories and custom categories), so recategorising drops it, as a sleeve is dropped.
- **Presets from the materials**, as a type presets warmth: wool fills hand wash, no bleach, dry flat,
  iron cool; a blend takes the most careful of each (cotton and wool is washed as wool). They fill only
  what is unset or still at the previous materials' preset (`applyCarePresets`, the same `followPreset`
  rule), carried by a hidden `presetMaterials` beside the chips. Dry cleaning is never preset: only the
  label knows "dry clean only".
- **Where it shows.** The garment form's "More details", under the other properties (the properties
  fragment redraws it when a material is tapped); its own marker `careLabel=1`, so a form cached before
  it leaves the label alone. The garment page's "Care label" section: the instructions as chips, then
  the free-text care notes (the old `washing_details`, relabelled "Care notes"). The grid filters by the
  wash (`?wash=`, only washes the wardrobe holds: the laundry sort), `search_garments` too.
  `get_garment` answers the label and `update_garment` writes it (new materials bring their presets,
  explicit values win).
- **The repair log** is a table, `garment_repair` (garment, day, kind `repair` or `alteration`, what
  was done, an optional cost; deleting the garment takes it). **The owner's own record, like wears**:
  read by the garment page's `ownerRecords`, written only by the owner (a grantee's post is a 403 or
  404, the wears' rule), never on a wishlist item (409: nothing is owned to mend). Both writes hold the
  owner lock (`ownerTransaction`). A day is never after today; a cost is read as a price.
- **Where it shows.** The garment page's "Repairs and alterations": the log newest first and "Spent on
  it" (the costs summed in cents), with "Log a repair" to the edit page. The edit page, below the
  garment form (forms cannot nest): each entry with Remove, then "Log a repair or alteration" (kind
  chips, what was done, the day defaulting to today, the cost), native posts, disabled offline. Adding
  lands on the garment page with the entry and a toast; a refusal re-renders the edit page with the
  messages. `get_garment` lists the log for the owner.
- **Cost per wear stayed the price's here; #151 folded the repairs in.** What a garment cost is now
  `totalCost` (price × copies plus its repairs' costs, null without a price), which every cost per wear
  surface divides; the insights statement and the wear summary each sum the repairs in a scalar
  subquery (`repairCostSql`), dated up to the window's last day; the log's "Spent on it" shows that same sum.
- **Seed.** Theo's garments carry their materials' care, a Care labels table where the label differs
  (the blazer, the wool coat and the flannels dry clean only) and a Repairs table (the blazer's and
  flannels' alterations, the raw denim's chain-stitch hem, the Bean Boots' laces, the oxford's button).
  Dana's untagged closet gets presets only where it has materials; Riley has nothing.
- **Out of scope.** Bulk edit of the label (the dialog has nine tabs already; a follow-up if the laundry
  sort asks for it), tagging mode (it asks for the essentials), reading a label from its photo, a
  per-garment laundry routine built from the label, editing an entry (remove and log it again), a
  repair write tool over MCP, and reminders ("the boots are due a resole").

## 18. Duplicate garments: "add a copy" (#20)

Wardrowbe's idea, from "Later" below, in its lightweight form (owner, 2026-09-27): no image embeddings,
the metadata the closet already holds. Adding a garment that looks like one already owned offers "add a
copy" (the garment's quantity, section 1's multiples) instead of a second garment.

- **One rule, 18b's.** `nearDuplicates` (`src/wardrobe/goes-with.ts`, section 11): the same category, the
  same type (both untyped counts as the same) and the same colour set, never an empty one. #20 asks it
  with **`sameBrand`**: a garment whose brand differs (both named, compared by `brandKey`, section 16) is
  not a copy. A blank brand on either side is unknown and still matches: most garments have none (Dana's
  closet), and colours already carry the rule's weight. 18b keeps asking without it, because "do I need
  another?" is about the kind (the Allbirds beside the Vejas), while "is this a copy?" is about the
  product. No second rule.
- **Where it fires.**
  - **The garment form, when the garment lands in the closet**: a new garment by hand, from the add
    sheet's photo, or from a link (the link import's prefilled form is this form, so #6 and #129's
    imports get it), and a clone of a closet garment. A region under Brand and Size, rendered with the
    page (a link import or a clone arrives filled in) and refreshed as the form changes (a GET fragment
    that reads the closet and writes nothing). At most 3 matches, newest first, each with its photo,
    name and copies. Not on an edit (it is already a garment), a wishlist form or "Bought it" (18b judges
    a wishlist item against the closet on its page, before buying).
  - **MCP**: `add_garment_from_link` has no review step, so it cannot ask first. Saved to the closet, its
    answer lists the `lookalikes` beside the garment, and the description tells Claude to ask the owner.
    A new tool, `add_garment_copy`, adds copies to a garment through the web's writer.
  - **Bulk paths**: none creates garments. Bulk edit and tagging mode change existing ones; the seed
    writes the personas' bibles. Nothing to check.
- **It never blocks a save.** The region is a suggestion beside Save, which saves as it always did. The
  check is a read. A refresh that fails (offline, an error) leaves the region as it was.
- **"Add a copy"** is a button on each match. It posts to that garment's `POST /wardrobe/:id/copies`
  and lands on that garment's page with a toast. Owner and MANAGE grantee: quantity is a garment
  property a grantee already sets. The buttons belong to a small form of their own after the garment
  form (`form=`), never to the garment form: a submit button there would come before Save in tree
  order and become the form's default button, so Enter in the name field would add a copy.
  - **Quantity**: one more, up to `QUANTITY_MAX` (30). The button is absent at the cap, and the write
    refuses past it (409). More than one ("bought two") is the garment page's edit afterwards. It runs
    in `ownerTransaction`: the garment row locked, judged (in the closet, under the cap), then written,
    with the owner lock's bounded wait, serialized with the re-plan, which reads availability.
  - **Nothing from the form is saved.** The garment keeps its name, properties, price and date.
  - **Photos**: the garment keeps its own. A pending photo the form held (a link import's, the add
    sheet's) is left as Cancel leaves it: nightly reconciliation removes it once it is a day old, and it
    counts toward the per-user cap of 10 until then (Images).
  - **Wears, washes and repairs**: untouched. They belong to the garment and count days, so the new copy
    starts clean: dirty copies are floor(wears / limit), capped at the quantity.
  - **Price**: per copy. Insights' spend and cost per wear (both price × copies, plus repairs since #151, `totalCost`) rise
    by one price, as they would after editing the quantity. A different price paid for the new copy is
    not recorded (one price per garment).
- **Dismissing a false positive**: "Not the same" on the region adds the matches shown to a hidden list in
  the form (`lookalikesDismissed`). Every refresh sends the list, so those matches stay away while the
  form is open. A new match that a later change brings still shows. The list is posted with a refused
  save and kept. Nothing is stored: the suggestion only exists while the form is open, and saving
  answers it.
- **Offline**: "Add a copy" carries `data-needs-network`, disabled with the explanation like every write.
- **Seed**: no change. Cloning any of Theo's garments that has colours shows the garment itself. The
  Playwright spec uses its own user.
- **Out of scope**: image embeddings; matching on the name or notes; finding duplicates already in the
  closet and merging two garments (their wears, outfits, capsules and photos would need merging); a
  stored "not a duplicate" mark; a price per copy; the wishlist and "Bought it" (18b); MCP deleting the
  garment it just saved (MCP never deletes: the owner does it in the app, then `add_garment_copy`).

## Delivery

Each feature is its own GitHub issue (six) and ships alone. The work for each: its schema and migration
(the drift test), integration specs first (behavior, authorization matrix rows for the new routes,
the one-writer rules), unit specs for the pure parts (roles, wash rules, the generator), a
phone-width browser check as the installed PWA, and the CLAUDE.md sections (Architecture, Routes)
updated in the same commit.

## Candidate features (research, 2026-09-26)

Surveyed: Cladwell, Whering, Indyx, Alta, Acloset, Stylebook, Pureple, Save Your Wardrobe, Fits,
Clueless, Smart Closet, OpenWardrobe, and **Wardrowbe** (github.com/theEvgene/wardrowbe, MIT,
self-hosted, household support, Open-Meteo, suggestions from a model). Wardrowbe is the closest
thing to this app; read how it does something before designing that thing here. Its MIT code may
be adapted with its notice kept (this repo is MIT since 2026-11-25).

**Folded into the sections above** (high value, low effort, fits the model):

- **Availability status** (Stylebook): lent out, at the tailor or repair. A manual state beside the
  derived wash state, never mixed with it. The generator and packing list skip unavailable garments.
  One nullable `garment.away` column (`lent`, `repair`) plus an optional note: see section 1.
- **Style this item** (Acloset "featured piece", the "unworn items" to "style it" flow): the
  gallery takes `?with=<garmentId>` and only generates outfits containing it: see section 3.
- **Say why not** (Acloset, Wardrowbe ratings): a skipped card can say too warm, too cold, clashes
  or not today. Too warm and too cold adjust a **personal temperature offset** (section 7). Clashes
  records the pair to avoid (section 3).
- **Bulk edit** (Whering): select mode on the grid (the capsule picker's) sets one property on many
  garments: see section 6.

**Promoted to sections 9-13** (owner, 2026-09-26): Today, Insights, the wishlist, the weekly
auto-plan and outfit selfies. The summaries below were the proposals; the sections hold the design.

- **9. Today.** The home screen is today (Cladwell): the weather, then up to 3 suggestions per
  occasion planned today (or one "all day" row), each with refresh and "Wear this". A planned
  outfit shows first. This gives Web Push its use (issue #5): a morning "today's outfit" push, and
  an evening "log what you wore?" reminder when nothing is marked (Fits, Wardrowbe). Both are
  opt-in per device.
- **10. Insights.** One stats page: % of the closet worn in 30/90/365 days, "unworn in N days" (each
  links to style this item), most and least worn, cost per wear (price from section 0), pairs
  most worn together, and a colour palette strip and brand breakdown (Whering, Cladwell,
  Stylebook). All of it is queries over `garment_wear`. A yearly recap (Whering "Unpacked") comes
  later.

**Later** (worth doing, not yet): duplicate detection with image embeddings (Wardrowbe); generator rules ("never X with
Y"); an inspiration library with "recreate this look"; order email import. (Care label and repair log,
from Save Your Wardrobe, became section 17.) (Measurements and per-brand sizes, from Stylebook, became section 16.)
(Duplicate detection became section 18, on metadata; image embeddings stay here.)

**Skipped:** avatar try-on (a gimmick at household scale), and social feeds, polls and resale
marketplaces (they need a user base).

## Open questions

1. Properties (section 6) go first, so link import and the generator have fields to fill and read.
   Link import follows immediately because it is the fastest way to stock the wardrobe.
2. The role-default wash thresholds (top 1, bottom 3, layer 10) are a guess. Adjust them to taste.
3. Should a trip's outfits also go on the calendar? Currently no, per the decision. A "Schedule
   these" button could be added later without changing the model.
4. The type lists and their presets (section 6) are a first cut, to be tuned on real garments.
