import { seededRandom } from '../random';
import {
  assessOutfit,
  FIT_PROBLEMS,
  isActivewearFor,
  type MatchGarment,
  type WeatherNeeds,
} from '../weather/match';
import {
  type AlwaysCheck,
  alwaysCheck,
  avoidedPairRule,
  type CompiledRules,
  compileRules,
  type OutfitRule,
  type RuleGarment,
} from './outfit-rules';
import type { ActiveDemand } from './occasions';
import {
  categoryRole,
  type Formality,
  type GarmentColor,
  type GarmentRole,
  isDrawnType,
} from './properties';

/**
 * The outfit generator (#9; docs/plans/2026-09-26-wardrobe-features.md,
 * section 3; the redesign's "Suggest", docs/plans/2026-09-26-redesign.md
 * section 1): whole outfits from a pool of garments, seeded and paged. Pure
 * and the one place suggestion rules live. Its callers:
 * - the Outfits page's Ideas (src/web/gallery), through ideasFor, which
 *   reads the pool, the weather and the owner's rows;
 * - the MCP tool suggest_outfits (src/web/mcp/tools/gallery.ts);
 * - "Goes with my closet" (#18b, src/wardrobe/goes-with.ts): the whole
 *   closet as the pool and one wishlist item `locked`;
 * - Styling's Shuffle (#42, src/web/styling): its locked rows are
 *   `locked`, the unlocked rows take the first idea; Today's suggestions
 *   (#15: a day's occasion, a page of 3).
 *
 * The caller decides the pool: garments in the closet and available
 * (isAvailable / availableGarment, src/wardrobe/availability.ts: not
 * dirty, not away), within a capsule when one is chosen. The generator
 * never widens it. What it decides:
 * - Templates: top + bottom + footwear, or one-piece + footwear; footwear
 *   only when the closet has some (a first-week wardrobe of tees and jeans
 *   still gets ideas). A layer only when the weather asks for one (or it is
 *   locked). Accessories, bags and uncategorised garments are never drawn;
 *   locked, they ride along.
 * - Rotation: each role is drawn weighted toward the garment worn least
 *   recently (days since its last wear day; never worn weighs most), so the
 *   gallery rotates the wardrobe instead of showing the favourites.
 * - Hard rules, never relaxed: at most MAX_ACCENT_COLORS non-neutral
 *   colours and MAX_LOUD_PATTERNS patterned garment; the owner's outfit
 *   rules (outfit-rules.ts: never A with B, always B with A, the avoided
 *   pairs of generator_avoid among the never-rules); no combination equal
 *   to a saved outfit (compared on the drawn roles, so a saved outfit with
 *   a belt still counts); every locked garment in every idea; for an
 *   occasion dressed for moving (`active`, OCCASION_HINTS: a workout) its
 *   roles filled with activewear (GarmentType.purpose), or no idea at all
 *   (the soft rules spare its legs' cold floor and its layer's
 *   formality: ActiveDemand). A never-rule
 *   the locked garments break among themselves does not empty the ideas:
 *   each is flagged 'breaks-rule', naming it (brokenRules).
 * - Soft rules, a score: the weather (assessOutfit, src/weather/match.ts)
 *   and the occasion's formality (OCCASION_HINTS, one step per garment
 *   outside the range). Ideas that fit (score 0) come first in draw order;
 *   once the draws run out, the near misses follow, best first, each with
 *   its problems named.
 *
 * Paging is stable: the draws are a sequence keyed by the seed, so page n
 * is the same every time it is asked for (for the same pool), and page 1
 * never changes when page 3 is read. Nothing is materialized: a closet of
 * 40 tops, 20 bottoms and 10 shoes is sampled, at most MAX_DRAWS draws a
 * page.
 */

/** Bump to reshuffle every seed's ideas on purpose. */
const GENERATOR_VERSION = 5;

/** Draws per page request: bounds the work on a closet with few combinations. */
export const MAX_DRAWS = 2000;

/** Colours that go with anything, on any garment. */
export const NEUTRAL_COLORS: readonly GarmentColor[] = [
  'black',
  'white',
  'grey',
  'beige',
  'brown',
];

/**
 * Whether `color` on a garment of `role` is a neutral for the colour rule:
 * the NEUTRAL_COLORS everywhere, and blue on bottoms too (owner, #9 review:
 * jeans and navy chinos go with anything, and counting them spent one of
 * the two colour slots on nearly every casual outfit). A blue top or layer
 * still counts as a colour. The one place this is decided.
 */
export function neutralFor(role: GarmentRole, color: GarmentColor): boolean {
  return (
    NEUTRAL_COLORS.includes(color) || (role === 'bottom' && color === 'blue')
  );
}
export const MAX_ACCENT_COLORS = 2;
const MAX_LOUD_PATTERNS = 1;

