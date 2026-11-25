# closet's plan, sourced by devkit/bin/check_tree.sh, which the publisher
# (devkit/bin/publish.sh) runs on main at most once per 3 h window: every job on a clean
# worktree, and only a green commit ships (a red one files `main-red`). No pre-merge gate (devkit
# 2026-11-02). devkit's default plan (devkit/bin/_paths_lib.sh) owns the area groups; closet adds
# only the rules the fleet table cannot express. Every job is a Makefile target.
#
#   docs only (*.md, docs/**)          -> docs (docs-check), no npm ci
#   tooling only (devkit/ guards and   -> deps + quick; + image when devkit's contract probe or
#     gate machinery, .devkit-rev, ...)   boot script changed (devkit's IMAGE group)
#   anything else ("other": closet's      -> deps + quick, then closet's own rules
#     src/ and test/ lie outside the       (gate_plan_extra), per path:
#     fleet's backend/frontend dirs)
#       LICENSE, .github/**             -> nothing more (Actions files; no plan job reads them)
#       docs/metrics/ratchet.json,      -> + db (the cov collector reads its coverage report)
#         scripts/ci/metrics.conf
#       test/integration/**             -> + db
#       test/support/**                 -> + db + e2e: scratch-database.ts and the integration
#                                          globalSetup, which both tiers import
#       other test/** (Playwright)      -> + e2e
#       anything else                   -> + db + e2e (src, views, public, drizzle, scripts,
#                                          package*.json, configs, Makefile, devkit/ job scripts)
#   any app path but GATE_IMAGE_EXCLUDE_PATHS -> + image (ci-image, then ci-smoke)
#   any non-docs path                  -> + metrics (ci-metrics, devkit's METRICS group, last)
#
# db and e2e live in gate_plan_extra, not the BACKEND/E2E groups: closet's whole app is the
# fleet's "other", and an area group would run both tiers for a Playwright-only or .github-only
# change. Order: deps, quick, image, db, e2e, metrics (the default plan runs its groups, then the
# extra, then METRICS).
# shellcheck disable=SC2034  # read by the sourcing skeleton and devkit_default_gate_plan
GATE_SLUG=kashhq/closet
# Public and forked: devkit-check's check_public_topology refuses homelab topology (devkit 2026-11-12).
# shellcheck disable=SC2034
GATE_PUBLIC=1
# What devkit/bin/publish.sh pushes to (read as this literal line, never sourced).
# shellcheck disable=SC2034
PUBLISH_IMAGE=ghcr.io/kashhq/closet
# How main ships, and so what proves it (devkit README "Deploy kinds").
# shellcheck disable=SC2034
DEPLOY_KINDS=image
# make merge (devkit/bin/pr_merge.sh) posts the review round as this status on the head before
# merging (devkit/bin/merge_rules.sh header); never post it by hand.
# shellcheck disable=SC2034
GATE_MERGE_REQUIRES=codex-review
# The scorecard's codex_review track reads this line; make merge decides on review rounds alone.
# shellcheck disable=SC2034
GATE_CODEX_REVIEW=1

PG_CONTAINER="closet-gate-pg-$PR"
SMOKE_PG_CONTAINER="closet-gate-smoke-pg-$PR"
IMAGE="closet:gate-$PR"

# deps first: ci-quick's lint and typecheck and every test tier need node_modules, and QUICK runs
# for every area that can run db or e2e (gate_plan_extra checks that anyway).
# shellcheck disable=SC2034
GATE_JOBS_QUICK="deps ci-deps|quick ci-quick"
# shellcheck disable=SC2034
GATE_JOBS_DOCS="docs docs-check"
# The build, then the image booted on its own throwaway Postgres (scripts/smoke-image.sh:
# /health/ready names CI_BUILD_VERSION, the observability contract probe): what publish.sh runs at
# main on the bytes it pushes, proved here before the merge.
# shellcheck disable=SC2034
GATE_JOBS_IMAGE="image ci-image ci-smoke CI_IMAGE=$IMAGE CI_BUILD_VERSION=gate-$PR SMOKE_PG_CONTAINER=$SMOKE_PG_CONTAINER"
# Every app path runs the image (devkit #115 retired the per-area override). These are the app
# paths no Dockerfile stage COPYs (closet has no .dockerignore: the Dockerfile's COPY list is the
# image's input set), so they cannot change what the image builds or boots. Keep it in step with
# the Dockerfile: a new COPY of one of these paths must drop it from here.
# shellcheck disable=SC2034
GATE_IMAGE_EXCLUDE_PATHS='^(\.github/|test/|docs/metrics/|(playwright|vitest|drizzle)\.config\.ts$|eslint\.config\.mjs$|knip\.jsonc$|lighthouserc\.js$|renovate\.json$)'

# Both vitest tiers again with the wall clock shifted (devkit README "Clock shift"), each once per
# offset before the real-clock db run, which rewrites the coverage report the ratchet reads. The
# CLOCK group runs on every "other" path, so a .github- or Playwright-only change pays for it too:
# no finer area exists, and a date bug is cheapest caught on the PR that writes it.
# Exceptions: scripts/ci/clock_shift.conf.
# shellcheck disable=SC2034
GATE_JOBS_CLOCK="clock-unit ci-unit|clock-db ci-db PG_CONTAINER=$PG_CONTAINER"

gate_cleanup() {
  "$ROOT/devkit/bin/throwaway_pg.sh" down "$PG_CONTAINER"
  "$ROOT/devkit/bin/throwaway_pg.sh" down "$SMOKE_PG_CONTAINER"
  docker rmi -f "$IMAGE"
}

gate_plan() { devkit_default_gate_plan; }

gate_plan_extra() {
  local db=0 e2e=0 path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    # docs, tooling and native paths are the default plan's; the rest is closet's layout.
    case "$(devkit_classify_path "$path")" in docs|tooling|native) continue ;; esac
    case "$path" in
      LICENSE|.github/*) ;;
      # The ratchet's bounds and collectors (other since devkit f6bf01f): db, so the cov
      # collector (job:db) measures instead of SKIPPING; no browser can see them.
      docs/metrics/ratchet.json|scripts/ci/metrics.conf) db=1 ;;
      test/support/*) db=1; e2e=1 ;;
      test/integration/*) db=1 ;;
      test/*) e2e=1 ;;
      *) db=1; e2e=1 ;;
    esac
  done <<< "$CHANGED"
  echo "GATE scope db=$db e2e=$e2e"

  # Unreachable while QUICK keeps its default areas; kept so a narrowed QUICK cannot run a
  # test tier without node_modules.
  if [ "$db$e2e" != 00 ] && ! devkit_group_ran quick; then job deps ci-deps; fi

  # 21 integration specs bind 127.0.0.2 (test/integration/link-sites.ts); without the alias
  # they fail with EADDRNOTAVAIL, which reads like a code failure.
  if [ "$db" = 1 ] && [ "$(uname -s)" = Darwin ] && ! ifconfig lo0 | grep -q 'inet 127\.0\.0\.2 '; then
    note "127.0.0.2 missing on lo0 (sudo ifconfig lo0 alias 127.0.0.2); the db job will fail"
  fi

  if [ "$db" = 1 ]; then
    job db ci-db PG_CONTAINER="$PG_CONTAINER"
  else
    skip db "no source, integration or test-support changes"
  fi

  if [ "$e2e" = 1 ]; then
    job e2e ci-e2e PG_CONTAINER="$PG_CONTAINER"
  else
    skip e2e "no source, Playwright or test-support changes"
  fi
}
