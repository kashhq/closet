# devkit/ is not tracked: .devkit-bootstrap.sh materializes the commit .devkit-rev pins (devkit
# docs/plans/2026-11-13-stop-vendoring.md). GNU make remakes this include, then restarts, so every
# target (install, the hooks' ci-* steps, check_tree) runs with devkit/ at the pin. SHELL is /bin/sh
# for this one rule because the repo's SHELL lives under devkit/bin. Not `-include`: that would hide
# a failed bootstrap. macOS's make 3.81 prints "No such file or directory" once before remaking it.
include devkit/.devkit-materialized.mk
devkit/.devkit-materialized.mk: SHELL := /bin/sh
devkit/.devkit-materialized.mk: .devkit-rev .devkit-bootstrap.sh devkit/.devkit-materialized ; @./.devkit-bootstrap.sh && touch $@
devkit/.devkit-materialized: ;

.PHONY: help lg-check-staged ci-deps ci-quick ci-guards ci-guards-staged devkit-check-staged ci-lint ci-typecheck secrets-staged ci-unit ci-db ci-e2e ci-image ci-smoke ci-metrics perf-compare metrics-snapshot metrics-tighten metrics-rebaseline screenshots gate pr merge review publish devkit-sync devkit-check toolchain-check release-check workflows-check docs-check hooks-check layer-check guard-check plain-js-check lg-check migration-check secrets-check actionlint-check install

# Thin callers: the npm scripts in package.json stay the definitions of each check. These
# targets add only what a clean machine needs around them (a throwaway Postgres, browsers,
# e2e env), so the PR gate (scripts/ci/gate_plan.sh), the publisher host (`make publish`) and
# ci.yml's manual jobs run the same thing.
# Run `make ci-deps` once first; the other ci-* targets assume node_modules.

# Every recipe line runs on .nvmrc's Node, not PATH's (devkit #166): a hand-run target and the
# check_tree read the same toolchain.
SHELL := devkit/bin/toolchain_shell.sh

PG := devkit/bin/throwaway_pg.sh
# One container name per caller; check_tree passes closet-gate-pg-<run> and removes it on exit.
# A hand run's name carries its worktree (`throwaway_pg.sh name`, devkit #162), so two
# worktrees never share one; Docker picks the port. ci-db and ci-e2e each bring it up fresh
# and take it down, so they never share data.
PG_CONTAINER ?= $(shell $(PG) name closet-ci-pg)
# --with-deps on Linux runners (system libraries); ignored on macOS.
PLAYWRIGHT_FLAGS ?=
CI_IMAGE ?= closet:ci
# The image's APP_VERSION (Dockerfile ARG): check_tree passes gate-<run>, publish.sh the bare 7-char
# sha of the main it builds. ci-smoke asserts /health/ready reports it.
CI_BUILD_VERSION ?= dev
SMOKE_PG_CONTAINER ?= $(shell $(PG) name closet-smoke-pg)

# Test-tier budgets and floors (owner directive 2026-10-13, docs/decisions.md "Lean test suite"):
# devkit's tier guard reports a tier over its wall-clock budget (OVERBUDGET) and one that ran fewer tests than
# the floor (FLOOR); neither fails the run, so read the warnings (a lost glob shows only as FLOOR),
# counting the runner's own summary line: tests that ran, never skipped ones. It prints one
# `TIER <tier>` line and writes build/metrics/tier-<tier>.json. The floors are the counts at the
# last change to the suite: raise them with new tests; lower them only in the PR that removes
# tests, saying why.
TIER := devkit/bin/tier_guard.sh
UNIT_BUDGET_SECONDS := 60
# db: 110 s, about twice its worst gate-like run (56 s beside e2e and an uncached image build;
# 51 s in PR #387's gate). docs/decisions.md 2026-10-14.
DB_BUDGET_SECONDS := 110
E2E_BUDGET_SECONDS := 180
# smoke: the container boot and probes took 5 s in PR #415's gate; smoke-image.sh's own bounds
# (boot 60 s, cutout 240 s) catch a hang, this catches a boot that slowly grew.
SMOKE_BUDGET_SECONDS := 120
UNIT_FLOOR := 1773
DB_FLOOR := 7869
E2E_FLOOR := 10
E2E_VITEST_FLOOR := 9

