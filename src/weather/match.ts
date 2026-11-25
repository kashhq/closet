import { OCCASION_HINTS, type Occasion } from '../wardrobe/occasions';
import {
  categoryRole,
  type GarmentRole,
  presetsFor,
  purposeOf,
  type Warmth,
} from '../wardrobe/properties';
import { type DayForecast, RAIN_CHANCE } from './forecast';

/**
 * Weather matching (#14; plan section 7): what a day's weather asks of an
 * outfit worn for an occasion, and how well an outfit answers it. Pure and
 * the one place the rules live: the outfit generator (#9) ranks and filters
 * with it, Today (#15) explains its picks with it, the MCP tools report it,
 * and the seed's simulated weather is checked against it
 * (src/seed/weather.spec.ts). Availability (isAvailable,
 * src/wardrobe/availability.ts) is a separate question: filter first, then
 * match.
 *
 * The steps:
 * 1. The occasion's window (OCCASION_HINTS: work 8 to 18, evening 18 to
 *    23, ...) picks the day's hours that matter.
 * 2. Their feels-like range, with the user's personal offset added
 *    (src/weather/temperature.ts), is what to dress for.
 * 3. That sets a target warmth: for the torso, the warmths of the top (or
 *    one-piece) and the layer combined (1 a tank ... 9 a sweater under a
 *    parka); for legs and feet, one garment's warmth (1-4).
 * 4. A large swing across the window (its coolest and warmest hours
 *    LAYER_STEPS or more torso steps apart, about 8 °C) asks for a layer that
 *    comes off: the outfit with it is judged by the coolest hours, without it
 *    by the warmest. A swing inside the heat (25 to 33 °C) asks for nothing:
 *    both ends want a tee.
 * 5. Rain in the window (any hour at RAIN_CHANCE or more) asks for a
 *    water-resistant layer, footwear or accessory, unless the umbrella
 *    answers it (WeatherNeeds.umbrella: warm rain hours, or the owner's
 *    water-resistant accessory, withRainGear): then it is advice for the
 *    day, "Take the umbrella", and no outfit is judged on it (#648).
 */

/**
 * Torso steps between the window's coolest and warmest hours from which the
 * outfit wants a layer: one step is inside the torso's tolerance, two are
 * not (about 8 °C).
 */
const LAYER_STEPS = 2;
/** The combined torso scale: a top's 1-5 plus a layer's 1-5, at most 9 is asked. */
const TORSO_TARGET_MAX = 9;

/**
 * The torso warmth for a feels-like temperature (°C): one step per 4 °C
 * down from 26 °C and over (a tank or a light tee, 1). A tee (2) at 22 °C
 * and still at 18 °C, a sweater (4) at 14 °C, a tee under a jacket (5) at
 * 10 °C, a sweater under a jacket (7) at 2 °C, under a parka (9) from -6 °C.
 */
export function torsoTarget(feelsLike: number): number {
  return clamp(Math.round((30 - feelsLike) / 4), 1, TORSO_TARGET_MAX);
}

/**
 * Below this feels-like (°C, about 14 °F) ordinary trousers and shoes alone
 * are cold: a cold snap's day (8 of New York's 31 days in January 2025).
 * Above it they are what people wear all winter (real-days.spec.ts).
 */
const COLD_SNAP = -10;

/**
 * How far under the cold snap's ask a run's legs may be (legsTooColdForRun):
 * wider than an everyday outfit's tolerance, since the effort warms a run:
 * leggings and joggers (2) pass, running shorts (1) do not.
 */
const COLD_RUN_LEGS_BELOW = 2;

/**
 * Whether a run's legs are too cold in `garment` (running shorts) in a cold
 * snap (#647): below COLD_SNAP an active occasion asks full-length bottoms
 * again, where above it the cold floor is spared. The generator keeps such
 * a garment out of an active occasion's draws, so a planner never takes it
 * as a near miss.
 */
export function legsTooColdForRun(
  needs: WeatherNeeds,
  garment: MatchGarment,
): boolean {
  return (
    needs.feelsLike.min < COLD_SNAP &&
    needs.limbs - COLD_RUN_LEGS_BELOW - garment.warmth > 0
  );
}

/**
 * Whether `garment` is activewear for an active occasion in `needs` (#647,
 * #768): an active type, and in a cold snap not bottoms too light for a run
 * (legsTooColdForRun). The one rule behind the generator's pool and the gap
 * it reports when nothing is drawn (activewearGap), so the two never
 * disagree. No `needs` (no forecast) means no cold snap.
 */
