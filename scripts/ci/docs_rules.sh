# shellcheck shell=bash
# closet's extra docs rules, sourced by devkit/bin/docs_check.sh after its standard checks (pair
# shape, size caps, decisions log, retired tools); contract in that script's header. Uses its
# $agents_files (every tracked AGENTS.md, root first-class) and docs_fail.
#
# The area index: the root AGENTS.md is loaded by every session, an area's AGENTS.md only when
# a file in its directory is read (#104), so the root's "### Area index" section is how an agent
# planning work finds an area's doc. Every area doc must be named there in backticks, and every
# `<path>/AGENTS.md` (or CLAUDE.md) the root names anywhere must exist: a stale pointer misleads
# wherever it is (#119). devkit/ is pinned tooling (untracked, so never in $agents_files), not an area.

closet_area_index() {
  awk '
    $0 == "### Area index" { inside = 1; next }
    inside && /^#/ { exit }
    inside { print }
  ' AGENTS.md
}

closet_index=$(closet_area_index)
if [ -z "$closet_index" ]; then
  docs_fail "AGENTS.md has no \"### Area index\" section"
else
  # shellcheck disable=SC2154  # agents_files is set by docs_check.sh, which sources this file
  for closet_doc in ${agents_files[@]+"${agents_files[@]}"}; do
    case "$closet_doc" in AGENTS.md|devkit/*) continue ;; esac
    case "$closet_index" in
      *"\`$closet_doc\`"*) ;;
      *) docs_fail "$closet_doc is not in AGENTS.md's area index" ;;
    esac
  done
fi

# shellcheck disable=SC2016  # the backticks are literal Markdown, not an expansion
while IFS= read -r closet_named; do
  [ -e "$closet_named" ] || docs_fail "AGENTS.md names $closet_named, which does not exist"
done < <(grep -oE '`[A-Za-z0-9_./-]+/(AGENTS|CLAUDE)\.md`' AGENTS.md | tr -d '`' | sort -u)

# The stack as /about and the llms files tell a stranger it (#641): upstream's claims (NestJS,
# hyperscript, client-side cutouts) went stale in the rebuild, and photos are processed on the
# server, which is a privacy fact.
# grep exits 1 for no match and 2 for an unreadable input: only 1 is a pass, so a moved lang.json
# or an emptied public/ cannot turn the guard into a silent no-op.
closet_stale_stack=$(grep -n -i -E 'nestjs|hyperscript|client-side' src/i18n/en/lang.json public/*.txt) && closet_stale_status=0 || closet_stale_status=$?
case "$closet_stale_status" in
  0)
    while IFS= read -r closet_hit; do
      docs_fail "stale stack claim (NestJS, hyperscript or client-side): $closet_hit"
    done <<<"$closet_stale_stack"
    ;;
  1) ;;
  *) docs_fail "stale-stack check could not read src/i18n/en/lang.json or public/*.txt (grep exit $closet_stale_status)" ;;
esac