/** Days unworn from which a garment is "rested" (the card says so). */
export const REST_DAYS = 21;
// Rotation weight: 1 for a garment worn today, rising by one every
// ROTATION_STEP days unworn, up to ROTATION_CAP days (never worn is the cap).
const ROTATION_CAP = 60;
const ROTATION_STEP = 10;

/**
 * The roles the generator draws. Others only arrive locked, so Styling's
 * Shuffle (#42) leaves its unlocked accessory and bag rows as they are.
 */
export const DRAWN_ROLES: readonly GarmentRole[] = [
  'layer',
  'one-piece',
  'top',
  'bottom',
  'footwear',
];

/** How an outfit reads, top to toe: the order of an idea's garments and of a picked outfit's slots. */
export const OUTFIT_ORDER: readonly GarmentRole[] = [
  'layer',
  'one-piece',
  'top',
  'bottom',
  'footwear',
  'accessory',
  'bag',
  'none',
];

/** Garments as an outfit's slots and name list them: top to toe (OUTFIT_ORDER), the given order among equals. */
export function inOutfitOrderByCategory<G extends { category: string }>(
  garments: readonly G[],
): G[] {
  const rank = (g: G) => OUTFIT_ORDER.indexOf(categoryRole(g.category));
  return [...garments].sort((a, b) => rank(a) - rank(b));
}

/** A role's share of a list, as `topToToe` groups it. */
export interface RoleGroup<T> {
  role: GarmentRole;
  items: T[];
}

/**
 * `items` grouped by their category's role (categoryRole), the groups top
 * to toe (OUTFIT_ORDER, custom categories last as `none`), each keeping
 * the items' order; empty roles left out. A trip's packing list reads a
 * list this way.
 */
export function topToToe<T>(
  items: readonly T[],
  categoryOf: (item: T) => string,
): RoleGroup<T>[] {
  const byRole = new Map<GarmentRole, T[]>();
  for (const item of items) {
    const role = categoryRole(categoryOf(item));
    const group = byRole.get(role);
    if (group) group.push(item);
    else byRole.set(role, [item]);
  }
  return OUTFIT_ORDER.flatMap((role) => {
    const group = byRole.get(role);
    return group ? [{ role, items: group }] : [];
  });
}

/**
 * A garment as the generator judges it: what the rules read (RuleGarment;
 * the colour 'pattern' marks a patterned garment), its formality, its
 * weather and its rest.
 */
export interface IdeaGarment extends RuleGarment {
  formality: Formality | null;
  /** How it counts for the weather (matchGarment, src/weather/match.ts). */
  weather: MatchGarment;
  /** Whole days since the last day it was worn; null when never. */
  idleDays: number | null;
}

/** A saved outfit's garments, as the duplicate rule compares them. */
export type SavedOutfit = readonly { id: number; role: GarmentRole }[];

/**
 * `G` is the caller's garment (IdeaGarment plus whatever its view needs:
 * a name, a photo); the ideas hand back the very objects of the pool.
 */
export interface IdeaRequest<G extends IdeaGarment = IdeaGarment> {
  seed: number;
  /** Garments the generator may draw (the caller filters availability and scope). */
  pool: readonly G[];
  /** In every idea: `?with=`, Styling's locked rows, #18b's wishlist item. */
  locked?: readonly G[];
  /** What the day's weather asks for the occasion; null without a forecast. */
  needs?: WeatherNeeds | null;
  /** The occasion's formality range; null for any. */
  formality?: { min: Formality; max: Formality } | null;
  /** The occasion is dressed for moving (ActiveDemand); null for everyday wear. */
  active?: ActiveDemand | null;
  /** Garment pairs never to combine (generator_avoid): never-rules beside `rules`. */
  avoid?: readonly (readonly [number, number])[];
  /** The owner's outfit rules (outfit_rule); none over a share. */
  rules?: readonly OutfitRule[];
  saved?: readonly SavedOutfit[];
  offset: number;
  limit: number;
}

/** 'breaks-rule': the locked garments break an outfit rule (Idea.brokenRules says which). */
/** Every problem an idea may name: the API's enum lists them (gallery/idea-resource.ts). */
export const IDEA_PROBLEMS = [
  ...FIT_PROBLEMS,
  'too-casual',
  'too-dressy',
  'breaks-rule',
] as const;
export type IdeaProblem = (typeof IDEA_PROBLEMS)[number];

export interface Idea<G extends IdeaGarment = IdeaGarment> {
  /** In OUTFIT_ORDER. */
  garments: G[];
  /** 0: fits the weather and the occasion. */
  score: number;
  problems: IdeaProblem[];
  /** The never-rules the locked garments break among themselves (every idea holds them); empty without. */
  brokenRules: OutfitRule[];
  /** Garments unworn REST_DAYS or more (or never): what the rotation brought back. */
  rested: number[];
}

