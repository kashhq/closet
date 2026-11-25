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

# An area doc holds invariants, gotchas, who-owns-what and pointers (docs/conventions.md, "What an
# area doc holds", #723). A route table, a statement count and a log sentence are prose copies of
# what a spec pins and the code says; they went stale every PR, so each is refused here. The
# patterns are narrow on purpose: a table row naming an HTTP method and a path, a digit before
# "statements" / "queries" / "round trips" (or a statement-count heading), and a bullet that opens
# with a Logs / Logging lead. What must never be logged is a rule, not a format: it goes on a
# `**Never logged**` bullet, which no pattern here matches. Long reference belongs in a
# `reference.md` beside the doc.
# grep exits 1 for no match and 2 for an unreadable input: only 1 is a pass.
closet_prose_patterns=(
  '^[[:space:]]*\|.*\b(GET|POST|PUT|PATCH|DELETE)\b[^|]*/'
  '(^|[^A-Za-z0-9_`-])[0-9]+(\+[0-9]+)? (SQL )?(statements?|queries|round trips?)\b'
  '^#+ (Statements per run|Round trips)\b'
  '^ *- \*\*(Logs?|Logging|Op lines)\*\*'
)
closet_prose_reasons=(
  "a route table row (the route files and their specs are the source)"
  "a statement count (the recordQueries spec pins it)"
  "a statement-count section"
  "a log sentence (the logger call is the source)"
)
# shellcheck disable=SC2154  # agents_files is set by docs_check.sh, which sources this file
for closet_doc in ${agents_files[@]+"${agents_files[@]}"}; do
  case "$closet_doc" in devkit/*) continue ;; esac
  for closet_i in "${!closet_prose_patterns[@]}"; do
    closet_hits=$(grep -n -E -- "${closet_prose_patterns[$closet_i]}" "$closet_doc") && closet_status=0 || closet_status=$?
    case "$closet_status" in
      0)
        while IFS= read -r closet_hit; do
          docs_fail "$closet_doc:${closet_hit%%:*}: ${closet_prose_reasons[$closet_i]}; an area doc keeps invariants and gotchas (docs/conventions.md#what-an-area-doc-holds)"
        done <<<"$closet_hits"
        ;;
      1) ;;
      *) docs_fail "$closet_doc: the area-prose check could not read it (grep exit $closet_status)" ;;
    esac
  done
done

# The original project's name never comes back (#1225): Closet is MIT since 2026-11-25, every
# inherited line rewritten, and nothing in the tree names where it began; docs/decisions.md's
# relicense entry is the one place allowed to. The patterns are spelled so that this file does not
# match itself. git grep exits 1 for no match: only that is a pass.
closet_old_name=$(git grep -n -I -i -E 'libre[ ._-]?closet|lazz[t]ech' -- ':!docs/decisions.md') && closet_old_status=0 || closet_old_status=$?
case "$closet_old_status" in
  0)
    while IFS= read -r closet_hit; do
      docs_fail "names the original project (#1225, docs/conventions.md): ${closet_hit%%:*}"
    done <<<"$closet_old_name"
    ;;
  1) ;;
  *) docs_fail "the original-name check could not run git grep (exit $closet_old_status)" ;;
esac
