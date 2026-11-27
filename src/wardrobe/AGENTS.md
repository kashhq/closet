# The garment model

_Reference, not auto-loaded:_ [`reference.md`](reference.md) holds Some types are never drawn, and `oth...; A workout is dressed in activewear b....

## Layout

```
  wardrobe/            The garment model, pure (no database, web or strings): properties.ts owns the
                       built-in categories, each category's role in an outfit (categoryRole), every
                       property's value set (schema.ts builds the check constraints from them), which
                       properties each role has (propertyApplies), the types per category with their
                       presets and weight steps, and applyPresets. See Wardrobe, Properties.
                       availability.ts: the wash and copies rules, away reasons and isAvailable
                       (the generator-facing rule). See Wears and washes.
                       status.ts: the garment status state machine (wishlist, closet, archived;
                       garmentStatusTransition, pure). See Wishlist
                       marks.ts: a garment's status marks, ordered, from its status, away,
                       wash and set-aside (garmentMarks; ownerView keeps away and the wash
                       from a share's viewer). Drawn by GarmentMark. See Layout
                       occasions.ts: a calendar entry's occasions, their order, weather window and
                       formality hint (#14's weather and #9's generator read them). See Calendar
                       generator.ts: the outfit generator (templates, rotation, colour rules, outfit
                       rules, the weather and formality score; seeded, paged). See Outfit gallery
                       outfit-rules.ts: the owner's outfit rules (never A with B, always B with A;
                       matchers by garment, category and type, colour, pattern; avoidedPairRule),
                       compiled once a request (compileRules, alwaysCheck). See Outfit gallery
                       recreate.ts: "Recreate this look" (#22b): a saved look's tagged pieces
                       ranked against the closet (type, colour with close shades, pattern, then
                       available, rested, id; a floor below which a piece is missing), re-picked
                       so the set keeps colorsGoTogether and the never-rules, what the look
                       itself breaks excused (recreateLook, pure, unseeded). See Inspiration
                       coverage.ts: what the closet covers, targets against inCloset
                       garments (matchPlan, the wardrobe plans' gap analysis kept for
                       get_closet_coverage, #337), pure. See MCP server
                       style.ts: the style profile's value sets. See Style profile
                       outfit-origin.ts: who made an outfit (person, agent, idea, planner)
                       and which origins Saved keeps (#659). See Outfits
                       look-reaction.ts: an agent outfit's reaction machine
                       (lookReactionTransition, pure; first the plans' looks, #290). See Outfits
                       agent-requests.ts: requestMove, pure. See Agent requests
                       money.ts: prices in cents (toCents, fromCents): insights' costs and
                       a need's budget fit
                       week.ts: the week template (weekdays, their occasions, the derived
                       rhythm) and planned_by; week-planner.ts: "Plan my week" and the
                       re-plan's judgement (planWeek, replanWeek), pure. See Weekly auto-plan
                       measurements.ts: body measurements, lengths in cm and the unit
                       they are read in; brands.ts: brandKey, the one brand comparison
                       (insights, sizes). See Sizes
                       insights.ts: every insights figure from the closet's rows
                       (wardrobeInsights), pure; recap.ts: the year in review
                       (yearRecap) from the same rows over a year, pure. See Insights
                       packing.ts: a trip's packing list (the copies-needed rule,
                       the warnings, tripPhase), pure. See Trips
                       care.ts: the care label's value sets, its presets from the
                       materials (carePresetsFor, applyCarePresets), the repair
                       kinds. See Wardrobe, care-and-repairs.md
                       suggestions.ts: the agent's suggestions and option groups
                       (decideSuggestion, pure; the dismissal reasons, budgetFit). See
                       Wishlist, suggestions.md
```

## Gotchas

- **The generator's output is pinned** (`generator-output.spec.ts`, #168): exact ideas, order, scores and `more` for seeded closets. A change for speed must pass it unchanged; one that changes it on purpose bumps `GENERATOR_VERSION` and re-pins. Its early stops (`generator-draws.spec.ts`) are sound only because the colour, pattern and clash rules never pass once they fail (adding a garment cannot mend them), the formality score is a sum over garments and the weather's is never negative (`scoreFloor`), and every base has a draw weight above 0. A rule that adding a garment could mend goes in `passes`, not `compatible` (the saved-outfit rule: a layer changes the combination); a score part that could go negative or stop adding up breaks the floor.

- **A layer is scored once per kind over a base** (`layerKinds`, #996: warmth, water resistance, rain gear, formality), and only as much of its rotation order is drawn as finding the best passing layer takes. A score input that reads anything else of a layer joins that key, or layers of one kind score alike when they should not and the pinned output moves.
- **Outfit rules (#21) split by whether a garment mends them.** A never-rule only worsens as garments are added, so it lives in `compatible` (and prunes: a pool garment that breaks one with a lock is never counted among the bases, offered as a layer or used as a mend, so a role it empties ends the request with no draw); an always-rule is mended by adding a B, so it lives in `passes` with the drawer's one repair step (`repairer`: a base with an A and no B gets a B in that role's slot, chosen by a sequence keyed on the seed and the base). An always-rule is moot when no drawable B could take an open slot and still pass `compatible` with the rest of the outfit (`alwaysCheck`: a drawn unlocked garment of B's role to swap, or a layer while layers are offered; the repair picks from the same swaps), so it never empties the ideas: a B that clashes with the outfit's other garments leaves it standing. A never-rule two locked garments break flags every idea (`'breaks-rule'`, `Idea.brokenRules`) instead of emptying them; a caller probing a pair by locking it (Goes-with's `layerChecks`) must read the flag. The pruning never changes the draws: non-viable bases are still drawn (the sequence picks by position in the whole role) and skipped, so a request without rules gives the pinned output.

- **Adding an occasion is a migration.** `outfit_calendar_occasion_check`, `week_template_occasion_check` and `trip_outfit_occasion_check` list `src/wardrobe/occasions.ts`'s `OCCASIONS`, so a new one fails every insert until `npx drizzle-kit generate` recreates the constraint; add its `occasion.<value>` string (a missing one is a type error). The display order is the array's order: reordering it is code only.
- **Adding a property value, a garment type, a colour or a style is a migration.** The check constraints (`garment`'s and `style_profile`'s, #34) list `src/wardrobe/properties.ts`'s, `care.ts`' and `style.ts`'s sets, so a new value there fails every insert until `npx drizzle-kit generate` recreates the constraint; add its `property.<name>.<value>` string too (`labels.spec.ts` fails without it). Removing a value needs a data step for rows that hold it.
- **Some types are never drawn, and `other` means none applies** (#685): a type with `drawn: false` is left out of the generator's pool (`isDrawnType`); `OTHER_TYPE` ends the lists that cannot be complete and has no presets or art.