export interface IdeaPage<G extends IdeaGarment = IdeaGarment> {
  ideas: Idea<G>[];
  /** Another page follows. */
  more: boolean;
}

interface Template {
  roles: GarmentRole[];
  weight: number;
}

export function generateIdeas<G extends IdeaGarment>(
  request: IdeaRequest<G>,
): IdeaPage<G> {
  const locked = request.locked ?? [];
  const lockedIds = new Set(locked.map((g) => g.id));
  const lockedRoles = new Set(locked.map((g) => g.role));
  const active = request.active ?? null;
  const byRole = drawableByRole(request.pool, locked, active, request.needs);
  const templates = templatesFor(byRole, lockedRoles, active);
  const rules = compileRules(rulesOf(request));
  const compatible = compatibleWith(rules, lockedIds);
  // Every idea holds the locked garments, and a garment added never mends a
  // broken colour or pattern rule: locks that break one can make no idea,
  // however long drawn. A never-rule the locks break among themselves is
  // not judged here: it flags every idea instead (brokenRules).
  if (templates.length === 0 || !compatible(locked)) {
    return { ideas: [], more: false };
  }
  // What can be in an idea with the locks at all: a garment that breaks a
  // rule beside them breaks it in every idea. Drawn all the same (the
  // draws pick by position in byRole, so the sequence stays the seed's),
  // but neither counted among the bases nor offered as a layer or a mend.
  const viable = viableByRole(byRole, (g) => compatible([...locked, g]));
  const bases = baseCount(templates, viable, lockedRoles);
  if (bases === 0) return { ideas: [], more: false };

  // A layer only when the weather asks (and none is locked).
  const layersOffered = Boolean(request.needs) && !lockedRoles.has('layer');
  const always = alwaysCheck<G>(rules.always, {
    drawable: viable,
    lockedIds,
    layersOffered,
    compatible,
  });
  const placeOf = placeKeyer(byRole, locked);
  const layers = layersOffered ? (viable.get('layer') ?? []) : [];
  // Weighed and sorted into kinds once per request, not per base judged.
  const layerWeights = layers.map(rotationWeight);
  const places = layers.map((_, n) => n);
  return drawPage(request, {
    outfits: outfitsOf(
      drawer(request.seed, templates, byRole, locked),
      new Set([...lockedIds, ...[...viable.values()].flat().map((g) => g.id)]),
      repairer(request.seed, always, placeOf),
    ),
    bases,
    floor: scoreFloor(templates, viable, locked, lockedRoles, request),
    layers: {
      offered: layers,
      ...layerKinds(layers),
      // The order by place in `offered`: the same sequence as of the
      // layers themselves (rotationOrder reads only the weights).
      orderFor: (base) =>
        rotationOrder(
          places,
          layerWeights,
          'generator-layer',
          request.seed,
          placeOf(base),
        ),
    },
    rules: hardRules(request, compatible, always, rules.brokenAmong(locked)),
  });
}

/** The owner's rules, then the avoided pairs as never-rules: one list (outfit-rules.ts). */
function rulesOf(request: IdeaRequest<IdeaGarment>): OutfitRule[] {
  return [
    ...(request.rules ?? []),
    ...(request.avoid ?? []).map(([a, b]) => avoidedPairRule(a, b)),
  ];
}

/** generateIdeas' draws: until the page is settled, then the page. */
function drawPage<G extends IdeaGarment>(
  request: IdeaRequest<G>,
  {
    outfits,
    bases,
    floor,
    layers,
    rules,
  }: {
    outfits: Outfits<G>;
    bases: number;
    floor: number;
    layers: Layers<G>;
    rules: HardRules<G>;
  },
): IdeaPage<G> {
  const want = request.offset + request.limit + 1;
  const fitting: Idea<G>[] = [];
  const nearMisses: Idea<G>[] = [];
  let atFloor = 0;
  // The page is settled, and drawing stops, once `want` ideas score the
  // floor: no later draw scores lower, and one that ties ranks after them
  // (ideas that fit keep draw order; near misses sort stably). With a floor
  // of 0 those are the ideas that fit. Past `bases` distinct viable draws
  // every further draw is a repeat or holds a garment no idea can, skipped.
  // Either way the page is the one MAX_DRAWS would give, sooner.
  for (
    let n = 0;
    n < MAX_DRAWS && atFloor < want && outfits.distinct() < bases;
    n += 1
  ) {
    const outfit = outfits.next();
    const idea = outfit && bestIdea(outfit, layers, request, rules);
    if (!idea) continue;
    (idea.score === 0 ? fitting : nearMisses).push(idea);
    if (idea.score === floor) atFloor += 1;
  }
  return pageOf(fitting, nearMisses, request);
}

