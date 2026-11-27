import {
  generateIdeas,
  type Idea,
  type IdeaGarment,
  MAX_DRAWS,
  OUTFIT_ORDER,
} from './generator';
import { brandKey } from './brands';
import type { OutfitRule } from './outfit-rules';
import { type GarmentColor, type GarmentRole, isDrawnType } from './properties';

/**
 * "Goes with my closet" (#18b; docs/plans/2026-09-26-wardrobe-features.md,
 * section 11): a wishlist item judged against the closet, pure. Every
 * outfit comes from the generator (generateIdeas), with the item `locked`
 * the way `?with=` locks a closet garment, so the colour, pattern, clash
 * and outfit rules are the gallery's and nowhere else. The caller
 * (goesWithCloset, src/web/gallery/ideas.ts) reads the item, the closet,
 * the avoided pairs and the rules; the item only ever rides along as
 * `locked`, never in a pool, so no other surface can draw it.
 *
 * What is judged, and why:
 * - **No weather.** A purchase is worn across seasons: today's forecast
 *   would make a winter coat "go with nothing" in July, and the answer
 *   change daily. Without a forecast the generator draws no layer, so
 *   layers are judged one by one (layerChecks), each locked with the item.
 * - **No occasion, but the item's own formality** as the range: the
 *   generator's formality score then ranks outfits by how far their pieces
 *   dress from the item, so the best few are the coherent ones (a merino
 *   crewneck with chinos and loafers before joggers and slides). An item
 *   without a formality ranks nothing.
 * - **No rotation.** How long a closet garment has rested says nothing
 *   about whether it goes with something not yet bought, and it would bias
 *   the counts toward rested pieces: the closet is drawn uniformly.
 */

/**
 * The most outfits the count names; past it the answer is "50+". One search
 * finds every distinct outfit it meets in MAX_DRAWS draws: exact for a
 * closet where the item makes fewer (the search space is then small enough
 * to be walked many times over), a sample past it, where the number would
 * say more about the draws than about the item.
 */
export const OUTFIT_COUNT_CAP = 50;

/** Outfit cards shown: the best few. */
export const BEST_OUTFITS = 3;

/** Garments named per role it pairs with. */
export const PARTNERS_PER_ROLE = 3;

export interface GoesWithRequest<G extends IdeaGarment> {
  item: G;
  /** The closet, every garment in it (the caller decides: inCloset). */
  closet: readonly G[];
  /** Garment pairs never to combine (generator_avoid). */
  avoid: readonly (readonly [number, number])[];
  /** The owner's outfit rules (outfit_rule). */
  rules: readonly OutfitRule[];
  seed: number;
}

export interface OutfitCount {
  /** Distinct outfits found, at most OUTFIT_COUNT_CAP. */
  outfits: number;
  /** More than OUTFIT_COUNT_CAP were found: "50+". */
  capped: boolean;
}

interface Partner<G> {
  garment: G;
  /** How many of the found outfits hold it; null for a layer (checked on its own). */
  outfits: number | null;
  /** It makes an outfit dressed at the item's formality. */
  atFormality: boolean;
}

/** One role the item is worn with: how many of the closet's go, and the best of them. */
interface PartnerRole<G> {
  role: GarmentRole;
  /** Closet garments of the role that make an outfit with the item. */
  goes: number;
  /** Closet garments of the role an outfit may hold (not swim trunks: isDrawnType). */
  of: number;
  /** The best PARTNERS_PER_ROLE: at the item's formality, in the most outfits. */
  best: Partner<G>[];
}

/** The count and the best few, without the roles: an option on a decision screen. */
export interface BestOutfits<G extends IdeaGarment> extends OutfitCount {
  /** The best BEST_OUTFITS, the item in each: at its formality first. */
  best: Idea<G>[];
}

export interface GoesWith<G extends IdeaGarment> extends BestOutfits<G> {
  /** The roles it is worn with, top to toe (OUTFIT_ORDER). */
  roles: PartnerRole<G>[];
}

function formalityOf(item: IdeaGarment) {
  return item.formality === null
    ? null
    : { min: item.formality, max: item.formality };
}

/** Uniform draws: rotation is the gallery's, not a purchase's. */
function unrotated<G extends IdeaGarment>(closet: readonly G[]): G[] {
  return closet.map((garment) => ({ ...garment, idleDays: null }));
}

/**
 * Every distinct outfit one search finds with the item locked: those
 * dressed at its formality first (in draw order), then the rest, closest
 * first. Asking for a page as large as the draws means the generator never
 * stops early, so the list is everything the search met.
 */
function outfitsWith<G extends IdeaGarment>(
  request: GoesWithRequest<G>,
): Idea<G>[] {
  return generateIdeas({
    seed: request.seed,
    pool: unrotated(request.closet),
    locked: [request.item],
    formality: formalityOf(request.item),
    avoid: request.avoid,
    rules: request.rules,
    offset: 0,
    limit: MAX_DRAWS,
  }).ideas;
}

function countOf(found: number): OutfitCount {
  return {
    outfits: Math.min(found, OUTFIT_COUNT_CAP),
    capped: found > OUTFIT_COUNT_CAP,
  };
}

/** How many outfits the item makes: "Unlocks N" on the agent inbox's options. */
export function outfitCount<G extends IdeaGarment>(
  request: GoesWithRequest<G>,
): OutfitCount {
  return countOf(outfitsWith(request).length);
}

function bestOf<G extends IdeaGarment>(ideas: Idea<G>[]): BestOutfits<G> {
  return { ...countOf(ideas.length), best: ideas.slice(0, BEST_OUTFITS) };
}

