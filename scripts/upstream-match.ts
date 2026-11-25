/**
 * The matching half of scripts/upstream-rewraps.ts, pure so scripts/upstream-match.spec.ts can
 * drive it with a small corpus. See upstream-rewraps.ts for what the corpus is and why text is
 * compared instead of blame.
 */

export const MIN_CHARS = 40;

// A formatter splits one inherited line into at most this many owner lines.
export const MAX_WINDOW = 3;

export interface OwnedLine {
  file: string;
  lineNumber: string;
  text: string;
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');
}

function core(normalized: string): string {
  return normalized.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

/**
 * The owner lines that begin inherited text: a line whose own core is at least MIN_CHARS long and
 * in the corpus, or the first line of a run of up to MAX_WINDOW consecutive owner lines of one
 * file whose joined core is. The run catches an inherited line a formatter split into pieces
 * shorter than MIN_CHARS, which no single line could match (#1236). `lines` is in file order.
 */
export function inheritedLines(
  lines: readonly OwnedLine[],
  corpus: string,
): OwnedLine[] {
  const verdicts = new Map<string, boolean>();
  const inCorpus = (text: string): boolean => {
    if (text.length < MIN_CHARS) return false;
    let found = verdicts.get(text);
    if (found === undefined) {
      found = corpus.includes(text);
      verdicts.set(text, found);
    }
    return found;
  };

  const normalized = lines.map((line) => normalize(line.text));
  return lines.filter((line, start) => {
    const last = Math.min(start + MAX_WINDOW, lines.length);
    let joined = '';
    for (let end = start; end < last; end++) {
      if (lines[end].file !== line.file) return false;
      joined += normalized[end];
      if (inCorpus(core(joined))) return true;
    }
    return false;
  });
}