/** The draws as outfits to judge (outfitsOf). */
interface Outfits<G> {
  /** The next outfit to judge; undefined for a draw to skip. */
  next(): G[] | undefined;
  /** Distinct viable bases drawn so far: what `bases` counts. */
  distinct(): number;
}

/**
 * Each draw once, as an outfit to judge: a base already drawn, or holding
 * a garment no idea with the locks can (outside `allowed`), is skipped;
 * the rest are mended (repairer), and an outfit a mend made of another
 * base is judged once too. A base is mended the same way every time it is
 * drawn, so skipping its repeats loses nothing.
 */
function outfitsOf<G extends IdeaGarment>(
  draw: () => G[],
  allowed: ReadonlySet<number>,
  repair: (base: G[]) => G[],
): Outfits<G> {
  const drawn = new Set<string>();
  const judged = new Set<string>();
  return {
    distinct: () => drawn.size,
    next: () => {
      const base = draw();
      const key = keyOf(base);
      if (drawn.has(key) || !base.every((g) => allowed.has(g.id))) {
        return undefined;
      }
      drawn.add(key);
      const outfit = repair(base);
      const outfitKey = outfit === base ? key : keyOf(outfit);
      if (judged.has(outfitKey)) return undefined;
      judged.add(outfitKey);
      return outfit;
    },
  };
}

/**
 * The always-rules' one repair step (the plan's section 2): a base holding
 * a garment that asks for another and none answering gets one in the slot
 * of the answer's role, before it is judged; each broken rule in turn,
 * once. Of the swaps alwaysCheck offers (each breaking no colour, pattern
 * or never-rule), one by rotation weight from a sequence keyed by the
 * seed, the base and the rule, so a base is mended the same way however
 * often it is drawn. A rule only a layer answers is left to bestIdea's
 * layers; one no compatible swap answers is moot (alwaysCheck).
 */
function repairer<G extends IdeaGarment>(
  seed: number,
  always: AlwaysCheck<G>,
  placeOf: (garments: readonly G[]) => string,
): (base: G[]) => G[] {
  return (base) => {
    let outfit = base;
    let unmet = always.unmet(outfit, 0);
    while (unmet) {
      // A base has no layer slot: bestIdea adds layers.
      const kept = unmet.swaps.filter((swap) => swap.mender.role !== 'layer');
      if (kept.length > 0) {
        const [mend] = rotationOrder(
          kept,
          kept.map((swap) => rotationWeight(swap.mender)),
          'generator-repair',
          seed,
          placeOf(outfit),
          unmet.index,
        );
        outfit = mend.outfit;
      }
      unmet = always.unmet(outfit, unmet.index + 1);
    }
    return outfit;
  };
}

/** byRole without what `fits` refuses: the garments an idea with the locks can hold. */
function viableByRole<G extends IdeaGarment>(
  byRole: Map<GarmentRole, G[]>,
  fits: (garment: G) => boolean,
): Map<GarmentRole, G[]> {
  return new Map(
    [...byRole].map(([role, garments]) => [role, garments.filter(fits)]),
  );
}

/**
 * The lowest score any idea can reach: its formality misses, since those
 * add up garment by garment (formalityMiss) and the weather's part is never
 * below 0. The locked garments' misses plus, per template, the smallest
 * miss each open role offers. Above 0 when no idea can fit: the locks
 * already miss the range ("Goes with my closet" locks a wishlist item and
 * asks for its own formality, and a layer of another formality can never
 * make it), or a role has nothing within it.
 */
function scoreFloor(
  templates: readonly Template[],
  byRole: Map<GarmentRole, readonly IdeaGarment[]>,
  locked: readonly IdeaGarment[],
  lockedRoles: Set<GarmentRole>,
  request: IdeaRequest<IdeaGarment>,
): number {
  if (!request.formality) return 0;
  const miss = (g: IdeaGarment) =>
    formalityMiss(g, formalityRangeFor(g, request));
  const missOf = (garments: readonly IdeaGarment[]) =>
    garments.reduce((sum, g) => sum + miss(g), 0);
  const leastMiss = (role: GarmentRole) =>
    Math.min(...(byRole.get(role) ?? []).map(miss));
  return (
    missOf(locked) +
    Math.min(
      ...templates.map((template) =>
        template.roles
          .filter((role) => !lockedRoles.has(role))
          .reduce((sum, role) => sum + leastMiss(role), 0),
      ),
    )
  );
}

/**
 * The formality range a garment is judged against: the request's, except
 * that a layer is free for an occasion dressed for moving (ActiveDemand: a
 * cold run's jacket). judge and scoreFloor both read it, or the floor stops
 * bounding the scores.
 */
function formalityRangeFor(
  { role }: Pick<IdeaGarment, 'role'>,
  request: Pick<IdeaRequest, 'formality' | 'active'>,
): IdeaRequest['formality'] {
  return request.active && role === 'layer' ? null : request.formality;
}

