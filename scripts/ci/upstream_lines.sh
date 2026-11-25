#!/usr/bin/env bash
# Counts the lines in the tree that the owner did not write (#1225). Closet began from another
# project's code and could be relicensed MIT only once none of its expression was left: only a
# copyright holder can relicense. This script is the proof; `make upstream-check` runs it.
#
# Upstream, defined: a line whose `git blame -w -M -C` author email is not in OWNER_EMAILS. The
# email, not the name: the owner commits under two names with one email. -w ignores whitespace
# edits and -M/-C follow lines moved within a file or copied across files, so reformatting or
# moving an inherited line does not make it the owner's; only new expression does.
# Substantive only: a line with no letter or digit (blank, a lone brace, `);`) carries no
# expression and cannot be re-authored, so it is not counted.
# Exempt: a line in scripts/ci/upstream_exempt.txt, which lists, per file, the inherited lines
# that are facts rather than expression (a syntax keyword, a dependency's name, a one-word label,
# a month's name) and so cannot be written another way; that file says why for each group. An
# entry that no longer matches an inherited line fails the run, so the list only shrinks.
#
# Blames HEAD, so commit first. Text files only (grep -I skips binaries); the lockfile is skipped.
# Output: `<upstream>\t<total>\t<file>` per file with any, then the UPSTREAM summary; exit 1 while
# any remain or an exemption is stale. Minutes over the whole tree, so it is in no tier.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Space-separated; the one place the owner is named.
OWNER_EMAILS='8147664+kashhq@users.noreply.github.com'
EXEMPT=scripts/ci/upstream_exempt.txt

matched=$(mktemp)
trap 'rm -f "$matched"' EXIT

upstream_total=0
upstream_files=0
exempt_total=0
while IFS= read -r -d '' file; do
  if [ ! -f "$file" ] || ! grep -Iq . "$file"; then continue; fi
  read -r upstream exempt total < <(git blame --line-porcelain -w -M -C HEAD -- "$file" | awk \
    -v owners="$OWNER_EMAILS" -v exempt_file="$EXEMPT" -v file="$file" -v matched="$matched" '
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
      if (mail in owner || text !~ /[[:alnum:]]/) next
      if (text in allowed) { exempt++; print file "\t" text >> matched } else upstream++
    }
    END { printf "%d %d %d\n", upstream, exempt, total }
  ')
  exempt_total=$((exempt_total + exempt))
  if [ "$upstream" -gt 0 ]; then
    printf '%d\t%d\t%s\n' "$upstream" "$total" "$file"
    upstream_total=$((upstream_total + upstream))
    upstream_files=$((upstream_files + 1))
  fi
done < <(git ls-files -z -- ':!package-lock.json')

stale=$(comm -23 <(grep -v '^#' "$EXEMPT" | grep $'\t' | sort -u) <(sort -u "$matched"))
if [ -n "$stale" ]; then
  echo "upstream-check: $EXEMPT has entries no inherited line matches any more; delete them:" >&2
  printf '%s\n' "$stale" >&2
fi

echo "UPSTREAM $upstream_total substantive line(s) in $upstream_files file(s); $exempt_total exempt ($EXEMPT)"
[ "$upstream_total" -eq 0 ] && [ -z "$stale" ]
