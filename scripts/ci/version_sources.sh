#!/usr/bin/env bash
# The second half of `make release-check` (docs/decisions.md 2026-11-25, #637): devkit's
# release_check.sh holds APP_VERSION to the image; this holds the rest. A build is named by
# APP_VERSION (the bare sha7) alone and a release by git and GHCR tags, so no tracked file may
# carry a second app version: package.json and package-lock.json say 0.0.0, and no tracked env or
# compose file gives APP_VERSION a value.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2
rc=0
fail() { echo "release-check: $*" >&2; rc=1; }

# The package's own version is the first "version" key at the top level (package.json, and the
# lockfile's line 3) and, in the lockfile, the first at packages[""]'s depth.
app_version() { # <file> <leading spaces>
  grep -m1 -E "^$2\"version\": " "$1" | sed -E 's/.*"version": "([^"]*)".*/\1/'
}
for spec in "package.json:  " "package-lock.json:  " "package-lock.json:      "; do
  file=${spec%%:*}
  found=$(app_version "$file" "${spec#*:}")
  [ "$found" = "0.0.0" ] || fail "$file: the app version is '$found', not 0.0.0; a release is a git and image tag (decisions 2026-11-25)"
done

# An env or compose file naming APP_VERSION, whatever the value (comments aside).
while IFS= read -r file; do
  if grep -E '(^|[^A-Za-z0-9_])APP_VERSION' "$file" | grep -qvE '^[[:space:]]*#'; then
    fail "$file sets APP_VERSION; the image is its only source"
  fi
done < <(git ls-files | grep -E '(^|/)(\.env[^/]*|(docker-)?compose[^/]*\.ya?ml)$|^deploy/.*\.ya?ml$' || true)

[ $rc = 0 ] && echo "release-check: version sources ok"
exit $rc