/** Formality steps a garment sits below and above the range (0 without either). */
function formalityMisses(
  { formality }: Pick<IdeaGarment, 'formality'>,
  range: IdeaRequest['formality'],
): { casual: number; dressy: number } {
  if (formality === null || !range) return { casual: 0, dressy: 0 };
  return {
    casual: Math.max(0, range.min - formality),
    dressy: Math.max(0, formality - range.max),
  };
}

function formalityMiss(
  garment: Pick<IdeaGarment, 'formality'>,
  range: IdeaRequest['formality'],
): number {
  const { casual, dressy } = formalityMisses(garment, range);
  return casual + dressy;
}

/**
 * How many distinct bases the templates can draw: per template, the
 * product of its open roles' garments. Templates never share a base (their
 * roles differ), and a role's garments are distinct, so this is the count
 * of distinct keys the draws can reach.
 */
function baseCount(
  templates: readonly Template[],
  byRole: Map<GarmentRole, readonly IdeaGarment[]>,
  lockedRoles: Set<GarmentRole>,
): number {
  return templates.reduce(
    (sum, template) =>
      sum +
      template.roles.reduce(
        (product, role) =>
          lockedRoles.has(role)
            ? product
            : product * (byRole.get(role)?.length ?? 0),
        1,
      ),
    0,
  );
}

/**
 * The requested page: the ideas that fit in draw order, then (only when
 * the draws ran out before the page filled) the near misses, best first.
 */
function pageOf<G extends IdeaGarment>(
  fitting: Idea<G>[],
  nearMisses: Idea<G>[],
  { offset, limit }: { offset: number; limit: number },
): IdeaPage<G> {
  const end = offset + limit;
  // Sort is stable: equal scores keep their draw order.
  const ranked =
    fitting.length > end
      ? fitting
      : [...fitting, ...nearMisses.sort((a, b) => a.score - b.score)];
  return { ideas: ranked.slice(offset, end), more: ranked.length > end };
}

/**
 * The pool by role: only the roles drawn, never a type no outfit is drawn
 * with (socks, swimwear: isDrawnType; one still rides along locked), never
 * an everyday garment in a role an active occasion keeps for activewear
 * (ActiveDemand; a locked one rides along: the person chose it; in a cold
 * snap, bottoms too light for it: isActivewearFor), and never
 * a locked garment twice.
 * Each role's garments in id order, whatever order the pool came in: the
 * draws pick by position, and a pool is a query's rows, whose order
 * Postgres does not promise without ORDER BY (it follows the heap and the
 * plan, which a reseed, an update or an index choice changes). Ordered
 * here, the ideas are a function of the pool as a set; ids keep their
 * relative order across a reseed, which inserts in the same order.
 */
function drawableByRole<G extends IdeaGarment>(
  pool: readonly G[],
  locked: readonly G[],
  active: ActiveDemand | null,
  needs: WeatherNeeds | null | undefined,
): Map<GarmentRole, G[]> {
  const lockedIds = new Set(locked.map((g) => g.id));
  const everyday = (garment: G) =>
    active !== null &&
    active.roles.includes(garment.role) &&
    !isActivewearFor(needs, garment);
  const byRole = new Map<GarmentRole, G[]>();
  for (const garment of [...pool].sort((a, b) => a.id - b.id)) {
    if (
      lockedIds.has(garment.id) ||
      !DRAWN_ROLES.includes(garment.role) ||
      !isDrawnType(garment.category, garment.type) ||
      everyday(garment)
    ) {
      continue;
    }
    const role = byRole.get(garment.role);
    if (role) role.push(garment);
    else byRole.set(garment.role, [garment]);
  }
  return byRole;
}

/**
 * The seed's sequence of bases: a template by weight, then each of its
 * roles the locks leave open, by rotation weight.
 */
function drawer<G extends IdeaGarment>(
  seed: number,
  templates: readonly Template[],
  byRole: Map<GarmentRole, G[]>,
  locked: readonly G[],
): () => G[] {
  const random = seededRandom('generator', GENERATOR_VERSION, seed);
  const templateWeights = templates.map((template) => template.weight);
  const lockedRoles = new Set(locked.map((g) => g.role));
  // Weighed once, not on every draw: a garment's weight never changes
  // within a request.
  const weights = new Map(
    [...byRole].map(([role, choices]) => [role, choices.map(rotationWeight)]),
  );
  return () => {
    const template = templates[random.weighted(templateWeights)];
    const base = [...locked];
    for (const role of template.roles) {
      if (lockedRoles.has(role)) continue;
      // templatesFor offers a role only when the pool has some.
      const choices = byRole.get(role)!;
      base.push(choices[random.weighted(weights.get(role)!)]);
    }
    return base;
  };
}

