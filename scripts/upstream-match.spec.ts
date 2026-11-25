import { describe, expect, it } from 'vitest';
import { inheritedLines, normalize, type OwnedLine } from './upstream-match';

const upstreamLine =
  'const inheritedSentenceThatIsLongEnough = computeSomething(first, second);';
const corpus = `${normalize('unrelated text')}\0${normalize(upstreamLine)}`;

const owned = (file: string, texts: string[]): OwnedLine[] =>
  texts.map((text, i) => ({ file, lineNumber: String(i + 1), text }));

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
      '    first, second);',
      'const alsoMine = 2;',
    ]);
    expect(inheritedLines(lines, corpus)).toEqual([lines[1]]);
  });

  it('does not join lines of different files', () => {
    const lines = [
      ...owned('a.ts', ['const inheritedSentenceThatIsLongEnough =']),
      ...owned('b.ts', ['computeSomething(first, second);']),
    ];
    expect(inheritedLines(lines, corpus)).toEqual([]);
  });

  it('ignores a run that is too short or absent from the corpus', () => {
    expect(inheritedLines(owned('a.ts', ['first, second);']), corpus)).toEqual(
      [],
    );
    const other = owned('a.ts', [
      'const mine = notInTheCorpusAtAllNoMatterHowLong();',
    ]);
    expect(inheritedLines(other, corpus)).toEqual([]);
  });
});
