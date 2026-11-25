import { describe, expect, it } from 'vitest';
import { buildCorpus, inheritedLines, type OwnedLine } from './upstream-match';

const upstreamLine =
  'const inheritedSentenceThatIsLongEnough = computeSomething(first, second);';
const corpus = buildCorpus([
  'unrelated text',
  `import x from 'y';\n${upstreamLine}\n`,
  // Boilerplate a codebase repeats: each line short, together over MIN_CHARS.
  '<div>\n  <button\n    type="button"\n    class="btn btn-primary"\n  >\n</div>\n',
]);

const owned = (file: string, texts: string[], from = 1): OwnedLine[] =>
  texts.map((text, i) => ({ file, lineNumber: String(from + i), text }));

describe('inheritedLines', () => {
  it('reports a single line found in the corpus', () => {
    const lines = owned('a.ts', [upstreamLine, 'const mine = 1;']);
    expect(inheritedLines(lines, corpus)).toEqual([lines[0]]);
  });

  it('reports the first line of an inherited line a formatter split into short pieces', () => {
    const lines = owned('a.ts', [
      'const mine = 1;',
      'const inheritedSentenceThatIsLongEnough =',
      '  computeSomething(',
      '    first, second,',
      'const alsoMine = 2;',
    ]);
    expect(inheritedLines(lines, corpus)).toEqual([lines[1]]);
  });

  it('does not report adjacent short lines that match adjacent upstream lines', () => {
    const lines = owned('a.tsx', [
      '<button',
      'type="button"',
      'class="btn btn-primary"',
    ]);
    expect(inheritedLines(lines, corpus)).toEqual([]);
  });

  it('does not join lines across a gap in line numbers', () => {
    const lines = [
      ...owned('a.ts', ['const inheritedSentenceThatIsLongEnough ='], 4),
      ...owned('a.ts', ['computeSomething(first, second);'], 6),
    ];
    expect(inheritedLines(lines, corpus)).toEqual([]);
  });

  it('does not join lines of different files', () => {
    const lines = [
      ...owned('a.ts', ['const inheritedSentenceThatIsLongEnough =']),
      ...owned('b.ts', ['computeSomething(first, second);'], 2),
    ];
    expect(inheritedLines(lines, corpus)).toEqual([]);
  });

  it('ignores a line that is too short or absent from the corpus', () => {
    expect(inheritedLines(owned('a.ts', ['first, second);']), corpus)).toEqual(
      [],
    );
    const other = owned('a.ts', [
      'const mine = notInTheCorpusAtAllNoMatterHowLong();',
    ]);
    expect(inheritedLines(other, corpus)).toEqual([]);
  });
});
