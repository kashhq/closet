import {
  FABRIC_WEIGHT_GSM,
  findType,
  GarmentCategory,
  type Material,
  ozToGsm,
  type Sleeve,
  type Warmth,
} from '../../../wardrobe/properties';
import type { GarmentColor } from '../../../wardrobe/properties';

/**
 * Guesses at a garment's fields from a product page's words: colour, category
 * and type, materials, fabric weight. Every guess is a prefill the user
 * reviews on the garment form, so a miss costs a tap; a guess nobody would
 * make ("down" from "button-down") costs trust, which is why the word lists
 * are explicit and matched as whole words. Pure.
 */

/** Lower case, curly quotes and dashes made plain, whitespace collapsed. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ');
}

/** Whole-word, case-folded matcher for an alternation of phrases. */
function words(alternatives: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${alternatives})(?![a-z0-9])`, 'g');
}

// Colour words and what they are on the form. "pattern" collects the
// words that name no single colour; "other" is never guessed.
const COLOR_WORDS: readonly (readonly [GarmentColor, RegExp])[] = [
  [
    'red',
    words('red|burgundy|maroon|wine|crimson|scarlet|oxblood|cherry|brick'),
  ],
  ['pink', words('pink|rose|blush|fuchsia|magenta|salmon')],
  ['orange', words('orange|rust|terracotta|coral|apricot|peach|tangerine')],
  ['yellow', words('yellow|mustard|lemon|canary')],
  ['green', words('green|olive|sage|forest|emerald|mint|army|teal|lime|moss')],
  ['blue', words('blue|navy|indigo|cobalt|azure|sky|royal|cerulean|turquoise')],
  ['purple', words('purple|violet|lavender|lilac|plum|mauve|aubergine')],
  ['black', words('black|jet|onyx')],
  ['white', words('white|off-white|ivory|cream|ecru')],
  ['grey', words('grey|gray|charcoal|slate|heather gr[ae]y|ash|graphite')],
  ['beige', words('beige|tan|camel|khaki|sand|stone|taupe|oatmeal|nude')],
  [
    'brown',
    words('brown|chocolate|espresso|cognac|mocha|coffee|chestnut|walnut'),
  ],
  ['gold', words('gold|golden')],
  ['silver', words('silver')],
  [
    'pattern',
    words(
      'multi|multi-?colou?r|stripes?|striped|plaid|check|checked|floral|camo|camouflage|print|printed|leopard|paisley|tartan|gingham',
    ),
  ],
];

/** The form's colours named in the text, in the order they first appear. */
export function guessColors(text: string): GarmentColor[] {
  const normalized = normalize(text);
  return COLOR_WORDS.map(([color, pattern]) => ({
    color,
    at: firstIndex(pattern, normalized),
  }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ color }) => color);
}

function firstIndex(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

interface KindRule {
  pattern: RegExp;
  category: GarmentCategory;
  /** A type of GARMENT_TYPES[category], or null for the category alone. */
  type: string | null;
  /** The sleeve the phrase itself states, over the type's preset. */
  sleeve?: Sleeve;
}

const kind = (
  alternatives: string,
  category: GarmentCategory,
  type: string | null = null,
  sleeve?: Sleeve,
): KindRule => ({ pattern: words(alternatives), category, type, sleeve });

const { TOPS, BOTTOMS, DRESSES, OUTERWEAR, FOOTWEAR, ACCESSORIES, BAGS } =
  GarmentCategory;

// Order does not matter: the phrase that ends last wins (see guessKind).
const KIND_RULES: readonly KindRule[] = [
  kind('long[- ]sleeve (?:t[- ]?shirt|tee)s?', TOPS, 'long-sleeve-tee'),
  kind('(?:t[- ]?shirt|tee(?:[- ]shirt)?)s?', TOPS, 't-shirt'),
  kind('polo(?: shirt)?s?', TOPS, 'polo'),
  kind('blouses?', TOPS, 'blouse'),
  kind('tank(?: top)?s?|camisoles?|cami', TOPS, 'tank'),
  kind('turtlenecks?|mock ?necks?|roll ?necks?', TOPS, 'turtleneck'),
  kind('hoodies?|hoody|hooded sweatshirts?', TOPS, 'hoodie'),
  kind('(?:crew ?neck )?sweatshirts?', TOPS, 'sweatshirt'),
  kind('cardigans?', TOPS, 'cardigan'),
  kind('sweaters?|jumpers?|pullovers?', TOPS, 'sweater'),
  kind('shirts?|overshirts?|button[- ]downs?', TOPS, 'shirt'),
  // Sports tops stay one type (they keep their active purpose); the form
  // names the sleeve, since the type's preset is the tee's short one.
  kind(
    '(?:running|training|gym|workout) (?:tees?|t[- ]?shirts?|tops?)',
    TOPS,
    'sports-top',
  ),
  kind(
    'sports? bras?|singlets?|(?:running|training|gym|workout) (?:tank(?: top)?s?)',
    TOPS,
    'sports-top',
    'sleeveless',
  ),
  kind(
    '(?:pajama|pyjama|sleep) (?:shirts?|tops?)|pajamas|pyjamas',
    TOPS,
    'sleepwear',
  ),
  kind('tops?', TOPS),
  kind('jeans', BOTTOMS, 'jeans'),
  kind('chinos?', BOTTOMS, 'chinos'),
  kind('trousers?|pants|slacks', BOTTOMS, 'trousers'),
  kind('joggers?', BOTTOMS, 'joggers'),
  kind('sweat ?pants|track ?pants', BOTTOMS, 'sweatpants'),
  kind('shorts', BOTTOMS, 'shorts'),
  kind('skirts?', BOTTOMS, 'skirt'),
  kind('leggings', BOTTOMS, 'leggings'),
  kind('running shorts?|run shorts?', BOTTOMS, 'running-shorts'),
  kind('swim ?(?:trunks?|shorts?)|board ?shorts', BOTTOMS, 'swimwear'),
  kind(
    '(?:pajama|pyjama|sleep) (?:pants|shorts|bottoms)',
    BOTTOMS,
    'sleepwear',
  ),
  kind('swimsuits?|bathing suits?', DRESSES, 'swimwear'),
  kind('nightgowns?|nightdress(?:es)?|nighties', DRESSES, 'sleepwear'),
  kind('dress(?:es)?', DRESSES, 'day-dress'),
  kind('(?:evening|cocktail) dress(?:es)?|gowns?', DRESSES, 'evening-dress'),
  kind('jumpsuits?|rompers?|playsuits?', DRESSES, 'jumpsuit'),
  kind('jackets?|bombers?|windbreakers?|anoraks?', OUTERWEAR, 'jacket'),
  kind('(?:denim|jean|trucker) jackets?', OUTERWEAR, 'denim-jacket'),
  kind('(?:leather|biker) jackets?', OUTERWEAR, 'leather-jacket'),
  kind('blazers?|sport ?coats?|suit jackets?', OUTERWEAR, 'blazer'),
  kind('coats?|overcoats?|topcoats?|pea ?coats?', OUTERWEAR, 'coat'),
  kind('parkas?', OUTERWEAR, 'parka'),
  kind('puffers?(?: jackets?| coats?)?|down jackets?', OUTERWEAR, 'puffer'),
  kind('trench(?: ?coats?)?', OUTERWEAR, 'trench'),
  kind('rain ?jackets?|rain ?coats?|rain shells?', OUTERWEAR, 'rain-jacket'),
  kind('vests?|gilets?', OUTERWEAR, 'vest'),
  kind('fleeces?(?: jackets?)?', OUTERWEAR, 'fleece'),
  kind('sneakers?|trainers?', FOOTWEAR, 'sneakers'),
  kind('running shoes?|runners', FOOTWEAR, 'running-shoes'),
  kind('boots?|chukkas?', FOOTWEAR, 'boots'),
  kind('loafers?|moccasins?', FOOTWEAR, 'loafers'),
  kind(
    'dress shoes?|derbys?|derbies|brogues?|oxford shoes?',
    FOOTWEAR,
    'dress-shoes',
  ),
  kind('sandals?', FOOTWEAR, 'sandals'),
  kind('slides?|flip[- ]flops?', FOOTWEAR, 'slides'),
  kind('heels|pumps|stilettos?', FOOTWEAR, 'heels'),
  kind('shoes?', FOOTWEAR),
  kind('hats?|fedoras?', ACCESSORIES, 'hat'),
  kind('caps?|snapbacks?', ACCESSORIES, 'cap'),
  kind('beanies?|toques?', ACCESSORIES, 'beanie'),
  kind('scarf|scarves', ACCESSORIES, 'scarf'),
  kind('gloves|mittens', ACCESSORIES, 'gloves'),
  kind('belts?', ACCESSORIES, 'belt'),
  kind('sunglasses', ACCESSORIES, 'sunglasses'),
  kind('ties|neckties?|bow ties?', ACCESSORIES, 'tie'),
  kind(
    'necklaces?|bracelets?|earrings?|rings?|pendants?',
    ACCESSORIES,
    'jewelry',
  ),
  kind('watch(?:es)?', ACCESSORIES, 'watch'),
  kind('socks?', ACCESSORIES, 'socks'),
  kind('underwear|boxers?(?: briefs?)?|briefs', ACCESSORIES, 'underwear'),
  kind('backpacks?|rucksacks?', BAGS, 'backpack'),
  kind('totes?(?: bags?)?', BAGS, 'tote'),
  kind('cross ?body(?: bags?)?', BAGS, 'crossbody'),
  kind('handbags?|purses?|shoulder bags?', BAGS, 'handbag'),
  kind('(?:duffel|duffle|weekender|holdall)(?: bags?)?', BAGS, 'duffel'),
  kind('bags?', BAGS),
];

export interface KindGuess {
  category: GarmentCategory;
  type: string | null;
  /** Only where the phrase states it ("sports bra"); else the type's preset applies. */
  sleeve?: Sleeve;
}

/**
 * The category and type a product name names. English puts the garment
 * last ("shirt dress" is a dress, "dress shirt" a shirt, "fleece hoodie" a
 * hoodie), so of every phrase found, the one that ends last wins, and of
 * those ending together the longest ("denim jacket" over "jacket").
 */
export function guessKind(text: string): KindGuess | null {
  const normalized = normalize(text);
  let best: { rule: KindRule; end: number; length: number } | null = null;
  for (const rule of KIND_RULES) {
    for (const match of normalized.matchAll(rule.pattern)) {
      const end = match.index + match[0].length;
      const length = match[0].length;
      if (
        !best ||
        end > best.end ||
        (end === best.end && length > best.length)
      ) {
        best = { rule, end, length };
      }
    }
  }
  if (!best) return null;
  const { category, type, sleeve } = best.rule;
  return sleeve ? { category, type, sleeve } : { category, type };
}

const MATERIAL_WORDS: readonly (readonly [Material, RegExp])[] = [
  ['cotton', words('cotton|pima|supima')],
  ['linen', words('linen')],
  // Merino is wool, stored as merino alone.
  ['wool', words('(?<!merino )wool|lambswool|tweed')],
  ['merino', words('merino')],
  ['cashmere', words('cashmere')],
  ['silk', words('silk')],
  ['denim', words('denim|selvedge|selvage')],
  // "faux leather", "faux-leather", "PU leather" are synthetic, below.
  ['leather', words('(?<!(?:faux|vegan|pu)[- ])leather')],
  ['suede', words('suede')],
  ['polyester', words('polyester')],
  ['nylon', words('nylon|polyamide')],
  ['fleece', words('fleece')],
  // Never "down" alone: "button-down", "down the leg".
  ['down', words('(?:goose|duck) down|down[- ]fill(?:ed)?|down insulat\\w*')],
  ['knit', words('knit|knitted')],
  [
    'synthetic',
    words(
      'acrylic|viscose|rayon|modal|lyocell|tencel|(?:faux|vegan|pu)[- ]leather',
    ),
  ],
];

/** The form's materials named in the text, in MATERIALS order. */
export function guessMaterials(text: string): Material[] {
  const normalized = normalize(text);
  return MATERIAL_WORDS.filter(
    ([, pattern]) => firstIndex(pattern, normalized) >= 0,
  ).map(([material]) => material);
}

const GSM =
  /(?<![\d.])(\d{2,4}(?:\.\d+)?) ?(?:gsm|g\/m2|g\/m²|g\/sqm|grams? per square met(?:er|re))(?![a-z])/;
const OUNCES = /(?<![\d.])(\d{1,2}(?:\.\d+)?)[ -]?(?:oz|ounces?)(?![a-z])/;

/** The weight as stated, gsm first, ounces converted; null for neither. */
function statedGsm(normalized: string): number | null {
  const gsm = GSM.exec(normalized);
  if (gsm) return Math.round(Number(gsm[1]));
  const oz = OUNCES.exec(normalized);
  return oz ? ozToGsm(Number(oz[1])) : null;
}

/**
 * A stated fabric weight in gsm ("240 gsm", "240g/m2", "14 oz", "6-ounce"),
 * or null when none is stated or it is outside FABRIC_WEIGHT_GSM (an "8 oz
 * bottle" of care product is not a fabric).
 */
export function guessFabricWeight(text: string): number | null {
  const weight = statedGsm(normalize(text));
  return weight !== null &&
    weight >= FABRIC_WEIGHT_GSM.min &&
    weight <= FABRIC_WEIGHT_GSM.max
    ? weight
    : null;
}

const HEAVY = words('heavy ?-?weight|heavy');
const LIGHT = words('light ?-?weight|featherweight');

/**
 * "Heavyweight tee" without a number: the warmth the type's heaviest weight
 * step gives (lightweight: its lightest), so the words move warmth the way a
 * stated weight would. Null when the type has no weight steps or the text
 * says neither.
 */
export function guessWeightWarmth(
  text: string,
  category: string,
  type: string | null,
): Warmth | null {
  const steps = findType(category, type)?.weightSteps;
  if (!steps) return null;
  const normalized = normalize(text);
  if (firstIndex(HEAVY, normalized) >= 0) return steps[0].warmth;
  if (firstIndex(LIGHT, normalized) >= 0) return steps[steps.length - 1].warmth;
  return null;
}
