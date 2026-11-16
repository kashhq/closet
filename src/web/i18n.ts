import english from '../i18n/en/lang.json';
import { escapeHtml } from './html';
import { PLACEHOLDER_KINDS } from './placeholder-kinds';

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

type Kinds = typeof PLACEHOLDER_KINDS;
type KindedKey = keyof Kinds;
type Value<Kind> = Kind extends 'copy' ? Translated : string | number;

/** One key's parameters: exactly its placeholders, each typed by its kind. */
type KeyParams<K extends KindedKey> = {
  [P in keyof Kinds[K]]: Value<Kinds[K][P]>;
};

/** The placeholders that are copy in any key of K (distributes over a union). */
type CopyNames<K> = K extends KindedKey
  ? {
      [P in keyof Kinds[K]]: Kinds[K][P] extends 'copy' ? P : never;
    }[keyof Kinds[K]]
  : never;

type IsUnion<K, All = K> = K extends unknown
  ? [All] extends [K]
    ? false
    : true
  : never;

/**
 * `t()`'s parameters for a key, from PLACEHOLDER_KINDS. One literal key takes
 * exactly its placeholders; a key without any takes none that matter. A key
 * type wider than one literal (a table of keys, a variable typed `StringKey`)
 * fails closed: a placeholder that is copy in any key it may be takes
 * `Translated`. It may still go without parameters: a key whose placeholder
 * is missing throws at runtime, which forges nothing.
 */
export type ParamsFor<K extends StringKey> =
  true extends IsUnion<K>
    ? [params?: { [P in CopyNames<K>]?: Translated } & StringParams]
    : K extends KindedKey
      ? [params: KeyParams<K>]
      : [params?: StringParams];

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
