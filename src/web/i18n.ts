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

/** Plain text; JSX escapes it where it lands. */
export function t(key: StringKey, params: StringParams = {}): string {
  return interpolate(key, params, (value) => value);
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
export function tKey(key: string): string {
  const template = STRINGS.get(key);
  if (template === undefined) throw new Error(`No string for key '${key}'`);
  return template;
}