/**
 * The count and the best few from the same search, without goesWith's
 * roles (whose layer checks are each a search of their own): the options
 * of an agent need side by side (src/web/wishlist/group-page.tsx).
 */
export function bestOutfits<G extends IdeaGarment>(
  request: GoesWithRequest<G>,
): BestOutfits<G> {
  return bestOf(outfitsWith(request));
}

export function goesWith<G extends IdeaGarment>(
  request: GoesWithRequest<G>,
): GoesWith<G> {
  const ideas = outfitsWith(request);
  const found = bestOf(ideas);
  if (ideas.length === 0) return { ...found, roles: [] };
  const partners = partnersIn(ideas, request.item.id);
  const asksLayers = request.item.role !== 'layer';
  const layers = asksLayers ? layerChecks(request) : [];
  const roles = OUTFIT_ORDER.flatMap((role): PartnerRole<G>[] => {
    const of = request.closet.filter(
      (g) => g.role === role && isDrawnType(g.category, g.type),
    ).length;
    const layerRole = role === 'layer' && asksLayers;
    const going = layerRole
      ? layers
      : partners.filter((p) => p.garment.role === role);
    // Layers are asked about whenever the closet has some: none going is
    // an answer ("no layer goes with it"). Any other role only when an
    // outfit holds it: a top is never worn with a dress.
    if (going.length === 0 && !(layerRole && of > 0)) return [];
    const best = going.slice(0, PARTNERS_PER_ROLE);
    return [{ role, goes: going.length, of, best }];
  });
  return { ...found, roles };
}

/**
 * The closet garments in the found outfits, each with how many hold it and
 * whether one of them is dressed at the item's formality; best first: at
 * its formality, then in the most outfits, then the oldest id.
 */
function partnersIn<G extends IdeaGarment>(
  ideas: readonly Idea<G>[],
  itemId: number,
): Partner<G>[] {
  const byId = new Map<number, Partner<G> & { outfits: number }>();
  for (const idea of ideas) {
    for (const garment of idea.garments) {
      if (garment.id === itemId) continue;
      const partner = byId.get(garment.id) ?? {
        garment,
        outfits: 0,
        atFormality: false,
      };
      partner.outfits += 1;
      partner.atFormality ||= idea.score === 0;
      byId.set(garment.id, partner);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.atFormality) - Number(a.atFormality) ||
      b.outfits - a.outfits ||
      a.garment.id - b.garment.id,
  );
}

/**
 * Which of the closet's layers go with the item: each asked of the
 * generator with both locked (an outfit of the two exists that passes every
 * hard rule), because without a forecast it draws none. At its formality
 * first, then the oldest id. A layer that goes finds its outfit in a few
 * draws; one that does not spends the search's MAX_DRAWS.
 */
function layerChecks<G extends IdeaGarment>(
  request: GoesWithRequest<G>,
): Partner<G>[] {
  const pool = unrotated(request.closet);
  const partners = pool.flatMap((layer): Partner<G>[] => {
    if (layer.role !== 'layer') return [];
    const [first] = generateIdeas({
      seed: request.seed,
      pool,
      locked: [request.item, layer],
      formality: formalityOf(request.item),
      avoid: request.avoid,
      rules: request.rules,
      offset: 0,
      limit: 1,
    }).ideas;
    // Locked together, a layer that breaks a never-rule with the item only
    // flags the idea (brokenRules): it does not go with it.
    return first && first.brokenRules.length === 0
      ? [{ garment: layer, outfits: null, atFormality: first.score === 0 }]
      : [];
  });
  return partners.sort(
    (a, b) =>
      Number(b.atFormality) - Number(a.atFormality) ||
      a.garment.id - b.garment.id,
  );
}

/** What near-duplicate detection compares. */
export interface Lookalike {
  id: number;
  category: string;
  type: string | null;
  colors: readonly GarmentColor[];
  /** Compared only with `sameBrand`. */
  brand?: string | null;
}

/** The garment judged: a saved one, or a form not yet saved (no id). */
export type LookalikeProbe = Omit<Lookalike, 'id'> & { id?: number };

export interface NearDuplicateOptions {
  /**
   * Also rule out a garment whose brand differs from the item's (#20, "add
   * a copy"): a copy is the same product, while "do I need another?" (18b,
   * the default) is about the kind, whoever made it.
   */
  sameBrand?: boolean;
}

/**
 * Closet garments near-identical to the item: "do I need this?" (#18b, a
 * wishlist item) and "is this a copy of one I own?" (#20, a new garment,
 * with `sameBrand`). The same category and type (both untyped counts as the
 * same, as for a category without types) and the same colours as a set, in
 * any order. A garment without colours is never one: unknown is not the
 * same. A blank brand is the opposite, unknown and not different: most
 * garments have none, and the colours already carry the rule.
 */
export function nearDuplicates<L extends Lookalike>(
  item: LookalikeProbe,
  closet: readonly L[],
  { sameBrand = false }: NearDuplicateOptions = {},
): L[] {
  const colors = new Set(item.colors);
  if (colors.size === 0) return [];
  const brand = sameBrand ? brandKey(item.brand ?? '') : '';
  return closet.filter(
    (garment) =>
      garment.id !== item.id &&
      garment.category === item.category &&
      garment.type === item.type &&
      sameSet(colors, new Set(garment.colors)) &&
      !differentBrands(brand, brandKey(garment.brand ?? '')),
  );
}

/** Both named, and not the same brand; '' (no brand, or not asked) never differs. */
function differentBrands(a: string, b: string): boolean {
  return a !== '' && b !== '' && a !== b;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}
