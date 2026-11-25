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

/**
 * The upstream text, held twice for the two rules of inheritedLines: `blobs` is every blob
 * normalized whole (line breaks gone, so a substring can span upstream lines) and joined by NUL;
 * `lines` is the core of every upstream line on its own, kept when at least MIN_CHARS long.
 */
export interface UpstreamCorpus {
  blobs: string;
  lines: ReadonlySet<string>;
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');
}

function core(normalized: string): string {
  return normalized.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

export function buildCorpus(texts: Iterable<string>): UpstreamCorpus {
  const blobs = new Set<string>();
  const lines = new Set<string>();
  for (const text of texts) {
    blobs.add(normalize(text));
    for (const line of text.split('\n')) {
      const lineCore = core(normalize(line));
      if (lineCore.length >= MIN_CHARS) lines.add(lineCore);
    }
  }
  // NUL never occurs in a text blob, so no match spans two of them.
  return { blobs: [...blobs].join('\0'), lines };
}

/**
 * The needles (each at least MIN_CHARS long) that occur in `haystack`, in one pass over it: each
 * needle is indexed by its first MIN_CHARS characters, so a position costs one map lookup rather
 * than every needle a scan of the whole corpus.
 */
function occurring(needles: Iterable<string>, haystack: string): Set<string> {
  const byPrefix = new Map<string, string[]>();
  for (const needle of needles) {
    const prefix = needle.slice(0, MIN_CHARS);
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(needle);
    else byPrefix.set(prefix, [needle]);
  }
  const found = new Set<string>();
  for (let at = 0; at + MIN_CHARS <= haystack.length; at++) {
    const bucket = byPrefix.get(haystack.slice(at, at + MIN_CHARS));
    if (!bucket) continue;
    for (const needle of bucket) {
      if (haystack.startsWith(needle, at)) found.add(needle);
    }
  }
  return found;
}

// The input holds owner lines only, so a gap in line numbers means inherited lines sat between.
function follows(previous: OwnedLine, next: OwnedLine): boolean {
  return (
    previous.file === next.file &&
    Number(next.lineNumber) === Number(previous.lineNumber) + 1
  );
}

/**
 * The owner lines that begin inherited text, by two rules:
 * - a line whose own core is at least MIN_CHARS long and occurs anywhere in `corpus.blobs`
 *   (an inherited line kept whole, joined from several, or kept inside a new wrapper);
 * - the first of a run of 2 to MAX_WINDOW lines, adjacent in one file (line numbers rising by
 *   exactly 1), whose joined core equals the core of a single upstream line: a formatter split
 *   that one line into pieces too short to match alone (#1236). Equality with one line, never a
 *   substring of the blobs, so short boilerplate lines next to each other (`<button`,
 *   `type="button"`) do not match the same boilerplate next to each other upstream.
 * `lines` is in file order.
 */
export function inheritedLines(
  lines: readonly OwnedLine[],
  corpus: UpstreamCorpus,
): OwnedLine[] {
  const cores = lines.map((line) => core(normalize(line.text)));
  const whole = occurring(
    new Set(cores.filter((lineCore) => lineCore.length >= MIN_CHARS)),
    corpus.blobs,
  );
  return lines.filter((line, start) => {
    if (whole.has(cores[start])) return true;
    const last = Math.min(start + MAX_WINDOW, lines.length);
    let joined = line.text;
    for (let end = start + 1; end < last; end++) {
      if (!follows(lines[end - 1], lines[end])) return false;
      joined += lines[end].text;
      if (corpus.lines.has(core(normalize(joined)))) return true;
    }
    return false;
  });
}