export function isActivewearFor(
  needs: WeatherNeeds | null | undefined,
  garment: { category: string; type: string | null; weather: MatchGarment },
): boolean {
  return (
    purposeOf(garment.category, garment.type) === 'active' &&
    !(
      needs != null &&
      garment.weather.role === 'bottom' &&
      legsTooColdForRun(needs, garment.weather)
    )
  );
}

/**
 * Legs and feet (one garment's warmth, 1-4 asked): shorts and sandals (1)
 * from about 26 °C, chinos and sneakers (2) around 19 °C, jeans (3) from
 * about 12 °C through an ordinary winter, heavy denim and boots (4) in a
 * cold snap.
 * Never 5, and 4 only in a cold snap: no ordinary trousers reach warmth 4
 * (only heavy denim does, DENIM_WEIGHTS) and only boots among shoes, so a
 * 4 asked on an ordinary winter day left one pair of jeans and one pair of
 * boots fitting every idea, and no office outfit at all (#645).
 */
export function limbTarget(feelsLike: number): Warmth {
  const max = feelsLike < COLD_SNAP ? 4 : 3;
  return clamp(Math.round((33 - feelsLike) / 7), 1, max) as Warmth;
}

/**
 * Above this feels-like (°C, about 72 °F) at every rain hour, rain is the
 * umbrella's, not the outfit's: the only water-resistant garments a closet
 * usually has are a shell and boots, and asking for one at 30 °C dressed
 * every July rain idea in the same shell over the one top light enough to go
 * under it (#648, real-days.spec.ts). Judged on the rain hours, not the
 * window's warmest: rain in a cool morning of a warm day still wants a shell.
 */
export const SHELL_CEILING = 22;

/**
 * What the cold would welcome on legs and feet, uncapped (1-5): the bound
 * for "too warm". `limbTarget`'s cap only lets ordinary gear meet the cold
 * side; it must not make insulated boots too warm for a winter day (#645).
 */
function limbCeiling(feelsLike: number): Warmth {
  return clamp(Math.round((33 - feelsLike) / 7), 1, 5) as Warmth;
}

export interface WeatherNeeds {
  occasion: Occasion;
  /** The occasion's hours, `from` inclusive, `to` exclusive, in the forecast's zone (a trip's: the destination's). */
  window: { from: number; to: number };
  /** The window's feels-like range, °C, the personal offset included. */
  feelsLike: { min: number; max: number };
  /**
   * Torso warmth (top or one-piece plus layer) for the coolest hours when a
   * layer is needed, else for the window's middle.
   */
  torso: number;
  /** Without the layer, for the warmest hours: equals `torso` without a swing. */
  torsoWithoutLayer: number;
  /** Legs and feet, for the window's middle. */
  limbs: Warmth;
  /** Legs and feet's too-warm bound: `limbs` without the cold-side cap. */
  limbsCeiling: Warmth;
  /** The swing is LAYER_STEPS or more: add a layer that comes off. */
  layer: boolean;
  /** An hour of the window reaches RAIN_CHANCE. */
  rain: boolean;
  /**
   * The rain is met outside the outfit ("Take the umbrella", advice for the
   * day, never a card's problem): warm rain hours (SHELL_CEILING) or the
   * owner's water-resistant accessory (withRainGear). False without rain;
   * with rain and false, the outfit wants water resistance.
   */
  umbrella: boolean;
}

/**
 * What `day` asks of an outfit for `occasion`, for someone whose personal
 * offset is `offset` (°C, added to every feels-like). Null when the forecast
 * has none of the window's hours (the first day of a forecast fetched late
 * in the evening still has them: Open-Meteo answers whole days).
 */
export function weatherNeeds(
  day: DayForecast,
  occasion: Occasion,
  offset: number,
): WeatherNeeds | null {
  const { window } = OCCASION_HINTS[occasion];
  const hours = day.hours.filter(
    (h) => h.hour >= window.from && h.hour < window.to,
  );
  if (hours.length === 0) return null;
  const feels = hours.map((h) => h.feelsLike + offset);
  const min = Math.min(...feels);
  const max = Math.max(...feels);
  const middle = (min + max) / 2;
  const layer = torsoTarget(min) - torsoTarget(max) >= LAYER_STEPS;
  const rainFeels = hours
    .filter((h) => h.precipitationChance >= RAIN_CHANCE)
    .map((h) => h.feelsLike + offset);
  const rain = rainFeels.length > 0;
  return {
    occasion,
    window,
    feelsLike: { min, max },
    torso: torsoTarget(layer ? min : middle),
    torsoWithoutLayer: torsoTarget(layer ? max : middle),
    limbs: limbTarget(middle),
    limbsCeiling: limbCeiling(middle),
    layer,
    rain,
    umbrella: rain && Math.min(...rainFeels) > SHELL_CEILING,
  };
}