/**
 * Which templates the pool (and the locks) can fill, each weighted by its
 * anchor garments, so a closet of five dresses and ten tops sees dresses a
 * third of the time. A locked garment of a template's role makes it the
 * only one.
 */
function templatesFor(
  byRole: Map<GarmentRole, readonly IdeaGarment[]>,
  lockedRoles: Set<GarmentRole>,
  active: ActiveDemand | null,
): Template[] {
  // An active occasion's roles are required: a template without one of
  // them (a dress; no shoes when the closet has no running shoes) is no
  // workout outfit, so none is left and the request has no idea.
  const templates = everydayTemplates(byRole, lockedRoles);
  return active
    ? templates.filter((template) =>
        active.roles.every((role) => template.roles.includes(role)),
      )
    : templates;
}

function everydayTemplates(
  byRole: Map<GarmentRole, readonly IdeaGarment[]>,
  lockedRoles: Set<GarmentRole>,
): Template[] {
  const count = (role: GarmentRole) => byRole.get(role)?.length ?? 0;
  const has = (role: GarmentRole) => lockedRoles.has(role) || count(role) > 0;
  const footwear: GarmentRole[] = has('footwear') ? ['footwear'] : [];
  const templates: Template[] = [];
  const lockedSeparates = lockedRoles.has('top') || lockedRoles.has('bottom');
  const lockedOnePiece = lockedRoles.has('one-piece');
  if (!lockedOnePiece && has('top') && has('bottom')) {
    templates.push({
      roles: ['top', 'bottom', ...footwear],
      weight: lockedSeparates ? 1 : count('top'),
    });
  }
  if (!lockedSeparates && has('one-piece')) {
    templates.push({
      roles: ['one-piece', ...footwear],
      weight: lockedOnePiece ? 1 : count('one-piece'),
    });
  }
  return templates;
}

/**
 * `choices` in a seeded rotation order, lazily: each next one drawn by its
 * rotation weight (`choiceWeights`, parallel to `choices`) from what is left, from a sequence keyed by
 * `key` (its purpose, then what the choice is for: the seed and the base),
 * so the same order comes out however often it is asked for. Of any subset
 * (the layers that fit), the first in the order is each one as often as
 * its weight says, which is how the drawer picks every role. The
 * repairer's mends take the first; bestIdea tries its layers in it and
 * stops at the first that fits, so the rest are never drawn.
 */
function* rotationOrder<T>(
  choices: readonly T[],
  choiceWeights: readonly number[],
  purpose: string,
  ...key: (string | number)[]
): Generator<T, undefined, undefined> {
  // Nothing to order (no layers offered without a forecast): no sequence to key.
  if (choices.length === 0) return undefined;
  const random = seededRandom(purpose, GENERATOR_VERSION, ...key);
  const left = [...choices];
  const weights = [...choiceWeights];
  while (left.length > 0) {
    const n = random.weighted(weights);
    weights.splice(n, 1);
    yield left.splice(n, 1)[0];
  }
  return undefined;
}

/** How strongly a garment is drawn: rested ones most. Also recreate.ts' last tie-break. */
export function rotationWeight(garment: Pick<IdeaGarment, 'idleDays'>): number {
  const idle = Math.min(garment.idleDays ?? ROTATION_CAP, ROTATION_CAP);
  return 1 + idle / ROTATION_STEP;
}

/** A combination's identity: its garment ids, sorted. */
export function keyOf(garments: readonly { id: number }[]): string {
  return garments
    .map((g) => g.id)
    .sort((a, b) => a - b)
    .join(',');
}

/**
 * A combination's identity for keying a sequence: each garment's place in
 * its role (byRole, in id order) or among the locks, never its id. A
 * reseed (`seed --reset`) gives every garment a new id in the same
 * relative order, so the places, and the sequences keyed by them, stay the
 * same: the ideas are a function of the pool as a set, as the drawer's
 * draws by position are.
 */
export function placeKeyer<G extends IdeaGarment>(
  byRole: Map<GarmentRole, readonly G[]>,
  locked: readonly G[],
): (garments: readonly G[]) => string {
  const places = new Map<number, string>();
  [...locked]
    .sort((a, b) => a.id - b.id)
    .forEach((g, n) => places.set(g.id, `locked${n}`));
  for (const [role, garments] of byRole) {
    garments.forEach((g, n) => places.set(g.id, `${role}${n}`));
  }
  return (garments) =>
    garments
      .map((g) => {
        const place = places.get(g.id);
        if (place === undefined) {
          throw new Error(
            `placeKeyer: garment ${g.id} is in neither the drawable pool nor the locks`,
          );
        }
        return place;
      })
      .sort()
      .join(',');
}

/** The part of an outfit the generator draws: what "equal to a saved outfit" compares. */
function drawnKey(garments: readonly { id: number; role: GarmentRole }[]) {
  return keyOf(garments.filter((g) => DRAWN_ROLES.includes(g.role)));
}

