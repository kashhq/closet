# Muse in closet: suggestions as garments

> **Status: draft for the owner's review (2026-10-05).** Nothing here is built.
> Comment on the pull request, line by line. This document replaces the plans feature's
> UI (`docs/plans-*.md`, `src/web/plans/`). Once approved it is the reference for the epic
> that implements it.

## 1. Why

The owner works with an AI stylist agent, **Muse**, over MCP. Muse designs them a wardrobe:
it researches real products online, offers options for each need, and proposes outfits. The
owner can talk to Muse directly. They want **closet to be the visual frontend for Muse's
work**: the place to see what Muse is suggesting, style it with their own clothes, decide,
and give feedback.

The plans feature (2026-09 to 2026-10) failed at this, on both the phone and the web:

- Suggestions live in lists **outside** the rest of the app. They can't be put in Styling,
  can't be seen with the owner's own clothes, and Muse's outfits are a separate, weaker copy
  of the Outfits tab.
- It is a **second app inside closet**, with its own items, candidates, looks, review page,
  shopping list, statuses and sheets. Each one duplicates something closet already does well.
- Flows dead-end: "2 options" led to the wishlist page; shop links were hard to reach;
  actions hid inside sheets; cards carried several primary buttons.

Meanwhile closet's **own** wardrobe UI (the grid, garment pages, Styling, outfits) works well.

### The job to be done

Not "review suggestions", but **a coherent wardrobe, bought with confidence, judged
against what I already own**. Muse does the research; closet is where the owner _sees_ a
suggestion in context and _decides_, and where Muse _learns_ from the decision. A week of
success looks like this:

> Muse finishes a round. A notification. On the phone, in five minutes, the owner opens
> Muse's three outfits, sees a proposed blazer with their own raw jeans, swipes it into
> Styling to try it with something else, sees it works with 23 of their outfits, taps
> **This one**, and buys it, online or in a store. Muse's next round already knows: what
> was picked, what was turned down and why, and later how often it gets worn.

A list of products is the failure mode.

## 2. Principles

1. **A suggestion is a garment.** Everything Muse proposes works where the owner's clothes
   work (Styling, outfits, garment pages), marked as Muse's, until it's bought or dismissed.
2. **Outfits first, products second.** The owner judges a piece by what it does with their
   closet, so a Muse round opens on outfits. Products come second.
3. **The closet decides between options.** Every suggestion shows **"unlocks N outfits"**
   with the owner's closet, and options sort by it.
4. **One concept per thing.** No plan, plan item, candidate or look. There is a garment
   (with provenance) and an outfit (with provenance).
5. **Every decision is feedback.** Choosing, dismissing (with a reason) and buying reach
   Muse in a form it can act on. Muse never re-proposes what was turned down.
6. **Phone first, desktop alongside.** One markup with CSS-only responsiveness. Every screen
   is designed and judged at 390 px and at 1440 px together.
7. **The owner's closet stays theirs.** The closet grid is untouched: owned garments only,
   no Muse badges. Muse appears only where a pick or a Muse outfit is.

## 3. Model

