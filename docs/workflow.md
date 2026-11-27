# Workflow: the flow per issue slice

The root AGENTS.md Workflow section names each step and its non-negotiables; this is each step in full (moved here on 2026-10-13 to keep AGENTS.md under its size cap).

1. **A branch** `<issue>-<slug>` (e.g. `12b-bulk-edit`), in its own git worktree when agents work in parallel.
2. **The fast loop locally**: the spec being worked on, and the pre-commit `npm run check` (~80 s).
3. **Push and open a PR** that links the issue (`Part of #12` / `Closes #12`): `make pr BODY_FILE=<file> [TITLE=…] [DRAFT=1]` (devkit/bin/pr_create.sh) opens it on origin, never on gh's default repo.
4. **No pre-merge gate** (devkit 2026-11-02): main is proven at deploy, when the publisher host runs every job of `scripts/ci/gate_plan.sh` on it (`devkit/bin/check_tree.sh`, at most once per 3 h window, a `main-red` issue on red). Run the `ci-*` targets your change touches before you push. Actions runs only the nightly checks and manual runs.
5. **An independent review** of the PR diff.
6. **A review round**: comment `@codex review`, or run `make review PR=<n>` (a local `claude -p` round, its record posted on the PR) when Codex is out of budget. Answer each P0/P1 finding once: fix what's valid or reply with the reason it isn't. Docs-only PRs owe no round.
7. **The merge**: `make merge PR=<n>` (devkit/bin/pr_merge.sh) decides on the review rounds, at most the plan's `DEVKIT_REVIEW_ROUNDS` (3): below the cap a P0/P1 finding wants another round, at the cap only P0 refuses, and P2 and below (P1 too at the cap) are filed as issues. Never `gh pr merge` directly. Squash merges only: one PR is one commit on `main`, and the merged branch is deleted. Merging publishes the image, then deploys.
8. **Fix forward**: parallel branches that each pass alone but clash together (duplicate migration numbers) show on main, at check_tree, and are fixed forward there.

The owner may stop any PR (comment or close).

## Commands and workflow as the root AGENTS.md stated them before #723

Moved here verbatim from the root `AGENTS.md` by #723 (the root now keeps a one-line form of each rule); the root wins where they differ.

### Commands

Each command's detail (flags, timings, what it needs): README's Development section.

```bash
nvm use                       # Node 22, the exact .nvmrc version
npm ci                        # postinstall applies patches/ via patch-package
npm run start:dev             # tsc, node and tailwind, each --watch
npm run build                 # clean, tsc (type-checks), generate
npm run start:prod            # node dist/main.js, as the image runs it; fetches the 940 MB model on first boot
npm run start:test            # the build with background removal stubbed: what Playwright and Lighthouse start
# The CLIs run from dist/ (build first) and never migrate:
npm run maintenance:reconcile # src/maintenance/AGENTS.md, like user:set-password and push:revoke-all
npm run seed                  # src/seed/AGENTS.md
npm run cutout:fetch-model    # src/cutout/AGENTS.md
npm run lint                  # eslint --fix; lint:check is the gate
npm run format                # prettier --write; format:check is the gate

# Test tiers, cheapest first; all but the first need Postgres (a postgres:18 container: README)
npm test                      # Vitest unit projects; test:watch, test:debug
npm run test:int              # Vitest integration: the real app in-process, a scratch database per spec file
npm run test:e2e              # build, then Playwright: test/AGENTS.md
npm run audit:pages           # every page/action as the demo persona (--persona scale: 500 garments) vs docs/perf/
npm run lighthouse            # lhci autorun
npm run test:all              # every Vitest project; test:cov adds v8 coverage
npm run typecheck             # app, tests, scripts, then the service worker
npm run check                 # check:static (format, lint, types) + test:all (~80 s); alias precommit
npm run verify:push           # build + Chromium Playwright (the plan: make ci-e2e)
npm run precommit:full        # check + verify:push + page audit + lighthouse (minutes)
npx drizzle-kit generate --name <what-changed>   # see Changing the schema
docker build --build-arg APP_VERSION=dev -t closet .

# The plan's jobs (scripts/ci/gate_plan.sh), each on its own throwaway Postgres 18
make install                  # git hooks (.githooks/), once per checkout or worktree
make ci-deps ci-quick         # npm ci; guards (docs-check among them), secrets, lint, types
make ci-unit | ci-db | ci-e2e # each reports OVERBUDGET / FLOOR warnings (Workflow)
make perf-compare             # the page audit over the demo and scale personas vs docs/perf/ baselines (docs/perf/README.md)
make ci-metrics               # the metrics report (never fails); make metrics-tighten keeps a cleanup round's gains
make review PR=<n>            # one local review round (when Codex is out of budget)
make merge PR=<n>             # squash-merge once the review rounds allow it
```