help:
	@echo "make ci-deps          — npm ci (patches applied by postinstall)"
	@echo "make install          — once per checkout or worktree: materialize devkit/, devkit-check, then point core.hooksPath at .githooks"
	@echo "make perf-compare     — the page audit over the demo and scale personas against docs/perf/'s baselines; prints regressions"
	@echo "make ci-quick        — ci-guards, secrets-check, ci-lint, ci-typecheck (the two git hooks split it: scripts/ci/hooks.conf)"
	@echo "make ci-guards        — devkit-check, toolchain-check, release-check, workflows-check, actionlint-check, docs-check, layer-check, guard-check, plain-js-check, migration-check"
	@echo "make ci-lint          — prettier format:check, eslint lint:check (both cached), then the changed-file rules"
	@echo "make ci-typecheck     — tsc over the server (incremental) and views/assets"
	@echo "make ci-unit          — the Vitest unit projects; no database. Budget $(UNIT_BUDGET_SECONDS) s, floor $(UNIT_FLOOR) tests"
	@echo "make ci-db            — every Vitest project with v8 coverage (the ratchet's cov input), on a throwaway Postgres 18. Budget $(DB_BUDGET_SECONDS) s, floor $(DB_FLOOR)"
	@echo "make ci-e2e           — build, then Playwright chromium against a throwaway Postgres 18 (PWA on, PORT random). Budget $(E2E_BUDGET_SECONDS) s, floor $(E2E_FLOOR)"
	@echo "make screenshots      — the 390 px (and 1440 px) persona screenshots (test/screenshots.spec.ts) into screenshots/, same server as ci-e2e"
	@echo "make ci-image         — docker build of the production image (CI_IMAGE=$(CI_IMAGE), CI_BUILD_VERSION=$(CI_BUILD_VERSION))"
	@echo "make ci-smoke         — boot CI_IMAGE on a throwaway Postgres 18 (scripts/smoke-image.sh); /health/ready must report CI_BUILD_VERSION"
	@echo "make ci-metrics       — the metrics report (never fails): scripts/ci/metrics.conf's collectors against docs/metrics/ratchet.json; run it in a cleanup round"
	@echo "make metrics-snapshot — run the collectors; build/metrics.json is the report"
	@echo "make metrics-tighten  — keep a cleanup round's gains in docs/metrics/ratchet.json"
	@echo "make metrics-rebaseline KEYS=<key>[,<key>] — loosen only those bounds (no label; optional)"
	@echo "make gate             — retired (devkit 2026-11-02): prints the review/merge path below"
	@echo "make pr BODY_FILE=<f> — push the branch and open its PR on origin [TITLE=…] [DRAFT=1]"
	@echo "make review PR=<n>    — one local review round: claude -p over PR <n>'s diff, its record posted"
	@echo "make merge PR=<n>     — squash-merge PR <n> once its review rounds allow it"
	@echo "make publish          — the publisher host's timer only: move ghcr.io/kashhq/closet:latest to the newest green main"
	@echo "make devkit-sync      — pin the latest kashhq/devkit in .devkit-rev (a one-line commit) and materialize it"
	@echo "make devkit-check     — fail if the materialized devkit/ differs from .devkit-rev (part of ci-quick)"
	@echo "make toolchain-check  — fail if a Dockerfile or workflow disagrees with the Node in .nvmrc (part of ci-quick)"
	@echo "make release-check    — fail unless the image is APP_VERSION's only source (part of ci-quick)"
	@echo "make workflows-check  — fail unless the workflows follow devkit's Actions rules (part of ci-quick)"
	@echo "make actionlint-check — fail unless every .github/workflows file is valid to actionlint (scripts/ci/actionlint.sh; part of ci-quick)"
	@echo "make docs-check       — AGENTS.md real + CLAUDE.md symlink, size caps, the area index (part of ci-quick)"
	@echo "make layer-check      — fail on an import in src/ that reaches up scripts/ci/layers.conf's layer stack (part of ci-quick)"
	@echo "make guard-check      — fail on a code-structure rule in scripts/ci/guards.conf (devkit/bin/guard_check.py; part of ci-quick)"
	@echo "make plain-js-check   — fail on a new plain-JS module in public/js/, or a converted one still listed in scripts/ci/plain_js.conf (part of ci-quick)"
	@echo "make lg-check         — fail when a page file's lg: count grows past scripts/ci/lg_count.conf, or shrinks without lowering it (scripts/lg-check.ts, Tailwind's own scanner and compiler; its tests are scripts/lg-check.spec.ts in ci-unit; part of ci-quick)"
	@echo "make migration-check  — fail on an edit to a shipped drizzle migration (devkit/bin/migration_check.py; part of ci-quick)"
	@echo "make secrets-check    — fail on a credential committed in the tree (devkit/bin/secrets_check.sh; part of ci-quick)"
	@echo "make secrets-staged   — the same scan over the staged paths only (the pre-commit hook's half)"
	@echo "make ci-guards-staged — ci-guards with devkit-check reading the index (the pre-commit hook's half)"
	@echo "make hooks-check      — fail unless core.hooksPath is .githooks and both hooks are executable"