| Concept           | What it is                                                                                                                                                              | Replaces                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Suggestion**    | A **wishlist garment** with provenance: `suggested_by_token_id` (Muse's access token), `suggestion_note` (Muse's reasoning), list price, `source_url`, an optional size | plan candidates (already wishlist garments) |
| **Option group**  | One need ("a navy blazer, under $300"), with its budget, Muse's reasoning, open or resolved, and the owner's note. Holds 1–N sibling suggestions, ranked by Muse        | `plan_item` plus `plan_item_candidate`      |
| **Muse outfit**   | An ordinary **outfit** with provenance (`proposed_by_token_id`, a note, the owner's reaction). It may hold not-owned pieces                                             | `plan_look`, `plan_look_slot`               |
| **Dismissal**     | A soft state on a suggestion, group or outfit, with a reason, never a delete                                                                                            | `plan_item_rejection`, review deletions     |
| **Style profile** | Unchanged                                                                                                                                                               | (kept)                                      |

Why no new garment status: "owned" checks are scattered (about 15 sites test
`status !== 'wishlist'`). A new status would leak into wears, washes, outfit saves and
archived views. A wishlist garment is already excluded everywhere ownership matters. The
owner's own wants and Muse's picks become **one "not owned yet" list**, told apart by
provenance.

### The one structural change: outfits may hold not-owned pieces

Today a saved outfit cannot contain a wishlist garment (Styling's Save refuses it), which is
why plans grew a parallel "looks" system. Instead:

- An outfit may hold wishlist pieces. Such an outfit is **incomplete**.
- An incomplete outfit **can't be worn, marked worn, planned on the calendar, packed, or
  suggested by Today, Ideas or the week planner** until every piece is owned. This is one
  rule applied in one place (the garment "holdable" check), not per surface.
- **Bought it** turns the pick into an owned garment, and every outfit that holds it stays
  intact (and becomes complete when its last piece is owned).
- A **dismissed** pick inside an outfit marks the outfit "needs a replacement", and Muse sees
  that in its feedback. Its slot is never silently emptied.

### Choosing between options

- **This one** resolves the group. The chosen pick stays a suggestion until bought; its
  siblings are dismissed with the reason "chose another".
- **Not for me** on a pick dismisses it, with a reason. On a whole group, it means "not this
  need right now", and Muse sees the need is still open or declined.
- **Bought it** (on the garment page) takes the price paid. **Bought a different one** opens
  the garment form prefilled from the pick (brand, category, colours), lands an owned garment
  with the provenance kept, and resolves the group.
- **Returned it:** archive with the reason "returned", visible to Muse.

## 4. Screens

### A. Today: the moment a round lands

One card when Muse finishes a round: **"Muse: 3 outfits, 7 pieces to consider"** with a
**Review** button, leading to the Outfits tab with Muse's round first. A Web Push
notification is sent once per round (opt-in per device, tagged so a newer one replaces an
unread one).

### B. Outfits tab: Muse's round (the main screen)

- Muse's outfits come **first**, as large cards: every piece big, to-buy pieces badged with
  their price, Muse's one-line note, and an **unlocks N** chip on to-buy pieces.
- **One primary per card:** **Love** (or **Save** once complete). A small **×** for
  **Not for me**, with quick reasons. **Edit in Styling** as a link.
- Tapping any piece opens the full-screen photo viewer (shipped in #326).
- Below Muse's round: the owner's own outfits, as today.
- **Phone:** one card per row, with a piece row of 4 tiles (tap to zoom).
  **Desktop:** 2–3 cards per row, pieces large.

### C. Decision: an option group

Reached from a Muse outfit's to-buy piece, or from the inbox.

- **Phone:** a snap strip of the options. Each card shows the photo, price vs budget,
  **unlocks N outfits**, your size note for that brand, and **This one** as the primary.
  Below the centred option sit its 3 best outfits with your closet (the "goes with" collages,
  inline).
- **Desktop:** the screen width earns its keep here. **One column per option**, side by
  side, each with its best outfits as rows underneath, so you can compare options directly.
- Muse's reasoning sits behind a tap, not as paragraphs.

### D. Wishlist tab: the inbox

- Option groups as compact strips, sorted by unlocks, then single picks in a 2-up grid
  (paged), then the owner's own wishlist items.
- A **"new from Muse"** marker since the last visit. Dismissed items collapse under one
  count ("12 dismissed"), so they can be undone.
- It's warmed for offline like the closet is.

### E. Styling

One toggle, **Include picks**, off by default. When it's on, each row's strip includes
suggested garments (badged, with a group's options next to each other), so the owner can try
a pick on any outfit with their own clothes. Saving works and produces an incomplete outfit.

### F. Garment page for a suggestion

The photo, Muse's note, price, your size note, **unlocks N outfits** (with the "goes with"
collages), its siblings in the group, **View product** (shop), and **This one / Not for me /
Bought it / Bought a different one**.

### G. Unchanged

The closet grid, capsules, the calendar, Today's outfit suggestions, laundry and insights.
They never show a not-owned garment.

### H. Removed

Every plans page: the plans list, plan page, item view and sheet, plan Outfits tab, review
page, shopping list, compare, "start from a wardrobe", and the plan Today card.

## 5. Muse's MCP contract

| Tool                      | Purpose                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_closet_coverage`     | What the closet lacks, derived and never stored (plans' gap analysis, kept)                                                                                                      |
| `create_option_group`     | A need: name, budget, reasoning                                                                                                                                                  |
| `suggest_garment`         | From a product URL into a group: note, rank, list price, size                                                                                                                    |
| `suggest_outfit`          | Owned plus suggested garment ids, a note                                                                                                                                         |
| `finish_round`            | Ends a research round: the Today card and push                                                                                                                                   |
| `get_suggestion_feedback` | Since the last call: picks, dismissals with reasons and notes, purchases (with price, or "bought a different one"), returns, wear counts of bought suggestions, outfit reactions |
| `list_suggestions`        | What's open, resolved and dismissed                                                                                                                                              |

Rules: Muse can never buy, delete or mark anything owned. It never re-proposes a dismissed
product (matched by URL or garment). The old plan tools keep working as shims for one
release, then go.

## 6. Feedback and learning

- **Dismissal reasons** (one tap, plus an optional note): too pricey, the colour, the style,
  already have one, fit or size, not now.
- **Behaviour:** purchases and **how often bought suggestions are worn** (from wears). This is
  the signal Muse can't get from chat.
- Closet stores **no taste model**. Muse derives taste from this history and the style
  profile.

## 7. Scale

With 120 suggestions: outfits first (paged like `/outfits`), then option groups (one strip
each), then singles (a paged grid). Dismissed items collapse. Nothing is ever one endless
scroll.

## 8. Rollout (each step ships and works alone)

1. **Model and inbox:** provenance, option groups and soft-dismiss. The Wishlist tab becomes
   the grouped inbox with the decision screen (C) and the garment page (F). Existing plan
   candidates migrate (they're already wishlist garments).
2. **Outfits hold not-owned pieces:** the incomplete rule. Muse outfits on the Outfits tab
   (B). `plan_look` migrates into outfits.
3. **Styling:** the Include picks toggle.
4. **Muse's tools and the round moment:** the new MCP tools, `finish_round`, the Today card
   and push. Old tools become shims.
5. **Remove plans:** about 11k lines of source, 1k of MCP tools and 15k of specs.

Each step: designed at 390 px and 1440 px together, screenshots for the owner **before**
merge, and one review focused on whether the UX matches this document.

### Production data

The owner's draft plan 14: 24 items become 24 option groups (their candidates are already
wishlist garments), and its 8 proposed looks become Muse outfits. Rejections become
dismissals. The style profile stays.

## 9. Risks

- **Outfits holding not-owned pieces** touches outfit saves, wears, the calendar, trips,
  Today and Ideas. It's safe only if "incomplete" is enforced in one place, with a spec per
  surface (the wishlist spec's pattern).
- **Byte-stable tab roots:** the Styling toggle is URL state, never time-based. The "new
  from Muse" marker is a client-side or stored last-seen, never part of the cached bare page.
- **Shared wishlists:** a household member who can view the wishlist sees Muse's notes.
  Accepted (owner, 2026-10-05).

## 10. Decisions

- Retire plans; suggestions are garments (owner, 2026-10-05).
- Dismissing is feedback to Muse: hidden from the inbox, kept, and recoverable (owner).
- No named batches: "new since you last looked" is enough (owner).
- Muse's notes visible to wishlist viewers in the household: fine (owner).
- No chat inside closet; no try-on view (design review).

## 11. Open questions for the owner

1. **Outfits first:** should a Muse round open on Muse's outfits (B), or on the option
   groups (C)?
2. **Unlocks N:** is "how many outfits this makes with your closet" the right headline
   number on each pick?
3. **Dismissal reasons:** is the list in §6 right?
4. **Your own wishlist items:** should they get the same decision screen, unlocks count and
   garment page as Muse's picks?