Builds, test suites, and `npm ci` go through a `build:build-runner` subagent, never inline.

### Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- **Backlog: GitHub issues, ordered by the pinned Roadmap (#27).** Pull the first unchecked item whose dependencies are done; its issue links to its design section in `docs/plans/` and lists the acceptance criteria. Open work and status live in issues, not in docs or memory. New ideas go in the **Later** milestone with where they were seen.
- Before implementing, read `docs/PROJECT_LOG.md` and this file for decisions and gotchas in the area.
- Plan in plain text and get approval before writing code or spawning implementers. Approval of a goal is not approval of an implementation.
- **Tests are budgeted and lean** (owner directive 2026-10-13; `test/AGENTS.md`): `make ci-unit` ≤ 60 s, `ci-db` ≤ 110 s (integration workers share their module graph: no `vi.mock` there), `ci-e2e` ≤ 180 s, each with a collected-count floor; the tier guard reports OVERBUDGET / FLOOR warnings, it does not fail. A test earns its place: it fails for a plausible regression in our code, proves what no kept test proves, is hermetic, and runs at the cheapest tier that can prove it. Behavior assertions go in `test/integration/` (the real app in-process); Playwright is held by the `ci-e2e` time budget, not a scenario count: a scenario earns its place by what only a browser shows.
- **Metrics are an on-demand report for cleanup rounds, not a per-PR gate** (`make ci-metrics` prints WORSE/BETTER and exits 0; complexity, dead code, import cycles, duplication, coverage lines and branches): a cleanup round reads it and runs `make metrics-tighten` to keep its gains. No label, no tighten commit per PR (devkit decisions 2026-11-13). Coverage is read from `make ci-db`'s report; vitest has no thresholds (`docs/decisions.md` 2026-10-16).
- **Before a feature is called done** it is verified in a browser as an installed PWA at phone width (type checks and tests verify code, not the app): Playwright at 390 px, locally in the one worktree not racing another for `:3000`, or from CI's uploaded artifacts.
- **Changes land through pull requests** (owner decision 2026-09-26), per issue slice (in full: `docs/workflow.md`): a branch `<issue>-<slug>` (own worktree when agents run in parallel); the fast loop locally; a PR linking its issue; a review round (`@codex review`, or `make review PR=<n>` at Codex's limit; docs-only PRs owe none), its P0/P1 findings answered once; `make merge PR=<n>` squash-merges. No pre-merge gate (devkit 2026-11-02): at most `DEVKIT_REVIEW_ROUNDS` (3) rounds; below the cap P0/P1 block, at it only P0, the rest filed as issues. Parallel branches that clash show on main and are fixed forward. Merging publishes, then deploys; the owner may stop any PR.
- **Migrations and parallel branches:** two branches that each generate `NNNN` collide in `drizzle/meta/_journal.json`. The later branch rebases on `main`, deletes its migration and snapshot, and regenerates (`npx drizzle-kit generate`); the drift test (ci-db) proves the result. Never hand-merge a journal.
- pre-commit runs guards, staged secrets and lint; pre-push typecheck and unit; never bypass either with `--no-verify`. If a hook fails, fix and create a new commit, never amend.
- Commit messages: concise, why over what.
- When a new pattern or gotcha lands, write it in its area's `AGENTS.md` (the area index; this file only for what every change needs) in the same commit, and add a dated `docs/decisions.md` entry for the decision behind it in the same change.
- No upstream: closet merges from nowhere else and every line in it is its own (#1225). Restructure freely.
