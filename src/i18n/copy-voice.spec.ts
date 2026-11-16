import { describe, expect, it } from 'vitest';
import english from './en/lang.json';

// #729: one voice. docs/conventions.md#copy states the rule; this holds it.
function leaves(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, child]) =>
    leaves(child, path ? `${path}.${key}` : key),
  );
}

const strings = leaves(english);

// Names that stay capitalised mid-label: names, not Title Case. Phrases, not
// words, so a name's parts ('Code', 'Weather') do not pass on their own.
const PROPER_NOUNS = [
  'Muse', // the wishlist's agent
  'Claude Code', // the MCP client the token screen names
  'Open-Meteo', // the weather provider (its credit line)
  'Styling', // the composer's section name
];

// Labels that quote or name other copy.
const NAMING_OTHER_COPY = new Set([
  'wear.UNDO_WORE_TODAY', // quotes the "Wore today" button
  'style.WEEK_CHANGE', // names the "Your week" section
  'style.CHANGE_HOME', // names the Weather settings page
  'style.BUDGET_HINT', // the budget tiers as the form names them
]);

function stripped(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\{?[^}]*\}\}?/g, '')
    .replace(/e\.g\./g, '');
}

/** A label never ends a sentence or opens a clause. */
function isLabel(text: string): boolean {
  return !/[.!?:;,](\s|$)/.test(stripped(text));
}

// A name becomes one lowercase word, not nothing: dropping it would promote
// the next word to first position, which the check skips ('Muse Picks').
function namesAsWords(text: string): string {
  return PROPER_NOUNS.reduce(
    (rest, name) => rest.replaceAll(name, 'name'),
    text,
  );
}

/** Words after the first that start uppercase and are not acronyms or names. */
function titleCasedWords(text: string): string[] {
  const words =
    namesAsWords(stripped(text)).match(/[A-Za-z][A-Za-z’'-]*/g) ?? [];
  return words
    .slice(1)
    .filter((word) => /^[A-Z]/.test(word) && word !== word.toUpperCase());
}

describe('the copy speaks in one voice (#729)', () => {
  it('walks every section of lang.json', () => {
    expect(strings.length).toBeGreaterThan(500);
  });

  it('labels are sentence case', () => {
    const offenders = strings
      .filter(
        ([key, text]) =>
          !NAMING_OTHER_COPY.has(key) &&
          isLabel(text) &&
          titleCasedWords(text).length > 0,
      )
      .map(([key, text]) => `${key}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it('it is Sign in / Sign out / Create account, never Login, Logout or Register', () => {
    const offenders = strings
      .filter(([, text]) =>
        /\blog ?(in|out)\b|\bregister\b/i.test(stripped(text)),
      )
      .map(([key, text]) => `${key}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it('the detector sees Title Case', () => {
    expect(titleCasedWords('Date Acquired')).toEqual(['Acquired']);
    expect(titleCasedWords('Add to Calendar')).toEqual(['Calendar']);
    expect(titleCasedWords('Request ID')).toEqual([]);
    expect(titleCasedWords('Date acquired')).toEqual([]);
    expect(titleCasedWords('Connect Claude Code')).toEqual([]);
    expect(titleCasedWords('Weather Settings')).toEqual(['Settings']);
    expect(titleCasedWords('Open Weather')).toEqual(['Weather']);
    expect(titleCasedWords('Muse Picks')).toEqual(['Picks']);
    expect(titleCasedWords('Styling Tips')).toEqual(['Tips']);
    expect(titleCasedWords('Ask Muse')).toEqual([]);
    expect(isLabel('Tap Save. Then wait')).toBe(false);
  });
});