ci-deps:
	npm ci --no-audit --no-fund

# The union of the parts below; check_tree and ci.yml run it whole, the hooks in two halves
# (scripts/ci/hooks.conf), so a part added here must be added to a hook too.
ci-quick: ci-guards secrets-check ci-lint ci-typecheck

# Sub-second each and stdlib only, except lg-check (Node, needs npm ci). ci-guards-staged is the pre-commit
# hook's copy: devkit-check judges the staged gate_plan.sh (devkit #124 reads the working tree
# by default, which let a bad staged plan through when only the disk copy was fixed).
GUARDS_AFTER_DEVKIT := toolchain-check release-check workflows-check actionlint-check docs-check layer-check guard-check plain-js-check migration-check
ci-guards: devkit-check $(GUARDS_AFTER_DEVKIT) lg-check
ci-guards-staged: devkit-check-staged $(GUARDS_AFTER_DEVKIT) lg-check-staged

# Formatting is prettier's alone (format:check); eslint does not run prettier as a rule, which
# read every file a second time (a third of a cold lint). Caches live in node_modules/.cache, so a
# fresh worktree's first lint is cold. changed_lint holds the rules with debt on main (sonarjs
# expression-complexity: 2 on 2026-10-19) to the files this branch touches (devkit #161).
ci-lint:
	npm run format:check
	npm run lint:check
	python3 -I devkit/bin/changed_lint.py eslint --root . --src src test scripts

ci-typecheck:
	npm run typecheck

# The floors read the default and list reporters' summary lines: keep those reporters.
ci-unit:
	$(TIER) unit --budget $(UNIT_BUDGET_SECONDS) --floor vitest=$(UNIT_FLOOR) -- npm test

# The whole suite, not only the integration project: coverage is measured over both tiers, and
# coverage/coverage-summary.json is what the metrics ratchet's `cov` collector reads
# (scripts/ci/metrics.conf, job:db), so splitting the run would change the ratcheted number.
# Each spec file clones the migrated template inside this container (migrations once per run;
# test/support/scratch-database.ts reads TEST_DATABASE_URL). STATEMENTS_OUT: the statement
# counts the specs pin (recordQueries; test/support/statement-budgets.ts), which the `statements`
# collector (scripts/ci/metrics.conf) turns into ratchet keys. Outside build/metrics/: metrics_collect.sh
# clears its collectors' files there before a run.
ci-db:
	@$(PG) up $(PG_CONTAINER) >/dev/null
	@trap '$(PG) down $(PG_CONTAINER)' EXIT INT TERM; \
	  TEST_DATABASE_URL=$$($(PG) url $(PG_CONTAINER)) || exit 1; \
	  export TEST_DATABASE_URL STATEMENTS_OUT=build/statements.json; \
	  $(TIER) db --budget $(DB_BUDGET_SECONDS) --floor vitest=$(DB_FLOOR) -- npm run test:cov

