#!/usr/bin/env bash
# The page's plain-JS modules only shrink (#713; scripts/ci/plain_js.conf says why). Judges the
# index, so the pre-commit hook sees what is being committed:
#   - a tracked public/js/*.js with no `known` line is a new plain-JS module: write it as
#     views/assets/page/<name>.ts instead;
#   - a `known` line with no tracked file was converted or removed: drop the line;
#   - a views/assets/page/<name>.ts whose public/js/<name>.js is tracked, or not ignored, would
#     ship the build's output beside (or instead of) the source: delete it, list it in .gitignore.
# Stdlib only (git, sort, comm), like layer-check, so it runs before npm ci.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

conf=scripts/ci/plain_js.conf
status=0
fail() {
  echo "plain-js-check: $*" >&2
  status=1
}

known=$(awk '$1 == "known" { print $2 }' "$conf" | sort)
tracked=$(git ls-files -- 'public/js/*.js' | sort)

while IFS= read -r file; do
  [ -n "$file" ] || continue
  fail "$file is a new plain-JS module: write it as views/assets/page/$(basename "$file" .js).ts (src/web/shell/AGENTS.md, Client modules)"
done < <(comm -13 <(printf '%s\n' "$known") <(printf '%s\n' "$tracked"))

while IFS= read -r file; do
  [ -n "$file" ] || continue
  fail "$file is no longer plain JS in the tree: drop its line from $conf"
done < <(comm -23 <(printf '%s\n' "$known") <(printf '%s\n' "$tracked"))

while IFS= read -r source; do
  [ -n "$source" ] || continue
  case "$source" in *.d.ts) continue ;; esac
  output="public/js/$(basename "$source" .ts).js"
  if git ls-files --error-unmatch -- "$output" >/dev/null 2>&1; then
    fail "$output is built from $source (npm run generate:pages): delete the tracked copy"
  elif ! git check-ignore -q --no-index -- "$output"; then
    fail "$output is built from $source (npm run generate:pages): list it in .gitignore"
  fi
done < <(git ls-files -- 'views/assets/page/*.ts')

if [ "$status" -eq 0 ]; then
  echo "plain-js-check: $(printf '%s\n' "$known" | grep -c .) plain-JS modules left (scripts/ci/plain_js.conf)"
fi
exit "$status"