type HardRule<G extends IdeaGarment = IdeaGarment> = (
  garments: readonly G[],
) => boolean;

interface HardRules<G extends IdeaGarment> {
  /**
   * The colour, pattern and never-rules (compatibleWith): a garment added
   * never mends one they break (colours and patterns only add up, a
   * clashing pair stays), so what fails here fails with anything added to
   * it.
   */
  compatible: HardRule;
  /**
   * compatible, not equal to a saved outfit, and keeping every always-rule
   * that can be kept: a layer can change either, so they are judged last.
   */
  passes: HardRule<G>;
  /** The never-rules the locks break among themselves: each idea is flagged with them. */
  lockBroken: readonly OutfitRule[];
}

/**
 * The colour and pattern rules, and no two garments breaking a never-rule
 * together, unless both are locked: the person chose those, so the rule
 * flags the ideas rather than emptying them.
 */
function compatibleWith(
  rules: CompiledRules,
  lockedIds: ReadonlySet<number>,
): HardRule {
  const pairBreaks = (a: IdeaGarment, b: IdeaGarment) =>
    !(lockedIds.has(a.id) && lockedIds.has(b.id)) && rules.clash(a, b);
  return (garments) =>
    colorsGoTogether(garments) &&
    !garments.some((a, i) =>
      garments.slice(i + 1).some((b) => pairBreaks(a, b)),
    );
}

function hardRules<G extends IdeaGarment>(
  request: IdeaRequest<G>,
  compatible: HardRule,
  always: AlwaysCheck<G>,
  lockBroken: readonly OutfitRule[],
): HardRules<G> {
  const saved = new Set((request.saved ?? []).map(drawnKey));
  return {
    compatible,
    passes: (garments) =>
      compatible(garments) &&
      !saved.has(drawnKey(garments)) &&
      always.holds(garments),
    lockBroken,
  };
}

function isLoud(garment: Pick<IdeaGarment, 'pattern' | 'colors'>) {
  return (
    (garment.pattern !== null && garment.pattern !== 'solid') ||
    garment.colors.includes('pattern')
  );
}

/**
 * At most MAX_ACCENT_COLORS colours beyond the neutrals (neutralFor: blue
 * bottoms included), however many garments carry each, and at most MAX_LOUD_PATTERNS patterned garment
 * (stripes included: a Breton and a plaid do not go).
 */
export function colorsGoTogether(
  garments: readonly Pick<IdeaGarment, 'role' | 'pattern' | 'colors'>[],
): boolean {
  const accents = new Set(
    garments.flatMap((g) =>
      g.colors.filter((c) => c !== 'pattern' && !neutralFor(g.role, c)),
    ),
  );
  const loud = garments.filter(isLoud).length;
  return accents.size <= MAX_ACCENT_COLORS && loud <= MAX_LOUD_PATTERNS;
}

/**
 * The layers offered (none without a forecast), each one's kind (an index
 * into `kinds`, one layer of each), and the order a base tries them in, as
 * places in `offered`.
 */
interface Layers<G> extends LayerKinds<G> {
  offered: readonly G[];
  orderFor: (base: readonly G[]) => Iterable<number>;
}

/**
 * Layers by what of them an option's score reads (judge: assessOutfit's
 * warmth, water resistance and rain gear, and the formality): over one
 * base, layers of one kind score alike.
 */
interface LayerKinds<G> {
  kindOf: readonly number[];
  kinds: readonly G[];
}

function layerKinds<G extends IdeaGarment>(
  layers: readonly G[],
): LayerKinds<G> {
  const index = new Map<string, number>();
  const kinds: G[] = [];
  const kindOf = layers.map((layer) => {
    const { warmth, waterResistant, rainGear } = layer.weather;
    const key = `${warmth}/${waterResistant}/${rainGear}/${layer.formality}`;
    let kind = index.get(key);
    if (kind === undefined) {
      kind = kinds.push(layer) - 1;
      index.set(key, kind);
    }
    return kind;
  });
  return { kindOf, kinds };
}

interface Option<G> {
  garments: G[];
  score: number;
  problems: IdeaProblem[];
}

/**
 * The drawn base with its best layer (or none): of the options that pass
 * the hard rules, the lowest score (the weather and the formality), and
 * among equals no layer, then the layers in the base's rotation order
 * (rotationOrder, keyed by the seed and the base): so among the layers
 * tied best, each is chosen as often as its rotation weight says, as every
 * other role is drawn (#646: one global preference, the most rested first,
 * put one coat on every card). Deterministic for a base, so a base is one
 * idea however often it is drawn. Undefined when no option passes the
 * hard rules.
 *
 * Shortcuts that cannot change the answer: a base that breaks a colour,
 * pattern or clash rule on its own is never scored (no layer mends it). A
 * layer's option is scored once per kind of layer (layerKinds: its score
 * reads nothing else of it), so a closet of 45 layers costs a handful of
 * scores, not 45. Then the scores are tried lowest first, the bare base
 * before the layers at each, and only as much of the rotation order is
 * drawn as it takes to meet a passing layer of that score (#996: drawing
 * the whole order for every base was most of a deep page's cost, as at
 * 500 garments most bases have no layer that fits).
 */
