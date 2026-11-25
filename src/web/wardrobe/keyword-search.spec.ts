import { describe, expect, it } from 'vitest';
import { keywordTokens, WORD_SPACES } from './keyword-search';

// The labels' side of the keyword (#673): which stored keys a word names.
// The SQL side, and that the two agree, is wardrobe-grid's and mcp-seed's.
describe('keywordTokens', () => {
  const keys = (keyword: string) =>
    keywordTokens(keyword).map(({ text, colors, types, categories }) => ({
      text,
      colors,
      types,
      categories,
    }));

  it('resolves a word to the keys whose label has a word it starts', () => {
    expect(keys('Blue  shirt')).toEqual([
      { text: 'blue', colors: ['blue'], types: [], categories: [] },
      // Not T-shirt or Sweatshirt: words split on whitespace only.
      { text: 'shirt', colors: [], types: ['shirt'], categories: [] },
    ]);
    expect(keys('coat')[0].types).toEqual(['coat', 'trench']);
    expect(keys('t-shirt')[0].types).toEqual(['t-shirt']);
    // A label that differs from its key: "Multicolor" is `pattern`.
    expect(keys('multicolour')[0].colors).toEqual([]);
    expect(keys('multi')[0].colors).toEqual(['pattern']);
    expect(keys('top')[0].categories).toEqual(['tops']);
  });

  it('folds punctuation, and keeps a punctuation-only word as itself', () => {
    expect(keywordTokens('J.Crew %')).toMatchObject([
      { text: 'jcrew', folded: true },
      { text: '%', folded: false, colors: [], types: [], categories: [] },
    ]);
    expect(keywordTokens('   ')).toEqual([]);
  });

  it('keeps letters of any script: the fold drops only FOLDED_PUNCTUATION', () => {
    expect(keywordTokens('CAFÉ Crème’s naïve')).toMatchObject([
      { text: 'café', folded: true },
      { text: 'crèmes', folded: true },
      { text: 'naïve', folded: true },
    ]);
  });

  it('splits on WORD_SPACES: JS whitespace and Unicode White_Space, nothing else (#789)', () => {
    const spaces: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      const char = String.fromCodePoint(code);
      if (/\s/u.test(char) || /\p{White_Space}/u.test(char)) spaces.push(char);
    }
    expect([...WORD_SPACES].sort()).toEqual(spaces.sort());
    expect(keywordTokens('navy\u00a0blazer\ufeffwool\u0085coat')).toMatchObject(
      [
        { text: 'navy' },
        { text: 'blazer' },
        { text: 'wool' },
        { text: 'coat' },
      ],
    );
  });
});
