import {
  and,
  arrayOverlaps,
  ilike,
  inArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  GARMENT_COLORS,
  GARMENT_TYPES,
  GarmentCategory,
  type GarmentColor,
} from '../../wardrobe/properties';
import { categoryLabel } from './garment';
import { valueLabel } from './labels';

/**
 * The search box's keyword (#673), the one predicate the grid, GET
 * /api/v1/garments and MCP's search_garments share through gridWhere and
 * the page order (queries.ts). The keyword is split on whitespace and every
 * token must start a word of one of the garment's texts (startsAWord:
 * punctuation folded on both sides, so "jcrew" finds "J.Crew"): its name,
 * brand, notes or category, or the label (or key) of one of its colours or
 * its type. Colours, types and built-in categories are stored as keys, so a
 * token is resolved to the keys whose labels match here, before the query:
 * the labels stay in the catalog, never in SQL. Design: grid.md, Search.
 */

/** `garment`'s searched columns. */
type GarmentTable = Record<
  'name' | 'brand' | 'notes' | 'category' | 'colors' | 'type',
  AnyPgColumn
>;

export interface KeywordToken {
  /**
   * The word folded (fold), or, for one that is all FOLDED_PUNCTUATION
   * ("100%" is not, "%" is), the word itself, matched literally: folded it
   * would be empty and match everything.
   */
  text: string;
  folded: boolean;
  colors: GarmentColor[];
  types: string[];
  categories: string[];
}

/**
 * The characters the fold drops, one fixed set for both sides (fold here,
 * contains' `translate` in Postgres): ASCII punctuation and the typographic
 * quotes and dashes. A set, not a character class: Postgres' `[:alnum:]`
 * follows the database's locale (ASCII only under C), so "café" folded to
 * "caf" there and "café" here, and never matched. Letters in any script stay.
 */
const FOLDED_PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~‘’‚“”„–—…·•';
const FOLDED = new Set(FOLDED_PUNCTUATION);

/**
 * The characters that split words, one fixed set for both sides (the
 * keyword's and the labels' split here, contains' `regexp_replace` in
 * Postgres): JS's `\s` and Unicode's White_Space together, so a no-break
 * space or a BOM pasted into a product name splits on both sides. A set,
 * not `[[:space:]]`: that class follows the collation in force (ASCII only
 * under C, so it held only while `pg_unicode_fast` reached the regex) and
 * even under Unicode differs from `\s` (U+0085, U+FEFF), #789.
 * keyword-search.spec.ts holds it to both definitions.
 */
export const WORD_SPACES =
  '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
/** WORD_SPACES as a bracket expression, in JS's and Postgres' regex alike (none of its characters is special there). */
const WORD_SPACE_RUN = `[${WORD_SPACES}]+`;
const WORD_SPLIT = new RegExp(WORD_SPACE_RUN, 'u');

/**
 * Lower case, FOLDED_PUNCTUATION dropped: "J.Crew" is "jcrew", "T-shirt"
 * "tshirt", "Café" "café".
 */
function fold(text: string): string {
  return [...text.toLowerCase()].filter((char) => !FOLDED.has(char)).join('');
}

/**
 * Whether a text has a word starting with the token, each word folded: words
 * are split on WORD_SPACES only, so "shirt" finds the Shirt type and "Western
 * denim shirt" but not "T-shirt" or "Navy crewneck sweatshirt", "coat" finds
 * "Trench coat", and "jcrew" finds "J.Crew". contains is the same rule in
 * Postgres; the two must agree.
 */
function startsAWord(text: string, token: string): boolean {
  return text.split(WORD_SPLIT).some((word) => fold(word).startsWith(token));
}

function matching<T extends string>(
  values: readonly T[],
  label: (value: T) => string,
  token: string,
): T[] {
  return values.filter(
    (value) => startsAWord(label(value), token) || startsAWord(value, token),
  );
}