function bestIdea<G extends IdeaGarment>(
  base: readonly G[],
  layers: Layers<G>,
  request: IdeaRequest<G>,
  rules: HardRules<G>,
): Idea<G> | undefined {
  if (!rules.compatible(base)) return undefined;
  const bare: Option<G> = { garments: [...base], ...judge(base, request) };
  if (bare.score === 0 && rules.passes(bare.garments)) {
    return ideaOf(bare, rules.lockBroken);
  }
  // Each kind of layer judged once over this base.
  const judged = layers.kinds.map((layer) => judge([...base, layer], request));
  const layerScores = new Set(judged.map((option) => option.score));
  const scores = [...new Set([bare.score, ...layerScores])].sort(
    (a, b) => a - b,
  );
  // Drawn only as far as a score's search needs, and kept for the next's.
  const order = lazily(layers.orderFor(base));
  for (const score of scores) {
    // A bare base scoring 0 was tried above.
    if (bare.score === score && score !== 0 && rules.passes(bare.garments)) {
      return ideaOf(bare, rules.lockBroken);
    }
    const layered = layerScores.has(score)
      ? firstLayerAt(score, { base, layers, judged, order, rules })
      : undefined;
    if (layered) return ideaOf(layered, rules.lockBroken);
  }
  return undefined;
}

/** The first layer in the base's rotation order scoring `score` whose option passes the hard rules. */
function firstLayerAt<G extends IdeaGarment>(
  score: number,
  {
    base,
    layers,
    judged,
    order,
    rules,
  }: {
    base: readonly G[];
    layers: Layers<G>;
    judged: readonly { score: number; problems: IdeaProblem[] }[];
    order: (n: number) => number | undefined;
    rules: HardRules<G>;
  },
): Option<G> | undefined {
  for (let n = 0, at = order(0); at !== undefined; n += 1, at = order(n)) {
    const option = judged[layers.kindOf[at]];
    if (option.score !== score) continue;
    const garments = [...base, layers.offered[at]];
    if (rules.passes(garments)) return { garments, ...option };
  }
  return undefined;
}

/** `items`' nth, drawn from it only once asked for, and kept. */
function lazily<T>(items: Iterable<T>): (n: number) => T | undefined {
  const iterator = items[Symbol.iterator]();
  const drawn: T[] = [];
  return (n) => {
    while (drawn.length <= n) {
      const next = iterator.next();
      if (next.done) return undefined;
      drawn.push(next.value);
    }
    return drawn[n];
  };
}

function ideaOf<G extends IdeaGarment>(
  option: Option<G>,
  lockBroken: readonly OutfitRule[],
): Idea<G> {
  return {
    garments: inOutfitOrder(option.garments),
    score: option.score,
    problems:
      lockBroken.length > 0
        ? [...option.problems, 'breaks-rule']
        : option.problems,
    brokenRules: [...lockBroken],
    rested: option.garments
      .filter((g) => g.idleDays === null || g.idleDays >= REST_DAYS)
      .map((g) => g.id),
  };
}

function judge(
  garments: readonly IdeaGarment[],
  request: IdeaRequest<IdeaGarment>,
): { score: number; problems: IdeaProblem[] } {
  const problems: IdeaProblem[] = [];
  let score = 0;
  if (request.needs) {
    const fit = assessOutfit(
      request.needs,
      garments.map((g) => g.weather),
    );
    problems.push(...fit.problems);
    score += fit.score;
  }
  // casual + dressy is the sum of formalityMiss over the garments, never
  // below it: scoreFloor's bound depends on it.
  if (request.formality) {
    let casual = 0;
    let dressy = 0;
    for (const garment of garments) {
      const miss = formalityMisses(
        garment,
        formalityRangeFor(garment, request),
      );
      casual += miss.casual;
      dressy += miss.dressy;
    }
    if (casual > 0) problems.push('too-casual');
    if (dressy > 0) problems.push('too-dressy');
    score += casual + dressy;
  }
  return { score, problems };
}

function inOutfitOrder<G extends IdeaGarment>(garments: readonly G[]): G[] {
  // Sort is stable: two garments of one role keep their order.
  return [...garments].sort(
    (a, b) => OUTFIT_ORDER.indexOf(a.role) - OUTFIT_ORDER.indexOf(b.role),
  );
}
