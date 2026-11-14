import { GarmentCategory, isBuiltInCategory } from '../../wardrobe/properties';
import { t, type StringKey } from '../i18n';

/**
 * What a garment's fields may hold and how they read, shared by the
 * wardrobe (src/web/wardrobe) and the outfit builder (src/web/outfits).
 * Pure: no database, no request.
 */

// Prices are stored without a currency: one household, one currency, and
// this household's is the US dollar (en-US like the string catalog).
const PRICE_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** A stored price ('24.90') as the garment page shows it ('$24.90'). */
export function priceLabel(price: string): string {
  return PRICE_FORMAT.format(Number(price));
}

const CATEGORY_LABELS: Record<GarmentCategory, StringKey> = {
  [GarmentCategory.ACCESSORIES]: 'CATEGORY_ACCESSORIES',
  [GarmentCategory.BAGS]: 'CATEGORY_BAGS',
  [GarmentCategory.OUTERWEAR]: 'CATEGORY_OUTERWEAR',
  [GarmentCategory.DRESSES]: 'CATEGORY_DRESSES',
  [GarmentCategory.TOPS]: 'CATEGORY_TOPS',
  [GarmentCategory.BOTTOMS]: 'CATEGORY_BOTTOMS',
  [GarmentCategory.FOOTWEAR]: 'CATEGORY_FOOTWEAR',
  [GarmentCategory.OTHER]: 'CATEGORY_OTHER',
};

const ENUM_ORDER: string[] = Object.values(GarmentCategory);

/**
 * A category as stored: trimmed and lower case, so "Tops" and "tops " are one,
 * and a built-in's label read back to its key. The form shows labels
 * (`categoryLabel`) and posts what it shows, so every surface that reads a
 * category (page, API, MCP, filters) maps it here, in the one place.
 */
export function normalizeCategory(value: string): string {
  const normalized = value.trim().toLowerCase();
  const builtIn = Object.values(GarmentCategory).find(
    (key) => t(CATEGORY_LABELS[key]).toLowerCase() === normalized,
  );
  return builtIn ?? normalized;
}

/** The built-in categories' translated names; a custom category is its own label. */
export function categoryLabel(category: string): string {
  const normalized = category.toLowerCase();
  return isBuiltInCategory(normalized)
    ? t(CATEGORY_LABELS[normalized])
    : category;
}

/** Built-in categories in enum order, then custom ones sorted. */
export function orderCategories(categories: string[]): string[] {
  return [
    ...ENUM_ORDER.filter((category) => categories.includes(category)),
    ...categories.filter((category) => !isBuiltInCategory(category)).sort(),
  ];
}

/** The built-in categories, then the wardrobe's own: the form's suggestions. */
export function categorySuggestions(stored: string[]): string[] {
  return orderCategories([...new Set([...ENUM_ORDER, ...stored])]);
}

const CANONICAL_SIZES = [
  'XX-Small',
  'X-Small',
  'Small',
  'Medium',
  'Large',
  'X-Large',
  'XX-Large',
  '3X-Large',
  '4X-Large',
  '5X-Large',
] as const;

// Spellings of each letter size, compared lower case without spaces or
// dashes ("x-large", "XL" and "x large" are all X-Large).
const SIZE_SPELLINGS: [string[], (typeof CANONICAL_SIZES)[number]][] = [
  [['xxxxxl', '5xl', '5xlarge', 'xxxxxlarge'], '5X-Large'],
  [['xxxxl', '4xl', '4xlarge', 'xxxxlarge'], '4X-Large'],
  [['xxxl', '3xl', '3xlarge', 'xxxlarge'], '3X-Large'],
  [['xxl', '2xl', '2xlarge', 'xxlarge'], 'XX-Large'],
  [['xl', 'xlarge'], 'X-Large'],
  [['l', 'large'], 'Large'],
  [['m', 'medium'], 'Medium'],
  [['s', 'small'], 'Small'],
  [['xs', 'xsmall'], 'X-Small'],
  [['xxs', '2xs', '2xsmall', 'xxsmall'], 'XX-Small'],
];

/**
 * A size as stored: a letter size in its canonical spelling, anything else
 * ("32", "One Size") trimmed as typed. Undefined for a blank one.
 */
export function normalizeSize(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const key = trimmed.toLowerCase().replace(/[\s-]+/g, '');
  const canonical = SIZE_SPELLINGS.find(([spellings]) =>
    spellings.includes(key),
  );
  return canonical ? canonical[1] : trimmed;
}

/** Canonical sizes in wearing order first, anything custom alphabetically after. */
export function compareSizes(a: string, b: string): number {
  const sizes: readonly string[] = CANONICAL_SIZES;
  const ai = sizes.indexOf(a);
  const bi = sizes.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}
