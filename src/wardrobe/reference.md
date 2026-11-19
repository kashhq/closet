# The garment model: reference

Moved out of `AGENTS.md` (#723) so the auto-loaded doc keeps only invariants, gotchas and ownership. Not auto-loaded: read it before changing this area. Where it disagrees with the code or a spec, they win.

## Gotchas

- **Some types are never drawn, and `other` means none applies** (#685): a type with `drawn: false` (socks, underwear, swimwear, sleepwear) is left out of the generator's pool (`isDrawnType` in `drawableByRole`), which every idea, plan and Shuffle reads. `OTHER_TYPE` ends the lists that cannot be complete (not tops or bottoms), so tagging can be answered honestly; it has no presets, no art shape and is no look piece's type.
- **A workout is dressed in activewear by type** (#647): `GarmentType.purpose: 'active'` (running shoes, running shorts, leggings, joggers, sports tops; not sweatpants, lounge wear) is code only, no column. `OCCASION_HINTS.workout.active` keeps its bottoms and footwear for active types (the generator's pool and templates: no idea, so an empty planner slot, rather than a near miss), spares legs and feet the cold floor (`assessOutfit`) and its layer the formality range. Every caller drawing for an occasion spreads `occasionDemands(occasion)` into its request, never `formality` alone.