# As production: the PWA on, so the service-worker specs run instead of skipping. Web Push
# needs an https: SITE_URL as its VAPID subject (nothing is fetched from it) and a key pair,
# generated per run unless the caller passes one. A random PORT keeps parallel worktrees off
# :3000, where Playwright would otherwise reuse whatever server listens. The Playwright run
# alone is budgeted (the build is outside the budget). $(1) is the
# Playwright command, $(2) the target's name for the log line; `screenshots` reuses it.
define e2e_server
	devkit/bin/playwright_browsers.sh $(PLAYWRIGHT_FLAGS) chromium
	npm run build
	@port=$$($(PG) up $(PG_CONTAINER) | sed -n 's/^PG_PORT=//p'); \
	  trap '$(PG) down $(PG_CONTAINER)' EXIT INT TERM; \
	  [ -n "$$port" ] || exit 1; \
	  if [ -z "$${PUBLIC_VAPID_KEY:-}" ]; then \
	    keys=$$(node -e "const k = require('web-push').generateVAPIDKeys(); console.log(k.publicKey, k.privateKey)") || exit 1; \
	    PUBLIC_VAPID_KEY=$${keys% *}; PRIVATE_VAPID_KEY=$${keys#* }; \
	  fi; \
	  export PUBLIC_VAPID_KEY PRIVATE_VAPID_KEY \
	    CI=true APP_ENV=gate PWA_ENABLED=true SITE_URL=https://closet.test \
	    ACCESS_TOKEN_SECRET=ci-only-access-token-secret-not-for-deployment \
	    DATABASE_HOST=127.0.0.1 DATABASE_PORT=$$port DATABASE_USER=ci DATABASE_PASS=ci DATABASE_NAME=ci \
	    PORT=$${PORT:-$$(awk 'BEGIN { srand(); print 3200 + int(rand() * 600) }')}; \
	  echo "$(2): app on :$$PORT, Postgres $(PG_CONTAINER) on :$$port"; \
	  $(1)
endef

ci-e2e:
	$(call e2e_server,$(TIER) e2e --budget $(E2E_BUDGET_SECONDS) --floor playwright=$(E2E_FLOOR) --floor vitest=$(E2E_VITEST_FLOOR) -- npm run test:e2e:ci,ci-e2e)

# Not a gate: 390 px (and a 1440 px block of) screenshots of the seed personas into screenshots/ (ci.yml's e2e job uploads
# them). test/screenshots.spec.ts runs only with SEED_SCREENSHOTS, which playwright.config.ts
# otherwise ignores the file under.
screenshots:
	$(call e2e_server,SEED_SCREENSHOTS=1 npx playwright test test/screenshots.spec.ts --project=chromium,screenshots)

# Build only (devkit-check's publish contract): the image's own boot (health, migrations, SIGTERM)
# is ci-smoke, which check_tree and devkit/bin/publish.sh run next. Plain `docker build` for the
# host's platform: the publisher host (amd64) builds the image it ships.
ci-image:
	DOCKER_CALL_TIMEOUT=900 devkit/bin/docker_bounded.sh build --build-arg APP_VERSION=$(CI_BUILD_VERSION) -t $(CI_IMAGE) .

# The smoke test the publisher runs on the image it then pushes: CI_IMAGE (built by ci-image) on
# the host network against a throwaway Postgres 18 published on loopback, and /health/ready must
# name CI_BUILD_VERSION. A random SMOKE_PORT keeps parallel runs off each other.
ci-smoke:
	@port=$$($(PG) up $(SMOKE_PG_CONTAINER) | sed -n 's/^PG_PORT=//p'); \
	  trap '$(PG) down $(SMOKE_PG_CONTAINER)' EXIT INT TERM; \
	  [ -n "$$port" ] || exit 1; \
	  DATABASE_HOST=127.0.0.1 DATABASE_PORT=$$port DATABASE_USER=ci DATABASE_PASS=ci DATABASE_NAME=ci \
	    SMOKE_PORT=$${SMOKE_PORT:-$$(awk 'BEGIN { srand(); print 3800 + int(rand() * 600) }')} \
	    BOOT_EXPECT_VERSION=$(CI_BUILD_VERSION) $(TIER) smoke --budget $(SMOKE_BUDGET_SECONDS) -- scripts/smoke-image.sh $(CI_IMAGE)

# Metrics ratchet (devkit README "Metrics ratchet"): devkit/bin/metrics_collect.sh owns which
# collectors run, the merge and the comparison with main's bounds. Needs node_modules (ci-deps)
# and origin/main fetched.
ci-metrics:
	devkit/bin/metrics_collect.sh check

# The page audit over both personas against their committed baselines (docs/perf/README.md): prints
# every step whose statements, rows or bytes changed and every time past the noise, and exits 0.
# For a perf-sensitive PR and the publisher's occasional check: about 36 minutes for both, most of it
# waiting out rate limits (scale's walk is about 18); `npm run audit:pages -- --only` times a few steps.
# Output under scripts/results/ (gitignored), on a throwaway Postgres.
perf-compare:
	@$(PG) up $(PG_CONTAINER) >/dev/null
	@trap '$(PG) down $(PG_CONTAINER)' EXIT INT TERM; \
	  TEST_DATABASE_URL=$$($(PG) url $(PG_CONTAINER)) || exit 1; \
	  export TEST_DATABASE_URL; \
	  npm run audit:pages -- --persona demo --compare docs/perf/baseline.json --out scripts/results/audit-demo \
	    && npm run audit:pages -- --persona scale --compare docs/perf/baseline-scale.json --out scripts/results/audit-scale

metrics-snapshot:
	devkit/bin/metrics_collect.sh snapshot

metrics-tighten:
	devkit/bin/metrics_collect.sh tighten

# The ratchet's fix lines name this target with the WORSE keys filled in. KEYS=<key>[,<key>]
# (make's command line; devkit #116) loosens only those bounds; without KEYS nothing changes.
metrics-rebaseline:
	devkit/bin/metrics_collect.sh rebaseline

# Retired (devkit 2026-11-02: no pre-merge gate). devkit/bin/gate.sh only prints the merge path
# (make review, then make merge); the target stays so an old runbook's `make gate` cannot fail.
gate:
	@devkit/bin/gate.sh

pr: ; devkit/bin/pr_create.sh

# The only merge path: squash-merges once the PR's review rounds allow it (Codex's, or
# `make review`'s; DEVKIT_REVIEW_ROUNDS, devkit/bin/merge_rules.sh), posting the codex-review
# status GATE_MERGE_REQUIRES names (scripts/ci/gate_plan.sh) itself; never `gh pr merge` by hand.
merge: ; devkit/bin/pr_merge.sh "$(PR)"

review: ; devkit/bin/pr_review.sh "$(PR)"

# Run by homelab's devkit-publish@closet.timer on the publisher host (check_tree at most once per 3 h window), never by hand on a Mac
# (it refuses anything but native amd64). devkit README "Publish".
publish:
	devkit/bin/publish.sh .

devkit-sync:
	devkit/bin/devkit-sync.sh

devkit-check:
	devkit/bin/devkit-check.sh

devkit-check-staged:
	devkit/bin/devkit-check.sh --staged

toolchain-check:
	devkit/bin/toolchain_check.sh

release-check:
	devkit/bin/release_check.sh

workflows-check:
	devkit/bin/workflows_check.sh

actionlint-check:
	scripts/ci/actionlint.sh

# Devkit's rules, plus closet's area index (scripts/ci/docs_rules.sh). Caps allowlist, if one is
# ever needed: scripts/ci/docs_oversize.txt.
docs-check:
	devkit/bin/docs_check.sh

hooks-check:
	devkit/bin/hooks_check.sh

# Imports in src/ point down the layer stack in scripts/ci/layers.conf (shared, infra|pure, metrics,
# db, cutout, web, maintenance, seed; the entries on top); an upward edge is a `known` line there,
# which only shrinks. Stdlib only, so it runs before npm ci.
layer-check:
	python3 -I devkit/bin/layer_check.py

# Code-structure rules (scripts/ci/guards.conf: the outbound-fetch door, seeded randomness, no
# config loading in src/web/); debt is a `known` line there, which only shrinks
# (guards.backend.known). Stdlib only, so it runs before npm ci.
guard-check:
	python3 -I devkit/bin/guard_check.py

# The page's plain-JS modules (public/js/*.js) only shrink: scripts/ci/plain_js.conf lists them,
# a new one fails, a converted one fails until its line goes (#713). Reads the index, so the
# pre-commit hook judges what is staged. Shell only, so it runs before npm ci.
plain-js-check:
	scripts/ci/plain-js-check.sh

# Page-level `lg:` classes in src/web are counted per file against scripts/ci/lg_count.conf, which
# only shrinks (#1066; the desktop layout plan's principle 7). Unlike its neighbours it needs
# node_modules: it compiles each class with Tailwind (ci-quick runs after ci-deps).
lg-check:
	node -r ts-node/register/transpile-only scripts/lg-check.ts

# The pre-commit hook's half: the conf, the file list and every file read from the index.
lg-check-staged:
	node -r ts-node/register/transpile-only scripts/lg-check.ts --staged

# A migration on origin/main has run on the deployed database: never edit or delete it, fix forward
# (the `migration-contract` label passes a deliberate edit). drizzle-kit's append to
# drizzle/meta/_journal.json is not an edit. Stdlib only, like layer-check.
migration-check:
	python3 -I devkit/bin/migration_check.py --versions drizzle --kind drizzle

# Committed credentials (scorecard T11): devkit's pattern scan over the tracked tree. Shell only,
# so it runs before npm ci.
secrets-check:
	devkit/bin/secrets_check.sh .

# pre-commit's half: only the staged paths. check_tree's ci-quick still scans the whole tree.
secrets-staged:
	devkit/bin/secrets_check.sh --staged .

# Steps: scripts/ci/hooks.conf. --fix rewrites core.hooksPath, so a tool that repointed it is
# undone by the next install.
install: devkit-check
	devkit/bin/hooks_check.sh --fix
