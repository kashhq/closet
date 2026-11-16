/**
 * Who made an outfit (#659): what decides whether the Saved tab and the
 * pickers list it (`keptOutfit`, src/web/outfits/queries.ts) or it sits
 * behind "Worn and planned". `outfit.origin`, written by createOutfit and
 * raised (never lowered) by a later save of the same garments
 * (adoptOutfit, src/web/week-plan/adopt.ts) and made `person` by any edit.
 *
 * - `person`: saved on purpose (the outfit form, Styling, a pick with no
 *   destination, a recreated look, the API); every outfit before #659
 *   that the migration could not prove otherwise.
 * - `agent`: the owner's agent saved it (create_outfit, a proposal, a
 *   pick_outfit with no date).
 * - `idea`: an idea picked for a day, a trip or a replace ("Wear this").
 * - `planner`: "Plan my week" made it.
 */
// In rank order: a reuse moves an outfit only towards the front (a kept
// saver keeps a one-off, an idea pick takes a planner outfit from the
// planner), never back (adoptOutfit's array_position compare).
export const OUTFIT_ORIGINS = ['person', 'agent', 'idea', 'planner'] as const;
export type OutfitOrigin = (typeof OUTFIT_ORIGINS)[number];

/** The origins Saved lists by default: an outfit someone chose to keep. */
export const KEPT_ORIGINS = [
  'person',
  'agent',
] as const satisfies readonly OutfitOrigin[];

/** One-offs: made for a day or a trip, not saved on purpose. */
export const ONE_OFF_ORIGINS = [
  'idea',
  'planner',
] as const satisfies readonly OutfitOrigin[];
