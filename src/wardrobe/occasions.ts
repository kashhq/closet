import {
  categoryRole,
  type Formality,
  type GarmentRole,
  purposeOf,
} from './properties';

/**
 * The part of the day a calendar entry is for (#13; plan section 8):
 * `outfit_calendar.occasion`. A fixed set, so each carries defaults the
 * rest of the app reads from here and nowhere else:
 * - the weather's time window (#14): which hours of the day's forecast the
 *   outfit has to dress for (work 8 am to 6 pm, evening 6 to 11 pm);
 * - a formality hint (#9's generator, Today #15): the range of garment
 *   formality (src/wardrobe/properties.ts FORMALITIES: 1 lounge, 2 casual,
 *   3 smart casual, 4 dressy) that suits it.
 * Pure: no database, web or strings (the labels are the catalog's
 * `occasion.<value>`). The check constraint on the column lists OCCASIONS,
 * so adding one is a migration (AGENTS.md, Gotchas).
 */

/**
 * In display order: all day first (it frames the day), then the others in
 * the order their windows start. A day's entries show in this order.
 */
export const OCCASIONS = [
  'all-day',
  'workout',
  'work',
  'daytime',
  'evening',
  'night-out',
] as const;
export type Occasion = (typeof OCCASIONS)[number];

/** What an entry is for when nobody said: every entry made before #13, and a post without one. */
export const DEFAULT_OCCASION: Occasion = 'all-day';

export interface OccasionHints {
  /**
   * Hours of the day in APP_TIMEZONE, `from` inclusive and `to` exclusive
   * (0 to 24). A default: the weather reads the forecast over it.
   */
  window: { from: number; to: number };
  /** The garment formality that suits it, both ends inclusive. */
  formality: { min: Formality; max: Formality };
  /** Dressed for moving (#647): see ActiveDemand. */
  active?: ActiveDemand;
}

/**
 * An occasion dressed for moving (a run, the gym), and what that changes:
 * - every idea fills `roles` with garments of an `active` type
 *   (GarmentType.purpose), a hard rule: a closet without them gets no idea
 *   (the generator's pool, the planner's empty slot), never a parka and
 *   boots for a run. The top is free: any light top runs;
 * - legs and feet are not held to the weather's cold floor (assessOutfit):
 *   running shorts at 0 °C are what runners wear, the effort warms them;
 *   too warm still counts (#757's ceiling);
 * - a layer is not held to the formality range (the generator): what keeps
 *   a cold run warm is a jacket, and none is formality 1.
 */
export interface ActiveDemand {
  roles: readonly GarmentRole[];
}

export const OCCASION_HINTS: Readonly<Record<Occasion, OccasionHints>> = {
  // An everyday outfit for the whole waking day.
  'all-day': { window: { from: 8, to: 22 }, formality: { min: 2, max: 3 } },
  // A morning run or gym session, before the day's outfit.
  workout: {
    window: { from: 6, to: 9 },
    formality: { min: 1, max: 1 },
    active: { roles: ['bottom', 'footwear'] },
  },
  // The plan's rule: at least smart casual.
  work: { window: { from: 8, to: 18 }, formality: { min: 3, max: 4 } },
  // Errands, brunch, a museum: out and about in daylight.
  daytime: { window: { from: 10, to: 18 }, formality: { min: 2, max: 3 } },
  // Dinner, a date.
  evening: { window: { from: 18, to: 23 }, formality: { min: 3, max: 4 } },
  // Drinks and late plans: a bar in jeans or a club in a jacket.
  'night-out': { window: { from: 21, to: 24 }, formality: { min: 2, max: 4 } },
};

/**
 * What the generator asks of an outfit for `occasion` (generateIdeas'
 * `formality` and `active`): every caller that draws for an occasion
 * spreads it into its request, so none forgets a part.
 */
export function occasionDemands(occasion: Occasion): {
  formality: OccasionHints['formality'];
  active: ActiveDemand | null;
} {
  const hints = OCCASION_HINTS[occasion];
  return { formality: hints.formality, active: hints.active ?? null };
}

/** Why an active occasion has no outfit for want of activewear (activewearGap). */
export type ActivewearGap = 'no-activewear' | 'none-available';

interface KindOf {
  category: string;
  type: string | null;
}

/**
 * Whether `garments` lack an activewear garment in a role `active` requires.
 * `isActivewear` judges one garment: by default its type's purpose, but the
 * generator also drops bottoms too light for a cold snap (isActivewearFor,
 * src/weather/match.ts), and a gap must say the same.
 */
export function lacksActivewear<G extends KindOf>(
  active: ActiveDemand,
  garments: readonly G[],
  isActivewear: (garment: G) => boolean = (g) =>
    purposeOf(g.category, g.type) === 'active',
): boolean {
  return active.roles.some(
    (role) =>
      !garments.some(
        (g) => categoryRole(g.category) === role && isActivewear(g),
      ),
  );
}

/**
 * What an empty answer for an active occasion is owed to, when it is
 * activewear: the closet has none of a required kind ('no-activewear': set
 * garment types, or in a cold snap none warm enough to run in), or it has,
 * but none is available (`available`: clean, at home) for the day
 * ('none-available'). Undefined for everyday wear, or when activewear is not
 * what is missing (the weather or a rule is). `isActivewear` as in
 * lacksActivewear.
 */
export function activewearGap<G extends KindOf>(
  active: ActiveDemand | null,
  closet: readonly G[],
  available: readonly G[],
  isActivewear?: (garment: G) => boolean,
): ActivewearGap | undefined {
  if (active === null) return undefined;
  if (lacksActivewear(active, closet, isActivewear)) return 'no-activewear';
  return lacksActivewear(active, available, isActivewear)
    ? 'none-available'
    : undefined;
}

/**
 * The occasions whose outfit is the one worn through the day. The others
 * (a morning workout, an evening, a night out) come around it. Today (#15)
 * suggests an all-day outfit while none of these is planned: a day with
 * only a run and a dinner on it still needs something to wear in between.
 */
export const DAY_OCCASIONS: readonly Occasion[] = [
  'all-day',
  'work',
  'daytime',
];

export function isOccasion(value: string): value is Occasion {
  return (OCCASIONS as readonly string[]).includes(value);
}

/** Sorts a day's entries into display order (Array.prototype.sort is stable, so ties keep theirs). */
export function compareOccasions(a: Occasion, b: Occasion): number {
  return OCCASIONS.indexOf(a) - OCCASIONS.indexOf(b);
}
