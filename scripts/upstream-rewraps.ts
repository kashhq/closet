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
 * So this compares text instead. The upstream corpus is every text blob in the tree of every
 * commit not authored by the owner, with all whitespace removed (line breaks too, so a split or
 * a joined line still matches) and a trailing comma before a closing bracket dropped (a
 * formatter adds or removes it when it rewraps). An owner line counts as inherited when its own
 * text, normalized the same way and trimmed of the punctuation at its ends (a quote, a comma, a
 * wrapper's bracket), is at least MIN_CHARS long and occurs anywhere in that corpus.
 *
 * MIN_CHARS keeps out the fragments every codebase shares: below 40 characters the matches are
 * one-name imports and two-class rows; a line that long and found verbatim in upstream text is
 * either inherited or a one-form fact, which scripts/ci/upstream_exempt.txt lists with its
 * reason.
 *
 * Usage: upstream-rewraps.ts <owned-lines> <owner email>...; <owned-lines> holds
 * `<file>\t<line number>\t<trimmed text>` per substantive owner line, as upstream_lines.sh's awk
 * writes it. Prints the same three fields for each inherited one.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MIN_CHARS = 40;
const BINARY_PROBE_BYTES = 8000;

function git(args: string[], input?: string): Buffer {
  return execFileSync('git', args, { input, maxBuffer: 1 << 30 });
}

function normalize(text: string): string {
  return text.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');
}

function upstreamCorpus(owners: Set<string>): string {
  const upstreamCommits = git(['log', '--format=%H%x09%ae', 'HEAD'])
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, email]) => !owners.has(email))
    .map(([sha]) => sha);

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
    texts.add(normalize(body.toString('utf8')));
  }
  console.error(
    `upstream-rewraps: ${upstreamCommits.length} upstream commits, ${texts.size} distinct text blobs`,
  );
  // NUL never occurs in a text blob, so no match spans two of them.
  return [...texts].join('\0');
}

function main(): void {
  const [ownedPath, ...ownerEmails] = process.argv.slice(2);
  const corpus = upstreamCorpus(new Set(ownerEmails));
  const verdicts = new Map<string, boolean>();
  for (const line of readFileSync(ownedPath, 'utf8').split('\n')) {
    if (!line) continue;
    const [file, lineNumber, ...rest] = line.split('\t');
    const text = rest.join('\t');
    const core = normalize(text).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (core.length < MIN_CHARS) continue;
    let inherited = verdicts.get(core);
    if (inherited === undefined) {
      inherited = corpus.includes(core);
      verdicts.set(core, inherited);
    }
    if (inherited) console.log(`${file}\t${lineNumber}\t${text}`);
  }
}

main();