const TYPE_VALUES = [
  ...new Set(
    Object.values(GARMENT_TYPES).flatMap((types) =>
      types.map(({ value }) => value),
    ),
  ),
];
const CATEGORIES = Object.values(GarmentCategory);

/** The keyword's tokens with the keys each one names; none for a blank one. */
export function keywordTokens(keyword: string | undefined): KeywordToken[] {
  return (keyword ?? '')
    .split(WORD_SPLIT)
    .filter((word) => word !== '')
    .map((word): KeywordToken => {
      const folded = fold(word);
      if (folded === '') {
        return {
          text: word,
          folded: false,
          colors: [],
          types: [],
          categories: [],
        };
      }
      return {
        text: folded,
        folded: true,
        colors: matching(
          GARMENT_COLORS,
          (color) => valueLabel('color', color),
          folded,
        ),
        types: matching(
          TYPE_VALUES,
          (type) => valueLabel('type', type),
          folded,
        ),
        categories: matching(CATEGORIES, categoryLabel, folded),
      };
    });
}

/** `text` with LIKE's own wildcards taken literally (the default escape, `\\`). */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * A text column matching the token. A folded token starts a word of the
 * column folded the same way, word by word: lower case, FOLDED_PUNCTUATION
 * dropped within words, words split on WORD_SPACES (startsAWord in Postgres;
 * " " is prepended so the first word starts after one). Both steps are
 * independent of the database's locale: `pg_unicode_fast` (Postgres 18's
 * builtin collation, Unicode case mapping as toLowerCase), a fixed
 * `translate` set and a fixed split set. A punctuation-only token is contained as itself ("%"
 * finds a name with a percent sign, not every garment). A filter over one
 * wardrobe's rows (hundreds): no index or stored folded column at household
 * size.
 */
function contains(column: AnyPgColumn, token: KeywordToken): SQL {
  if (!token.folded) return ilike(column, `%${likeLiteral(token.text)}%`);
  const words = sql`' ' || regexp_replace(translate(lower(${column} collate "pg_unicode_fast"), ${FOLDED_PUNCTUATION}::text, ''), ${WORD_SPACE_RUN}::text, ' ', 'g')`;
  return sql`${words} like ${`% ${likeLiteral(token.text)}%`}`;
}

/**
 * The token matched by anything but the notes: the name, the brand, the
 * category (stored text, so a custom category, its own label, matches too),
 * or a key its labels resolved to.
 */
function strongMatch(table: GarmentTable, token: KeywordToken): SQL {
  return or(
    contains(table.name, token),
    contains(table.brand, token),
    contains(table.category, token),
    token.colors.length > 0
      ? arrayOverlaps(table.colors, token.colors)
      : undefined,
    token.types.length > 0 ? inArray(table.type, token.types) : undefined,
    token.categories.length > 0
      ? inArray(table.category, token.categories)
      : undefined,
  )!;
}

/** Every token matches one of the garment's texts, the notes included. */
export function keywordMatch(
  table: GarmentTable,
  tokens: readonly KeywordToken[],
): SQL {
  return and(
    ...tokens.map(
      (token) => or(strongMatch(table, token), contains(table.notes, token))!,
    ),
  )!;
}

/** keywordRank's values; the page cursor carries one (queries.ts, GridCursor). */
export const KEYWORD_RANKS = [0, 1] as const;
export type KeywordRank = (typeof KEYWORD_RANKS)[number];

/**
 * 0 when every token matched something other than the notes, 1 when one
 * matched only them: the page sorts by it first, so a garment the keyword
 * names ranks above one whose notes merely mention it. For a matching row
 * only (keywordMatch); a null name or brand falls to 1, never to null.
 */
export function keywordRank(
  table: GarmentTable,
  tokens: readonly KeywordToken[],
): SQL<KeywordRank> {
  const strong = and(...tokens.map((token) => strongMatch(table, token)))!;
  return sql<KeywordRank>`case when ${strong} then 0 else 1 end`;
}