/**
 * `needs` for an owner whose `closet` holds what keeps them dry beside the
 * outfit (a water-resistant accessory, an umbrella among them, which the
 * generator never draws): a cool rainy day's water resistance becomes the
 * umbrella's too. ideasFor applies it over its pool, so the cards and the
 * advice agree; a closet without one keeps the requirement.
 */
export function withRainGear(
  needs: WeatherNeeds,
  closet: readonly MatchGarment[],
): WeatherNeeds {
  if (!needs.rain || needs.umbrella) return needs;
  const carried = closet.some((g) => g.rainGear);
  return carried ? { ...needs, umbrella: true } : needs;
}

/** The outfit itself must keep the rain off: rain the umbrella does not answer. */
export function needsWaterResistance(needs: WeatherNeeds): boolean {
  return needs.rain && !needs.umbrella;
}

/** A garment as the matching sees it: its role and the warmth it counts for. */
export interface MatchGarment {
  role: GarmentRole;
  /** 1-5: the garment's own, else its type's preset, else its role's middle. */
  warmth: Warmth;
  waterResistant: boolean;
  /**
   * Keeps rain off the wearer beside the outfit: a water-resistant hat or
   * cap (RAIN_GEAR_TYPES). A water-resistant watch or belt is not.
   */
  rainGear: boolean;
}

/** The garment columns matchGarment reads (a garment row has them all). */
export interface GarmentWeatherFields {
  category: string;
  type: string | null;
  fabricWeight: number | null;
  warmth: Warmth | null;
  waterResistant: boolean;
}

// An untagged garment of an untyped category counts as its role's usual
// weight: never 1 (a vest) nor 5 (a parka) by accident.
const ROLE_WARMTH: Readonly<Record<GarmentRole, Warmth>> = {
  top: 2,
  bottom: 2,
  'one-piece': 2,
  layer: 3,
  footwear: 2,
  accessory: 1,
  bag: 1,
  none: 1,
};

/** Accessory types that shed rain; there is no umbrella type yet. */
const RAIN_GEAR_TYPES: readonly string[] = ['hat', 'cap'];

/**
 * A garment for the matching. Nothing is required (plan section 6): an
 * unknown warmth is the type's preset (with its weight step: a 6 oz tee is
 * 3), else the role's usual.
 */
export function matchGarment(garment: GarmentWeatherFields): MatchGarment {
  const role = categoryRole(garment.category);
  return {
    role,
    warmth: garment.warmth ?? presetsFor(garment).warmth ?? ROLE_WARMTH[role],
    waterResistant: garment.waterResistant,
    rainGear:
      role === 'accessory' &&
      garment.waterResistant &&
      garment.type !== null &&
      RAIN_GEAR_TYPES.includes(garment.type),
  };
}

/** What is wrong with an outfit for the weather; none means it fits. */
export const FIT_PROBLEMS = [
  'too-cold',
  'too-warm',
  'needs-layer',
  'legs-too-cold',
  'legs-too-warm',
  'feet-too-cold',
  'feet-too-warm',
  'needs-water-resistance',
] as const;
export type FitProblem = (typeof FIT_PROBLEMS)[number];

export interface OutfitFit {
  fits: boolean;
  problems: FitProblem[];
  /**
   * 0 for a fit; otherwise how far off, in warmth steps (each missing layer
   * or water resistance counts MISSING_PENALTY; rain the umbrella answers
   * counts nothing). The generator sorts on it.
   */
  score: number;
  /** The torso's combined warmth with the layer on, and with it off. */
  torso: { withLayer: number; withoutLayer: number };
}

// How far each part may miss its target before it is a problem. Legs may
// run two steps warmer than the target (jeans in summer are common, shorts
// in the cold are not), feet one (sneakers in the heat are, suede boots are
// not); the torso has a layer to shed, so with one it may start warmer too.
// A layer may be one step warmer than the coolest hours ask of a layer over
// a tee, and at most LAYER_SPREAD steps warmer than what is under it.
const TOLERANCE = {
  torso: { below: 1, above: 1, aboveWithLayer: 2 },
  legs: { below: 1, above: 2 },
  feet: { below: 1, above: 1 },
  layer: { above: 1 },
} as const;
/**
 * What a tee counts for on the torso scale: the layer the coolest hours ask
 * for is their torso target less a tee under it (a jacket, 3, at 10 °C; a
 * parka, 5, from about 4 °C, and within the tolerance from about 8 °C).
 */
const TEE_WARMTH = 2;
/**
 * The most a layer may outweigh the top under it: a parka over a tee (3)
 * is a cold morning that warms up, a parka over a linen shirt (4) is two
 * seasons at once, cold whenever it is open or off.
 */
