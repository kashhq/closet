import english from '../i18n/en/lang.json';
import { escapeHtml } from './html';

/**
 * English strings for JSX views, typed to the keys of src/i18n/en/lang.json:
 * `t('ABOUT_TITLE')`, `t('validation.IS_EMAIL')`. A misspelled key is a type
 * error, not raw text in the page.
 */

type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

export type StringKey = Leaves<typeof english>;
/** Values for `{name}` placeholders in the catalog's strings. */
export type StringParams = Record<string, string | number>;

/**
 * The kind of each placeholder in the keys that are only placeholders and
 * punctuation ("{reason}: {message}"), and in any other key one of whose
 * placeholders is copy. `t()` reads it (`ParamsFor`): a `copy` placeholder
 * takes `Translated`, so a format-only key cannot wrap English written in code
 * (#1100); a `data` one (a name, a count, a year, a machine word) any string or
 * number, like every placeholder of a key not listed. TypeScript widens a JSON
 * import's values to `string`, so the type cannot read placeholders from
 * lang.json; `i18n.spec.ts` holds this table to the catalogue instead: every
 * format-only key is listed, and every entry names exactly its placeholders.
 */
export const PLACEHOLDER_KINDS = {
  CALENDAR_PLAN_DAY: { weekday: 'copy', month: 'copy', day: 'data' },
  QUANTITY_BADGE: { quantity: 'data' },
  'calendar.MONTH_TITLE': { month: 'copy', year: 'data' },
  'calendar.MORE': { count: 'data' },
  'calendar.SHORT_DAY': { month: 'copy', day: 'data' },
  'calendar.SHORT_DAY_YEAR': { month: 'copy', day: 'data', year: 'data' },
  'calendar.WEEK_RANGE': { from: 'copy', to: 'copy', year: 'data' },
  'calendar.WEEK_RANGE_YEARS': { from: 'copy', to: 'copy' },
  'care.REPAIR_DAY_VALUE': { day: 'copy', year: 'data' },
  // A garment's name, or its category's label when it has none.
  'gallery.PAIR': { a: 'data', b: 'data' },
  'inspiration.ADD_HINT_PIECE': { piece: 'copy' },
  'inspiration.PIECE_NAME': { kind: 'copy', colors: 'copy' },
  // The reason is a refusal word (LinkImportRefusal) a caller branches on.
  'linkImport.REASON_LED': { reason: 'data', message: 'copy' },
  'mark.OUTFIT_LABEL': { name: 'data', warnings: 'copy' },
  'mark.PIECE': { name: 'data', marks: 'copy' },
  'muse.round.BOTH': { outfits: 'copy', pieces: 'copy' },
  // The field is the form's field name, a machine word.
  'refusal.form.fieldErrors': { field: 'data', errors: 'copy' },
  'sizes.BRAND_NOTE': { brand: 'data', note: 'data' },
  'today.push.PLANNED': { occasion: 'copy', outfit: 'data' },
  'trips.DATE_RANGE': { from: 'copy', to: 'copy' },
  'weather.DAY_HIGH': { high: 'data' },
  'weather.DAY_RANGE': { low: 'data', high: 'data' },
  // The unit is a symbol (°C, UNIT_SYMBOLS), notation rather than words.
  'weather.RANGE': { low: 'data', high: 'data', unit: 'data' },
  'weekPlan.SLOT': { day: 'copy', occasion: 'copy' },
} as const satisfies Partial<
  Record<StringKey, Readonly<Record<string, 'copy' | 'data'>>>
>;

type KindedKey = keyof typeof PLACEHOLDER_KINDS;

/**
 * A key whose placeholders are all data: the type for a table of keys chosen
 * at runtime and then given parameters (`t(LINES[reason], { garment })`),
 * which `StringKey` refuses (see ParamsFor).
 */
export type DataKey = Exclude<StringKey, KindedKey>;

