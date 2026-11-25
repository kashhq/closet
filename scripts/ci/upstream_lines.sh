#!/usr/bin/env bash
# Counts the lines in the tree that the owner did not write (#1225). Closet began from another
# project's code and could be relicensed MIT only once none of those lines were left: only a
# copyright holder can relicense. This script is the proof; `make upstream-check` runs it.
#
# Upstream, defined: a line whose `git blame -w -M -C` author email is not in OWNER_EMAILS. The
# email, not the name: the owner commits under two names with one email. -w ignores whitespace
# edits and -M/-C follow lines moved within a file or copied across files, so reformatting or
# moving an inherited line does not make it the owner's; only new expression does.
# Substantive only: a line with no letter or digit (blank, a lone brace, `);`) carries no
# expression and cannot be re-authored, so it is not counted.
#
# Blames HEAD, so commit first. Text files only (grep -I skips binaries); the lockfile is skipped.
# Output: `<upstream>\t<total>\t<file>` per file with any, then the UPSTREAM summary; exit 1 while
# any remain. Minutes over the whole tree, so it is in no tier.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Space-separated; the one place the owner is named.
OWNER_EMAILS='8147664+kashhq@users.noreply.github.com'

upstream_total=0
upstream_files=0
while IFS= read -r -d '' file; do
  if [ ! -f "$file" ] || ! grep -Iq . "$file"; then continue; fi
  read -r upstream total < <(git blame --line-porcelain -w -M -C HEAD -- "$file" | awk -v owners="$OWNER_EMAILS" '
    BEGIN { n = split(owners, list, " "); for (i = 1; i <= n; i++) owner["<" list[i] ">"] = 1 }
    /^author-mail / { mail = $2; next }
    /^\t/ {
      total++
      if (!(mail in owner) && substr($0, 2) ~ /[[:alnum:]]/) upstream++
    }
    END { printf "%d %d\n", upstream, total }
  ')
  if [ "$upstream" -gt 0 ]; then
    printf '%d\t%d\t%s\n' "$upstream" "$total" "$file"
    upstream_total=$((upstream_total + upstream))
    upstream_files=$((upstream_files + 1))
  fi
done < <(git ls-files -z -- ':!package-lock.json')

echo "UPSTREAM $upstream_total substantive line(s) in $upstream_files file(s)"
[ "$upstream_total" -eq 0 ]