const LAYER_SPREAD = 3;
const MISSING_PENALTY = 2;
const TORSO_ROLES: readonly GarmentRole[] = ['top', 'one-piece'];
const LEG_ROLES: readonly GarmentRole[] = ['bottom', 'one-piece'];
// Where water resistance keeps you dry: a bag's does not.
const RAIN_ROLES: readonly GarmentRole[] = ['layer', 'footwear', 'accessory'];

/**
 * How `garments` (an outfit, a candidate combination) answer `needs`. The
 * torso's warmth is its tops and one-piece plus its layers; legs are the
 * warmest bottom or one-piece, feet the footwear. A part the outfit lacks
 * (no footwear chosen yet) is not judged: the generator fills roles, this
 * judges what is there.
 */
export function assessOutfit(
  needs: WeatherNeeds,
  garments: readonly MatchGarment[],
): OutfitFit {
  const warmthOf = (roles: readonly GarmentRole[]) =>
    garments
      .filter((g) => roles.includes(g.role))
      .reduce((sum, g) => sum + g.warmth, 0);
  const withoutLayer = warmthOf(TORSO_ROLES);
  const layerWarmths = garments
    .filter((g) => g.role === 'layer')
    .map((g) => g.warmth);
  const hasLayer = layerWarmths.length > 0;
  const withLayer = withoutLayer + layerWarmths.reduce((a, b) => a + b, 0);
  const warmestLayer = Math.max(0, ...layerWarmths);

  const problems: FitProblem[] = [];
  let score = 0;
  const miss = (problem: FitProblem, by: number) => {
    problems.push(problem);
    score += by;
  };

  // Without a top or one-piece there is no torso to judge yet.
  if (garments.some((g) => TORSO_ROLES.includes(g.role))) {
    const cold = needs.torso - TOLERANCE.torso.below - withLayer;
    const aboveLimit = hasLayer
      ? TOLERANCE.torso.aboveWithLayer
      : TOLERANCE.torso.above;
    // Too warm with the layer on at the coolest hours, or with it off at
    // the warmest.
    const warm = Math.max(
      withLayer - (needs.torso + aboveLimit),
      withoutLayer - (needs.torsoWithoutLayer + TOLERANCE.torso.above),
    );
    // The sum alone reads a parka over a linen shirt (5 + 1) as a jacket
    // over a sweater (3 + 3): the layer is judged on its own too. Too warm
    // when the coolest hours ask for less of a layer; too cold when the top
    // under it is far lighter (open or off, it is summer's).
    const layerTooWarm =
      warmestLayer -
      (torsoTarget(needs.feelsLike.min) - TEE_WARMTH + TOLERANCE.layer.above);
    const layerOverTop = hasLayer
      ? warmestLayer - withoutLayer - LAYER_SPREAD
      : 0;
    const tooCold = Math.max(cold, 0) + Math.max(layerOverTop, 0);
    const tooWarm = Math.max(warm, 0) + Math.max(layerTooWarm, 0);
    if (tooCold > 0) miss('too-cold', tooCold);
    if (tooWarm > 0) miss('too-warm', tooWarm);
  }
  if (needs.layer && !hasLayer) miss('needs-layer', MISSING_PENALTY);

  // Dressed for moving (ActiveDemand): running shorts and shoes at 0 °C are
  // what a run wears, so legs and feet are judged only too warm. Below
  // COLD_SNAP the floor is back: full-length bottoms, not running shorts.
  const coldFloor =
    !OCCASION_HINTS[needs.occasion].active || needs.feelsLike.min < COLD_SNAP;
  const limb = (
    roles: readonly GarmentRole[],
    tolerance: { below: number; above: number },
    cold: FitProblem,
    warm: FitProblem,
  ) => {
    const worn = garments.filter((g) => roles.includes(g.role));
    if (worn.length === 0) return;
    const warmth = Math.max(...worn.map((g) => g.warmth));
    const below = needs.limbs - tolerance.below - warmth;
    const above = warmth - (needs.limbsCeiling + tolerance.above);
    if (coldFloor && below > 0) miss(cold, below);
    if (above > 0) miss(warm, above);
  };
  limb(LEG_ROLES, TOLERANCE.legs, 'legs-too-cold', 'legs-too-warm');
  limb(['footwear'], TOLERANCE.feet, 'feet-too-cold', 'feet-too-warm');

  if (
    needsWaterResistance(needs) &&
    !garments.some((g) => g.waterResistant && RAIN_ROLES.includes(g.role))
  ) {
    miss('needs-water-resistance', MISSING_PENALTY);
  }

  return {
    fits: problems.length === 0,
    problems,
    score,
    torso: { withLayer, withoutLayer },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
