#!/usr/bin/env bash
# Counts the lines in the tree that the owner did not write (#1225). Closet began from another
# project's code and could be relicensed MIT only once none of its expression was left: only a
# copyright holder can relicense. This script is the proof; `make upstream-check` runs it.
#
# Upstream, defined: a line whose `git blame -w -M -C -C -C` author email is not in OWNER_EMAILS.
# The email, not the name: the owner commits under two names. -w ignores whitespace edits, -M
# follows lines moved within a file and -C -C -C lines copied from any file in any commit (one -C
# looks only at files the same commit changed), so reformatting, moving or copying an inherited
# line does not make it the owner's; only new expression does.
# Rewrapped lines: blame matches whole lines, so a line a formatter split or joined, text kept
# verbatim inside a new wrapper, or a line retyped from a deleted file is credited to the owner.
# scripts/upstream-rewraps.ts, the second pass, catches those by text: an owner line of 40 or
# more characters (or up to three consecutive ones, joined) found anywhere in the upstream commits' blobs, whitespace and line breaks
# ignored, counts as upstream too (that file says why). No .git-blame-ignore-revs: the history is
# squash-merged, so no commit is format-only (every one that rewrapped also changed content), and
# an ignored commit's new lines would go to its parents. If a format-only commit ever lands (a
# formatter run over the tree, alone), list it in a .git-blame-ignore-revs and pass the file here
# with --ignore-revs-file.
# Substantive only: a line with no letter or digit (blank, a lone brace, `);`) carries no
# expression and cannot be re-authored, so it is not counted.
# Exempt: a line in scripts/ci/upstream_exempt.txt, which lists, per file, the inherited lines
# that are facts rather than expression (a syntax keyword, a dependency's name, a one-word label,
# a month's name) and so cannot be written another way; that file says why for each group. An
# entry that no longer matches an inherited line fails the run, so the list only shrinks.
#
# Blames HEAD, so commit first. Text files only (grep -I skips binaries). Generated files are
# skipped, their source being blamed instead: the lockfile, and drizzle-kit's snapshots (written
# from src/db/schema.ts, never edited, immutable once shipped; -C -C -C finds the column names
# every later snapshot repeats from the first, which are the schema's, not anyone's expression).
# Output: `<upstream>\t<total>\t<file>` per file with any, `rewrapped\t<file>:<n>\t<text>` per
# line the second pass finds, then the UPSTREAM summary; exit 1 while any remain or an exemption
# is stale. Minutes over the whole tree, so it is in no tier.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Space-separated; the one place the owner is named. Both are the owner's GitHub account's
# no-reply addresses: the id-prefixed one GitHub stamps on squash merges, and the plain one a
# local checkout's commits may carry before the merge.
OWNER_EMAILS='8147664+kashhq@users.noreply.github.com kashhq@users.noreply.github.com'
EXEMPT=scripts/ci/upstream_exempt.txt

# A 0 proves something only over the whole history: a shallow clone blames every line to its
# boundary commit (the owner's), and one with no inherited commit has nothing to compare against.
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo "upstream-check: shallow clone; run git fetch --unshallow first" >&2
  exit 2
fi
owner_re=$(tr ' ' '\n' <<<"$OWNER_EMAILS" | sed 's/[.+]/\\&/g' | paste -sd'|' -)
# grep -c reads to the end: -q would stop early and SIGPIPE git log under pipefail.
inherited=$(git log --format=%ae HEAD | grep -cvxE "$owner_re" || true)
if [ "${inherited:-0}" -eq 0 ]; then
  echo "upstream-check: no inherited commit in this history, so nothing to check against" >&2
  exit 2
fi

matched=$(mktemp)
blame=$(mktemp)
owned=$(mktemp)
rewrapped=$(mktemp)
counts=$(mktemp)
trap 'rm -f "$matched" "$blame" "$owned" "$rewrapped" "$counts"' EXIT

upstream_total=0
upstream_files=0
exempt_total=0
while IFS= read -r -d '' file; do
  if [ ! -f "$file" ] || ! grep -Iq . "$file"; then continue; fi
  # Blame to a file, not a pipe: a failed blame must stop the run, never read as a clean file.
  if ! git blame --line-porcelain -w -M -C -C -C HEAD -- "$file" > "$blame"; then
    echo "upstream-check: git blame failed for $file" >&2
    exit 2
  fi
  read -r upstream exempt total < <(awk \
    -v owners="$OWNER_EMAILS" -v exempt_file="$EXEMPT" -v file="$file" -v matched="$matched" \
    -v owned="$owned" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    BEGIN {
      n = split(owners, list, " "); for (i = 1; i <= n; i++) owner["<" list[i] ">"] = 1
      while ((getline line < exempt_file) > 0) {
        tab = index(line, "\t")
        if (line ~ /^#/ || tab == 0) continue
        if (substr(line, 1, tab - 1) == file) allowed[substr(line, tab + 1)] = 1
      }
    }
    /^author-mail / { mail = $2; next }
    /^\t/ {
      total++
      text = trim(substr($0, 2))
      if (text !~ /[[:alnum:]]/) next
      if (mail in owner) { print file "\t" total "\t" text >> owned; next }
      if (text in allowed) { exempt++; print file "\t" text >> matched } else upstream++
    }
    END { printf "%d %d %d\n", upstream, exempt, total }
  ' "$blame")
  exempt_total=$((exempt_total + exempt))
  if [ "$upstream" -gt 0 ]; then
    printf '%d\t%d\t%s\n' "$upstream" "$total" "$file"
    upstream_total=$((upstream_total + upstream))
    upstream_files=$((upstream_files + 1))
  fi
done < <(git ls-files -z -- ':!package-lock.json' ':!drizzle/meta/*_snapshot.json')

# The second pass over every owner line at once: its corpus is built once per run.
node -r ts-node/register/transpile-only scripts/upstream-rewraps.ts "$owned" $OWNER_EMAILS \
  > "$rewrapped"
# A rewrapped line answers to the same exemptions; each finding prints as `rewrapped\t<file>:<n>\t<text>`.
awk -v exempt_file="$EXEMPT" -v matched="$matched" -v counts="$counts" '
  BEGIN {
    while ((getline line < exempt_file) > 0) {
      tab = index(line, "\t")
      if (line ~ /^#/ || tab == 0) continue
      allowed[line] = 1
    }
  }
  {
    split($0, field, "\t")
    text = substr($0, length(field[1]) + length(field[2]) + 3)
    key = field[1] "\t" text
    if (key in allowed) { exempt++; print key >> matched; next }
    upstream++
    print "rewrapped\t" field[1] ":" field[2] "\t" text
  }
  END { printf "%d %d\n", upstream, exempt > counts }
' "$rewrapped"
read -r rewrap_upstream rewrap_exempt < "$counts"
upstream_total=$((upstream_total + rewrap_upstream))
exempt_total=$((exempt_total + rewrap_exempt))

stale=$(comm -23 <(grep -v '^#' "$EXEMPT" | grep $'\t' | sort -u) <(sort -u "$matched"))
if [ -n "$stale" ]; then
  echo "upstream-check: $EXEMPT has entries no inherited line matches any more; delete them:" >&2
  printf '%s\n' "$stale" >&2
fi

echo "UPSTREAM $upstream_total substantive line(s) ($rewrap_upstream rewrapped) in $upstream_files file(s) by blame; $exempt_total exempt ($EXEMPT)"
[ "$upstream_total" -eq 0 ] && [ -z "$stale" ]
