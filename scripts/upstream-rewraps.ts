/**
 * The second pass of `make upstream-check` (scripts/ci/upstream_lines.sh, #1225): finds lines
 * `git blame` credits to the owner whose text is inherited all the same.
 *
 * Blame matches whole lines. `-w` forgives whitespace inside a line, `-M`/`-C` follow moves and
 * copies, but none of them follows a line a formatter split or joined, nor text kept verbatim
 * inside a new wrapper (an inherited SQL string moved from `this.addSql(...)` into an array), nor
 * a line retyped from a file deleted before it was written. Those lines are credited to the commit
 * that rewrapped them. A `.git-blame-ignore-revs` cannot help: the history is squash-merged, so no
 * commit is format-only (each one that rewrapped also changed content), and ignoring one would
 * hand its new lines to its parents.
 *
 * So this compares text instead, against every text blob in the tree of the fork point and
 * each of its ancestors (scripts/ci/upstream_base, #1234: ancestry, not authorship, so a bot's or
 * contributor's later commit is never upstream), normalized: all whitespace removed and a trailing comma before a closing
 * bracket dropped (a formatter adds or removes it when it rewraps); a line's core is that, trimmed
 * of the punctuation at its ends (a quote, a comma, a wrapper's bracket). A post-fork line counts as
 * inherited when (scripts/upstream-match.ts, inheritedLines):
 * - its core is at least MIN_CHARS long and occurs anywhere in the blobs, matched with line
 *   breaks removed, so a line that joins inherited lines or wraps inherited text still matches; or
 * - it starts a run of two or three post-fork lines, adjacent in one file, whose joined core equals
 *   the core of one upstream line: a formatter split that line into pieces under MIN_CHARS
 *   (#1236). Equality with a whole upstream line, not a substring, because short boilerplate lines
 *   (`<button`, `type="button"`) sit next to each other in any codebase.
 * The hit is reported at the line, or the run's first line.
 *
 * MIN_CHARS (40) keeps out the fragments every codebase shares: below it the matches are one-name
 * imports and two-class rows; a line that long and found verbatim in upstream text is either
 * inherited or a one-form fact, which scripts/ci/upstream_exempt.txt lists with its reason.
 *
 * Usage: upstream-rewraps.ts <post-fork-lines> <fork point sha>; <post-fork-lines> holds
 * `<file>\t<line number>\t<trimmed text>` per substantive line blamed after the fork point, as upstream_lines.sh's awk
 * writes it. Prints the same three fields for each inherited one.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  buildCorpus,
  inheritedLines,
  MIN_CHARS,
  type OwnedLine,
  type UpstreamCorpus,
} from './upstream-match';

const BINARY_PROBE_BYTES = 8000;

function git(args: string[], input?: string): Buffer {
  return execFileSync('git', args, { input, maxBuffer: 1 << 30 });
}

function upstreamCorpus(base: string): UpstreamCorpus {
  const upstreamCommits = git(['rev-list', base])
    .toString()
    .split('\n')
    .filter(Boolean);

  const blobs = new Set<string>();
  for (const sha of upstreamCommits) {
    for (const entry of git(['ls-tree', '-r', '-z', sha])
      .toString()
      .split('\0')) {
      const [mode, type, id] = entry.split('\t')[0].split(' ');
      if (type === 'blob' && mode !== '120000') blobs.add(id);
    }
  }

  const batch = git(['cat-file', '--batch'], [...blobs].join('\n') + '\n');
  const texts = new Set<string>();
  let at = 0;
  while (at < batch.length) {
    const headerEnd = batch.indexOf(0x0a, at);
    const size = Number(batch.subarray(at, headerEnd).toString().split(' ')[2]);
    const body = batch.subarray(headerEnd + 1, headerEnd + 1 + size);
    at = headerEnd + 2 + size;
    if (body.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
    texts.add(body.toString('utf8'));
  }
  const corpus = buildCorpus(texts);
  console.error(
    `upstream-rewraps: ${upstreamCommits.length} upstream commits, ${texts.size} distinct text blobs, ${corpus.lines.size} distinct lines of ${MIN_CHARS}+`,
  );
  return corpus;
}

function main(): void {
  const [ownedPath, base] = process.argv.slice(2);
  const corpus = upstreamCorpus(base);
  const owned: OwnedLine[] = readFileSync(ownedPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [file, lineNumber, ...rest] = line.split('\t');
      return { file, lineNumber, text: rest.join('\t') };
    });
  for (const { file, lineNumber, text } of inheritedLines(owned, corpus)) {
    console.log(`${file}\t${lineNumber}\t${text}`);
  }
}

main();