// Distributes over a union of keys, one object each, for ParamsFor to intersect.
type KindedParams<K extends KindedKey> = K extends unknown
  ? {
      [P in keyof (typeof PLACEHOLDER_KINDS)[K]]: (typeof PLACEHOLDER_KINDS)[K][P] extends 'copy'
        ? Translated
        : string | number;
    }
  : never;

type Intersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

/**
 * `t()`'s parameters for a key. Fails closed when the key is not one literal:
 * a key type that may be several listed keys (a union, a variable typed
 * `StringKey`) takes what every one of them takes, so no placeholder that is
 * copy for one of them is data through the wider type. Such a key may still
 * go without parameters (`t(MONTH_NAMES[i])`): a listed key then throws on
 * its missing placeholder, which forges nothing.
 */
export type ParamsFor<K extends StringKey> = [Extract<K, KindedKey>] extends [
  never,
]
  ? [params?: StringParams]
  : [K] extends [KindedKey]
    ? [params: Intersection<KindedParams<K>>]
    : [
        params?: Intersection<KindedParams<Extract<K, KindedKey>>> &
          StringParams,
      ];

function flatten(node: object, prefix = ''): [string, string][] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[prefix + key, value] as [string, string]]
      : flatten(value as object, `${prefix}${key}.`),
  );
}

const STRINGS = new Map(flatten(english));
const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(
  key: StringKey,
  params: StringParams,
  encode: (value: string) => string,
): string {
  // The key type guarantees the entry exists.
  const template = STRINGS.get(key)!;
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`t('${key}'): missing parameter {${name}}`);
    }
    return encode(String(params[name]));
  });
}

declare const translated: unique symbol;

/**
 * Copy that came out of lang.json through `t()`: the only producer, so a
 * parameter typed `Translated` (an HttpError's message, #734) cannot be
 * handed English written in code. Assignable to `string`, never from it.
 */
export type Translated = string & { readonly [translated]: true };

/** Several pieces of copy as one, for a message that lists them. */
export function joinCopy(
  parts: readonly Translated[],
  separator: string,
): Translated {
  return parts.join(separator) as Translated;
}

/** Plain text; JSX escapes it where it lands. */
export function t<K extends StringKey>(
  key: K,
  ...params: ParamsFor<K>
): Translated;
export function t(key: StringKey, params: StringParams = {}): Translated {
  return interpolate(key, params, (value) => value) as Translated;
}

/**
 * The text before and after one placeholder, for markup at it ("last worn
 * {when}" around a <time>, src/web/day-time.tsx): JSX escapes both parts.
 */
export function tAround(
  key: StringKey,
  name: string,
  params: StringParams = {},
): [before: string, after: string] {
  const marker = '\u0000';
  const [before = '', after = ''] = interpolate(
    key,
    { ...params, [name]: marker },
    (value) => value,
  ).split(marker);
  return [before, after];
}

/**
 * A string whose English text carries markup (ABOUT_INTRO's attribution
 * link), for `dangerouslySetInnerHTML`. The template comes from the bundled
 * language file and is trusted; the parameters are escaped, so config or user
 * values can never inject markup through it.
 */
export function tHtml(key: StringKey, params: StringParams = {}): string {
  return interpolate(key, params, escapeHtml);
}

/**
 * A string whose key is built at runtime: a value set's label
 * (`property.warmth.3`, `property.type.t-shirt`; src/web/wardrobe/labels.ts).
 * Throws on a key the catalog lacks, which labels.spec.ts rules out for
 * every value of every set. Deliberately no fallback for stored values: a
 * stored property is always in its check constraint's set (the migration
 * that drops a value still held by a row fails at boot, before any request),
 * so a miss here is a missing catalog string, a bug to surface, not data to
 * render raw.
 */
export function tKey(key: string): Translated {
  const template = STRINGS.get(key);
  if (template === undefined) throw new Error(`No string for key '${key}'`);
  return template as Translated;
}
