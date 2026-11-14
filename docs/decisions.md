# Decisions

Dated decisions, their rationale and the gotchas they carry. Newest last (devkit's docs-check;
the union merge appends); the 2026-10-13 block predates that rule and reads newest first. The
older history lives in `docs/PROJECT_LOG.md`.

## 2026-10-13 — Tier budgets and floors through devkit's tier guard

**Why:** `scripts/ci/budget.sh` and `scripts/ci/test_floor.py` were closet's copy of what five repos built separately; devkit 4f5f282 ships the one implementation (`devkit/bin/tier_guard.sh`).
**Decision:** ci-unit, ci-db and ci-e2e run under `$(TIER) <tier> --budget … --floor vitest=…|playwright=… -- <cmd>`; both scripts, the JSON reporters and `build/test/` are gone, and the floor reads the runner's summary line (tests that ran, as test_floor.py counted). `CI_BUDGET_ENFORCE` is now `TIER_BUDGET_ENFORCE`. Budgets 60/180/180 and floors 1486/4472/10 are unchanged.
**Consequence:** each tier prints one `TIER <tier>` line and writes `build/metrics/tier-<tier>.json` beside `statements.json`. Measured under the lock, 4 workers: unit 1498 tests in 5 s, db 4489 in 103 s, e2e 10 in 17 s.

## 2026-10-13 — devkit 4f5f282: union-merged decisions log, tier names, one tier guard

**Why:** devkit 4f5f282 adds three guards (`docs/decisions.md merge=union`, `ci-<tier>-<area>` target names, no privileged port in a non-root image) and `bin/tier_guard.sh`, the fleet's one budget-and-floor runner.
**Decision:** sync, then adopt in this PR: the union line in `.gitattributes`, and the tier guard in place of closet's own budget and floor scripts (next entry). closet's targets already follow the naming rule and its image runs as root, so neither of the other guards asks for a change.
**Consequence:** two PRs that each append a decisions entry no longer conflict on rebase.

## 2026-10-13 — /health/live and /health/ready

**Why:** `observability.md`'s health contract: closet answered `/healthz` `{status: "ok", version}` checking nothing, the image had no `HEALTHCHECK`, and the smoke's probe could only run `--live`.
**Decision:** `src/web/health`: `/health/live` checks nothing (the PWA heartbeat moves to it, so a down database never reads as offline); `/health/ready` checks `database` + `migrations` (required, one statement under 3 s: the newest recorded migration against this build's) and `cron_jobs` + `cutout_queue` (optional, as locus and Orbit: every page serves without them, and a restart loop would cost the household the app). A timer's hung run is the one way it stops, so `JobRoster` reports a run in flight past 30 min. `/healthz` is the ready handler, for cached clients. Rate-limited per address as the convention says (`HEALTH_LIMIT`, one checker for both paths): closet has no in-container proxy and `TRUSTED_PROXIES` covers Caddy, so no delta. Dockerfile `HEALTHCHECK` on `/health/ready` via node's fetch; the smoke polls it and probes `--live /health/live --health /health/ready`.
**Consequence:** production's container reports health from the next deploy; homelab still has to add the `autoheal: "true"` label (and `pids_limit`, `no-new-privileges`). The image still runs as root (a separate change: the data volume's ownership). Remove `/healthz` once no phone HEADs it (its requests have no access line; the Caddy log shows them).

## 2026-10-13 — Lean test suite: budgets per tier, ten e2e scenarios, migrations once per run

**Why:** the owner directive ("a FAST, lean, useful test suite", 2026-10-13) and the gate's clock: the db tier took 278 s (1479 unit and 3036 integration tests, the latter in 136 files, every file migrating its own database and hashing passwords at bcrypt cost 12) and the e2e tier 356 s (61 Playwright files, 220 chromium tests, most re-proving what the integration tier already proves or what only a phone shows). Specs of shipped migrations tested frozen SQL that no change of ours can break.
**Decision:** budgets in the Makefile (`scripts/ci/budget.sh`: unit ≤ 60 s, db ≤ 180 s, the owner's tier budget: the gate runs it beside e2e and the image build, 160 s there against 83 s alone; e2e ≤ 180 s) with collected-count floors (`scripts/ci/test_floor.py`; UNIT*FLOOR/DB_FLOOR/E2E_FLOOR). Infrastructure first: `PASSWORD_HASH_ROUNDS` (4 in every test tier; refused under 12 when `APP_ENV=production`) and one migrated template database per run (`closet_tpl*<hash of drizzle/>`, cloned per spec file; `test/support/scratch-database.ts`). Then the cuts: the 14 shipped-migration specs and `migrateBefore`(53 tests); Playwright from 61 files to ten scenarios, one per file (login, add from a photo, style an outfit, plan on the calendar, wear and wash, a trip, a shared wardrobe, the offline shell, the worker's update, the image cache across sessions);`screenshots.spec.ts`becomes`make screenshots`, off the gate; the calendar-date sweep keeps boundary years. The gate's image job now runs `ci-image`then`ci-smoke`.
**Consequence:** measured on the Mac under the gate's lock, 4 workers: unit 1486 tests in 11 s; db 1486 + 2986 tests in 83 s (was 278 s); e2e 10 scenarios in 14 s (was 356 s). The floors are those counts. Gotchas fixed on the way: `metrics.spec.ts`'s app_info read whatever commit an earlier `npm run build`left in`public/build.json`, so the db tier failed after an e2e run (it pins APP_VERSION now); Chromium logs a refused login's 401 page as a console error, which the login scenario now expects by name. The worker's stale-page, warm, install and push-settings behaviours lost their browser specs and are verified on the phone before a feature is called done (`test/AGENTS.md`); a migration with a data fix is proved by hand on production-shaped rows in its PR (`src/db/AGENTS.md`). References to retired specs in docs and comments are marked `(retired 2026-10-13)`.

## 2026-10-13 — Observability contract 2: job ids, app_info and db-statement metrics, no-console, request_id in error bodies

**Why:** `observability.md` asks for a `<kind>-<12hex>` id per background run with its `parent_request_id`, `app_info{version}` and `http_request_db_statements`, the `logger` field name, no console in app code, `request_id` in every error body, and devkit's `contract_probe.sh` in the smoke. #381 left these open.
**Decision:** one async store holds a request or a job (`runAsJob`); a job replaces the request, keeping its id as parent. Timer runs are `cron-`, cutout photos `cutout-`. The cutout's parent survives the database queue in a new nullable `file.cutout_request_id`, set where a row enters the queue. Statements are counted by Drizzle's logger hook in the caller's context, proven equal to node-postgres's count. `make ci-db` writes `build/metrics/statements.json` from `recordQueries` blocks only (decision H). `context` became `logger`: nothing in homelab reads it.
**Consequence:** Loki queries on `context` must use `logger`. The smoke probes `--live /healthz`; `--health` waits for `/health/ready`. No ratchet reads `statements.json` until closet's `ci-metrics` lands. Push and MCP outcome words are unchanged (owner decision pending).

## 2026-10-13 — Observability contract: bare sha7 version, JSON logs with request ids, Bugsink environment

**Why:** `observability.md` names one version string (the bare sha7), JSON log lines, a 12-hex `request_id` joining a reply, its log lines and its Bugsink event, and an explicit `environment`. closet reported `sha-<7>`, wrote pino-pretty to Loki, had no request id, and sent smoke boots to Bugsink as `production` (NODE_ENV).
**Decision:** `APP_VERSION` is the bare sha7 (owner decision E); only the image tag keeps `sha-`. `LOG_FORMAT` `json` (default) or `text`; JSON is a sync multistream, since a worker with two targets drops lines whose `level` is a label. One async context (`src/request-context.ts`) carries the id and the request timing; pino's mixin and the tracker read it. `APP_ENV` (production|dev|gate) is the tracker's environment. Job outcomes keep `discarded` and `interrupted` (owner decision C, a Convention delta); errors and timeouts are `failure`.
**Consequence:** Bugsink releases change from `sha-<7>` to `<sha7>` at the next deploy. No Dockerfile `HEALTHCHECK` yet: nothing reads closet's container health (homelab compose has no healthcheck or autoheal label); it lands with `/health/ready`. Still open: `logger` field name, job ids, `app_info`, push/MCP outcome words.

## 2026-10-13 — Docs-check and git hooks via devkit; area docs become AGENTS.md

**Why:** the 36 area docs were real `CLAUDE.md` files, which only Claude Code reads, and closet kept its own docs check (`scripts/claude-md.ts`) and hook runner (`scripts/git-hook.ts`) beside devkit's copies of both. The pre-commit hook ran the integration tier against pgvault-dev, and pre-push ran Playwright on a push to `main`.
**Decision:** every area doc is `AGENTS.md` with `CLAUDE.md -> AGENTS.md`; live references name `AGENTS.md` (history docs keep their wording). `make docs-check` (devkit, in `ci-quick`) owns the pair rule and the 30/16 KB caps; closet's one extra, the root's area index, moved to `scripts/ci/docs_rules.sh`. Hooks are devkit's templates: pre-commit `ci-quick`, pre-push `ci-unit` (`scripts/ci/hooks.conf`); `make install` sets `core.hooksPath`, and the npm `prepare` script no longer does.
**Consequence:** hooks need neither Postgres nor a browser; the integration tier and e2e run only in the gate. `npm run check` no longer includes a docs check. A new area doc must be added to the index and as a pair, or `ci-quick` fails.

## 2026-10-13 — Release identity: APP_VERSION baked into the image, ship tags from CI

**Why:** the image named its build three ways (a full sha in `public/build.json` for the error tracker, package.json's frozen `0.5.1` on /about and MCP, semver tags from `tag-release.yml`), and `/healthz` named none, so nothing said which build production runs.
**Decision:** one string, `sha-<7>`: `ci.yml`'s publish job passes `APP_VERSION` once; the Dockerfile's final stage holds `ARG`/`ENV`/`LABEL org.opencontainers.image.version`; `/healthz` answers 200 `{status, version}`; compose never sets it (`make release-check`). Only that job moves `latest`, then tags `ship-<date>-<sha7>`. `tag-release.yml`, the `v*` trigger, semver and date image tags are retired. The Dockerfile moved to the root (devkit's checks read only that one). Renovate replaces Dependabot.
**Consequence:** the error tracker's releases change from full shas to `sha-<7>`. The beacon accepts any `[A-Za-z0-9._-]` release. The builder stage no longer takes the commit, so `npm run build` stays cached across commits.

## 2026-10-13 — PR gate moves in-repo via devkit; strict protection off

**Why:** the gate was a closet-only script outside the repo, posting three per-job statuses, updating branches for strict protection and merging on its own. Its scratch databases lived on the shared pgvault-dev. Its path map also sent `test/support/**` to the browser job only, skipping the integration tier that imports it.
**Decision:** devkit's shared skeleton (`make gate PR=<n>`) runs this repo's Makefile `ci-*` targets from `scripts/ci/gate_plan.sh` and posts one `local-gate`. Protection requires `local-gate` + `codex-review` with strict off. The merge queue merges only when the head and `main` it gated are still current, pinned with `--match-head-commit`. That is the guarantee strict gave, without update-branch or carrying `codex-review` over. Tests run on a throwaway Postgres 18 container (`devkit/bin/throwaway_pg.sh`), never pgvault-dev. Fork PRs are refused (public repo; `GATE_ALLOW_FORKS` stays 0).
**Consequence:** a hand merge in the UI can use a `local-gate` from an older `main`; its description names that `main` ("Passed on main abc1234"). Coordinators never enable auto-merge. A check changes in the Makefile, never in the plan or `ci.yml`.

## 2026-10-13 — devkit e7b19d7: hook steps scoped by changed paths, standard docs set

**Why:** devkit e7b19d7 fixes the gate log race, scopes hook steps from one fleet layout table, and adds docs-check rules 6-10 (standard README sections, dated decisions, real `make` targets and links), warning until 2026-11-15.
**Decision:** sync with no `scripts/ci/hooks.conf` change; closet's layout needs no override. A docs-only commit skips `ci-quick` and `ci-unit` and the hook runs `make docs-check` itself; any other change runs every step as before. The README gains Architecture, Deploy and Documentation sections that point at the existing docs.
**Consequence:** a docs-only commit or push checks only the docs locally; the gate stays authoritative. `docs_check.sh` reports no warnings under a 2099 date, so the 2026-11-15 flip needs no closet change.

## 2026-10-14 — db tier under budget: integration workers share their module graph

**Why:** `make ci-db` ran 173–176 s in the gate against its 180 s budget (78 s solo). A third of its CPU was each of 122 integration spec files importing the app's module graph afresh (about 1 s each), plus a cold first boot per process.
**Decision:** the integration project runs `isolate: false`, overturning the 2026-09-25 rule whose blocker (config read from env at import) `createApp(config)` removed. Route tables move to `authorization-<group>.routes.ts` (Vitest never re-imports a test file); `createApp`'s `onRoute` option replaces the coverage spec's `fastify` mock; eslint bans `vi.mock`/`doMock` in `test/integration/`; `shared-worker-setup.ts` restores timers, envs and globals per file. The fixed 5 s lock and stop timeouts stay: production constants, idle not CPU.
**Consequence:** solo 78 s → 45 s; gate 173–176 s → 51 s (56 s beside e2e and an uncached image build). Budget 180 → 110 s; floors unchanged (4489 ran). Proof of no leak (#387): one-worker and two shuffled runs gave the isolated run's outcomes per test and its `statements.json` byte for byte.

## 2026-10-15 — devkit 51a7bb5: one path classification for hooks and gate

**Why:** devkit 51a7bb5 moves the fleet's path table into `bin/_paths_lib.sh`, shared by the hooks and the gate, and adds `devkit_default_gate_plan`; a devkit-only change is now "tooling".
**Decision:** sync with no hooks.conf change (the hooks treat tooling like other, so local steps are unchanged), then convert the gate plan to the default (next entry).
**Consequence:** the tier guard's git-root lookup now ignores a hook's exported `GIT_DIR`, so `build/metrics/` always lands at the checkout root.

## 2026-10-15 — Gate plan on devkit's default; closet's db/e2e rules in gate_plan_extra

**Why:** every devkit sync ran db + e2e (~4–5 min) because the old plan's own path loop called `devkit/` app code; devkit 51a7bb5 classifies those paths as tooling.
**Decision:** `scripts/ci/gate_plan.sh` declares QUICK (`deps` + `quick`), DOCS and IMAGE (`GATE_AREAS_IMAGE=""`, image paths only) and calls `devkit_default_gate_plan`. db and e2e stay closet's per-path rules in `gate_plan_extra`, not BACKEND/E2E groups: all of closet is the fleet's "other", and an area group would run both tiers for a Playwright-only or `.github`-only change.
**Consequence:** docs-only runs docs-check without `npm ci`; devkit-only runs deps + quick; a change to devkit's contract probe runs the image job (it ran db + e2e and no image before). The image job now runs before db and e2e. The plan is read from the invoking checkout, so the PR that changes it is gated by `main`'s copy.

## 2026-10-15 — The image runs as uid 1000; readiness checks storage is writable

**Why:** delivery.md / observability.md want non-root images, and closet's ran as root. Its two runtime directories are host mounts that keep the host's ownership, so a non-root image on a root-owned one is Orbit's port-80 outage class: the Mac smoke passes, production breaks. Measured against the code, a root-owned DATA_PATH already crashed the boot (a bare EACCES from opening app.log), while a root-owned MODELS_PATH would have read `up` and failed only the model download.
**Decision:** `USER node` (node:22-slim's uid/gid 1000) after chowning only `/app/data` and `/app/models`, the process's only runtime writes (HOME `/home/node` is already its own). `src/storage-probe.ts` (a real create + unlink, not mode bits: the data share is NFS squashed to the NAS admin) feeds a required `storage` check on `/health/ready` (cached 5 s) and main.ts's refusal of an unwritable DATA_PATH, both naming the chown. The smoke boots on Docker volumes (a macOS bind mount lets every uid write) and proves uid 1000, then a root-owned data volume (boot refused) and a root-owned models volume (503, `storage` down).
**Consequence:** deploy ORDER: closet autodeploys `latest` from main, so the owner chowns the production host's `/srv/docker/closet/models` to 1000:1000 and proves both directories writable as uid 1000 (`docs/operations.md#permissions`) BEFORE this merges; then `docker exec closet id -u` is 1000 and an upload works. homelab's compose comment "The image runs as root" changes with it.

## 2026-10-16 — Metrics ratchet: ci-metrics on devkit's collectors; coverage stays in vitest for now

**Why:** owner decision C4 puts closet's static numbers and coverage under devkit's ratchet (devkit f756b39), so a PR can only leave them as good as `main`.
**Decision:** `scripts/ci/metrics.conf` runs `ts.mjs` over `src` (scope `backend`, area `other`: cyclomatic, cognitive, knip, cycles) and `jscpd.mjs` over `src`; `docs/metrics/ratchet.json` holds every key they emit at today's value. No bundle key: the build is tsc, not vite. `knip.jsonc` declares the entry points and importmap names knip cannot see, so `dead.*` counts dead code. The four tools are pinned exactly, as in finplat.
**Not yet:** coverage. Its report comes from `ci-db`, which skips `.github`-only, Playwright-only and tooling PRs, while devkit runs every collector on any `other` or `tooling` path. A coverage collector would then fail for a missing report. The vitest thresholds keep gating coverage until devkit can skip a collector whose producing job did not run. The same gap keeps `statements.*` (from `ci-db`) and `audit-pages` statements untracked.
**Consequence:** `make ci-metrics` takes about 30 s, almost all of it two type-aware eslint passes. It is the gate's last job on every non-docs PR, devkit syncs included.

## 2026-10-16 — devkit 8236095: knip's unused files counted; closet's bound of 0 holds

**Why:** devkit #36 fixes `ts.mjs`, which read a `files` array knip 6 no longer fills, so `dead.*.knip_files` was 0 everywhere.
**Decision:** sync. Re-measured with the fix, closet's `dead.backend.knip_files` is still 0 (`knip.jsonc` declares every entry point), so the bound merged in #391 stands; no rebaseline.
**Consequence:** a new unreferenced file under `src/`, `scripts/` or `test/` now fails `ci-metrics`; declare a real entry point in `knip.jsonc`, never to hide one.

## 2026-10-16 — Coverage moves into the metrics ratchet (C4); vitest thresholds deleted

**Why:** decision C4 wants one place to gate coverage. devkit f6bf01f lets a collector name the gate job it reads (`job:db`), so it is SKIPPED, not failed, when the gate skips db (`.github`, Playwright-only, tooling PRs).
**Decision:** `make ci-db` adds the `json-summary` reporter. The `cov` collector (`job:db`) turns it into `coverage.backend.lines` 97.43 and `branches` 92.36, both today's values, direction higher. The four vitest thresholds are deleted. Functions and statements are no longer gated: the fleet key set is lines and branches, statements track lines, and functions jitter (two runs differed by one function in `src/db/client.ts`; lines and branches were identical).
**Consequence:** a coverage drop fails `ci-metrics`, not `test:cov`, and `ci.yml`'s db job no longer gates it. The bounds and the conf are `other` now and run db only (`gate_plan_extra`), so the coverage keys are measured, not skipped. `statements.*` and `audit-pages` stay untracked.

## 2026-10-16 — Layer direction through devkit's layer guard; knip and jscpd bases

**Why:** closet's layering was lint-only and covered the pure layers; nothing held db below web or metrics below db. devkit f7ee75e ships `bin/layer_check.py` and the collectors' base configs.
**Decision:** `scripts/ci/layers.conf` declares src/ bottom-first (shared, infra|pure, metrics, db, cutout, web, maintenance, seed; entries on top) as the code obeys it today. `make layer-check` joins ci-quick and the `layers` collector (`repo`, so a conf-only PR is measured) gates `coupling.backend.layer_violations` at 3: metrics imports the auth cookie name, the token prefix and `isWarmRequest` from web, each a `known` line with its fix. `db/schema.ts -> cutout/state.ts` is an `allow`: a constant module that imports nothing, taken as the schema takes the pure layers' enums. ESLint keeps the package bans.
**Consequence:** `--knip-base` drops four knip.jsonc lines; `--base` gives jscpd the spec exclusion closet never had, so clones fell 45 to 33 and the percent 0.5 to 0.43 (tightened, with branches 92.37).

## 2026-10-16 — Convention deltas declared

**Why:** the fleet matrix (2026-10-16) found three deliberate gaps with no line under `## Convention deltas`: no pull-request job in Actions, a scheduled `nightly.yml`, and the own image smoke instead of devkit's `boot_image.sh`. `job_last_success` sat in an "open gaps" note. The docs diet also limits root AGENTS.md to the standard H2s.
**Decision:** declare the three as deltas. The PR gate is `local-gate` (2026-10-13). The nightly runs the page audit, Lighthouse, the real cutout model and WebKit, which no PR should wait for. `scripts/smoke-image.sh` boots on the host network (`boot_image.sh` uses a private one) and still runs devkit's `contract_probe.sh`. `job_last_success_timestamp_seconds` and the push and MCP outcome words go under `## Deliberate exceptions`. Conventions, Changing the schema, Deployment and Gotchas become H3s, verbatim. One-off audits and superseded plans move to `docs/reports/`, while plans cited from source stay in `docs/plans/`. `docs/deployment.md` becomes `docs/operations.md`.
**Consequence:** the fix hints in the storage and health checks now name `docs/operations.md#permissions` and `#health`. `ci.yml`'s comment still names `docs/deployment.md` until the next workflow change. A new plan cited from code is linked from README.

## 2026-10-16 — Statement budgets join the ratchet at tolerance 0

**Why:** `make ci-db` already wrote each route's statement maximum, but into build/metrics/, which metrics_collect.sh clears, and no collector read it: an N+1 regression passed the gate.
**Decision:** the fixture writes `build/statements.json`; devkit's shared collector `devkit/metrics/statements.py` (decision H) validates it into `statements.<METHOD>:<route>` keys, `job:db` in scripts/ci/metrics.conf, `--min-routes 87` (today's count). The 87 keys were seeded by a rebaseline that moved no other bound.
**Consequence:** one more statement on any pinned route fails ci-metrics. A route that legitimately needs more is a bound edit in docs/metrics/ratchet.json with the metrics-rebaseline label; a new recordQueries route raises --min-routes in the same PR.

## 2026-10-16 — Scorecard sync: sizes, fan-out and vulnerabilities measured; secrets guard in ci-quick

**Why:** the scorecard's T2, T4 and T11 rows had no number in closet: file size, module fan-in/out and dependency advisories were unmeasured, and nothing stopped a committed credential.
**Decision:** devkit main's `size.py` and `vuln.py` collectors plus `--fan` on ts-backend, all area `other` (all of src/ is other). size and coupling bounds were seeded at today's values (max_lines 2295, over_600 15, fan_in 122, fan_out 36); vuln is report-only (the ratchet never tracks it: it needs network). `make secrets-check` runs in ci-quick; `scripts/ci/secrets_allow.txt` names the page audit fixture's fake signing key.
**Consequence:** a file growing past its bound or a new 600-line file fails ci-metrics. Today's OSV hits (1 critical, 10 high) are fixed in a separate runtime PR the owner merges.

## 2026-10-16 — Dead exports deleted; knip_exports bound tightened

**Why:** knip reported 200 exports and types no other module imports, so the scorecard's T3 (dead code) read F and every new unused export hid among them.
**Decision:** 187 lost only the `export` keyword (each is used inside its own file). Ten e2e helpers orphaned when PR #383 cut the e2e specs were deleted. Three `as const` arrays read only to derive a type (GARMENT_PROPERTIES, the forecast's CONDITIONS, FIT_PROBLEMS) became plain union types. Nothing went into knip's ignore list.
**Consequence:** `dead.backend.knip_exports` is bound at 0. Export a symbol in the same change that imports it from another module; a test needing an internal goes through the module's public behaviour.

## 2026-10-16 — Layer debt paid: metrics never imports web

**Why:** three `known` lines in `scripts/ci/layers.conf` let src/metrics reach into src/web for the session cookie's name, the personal token prefix and `isWarmRequest`.
**Decision:** the two credential names move to `src/credential-names.ts` and the warm marker (header + `isWarmRequest`) to `src/warm-request.ts`, both in the `shared` layer; every consumer (web/auth, the service worker, app.ts) imports them there, with no re-export left behind.
**Consequence:** no `known` lines remain and `coupling.backend.layer_violations` is bound at 0: a new metrics→web import fails ci-quick.

## 2026-10-16 — devkit c9ef303 and the scorecard ratchet

**Why:** the scorecard grades closet per track, but nothing stopped a PR from lowering a track's pass share.
**Decision:** `docs/metrics/scorecard.json` is committed from `scorecard.py . --mode rebaseline`; `make ci-metrics` (metrics_collect.sh) then runs `--mode check` after the metric bounds and fails a PR whose ratcheted track (T1-T6, T10, T12, T14) drops. Baseline: closet D.
**Consequence:** letters only rise from here; a PR that raises a share runs `--mode tighten` and commits the file. The `metrics-rebaseline` label is the escape hatch, as for the metric bounds. Also moved the 2026-10-16 layer-debt entry to the end, where docs-check's newest-last rule wants it.

## 2026-10-17 — Guard kit and the ESLint base adopted (devkit 164aeb5)

**Why:** devkit now judges code-structure rules from one conf (`guard_check.py`) and ships a shared ESLint base; closet is the TS canary the other repos copy.
**Decision:** `scripts/ci/guards.conf` declares five rules no lint rule held: the outbound-fetch door (sockets, DNS, `node:http` and global `fetch` only in `outbound-fetch.ts`; `errors.tsx` reads STATUS_CODES), no `Math.random`, no `loadConfig` in src/web. `make guard-check` runs in ci-quick; ratchet key `guards.backend.known` (bound 0). No test was deleted: `photo-ref-guard.spec.ts` stays (type-only imports are erased and its other three checks scan SQL text). ESLint spreads `devkit/lint/eslint.base.mjs` first; closet's src-only `no-console` became a scripts/test exemption.
**Consequence:** `scripts/preCommit.sh` (a second gate) is gone; the docs name the real merge (`gh pr merge --squash --match-head-commit`), not a script that never existed. `migration_check.py` is not wired: it reads `drizzle/meta/_journal.json`, which every new migration appends to, as a shipped edit. `coverage.backend.branches` drops 92.37 → 92.36 under `metrics-rebaseline`: origin/main measures 92.36 on 2026-10-17 with no src change, so a branch depends on the day.

## 2026-10-17 — pre-commit split: typecheck and unit run at pre-push

**Why:** the scorecard's T8 read pre-commit p90 33 s (budget 30 s): the hook ran all of ci-quick, and a fresh worktree's first eslint is cold, with prettier run twice (format:check, and again as an eslint rule).
**Decision:** as rollcall #56: pre-commit = ci-guards + `secrets_check.sh --staged` + ci-lint; pre-push = ci-typecheck + ci-unit. ci-quick is the union of the Makefile parts, so the gate and ci.yml are unchanged. eslint-plugin-prettier is dropped for eslint-config-prettier: formatting is format:check's alone.
**Consequence:** a type error is caught at push, not commit. A new ci-quick part goes into a hook step too (scripts/ci/hooks.conf).

## 2026-10-17 — The outfit destination has one owner: query, body, hidden fields and label

**Why:** `src/web/outfits/destination.ts` documented itself as the one parser and writer of `?for=`, yet the `for`/`occasion`/`replace` query schema was spelled in five routes, the hidden fields that post it back in the gallery and Styling, the pick label ("Plan for Tuesday", "Add to the trip") in both pages, and the posted body's pattern in `schemas.ts` beside the module's own format constants. jscpd counted four of the 33 clone blocks here; the refactor skill's drift lens (two writers of one policy, a documented owner bypassed) picked it over the larger capsules/trips form group, whose copies are design (two products, no owner yet).
**Decision:** the module (now `destination.tsx`) owns `DestinationQuery` (lenient strings, spread into a page's querystring), `DestinationBody` (strict, a write's) and `DestinationFields` (the hidden fields); `destination-views.tsx` (was `day-destination.tsx`) owns what the pages say of one, `DayDestinationLine` and `destinationPickLabel`, because the label needs `t` and `coupling.backend.fan_in_max` is i18n's importer count (122): the parser module importing it would have raised that bound. Every feature spreads or renders them. `destination.spec.tsx` proves the round trip: what `DestinationFields` writes, `DestinationBody` accepts and `parseDestination` reads back. No guards.conf rule: the guard grammar has no "only this file spells this attribute" kind; the ratchet's `duplication.repo.clones` 33 → 30 and `jscpd_percent` 0.43 → 0.38 hold the consolidation.
**Consequence:** a feature spelling the `day:`/`trip:` format, a `for: Type.Optional(Type.String())` of its own, or a label switch on the kind is a regression (calendar and outfits AGENTS.md). One form keeps writing the field names by hand: the plan sheet's GET into Ideas, whose occasion is the user's radio choice, so a posted-back destination component cannot carry it; its `for` value is `destinationTarget`'s (Codex review of #408). Old builder links (`/outfits/new?for=…`) now also carry `replace` through to Styling, as every other reader did. Remaining clone groups for the next lane: capsules/trips forms (6 blocks, design until a shared field component exists), gallery/styling query shape beyond the destination (`capsule`, `with`), the four photo route preludes, the two cron timers.

## 2026-10-17 — Complexity sweep, error text through errorFields, migration guard wired (devkit 174d401)

**Why:** the ratchet holds two functions over cognitive 15. devkit #86 and #91 made three closet gaps expressible: names from `node:http`, the drizzle journal append, and logger calls that splice error text. The new rule found ten such calls (a fetch or driver error can quote a URL with its token). Pino's default serializer also wrote every `{ err }` raw, with all of the error's own fields.
**Decision:** `decideSuggestion` hands its bought and dismiss-group arms to functions, as undo-group already did, and `decideOnPick` does the same with dismiss-pick, with `settledBy` naming the "reopens its need" test. `crossFieldProblems` hands over the order-mail group. `errorFields` (src/logger.ts) is every logger's `err` serializer: it redacts the error tracker's credential shapes (now `src/secret-text.ts`, one list for both; a Drizzle `params:` tail included, Codex review), URLs (not file:// frames) and `key=value` pairs, keeps type, code, status, causes and the stack, and drops other fields. Unlike rollcall's helper it keeps the stack, because errors.spec holds "a 500 logged with its stack". `@outbound-http-sockets` bans the socket names; `migration-check` runs in ci-guards (the pre-commit hook and ci-quick).
**Consequence:** log lines change: those ten messages lose the error text, which is now under `err`, and every `err` is redacted. The names ban is a deny-list: `import * as http` in errors.tsx would pass it. `readInbox` (cyclomatic 14, a flat list of optional reads for one statement) is why cyclomatic_max stays 14.
**Decision:** `decideSuggestion` hands its bought and dismiss-group arms to functions, as undo-group already did, and `decideOnPick` does the same with dismiss-pick, with `settledBy` naming the "reopens its need" test. `crossFieldProblems` hands over the order-mail group. `errorFields` (src/logger.ts) is every logger's `err` serializer: it redacts URLs (not file:// frames) and `key=value` pairs, keeps type, code, status, causes and the stack, and drops other fields. Unlike rollcall's helper it keeps the stack, because errors.spec holds "a 500 logged with its stack". `@outbound-http-sockets` bans the socket names; `migration-check` runs in ci-quick.
**Consequence:** log lines change: those ten messages, and five the rule cannot see (a describe helper, a `why` string, a child process's reply, a connection reason, `String(error.cause)`; Codex on #406), lose the error text, which is now under `err`, and every `err` is redacted. A push failure logs its HTTP status, not the push service's body. The names ban is a deny-list: `import * as http` in errors.tsx would pass it. `readInbox` (cyclomatic 14, a flat list of optional reads for one statement) is why cyclomatic_max stays 14.

## 2026-10-17 — Runner images pinned to ubuntu-24.04 (devkit 174d401)

**Why:** `ubuntu-latest` moves to a new OS on GitHub's schedule, so a green workflow can turn red with no commit here; devkit #105 makes workflows-check fail on it.
**Decision:** every job in ci.yml and nightly.yml runs on `ubuntu-24.04`.
**Consequence:** a newer image is a deliberate PR that changes the pin and watches ci.yml and the nightly run once.
**Rebaseline:** devkit #108 drops Markdown, text and lockfiles from jscpd's denominator, so `duplication.repo.jscpd_percent` reads 0.39 on main's own tree (0.38 before) with the same 30 clones; that one bound moves (label `metrics-rebaseline`). `make metrics-rebaseline` is now a target, as the ratchet's failure message assumed; it would also have dropped the report-only `fan_in_max`, which stays.

## 2026-10-17 — One owner per transaction (devkit bca8cbd: own-transaction, report-only.json)

**Why:** the scorecard read `arch.own_commit` UNMEASURED: drizzle has no session object for devkit's Python tracer, and closet spells a transaction `db.`, `this.db.` and raw `BEGIN` in `client.query`.
**Decision:** guards.conf `@own-tx` (devkit #113) lets only the query/write modules it lists and `src/db/migrate.ts:recordBaseline` open, commit or roll back a transaction; 0 violations on main, and a planted `db.transaction(` in `src/web/wardrobe/urls.ts` fails it. `docs/metrics/report-only.json` (devkit #112, written by `make metrics-tighten`) carries `vuln.*` and `fan_in_max` to the scorecard.
**Consequence:** a new transaction site joins an owner module or the line, in the same PR. T4 0.6 → 0.8.

## 2026-10-17 — devkit c2d7e22: image for every app path, sonarjs rules, rebaseline KEYS

**Why:** devkit #115 refuses `GATE_AREAS_IMAGE`; closet's `""` had let #404, #406, #408 and #409 merge src/ changes no image build or smoke booted. devkit #110 exports sonarjs rule maps, and #116 makes a rebaseline name its keys.
**Decision:** the override is gone and `GATE_IMAGE_PATHS` with it (every path it named is already an app path). `GATE_IMAGE_EXCLUDE_PATHS` lists the app paths no Dockerfile stage COPYs (there is no .dockerignore). eslint registers sonarjs for every linted file with `sonarjsRules`, and specs get `sonarjsTestRules`. The 75 findings (40 nested ternaries, 35 duplicate strings) became named helpers, lookup maps and one-owner consts; outcome tags such as `NOT_ALLOWED` are `as const` values the union types derive from. `make metrics-rebaseline` documents `KEYS=`.
**Consequence:** a new nested ternary or a literal repeated three times fails ci-lint. A new Dockerfile COPY of an excluded path must drop it from the exclude list. Splitting the ternaries put two untested branches on lines of their own, so `weather/views.spec.ts` now pins the push's weather text.

## 2026-10-17 — One owner for a form field's invalid state

**Why:** jscpd's form-field group (pass 2 of the clone ratchet) was drift, not design. Eight copies of label + input + messages decided "this field was refused" in three shapes: capsules and trips never announced their messages (no `role="alert"`), and the garment form, repair log, "Bought it" and fabric weight were red without `aria-invalid`. Only link import also tied the input to its message (`aria-describedby`).
**Decision:** `src/web/form-field.tsx` owns it: `FormField` (label, control, `FieldMessages`) and `inputAttributes` (id, classes, `aria-invalid`, `aria-describedby`); `Messages` and `inputClass` left `layout/parts.tsx`. guards.conf `@field-invalid` holds `input-error` and `aria-invalid` to it and to `auth/form.tsx`, whose inline-check slots are a separate design.
**Consequence:** a refused input is now invalid, described and announced on every post form (the colour dropdown's messages are announced only). That is an accessibility-tree change, not a visual one. The capsule/trip create-edit page frame is still two copies; their offline-guard difference is #411. `coverage.backend.branches` was rebaselined 92.49 to 92.48 (label metrics-rebaseline): about 35 covered duplicate branches were deleted and 14 covered ones added, a denominator effect, not lost coverage.

## 2026-10-17 — One owner for the checklist protocol

**Why:** jscpd's pass-2 groups held three hand-written checklist bodies (two in capsules, one in trips) and four hidden `shown` inputs. Trips imported `unchecked` from capsules' validation, a cross-feature reach. The two trip writers resolve an id sent as both packed and unpacked differently (`setPacked` packs it, `setItemsPacked` unpacks it); no post reaches that, since `unchecked` never returns a checked id.
**Decision:** `src/web/checklist.tsx` owns `checklistBody(field, maxItems)`, `unchecked` and `ShownId`. Posted names (`ids`, `capsuleIds`, `packed`) and caps (2000, 500) stay per list, because cached pages post them. guards.conf `@checklist-shown` keeps `name="shown"` there.
**Consequence:** the schemas and rendered markup are unchanged. A new checklist starts from the owner; a hand-made `shown` input fails ci-quick.

## 2026-10-18 — One owner each for the place picker and the timer loop (clones 25 to 22)

**Why:** pass 3 of the clone ratchet. The home city and a trip's destination each owned the place search: the field's 2–100 bounds, the query schema, the try/catch answer, the result list, the posted coordinates and the body schema (trips' said "the weather's own shape", a copy held by a comment). `scheduleNightly` and `scheduleMinutely` each carried the timer loop, the cron job per run and the bounded stop.
**Decision:** `src/web/weather/place-picker.tsx` owns the picker (each picker brings only its `Form`); `scheduleJob` (`src/maintenance/scheduled.ts`) owns the loop, the two schedulers bringing only `untilNext`. guards.conf `@place-fields` and `@cron-loop` hold each to its owner. devkit synced to c411302 (jscpd_percent report-only); its devkit-check reads gate_plan.sh from disk unless `--staged`, so the pre-commit hook's guards step is now `ci-guards-staged` (Codex review).
**Consequence:** rendered markup is byte-identical (old and new components rendered side by side). A trip's picked name is now capped by the picker's 200, equal to `TRIP_DESTINATION_MAX`. Left as design: the capsule/trip create-edit frame (#411 rides on it), plan/trip add page tails, the capsule/inbox `resolve` prologue, the parts.tsx icon wrappers, schema and query twins. Link tabs and the sheet backdrop follow in their own PR. `make metrics-tighten` now drops the report-only bounds (`jscpd_percent`, and `fan_in_max`, 123 with the picker's i18n import) from ratchet.json; both stay in report-only.json.

## 2026-10-18 — One writer each for link tabs and the sheet backdrop (clones 22 to 19)

**Why:** the clone ratchet's pass 3, second half. The Wardrobe, Outfits and Calendar tab bars each wrote a link tab's role, `tab-active` and `aria-selected` by hand, and nine dialogs wrote their tap-outside close (`modal-backdrop`).
**Decision:** `LinkTabs` (`src/web/layout/link-tabs.tsx`; a `false` entry is a tab left out) and `SheetBackdrop` (`layout/parts.tsx`) own them. The backdrop's label stays each sheet's: Cancel on the plan sheet and Styling's save, which ask a choice, Close elsewhere. guards.conf `@link-tabs` and `@sheet-backdrop` fail a hand-written copy.
**Consequence:** the tab bars render byte-identical markup (old and new rendered side by side). The selfie viewer's backdrop button loses a redundant `type="submit"`, the default for a button in a form. `coverage.backend.branches` was rebaselined 92.48 to 92.47 (label metrics-rebaseline): the three tab bars' twelve covered branches became `LinkTabs`' six, all covered, a denominator effect; the gate read 92.47 twice where a local run reads 92.48.

## 2026-10-18 — devkit 7ed3645: `make merge` is the merge path; gains lock in; scorecard v2

- **Why:** no paid GitHub features (owner, 2026-10-18), so the merge itself must check the gate; and a ratchet that tolerated BETTER let gains slip back.
- **Decision:** `make merge PR=<n>` (devkit/bin/pr_merge.sh) is the only merge: `local-gate` and `codex-review` (`GATE_MERGE_REQUIRES`) success on the exact head, `main` unmoved since the gate. `ci-metrics` fails on BETTER until `make metrics-tighten`; size, jscpd percent and fan-in are report-only (docs/metrics/report-only.json). `ci-smoke` runs under the tier guard (120 s) and `ci-image` under `docker_bounded.sh`.
- **Consequence:** `docs/metrics/scorecard.json` holds only the WIRED share (19/19 repo-scoped). The machine-scoped gh shim is not installed here yet, and BITE's unguarded count is the pre-local-gate merges up to #376, ageing out of the 30-day window.
- **Gotcha:** `metrics-tighten` locks in any gain, even inside the ratchet's 0.05 float tolerance; branch coverage moves 0.01 run to run (v8 merging of `wardrobe/destination.ts`), so a 92.48 tighten failed the next gate as WORSE. Leave sub-tolerance coverage gains at main's bound.

## 2026-10-19 — An add or edit page is one frame, disabled offline (#411; clones 19 to 16)

**Why:** `PostForm`'s offline guard (`needsNetwork`) was each page's opt-in, and only the trip form had opted in. A cached capsule, garment or "Bought it" form opened offline posted into the worker's offline page and lost what was typed, and the capsule's Delete stayed live. That breaks AGENTS.md's "unreachable writes are disabled with a reason, never dropped". The capsule/trip create-edit frame was also the clone triage's last drift group (#412, #414).
**Decision:** `FormPage` (`src/web/layout/form-page.tsx`) owns the frame: the `formPage` app bar, `PageMain`, one always-guarded `PostForm`, Cancel then the submit, and a guarded Delete. The four forms bring only their fields. `@form-page` (guards.conf) keeps `<CancelLink` there; `expectOfflineGuarded` tests each form. connectivity.js logs how many write controls it disabled. Not chosen: `needsNetwork` on by default in `PostForm`, the issue's owner call, since 14 other PostForms (login, tokens, link import) would change too.
**Consequence:** the four forms are disabled offline with the banner's reason. Visible: trips and capsules put Cancel before Save, both full width, as the garment form did; the capsule, trip and "Bought it" columns are `narrow` (40rem, was 32rem; phones unchanged). The repair log's note and day now carry the required mark (the issue's side note). jscpd's share fell 0.23% to 0.19%.

## 2026-10-19 — devkit 367dc33: recipes on the Node pin, changed-file expression complexity

- **Why:** devkit-check warned that a hand-run make used PATH's Node, not `.nvmrc`'s (devkit #166); `sonarjs/expression-complexity` has 2 findings on main, so it cannot join the whole-tree rules yet (#161).
- **Decision:** `SHELL := devkit/bin/toolchain_shell.sh`; ci-lint runs `changed_lint.py eslint` over src, test and scripts, the files lint:check reads. A planted six-term `&&` in a changed file fails it; five terms pass. A hand run's ci and smoke container names carry the worktree (`throwaway_pg.sh name`, #162); devkit-check missed the old literals because they sat in `?=` variables. renovate.json already extends the preset with no automerge.
- **Consequence:** a new chain of five or more operators fails the PR that writes it; the 2 existing drain as their files are touched, then the rule moves into eslint.config.mjs. Metrics 100 SAME, 0 tightened; scorecard wired 24/24.

## 2026-10-21 — devkit 401c9b7: metrics merge per key, vitest timeouts stretch with load

- **Why:** two PRs that each move a metrics bound conflicted on docs/metrics/\*.json (#176), and fixed 30 s vitest timeouts failed gates on a loaded box (#175).
- **Decision:** `.gitattributes` routes docs/metrics/\*.json through devkit's per-key merge driver (#176; `make install` sets it per clone); vitest.config.ts wraps its 30 s timeouts in `loadScaled` (devkit/lint/vitest.base.mjs, #175), so a gate on a box above its core count stretches them by `DEVKIT_LOAD_SCALE` (cap ×2).
- **Consequence:** `coverage.backend.branches` rebaselined 92.47 to 92.46 (label metrics-rebaseline): an untouched origin/main tree reads 8642/9346 = 92.46 today, file for file the same as this branch. The bound has drifted 92.48, 92.47, 92.46 over three days with no source change, which points at a date-dependent branch in a spec; open, not chased here.

## 2026-10-21 — `make merge` requires Codex's review of the head (GATE_CODEX_REVIEW=1)

**Why:** `GATE_MERGE_REQUIRES=codex-review` wants only a success status, whatever commit its text names, so a head Codex never reviewed (failed, missing, or reviewed an older commit) merged on any codex-review success. devkit #189 made the stricter check opt-in; the fleet opts in.
**Decision:** only `make merge` reads it. A failed, missing or stale Codex review of the head blocks unless the head's codex-review success names the fallback review of that exact commit (`… (Codex at limit) of <sha7>` or `<sha8> passed on Claude self-review`). #417 to #420 already recorded that form.
**Consequence:** every push needs a fresh Codex review (or a fallback naming that push's head) before `make merge`; a codex-review success left from an earlier head no longer carries.

## 2026-10-22 — Vitest tiers rerun with the clock shifted; coverage no longer moves with the date (devkit 31d9f2a)

**Why:** devkit #212 added the vitest half of the clock shift. Closet's db tier failed 6 specs at +30d/+365d, and its covered branches read 8643, 8644, 8642 of 9346 at 0, +30d, +365d: the drift the 2026-10-21 entry left open.
**Decision:** `GATE_JOBS_CLOCK` names `ci-unit` and `ci-db` (scripts/ci/gate_plan.sh); vitest.config.ts lists devkit's clock-shift setup files (since 2026-10-26 its `clockShift()` plugin). Root fixes: `pending_photo` rows take `created_at` from the app's clock, the clock reconciliation's cutoffs already use (3 specs); photo-storage.spec.ts dates its live file from the clock `prepare()` reads (1). The 2 muse-round-close specs stay in clock_shift.conf: the Muse writes and their quiet window are Postgres `now()` across decisions, feedback and rounds by design (shared instants, the feedback margin), not a small binding. The drift's sources: trips.spec.ts, the gallery's weather block and mcp-statements.spec.ts pin `Date` to `STUB_WEATHER_NOW` (the stub's weather and the seed's history are the date's); a `roundWhat` spec and a deterministic stale-need 409 (the two-phone race reached it only some runs, muse-inbox.spec.ts) cover branches only a shift or the scheduler reached.
**Consequence:** 8645/9346 covered at 0 (twice), +30d and +365d. The three pinned blocks no longer see the shift (a pin is what it checks for); a new weather or seed spec pins too. The CLOCK group runs on every "other" path, so a .github- or Playwright-only PR pays two more unit and db runs per offset.

## 2026-10-22 — Every PostForm is disabled offline unless it says why (#411)

**Why:** owner, 2026-10-22: "the offline guard is ON BY DEFAULT for every PostForm." #417 guarded the four `FormPage` forms; 15 others still posted from a cached copy into the worker's offline page. 14 are now guarded: sign in, register, email, password, account deletion, two token forms, link import, laundry, sharing, the add sheet's two photo forms, cutout retry, bulk select.
**Decision:** `PostForm` always renders `data-needs-network`; `allowOffline="<reason>"` (rendered `data-allow-offline`) is the only opt-out, and guards.conf `@post-form-offline` refuses one without a 12+ character literal. connectivity.js guards a form's `elements`, so a `form=` control outside it needs no marker: "Add a copy" lost its own, as did laundry's Mark washed inside its form. One opt-out: the styling form, since a guarded form is dimmed whole and its strips must stay usable offline ("choosing still works"); its Save, Shuffle, picks and + Add row carry their own markers (Add row's is new: it sent the rows' inputs, which a guard would have dropped). `expectFullPage` fails any unguarded PostForm on every page; `test/offline-writes.spec.ts` checks the browser.
**Consequence:** visible: those forms' controls, submit included, are disabled and dimmed while offline. htmx writes outside PostForm that carry no typed input (garment and outfit menu actions, a calendar entry's ×, the invite link, the push test, the inbox's seen mark) stay unguarded; every one holding input already was.

## 2026-10-23 — Scorecard bounds record each check, not a share

**Why:** devkit #218 made the scorecard ratchet hold each check by name; the share-only `{"wired": 1.0}` file bounds no check and fails `scorecard_file` until rewritten.
**Decision:** `scorecard.py . --mode tighten` (the scorecard step of `make metrics-tighten`) rewrote `docs/metrics/scorecard.json` as `{"checks": {<id>: wired}}`; every check the share counted stays wired. Unwired, recorded as backlog: none.
**Consequence:** ci-metrics now fails a recorded wired check that goes unwired, and a backlog check once wired until `make metrics-tighten` records it.

## 2026-10-26 — vitest.config.ts takes the clock shift from devkit's `clockShift()` plugin

**Why:** devkit #227 replaced its setup-files export with the `clockShift()` vite plugin (setup file first in every project's setupFiles, the file allowed past `server.fs.strict`, a no-op unshifted); #228 deprecated the export with a 30-day removal window and devkit-check warns on it.
**Decision:** `plugins: [clockShift()]` on the root config; the root `setupFiles` line that only carried the shift is gone. Vitest stays on 4.0.18 here (fleet target 5, a separate change).
**Consequence:** same runs as before at 0, +30d and +365d: unit 1519, db 4513, the two muse-round-close entries the only clock_shift.conf exceptions.

## 2026-10-26 — The page audit paces the app's rate limits; WebKit's double 401 (#374, #301)

**Why:** the nightly's audit failed `suggest_garment` with a 429: it and `add_garment_from_link` spend one `MCP_LINK_IMPORT_LIMIT` (10 a minute per user), and each had capped its own `runs` to fit alone (18 calls). Per-step caps do not compose once steps share a counter, and the photo choice's limit answers 200, so an over-budget run there would time a refusal unnoticed. The same run expected `/healthz`'s old 204 (an alias of `/health/ready` since #384), and WebKit logged the refused login's 401 twice (the worker's fetch and the document's).
**Decision:** a step declares `limits` (`AuditLimit`, `scripts/audit/budget.ts`: `auditLimit()` over the constant in `rate-limit.ts`, whose windows are now the number 60 000 the plugin parsed '1 minute' to, typed by `satisfies`); one `Budgets` tracker per walk waits before every run until each budget has room (sliding window, so the plugin's fixed one never trips) and logs the wait. `runs` stays a sample count. `/health/live` and `/health/ready` joined #174. `test/auth.spec.ts` asserts every console error is the 401 line, at least once, and awaits the registration's inline check before submitting (a Mac's WebKit logged the cut-off request as `htmx:sendError` 7 runs in 8).
**Consequence:** the walk is slower by about a minute (the MCP link budget). A new limited step that forgets `limits` still 429s, as before; the rule is in `test/AGENTS.md` and `docs/perf/README.md`.

## 2026-10-26 — Tests on vitest 5.0.3 and vite 8.3.4 (fleet target); config is vitest.config.mts

**Why:** fleet target (orbit #127, rollcall #91). Vitest 5 makes `vite` a required peer; vite 8's optional `esbuild` peer (`^0.27 || ^0.28`) refused our direct `esbuild ^0.25` (ERESOLVE), and vite 8 warns that `vitest.config.ts` is ESM in a CommonJS package (vite 7 did not).
**Decision:** exact pins vitest, @vitest/coverage-v8 5.0.3 and vite 8.3.4; `esbuild` `^0.28.2` (vite 7 already ran 0.28 nested; fonts.css, src-sw.js and bundle.css build byte-identical); `@types/node` stays `^22` (peer `^22 || >=24`, .nvmrc 22); no DOM environment to pin. The config is `.mts`, which clears the loader warning without `"type": "module"`. Migration guide checked: no nested `vi.mock`/`vi.hoisted`, no `sequential`, no worker-id use, no unawaited `resolves`/`rejects`; the projects already say `extends: true`, and the clockShift() plugin handles v5's appended setupFiles.
**Consequence:** unit 1519 and db 4513 at 0/+30d/+365d, the same two clock_shift.conf exceptions. Vite 8 transforms with Oxc, whose source maps split single-line `if (…) throw` statements and `??` sort tie-breaks that esbuild's maps folded into covered code: 5 statements and 4 branches, always unexecuted, became visible, so `coverage.backend.lines` 97.46 → 97.45 (metrics-rebaseline; branches 92.46 held). Those paths are the coverage to add next, not a regression.

## 2026-10-26 — Tailwind scans src/ and public/js/ only

**Why:** `@import "tailwindcss"` with no `source()` let Tailwind v4 scan every tracked file, devkit/ and docs/ included, so prose words became classes (devkit-check's warning; rollcall #81's `.shadow`).
**Decision:** `@import "tailwindcss" source("../../src")` plus `@source "../../public/js"`: the views and class helpers, and the client modules' classList/className. No other tracked file names a class at runtime.
**Consequence:** the built bundle.css loses 44 of 734 class selectors and gains none (155.4 → 143.9 kB); each lost one occurs only in docs/, devkit/, CHANGELOG, eslint.config.mjs, test/ or comments (incl. daisyUI's drawer, navbar, validator and react-day-picker blocks). A class used only from a new directory needs an `@source` line here.

## 2026-10-26 — Production advisories cleared: MCP SDK 1.32.2, zod 4, fastify 5.12.7; the MCP element cap

**Why:** OSV reported 4 high and 13 other advisories in locked production packages that landed with no code change (vuln.backend 0/4/17). The MCP SDK's GHSA-46jr-4wx8-v453 fix is an `McpServer` option that is off unless set; zod 3.25 has no fixed 3.x (GHSA-mrhx-c7xc-m3w5 needs 4.6.6).
**Decision:** direct bumps `@modelcontextprotocol/sdk` ^1.32.2, `zod` ^4.6.7 (imports now `'zod'`; the code already used the `zod/v4` API), `hono` ^4.13.14, `fastify` 5.12.7 (still exact); `npm update` for transitive body-parser 1.20.9/2.4.0, qs 6.16.1 (via express 4.22.3), fast-uri, fast-copy. No overrides needed. `/mcp` sets `maxToolInputElements` to `MAX_TOOL_INPUT_ELEMENTS` (10 000, about 5x the largest real call); coverage targets' colours and materials gained the `.max()` every other array input has.
**Consequence:** vuln.backend 0/0/0. The token check runs before the SDK, so both MCP DoS paths were owner-only. Zod 4.5+ visible changes: `z.iso.datetime()` needs seconds (`feedbackUntil` is our own ISO string), string bounds count code points, and tools/list's JSON Schema now carries `.int().min().max()` bounds it used to drop. body-parser is reachable only through express, which closet never mounts.

## 2026-10-26 — A probe asked for mid-flight probes again; offline-writes blocks the worker

**Why:** `offline-writes.spec.ts` failed 9–17 runs in 100 in WebKit (#436), for two reasons. `probe()` handed a call made mid-flight the running probe's promise, so an `offline` event during the page-load heartbeat took its 200 and the app stayed online for 30 s (on a phone too, after a failed request). And once the worker controls the page, WebKit sends `/health/live` through it, past `page.route`.
**Decision:** `probe` is `singleFlight(task)` (`public/js/single-flight.js`): still one probe at a time, but a call while one runs gets one more run after it, shared by every call in that window. The spec runs with `serviceWorkers: 'block'`: it tests `connectivity.js`, which never depends on a worker.
**Consequence:** an outage seen mid-probe costs one extra HEAD, never the 30 s heartbeat. Locally, both fixes together: 0 in 100 runs under 10 workers, twice; either alone still failed. A spec faking the heartbeat with `page.route` blocks the worker (`docs/testing-webkit.md`).

## 2026-10-27 — jscpd from devkit's pin; `make pr` opens PRs on origin

**Why:** devkit #235 gave jscpd one pin (5.4.2, run through `bin/npm_tool.sh`) and deprecates a repo's own `node_modules/.bin/jscpd` until 2026-11-25; closet's devDependency 5.4.0 was that legacy path. devkit #255 added `pr_create.sh` and devkit-check warns while a gate target has no `pr` target.
**Decision:** jscpd leaves package.json and the lock; metrics.conf's `dup` line already had no `--bin`. `pr: ; devkit/bin/pr_create.sh` sits beside `merge`, and docs/workflow.md steps 3 and 6 name `make pr` and `CODEX_FALLBACK=1 make merge`.
**Consequence:** `duplication.repo.clones` 16 and `jscpd_percent` 0.19 on both pins; devkit-check prints ok with no warning.

## 2026-10-27 — One wardrobe guard per plugin reads `?ownerId=` itself

**Why:** jscpd's clones held three hand-written `authorizeWardrobe` wrappers (garment-access, capsules, the wishlist inbox) that differed only in their 404 message, and 40 routes relayed `request.query.ownerId` into them by hand (three helpers took it as a parameter only to pass it on).
**Decision:** `wardrobeGuard(db, notFound)` (`sharing/access.ts`) returns `authorize(request, need)`, which reads the request's `?ownerId=` (`WardrobeRequest`); each plugin binds it once (`garmentGuard(db)` for the garment routes, the capsule, inbox, export and Styling plugins with their own message). `authorizeWardrobe` stays for a caller whose wardrobe is not the query's (the MCP tools' user id). The inbox page and its next page read through one `addressedInbox`.
**Consequence:** behaviour is unchanged (the authorization matrix specs pass as they were); `duplication.repo.clones` 16 → 12. A new share-aware route calls its plugin's `authorize`, never a wrapper of its own.

## 2026-10-27 — Shared view pieces: the Saved picker, ChipGroup, the entry-page preview, the outline icon frame

**Why:** jscpd's clones held four copies of one view concept each: the plan page's and a trip's add page's Saved section, two `ChipGroup`s (the garment form, the style profile; one had gained a hint), login's and register's link preview (og tags plus the schema.org WebPage, always together), and parts.tsx's Heroicons outline frame.
**Decision:** `SavedOutfitPicker` (`outfits/saved-outfit-button.tsx`; the page passes its heading, action, hidden fields and each outfit's note), `ChipGroup` in `form-field.tsx` beside `FormField`, `AccountShell`'s `description` (it writes both previews), and `OutlineIcon` in `layout/parts.tsx` (Camera and Photo library; HangerIcon keeps its own frame, which is not `aria-hidden`). Markup is unchanged.
**Consequence:** `duplication.repo.clones` 12 → 8. The other 20 inline SVGs keep their own frames: they vary in stroke, box and labelling, so no one frame owns them.

## 2026-10-27 — Data seams: coordinate columns, newOutfitSlots, wornPairs, updateOwnedGarment

**Why:** jscpd's clones held four data rules written twice: the numeric(4,2)/(5,2) of a stored coordinate (ten columns over four tables, scale 2 only by agreement with `COORDINATE_DECIMALS`), MCP create_outfit's and suggest_outfit's read-judge-slot sequence, insights' and the recap's pair naming, and three garment writers' owner-scoped update.
**Decision:** `latitudeColumn`/`longitudeColumn` in `schema.ts` derive precision and scale from `COORDINATE_DECIMALS` (drizzle-kit generate: no schema changes); `newOutfitSlots` in `outfits/gone-garments.ts` (one read, the #219 refusal, the slots); `wornPairs` in `wardrobe/insights.ts`; a private `updateOwnedGarment` under `updateGarmentFields`, `updateGarmentProperties` and `setCondition`, which keep their typed field sets.
**Consequence:** behaviour unchanged; `duplication.repo.clones` 8 → 4. Left as coincidental: `push_reminder`/`week_replan` (two claim tables of different owners), the calendar's two upserts (different conflict rules and answers, one statement each), the trip's two packing posts (different writers and answers), and `get_garment`/`get_garment_photo`'s one-line preamble.

## 2026-10-28 — Images ship from the publisher host; ci.yml's publish job deleted (devkit #273)

**Why:** the owner chose one fleet publisher on the publisher host, closet and redlib included although their public Actions still work (local-publish-design.md Q1, 2026-10-27); devkit #273 built it. ci.yml's `publish` job was a second mover of `latest`, with no registry prune (GHCR held 100+ closet versions).
**Decision:** devkit 2720daa; `PUBLISH_IMAGE=ghcr.io/agandhi4/closet` and `publish:` (homelab `devkit-publish@closet.timer`). `ci-image` was already build-only and the gate's `image` job already runs `ci-smoke`, so the publisher runs the gate's two targets. ci.yml keeps only its `workflow_dispatch` test jobs (a public repo's Actions still run; no quick-check existed); nightly.yml now writes its own gha layer cache, which the publish job used to.
**Consequence:** a merge that changes an image input reaches `latest` within 5 min plus the build and the deploy at the next `*:40`; a merge the gate's image job would skip (docs, `GATE_IMAGE_EXCLUDE_PATHS`) publishes nothing. Each publish prunes GHCR to the 10 newest `sha-*` images, so the first one deletes the backlog. Branch protection is unchanged (`local-gate`, `codex-review` are statuses, not workflow jobs).

## 2026-11-02 — Docs describe review rounds and the main check, not the retired gate

**Why:** devkit retired the pre-merge gate (2026-11-02), but AGENTS.md, docs/workflow.md,
docs/operations.md and the Makefile still described `make gate` and `local-gate`, and the `gate`
target called the deleted `devkit/bin/local_gate.sh`, so `make gate` failed.
**Decision:** a PR merges on review rounds (`@codex review` or `make review`, cap 3); main is
proven at deploy by check_tree on the publisher host (≤ once per 3 h, red files `main-red`). `make gate`
runs devkit's stub; `GATE_STATE_NAME` is gone (unread).
**Consequence:** a merge-order clash (duplicate migration numbers) now shows on main and is fixed forward.

## 2026-11-09 — .claude/settings.json denies the five tools no lane can use

Why: claude-kit measured (2026-11-09) that a session's first API call is re-read on every later call, and that the Artifact, ArtifactComments and ArtifactData schemas cost 11.4k tokens, SendFeedback 2.0k and AskUserQuestion 1.7k of it; a whole-tool `permissions.deny` drops the schema from every session and lane in the repo.
Decision: the deny list follows claude-kit's `templates/project-settings.json` (claude-kit #67). No plugin skill or agent uses these tools, and an unattended lane cannot answer a question or publish a page.
Consequence: interactive sessions here lose the artifact publish flow and the question prompt; removing a line from this file brings one back (deny beats allow, so `settings.local.json` cannot).

## 2026-11-11 — CHANGELOG and the upstream Copilot files retired

**Why:** `CHANGELOG.md` had not moved since 2026-09-26 and claimed semver, which the 2026-10-13 release identity retired; `.github/agents/TDD.agent.md` and `.github/prompts/boilerplate.prompt.md` (upstream Copilot config) told agents to write to it and to prefer `_hyperscript`, which `expectFullPage` refuses.
**Decision:** all three are deleted (#374). What ships is the squash title on `main` and its `ship-<date>-<sha7>` tag; the rules the prompt held that we keep are in AGENTS.md's Project rules.
**Consequence:** no changelog to keep; a Copilot or VS Code agent no longer reads rules that contradict AGENTS.md. History cited as "CHANGELOG Unreleased" (`docs/PROJECT_LOG.md`, the 2026-09 reports) is in git before this commit.

## 2026-11-12 — The repos moved to the kashhq organisation; the image did not

**Why:** closet, devkit, claude-kit and homelab were transferred from `agandhi4` to `kashhq`; GitHub redirects reads, but devkit-check compares `GATE_SLUG` with the live slug and refused every commit, and `gh api` does not follow a redirect on a write.
**Decision:** every repository reference names `kashhq/...` (the gate slug, Renovate's preset, the claude-kit plugin source, the public `llms.txt` links). `PUBLISH_IMAGE` and the docs keep `ghcr.io/agandhi4/closet`: a container package does not move with its repo, and production's autoupdater pulls that name.
**Consequence:** moving the image to `ghcr.io/kashhq/closet` is its own change, made with homelab's compose in the same step. Dated history (`docs/history.md`, reports) keeps the old name.

## 2026-11-12 — Repo links, slug and image name moved to the renamed account kashhq

**Why:** the account was renamed agandhi4 → kashhq on 2026-11-12; the container namespace does not redirect (pulls of `ghcr.io/agandhi4/*` fail), and git redirects only until the old name is reused (devkit #469).
**Decision:** this is the image step the entry above deferred: `PUBLISH_IMAGE`, the compose snippets and every live link name kashhq. This log, `docs/history.md` and the dated reports keep the old name where they record the past; the vendored `devkit/` follows through devkit-sync.
**Consequence:** the next publish pushes to `ghcr.io/kashhq/closet`; homelab's stacks pull it from there (homelab PR of the same day). Until that PR lands, production holds its running image, since the old name has failed since the rename.

## 2026-11-12 — A cutout's thumb is trimmed to the garment; the stored cutout keeps its frame

**Why:** a garment photographed with room around it sat small in its tile (#373), but the mask editor overlays the stored cutout on the centre-padded original, so trimming the cutout would misalign the restore brush (or need a stored crop rect and a migration).
**Decision:** only the thumb is trimmed (`cutoutThumb`: alpha > 24, 5% margin, under 0.5% of the frame keeps it whole), squared and sized to exactly 400 px; every tile reads the thumb. The nobg stays the untouched master. Existing thumbs move with `npm run maintenance:retrim-thumbs`, through a new `rederive` event (ready/edited keep their status) under a new variant key, because thumbs are served immutable and cached by the app.
**Consequence:** tiles show every garment at one size, losing the hint of relative size framing gave; small garments are enlarged to 400 px. Photos whose cutout the browser made (`none`) cannot take a key and keep their untrimmed thumb.

## 2026-11-12 — update_garment edits the garment's own fields through the form's reader

**Why:** MCP tagging loops (#372) still had to open the app to fix a name, category, colours, size, brand, notes, price or date; and update_garment's own property path (two writes, a second read) duplicated what the garment form's reader already rules.
**Decision:** the tool builds the stored garment's edit form (`storedFormValues`, the caller's audience), overlays the changes (null clears; category never), and saves through `formPost` + `readGarmentForm`, as add_garment_from_link does. It writes only the fields whose stored value changed, in one `updateGarmentFields` (now taking a partial), and answers the read garment with them. The weight is posted in grams, since the form's ounces do not read back exactly. A new category presets nothing; `ignored` names what its role drops.
**Consequence:** one set of rules for the form and the agent; a field left out is never rewritten (the product link survives a name edit). Statements 5 → 4; a repeat writes nothing. `updateGarmentProperties`/`setCondition` keep their page callers.

## 2026-11-12 — Homelab topology lives in the homelab repo

**Why:** the repo is public and forked. `docs/operations.md` named pgvault's LAN address, the NAS volume paths, the Pi-hole and Caddy files, the private URL and the public MCP host's chain; the September reports carried the owner's home paths.
**Decision:** production's topology moved to homelab's `stacks/closet/README.md` (private); `operations.md` keeps what holds for any install, with placeholders. The reports were scrubbed, not deleted: code cites them. `docs_rules.sh` (docs-check) refuses a 192.168/16 address outside a spec, NAS volume and home paths, dynamic-DNS and tailnet suffixes and the owner's domain; `devkit/` is exempt (fixed in devkit, then synced).
**Consequence:** git history still holds all of it (no credentials ever did); a history rewrite stays an owner decision. A production change edits the homelab README.

## 2026-11-12 — Tailnet hostnames are role words

**Why:** after #477 the public tree still named the homelab's tailnet hosts (the publisher, the NAS, the error tracker, the HTTP twin) in docs, comments and spec fixtures.
**Decision:** they are role words ("the production host", "the publisher host", "the error tracker", "the HTTP twin"); a fixture host is `<role>.example` (reserved, never resolves). The real names live in homelab's `stacks/closet/README.md`. `docs_rules.sh`'s topology rule now also refuses them, specs included; the dated history files are exempt from the hostnames since they are not rewritten.
**Consequence:** a bare `<name>.box` is refused only in Markdown or URL/backtick context, since code has `.box` properties. The rule avoids `\b`: macOS git grep lacks it and matched nothing.

## 2026-11-12 — The topology guard is devkit's (`GATE_PUBLIC=1`)

**Why:** devkit #477 added `check_public_topology` to devkit-check for its public consumers; closet's own `docs_rules.sh` rule (#477, #479 here) duplicated it.
**Decision:** `gate_plan.sh` sets `GATE_PUBLIC=1`. The local rule stays (#482) until devkit's docs-check runs the topology guard for `GATE_PUBLIC` plans: a docs-only commit or PR runs docs-check alone, never devkit-check. Its history exemption shrinks to docs/reports/ and docs/audits/, as devkit's. The check scans the dated history too, so the hostnames in decisions.md and PROJECT_LOG.md became role words in place (no entry moved or re-dated). The SSRF specs' private and CGNAT addresses are generic range examples, so each such line ends `// topology example`.
**Consequence:** a new pattern is added in devkit and synced. The local rule is gone as of the devkit b0eb8e2 sync (devkit #486: docs-check runs the guard for `GATE_PUBLIC` plans). devkit's rules are generic shapes (any `.box` host in Markdown included), never a real name: the owner's domain is no longer checked, since a rule spelling it publishes it (devkit #478).

## 2026-11-12 — A rotate is refused only for a mask its turned copy would lose (#248)

**Why:** the rotate's stale check compared the photo's version, which every cutout bumps, so a second ↻ tap while the first photo's cutout was still pending met the cutout landing and got a 409 error page; the photo the user saw had not changed.
**Decision:** `rotateStillValid` (`src/web/wardrobe/writes.ts`), under the same garment and row locks: the same photo row is still required (another rotate or upload refuses), and then only a mask the turned copy lacks refuses it: with a kept mask any new version, without one a mask saved since. A job's result, a retry or a rederive passes; the rotate requeues the turned photo's own cutout.
**Consequence:** the version stays the check for an edited photo (two masks race exactly as before); a new event that brings user-made cutout bytes must be added to this rule, or a rotate could delete them.

## 2026-11-12 — A strip's keyboard focus moves at keydown; its steps are aria-disabled (#469)

**Why:** focus followed a keyboard step only when the observer chose the target (a 1.5 s record, `FOCUS_WINDOW`), so Enter mid-scroll opened the item being left, a held key stayed on it, and the late `focus()` pulled focus from wherever the user had gone. The step buttons were `disabled` by the script: enabled before it ran, and a focused Next dropped focus to `<body>` at the end.
**Decision:** the arrow handler focuses the step's target synchronously (`preventScroll`); nothing moves focus afterwards. Steps and buttons read one `position()` (the in-flight `heading`, else the chosen item); a step to an end or an inert item is unavailable. The buttons render `aria-disabled="true"` and `syncSteps` sets it, never `disabled`; styling.js re-syncs on a lock.
**Consequence:** a disabled step stays focusable (one more tab stop at an end, on fine pointers only) and a held key on it is a no-op. For a moment the focused option is not yet `aria-selected`; Enter on it only centres it. Selection still moves only through the observer.

## 2026-11-12 — Link import tells a shop that blocks us, and reads big pages up to the cap (#347)

**Why:** of Muse's first ten `suggest_garment` calls four failed. Probed from the Mac with the fetcher's headers: Shopify stores behind Cloudflare (darntough after its www→apex 301, which was followed; blauerboardshop) answer product pages 429 `Retry-After: 60` over HTTP/1.1 whatever the User-Agent, and 200 to the same request over HTTP/2; campmor is Cloudflare's 403 challenge (`cf-mitigated: challenge`) to any UA; sunandski's product pages are AWS WAF's 202 challenge (`x-amzn-waf-action: challenge`) and its og/twitter image is the site logo, `image/svg+xml` (the header is honest; product photos are `image/jpeg`). blauerboardshop's product page is 3.8 MB of HTML, its JSON-LD and og tags in the first 110 KB, `</head>` at 3.2 MB behind a size-chart blob.
**Decision:** the outbound fetcher answers a user's URL that gets a 403, a 429 or a challenge header (any status) with `blocked-by-site` (status kept; fetches naming `hosts` keep `http-status`); the link page says so, and the MCP tools' errors lead with the reason. A page past 2 MB is cut at 2 MB (`truncated`), never refused; images and JSON past their caps still are. No magic-byte sniffing: the refused types were honest. No HTTP/2 and no browser User-Agent: that would be getting past a shop's bot rule, an owner decision.
**Consequence:** `too-large` is now only an image's (or JSON's). A truncated page may cut a late JSON-LD block, which then fails to parse and is skipped like any broken one. Shopify product pages stay `blocked-by-site` until an HTTP/2 transport is decided.

## 2026-11-12 — The whole backlog is approved, in waves, with every recommended option

**Why:** the owner wants every open issue built, the JSON API and the desktop views included ("I want all of this built"), and approved the session's recommendations in one reply.
**Decision:**

- Outfit rules: `docs/plans/2026-11-12-generator-rules.md`.
- Desktop Styling and Calendar: `docs/plans/2026-11-12-desktop-styling-and-calendar.md`, CSS-first and one markup.
- JSON API: `docs/plans/2026-11-12-json-api.md`. #188 goes first; APNs later.
- Offline (#178): wears, washes and packing ticks queue while offline and sync on reconnect (last write wins); a new garment with its photo stays online-only.
- Safari (#244): the sign-out redirect sets a short-lived marker, and the login page sends `Clear-Site-Data` on its 200.
- Link import: HTTP/2 in the outbound fetcher gets its own issue and plan, keeping its pinned-address guarantees.
  **Consequence:** the frontend-pwa rule "unreachable writes are disabled, never dropped" gains an exception for those three queued writes, written into AGENTS.md with #178's change. Each plan's slices are its PRs.

## 2026-11-12 — Clear-Site-Data is relayed to the page a redirect lands on (#244)

**Why:** WebKit applies `Clear-Site-Data` only to the response a load ends on, never to a followed redirect, and sign-out, account deletion, a revoked cookie and a sign-in over another account all answer with one, so Safari kept the HTTP cache (selfies `private, immutable`, `/file/**`).
**Decision:** the redirects stay and keep the header (Chromium and Firefox apply it there). A root onSend hook (`createCacheClearRelay`, `src/web/auth/session.ts`) sets a 60 s httpOnly, Lax, Secure-less `cache_clear_pending` cookie on any non-document answer carrying the header, and the next whole HTML document repeats it once and clears the cookie. Decided on the finished answer, not in `endSession`, which runs before the gate picks a redirect; static paths, fragments and redirects never consume it. The worker deletes the header from every page copy it stores.
**Consequence:** any landing (the login page, the profile, a `safeReturnTo` target) needs no code of its own. In the installed app the worker's followed fetch of the auth POST is the landing that clears; its 303 re-navigation finds the marker spent. Not provable in Playwright's WebKit: verified on the owner's iPhone.

## 2026-11-13 — Root AGENTS.md: Commands keeps one-line comments, the detail lives in README

**Why:** the root AGENTS.md sat 5 bytes under docs-check's 30,720-byte cap, so the next standing rules (outfit rules' area row, the offline queued-writes exception) had no room.
**Decision:** each command in the root's Commands block keeps a one-line comment; flags, timings, what a tier needs and the gate's make targets and git hooks live in README's Development section (Scripts, "The gate's jobs and the git hooks"). The Workflow PR bullets are one; squash-only and fix-forward moved into `docs/workflow.md`.
**Consequence:** about 2.6 KB of headroom. A new command's detail goes to README, not the root's comment.

## 2026-11-13 — Styling at lg: the rows beside a preview, one markup (#468a)

**Why:** on a desktop the composer was a phone column stretched wide with a bar under it, and nothing showed the outfit as a whole (the plan's §2, owner-approved).
**Decision:** from `lg` the rows sit beside a sticky aside (the preview, then Shuffle and Save); below lg every new wrapper is `contents` and the preview `hidden`, so the 390 px page is the same boxes (pixel-identical against main) and `/styling` the same bytes for any device. The preview is a slot per row, drawn by the server and re-sent out of band with every rows answer; between them styling.js copies each choice in on snap-strip.js's new `snap-strip:chosen`, so it works offline and costs no request. Slots are found by row index, not role (two rows may share one).
**Consequence:** any answer that replaces `#styling-rows` must go through `renderRows` (it carries the preview). The weather fit line (468b) hangs off the same aside.

## 2026-11-13 — Typed refusals, the Actor, and a guard before the #188 moves (#188a)

**Why:** access checks live in route handlers and MCP tools, each wording its own 404 (`'Outfit not found'` four ways), so a third surface (the JSON API) would copy them again.
**Decision:** `NotFound(resource)` / `Forbidden()` are `HttpError` subclasses (`src/web/refusals.ts`), messages from one `refusal.*` table; `HttpError` gains `code`, defaulted from the status. `Actor` and `actorOf(request)` live beside the read-ahead in `sharing/access.ts`, the MCP `actorOf(ctx)` in `mcp/tool.ts`. guards.conf `[refusals]` (its own section, so its own ratchet key `guards.refusals.known`): `raw-refusal` refuses `new HttpError(403|404` everywhere but app.ts's not-found handler, domain modules included, since the typed refusal is the one spelling; `route-refusal` refuses `NotFound`/`Forbidden` built in a route or tool, which plain `raw-refusal` could not see.
**Consequence:** today's 52 raw sites are `known` lines, tagged with the 188b–f slice that deletes them; a parallel branch adding or removing one turns main red (fixed forward). devkit's `only-text` is per line, so a 404 prettier wraps onto its own line is unseen.

## 2026-11-13 — Outfit rules in the generator: one compiled rule list, pruned and mended (#21a)

**Why:** plan `docs/plans/2026-11-12-generator-rules.md`: "never A with B" and "always B with A" must reach every surface that suggests outfits, without a statement more and without changing anyone's ideas when they have no rules.
**Decision:** `outfit_rule` (one matcher column set per side; unique over the coalesced sides, since drizzle-kit cannot round-trip `NULLS NOT DISTINCT`) is read by `outfitRulesSql` inside `generatorMemorySql` and the goes-with inputs. The generator compiles the rules and `generator_avoid`'s pairs into one list (`compileRules`): never-rules in `compatible`, each garment's matched sides memoized; always-rules in `passes` plus one repair step per base, moot without a B that can be swapped in compatibly with the outfit's other garments (not just the locks: PR #501's review found a clashing B emptied Ideas); `alwaysCheck` builds the swaps and the repair picks from them, so the two cannot disagree. Never-rules prune by viability (a pool garment that breaks one with a lock) without changing the draw sequence, so the pinned output stands and `GENERATOR_VERSION` stays 1. A never-rule between two locks flags each idea `'breaks-rule'` with `brokenRules`, as the plan asks, which also applies to a locked avoided pair (it used to empty the page). Grantees get none: `browseIdea` passes no rules, as it passes no pairs.
**Consequence:** `IdeaGarment` carries `category` and `type`. Accessories are never drawn, so an always-rule whose B is a belt is moot unless the belt is locked. 21b adds the Style page's writer, which must check that a side's garment is the owner's and that a type belongs to its category; 21c renders the flag's rule text.

## 2026-11-13 — Queued writes replay through their own routes, answered 204 (#178a)

**Why:** the outbox (#178b) replays wears, washes and packing ticks after the phone was offline: it needs the tap's day, an answer it can read without paying for a page, and a guard against a record replayed into another account's session.
**Decision:** the five routes are `config: { queueable }` (`src/offline-writes.ts` lists them; the spec holds both equal). `day` is accepted from today − 7 to today, else 409 `too-old`/`future`; `markWashed` is `greatest(...)` (monotone, no undo). `X-Closet-Queued: <user id>` marks a replay: a mismatch is 409 `account` from a preHandler, nothing written; a replay gets 204 `X-Closet-Outcome: changed | unchanged`; the reason of a 409 rides the same header. `Idempotency-Key` is logged, never stored (the JSON API's model, a convention delta: no receipt table); `clientId` is accepted, stored only from #196a.
**Consequence:** the 404/409/401 a tap gets stay the replay's. The plan's "queued 2 h ago" log part is not sent by the contract, so replays log the key only. A new queueable write is one `config.queueable`, one `QUEUEABLE_ROUTES` entry and a row in `queued-writes.spec.ts`.

## 2026-11-13 — The outbox is the page's, built from TypeScript beside the worker, drawn by the server (#178b)

**Why:** wears, washes and packing ticks must survive a basement or a plane (owner, 2026-11-13: the laundry batch queues, sign-out confirms then discards, 7-day window); iOS has no Background Sync, and the collapse keys and answer table must not drift between the views that render a key and the page that replays it.
**Decision:** `views/assets/outbox.ts` (IndexedDB, replay on reconnect, load and visibility; `navigator.locks` across tabs) is bundled by esbuild into `public/js/outbox.js` (gitignored, like `sw.js`) and imports the pure rules from `src/offline-writes.ts`, which the views use too. A queueable control is `data-offline-queue` plus a region whose other state is a server-rendered `<template data-outbox-state>`: the script picks, never draws. Failures stay in a notice until dismissed; another account's page deletes records unsent. The exception to "unreachable writes are disabled, never dropped" is in AGENTS.md's project rules.
**Consequence:** a new queueable write is a route kind (178a) plus `queueForm`/`outboxRegion` on its control and a row in `queued-writes.spec.ts`; an integration assertion that a state is absent reads `shownMarkup`. The worker's own deletion and refetch are 178c's (`src/web/shell/outbox.md`).

## 2026-11-13 — A tap behind a waiting record goes through the outbox; replays name themselves to the session gate (#178b review)

**Why:** PR #507's review: online, a tap past a record still backing off or in flight landed first and the older replay then overwrote it (Wore today, 503, Undo: worn again). And on the plain-HTTP twin (no Fetch Metadata) a replay without a session got the navigation's 302, opaque under `redirect: 'manual'`, and was failed for good instead of kept for sign-in.
**Decision:** one rule, `goesThroughOutbox` (`src/offline-writes.ts`): offline, or any key of the tap pending, the tap is queued (collapsed over the old record) and drained at once after a drain in flight; an answer is written back only to a record still queued (`settle`), and a replaced record is never sent. The drain lock waits instead of `ifAvailable`. The session gate treats `X-Closet-Queued` (`REPLAY_HEADER`) as a script request (401); `replayVerdict` keeps a status-0 answer like a 401.
**Consequence:** no control may decide its own online/offline path: `route` in `views/assets/outbox.ts` is the only one (over the store since the next entry). A new client of the queued-write routes sends `REPLAY_HEADER`, not Fetch Metadata, to be told 401.

## 2026-11-13 — The outbox's store is its only truth, and one scheduler starts every drain (#178b review 2)

**Why:** PR #507's second review: a tab's in-memory record list disagreed with IndexedDB (a failed put left a phantom pending record that sent every later tap on its key to the outbox) and with other tabs (a second tab's online tap raced the first tab's record); a write queued at `htmx:sendError` while the probe still said online was never drained; a hung replay held the drain lock, and sign-out behind it, forever; a failed record left its control showing the unsaved state.
**Decision:** no record copy in memory: every tap decision (`routesThroughOutbox`), the cap (`enqueue`) and every render read the store as committed, and every write posts on a BroadcastChannel so other tabs re-read (and drain after a put). Taps are held at `htmx:confirm`/`submit` for that read, then sent (`issueRequest`, `requestSubmit`) or queued, serially per tab. `schedule()` is the only drain trigger (enqueue, reconnect, load, visible, another tab's put, the backoff); each replay is aborted after `REPLAY_TIMEOUT_MS` (15 s) as a retry; sign-out waits at most 5 s. A failed record's region shows the server's markup again (`data-outbox-intent` says what to put back) and `outbox:synced` fires for failures too.
**Consequence:** a new decision about the queue reads the store through `OutboxStore`, never a cache; the replay timer is `setTimeout`, not `AbortSignal.timeout`, so Playwright's clock can jump it.

## 2026-11-13 — The Calendar week is a grid from lg, from the same markup (#467)

**Why:** a desktop week read as a 40rem column of seven stacked days; `/calendar` is a cached tab root, so a `?view=` page would be another cache key that fails offline, and the server cannot see the width.
**Decision:** CSS only: the days' wrapper is `lg:grid-cols-7` with a row per week occasion (`weekOccasions`, template plus used, pure); each day a subgrid; pieces placed by `lg:row-start-*` inside `contents` cell wrappers, keeping the phone's DOM order (entries, then open slots) rather than interleaving them by occasion. Empty cells from today on hold a desktop-only "+ Occasion" opener; past empty cells render nothing. `PageMain` gains `agenda` (narrow, wide from lg).
**Consequence:** the phone renders pixel-identical (390 px screenshots against main); desktop focus order is the phone's, so an open slot can be focused after an entry drawn below it. A seventh occasion means a longer `WEEK_ROWS`/`ROW_START` table.
## 2026-11-13 — Outfit rules on the Style page: one select per side, its options the schema (#21b)

**Why:** the plan's §4: the owner adds and removes rules as a native form on a phone, with no script, and a side is a garment, a category (and maybe its type), a colour or a pattern.
**Decision:** each side is one `<select>` whose options are every valid matcher, spelled only by `ruleSideValue` (`garment:<id>`, `category:<c>[:<type>]`, `color:`, `pattern:`); `OutfitRuleBody` accepts exactly those literals plus the garment pattern, so a type outside its category is a 400 from the schema, not a check in the writer. `addOutfitRule` is one statement like `avoidPair` (the garments the actor's, locked `FOR SHARE`, else `NotFound`; `on conflict do nothing` answers a duplicate with the form's message); it and `deleteOutfitRule` take an `Actor` and throw the typed refusals, per #188a. "Allow again" reuses `POST /outfits/ideas/allow`, which now takes a `returnTo` (`safeReturnTo`). The page stays 2 statements.
**Consequence:** a never-rule's sides are stored in one order (`storedSides`, comparing the columns as the unique index does), so "never B with A" is the duplicate of "never A with B" and the list may show the sides swapped from how they were typed; an always-rule keeps its order (directional). The accessory note is CSS (`data-undrawn` on options outside `DRAWN_ROLES`). The page's toast flag is now `?saved=profile|rule-added|rule-removed|pair-allowed`.

## 2026-11-13 — A broken rule is named wherever it shows, and a flagged idea never "fits" (#21c)

**Why:** 21a's generic "Breaks one of your outfit rules" chip did not say which, and MCP's `suggest_outfits` answered `fits: score === 0`, true on a flagged idea; Muse also had no way to read the rules it must keep.
**Decision:** one wording, `src/web/style/labels.ts`: `brokenRuleLabels` ("Breaks: Never {a} with {b}", a chip per rule) on Ideas' `Reasons` and Styling's Shuffle (`StylingModel.broken`); the rule's garments are named from the idea's own (a broken rule is two locked garments'), so no read is added. MCP `fits` is the card's, `problems.length === 0`, with `brokenRules` beside it. `get_style_profile` adds `outfitRules` (kind, `a`, `b`, `sentence`) and the gallery's `avoidedPairs`, still one statement. No write tool (plan §4).
**Consequence:** only Shuffle locks two garments today, so Ideas, Today and `suggest_outfits` (one lock at most) cannot show a flagged idea yet; their code is correct by construction, proven only on Shuffle (`styling.spec.ts`). The generic `gallery.problem.breaks-rule` string is gone.

## 2026-11-13 — Styling's fit line loads on intersect, desktop only (#468b)

**Why:** plan §2 (owner decision 3: the weather fit line, desktop first): Styling should say how the rows' outfit meets the day, while `/styling` stays a byte-stable tab root and a phone, where the line is hidden, pays nothing.
**Decision:** `GET /styling/fit` (only with `WEATHER_ENABLED`) answers `assessOutfit` for `aimIdeas`' day in the gallery's words (`gallery/chips.tsx`, shared with `Reasons`), in one statement: `rowWeatherSql` under the rows' one carry rule, beside ideasFor's own `weatherColumn`/`weatherFrom` (split out of `ideasColumns`/`ideasFrom`, so both read a day the same way). The slot triggers on `intersect once`, not the plan's `load`, and on `styling:outfit-changed`, which styling.js sends only when a choice changed the preview and the slot is shown, not `snap-strip:chosen from:#styling-rows` (that element is replaced by every rows answer, and the event fires on every first watch). Rows answers send the slot out of band to reload it.
**Consequence:** the slot's request is cached by the worker like any fragment (`|hx`); offline it dims and says so. Formality is not judged (weather only). Showing it on a phone later is a CSS change and dropping the `offsetParent` gate.

## 2026-11-13 — The garment access path takes an Actor; an unseen wardrobe reads as what the caller named (#188b-1)

**Why:** #188's plan §4: the domain function enforces access and throws the typed refusal, so pages, MCP and the API refuse alike; garments first, reads before writes (the L area split, 188b-2 the writes).
**Decision:** `authorizeWardrobe(db, actor, ownerId, need, unseen: Resource)` throws `NotFound(unseen)` / `Forbidden()`; the read ahead rides on `actorOf(request)`, so statement counts hold. `requireGarment(db, actor, { id, ownerId }, need)` reads an unseen wardrobe as "Garment not found" (a page's garment URL); MCP names the wardrobe, so it keeps "Wardrobe not found" via `wardrobeFor` then `garmentIn(db, access, id)`, which takes only an authorized `WardrobeAccess`. `garmentGuard(db)` gains `authorize.garment(request, need)`, so the wears plugin and every `authorize(request, need)` call stay as they were. `Forbidden` takes a `reason` from its own table (search_garments' needs-wash keeps its explanatory message). The wishlist inbox's unseen wardrobe is now "Wardrobe not found" (it was "Not found"; status unchanged).
**Consequence:** search_garments parses before it authorizes, as a page's schema does: a malformed type is a 400 even on a wardrobe the caller cannot see. The garment write paths still call `garmentNotFound()` themselves until 188b-2.

## 2026-11-13 — Metrics are a cleanup-round report; devkit's friction cuts synced

**Why:** the owner: a per-PR ratchet is overkill; refactor/cleanup rounds can read it instead (devkit#497, devkit#498, devkit decisions 2026-11-13). Tighten commits and the `metrics-rebaseline` label cost turns and caught no defect.
**Decision:** devkit synced to 1ee0e26. `make ci-metrics` prints WORSE/BETTER and exits 0; `GATE_JOBS_METRICS` and `TIER_BUDGET_ENFORCE` wording are gone, docs caps and tier budgets only warn. Floors only warn now too, so a lost test glob shows as a FLOOR warning in the tier output rather than a failure: read the warnings.
**Consequence:** no per-PR `make metrics-tighten` or label; a cleanup round runs `make ci-metrics` and tightens. Earlier entries naming the label are history.

## 2026-11-13 — Device tokens: one credential table, a kind per surface, a password change behind the row lock (#189)

**Why:** plan `docs/plans/2026-11-12-json-api.md` section 3: native clients need bearer tokens that `/mcp` refuses, and the plan check found that a password change could miss a token minted concurrently, and that a mint could outlive a password changed after it was checked.
**Decision:** `personal_access_token.kind` (`mcp` | `device`, default `mcp`). `authenticateToken` scopes by kind. `MAX_ACTIVE_TOKENS` (20) counts per kind, over rows in force. At the cap an agent mint is refused and a device mint evicts the least recently used (`coalesce(last_used_at, created_at)`, then the lowest id; a minute's resolution, since the last use is written at most once a minute), logged. `updatePasswordHash` becomes two statements in a transaction: the hash first (the row lock), then the revocations. `createToken` rechecks the caller's full verified hash under the same lock (`password-changed`). Revoking an agent token or a device asks for no password, a deliberate step-up exception: it only narrows access, and minting stays password-gated. A revoke that finds nothing redirects with a notice (no 404 page).
**Consequence:** change password costs 5 statements (was 2; ratchet rebaselined). #190's sign-in must pass the hash it verified. Once a device-authenticated caller can mint, `createToken` needs an `excludeId` so a device never evicts itself. Rolling the code back past this change once #190 mints device tokens would let `/mcp` accept them (the older `authenticateToken` ignores `kind`).

## 2026-11-13 — A push subscribe takes the user's row lock and rechecks its session under it (#512)

**Why:** after #189 a token minted during a password change was revoked, but a subscribe took only the foreign key's share lock, which a password update does not wait for: a subscription committed meanwhile outlived the new password.
**Decision:** `upsertDevice` is one insert-select from the user's row `for no key update`, only while `right(password, 8)` equals the session's `pwf` (`sessionFingerprint(request)`). The session's fingerprint, not the full hash: it is what the gate trusts, and a subscribe has no password check to carry a hash. `no key update` serializes with the password's update without holding up other inserts' foreign-key checks on the user. A refused subscribe answers as the gate answers an ended session's fetch (`endSession` + bodiless 401, `loginRequired`).
**Consequence:** still one statement (the subscribe's budget holds). Specs that make a device outside a request go through `subscribeAs` (harness). Any new writer of something a new password must end follows the same shape.

## 2026-11-13 — The worker deletes the queue only at a confirmed sign-out, refetches what a sync changed, and tells the tabs (#178c)

**Why:** the plan gives the worker the session boundary and the refetch (`OUTBOX_SYNCED`), but not which boundaries, which pages, or how the refetch meets `freshness.js`'s `REVALIDATE_PAGE` on the same page.
**Decision:** the worker deletes every record at a sign-out or account deletion that redirected, and other accounts' at a claim for a new owner; a revoked session and an auth POST with no answer keep them (a lost queue is the user's taps, a lost cache only a refetch). The refetch takes only allowlisted write paths (`syncedWritePaths`), renews every cached page that draws one (`showsQueuedWrite`), the sender's included, then posts every controlled tab the copies that changed with their markup (`PAGES_RENEWED`), which `freshness.js` swaps in like a revalidation. A `REVALIDATE_PAGE` after the renewal would find nothing new, so the page's `outbox:synced` revalidation is gone (it replaces 178b's "fires for failures too": a failure's region is put back by the outbox). Skipping only the sender's page left a stayed-put sender's copy stale and every other tab unswapped. The claim's rule is `queuedWritesGoneAtClaim`, compared as stored: X-Page-Account and `data-account` must stay one spelling. The database's definition is one module both bundles import (`views/assets/outbox-store.ts`).
**Consequence:** a new page that draws a queued write's state gets a row in `showsQueuedWrite` and its spec; a new reader or writer of the outbox opens it through `outbox-store.ts`, never its own `indexedDB.open`.

## 2026-11-13 — The garment writes take an Actor and refuse themselves (#188b-2)

**Why:** #188 section 4 after 188b-1's reads: every garment write handler and MCP write tool still turned an outcome into `garmentNotFound()`, a 409 or a raw 404 itself, so the API would copy each.
**Decision:** `wardrobe/garment-actions.ts` holds each write as `(db or deps, actor, address, input)`: authorize (`garmentWardrobe`, or `requireGarment` where the write needs the stored garment), call the owner-scoped query, throw `NotFound`/`Forbidden`/409 with a `logDetail` (the error handler and MCP log it, so callers no longer log refusals). `buyWishlistItem` does the same in `wishlist/purchase.ts`; asking for the archive is `purchaseNeed` = ownership, which replaces the route's raw 403. A page that needs the wardrobe before the write (a form's audience, a refused form) asks its guard first; the writer's check is then free (own wardrobe, or the read ahead), so statement counts hold. `GarmentAddress.unseen: 'wardrobe'` keeps MCP's "Wardrobe not found". The order review's gate is a preHandler hook answering `reply.callNotFound()` (the app's own not-found handler, not a hand-built 404).
**Consequence:** new resources `draft`, `need`, `orderItem`, `repair`; the mask save's vanished photo now reads "Garment has no photo" (status unchanged). Not moved: create and clone (no refusal of their own in the handler), the add-photo upload, add_garment_from_link (authorizes before its rate limit, said at the site).

## 2026-11-13 — Capsules and the Muse inbox take an Actor and refuse themselves (#188c)

**Why:** #188 section 4, order item 3: the capsule routes, the inbox's decisions and need page, and the capsule and Muse MCP tools each turned an outcome into their own 404 or 409 (`'Not found'` in the inbox, `'Capsule not found'` spelled twice).
**Decision:** `capsules/capsule-actions.ts` (`requireCapsule`, `capsuleIn`, create, rename, delete, `setCapsuleMembers`, `setGarmentCapsules`; `capsuleNotFound` moved there) and `wishlist/suggestion-actions.ts` (`requireNeed`, `makeDecision` over decide's page decisions, and Muse's `checkSuggestionRoom`, `markSuggestedPick`, `createNeed`, whose 409 wordings moved from the tool) take `(db, actor, address, input)` and throw the typed refusals; `goesWithCloset(db, actor, id)` throws `NotFound('wishlistItem')` ("Not on your wishlist", unchanged). Create and rename still ask the guard (rename the capsule) before the form, so a refused form is drawn only for the owner; the writer's own check is then free, and statement counts hold.
**Consequence:** an unseen wardrobe now reads as what the URL names: a decision's "Garment not found" or "Need not found" (was "Not found" or "Wardrobe not found"), the garment page's capsule toggles "Garment not found" (was "Capsule not found"); statuses unchanged. suggest_outfit's refusals are the outfit writer's (`proposeOutfit`) and move with outfits (188d). `[refusals]` known: 24 lines (37 sites) to 19 (29).

## 2026-11-13 — The API is a surface, named by the route or its path, and answers problem+json (#190)

**Why:** `config.bearer` was read in three hooks, each deciding alone that a request was not a page; a second bearer client (`/api`) and its unmatched paths needed the same answer everywhere. A first build read the cookie on `GET /api/v2/x`: the static files' `GET /*` wildcard matched it, so `is404` was false.
**Decision:** `config.surface` (`page`|`mcp`|`api`) replaces `bearer`. The root onRoute hook `assignSurface` stamps `api` on every `/api/v1` route and stops the boot on any disagreement. `surfaceOf` reads the route's surface, else the path, in any case, so any `/api` request no route matched is `api`. The error handler answers `api` with RFC 9457 `{ type: about:blank, title, status, detail, code, requestId, errors? }`, built in `errors.tsx` (the guard's one `node:http` importer); `HttpError.retryAfterSeconds` sets `Retry-After`.
**Consequence:** a new bearer client is a new surface value, never a flag; `src/web/surface.ts`'s readers are the list to extend. An unknown `/api` path never echoes its URL.

## 2026-11-13 — One sign-in budget for both doors, and a per-account cap on the API's (#190)

**Why:** route-config limits are a counter per route, so the login page and the API sign-in would each give an address 5 guesses a minute. An API sign-in mints a token that lasts until revoked, so guesses spread over many addresses matter more there.
**Decision:** `SIGN_IN_LIMIT` is one `createRateLimit` checker (`signInLimit`, built in `webPlugin`) that both doors count on in onRequest: 5 a minute per address in all, the 6th a 429. The API door also counts `SIGN_IN_ACCOUNT_LIMIT`, 5 a minute per SHA-256 of the normalized email (preHandler, after the body). Both doors check through `checkSignIn`, one bcrypt comparison on every path.
**Consequence:** the page login has no per-account cap yet (an owner call: it would let anyone slow one person's browser sign-in). Registration keeps its own route-config counter.

## 2026-11-13 — The OpenAPI spec is committed and served as committed; swagger is a devDependency (#190)

**Why:** a Swift client generated from the spec needs every contract change to be a reviewed diff, and generating at boot would put a dev tool in the image and serve whatever the build happened to produce.
**Decision:** `npm run api:spec` (`scripts/api-spec.ts`) registers `apiPlugin` on a bare Fastify with `@fastify/swagger` (OpenAPI 3.1, `info.version: v1`) and writes `src/web/api/openapi.json`. `GET /api/v1/openapi.json` serves that file, imported. `scripts/api-spec.spec.ts` (unit) fails when the file differs from what the routes generate, and validates it. `requireContract` refuses a route at boot that lacks its operationId, tags, 2xx and problem responses.
**Consequence:** every `/api/v1` change runs `npm run api:spec` and commits the file. `Problem` is one shared schema (`addSchema`, by `$id`); a new shared resource schema can join it the same way.

## 2026-11-13 — Only our own words reach an error's answer and log line; the API authenticates before the body (#190)

**Why:** `describeError` passed any Fastify 4xx message through to the page, the problem's `detail`, MCP and the warn line; a body parser's message can quote the request (JSON.parse's SyntaxError names the bytes, a password's included; Fastify 5.12's default JSON parser happens not to). And the device-token check ran at preValidation, after the body was read, so a stranger got a 400 or 413 instead of the 401.
**Decision:** an HttpError's message and ajv's validation messages (rule and field, never the value) pass; every other 4xx gets a fixed `refusal.request.*` message by status, its `code` (or class name) as the log detail. `createDeviceTokenHook` is an onRequest hook, after `refuseQueryToken`. `isApiPath` (`src/web/api-path.ts`) is the one "is this /api" rule, read by `surfaceOf` and the worker's `bypassesWorker`.
**Consequence:** a 4xx that needs its own wording throws an HttpError. A multipart "request file too large" now reads "The request is too large".

## 2026-11-13 — Outfits, the calendar and the week plan take an Actor and refuse themselves (#188d)

**Why:** #188 section 4, order item 4: the outfit, calendar and week-plan routes and their MCP tools each turned an owner-only outcome (`'not-found'`, `'no-such-outfit'`, `ReplaceRefused`, `ProposeOutcome`) into their own 404 or 409, `'Outfit not found'` spelled five ways.
**Decision:** `outfits/outfit-actions.ts` (`requireOutfitPage`, `requireOutfit`, `editOutfit`, `removeOutfit`, `reactToProposal`, `proposeOutfitTo`, `outfitNotFound`) and `calendar/entry-actions.ts` (`planOutfit`, `markEntryWorn`, `requireEntry`, `removeEntry`, from the deleted `writes.ts`) take `(db, actor, id, input)` over the owner-scoped queries with `actor.userId`; `replaceEntryOutfit`, `undoWeekPlan` and `allowPair` take the Actor and throw themselves (`isRefused`/`replaceRefusal` gone). Private records ignore the share read ahead: a VIEW or MANAGE grantee is a stranger, a 404, never a 403. New resources `weekPlan`, `avoidedPair`, messages unchanged. The ideas' feedback route is registered only with `WEATHER_ENABLED` (it was a hand-built 404).
**Consequence:** a refused replace now rolls back whole (a pick's proposal adoption before an already-on-the-day 409 no longer commits) and logs through the error line's `logDetail`, not its own info line. Not moved: `pickIdea`'s `'not-found'` (garmentsGoneError at pickTo, Wear this, pick_outfit), `avoidPair`. `[refusals]` known: 19 lines (29 sites) to 11 (16).

## 2026-11-13 — Saved looks: a table of their own, private photos through one sender, a link kept when the site refuses (#22a)

**Why:** plan `docs/plans/2026-11-13-inspiration-library.md` §3 and §7: a look is the owner's taste (owner-only), a whole picture (no cutout), and most social pages refuse our fetcher.
**Decision:** `inspiration` (photo, link or both, by check) and `inspiration_piece` (roles, types, colours, patterns checked against `properties.ts`; no array default: drizzle-kit reads `'{}'` back as drift). The photo is a `file` row inserted `unwanted`, `ON DELETE CASCADE` to the look, counted by `photoIsReferenced`, refused by `publicPhoto`, served by `/inspiration/photo/*`. Selfies' owner-only image answer moved to `sendPrivatePhoto` (`src/web/files/private-photo.ts`) and `SelfiePhoto` became `PrivatePhoto`, so the next private photo reuses both. A pasted link's pending photo is claimed in the look's transaction; a 502 refusal or a page without a readable photo saves the link alone with `?unread=`; a 400 refusal saves nothing. The link route has a `LINK_IMPORT_LIMIT` checker of its own, as the order mail does.
**Consequence:** a new private photo kind joins `publicPhoto`, `photoIsReferenced`, `photo-ref-guard.spec.ts` and goes through `sendPrivatePhoto`. Looks have no per-user cap (garments have none either).

## 2026-11-13 — devkit is pinned and materialized, no longer vendored (devkit stop-vendoring canary)

**Why:** 37 of 77 commits in 30 days were "Update devkit to …" PRs of ~150 files through the hooks; devkit's plan `docs/plans/2026-11-13-stop-vendoring.md` (owner decision 2026-11-13) keeps the guarantee that a commit names the exact devkit it was checked with, at a one-line bump. closet is its canary.
**Decision:** `devkit/` is untracked and gitignored (`/devkit/`, `/devkit.*`); `.devkit-rev` keeps its two fields; `.devkit-bootstrap.sh` (byte copy of devkit's template, held by devkit-check) materializes it, run by the Makefile's first-lines include stanza and by the hooks. No eslint, vitest, knip, tsconfig or Dockerfile path changed (no COPY names `devkit/`).
**Consequence:** a fresh worktree needs `make install` before a bare `npm test`; an old commit needs `rm -rf devkit` before checkout. The migration itself ran devkit's own `bin/devkit-sync.sh --stage <full sha>` from a devkit checkout (a short sha fails its `git fetch`). Rollback is `rm -rf devkit` first, then reverting the migration PR: git refuses to re-add the tracked `devkit/` files over the materialized untracked one. Lane branches cut before this merges hit a one-time modify/delete conflict on `devkit/*` if they touch it (resolve by deleting; the bootstrap refills it). The Makefile stanza makes the include depend on the stamp and `devkit/bin`, so a half-filled `devkit/` heals on the next make. Actions jobs run `./.devkit-bootstrap.sh` after checkout with `DEVKIT_READ_TOKEN` (devkit is private; the owner adds the secret).

## 2026-11-13 — Recreate this look: ranked, then re-picked to go together; pieces as one kind select (#22b)

**Why:** plan `docs/plans/2026-11-13-inspiration-library.md` §4: a look's pieces matched to the closet must also go together, and a piece's type must always be its role's without a redraw that would fight the autosave.
**Decision:** `recreateLook` (`src/wardrobe/recreate.ts`, pure, no seed: every tie ordered down to the id) ranks per piece by type, colour (main over accent, `CLOSE_COLORS` below equal), pattern, then available, rested, id; a match must share the type or a colour. The closest set must keep `colorsGoTogether` and the never-rules (avoided pairs included) with no garment twice; otherwise the sets fewest steps down the rankings are tried, the loudest piece first, bounded (`SEARCH_DEPTH`, `MAX_TRIES`), else the closest are kept and the pieces named `unfixed`. What the look's own pieces break (judged as garments) is excused, as locked garments are in the generator. Availability ranks, never filters: a look is recreated from what the owner has. The form's `kind` is `role` or `role/type`; colours are two selects (main, second), so the cap and the order hold by construction; colours got `property.color.*` labels.
**Consequence:** MCP's `get_inspiration` (22d) calls `recreateLook` over `recreateInputs`; 22c gives the strips a `name` and writes `matched_garment_id` (a piece's edit already clears it).

## 2026-11-13 — Trips and packing take an Actor and refuse themselves (#188e)

**Why:** #188 section 4, order item 5: the trip routes, the trips MCP tools and the gallery's pick for a trip each turned `'no-trip'`, `'not-a-trip-day'`, `'no-outfit'` or a miss into their own 404 or 400, the day's 400 worded three ways (MCP paid a second statement to name the dates).
**Decision:** `trips/trip-actions.ts` (`requireTrip`, `requireTripPage`, `requireTripModel`, `requireAddOutfitPage`, `editTrip`, `removeTrip`, `locateTrip`, `planTripOutfit`, `pickIdeaForTrip`, `takeOffTrip`, `wearTripOutfit`, `packTrip`, `packTripItems`, `addTripItem`, `removeTripExtra`, `copyTripExtras`; `tripNotFound` moved there from `validation.ts`) take `(db, actor, address, input)` and throw `NotFound('trip')`, `NotFound('outfit')`, the day's 400 (`trips.NOT_A_TRIP_DAY`, the dates from the lock's `NotATripDay`) and "Wore it"'s 409 (now i18n). Trips are private: grantees are strangers. The queued checklist routes still refuse before `isReplay`, so a replay of a gone trip is the 404 it was.
**Consequence:** the page and gallery's day 400 now names the trip's dates (was `body/day`/`body/for must ... day of the trip`); plan_trip_outfit's unholdable garments are `garmentsGoneError`'s named refusal like pick_outfit's (was "A garment is not in your closet"). `[refusals]` known: 11 lines (16 sites) to 8 (12), none an area slice's but sharing and sizes (188f).

## 2026-11-13 — The last refusals: sharing, sizes, selfies and the account typed; NotServed for paths a route answers as absent (#188f, #188g)

**Why:** #188's guard still held 12 raw 404s outside an area slice. Seven were access or existence decisions; five were a public route saying a path does not exist (the image server's non-photo or private name, an unknown share id, bytes missing from storage, /metrics through a proxy), where no actor asks and a resource word would change the bare body those routes always answered.
**Decision:** `removeShare`, `updateBrandSize`, `deleteBrandSize`, `attachSelfie` and `removeSelfie` take the `Actor` and throw `NotFound` (`share`, `brand`, `calendarEntry`, `selfie`); `updatePasswordHash` and `lockOwner` throw `NotFound('account'|'wardrobe')`. The five request concerns throw `NotServed` (`refusals.ts`: 404, the status text, no resource), allowed only at the sites guards.conf `@not-served` lists, each with its reason in the rule's comment: an only-text allow list, not a `known` count, since they are design, not debt.
**Consequence:** the `[refusals]` known list is empty. Messages changed: removing a share the user is no party to reads "Share not found" (was "Not Found"); statuses and every public `/file/**` and `/metrics` body unchanged. A new site answering a path as absent adds its file to `@not-served` with its reason; an access refusal is never NotServed.

## 2026-11-13 — A look's choices live in matched_garment_id; Save is pickIdea; Find this makes no product link (#22c)

**Why:** plan `docs/plans/2026-11-13-inspiration-library.md` §4 and §7.5: the match view saves the chosen set as an outfit and turns a missing piece into a wishlist item at once, and a double tap must not make two of either.
**Decision:** `matched_garment_id` holds whichever garment was chosen for a piece: the closet garment the save recorded, or the wishlist item "Find this" made (a wishlist piece shows "On your wishlist" with no strip; once bought it is a closet match like any). No column for "None": it is stored as null, so the page offers the closest again. Save is `pickIdea` inside one owner transaction with the look locked and the choices recorded by one guarded `UPDATE ... FROM (VALUES ...)` (owner's garment, the piece's category), so the once-per-garment-set rule is the double-tap guard. Find this locks the piece row, then asks in a second statement whether its match is already on the wishlist (a single statement's snapshot would miss a twin's commit). The item has **no product link**, unlike the plan: a look's page is not a shop, and Muse's never-again rule compares products by link; the look goes in its notes.
**Consequence:** "Save with wishlist pieces" (plan §4) is not built; MCP's 22d tools read `matched` from the same `lookJsonSql`.

## 2026-11-13 — Piece edits take the look's lock; wishlisted pieces leave the assignment (#22c review)

**Why:** a piece's autosave raced the save (a role changed under it, a top recorded for a bottom), and one joined `FOR UPDATE` statement reads the pieces from its start snapshot, not after the wait. A wishlisted piece in `recreateLook` reserved a garment a later piece needed.
**Decision:** `updateInspirationPiece` runs in a transaction under `lockOwnLook`, the save's lock; `lockLookForSave` locks, then reads roles in a second statement. The GET passes only unwishlisted pieces to `recreateLook` and maps results back.
**Consequence:** a save after an edit sees the edited role, and its category check refuses a stale choice (409).

## 2026-11-13 — Recreate: saved choices are pinned in the matching, duplicates are refused

Why: a saved garment (`matched_garment_id`) lived outside `recreateLook`, so truncating to the top three could drop it, and two strips could default to or post one garment, which `pickIdea`'s Set dedup silently collapsed.
Decision: `recreateLook` takes `saved` per piece; a saved garment that still matches is that piece's only candidate in the assignment and leads its matches, and no other piece is offered it. `saveRecreation` answers 409 for one garment on two pieces.
Consequence: the page's defaults are unique by construction; the view no longer picks the saved garment itself.

## 2026-11-13 — API parity is one reviewed manifest, not a flag on each route (#191)

**Why:** the plan (2026-11-12-json-api.md section 5) had each page write route declare `config.operation|webOnly|apiPending`, and an `api.pending_routes` ratchet key. Metrics are report-only since devkit 2026-11-13, so a ratchet would gate nothing, and a config on every write route across the feature plugins would scatter what the issue asked for: one reviewed allow-list.
**Decision:** `src/web/api/operations.ts` holds `OPERATIONS` (every operationId, enforced at boot by `requireContract`), `PAGE_WRITES` keyed `METHOD /template` (an API twin, a named web-only reason, or `pending` #192–#195) and `MCP_WRITES` (listed, `agentOnly` for Muse's round). `api-parity.spec.ts` is the gate: unclassified, stale and dangling-twin lines fail, the way `authorization-coverage.spec.ts`'s EXEMPT does. Refusal parity is a matrix route's `api` twin, replayed by `describeMatrix` on the group's own database.
**Consequence:** `POST /auth/login` and `/auth/logout` are the only twins today (`signIn`, which shares `checkSignIn` with the login page, and `signOut`); no matrix route carries `api` yet, so the replay first runs with #192. The pending count shrinks as lines turn to `api`; nothing counts it. Saved looks (#22) are filed under #193.

## 2026-11-13 — The API's garment reads: searchGarments, the page's reads, the share read with the token (#192a)

**Why:** plan section 6 named `gridPage` plus `readFilterOptions` for `GET /garments`, but the grid's reader drops what does not apply (URL state), while a client names its filters, as MCP's `search_garments` does; and a grantee's API read paid a share lookup the page saves (#170), one statement over its twin.
**Decision:** `GET /api/v1/garments` calls `searchGarments` with MCP's filter names (`searchFilters`/`checkedType` moved to `wardrobe/garment-search.ts`, i18n), and `garmentSummaries` reads the garment page's photo (one join), which MCP leaves out. `GET /garments/{id}` is `requireGarment` + `garmentContext`, mapped by `garment-resource.ts`. `authenticateToken` takes `shareOf` (`shareToReadAhead`, now without a known user) and reads the share beside the token; `actorOf(request)` takes the device token's user on the api surface. Cursors are `idCursor` (base64url `id:<n>`, `src/web/api/resource.ts`); nulls are dropped by `withoutNulls`, since Fastify serializes a null through a `string` schema as `""`.
**Consequence:** both reads cost 3 statements for the owner and a grantee, as their pages. The filter modal's choices (`readFilterOptions`) have no endpoint yet; a native filter sheet needs one (192b or later). `authorization-coverage.spec.ts` counts a matrix route's `api` request as coverage.

## 2026-11-13 — A share never writes without a same-origin confirmation; MCP tags looks by keeping equal pieces (#22d)

**Why:** a manifest has one `share_target`, so links and photos share one multipart POST; a first version had the service worker relay it to the server, but the worker cannot tell Android's share from a cross-site page auto-submitting the same form (no client id, no readable Origin), and its relay carried our Origin and the cookie: a CSRF bypass saving a look in the victim's account, repeatable, up to 100 MB a post.
**Decision:** with `PWA_ENABLED` the target is `POST /inspiration/share`, answered **only by the worker, never sent on** (`receiveShare`, `share-target.ts`; no server route): the first `image/*` file (at most 20 MB) is kept in Cache Storage (`shares-v1`, a session cache, one share, an hour) and the answer is a 303 to `GET /inspiration/share/confirm#<id>` (a fragment: never sent or logged), whose **Save look** is a native post to the existing `POST /inspiration` (same-origin, `fileSize` 20 MB); no photo is a 303 to the link page with the link only. Without the worker the target stays the GET, links only. `set_inspiration_pieces` keeps a stored piece equal to one asked for (its position and choice too) and adds the rest after the highest position, so a stale match view never posts onto a different piece; `add_inspiration` is the paste's writer, so a blocked site saves the link and answers `unread`, not an error.
**Consequence:** a cross-site share can at most show the victim a photo they must choose to save. The share sheet is proven only on a phone. A share while signed out is lost (the sign-in drops the stash). The auth posts' relay has the same flaw (#542, its own fix).

## 2026-11-13 — The share target's server fallback is the one Origin-less page route (#22d review)

Why: with no controlling worker (storage cleared, not yet installed) Android's share post reaches the server with no Origin; the same-origin hook's 403 left the person on an error page.
Decision: `POST /inspiration/share` writes nothing and answers a 303 (link page, or `confirm#not-opened` for a photo, whose bytes it never reads); it says `config: { stateless: true }`, the hook's one page exemption, allowed only on `STATELESS_ROUTES` (the boot refuses any other). Save look opens 800 ms after the preview is decoded and visible and refuses taps begun earlier; a shared photo is deleted by the look's page, not on submit.
Consequence: a new Origin-less route is a reviewed CSRF exemption with a list entry and a no-write spec; a photo shared without the worker must be shared again from the open app. #542's stop listener answers the share target alone, on the device (`navigationPostAnswer`); every other navigation post is the browser's.

## 2026-11-13 — Every synced write takes its owner's lock first, one release before the sync triggers (#196a-1)

**Why:** the sync triggers (#196a-2, plan 2026-11-12-json-api.md §7) bump a per-owner revision by updating the owner's `user` row from inside the write, after the written row is locked. Garment, trip, capsule, size and photo writers locked their row first, so the bump would have closed deadlock cycles with owner-first writers (`pickIdea`, `deleteOutfit`'s cascade into a trip, `swapPhoto` against a cutout result).
**Decision:** every write to a synced table takes the owner lock before any other row lock, folded into its existing first statement (`ownerLockCte`, `src/db/owner-lock.ts`: no new statements), and marks the transaction once the row is held. A test-only guard on every spec database (`test/support/sync-guard.ts`) refuses a synced write without the mark; fixtures write through `asFixture`. The migrations (columns, tombstones, triggers that raise on an unlocked write) are #196a-2.
**Consequence:** **#196a-2 merges only after #196a-1 is deployed**: its strict triggers would fail every write of a build that predates this one, during the deploy overlap or a rollback. A rollback two releases back (to before #196a-1) onto the trigger schema is unsupported. Inspiration (#22) is not synced: its API endpoints decide that later. The guard catches forgetfulness, not malice. Review found two traps: `ownerLocked` counts the CTE's rows, since an `exists` locks only the first of several owners (account deletion's set), and a write that deletes a row the owner's holder also deletes (a pending photo's claim) takes the owner first too.
## 2026-11-13 — Every owner lock bounds its waits; a name is locked only behind its owner (#196a-1, review 2)

**Why:** folding the owner lock into garment, wear, trip, capsule, size and cutout writes made them wait on the holders `lockOwner`'s writers wait on (planMyWeek, the re-plan, deleteOutfit), but only `lockOwner` set `lock_timeout`, so a folded wait ran to statement_timeout and answered a 500. The discard and the look's save still took the photo name before the owner.
**Decision:** `ownerLockSelect` always sets `lock_timeout` (`OWNER_LOCK_TIMEOUT_MS`, now in `src/db/owner-lock.ts`); `describeError` answers any 55P03 as `OwnerLockTimeout`'s 503 (moved to `src/web/errors.tsx`), `ownerTransaction` still throws it naming its writer for the jobs that defer on it. `lockPhotoName` is gone: `lockOwnerAndPhotoName` (one statement) is the only name lock; the discard locks the uploader, whose deletion deletes the row.
**Consequence:** account deletion and the cutout job's row writes now give up after 5 s behind a held owner lock (a 503; a job's lease lapses and it reruns) instead of 15 s. Neither old taker deadlocked (they took no lock after the row), but the old look's save beside a deletion left a `file` row the cascade dropped with its bytes unreturned.

## 2026-11-13 — The API's garment writes: the form's reader shared, lean answers, set-state status (#192b)

**Why:** plan section 6 wanted `PATCH /garments/{id}` through "a JSON reader beside the form reader"; MCP's `update_garment` already had one (stored form values + changes, `formPost`, `readGarmentForm`), private to its tool file. Answering each write with the garment read again would cost statements its page twin (a redirect) never pays.
**Decision:** that reader moved to `wardrobe/garment-changes.ts` (`readGarmentEdit` for an edit, `readNewGarment` for a create or clone), the one path MCP and the API save by; `garment-api-input.ts` maps the resource-shaped JSON (`properties`, `careLabel`, `care`) onto it, and a form refusal is a 400 problem whose `errors` name `body/<field>` (`HttpError`'s new `validation`). Writes answer what changed (`{ id }` + `Location`, `{ ignored }`, `{ status }`...), never the garment. `PUT .../status` is set-state (`putGarmentStatus`: already there is a 200, not Archive's 409). The plan's `POST .../copies` for a clone is `POST .../clones`; `.../copies` is "add a copy" (quantity), as the pages name them. Bulk edit is `PATCH /garments`. `clientId` is accepted and logged, not stored, until #196a.
**Consequence:** every write costs what its page twin does, but PATCH: one more (it reads the garment it merges into, as `update_garment` does) and tags one less (`api-statements.spec.ts` pins each against its twin). Still `pending: '#192'`: the repair log, the photo routes (#192c) and the link import.
## 2026-11-13 — /api JSON bodies are validated without type coercion

**Why:** Fastify's ajv coerces types (`coerceTypes: 'array'`), so under `Nullable`'s null-first union a `0` became null: "never wash" (`care.washAfterWears: 0`) silently became the role's default on POST, PATCH and clone.
**Decision:** `jsonApiValidator` (`src/web/api/validator.ts`, @fastify/ajv-compiler with the root's options) is set on `apiPlugin`'s scope only: bodies validate as sent, querystring and params still coerce (`?limit=20`). `Nullable` is a plain `[T, null]` union.
**Consequence:** a client sending `"3"` for a number gets a 400 `validation`; page routes are unchanged.

## 2026-11-13 — The worker never answers a navigation post; our pages announce a session boundary (#542)

**Why:** the worker relayed the four auth posts (#239's fix) with its own fetch, which carries this site's Origin and the Lax cookie whoever started the post, so a cross-site form passed the same-origin hook: login CSRF, cross-site sign-out. The worker cannot see `Origin` or `Sec-Fetch-*`; `referrer` can be stripped.
**Decision:** design (a) of PR #543's plan, owner-approved: a fetch listener above every route stops every non-GET navigation (`isNavigationPost`), so the browser posts natively and the server judges the real Origin. The four auth forms carry `data-ends-session`; `pwa.js` posts `SESSION_ENDING` as one leaves and the worker drops the session caches (`waitUntil`; copies wait for the drop). The outbox holds sign-out and deletion to drain and discard. Rejected: a referrer-gated relay (rests on each browser's `FetchEvent.request.referrer`) and a pre-session token (cookie tossing from homelab siblings; we cannot use `__Host-`, cached login pages would serve stale tokens).
**Consequence:** #239 cannot recur (no worker fetch of a navigation). In the installed app the #244 relay's landing is the browser's own load, as in a tab, which supersedes 2026-11-12's "the worker's followed fetch is the landing". A navigation POST share target (#541) must take the same shape. Verify sign-out on the owner's iPhone.

## 2026-11-13 — Piece positions come from a per-look counter; the share's fields precede its photo (#541)

**Why:** adds numbered pieces from the highest stored position, so removing the top piece and adding another reused its position and a stale match view's choice landed on the new piece. A share's hidden link and title also followed the file input in the form, and its worker kept links POST /inspiration refuses (a 400 on every retry).
**Decision:** `inspiration.next_piece_position` (0050, backfilled to max+1) only grows; `takePiecePositions` reserves from it under the look's lock (400 at the smallint's end). The hidden fields come before the file; the server reads fields in any order (`storeUploadParts` drains the stream). `isStorableLink` (`link-text.ts`, no imports) is the one rule for the server and the worker.
**Consequence:** a stale save for a removed position is a 409. A share's unstorable link is dropped, the photo kept.

## 2026-11-13 — One global owner-lock order; account deletion deletes under its locks (#544)

**Why:** account deletion folded its `file` delete into its lock statement, whose READ COMMITTED snapshot predates the lock wait: a save that held the lock and committed meanwhile (the account's own garment photo, a grantee's save into its wardrobe) was invisible to the delete, and the user's cascade dropped that row with its bytes left behind. A MANAGE grantee's save locked the wardrobe owner but not the uploader whose deletion deletes the pending row, so the two raced. The suggested "own row first, then the owner set" is not one order: holding 5 while waiting on 3 deadlocks a save holding 3 and waiting on 5.
**Decision:** every transaction locks every account whose rows it writes in one statement, ascending, before any other lock (`ownersLockCte` takes ids; `lockOwnersAndPhotoName(tx, [ownerId, userId], name)`, true only when all were locked). `deleteUserAndFileRows` locks its set alone, then deletes files and pending rows in one statement under the locks that re-reads the owner set; an unlocked owner deletes nothing and `deleteAccount` relocks (3 attempts). `lockCutoutRows` has its EXPLAIN pin.
**Consequence:** statement counts are unchanged (the deletion still sends three). A grantee save beside the uploader's deletion now takes turns with it, whichever goes first. No writer since #40 gives a garment another account's photo, so the retry guards legacy-shaped rows only; migrating those rows to their garment's owner would retire the cross-account set (not done: it changes what a deletion removes).
## 2026-11-13 — The API's photo and link import: multipart documented, not validated; the import saves at once (#192c)

**Why:** a `body` schema on a multipart route makes Fastify validate the unparsed body (null), and the parts must be read only after the garment is judged; the page's link import answers a form a person reviews, which a client has no use for; and @fastify/swagger marks every body required (#546).
**Decision:** photo routes declare `multipartBody` (spec only, `scripts/api-spec.ts`'s `transform`); a body schema admitting null is `required: false` (`markOptionalBodies`). `POST /garments/link-imports` saves at once through `saveGarmentFromLink` (`link-import/save.ts`, moved from MCP's tool, which wraps it) under the page's one `LINK_IMPORT_LIMIT` checker, now built in `webPlugin`. The add sheet's upload and the photo choice are `webOnly` (`FORM_STAGING`): create, then `PUT .../photo`. Photo writes answer `{ cutoutStatus }` (`swapPhoto` returns it); the mask save answers the photo's new URLs.
**Consequence:** #192 has no pending line left. The import pins 11 statements (no twin saves); the rest equal their page twins. The API's import answers no lookalikes (MCP's does, after reading the garment back). `FORM_STAGING` extends owner decision 9's web-only list: owner to confirm.

## 2026-11-13 — The sync columns and the strict sync triggers (#196a-2)

**Why:** plan 2026-11-12-json-api.md §7 needs a per-owner revision cursor, tombstones and offline creates' client ids before the area endpoints; #196a-1 made every synced writer owner-first, so the revision bump can live in triggers without new waits.
**Decision:** 0051 adds `user.revision`/`sync_floor`/`week_template_revision`, `revision` + `updated_at` (default now(): the migration's instant, no rewrite) + `(owner, revision)` per root, `client_id` (unique per owner, roots only: a child table such as trip_item gets one only together with a tombstone trigger, which nothing needs yet) and `sync_tombstone`; 0052 (hand-written) the triggers, which replace the test-only guard and raise on an unlocked write. The cache is `closet.revision_<id>` (the plan's `.<id>` is not a valid GUC name). A tombstoned client id is refused in the trigger (SQLSTATE `CL410`, a 410 `gone`), whose fresh snapshot sees a tombstone committed during the lock wait. Both migrations set `lock_timeout` 5 s. Inspiration stays unsynced.
**Consequence:** **merges only after #196a-1 is deployed**; a rollback two releases back onto this schema is unsupported. Only Wore today stores a client id so far (the outbox's); the API's garment create still only logs its own (#563). The outbox takes a 410 for saved. The export leaves `revision` and `client_id` out. Statement counts are unchanged.

## 2026-11-13 — The API's outfits and wears: wears keyed by day, rename without rows (#193a)

**Why:** the page's Wore today is one toggle (`worn=1|0`, the day optional), and the outfit form's save replaces every row, so a twin shaped like either would make a client resend an outfit's rows (which the read drops when empty) to rename it, and guess today.
**Decision:** a wear is `PUT`/`DELETE /garments/{id}/wears/{day}` (set-state, `{ day, worn, changed }`); washes `POST .../washes` and laundry `POST /garments/washes` take a required `day`; the window is the queued taps' (`dayOutsideWindow`: a 409 without `X-Closet-Outcome`, the outbox's header). Wear, wash and away go through `wears/wear-actions.ts`, which the page routes now call too. `updateOutfit` takes an `OutfitEdit` whose absent `slots` leave the rows and trips alone. `POST /outfits` answers a reused set 200 `alreadySaved`, a new one 201. Muse's three reactions are one `POST /outfits/{id}/reactions`.
**Consequence:** every route costs its page twin's statements, but a rename: two fewer (`api-statements.spec.ts`). The wear's undo has no matrix case (the shared fixture must stay unworn), so a named test covers it (coverage EXEMPT). Still `pending: '#193'`: Today's Wear this, Styling, ideas, inspiration, the calendar, the week plan, selfies.

## 2026-11-13 — The outbound fetcher dials the checked address itself (#496a)

**Why:** HTTP/2 (#496, plan `docs/plans/2026-11-13-http2-outbound.md`) needs one TLS socket whose ALPN result picks the protocol; `https.request` dials for itself and cannot hand an h2 session its socket. Its pinned `lookup` was also a second, indirect path to the address.
**Decision:** `dial()` (`src/web/security/outbound-dial.ts`) is the one way a connection opens: `net.connect`/`tls.connect` to the checked IP literal, `servername` the URL's name, `rejectUnauthorized: true`, an abort listener (tls.connect takes no signal) and an error listener from creation. `http.request` runs on it through `createConnection` with no agent, Host set from the URL. ALPN offers `http/1.1` alone: a server offered h2 could pick it before the h2 transport exists. Responses become a transport-neutral `Answer`, read by the one copy of the refusal rules. `tls.ca` is a specs-only option (`OutboundStandIn`); guards.conf confines tls, https, http2 and net's connect.
**Consequence:** the pinned lookup is gone; a TLS error is `network` with its code logged. 496b adds `h2` to ALPN and its transport beside `sendHttp1`, and moves http2's guard to that file.

## 2026-11-13 — The API's calendar and week plan: entries by id, a range not pages, batches deleted (#193b)

**Why:** the page's `POST /calendar` both plans and (with `replace`) changes an entry, its worn pill is a toggle, Wear this wears today only, and the plan's `/week-plans/{weekStart}` (plan section 6) names no batch while Undo works on one; a client offline for days must name the day it tapped.
**Decision:** `/calendar-entries` is a range read (`{ from, to, data }`, at most `MAX_CALENDAR_DAYS`, never paged) plus `POST` (201, or 200 with the existing entry's id: `scheduleOutfit` now reads it in its check), `PUT .../{id}/outfit` (the entry by id: `EntryTarget.day` optional), `PUT .../{id}/worn` (set-state) and `DELETE`. Wear this is `POST /outfit-wears` with a `day` in the window (`wearIdea` takes it). The week plan is `POST /week-plans` (200 always, `weekPlanId` only when a batch was made; `planMyWeekNow` is the page's, MCP's and the API's one caller of `planMyWeek`), Undo `DELETE /week-plans/{id}`, the template `GET`/`PUT /week-template` (`{ days }`, Sunday first). A page write of two shapes takes a list of twins (`Twin`, `operations.ts`).
**Consequence:** every route costs its page twin's statements (`api-statements.spec.ts`). Still `pending: '#193'`: Styling, ideas, inspiration, selfies (193c).

## 2026-11-13 — The API's trips: ticks per row, the trip form replaced whole, a position cursor (#194a)

**Why:** the page's packing and extras posts are checklists (every shown id, the checked ones), which a client offline would have to rebuild from a stale list; `updateTrip` saves every field the form posts; and the trips' order (upcoming first, by a phase that moves at midnight) is no keyset of their rows.
**Decision:** a tick is one row, set-state: `PUT /trips/{id}/packing/{garmentId}` and `PATCH /trips/{id}/items/{itemId}` with `{ packed }`, through `setPacked`/`setItemsPacked`. `setPacked` also answers `onList` in its one statement, so a garment the list no longer holds is a 404 (the client drops the tick). `PUT /trips/{id}` replaces the form's fields (no merge read, so it costs what the page does). `GET /trips` pages by `offsetCursor`. Adding an outfit or an extra answers `{ added }`, no row id: GET /trips/{id} has them. The destination moves to `pending: '#195'`, with the place search it needs. `refusedBody` moved to `src/web/api/refused-body.ts`.
**Consequence:** every trip route equals its page twin's statements. A client re-reads the trip after adding to it; stored `clientId`s (#196) can answer ids later.

## 2026-11-13 — The outbound fetcher speaks HTTP/2 on the dialed socket; a body counts only whole (#496b)

**Why:** #347's Shopify storefronts 429 HTTP/1.1 and serve h2 (the 2026-11-12 entry's "stay `blocked-by-site` until an HTTP/2 transport" consequence is superseded). Probed on Node 22: a client h2 stream whose session dies mid-body (a GOAWAY then the close, or the close alone) ends quietly, as if complete; nghttp2 holds DATA to a declared content-length except when a RST*STREAM(NO_ERROR) cuts it before END_STREAM.
**Decision:** ALPN offers `h2`, `http/1.1`; `dial()` builds the h2 session itself (`createConnection` to its own socket, the only `http2.connect`), anything else is HTTP/1.1 on that socket. Sessions: `HTTP2_LIMITS` (no push, 16 KB / 100 header pairs, 1 MB memory, few outstanding pings/settings), one per hop, destroyed, never closed or reused. A request that fails before its response destroys its session at once. `wholeBody`: whole is exactly a declared content-length, or with none a stream whose `rstCode` is unset or NO_ERROR (set on the wire's schedule; CANCEL when its session's death closed it); else `network`, codes `H2*\*`. The log names the protocol normalized. #568: net's `Socket`/`Stream`banned beside`connect`.
**Consequence:** a RST(NO_ERROR) before END_STREAM with no content-length still reads as the end: it too closes the stream NO_ERROR, and Node exposes no difference. A server that ends a response and hangs up at once is whole however slow the reader (the PR's first `session.destroyed` check, sampled at the reader's pace, refused it). Node discards a stream's unread bytes when its session dies, so a reader behind by more than its buffers (~100 KB raw, beyond the window) still loses that answer: open question, not fixed here. 496c checks real shops by hand.

## 2026-11-13 — The API's wishlist and capsules: the inbox whole, decisions as events, membership as a set change (#194b)

**Why:** the inbox sorts needs by what every option unlocks, which no page of it knows; the page's decisions are six posts with a `returnTo` and a toast; and the plan's `PUT`/`DELETE /capsules/{id}/members/{garmentId}` is one pair per call, where the one writer (`changeMembership`), the picker and `set_capsule_membership` take a set.
**Decision:** `GET /wishlist` answers the inbox's sections as one resource (no pagination). A pick's decisions are one `POST /garments/{id}/decisions` (`event`, as `/outfits/{id}/reactions`), a need's one `POST /wishlist/needs/{id}/decisions`; Returned and "Bought it" are their own sub-resources. Membership is `PATCH /capsules/{id}/members` and `PATCH /garments/{id}/capsules` with `{ add, remove }`, set-state. "Bought a different one" rides `POST /garments` (`boughtForNeedId`). Goes-with takes `?ownerId=` only to refuse a share (403).
**Consequence:** #194 has no `pending` line. Every route costs its page twin's statements but `GET /capsules/{id}` (−2: no garments, they are `GET /garments?capsuleId=`) and `PUT /capsules/{id}` (−1: the capsule is read only for a refused form). A client re-reads the inbox after a decision.

## 2026-11-13 — The API's ideas, pick, clashes and selfies: Shuffle is a read, a pick goes where it says (#193c)

**Why:** Styling's Save is four writes in one form (a pick, an entry's Change, Include picks' slot write, an edit), its Shuffle a GET of the rows, and the gallery's pick takes a `for=` of a day, a trip or an entry to replace; a twin shaped like either page would carry its form state into the contract.
**Decision:** `GET /ideas` is ideasFor's statement with `with` (any closet garments locked: "Style this" and Shuffle's locked rows, read in the same statement, `ideasWith`) and an opaque cursor carrying the seed and offset; Shuffle is that read with another `seed`. `POST /outfit-picks` (`pickGarments`, shared with `pickTo` and `pick_outfit`) saves, or plans with `plan`; a pick's other destinations are their resources' writes with the idea's `garmentIds`: an entry's Change `PUT /calendar-entries/{id}/outfit`, a trip `POST /trips/{id}/outfits` (#194a), both refusing neither-or-both alike (`outfitOrGarments`). Clashes are `PUT`/`DELETE /garments/{id}/clashes/{otherId}`; selfies `PUT /calendar-entries/{id}/selfie` (multipart) and `DELETE /selfies/{id}`; the feedback `POST /weather/feedback`, which exists only with WEATHER_ENABLED (`scripts/api-spec.ts` documents every feature on).
**Consequence:** `POST /styling` twins five operations, the gallery's pick three; Styling's Save of an edit is the outfit's PATCH. `GET /ideas?with=` costs one statement fewer than the page's `?with=`. No API route serves a selfie's bytes yet: a native client sees `selfieId`, not the photo (follow-up). `/calendar-entries?to=` alone is the week up to it (#570).

## 2026-11-13 — Specs hold under the shifted clock: a fixed TLS window, a refused upload stores nothing

**Why:** the publisher's check at 471f4b8 failed clock-db-30d/365d: `selfSignedCertificate` dated its window from `Date.now()`, which the shift moves while OpenSSL checks the real clock ("not yet valid"); and `inspiration.spec.ts`'s reconciliation found an orphan another test left: a 413'd upload's photo, stored after the response (the parser reports the `fileSize` cut once the stream ends, after a JPEG decoded), with a real-clock mtime the shifted cutoff called old.
**Decision:** the fixture's validity is a constant (2000-01-01 to RFC 5280's 99991231235959Z), never from `Date`; `Photos.storeUploadParts` awaits a started pipeline when the body is refused and deletes its bytes before rethrowing. Nothing went into `clock_shift.conf`: both causes could move.
**Consequence:** every multipart route (garment photos, looks, selfies) stops leaking refused uploads to reconciliation; a fixture a real-clock validator reads is never dated from the JS clock.

## 2026-11-13 — A trip outfit is worn today by its own copy, not its outfit (#573)

**Why:** `tripModel.wornToday` was keyed by outfit id, so an outfit on several trip days (or also on "Any day") showed every copy "Worn" once today's was worn, on the page and as the API's `wornTodayEntryId`. A calendar entry is per (owner, day, outfit) and carries no trip outfit, so the copy is derived.
**Decision:** `readTrip` keys the map by the trip outfit's id, and only for a copy `wearableToday` (today's or "Any day"); the page and `toTripOutfit` look up `outfit.id`.
**Consequence:** a copy of another day is never worn. An "Any day" copy of an outfit also on today still shares today's entry (one entry per outfit per day), so both show worn.

## 2026-11-13 — The API's saved looks: `/looks`, the photo's bytes behind the token, the share target web-only (#193d)

**Why:** a look's photo is private (`sendPrivatePhoto`), served by a page route that reads the session cookie, which no token request carries; the page's pieces are one autosave per piece while MCP sets the whole list; and the share target is the installed web app's worker answering Android's post.
**Decision:** the resource is `/looks` (Inspiration's looks), owner-only, every route its page twin's writer. The photo's bytes get their own operation, `GET /api/v1/look-photos/{fileName}?variant=` (`servePrivatePhoto`, a problem 404 for anyone else), and a look's `photo` names those URLs (`apiInspirationPhotoUrl`). Pieces are `POST`, `PUT`/`DELETE .../pieces/{position}` and `PUT .../pieces` (`setInspirationPieces`, set_inspiration_pieces' twin). A piece write on a removed position is the page's 404; a stale position in `POST .../outfits` is `saveRecreation`'s 409. The paste's budget is one checker for both doors (`inspirationLinkLimit`). The share target stays web-only. No empty look: the table's check wants a photo or a link.
**Consequence:** #193 has no `pending` line. Every look route costs its page twin's statements. `servePrivatePhoto` is where a selfie's bytes route would go too.

## 2026-11-13 — The API's photo bytes count on their own budget, `API_PHOTO_LIMIT`

**Why:** a client paints a page of 50 thumbnails with one `GET /api/v1/look-photos/*` each; on `API_LIMIT`'s 120 a minute per token that 429s its own JSON calls. An exemption would leave the bytes uncounted.
**Decision:** a route marked `config: { apiPhotoBytes: true }` counts on `API_PHOTO_LIMIT` (600 a minute per token: a 50-item page twice a minute with headroom, and immutable bytes mean a caching client stays far below), picked by the API plugin's preHandler, never a path regex. Neither budget counts a 401. The refused photo's 404 is `no-store`, as the page's.
**Consequence:** `servePrivatePhoto` plus this flag is the one way an API route serves private image bytes; #579 (selfies) reuses both.

## 2026-11-13 — The API's selfie bytes are addressed by file name, not selfie id (#579)

**Why:** replacing a selfie keeps its id but stores another photo, so an id-addressed URL served as immutable would hand a caching client the old bytes.
**Decision:** `GET /api/v1/selfie-photos/{fileName}?variant=thumb&v=` (`servePrivatePhoto`, `apiPhotoBytes`), owner-only; a stranger, a grantee and a replaced or removed selfie get the same problem 404. A calendar entry carries `selfiePhoto { version, originalUrl, thumbUrl }` beside `selfieId`, so a client never builds the URL. The look and selfie byte routes share their schemas in `src/web/api/private-photo-bytes.ts`.
**Consequence:** a new private image over the API is addressed by its stored file name, read from the resource, never by its row id.

## 2026-11-13 — The API's Today and weather: one day shape for MCP and the API, the weather budgets shared with the page (#195a)

**Why:** a native client needs Today, the forecast, the settings, the place search and a trip's destination; MCP's tools already map a forecast day and a typical day (`dayWeather`), and the page's `WEATHER_SEARCH_LIMIT`/`WEATHER_LOCATION_LIMIT` were route configs, which count per route: an API route with the same config would be a second budget for the same Open-Meteo calls (`weather.spec.ts`: "Home counts on its own" stays true of the page).
**Decision:** `GET /today` (`todayFor` with the page's `needs`; its ideas row carries GET /ideas' cursor, Refresh's twin), `GET /weather?from=&to=&occasion=` (the calendar's week defaults, at most `MAX_SUMMARY_DAYS`), `GET /weather/places` (a failed search is a 503 `busy`, not the page's 200 message), `PUT`/`DELETE /weather/home` and `/here`, `PUT /weather/unit`, `DELETE /weather/offset`, `GET /trips/{id}/weather`, `PUT /trips/{id}/destination`; the weather's exist only with WEATHER_ENABLED. The day mappers moved to `src/web/weather/weather-resource.ts`, read by both. The weather's budgets are ONE checker per page route and its API twin (`weatherLimits`: search, home, here, destination; `createWeatherLimits`, built in `webPlugin`, as `inspirationLinkLimit`), keyed by the device token's user or the session's. Each page route keeps its own budget, so a page-only user's bounds and the audit's pacing are unchanged; a trip page's search stays its own route config.
**Consequence:** #195's pending lines are only insights, sizes, the style profile and sharing (#588, #589). Each twin costs its page's statements. A user's two doors together get the page's bound, not double (`api-weather.spec.ts` spends one budget on the page and finds it spent on the API, and the reverse). The checkers log through the Web logger (`enforceLimit`), not RateLimit.

## 2026-11-13 — The API's querystring is closed (#577)

**Why:** a misspelled filter (`?categroy=`) was ignored and answered the unfiltered list; Fastify's ajv also runs `removeAdditional: true`, so `additionalProperties: false` alone would have stripped the key, not refused it.
**Decision:** one place, `validator.ts`: `jsonApiValidator` closes every `/api/v1` querystring schema and compiles it with `removeAdditional: false`; `declareQuerystring` (an apiPlugin onRoute hook) gives a route with none an empty one. A stray parameter is a 400 `validation` with `errors[].path` `querystring/<name>` (`validationFailures` reads ajv's `additionalProperty`). Pages stay lenient. No route needed a new declaration.
**Consequence:** a route added later is strict without work; a parameter it accepts (`ownerId`, `v`) must be declared in its schema.

## 2026-11-13 — The API's style profile, outfit rules and shared wardrobes; sharing admin stays web-only (#195c)

**Why:** the style page's three writes needed twins, and a native client needs the wardrobes shared with it to address `?ownerId=`. An invite link is a bearer capability to a wardrobe (handing one out is handing out a credential; accepting spends it), and the outbound and pending lists carry invite tokens and grantees' emails.
**Decision:** `GET`/`PUT /style-profile` (set-state, a closed body), `POST /outfit-rules` (structured sides, never the page's `garment:<id>` spelling), `DELETE /outfit-rules/{id}`, each its page twin's writer; `GET /shared-wardrobes` maps `grantorFirstName` only, never `grantorName` (it falls back to the email). Invite, accept, decline and remove stay `SHARING_ADMIN`; change permission has no page action to twin.
**Consequence:** a rule the owner holds already (a never-rule's mirror included) is 200 `added: false` on the API where the page answers 400 "You have this rule already": a retry or a second device is not a mistake to show, as the trip items' idempotency (decided here, deliberately divergent). No API answer carries an email.

## 2026-11-13 — An API body schema that closes itself refuses extras (#195c)

**Why:** a PUT that replaces the style profile whole must not silently drop a misspelled key, and ajv's `removeAdditional` strips keys inside an `anyOf` while trying branches, so a rule side `{ color, pattern }` could match after mutation.
**Decision:** `jsonApiValidator` compiles bodies with `removeAdditional: false` too. A schema with `additionalProperties: false` (the style profile's, a rule and its sides) is a 400 naming `body/<key>`; open schemas, every other route's, are unaffected.
**Consequence:** closing an existing route's body is a contract change for its clients: do it with its own decision, not in passing.

## 2026-11-13 — The API's insights, recap and sizes: data where the pages fall back, centimetres on the wire (#588)

**Why:** a native client needs insights, the year in review and Profile › Sizes; the pages treat `?unworn=`/`?year=` as navigation state (anything falls back) and the measurements form posts strings in the unit shown, keeping a stored length posted as shown (`readMeasurementsForm`).
**Decision:** `GET /insights?unwornDays=` and `GET /insights/recap?year=` (`readInsights`; `readRecap`, now the page's too), owner-only like the pages, so no `ownerId`; an unknown window, or a year after this one, is a 400. `GET /sizes`, `PUT /sizes/measurements` (every length in cm, replaced whole, rounded to the column's two decimals), `PUT /sizes/unit`, `GET /sizes/brands[?brand=]` (the hint), `POST`/`PUT`/`DELETE /sizes/brands[/{id}]` (`readBrandSizeForm`; a brand noted already is a 400 under `body/brand`, as the form). The recap's "Save image" is drawn on the device: web-only, in the plan's list.
**Consequence:** every twin costs its page's statements but `PUT /sizes/measurements`, one fewer (no stored lengths to keep). Measurements never reach a share on any surface. #195 has no pending line left.

## 2026-11-13 — No 409 for an API garment clientId on "different content" (#563)

**Why:** a garment has no natural key, so a repeated `clientId` is always a retry of its create, and a retry after the client's own edit legitimately differs.
**Decision:** `POST /garments` answers the first row, 200, for any repeat of the id (a deleted one's is 410); content is never compared. A need the create settled is resolved only after the insert proves it new (`createGarmentOnce`), so its retry is not refused with the need's 404.
**Consequence:** the id alone identifies the create; a client reusing one for another garment gets the first garment back.

## 2026-11-13 — 0051 gets its lock_timeout in place, under the migration-contract label (#601)

**Why:** 0051's ~30 `ALTER TABLE`s on root tables ran before 0052's `SET LOCAL lock_timeout`, so behind a long reader (a backup's `pg_dump`) the boot could wait without limit instead of failing and retrying. A new migration cannot help: the timeout must be in force while 0051 runs.
**Decision:** edit 0051 (a leading `SET LOCAL lock_timeout = '5s'`) before production ever ran it (last ship 96b3ebc predates #566), under the `migration-contract` label. No schema changes; a database that already applied 0051 (dev, worktrees) is unaffected since Drizzle never re-checks hashes.
**Consequence:** once a migration has shipped to production this hatch is closed; fix forward then.
## 2026-11-13 — A migration that locks a table must start with lock_timeout (#603)

**Decision:** `src/db/migration-lock-timeout.spec.ts` (unit tier, reads `drizzle/*.sql`) fails any file from 0051 on with `ALTER TABLE`, trigger, `DROP`, `TRUNCATE` or non-concurrent `CREATE INDEX` whose first statement is not `SET LOCAL lock_timeout`; 0000-0050 are exempt by number.
**Consequence:** 0051 shipped without one and only review caught it (#601); a new migration now fails fast, naming file and fix.

## 2026-11-13 — The lock_timeout rule is unconditional (#610)

**Decision:** every migration from 0051 on starts with a positive `SET LOCAL lock_timeout`, not only those with a locking statement (#603's list). A statement list cannot be complete: `ALTER INDEX`, `REINDEX`, `LOCK TABLE`, policies and FK references in `CREATE TABLE` all lock, and a miss is silent.

## 2026-11-13 — createGarmentOnce's settle runs on its transaction (#615)
Why: `settle` resolved the Muse need through `postedDestination(db, ...)` on the pool while the insert's transaction held a connection and the owner lock: two connections for one create, and a pool at its limit could deadlock the request on itself.
Decision: `settle(tx)` receives the transaction; `postedDestination`, `resolveNeed`, `resolveOrderItem` and `findPendingOrderItem` take `Queryable`. No other `db.transaction` callback in `src/` reaches the pool (audited).
Consequence: no per-app pool size exists in the harness (`POOL_MAX` is a constant), so the proof is the type (a pool-typed closure no longer compiles) plus the retry and need specs in api-wishlist.

## 2026-11-13 — The feed's garment carries its stored fields only (#607)

**Why:** the page's garment embeds `worn`, `wornSinceWash`, `lastWorn`, `cost`, `costPerWear` and `capsules`, read from wears and capsules. A wear or a capsule rename moves only its own row's revision, so a synced garment would hold them stale; touching the garment from every wear needs a migration and resends a garment per wear.
**Decision:** `GET /changes` carries `SyncedGarment` (`garment-resource.ts`): the stored fields, the owner's stored care (`washAfterWears`, `lastWashedOn`, `away`, `awayNote`) and repair log (a child that touches the garment), nothing derived. The wears and capsules (with `garmentIds`) are resources of their own; the client derives the rest.
**Consequence:** the feed's garment differs from `GET /garments/{id}`'s; the derived rules (`src/wardrobe/insights.ts`, the wash rules) are the client's to mirror.

## 2026-11-13 — The changes cursor: a keyset position per wardrobe (#607)

**Why:** one transaction is one revision (a bulk edit, the #196a backfill's every row at 0), so `{ ownerId: revision }` cannot end a page inside a revision; an inclusive end resends a revision-0 wardrobe forever; a full sync paging below a raised floor would 410 forever.
**Decision:** opaque base64url JSON `{ v: 1, c, w: { <owner>: [revision, kind, table, id, seq, passFloor] } }` (`src/web/sync/cursor.ts`): the total order `(revision, kind, resource COLLATE "C", id, tombstone id)`, an exclusive end (kind 2) at the snapshot's `user.revision`, the floor the pass began at (expired only if the floor rose past both), and `c`, the registered resources' bitmask: a cursor from before a resource joined the feed is a 410 rather than missing that resource's older rows.
**Consequence:** #608 registering a resource expires every cursor once (one full sync per device); a malformed cursor is a 400 like `readIdCursor`'s.
A full sync is marked: every page of one begun without a cursor carries `snapshot: { wardrobes }` (the cursor's `s: 1` holds it to the last page), and after it the client drops what was not re-sent, since a cursorless read can send neither pruned deletions nor revoked shares.

## 2026-11-13 — Sync tombstones are pruned nightly; the cursor names its user (#609, #617)
Why: tombstones grow forever; a cursor replayed by another account (a device switching users) had its positions trusted, reading the caller's wardrobe as a delta without `snapshot`.
Decision: `pruneSyncTombstones` (`src/maintenance/sync-prune.ts`, nightly `sync_prune`) deletes client-id-less tombstones past 90 days by Postgres `now()` and raises `sync_floor` in one statement per 1000, owners locked in id order (`ownersLockSql`): a page's snapshot sees both or neither. The cursor carries `u`, the user it was answered to; any other presenter, or a cursor without `u`, is a 410 `cursor_expired`, not a 400.
Consequence: a device offline over 90 days, or one that switched accounts, syncs in full once; every cursor answered before this deploy expires once. `u` is optional in `v: 1`, so no version bump.

## 2026-11-13 — Shared integration workers keep built-in prototypes clean (#620)
Why: `GET /api/v1/changes` 500'd in full-suite runs (`Cannot read properties of undefined (reading 'replace')`, ajv `safeStringify` under `required`). drizzle-kit/api assigns `Array.prototype.random` and six `String.prototype` helpers, enumerable, at import (`schema-drift.ts`, loaded by the two migration specs); fast-json-stringify's `cloneOriginSchema` copies inherited keys with `for...in`, rfdc then turned the extra key into a hole in each `required` array, and ajv's codegen threw on it. Only a worker that ran a migration spec before a feed request hit it.
Decision: `schema-drift.ts` makes them non-enumerable right after the import (`hidePrototypeExtensions`, `test/support/prototype-hygiene.ts`; drizzle-kit still calls them); `shared-worker-setup.ts` fails any integration file that leaves an enumerable key on Object, Array or String's prototype, naming it. No drizzle-kit patch: it would drop on every bump.
Consequence: production is unaffected (drizzle-kit is a devDependency, omitted from the image, and `src/` never imports it). A new polluting import fails the file that loads it, not a random later spec.

## 2026-11-13 — 0.1 is driven by the pre-0.1 audit's epic (#631)
Why: before a first release tag the owner wanted every core job working and everything beautiful, checked by evidence rather than feature lists: seven reviewers (journeys driven in the real app at 390 px, security, performance, quality, errors, portability, UI/UX) plus six gap reviews, P0–P2 findings adversarially verified (`docs/reports/2026-11-13-pre-0.1-audit.md`).
Decision: the 141 surviving findings became 103 issues under the pinned epic #631 and milestone `0.1`, one issue per fix (shared root causes merged, polish batched per area), ordered P1s, journey blockers, UX, ops, security, perf, structure, polish; 9 product/legal/policy questions are `agent-blocked` until the owner answers (#637 #638 #639 #655 #670 #680 #681 #695 #725).
Consequence: the work loop's lane order is #631's checklist; the 0.1 tag waits on the release-identity decision (#637), since 2026-10-13 retired semver tags.

## 2026-11-13 — Stdout is the only default log sink; LOG_FILE is opt-in and async (#632)
Why: every log line was a synchronous write to `DATA_PATH/app.log`, and production's DATA_PATH is an NFS mount over Wi-Fi: a link stall blocked the event loop (`/health/live`, the timers, DB-only pages), a full share raised an `error` nothing listened to, and the file sat where `/file/**` serves from, unrotated, in every photo backup. Loki already reads stdout.
Decision: `createLogger` writes stdout only. `LOG_FILE` (unset by default) adds JSON lines to a file through an async pino destination whose `error` is reported to stdout once, after which the file is dropped and stdout continues. A `LOG_FILE` under `DATA_PATH` (both resolved) is a `ConfigError` naming the key. The harness's `appLog` option is gone; specs read `t.logs`.
Consequence: lines still buffered at a crash are lost from the opt-in file (stdout stays synchronous). The file is never rotated (out of scope). `PhotoStorage.list` and the `/file` guards no longer name `app.log`; the name stays only as a refused-name fixture in specs.

## 2026-11-13 — The README quick start is executed by the image smoke, and PWA_ENABLED needs an https SITE_URL at config time

**Why:** README's compose shipped `PWA_ENABLED: 'true'` without `SITE_URL`, so the default `http://localhost:3000` became the VAPID subject and the boot died in web-push with a message that never named `SITE_URL`; nothing ran the example, so it rotted (#633).
**Decision:** `loadConfig`'s cross-checks refuse `PWA_ENABLED` with a non-https `SITE_URL`, naming the key and never the value (the subject is always `SITE_URL`, so https is the only form it can take; mailto is not reachable). The quick start defaults the PWA off with a commented HTTPS block, mounts `closet_models`, and uses `postgres:18-alpine`. `scripts/smoke-image.sh` extracts the yaml fence after `<!-- smoke:quickstart -->`, substitutes only image, the two placeholders and the host port, boots it with docker compose, and recreates the container to prove the models volume survives.
**Consequence:** edit the README block and the smoke follows; keep the marker and the `<secret>`/`<password>` placeholders, or the smoke fails. The sender still checks the VAPID keypair's shape.

## 2026-11-13 — Touch sizing lives at the theme token (#636)
Why: every field was under 16 px (iOS zoomed the installed app into it and left it side-scrollable; the `@supports (-webkit-overflow-scrolling: touch)` guard died with iOS 13) and controls were daisyUI's desktop scale (btn-sm 32 px, btn-xs 24), patched per call site with 13 `min-h-11 fine:min-h-8`.
Decision: one `@media (pointer: coarse)` block in `views/assets/main.css`: `--size-field` 0.275rem (default btn/input/select/tab 44 px), text fields `max(16px, 1em)`, small fields at default height, menu rows 44 px; btn-sm/-xs, tabs, checkboxes, radios, toggles, `.link` and control badges keep their look and gain a transparent 44 px pseudo-element (components layer, so a site's utilities win). The calendar row's × moved into its Change menu. `test/support/touch-targets.ts` holds both rules in the trips scenario (390 px, `hasTouch`).
Consequence: no call site sizes for touch; a text link that truncates puts `truncate` on an inner span (its own overflow clips the hit area); a stretched link on a btn-sm adds `static`. A fine pointer keeps daisyUI's scale.

## 2026-11-13 — One channel for failed htmx requests (#642)

Why: htmx swaps no 4xx/5xx, so a refused tap (a deleted garment's 404, the owner lock's 503, a 429) showed nothing; routes answered 200-with-error one by one.
Decision: the root error handler decides by request kind: a fragment request gets its status, no body and `HX-Trigger` `closet:request-failed` `{ message, requestId }` (i18n, never the error's text; the 500 a fixed line); a navigation or boosted tap the error page. `public/js/request-failures.js` swaps a boosted error page that is ours (`X-Request-ID`), toasts the trigger, a foreign error answer and `htmx:timeout` (`HTMX_CONFIG.timeout` = `REPLAY_TIMEOUT_MS`); a queueable form's timeout is queued by the outbox instead. Not `responseHandling`: its rules see only the status, not `boosted`, and swapping every 4xx would empty a fragment target with the bodiless answer.
Consequence: a route throws to refuse an htmx request; the link photo choice's 200-with-error is gone, the registration's inline validation stays 200 (a message is its answer, not a failure). The 404 handler's message no longer echoes the URL.

## 2026-11-13 — An outfit's origin, and one list rule for Saved and the pickers (#659)

**Why:** every list was "all the owner's outfits", so after a few weeks of Plan my week and Wear this, curated outfits sat under dozens of machine-named one-offs in Saved, the calendar's plan page and a trip's add page; the calendar's x also left the planner's outfit behind.
**Decision:** `outfit.origin` (`person`, `agent`, `idea`, `planner`; `src/wardrobe/outfit-origin.ts`), required by `createOutfit`/`pickIdea`. A reuse only raises it (`adoptOutfit`), any edit makes it `person`. `keptOutfit()` (`person`, `agent`) is the one predicate, read only through `savedOutfitsSql(owner, list)` and the API's `show`; the rest sit behind "Worn and planned" (`?show=one-offs`, lenient). `deleteEntry` applies Undo's rule. Migration 0053 moves only provable rows (proposals to `agent`; unadopted, untouched planner outfits to `planner`) under the owners' locks; everything else stays `person`.
**Consequence:** older one-offs (Wear this, planner outfits whose entries were already removed) stay on Saved; a no-op save of a planner outfit before 0053 backfills `planner`. A synced copy without `origin` is `person`. Not pruned: an idea one-off whose entry is removed, a planner outfit whose entry the person took over; both stay under "Worn and planned".

## 2026-11-13 — The error page names what the person can do, by status class (#644)

**Why:** upstream's debug view (Path, Time, a lone Return to Home in `p-20`) made a deleted garment look like a crash with no way back.
**Decision:** `ErrorPage` (`src/web/error-page.tsx`) classes the status (missing, refused, retry, rejected, failed): a human h1, Back plus the section's home link, Try again only for the retry class on a plain GET with nothing secret in its URL, the request id on a 5xx only. Strings are `errorPage.*`; the refusal sentences stay `refusal.*`.
**Consequence:** a new status that needs its own shape is a new `ErrorClass`; the h1 is no longer "Error NNN", so specs find the page by its title.

## 2026-11-13 — Limb targets stop at 3 above a cold snap; a layer is judged on its own too (#645)
Why: legs and feet asked 4-5 below about 8 °C, which only heavy denim and boots reach, so on an ordinary New York January day one pair of jeans and one of boots filled every idea and no office outfit fit; the torso was a plain sum, so a parka over a linen shirt "fit" at 44-61 °F; one limb tolerance let suede boots through at 32 °C.
Decision (`src/weather/match.ts`, pinned by `src/weather/real-days.spec.ts`: four real 2025 Central Park days, ERA5, against the demo closet): `limbTarget` is capped at 3 above `COLD_SNAP` (-10 °C feels-like, 8 of January 2025's 31 days) and at 4 below it, never 5, so ordinary trousers and closed shoes pass an ordinary winter. The cap judges only too-cold: too-warm is judged against the uncapped target (`limbsCeiling`, up to 5), so warmth-5 boots still fit a winter day (review of #743). Legs keep +2 above the target, feet get +1. A layer may be at most one step warmer than the coolest hours' torso target less a tee (too-warm), and at most `LAYER_SPREAD` (3) warmer than the tops under it (too-cold). Every part stays non-negative and additive (scoreFloor). GENERATOR_VERSION 2.
Consequence: thresholds came from the real days, not from tuning; a new real-world complaint gets a row in real-days.spec.ts first. Which fitting layer is chosen (#646), workout (#647) and rain (#648) are untouched.

## 2026-11-13 — The re-plan judges the limb ceiling on fresh needs, not a stored column

**Why:** #743 capped `limbs` and added `limbsCeiling` (the too-warm bound); `week_plan_entry` stores only the capped target, so equal stored targets hid warmth-5 boots turning feet-too-warm (#746).
**Decision:** `replanWeek` re-runs `assessOutfit` with the fresh needs for an entry whose targets held, and treats a legs/feet too-warm problem as a change (kept, or swapped for a better idea, saying "warmer"). No schema change.
**Consequence:** a near miss planned with that problem is re-judged each morning (pure, no extra statement); it is swapped only for a strictly better idea.

## 2026-11-13 — The layer is drawn by rotation per base, not by one global preference (#646)

**Why:** `bestIdea` tried layers most rested first, the same order for every base, and took the first that scored 0: one layer (the parka unworn since winter, or the denim jacket on a never-worn closet) on 12 of 12 ideas.
**Decision:** layers are tried in `rotationOrder` (`src/wardrobe/generator.ts`): a lazy weighted draw without replacement by `rotationWeight`, keyed by the seed and the base's places (`placeKeyer`: each garment's position in its role, never its id, so `seed --reset`'s new ids draw the same; `seed.spec.ts` caught it), which the repairer's mends now share. Among the layers tied best each wins as often as its weight says; a base is still one idea. The issue's "closeness to the layer's target" tier was dropped: a hard closeness filter left one layer per warmth class (Down Sweater on 10 of 12 April ideas on the demo closet), the monoculture again. GENERATOR_VERSION 3.
**Consequence:** a base that fits bare never draws a sequence; one that needs a layer judges, on average, more layers before the first fit (no fixed order happens to put a broadly fitting one first), so a closet with many layers costs more per draw.

## 2026-11-13 — The planned limb ceiling is stored; the re-plan flags only a newly too-warm outfit

**Why:** #749 re-judged every entry's legs and feet on today's needs, so a near miss planned already too warm was re-judged each morning and could be swapped with a false "turned warmer" push (#750, #751). The planning-time ceiling cannot be derived from `limbs`: a stored 3 means a ceiling of 3, 4 or 5.
**Decision:** `week_plan_entry.limbs_ceiling` (nullable smallint, migration 0054) keeps it; `replanWeek` counts legs/feet too-warm only when the ceiling now is below the stored one (and the outfit is too warm now), so the cause is always a fallen ceiling ("warmer"). Null (older rows) is never judged on limbs; a kept or swapped entry records the new ceiling. Supersedes the interim rule above (no stored column).
**Consequence:** a new stored target goes in `PlannedNeeds`, the table and `needsColumns` together.

## 2026-11-13 — Everyday types are never drawn; "no type applies" is the type `other` (#685)

**Why:** the demo's socks could not be typed (no honest choice among the accessories), so "1 garment needs details" never cleared; a real closet's socks, underwear, swimwear and sleepwear were stuck the same way.
**Decision:** `socks`, `underwear` (accessories), `swimwear`, `sleepwear` (tops, bottoms, dresses) carry `drawn: false` (`GarmentType`, `isDrawnType`): the generator's `drawableByRole` skips them, so no idea, plan or Shuffle draws one; a locked one still rides along. `sports-top` and `running-shorts` are ordinary drawn types until #647's purpose. "No type applies" is a stored type, `OTHER_TYPE` ("Other", no presets), offered only by the categories whose list cannot be complete (accessories, bags, footwear, outerwear, dresses): no column, and tagging's `needsTags` needed no change. Tops and bottoms always have a closest type (it brings the sleeve and length the weather reads). Migration 0055 widens the four type checks.
**Consequence:** a new undrawn type sets `drawn: false`; a look's piece never takes `other` (`typesOfRole`), and the art draws `other` from the name or category.

## 2026-11-13 — Rain is the umbrella's in the heat or with a rain accessory (#648)

**Why:** rain demanded a water-resistant layer, footwear or accessory, but accessories are never drawn and the demo's only water-resistant shoes are boots, so at 30 °C every rainy idea wore the one rain shell over the one top light enough for it; on 2025-07-14 (Central Park, ERA5) no idea fit at all.
**Decision:** `WeatherNeeds.umbrella` (`src/weather/match.ts`): rain is met outside the outfit when every rain hour's feels-like is above `SHELL_CEILING` (22 °C; the coolest rain hour decides, so a cool morning shower on a warm day still wants a shell), or (`withRainGear`) the owner has a water-resistant hat or cap (`MatchGarment.rainGear`; a watch or belt does not count). `ideasFrom` applies it over its pool and `GET /api/v1/weather` and `get_weather` over `closetRainGear` (the same rule, one query), so `takeUmbrella` agrees across them; `GET /today` and the trip and calendar days judge by the heat alone. Then `assessOutfit` scores nothing for it and the idea lists say "Take the umbrella" once (`adviceChips`); otherwise `needs-water-resistance` stays a scored problem. `rain` keeps meaning rain in the window (the planner's stored targets read it). The API and MCP add `takeUmbrella`; `needsWaterResistance` is now the scored requirement only; the weather resource's `outfit` also carries `rain` (rain likely, however answered). GENERATOR_VERSION 4.
**Consequence:** the week planner gets the heat rule but not the accessory one (its pool is `weekPoolSql`, read in `week-planner.ts`); no water-resistant accessory is drawn into an idea (accessories stay undrawn).

## 2026-11-13 — A workout is dressed in activewear, a purpose of the garment type (#647)

**Why:** a workout was only `formality 1..1`, so "Plan my week" took near misses like a parka, sweatpants and Iron Rangers for a run (0 of 48 ideas fit at 0 °C).
**Decision:** `GarmentType.purpose: 'active'` (running shoes, running shorts, leggings, joggers, sports tops; sweatpants stay lounge wear) is code, not a column: no migration. `OCCASION_HINTS.workout.active` (`ActiveDemand`) makes bottoms and footwear hard rules (the generator's pool and templates, so a closet without them gets no idea and the planner's slot stays empty, never a near miss). The top stays free. Legs and feet lose the cold floor above `COLD_SNAP` (`assessOutfit`; below it the generator keeps bottoms more than two steps under the ask (`legsTooColdForRun`: running shorts) out of a run's draws, so no planner takes them as a near miss, and too warm and #757's ceiling always count), the layer the formality range. Swimwear needed nothing: #685's `drawn: false` already keeps it out of every idea. Callers spread `occasionDemands(occasion)`. GENERATOR_VERSION 5.
**Consequence:** an empty workout says why on every surface, as `activewearGap` (`no-activewear`: the closet has none, set garment types; `none-available`: none clean and at home): the Ideas empty state, `emptyReason` on `GET /api/v1/ideas` and `suggest_outfits`, and the plan banner (which only knows the closet's kinds, `closetKindsSql`, so it says "none available" whenever kinds exist). A new activity occasion sets `active`; a new athletic type sets `purpose`.

## 2026-11-13 — Sign-in returns to its page, through one signInReturnTo (#661)

**Why:** login and registration always landed on Profile, so an invite opened signed out was lost at sign-in and a session that expired mid-task came back to settings.
**Decision:** the page travels as `?returnTo=` then a hidden form field; the gate sets it on every bounce (a GET navigation its own URL, anything else `HX-Current-URL` or the Referer, same-origin only, so a POST-only action is never a target). `signInReturnTo` (`src/web/auth/return-to.ts`) is the one reading: `safeReturnTo`, page targets only by denylist (Fastify cannot match a concrete path against its route table publicly), 2 KB, no repeats, no credential shape; else Today. The invite token rides along rather than in a server-side pending-invite store: the sign-in GETs are `secretPath` and `no-store`, and the worker now refuses to store any `no-store` page (`forbidsStorage`) while still claiming the cache from it.
**Consequence:** a new surface that is not a page (like `/api`, `/mcp`) joins the denylist in `return-to.ts`; sign-in lands on Today, a tab root, which is safe only because the sign-in post drops the session caches first (`session-caches.md`).

## 2026-11-14 — One owner of the closet's rain gear, read only when a day asks (#759)

**Why:** after #648 only the ideas (over their pool, which `?capsule=` narrows) and the weather resource applied `withRainGear`; Today's weather, trip and calendar days judged by the heat alone, so one response could say `needsWaterResistance` and `takeUmbrella` together.
**Decision:** `rainGearFor(db, ownerId, needs)` (`src/web/weather/queries.ts`) is the only reader of the owner's closet-wide gear and reads it only when one of `needs` asks for water resistance (a dry week costs no statement); every surface applies it with `withRainGear`: `ideasFrom`, `needsWithGear` (weather resource, `GET /today`, `get_today`, `get_calendar`, `get_weather`), `tripForecast` (so the trip page, `get_trip` and the API agree) the week planner and its re-plan (`weekRainGear`, `src/web/week-plan/plan.ts`, reads the gear once per run and passes it in as `WeekContext.rainGear`; the pure planner never scans its pool). A trip day's gear is the water-resistant hat or cap on the trip's packing list (`rainGearFor`'s `tripId`, packed or not, whatever its wash or away state, but still in the closet; the trip's ideas pass it too), never the closet at home. Supersedes #648's "Today, trip and calendar judge by heat alone" and "planner gets the heat rule only".
**Consequence:** a rainy day adds one statement on ideas, `GET /today`, `get_today`, `get_calendar`, trips' forecast and the weather reads; a new surface that carries a day's needs calls `rainGearFor` first. A plan or re-plan run whose planned days ask for water resistance reads the gear in one more statement; dry weeks add none. A trip with no gear on its list says a rainy day needs water resistance even when the closet at home has a rain hat.

## 2026-11-13 — A deploy refreshes older-build pages instead of deleting them; each build keeps its own static files (#656)

Why: `servedCopies` deleted every copy stamped before activation (#2/#287: an older build's importmap must not meet this build's precached scripts), so after each merge-to-main deploy the phone showed the offline page where yesterday's wardrobe was.
Decision: older-build copies are kept and served by NetworkFirst's offline fallback with their age (never stale-first); each `WARM_PAGES` first refetches every cached key stamped before `activated-at`, one at a time in cache order, resuming where it stopped (`refreshOlderBuildPages`, `refetchVerdict`). The importmap reason is answered, not waived: each static build keeps its own precache (next entry); an older copy whose build (its `X-Asset-Version`) has no installed precache is deleted on read, as before. A page failing (500) is passed over; only 429/502/503/504 or a thrown fetch stop a refresh, and the warm runs after a walk that asked every key. The update toast's Reload is disabled while the heartbeat says offline. Not deferring activation: a staging cache would be a second session cache, days stale by the tap.
Consequence: a 401 during the refresh still drops the session caches (how a revocation reaches a lost phone; an expired cookie plus a deploy loses the offline copies). The first deploy carrying this still deletes older copies (they name no build). A sync's refetch now stops on 429/502/503/504. In full: `src/web/shell/updates.md`.

## 2026-11-13 — `?v=` is the static set's content id; one Workbox precache per build (#656)

Why: a hand-built per-build store (`assets-v2`, a shared builds record, eviction by last stored) had cross-build bugs in held state in two review rounds (evicting the active build on two deploys before Reload, another build's bytes under a `?v=`, a cross-worker read-modify-write losing the complete flag): the design was wrong, not the patches. Naming precaches by the release could not work either: `APP_VERSION` is set after the image's `npm run build`, and a server-only deploy changes the release but not `sw.js`, so no worker would hold the new `?v=`.
Decision: `?v=` (`BuildInfo.assetVersion`) is, in production, `staticBuildId` of the precache manifest (`src/static-build.ts`), which `scripts/generate-sw.ts` writes into `public/build.json` with the `sw.js` it injects, so the two never disagree; dev and the integration tier keep the release fallback (a lingering build.json). The worker names its precache `closet-precache-<id>`; the manifest is the whole `?v=` set (`/modules/`, `js/errors.js` added; the build fails without them); Workbox's atomic install plus a key check is the completeness guarantee (`installed-at`). A `?v=X` URL is answered from X's precache only, else the network, never stored. Activate keeps its own and the latest other to have activated, drops the rest. `workbox-cli` and `workbox-config.js` are gone (`workbox-build` from the script).
Consequence: a server-only deploy keeps every `?v=` and the precache. The release stays the build's name (health, /about, MCP, Sentry). The precache grows to about 630 KB (the install dialog's bundle among it). The first deploy carrying this finds the old build's pages naming no precache: they are deleted on read once.

## 2026-11-14 — One first-run gate: the closet can be dressed (#666)

**Why:** every page rendered its own empty state with its normal primary action, so a new account's Today, Calendar and Styling led with "Plan my week" and "Include picks" over an empty closet.
**Decision:** `canProduceOutfit(roles)` (`src/wardrobe/properties.ts`: a top and a bottom, or a dress, the generator's base templates) is the one gate. Today, the calendar week and Styling's strips each fold `closetKindsSql` into the statement they already send (`closetCanDress`); no page counts garments itself, and Styling judges the closet, not the capsule shown. Today's first-run path opens Wardrobe's own `AddSheet` in place rather than linking to `/wardrobe?add=`, so the Wardrobe tab root stays byte-stable. A photoless garment draws its role's silhouette (`GarmentSilhouette`, `parts.tsx`); the hanger is the dock's.
**Consequence:** an established Today stays at 3 statements (2 dressed); a first-run Today is 2, as no idea is drawn. A new surface that plans or suggests hides behind `canProduceOutfit` too.

## 2026-11-14 — A bar above the dock that must not cover content is sticky, not fixed (#664)

**Why:** Styling's phone bar grew from Shuffle and Save to the outfit's strip and the fit chips (they wrap, and the strip opens), so a fixed bar's guessed page padding (`pb-40`) could no longer promise the last row stays uncovered.
**Decision:** the aside is `sticky bottom-dock` in the flow after the rows (the page pads only `pb-dock`): it rides on the dock while they scroll and lands below them at their end, whatever its height. The preview's phone strip and desktop stack are one markup; `group-open:` and `lg:` spell the stack twice and must agree (`group-open:` wins on specificity).
**Consequence:** a new bar above the dock whose height varies is sticky in its page's flow; a fixed one (`fixed left-rail bottom-dock`) suits only a bar of known height. `test/styling.spec.ts` holds the geometry at 390 px.

## 2026-11-14 — The bare composer opens on "No garment", Shuffle leads (#665)

**Why:** `freshStates` chose the newest garment per role, by id, over `inCloset`: on a rainy November day it opened on swim trunks and slides and looked like a suggestion, ignoring wash and away state. The page must stay byte-stable (a stale-while-revalidate tab root), so it cannot be seeded by the day or the clean state.
**Decision:** every drawn row opens on "No garment" (newest first stays the strip's order); Shuffle is the primary button while no preview slot holds a garment and Save takes over once one does; the bar's "Nothing chosen yet" hint hides likewise. All three are CSS (`group/bar` + `group-has-[[data-preview-garment]:not([data-preview-garment=''])]`) off `data-preview-garment`, which the server draws, a rows answer redraws and styling.js keeps, so they follow Shuffle and a swipe with no swap of the bar. The fit line already answers nothing without a garment. `?with=`, `?outfit=` and edits open on their garments as before.
**Consequence:** the bare page's bytes still depend on the wardrobe alone. A control whose look follows the composer's choice reads `data-preview-garment`, never markup shape or a render-time flag. Rejected: skipping away or unwashed garments in `freshStates` (needs state that changes by itself).

## 2026-11-14 — A wash and a wear keep their instant on their day (#676)

**Why:** `last_washed_on` is a date, so a tee washed Sunday morning and worn that evening was clean on Monday. `garment_wear.created_at` is the insert (a replay's, a late "Worn?"), not when it was worn.
**Decision:** `garment.washed_at` and `garment_wear.worn_at` (0056, nullable; null for every earlier row) hold the instant only when known and inside the row's day in `APP_TIMEZONE`, one rule for wear, wash and entry worn (`tapInstant` + `instantOnDay`): the posted tap's `at` capped at the server's now; without one, now for a live tap but unknown (null) for a replay (`X-Closet-Queued`: the replay's time is not the tap's); dropped outside the day, never clamped to its edge. The outbox posts `at` on wear, wash and entry records. A same-day wear counts after the wash iff both are known and `worn_at > washed_at`; otherwise the day rule. `markWashed` keeps a known instant against a timeless same-day wash (only a later day replaces it; only rows that move are updated); a day-level wear met again (`setWoreToday`, `detachOutfitWears`) keeps the later known instant.
**Consequence:** bounded limits, accepted: a record queued before the deploy (no `at`), then that day's wear, counts by the day rule (0); a live entry marked at 21:00 for a morning wear after a 09:00 wash counts as after (errs toward dirty); a slow client clock can misorder (only a fast one is capped). Rejected: ignoring a `washed_at` off its day in the rule (needs the time zone in every SQL caller; the one writer cannot produce one).

## 2026-11-14 — A failing page backs off the activation refresh; fonts and `?v=` favicons across builds (#780, #781, #782)

**Why:** `refreshed-at` was written only when no key failed, so one page answering 500 made every `WARM_PAGES` rescan `pages-v2` and refetch it; the per-build precache (#742) stopped matching `/favicon.ico?v=` and answered fonts only from the active build's precache.
**Decision:** a failed key gets a `RefreshBackoff` record beside it (5 min doubling to a day, reset by any other answer or a later activation, whose `activated-at` it carries); `refreshed-at` is JSON `{ at, retryAt }`, written once every key was asked or is backing off, and due again at `retryAt` (`refreshDue`, `page-cache.ts`). The PrecacheRoute strips `v` only outside the versioned roots (`unversionedPrecacheVariants`); `/vendor/fonts/` without `?v=` is answered from the own precache, then the latest-activated other (`answerContentHashed`).
**Consequence:** a failing page is asked at most on its backoff, never per load; a versioned root's `?v=X` still never meets another build's bytes. A new content-hashed path joins `isContentHashed`.
## 2026-11-14 — The keyword is a word-start AND-search, keys resolved from labels (#673)

**Why:** one literal phrase over name, brand and notes found "navy blazer" but not "blazer navy", nothing for "blue shirt" (colour and type are keys) or "jcrew", and a blazer for "tee" through its notes; Muse's `search_garments` inherited it.
**Decision:** every whitespace word must start a word (punctuation folded on both sides) of the name, brand, notes or category, or of a colour's or type's label; labels resolve to keys in TypeScript before the query (`keyword-search.ts`), so the catalog stays their one source. Word-start, not substring: "shirt" must not find T-shirts or sweatshirts. A notes-only match ranks after the rest (`keywordRank`), newest first within each rank, keyset-paged on `(rank, id)`, the rank carried in the cursor (`grid-cursor.ts`; rank 0 is still the bare id, so unranked cursors and cached pages read as before). The first cut read the cursor's rank from the row its id named, unscoped: any wardrobe's garment, so the page answered whether a stranger's private text held the keyword (#784 review, P1). The fold is one fixed punctuation set (`FOLDED_PUNCTUATION`) and `pg_unicode_fast` lowering, never a locale-dependent class. No index or folded column at household size.
**Consequence:** the grid, `GET /api/v1/garments` and `search_garments` share `gridWhere` and `gridOrder` (queries.ts); a new searchable field joins `strongMatch`, and a new sort order still needs its own cursor. A substring inside a word ("ford" for "oxford") no longer matches.

## 2026-11-14 — The filter sheet chips are real inputs; Type shows with the category, by CSS (#674)

**Why:** `Choice` was a `display:none` radio under a badge: no tab stop, no role or state for VoiceOver, no way to clear one value, and Type only after Apply.
**Decision:** `Chips` (`form-field.tsx`, shared with the garment form) is the one chip: radio `input.btn` + `aria-label`, and a "× Clear" radio (value empty) while a value is chosen, so a single choice clears alone and stays a native radio group (a checkbox toggle would change the form semantics and the arrow-key model). Every category type group is rendered and revealed with `group-has-[...:checked]/filter:block`, no script. Guard `@hidden-control` refuses `class="hidden"` on a form control in `src/web`, except the password manager username twin and the share page file input.
**Consequence:** a new built-in category needs a `TYPE_GROUP_REVEAL` entry (the Record type enforces it). The clear chip appears for an applied value only, not one just picked in the open sheet.

## 2026-11-14 — Link import says how much it read: `confidence` (#675)

**Why:** a shop that serves an app shell or redirects to its home page gave `extractProduct` only a marketing headline as `<title>`, and the form opened with it as the garment's name under "Filled in from the page"; Muse could not tell a weak read from a good one.
**Decision:** `extractProduct(html, finalUrl, requestedUrl)` returns `confidence`: `product` (JSON-LD Product, or Open Graph with `og:type` product, a `product:` or `og:price:` tag), `page` (Open Graph alone), `title-only` (a title or nothing). A link that **left the product path** is `title-only` whatever the page says: the requested path was deeper and the final one is the site root or a single-segment locale root (`/en-us/`), or another host's root; any other change (a canonical `/product/123/slug` to `/product/123`, a locale prefix) is not leaving. `title-only` prefills only the link, shows a warning (`LinkImportView.warnings`, `alert-warning`) and fetches no photo (its og:image is the shop's logo). Titles lose a trailing " | Site", " – Site" or " — Site"; brand falls back to `og:site_name`, then the registrable name of the host (a tiny `co`/`com`/... second-level list, no public-suffix dependency), only for `page` and `title-only` reads (a retailer of many brands is never a product's brand); the suffix goes only when it is the site's name, alone or followed by words ("UNIQLO US"), never by position; colour falls back to the address's last path segment and `color`/`colour` query.
**Consequence:** `saveGarmentFromLink`'s notices lead with the warnings, and MCP's `add_garment_from_link` and `suggest_garment` and `POST /api/v1/garments/link-imports` carry `confidence` (null for an image link). MCP and the API answer a title-only read with no `name` as a 422 whose message leads `title-only:` (like the fetch refusals' reasons, a `body/name` error on the API) and save nothing; a name override saves as before.

## 2026-11-14 — The warm names every page with a queueable control (#657)

**Why:** `/trips/:id` and `/laundry` render `data-offline-queue` controls that replay fine, but a warm that never named them left a phone that had not visited them showing the offline page: packing at the airport worked by luck.
**Decision:** `src/offline-writes.ts` holds the one list (`LAUNDRY_PAGE`, the trip page pattern, `isQueueablePage`); `showsQueuedWrite` and `warmList` both read it. The warm names `/laundry` always and the owner's trips whose last day is not before `todayIn(APP_TIMEZONE)` (nearest first, `WARM_TRIP_CAP` 20), right after next week and before the garments, outside the garment and outfit caps (`WARM_PAGE_CAP` grows by 21). One more scalar in the list's one statement.
**Consequence:** `test/integration/offline-warm.spec.ts` fails when a page `showsQueuedWrite` names is neither a tab root, Today, a garment page nor a warmed queueable page, and checks each listed page renders a control. A new queueable page joins the list in `offline-writes.ts`.

## 2026-11-13 — Plan my week answers the week and day it starts on
Why: the calendar shows Sunday to Saturday, the plan covers today and six days, so on a Friday the first planned day was off-screen under a text banner (#683).
Decision: the POST redirects to `?week=<startOfWeek(first planned day)>&planned=<batch>#day-<first>`; banner rows are links (`#day-D` in the shown week, `dayUrl` otherwise) with a `thumb` collage. Nothing planned keeps `/calendar?planned=none`.
Consequence: `plannedWeekUrl(planned, firstDay?)` is the one builder; the banner's garments ride `batchEntriesSql`, still the week's one statement.

## 2026-11-13 — One status region for every write's result (#679)

**Why:** "Wore today", the worn pill, Washed, Mark washed and Wear this dropped focus to `<body>` and announced nothing; `SavedToast` inserted its own `aria-live` container with the page, which screen readers do not reliably read.
**Decision:** `#toast-host` is the one polite region (`role="status"`); htmx writes fill it with `announce()` (`HX-Trigger` `closet:status`, the encoding shared with #642's failures, `src/htmx/trigger.ts`), native posts' landing pages with `SavedToast`'s inert template, both read by `public/js/toast.js`. Toasts carry no role of their own. In-place write buttons keep one id across states (htmx refocuses by id); a vanished control or a landing page sets `autofocus` on where focus goes.
**Consequence:** saved toasts now show at the bottom above the dock, not under the app bar, and need script. `SavedToast`'s props are unchanged. A new in-place queued write needs a stable button id (`expectInPlaceWritesKeepFocus`, in `expectFullPage`); other `hx-post` forms are not yet held to it.

## 2026-11-14 — A trip is dressed in its destination's zone; "today" stays home's (#678)

**Why:** every forecast was asked in `APP_TIMEZONE`, so a Tokyo trip day's 8-22 window read 22:00 to 12:00 Tokyo time (the night), and its outfits and packing skewed cold for eastward travel.
**Decision:** a trip carries `time_zone` (0057), the geocoding answer's `timezone`, canonicalised by `canonicalTimeZone` and written only by `setTripDestination` with the coordinates (invalid or missing: null). The weather caches key on `(latitude, longitude, time_zone)`; a trip's forecast and normals are asked in its zone, the home's in `APP_TIMEZONE`. Nothing is learned on a GET.
**Known 0.1 limits:** "today while travelling is home's": which trip days are left, "Wore it" and the calendar follow `APP_TIMEZONE`, so across the date line a trip day can lack a forecast and shows its typical weather instead. Trips located before 0057 keep APP_TIMEZONE until their destination is re-saved: geocoding has no reverse lookup, and a backfill job probing the forecast per trip was not worth a job for a handful of rows.
**Consequence:** a new reader of a trip's weather passes `zonedIn(trip.location, weather.timeZone)`; a new writer of a trip's place goes through `setTripDestination`. Rolling back past 0057 needs the down script in `docs/operations.md`.

## 2026-11-14 — Select mode is one selection several verbs act on (#677)

**Why:** select mode was wired to one verb (Set…) and returned to the plain grid, so a second property, a capsule or a wash meant selecting again, and only loaded tiles could be selected.
**Decision:** every verb (`/wardrobe/bulk`, `/bulk/capsule`, `/bulk/washed`, `/bulk/archive`) posts the same form and answers 303 to `?select=1` with `selected=<ids>` (or `all=1`) checked again. "Select all N" posts `all=1` and the filters, never ids; the server resolves them through the grid's own `gridWhere` (`gridIds`), one predicate. Archive needed a list form of the status writer: `setGarmentsStatus` (rows locked in id order, one update) is now the writer and `setGarmentStatus` its one-garment answer, so there is still one writer. The verbs are online only (`data-needs-network`): "all" is resolved server-side, so nothing is queued.
**Consequence:** Archive and Mark washed are `webOnly` (a client keeps its own selection and calls the per-garment writes or `POST /garments/washes`); Add to capsule twins `changeCapsuleMembers`. Select mode's context now reads `count` and `capsules` (3 statements, was 2).

## 2026-11-14 — Agent writes carry the token that made them (#682)

Why: rows an MCP tool wrote (entries, trip outfits, outfits, garments) looked hand-made; the owner could not tell what Muse did.
Decision: one shape, `src/web/write-origin.ts`: stamping writers take a required `madeBy: WriteOrigin` (`originOf(ctx)` on MCP, `BY_PERSON` elsewhere; named `madeBy` because `origin` is already the outfit's #659 field). Entries add `planned_by = 'agent'` + `planned_by_token_id` (ranked `auto < agent < user` in `calendar/planned-by.ts`); trip outfits `planned_by_token_id`; outfits and garments reuse `proposed_by_token_id` / `suggested_by_token_id`, mapped as `addedByTokenId` with their SQL names kept (no rename churn). The name is read live (tokens are revoked, never deleted, and cannot be renamed); the garment's column is a soft reference with no FK, because a grantee's agent stamps the owner's garment and deleting the grantee must leave "Agent". Viewer rule: the token's author sees its name, the owner "<first name>'s agent", anyone else "Agent", applied in SQL (`agentLabelSql` with the viewer), so no row carries the author or another's token name; `agentName` only words the label. Muse's needs, suggestions, proposals and rounds read it too (`museLabelSql`): no other reader joins a token's name. Since the token no longer means "a suggestion" or "a proposal", only `suggested_at` / `proposed_at` mark one: every Muse reader tests them, never the token.
Consequence: MCP_WRITES' required `attribution` says what each tool stamps; `mcp-attribution.spec.ts` runs every `stamps` and `none` tool, keeps agent-made rows out of the inbox and proposals, and reads the viewer rule per viewer, past the grantee's account deletion. update_garment and add_garment_copy stamp nothing (edits), which narrows #682. The badges in the views are a follow-up issue.

## 2026-11-14 — Offline notices derive from the queue kinds (#658)

**Why:** the trip's offline note said packing needs a connection while ticks queue, the fallback page sat under a "showing saved data" banner, and a queued tick left the counter and the "Saved" line as they were.
**Decision:** `offlineNotice(kinds)` (`src/offline-writes.ts`, pure) maps a page's `data-offline-queue` kinds to none / wears / washes / ticks / changes, and the page renders the matching `offlineNotice.*` string (the trip page derives its kinds from the controls it draws). The global banner says dimmed controls need a connection, once. `/offline.html` carries `data-offline-fallback`, which makes connectivity.js hide the banner, and links `OPENS_STALE`'s tab roots. The outbox sets `[data-packed-count]` from the checked ticks and empties the autosave status when it queues.
**Consequence:** a page that gains a queueable control joins its kinds list; no string may say a queueable write needs a connection.

## 2026-11-14 — DATA_PATH is identified by a marker, not by its contents (#650)

**Why:** a container started on the bare NFS mountpoint read as "every photo gone": reconciliation deleted every pending row and reported success, and uploads landed where the remount hid them.
**Decision:** `claimStorage` (`src/web/files/storage-identity.ts`, run by `createPhotos` in every process) writes `.closet-storage` (`installId`, `createdAt`; temp + rename) only on an empty `file` table or when the directory holds the sets of 90% of the rows (`ADOPT_MIN_COVERAGE`: a mountpoint's stray uploads never adopt it); anything else, or an unreadable marker, refuses (`StorageIdentityError`). It is created exclusively (`link`, EEXIST adopts the winner), so a server and a CLI booting together agree on one install id. Readiness and each reconciliation run re-read it against the claimed id; reconciliation also refuses rows with zero stored sets. Neither refusal yields to `--force`.
**Not done:** the install id is not copied into the database, so a share swapped with another install's before a boot passes. That needs a one-row table (a migration); proposed for a follow-up rather than built here.
**Consequence:** a backup of the photos must include the marker; recovery and re-adoption are in `docs/operations.md#photo-storage-marker`.

## 2026-11-14 — A workflow file that does not parse cannot merge, and a silent nightly is reported (#635)
**Why:** #532 put a bootstrap step between `uses: actions/checkout` and its `with:`; GitHub refused nightly.yml, so no scheduled run existed for two days and nothing said so (no PR job parses workflows; a nightly that never starts opens no issue).
**Decision:** `make actionlint-check` (in `ci-guards`, so both hooks and ci-quick) runs `scripts/ci/actionlint.sh`: the upstream release, pinned by version and sha256, cached under `~/.cache/closet`, never vendored. The npm `actionlint` wasm is 1.6.x (rejects `ubuntu-24.04`) and was refused. `nightly-watchdog.yml`, a file of its own, runs `scripts/nightly-staleness.sh` daily: no completed scheduled nightly in 48 h opens or updates one issue.
**Consequence:** the first run on a machine needs curl and network (or `ACTIONLINT_BIN`); a version bump needs the four checksums from the release's checksums.txt.

## 2026-11-14 — A warm whose list a drop overtook runs again (#812)

**Why:** the first signed-in page claims the cache from the sign-in page's empty owner, which is a drop (generation +1). A warm already fetching its list then found the claim stale, returned with nothing stored, and nothing re-queued it: the device stayed unwarmed until its next load or visibility event (the trips spec's offline step failed first try, and sometimes never saw the trip).
**Decision:** `fetchWarmList` sets `warmAgain` when its claim is refused for a moved generation, so `warmPages` runs once more in the new generation; no second queue. A spec cannot hold a worker's request with `context.route` or wait on its console reliably (Playwright attaches to a service worker after it has started): it holds a worker request by wrapping `fetch` inside it (`holdWarmList`).
**Consequence:** a drop mid-warm costs one more run, never a lost one. A spec asserting the warm calls `withoutWarming(context)` and `warmOnce(page)` so it alone decides when the single WARM_PAGES goes.

## 2026-11-14 — Third-party notices are generated at build and served, forecasts credit Open-Meteo (#640)
**Why:** client files are minified or copied without their banners, `@fontsource` (OFL 1.1) is a devDependency absent from the final stage, and Open-Meteo's data is CC BY 4.0 with no credit shown.
**Decision:** `npm run generate:notices` (`scripts/third-party-notices.ts`, in `build` before `generate:sw`) writes `public/THIRD-PARTY-NOTICES.txt` from `package-lock.json` (every non-`dev` package, plus the build-bundled fonts, daisyUI and the workbox modules with their dependencies) and each installed package's licence files, no new dependency; icons (Heroicons, Hugeicons, MIT) and the weather credit are hand-written sections. It is served by the static root (`/THIRD-PARTY-NOTICES.txt`: a static path, revalidating since /about links it without `?v=`, not precached) and the image gets it with `public/`. Every forecast surface renders `OpenMeteoCredit` (`src/web/weather/views.tsx`): plain text, no link.
**Consequence:** a new `CLIENT_MODULES` entry or bundled devDependency must be in the lock's production tree or `BUNDLED_AT_BUILD` (`third-party-notices.spec.ts` fails otherwise). Optional platform packages appear only where installed.
**Versions are omitted** from the public notices (an anonymous fingerprint of known-vulnerable server dependencies); names, licences and licence texts are what a notice needs. Normals are Open-Meteo data too, so the credit shows on typical days as well.

## 2026-11-14 — Reconciliation quarantines unexplained photo sets (#649)

**Why:** after a database restore from an older dump, the photo sets of garments added since have no `file` row and are the only copy; a dozen of them passes the wholesale guard, so the nightly unlinked them.
**Decision:** the orphan pass renames each set into `DATA_PATH/.trash/<APP_TIMEZONE day>/<base name>/` (`PhotoStorage.quarantine`; a second set of a name that day gets a `~<hex>` entry, never an overwrite), and the same run purges day directories older than 30 days (`TRASH_RETENTION_DAYS`), not while the guard refuses. `--restore-from-trash` links files back whole or not at all, stamped now, and refuses over a live set. Unreferenced rows' sets, pending photos and superseded variants stay direct deletions: a row explains them.
**Consequence:** DATA_PATH holds at most 30 days of orphans. A restored set without its row is quarantined again the next night; re-attaching is out of scope.

## 2026-11-14 — One AgentBadge shows who made a row (#822)
**Why:** #821 resolved the viewer's label in SQL (`agentLabelSql`) but nothing in the app showed it.
**Decision:** `src/web/agent-badge.tsx` words an `AgentLabel` (`agentName`) as a `badge-soft badge-secondary` pill, the name truncating inside it, "Made by <name>" for assistive tech. Pages get the label as one more column of their own statement (the Saved tab's `savedOutfitsSql`, the wishlist's `ownItemsSql`, the garment page's existing context), so no statement count moves. Muse's rows keep "From Muse" and get no second badge.
**Consequence:** the month grid shows none (its cells are collages only). A new surface for an agent-made row adds its label to its own query and renders `AgentBadge`, never a token name read another way.

## 2026-11-14 — The database records its photo storage's install id (#833)
**Why:** #650's marker proved DATA_PATH is a closet install's storage, not this database's: another household's or a staging copy's marked share mounted before a boot was accepted.
**Decision:** a one-row `install` table (boolean primary key checked true; not synced, no owner) holds the marker's install id, written by the claim that writes or adopts the marker, or from the marker found when no row exists (the deploy pairs production with its own share). A different id is `unpaired`: with `APP_ENV=production` boot, CLIs and reconciliation refuse; elsewhere one warn line (worktrees share pgvault-dev with their own DATA_PATH). Readiness never reads the row: it compares the marker with the id claimed and paired at boot, so database trouble never reads as storage trouble. A marker written over an unmarked share takes the row's id, so a 90% re-adoption pairs. Re-pairing is `maintenance:reconcile -- --repair-storage-identity --confirm`, never a hand SQL: it reads the marker and never writes one.
**Consequence:** production's reconciliation costs one more statement (4). A database repointed under a running server is caught by the next reconciliation and boot, not by readiness. A database restored without its `install` row pairs with whatever marked share it next boots on, as the deploy did.

## 2026-11-14 — The database out of reach is a 503 busy, captured once per outage (#643)

**Why:** with pgvault down a signed-in phone got the error handler's JSON as its document (the root hook threw before building a page context), every request was a Bugsink event, the worker served the 5xx over its copy, the pool had no client timeouts (a blackholed host waited on the kernel), and `errorFields` cut the Postgres reason off behind Drizzle's 200-character statement.
**Decision:** `TimedPool.connect` fails as `DatabaseUnreachable`; `isDatabaseUnavailable` (`src/db/errors.ts`, over the one cause walk in `src/driver-error.ts`) adds class 08, 57P01-03 and a connection lost under a Drizzle query (errnos only there: an outbound fetch has the same ones). `describeError` answers it as `DatabaseUnavailable` (503 `busy`, `Retry-After: 5`), warn with the error; `DatabaseOutage` captures the first per outage, ended by createDb's `onAnswer`: a connection opened or one given back with its last query answered (a full pool under steady load opens no connection, so a `connect` event alone could leave the latch set). pg-pool's queue timeout (the same `connectionTimeoutMillis`, no socket opened) is `PoolExhausted`, a 503 `busy` that is never captured and never begins an outage. The root hook builds a signed-out `ViewContext` before rethrowing. The worker's NetworkFirst (`ServerFirstPages`) takes `serverUnavailable` answers like a timeout, in `_handle` because a preload response skips the fetch plugins. `DbTimeouts` gains `connectMs` 5 s, `queryMs` (statement + 1 s) and keepalive, shared by the listener. `errorFields` reads innermost first.
**Consequence:** a pool saturated for 5 s answers `SERVER_BUSY` instead of waiting. node-postgres's `query_timeout` leaves the statement running, so `TimedClient` ends a timed-out connection (a transaction's ROLLBACK otherwise waited behind it and the busy connection was pooled again). The worker learns an account only from a 200 HTML answer (`renderedAccount`): the busy page renders signed out. Sentry's Dedupe drops a second outage's event identical to the previous event, so a spec counts outages by the `Db` warn line. A pg bump re-checks the codeless messages in `errors.ts`.

## 2026-11-14 — The home calendar reads a trip's days, nothing more (#684)

**Why**: a trip was invisible to the week: "Plan my week" dressed Lisbon days for Brooklyn's forecast, and a new trip's destination needed a second Find before its forecast showed.
**Decision**: trips stay standalone lists; `src/web/trips/away.ts` (`awayTripsSql`, folded into each reader's existing statement, so no page pays a round trip) is the one cross-reference. The week and Today show "Away" linking to the trip; `planMyWeek` skips trip days and says so; a trip's create and re-dating remove the planner's unworn entries on its days from today on (a trip logged after the fact keeps past plans) in their own transaction, and the re-plan any left (one rule, `removeAutoEntries`), never a person's or an agent's. A new trip's form picks its destination from the weather's search (the trip page's Find, in the form: `DestinationPicker`), and the create stores the pick through `setTripDestination` in its own transaction (`createTripAt`; the API's `place`). Not a lookup at save: "exactly one result" rarely holds, a post-commit search could fail after the insert (a retry then duplicates the trip), and every create would be an unthrottled outbound search.
**Consequence**: a new reader of "days the planner may fill" goes through `splitAwayDays`. Only the new-trip form has the picker; an edit's new name still clears the place and offers Find. Packed garments are not held back from home plans (out of scope).

## 2026-11-14 — A job that left someone out ends as a failure (#687)

Why: `timeJob` records `failure` only when `run()` throws, but reminders, the re-plan and reconciliation caught per person (or refused) and returned, so a person's reminder failing daily, a refused guard or photo rows without bytes showed a green dashboard; the re-plan also claimed the day after a failure.
Decision: the per-person loop is unchanged; the scheduled wrapper (`*Whole`, `src/metrics/partial-failure.ts`) throws `PartialFailure` after the others finished when `failed > 0`, the run was refused or `missingOriginals > 0`. `JOB_OUTCOMES` is unchanged. A failed re-plan leaves its day unclaimed and is retried at 5, 15 and 60 minutes (`ReplanRetries`, in process: no table, a restart only retries sooner), the fourth failure claiming the day as before; only the first failure of a person-day is counted, so one metric and one capture, not one a minute. A forecast fetch that fails with nothing cached is no forecast (`userWeatherOrNone`), never a failed person.
Consequence: a new per-person job throws at its end the same way; callers wanting the report call the unwrapped function.
## 2026-11-14 — Each re-plan job reports its own first failure (#858)
Why: the minutely re-plan and the morning reminder share one `ReplanRetries`; a reminder failing first used up the person-day's single `reported` slot where nothing counted it, so `replanWeeksWhole` never ended as a PartialFailure.
Decision: the retry schedule stays shared; "first failure" is tracked per job (`ReplanJob`: `replan`, `reminders`) and the reminder counts its own into its `run.failed`.
Consequence: a person-day failing in both paths yields one failure metric and capture per job; a reminder whose re-plan failed still sends and its run reports `failed`.

## 2026-11-14 — The outbox gives up on a record the server keeps failing (#691)
Why: `replayVerdict` retried every 5xx forever and the drain stops at the first retry, so one deterministic 500 left every later queued write unsent with no sign online. A per-record count alone would let a server-wide outage (restart, deploy) fail the whole queue.
Decision: a 5xx counts against a record only when the server answers another record properly in the same drain (`replayQueue`: the head waits as a suspect, the next is tried); 5 counted answers within 10 min fail it ("server") and the drain goes on. Two 5xx in a row, or a lone record, back off and spend nothing. Network errors, timeouts, 408, 429 and 503 (the busy page) never spend it; they neither spend nor clear the count. The counters are optional fields on the IndexedDB record, so no schema bump.
Consequence: an outage never fails a wear; a lone poisoned record retries until a neighbour proves the server healthy. A tap on a failed record's key is sent as a newer intent.

## 2026-11-14 — A model the queue cannot have is a state of the queue (#689)
Why: `runnerReady` caught a refused download, a bad checksum, EACCES or a missing onnxruntime binding, slept 5 min and claimed nothing, while `cutout_queue` read `up` (it reported only "started") and every open garment page polled every 2 s forever.
Decision: the queue owns an explicit state (`src/cutout/queue-state.ts`: stopped, running, waiting-for-model with a closed kind), moved only by `queueTransition` through `CutoutQueue.transition`, which logs and captures the first failure of an outage and each new kind once (source `cutout_model`). The binding is proven by a short-lived model process answering `probe` (`ModelRunner.ready`), never by loading onnxruntime in the web process. `cutout_queue_oldest_age_seconds` comes from the depth's own count (no extra statement). The pending poll backs off by a poll count in its URL (2 s for 30 s, then 10 s), no server clock or per-page state; past 2 min it stops with a "queued" line only while the queue is waiting-for-model, since a busy working queue (a bulk upload) would otherwise strand cutouts that land seconds later (review of #864).
Consequence: a smoke boot with the placeholder model reads `cutout_queue` down (`checksum`), still 200. A new way the model can fail adds a kind and its fix, never a free-text reason in the body.

## 2026-11-14 — A switched context closes through `closeSwitchedContext` (#867)

Why: `networkSwitch`'s `context.route` handler awaits `abort()`/`fallback()` per request. A device left offline with queued writes (trips, offline-writes) still makes requests (outbox replays, heartbeat), so `context.close()` could run while a handler was pending; its call then failed with "Target page, context or browser has been closed" and that surfaced at `close()`, passing on retry.
Decision: such a context ends with `closeSwitchedContext` (`test/support/service-worker.ts`): `unrouteAll({ behavior: 'wait' })`, then `close()`. Each scenario's `finally` is still the one owner of its context.
Consequence: a new spec using `networkSwitch` on a context it closes uses the helper, never a bare `close()`.

## 2026-11-14 — A removed entry prunes only the one-off it created (#748)

Why: pruning every unheld idea/planner outfit when an entry went also took outfits that existed before the entry (a reused planner outfit, an idea outfit picked earlier); only the planner's `week_plan_entry.outfit_created` said who made one, and Wear this had nothing.
Decision: `outfit_calendar.outfit_created` (nullable boolean, 0060), written true by the pick that created the outfit (createOutfit's plan, wearIdea, Change), null otherwise; `deleteEntry` reads only it (the planner's `week_plan_entry.outfit_created` goes stale when Change gives the entry an existing outfit), the outfit is origin idea/planner and nothing holds it (`removeUnheldOutfits`, which never deletes person/agent).
Consequence: existing entries are null, so their outfits are kept as before (planner entries made before 0060 lose x-pruning until re-planned). The column is internal: not in the sync feed or the API.

## 2026-11-14 — A 5xx makes a queued write stuck, never failed (#865, #866; replaces #691's budget)
Why: #691 failed a record after 5 counted 5xx, but only if a neighbour was answered, i.e. it inferred server health. Three review rounds found the inference wrong each way (a lone poisoned record never failed; an outage could fail valid writes; evidence went stale), and a durable health stamp only moved the error.
Decision: no inference, nothing dropped. 3 consecutive 5xx (`STUCK_AFTER_SERVER_ERRORS`) make the record `stuck`: still pending, skipped by the drain with its key, listed in the notice with Try again and Discard. It is retried when a record saves in a drain or after 30 min (`STUCK_RETRY_MS`), and stays stuck while it fails. Other keys keep going; the network, 408, 429 and 503 still stop the drain and count nothing.
Consequence: a server-wide outage marks records stuck and loses none; a poisoned wear waits for the user. A same-day wear and wash are different keys, so their order rests on the taps' `day`/`at` (absent on pre-#676 records).

## 2026-11-14 — Stuck retry ladder; Try again and Discard take the drain turn

Why: a Postgres blip answers 500 behind a live heartbeat, so writes went stuck for a flat 30 min (#877); Try again/Discard raced a replay in flight (#878, #881).
Decision: a stuck record retries after `stuckRetryMs` (1 min, doubling per further 5xx, capped at `STUCK_RETRY_MS`); a negative stuck age is due; the notice buttons run inside the drain lock (`exclusively`).
Consequence: a poisoned record is retried a little more often early on; no second concurrent replay of a record.

## 2026-11-14 — `closeSwitchedContext` unroutes with 'ignoreErrors', never 'wait' (#886; replaces #867's 'wait')

Why: `unrouteAll({ behavior: 'wait' })` awaits every in-flight handler invocation, and `networkSwitch`'s handler awaits `route.abort()`, a browser round trip Playwright races only against the request's page or worker closing (a request tied to neither races a scope that never closes). One unanswered abort hung trips' teardown until the 30 s test timeout. A handler that never settles reproduces it: 'wait' never returns, 'ignoreErrors' returns at once.
Decision: setOffline(true), `unrouteAll({ behavior: 'ignoreErrors' })` (Playwright drops in-flight handlers' target-closed errors without waiting on them, the #867 failure), then close().
Consequence: teardown waits on no handler. A route handler on a switched context must not catch its own `abort()` rejection: Playwright then never marks the route handled and the invocation stays pending.

## 2026-11-14 — The schema check has three states; an older image refuses a newer schema (#651)
Why: redeploying a previous `sha-` image after a migration booted (drizzle's `migrate()` finds nothing newer than its last row) and old code wrote to the new schema; destructive migrations ran under the hourly autoupdater with no dump taken.
Decision: `schemaState` (`src/db/migrate.ts`): behind / current / ahead, the one rule for the boot (`SchemaAheadError`, checked first, writes nothing), the CLIs (exit 1) and `/health/ready` (`migrations` down with `schema`). A migration is identified by `created_at` (the journal `when`), drizzle's own key; `hash` is never re-read by drizzle, so it decides nothing. A newest row the journal lacks is ahead, whether newer or not (a branch build's migration too).
Consequence: a rollback either restores the pre-migration dump or undoes each newer migration and deletes its row (`docs/operations.md#migrations-and-rollback`; the 0057 steps now delete its row). The deploy takes `pg_dump -Fc` whenever the image has pending migrations, kept until the next: the deploy script is homelab's, tracked there.

## 2026-11-14 — Background removal can be switched off (`CUTOUT_ENABLED`); the image keeps its own platform's onnxruntime binary (#690)
Why: `main.ts` always fetched the 940 MB model and the child peaks near 3 GB RSS, so on a 1-2 GB host every photo ended on "Try again"; a broken Hugging Face URL left no clean way to run without cutouts. The Dockerfile also deleted linux/arm64's binary unconditionally.
Decision: `CUTOUT_ENABLED` (default true). Off: `bootModelRunner` returns no runner (no `CutoutModel`, no download), `serve()` starts no queue and no retry, new uploads and rotates start `none` through `initialCutoutState` (no new photo state), and the queue sits in a terminal `disabled` state of #689's machine rather than `stopped`+reason: `stopped` means "not yet or no longer running" and reads as down. `/health/ready` reports `cutout_queue` `up` with `disabled: true` (the contract allows only up/down). The Dockerfile deletes every onnxruntime binary directory not matching BuildKit's `TARGETARCH`.
Consequence: the API's photo-write answers may now say `none`. A photo already `pending` or `failed` when the switch flips is shown as `none` at read time by every surface (`shownPhoto`, `cutout-shown.ts`: the garment page and poll fragment with no spinner, poll or "Try again", the API's garment reads and the changes feed with no `pending` to poll for; MCP exposes no cutout status), never rewritten, so turning removal back on resumes it; a hand-posted retry is refused (`not-allowed`). A rotate with removal off turns an existing `ready` or `none` cutout along with its photo (stored `edited`), since nothing would re-cut it. `serve()` starts the queue from `config.CUTOUT_ENABLED` alone, never from a runner being passed.

## 2026-11-14 — The changes cursor carries a sync epoch; a restore bumps it (#652)
Why: a database restored to an older revision reuses revisions and serial ids a device already holds; its cursor read `> 500` forever and never learnt the lost rows were gone.
Decision: one-row `sync_epoch` table (a random uuid, `bumped_at`), not a column on `install`: that row exists only once photo storage is paired, its id is NOT NULL and the storage repair upserts it, while the epoch must exist from the migration on. Random, never a counter: two restores of one dump would mint the same next integer. The cursor carries it as `e`; another is a 410 `cursor_expired`. It is cross-joined onto the wardrobes statement, so a page sends no statement more and no process cache goes stale when a CLI bumps it. A cursor without `e` (pre-#652) is current until the first bump: nothing was restored before it, so the deploy re-syncs no device. Second guard: a position above its wardrobe's current revision is a 410.
Consequence: `bumpSyncEpoch(db)` (`src/db/sync-epoch.ts`) is the post-restore step #653's CLI runs; until then a restore is caught only by the revision guard, and only where the restore went below the device's revision.
## 2026-11-14 — Deletes ask in the app's sheet or offer Undo, never confirm() (#686)

Why: the 11 `hx-confirm`/`data-confirm` sites fell through to the browser's confirm(), titled with the server host, unstyled in the installed app; reversible removals asked anyway, and a page's guess of "reversible" and a client-posted Undo were both forgeable or stale.
Decision: one `htmx:confirm` + PostForm `submit` listener (`public/js/confirm-sheet.js`) over one `<dialog>` in every body; the outbox's discard uses `confirmAction()`. A calendar entry's Remove acts at once with an Undo toast only when the restore is exact (unworn, not an agent's, no one-off pruned); the SERVER decides (`deleteEntry({ asksFirst })` rolls back and answers 409 + `closet:confirm` unless `confirmed=1`), and Undo posts only a token for an in-process snapshot (`createUndoStore`, 30 s, owner-scoped, single use; web-only, `createCalendarEntry` is the API twin). One-off outfits keep the sheet: recreating a pruned outfit was not worth the code, and deferring the prune would leave unheld one-offs in Saved.
Consequence: `@native-confirm` guard; Playwright's `test` comes from `test/support/fixtures.ts`, which fails a scenario on any native dialog. A restart or the TTL loses Undo, nothing else.

## 2026-11-14 — After a restore: one command, and a photo with nothing stored is marked, not broken (#653)

Why: restore was never a named operation: its steps were gotcha paragraphs of raw `update file set` SQL written before the sync triggers, which refuse it (no owner lock) or let it pass unseen by devices, and rows whose bytes were gone drew broken tiles forever.
Decision: `maintenance:after-restore` bumps the sync epoch, revokes push, releases leases older than 2 × the model timeout (per row, `release` naming the row's worker) and reconciles as a dry run, listing missing originals from the plan. `maintenance:repoint-cutout` goes through the state machine: `rederive` for ready/edited (status kept), `edit` for none/pending/failed; edit and rederive may carry a null key (the unkeyed set). Coordinator's decision: nullable `file.original_missing_since` means "nothing left to show" (original AND the row's nobg and thumb absent), set and cleared by reconciliation's plan in one owner-locked statement after the deletions (a failure is reported, costs no deletion; dry runs never mark), cleared by repoint too; 0062 extends `closet_sync_touch_photo` so the garment's revision moves. The photo-ref helpers answer no photo while marked; the API leaves `photo` out and adds `photoMissingSince`.
Consequence: no raw SQL for operators; a hand fix follows `src/db/AGENTS.md`'s recipe, which `after-restore.spec.ts` runs. Writes find a photo by `photo_id`, never through the ref helpers. Revived sessions and tokens are #908.

## 2026-11-14 — DATABASE_SSL is a mode, DATABASE_NAME the database (#694)

Why: `DATABASE_SSL=true` meant `rejectUnauthorized: false` (pgvault's self-signed certificate), so a managed Postgres over the internet ran TLS anyone on the path could impersonate, with no setting to fix it; `DATABASE_SCHEMA` named the database. 0.1 freezes the env names.
Decision: `DATABASE_SSL` is `verify` | `no-verify` | `off` (default), `DATABASE_SSL_CA` a PEM path for `verify` only (`databaseSslMode`, `sslOption`); `false` reads as `off`, `true` as `no-verify` with a boot warning. `DATABASE_NAME` wins over `DATABASE_SCHEMA`, a deprecated alias that warns. Warnings go through `loadConfig`'s `onDeprecated` (main.ts logs them; config cannot log).
Consequence: `true` flips to `verify` in the first release after homelab's compose stops using the old names (it sets `DATABASE_SSL: "false"` and `DATABASE_SCHEMA`, so production never relied on `true`); then `true` and the alias's warnings go with the next env cleanup. Transaction-mode poolers stay unsupported (docs/operations.md).

## 2026-11-14 — Production runs no autoheal; an unhealthy container is only marked (#696)

Why: the 2026-10-13 health entry said homelab "still has to add the `autoheal: "true"` label", and the runbook told an operator an unhealthy container restarts itself; production has no autoheal container, so an operator waited for a heal that never came.
Decision: no restarter, on purpose: the optional checks (`cron_jobs`, `cutout_queue`, `storage`) report what a restart does not fix, and a restart loop would cost the household the app. The runbook (Health, Permissions) now says an unhealthy container is only marked and is restarted by hand.
Consequence: supersedes that entry's autoheal consequence (homelab owes no label). Docker's restart policy still restarts a crash or a refused boot.

## 2026-11-14 — A boot failure reaches Bugsink, and shutdown fits docker stop's 10 s (#696)

Why: main.ts's error tracker was made inside createApp, so a boot that failed (refused migration, unmounted share, taken port) was logged but never captured, and a crash-looping container was visible only in its logs. The stop bounds summed to 15 s (timers) + 5 s + 10 s (cutout) + 2 s (tracker) against Docker's default 10 s grace, so a deploy during a slow push send was SIGKILLed before the cutout lease was released.
Decision: main.ts makes the tracker first (`createAppErrorTracker`, passed through `AppOptions.errors`) and its boot catch calls `reportBootFailure` (capture `source: process, origin: boot`, flush 2 s). The stop bounds are one budget (`src/shutdown-budget.ts`): timers 2 s, cutout listener 1.5 s + loop 2.5 s (the weather refresh settles inside the same 4 s), tracker 1 s: 7 s of bounded phases under an 8 s budget; `shutdown-budget.spec.ts` fails if they stop fitting. Shrunk rather than asking homelab for a `stop_grace_period`.
Consequence: shutdown waits 1.5 s for a timer run, then aborts it (`ScheduledJob`'s `run(signal)`, `JOBS_ABORT_GRACE_MS` 0.5 s more); a reminder run abandons its send and gives back the claims of messages the sender has not reported (`sendEach`'s `onReport`, `releaseReminderClaims`), so a stop mid-send loses no reminder (a send out but unreported may repeat once; the tag replaces it). Open push sockets still keep the process alive until they finish or Docker's SIGKILL at 10 s. The request drain, the pool's end and the exit are unbounded and live in the 2 s margin.

## 2026-11-14 — A run's abort gives back every unsent claim, whatever step it is in, and ends `interrupted` (#914)

Why: #912 honoured the abort only inside `sendAll`: aborted while composing, the run outlived the grace and its claims were lost; aborted before `sendEach`, every message still went out and then the claims were released (a repeat). Giving back also went through `markFailed`, so a deploy read as a `PartialFailure` plus a Bugsink event.
Decision: `sendDueReminders` owns the claims: every step after the claim (readBatch, each morning's compose, the send) is abortable and never starts once aborted; on `ShutdownAbort` it gives back every claim `sendEach` had not reported (`giveBack`) and sets `run.interrupted`; `sendDueRemindersWhole` then throws `JobInterrupted`, which `timeJob` records as `interrupted` (no capture) and the scheduler logs at info. Claiming stays before composing, not after: the winner of the claim is the server whose re-plan's swaps the reminder says, and the loser composes nothing.
Consequence: this supersedes the #696 entry's "abandons its send" wording: the whole run, not only the send, stops and gives back.

## 2026-11-14 — A restore ends every session through the sync epoch, and revokes every token (#908)

Why: a session dies only when its `pwf` stops matching the hash, and a restore brings the old hashes back with the sessions, tokens and subscriptions revoked after the dump; nothing in the dump can say what was revoked since.
Decision: the session cookie carries the restore epoch as `sep` (`restoreEpochSql`: `sync_epoch.epoch` once bumped, null before the first bump, so pre-#908 cookies stay valid until a restore), read in the account statements sign-in, registration and a password change already send, and compared by the resolver in its one lookup. `maintenance:after-restore`'s existing bump is therefore the session revocation; tokens go per user through `revokeAllTokensStatement`, push as before. Rejected: an `iat` floor (second granularity, and DB time against the JS clock) and a session table (more machinery than a rare restore justifies).
Consequence: one epoch now owns both cursors and sessions: anything else that ever bumps it signs the household out too, and a per-user "sign out everywhere" needs its own column beside `pwf`.

## 2026-11-14 — A reminder run's abort cancels its compose and re-plan, never abandons them (#920)

Why: #918 stopped *waiting* on an aborted compose (`guard`), but the compose ran on: `replanToday` could commit swaps and send the swap notice after its claim was given back, use the pool while shutdown closed it, and `markFailed` a run already logged; a give-back that threw still ended `interrupted`, losing reminders with no alert. Third round on this path, so the structure changed, not an edge.
Decision: the run's `AbortSignal` is threaded into `readBatch`, `morningPayload`, `replanToday` and the forecast reads (`ReadOptions.signal`: an ask stops waiting on the cache's refresh, which `settled()` still awaits); each checks it at its step boundaries, the re-plan before its commit too, so an abort throws and rolls back. The run awaits every step it started, then gives back; `interrupted` only when every unsent claim was released, else `lost` makes a `PartialFailure`. The send alone is still not awaited after the abort: web-push takes no signal and a device's socket timeout (10 s) exceeds the grace.
Consequence: a step the signal cannot cut (a statement in flight, the owner lock's 5 s wait, a swap notice already started) holds the run past the 500 ms grace; stop() then gives up on it as for any job, and its give-back may meet the ended pool, which is now a captured failure, not a silent loss.

## 2026-11-14 — A photo is marked missing when its original and its nobg are both gone (#917), superseding the thumb rule of the #653 entry

Why: the #653 rule marked a photo missing only when original, nobg and thumb were all absent, so a row left with a lone thumb drew a tile its pages cannot show (they render the original or nobg, never the thumb).
Decision: `file.original_missing_since` means "its pages cannot show it": the original AND the row's nobg are absent, whatever the thumb. Everything else in the #653 entry stands (set and cleared by reconciliation's plan, cleared by repoint, dry runs never mark).
Consequence: a lone thumb no longer keeps a photo unmarked; the photo-ref helpers and the API's `photoMissingSince` follow the new rule.

## 2026-11-14 — Each order email gets its own outcome (#693)
Why: the poll recorded an email only on success, so one that threw (a 9-digit JSON-LD price past `numeric(10,2)`, a NUL in a name) was re-read first every poll and stalled every later email, with a Bugsink event each poll; a newer email recorded first could also move the watermark past it.
Decision: `order_email` gets `status` (decided, failed, parked), `attempts`, `mailbox_failures` and `error_kind` (a SQLSTATE or name, never text; 0063). A read is caught per email; an email-level failure spends an attempt, 3 park it; a mailbox-level one (`JmapError.scope`: transport, auth, 5xx) fails the run and spends none, but 3 in a row on one email spend one. The watermark is the oldest failing email's arrival; every outcome upserts over a `failed` row only. The job fails while any email is failing, captured once per email (`PartialFailure.reported`). `parsePrice` and `plainText` bound what the extractor hands on to what the columns hold.
Consequence: a new failure path in the poll is classified by scope; a parked email is never retried (no UI yet: the row says why).

## 2026-11-14 — web-push and onnxruntime-node stay pinned; @sentry/node moves to 11 (#697)

Why: the runtime dependencies are brought current before the tag, except two whose newest release does not fit. web-push 4.0.0 is ESM-only (no CJS build, no types) and the build is CommonJS; onnxruntime-node 1.31.1 drops `bin/napi-v3` (binaries move to `napi-v6`, which the Dockerfile's per-arch pruning names) and only the real-model nightly can prove the model still cuts.
Decision: web-push stays `^3.6.7` (the range blocks 4; revisit with an ESM migration, not `require(esm)`); onnxruntime-node stays exactly 1.21.0 until a change that bumps it, fixes the Dockerfile path and passes the nightly. `@sentry/node` 11 ships a CJS build; `sendDefaultPii` is gone, so the tracker sets every `dataCollection` category off and `attachStacktrace: false`, keeping v10's events.
Consequence: `npm audit --omit=dev` is 0, so the pins cost no advisory; the reasons are in `src/push/AGENTS.md` and `src/cutout/AGENTS.md`.

## 2026-11-14 — @sentry/node returns to 10 (#934; supersedes the Sentry-11 part of the entry above)

Why: `@sentry/node` 11 hard-depends on `@sentry/bundler-plugins`, which pulls the `sentry` CLI (FSL-1.1-Apache-2.0, not OSI) into the AGPL production image; 11 fixed no advisory.
Decision: `@sentry/node` stays `^10` (the range blocks 11); the tracker sets `sendDefaultPii: false` again and leaves `attachStacktrace` at v10's default. The lockfile has no non-dev `sentry`, `@sentry/bundler-plugins`, `@sentry/cli` or FSL package.
Consequence: revisit when Sentry drops bundler-plugins from node's runtime deps or the owner settles licences (#638, #639); the reason is in `src/metrics/AGENTS.md`.

## 2026-11-14 — Order mail strikes count only an email's own fetch (#932, #933)
Why: #923 counted every mailbox-level failure as a strike on the email being read, so a 10-poll session 503, a 429 or a database blip parked healthy emails.
Decision: `failureScope` returns `email` (spends an attempt), `message` (that id's own body fetch: 5xx or wrong shape; a strike, 3 in a row spend one) or `outage` (everything else, every database error that is not a refusal of the email's values: no row written). Strikes left by the old rule are harmless: the next strike or outcome resets them.
Consequence: a new failure path picks one of the three in `failureScope` or `JmapError.scope`, nowhere else.

## 2026-11-14 — Old order-mail strikes are not reset by the next one (#938; supersedes the entry above's "harmless" sentence)
Why: `recordOrderEmailFailure` adds a strike to the stored `mailbox_failures`; it resets only when strikes spend an attempt, on an `email` failure or a decided outcome.
Decision: no data fix; an email left at 2 by the old rule spends one attempt on its first `message` strike, at most one early attempt of three.
Consequence: `src/web/wardrobe/order-mail.md` says so; a future counter change states what it does to stored values.

## 2026-11-14 — The order-mail poll fetches by allowlist, every redirect judged (#698)
Why: link selection was a deny list applied once to the unwrapped href, and redirects were followed unjudged, so a tracker in front of "Cancel this order" or a single-use sign-in link was requested from the home IP.
Decision: `judgeLink` fetches only https product paths (`isProductLink`) and at most 2 opaque trackers of a known shape whose anchor text names no action; the fetcher's `mayFollow` asks `isProductLink` of every redirect before it is resolved (`redirect-not-followed`). Fail closed: unknown product shapes, `?code=` and the "host that already yielded a product" bypass are refused.
Consequence: a shop whose product URLs fit no shape lists nothing; widen `isProductPath` or the tracker shapes with a spec, never the deny words alone. `src/web/wardrobe/order-mail.md`, Gotchas.

## 2026-11-14 — One bearer gate for /mcp and /api; refusals limited per address; no MCP batches (#667)

Why: `/mcp` parsed up to 1 MiB of JSON before its 401, had no limit for refused callers, and counted a 100-message batch as one request against `MCP_LIMIT`.
Decision: `createBearerGate` (`src/web/auth/bearer-gate.ts`) is both surfaces' onRequest token check. Refusals, and only refusals, count on one `BEARER_REFUSAL_LIMIT` per `request.ip` (30 a minute); past it a missing, malformed or unknown credential is a 429, a revoked or other-kind token still the 401 (`authenticateToken` now reads by hash alone and says which). A JSON-RPC batch is a 400 `-32600` before any server is built. `WWW-Authenticate` is set only by the error handler, for every bearer-surface 401.
Consequence: a valid token is never throttled by its address, so a household behind one IP keeps working; the cost is one indexed SELECT for each throttled `closet_` guess. Past the budget, 401 versus 429 tells a prober that a token existed and was revoked: accepted, since it needs the revoked token's value. A pre-2025-06 MCP client that batches is refused.

## 2026-11-14 — An untrusted proxy shows in readiness; refusals past the budget log one summary (#671, #940)
Why: a proxy missing from TRUSTED_PROXIES makes SIGN_IN_LIMIT and BEARER_REFUSAL_LIMIT household-wide and nothing said so; and an address over its refusal budget still wrote one warn per revoked-token 401 and per 429 (the NAS log freeze, #632).
Decision: `UntrustedProxyWatch` (root onRequest hook) flags a peer whose `request.ips` is just itself while it sent X-Forwarded-For: one `Security` warning per boot, and the optional `trusted_proxies` check down (readiness stays 200, no peer in the body). `RefusalSummaries` counts refusals past BEARER_REFUSAL_LIMIT per address and writes one line per window, found by the next refusal of any address or by capacity (1000), never a timer; the 401 for revoked and wrong-kind tokens is unchanged.
Consequence: a direct caller can set the header and flip the check, so it prompts a look and never refuses. An address that stops while no one else is refused leaves its summary unwritten. The homelab compose default (172.16.0.0/12) and README value (172.23.0.0/16 for linuxbox_web, 172.16.53.0/24) both cover Caddy and the gate; the live `.env` is what the check now confirms.

## 2026-11-14 — The order-mail poll fails closed: no opaque tracker is fetched, deny words match inside segments (#946)
Why: #939 still decided two cases by deny lists: an opaque click tracker was fetched unless its anchor text named a listed action word (the tracker records the click on that first request), and a product path was refused only when a segment equalled a deny word (`/products/123/cancel-order` passed). A deny list cannot fail closed.
Decision: an opaque tracker (known shape, no plain target in its query) is never fetched, so the tracker fetch path, `MAX_TRACKERS_PER_EMAIL`, the anchor-text check and the anchors' text window in `html.ts` are gone; a tracker carrying its target in the query is still unwrapped and judged on that target. Deny words match word tokens (split on non-letters) of every path segment, on every path.
Consequence: a shop that wraps every link in an opaque tracker is not auto-imported (the household uses "Add from a link"), and `/products/confirm-hoodie` is refused: both accepted false refusals. Widen `isProductPath` or unwrapping with a spec, never a longer deny list. `src/web/wardrobe/order-mail.md`, Gotchas.

## 2026-11-14 — Invite links expire after 7 days, edit links ask for the password, a new password ends open invites (#668)
Why: a borrowed phone or stolen cookie could mint a MANAGE link, accept it elsewhere and keep write access after the owner signed out and changed the password; open links never expired.
Decision: expiry is derived (`created_at` + `INVITE_LIFETIME_MS`, no column), compared with a cutoff from the app's clock in the accept's read and its write guard, the landing and Profile. A MANAGE create is step-up (`checksPassword`, `INVITE_LIMIT` = ACCOUNT_LIMIT for edit links only; a view link stays one tap). `createInvite` mints under the user's row lock against the session fingerprint, and `updatePasswordHash` deletes the user's unanswered invites in its revocation statement.
Consequence: no migration, so MANAGE invites minted before this deploy stay valid until their 7 days from `created_at` run out (older ones expired at deploy). Accepted shares are untouched by expiry and by a new password; the confirmation lists them for the owner to revoke.

## 2026-11-14 — HEIC decodes on one worker thread; link import never fetches HEIC; uploads get a per-user budget (#699)
Why: heic-decode ran libheif's WASM inline: a 50 MP photo stalled every request for seconds (and `/health/live` with it), link import let any site make the server decode up to six, and uploads had no per-user limit.
Decision: one `worker_threads` thread (`HeicDecoder`), not a pool and not the cutout's forked child: `terminate()` interrupts WASM, so the deadline needs no process, and a decode's cost is memory, so one at a time. At most 4 queued behind the running one, checked before buffering (a fifth is a 503) and after, so a body still sending holds no place; one 30 s deadline from enqueue covers wait and decode; a timeout, crash or heap OOM is the bad-photo 400 and the next decode gets a fresh thread. The fetcher refuses `image/heic`/`image/heif` and a `fetched` ImageSource is never HEIC. `PHOTO_UPLOAD_LIMIT` (60 a minute per user, pages and API on one checker) on routes marked `photoUpload`; a multipart body elsewhere is a 415.
Consequence: `resourceLimits` bounds the thread's JS heap, not libheif's WASM memory: the 64 MP pixel check stays the memory bound. A burst past four concurrent HEICs gets a retryable 503. The page audit paces its upload steps on the new budget.

## 2026-11-14 — A HEIC decode that ends at its deadline is the busy 503, not the bad-photo 400 (#961)
Why: #699's entry answered a timeout as the bad-photo 400, a permanent verdict on a photo that merely waited behind others (or was slow under load); the 64 MP pixel cap already bounds a hostile file.
Decision: 'timeout' joins 'busy' and 'closed' in `heicBusy` (`heic.ts`): 503 `SERVER_BUSY` with `Retry-After`. Undecodable bytes and a crashed thread stay 400; the byte and pixel caps stay 413/400.
Consequence: supersedes the timeout clause of the #699 entry above.

## 2026-11-14 — A public garment or outfit link is a state: none until Share, gone at Stop sharing (#669)
Why: every garment, outfit and file got a permanent `shareable_id` at insert and `/share` served it with no opt-in, so a link sent once, or collected by a former MANAGE grantee, stayed public for the row's life.
Decision: `garment.shareable_id` and `outfit.shareable_id` are nullable (0064); `setPublicShare` (`src/web/share/queries.ts`) is the one writer, one UPDATE under the owner lock (`coalesce`, so racing taps answer one id; Stop nulls it, a later Share mints a new one). Inserts and clones mint nothing. Garments: owner and MANAGE; outfits: owner. `/share` is a 404 for anything not shared, and `/file/watermark/:id` is keyed by the item's id, not the photo's (`SHARE_PREVIEW_CACHE` 300 s).
Consequence: existing ids were kept (the issue's migration note), so links already sent keep working and every pre-0064 garment and outfit reads "Shared publicly" until its owner stops it. Stop ends the /share page and the watermark; it does not end a shared outfit's garments' `/file/**` photo URLs a viewer saw (unguessable names, public by design), Open Graph previews other services already fetched, or `file.shareable_id` (no reader now; dropped in #960). API twins: #959.

## 2026-11-14 — A photo's file row is its showing row's owner's, held by composite foreign keys (#703)
Why: before #40 a MANAGE grantee's upload made a `file` row of the grantee's; their account deletion (file rows cascade from the user) emptied the owner's garment and unlinked its bytes. The code handled that (`ownersShowingPhotosOf`, a three-attempt relock) instead of making it impossible. Production's count was not checked (closet_db out of reach).
Decision: 0065 aborts on a photo shown by two owners, gives every photo row to its garment's, selfie's or look's owner, then replaces each single-column photo FK with one composite `(photo_id, owner_id)` to `file (id, created_by_id)` (new unique `file_id_created_by_id_unique`), ON UPDATE NO ACTION; garment's `ON DELETE SET NULL ("photo_id")` is hand-written (drizzle cannot say the column list; plain SET NULL would null owner_id), selfie and inspiration CASCADE. One FK per table, never two beside each other: their RI order is by name/OID, which a restore can flip. No owner lock: `created_by_id` moves no synced field. Account deletion locks only itself.
Consequence: no writer can make the cross-owner row again. drizzle-kit's FK introspection read composite columns unordered and crossed; `patches/drizzle-kit+0.31.11.dev.patch` now pairs them by position, or the drift test fails on these keys.

## 2026-11-14 — Sign out everywhere is a per-user session version; Secure follows the request (#700)

Why: signing out cleared only the browser's cookie; a copied session JWT lived a year, revocable only by a new password. The cookie was never Secure, so it crossed the plain-HTTP twin in clear and production alike.
Decision: `user.session_version` (integer, default 0), carried as the token's `sv` (absent = 0, so the deploy ended nothing) and compared by the resolver in its one statement. Sign out everywhere (password-gated, `ACCOUNT_LIMIT`, web-only) and a new password bump it in their locking UPDATE; one `revokeSignIns` follows both (device tokens and pushes; a password adds agent tokens and invites). The reissued cookie comes from the bump's RETURNING. Rejected: the audit's `sessions_valid_after` vs `iat` (second granularity, and JS's shifted clock against the stored one) and the restore epoch (global). Cookies get `Secure` per request from `request.protocol` (`sessionCookieOptions`).
Consequence: the acting session survives; production is Secure only once `TRUSTED_PROXIES` covers Caddy. Rolling back to an older image revives sessions ended by a bump (it ignores `sv`).

## 2026-11-14 — The coverage guard keys on `RowId` in a body or querystring, not on `ownerId` alone (#704)
Why: `takesId` saw a path parameter or a property literally named `ownerId`, so a new route taking `garmentIds` in its body passed CI with no matrix case; eight such routes had none.
Decision: `RowId` carries a `RESOURCE_ID` symbol key (not a JSON Schema keyword: ajv strict mode refuses `x-` unknowns, and openapi.json stays unchanged); `carriesResourceId` walks properties, items and unions of a route's body and querystring. Such a route needs a matrix case or an EXEMPT reason. TypeBox's Clone and CloneType keep symbol keys.
Consequence: a request's resource id must be `RowId`, never `Type.Integer()`, or the guard cannot see it. Exempt: `POST /outfits/ideas/feedback` (ids only echoed into a redirect), `POST /outfits/ideas/allow` (needs an avoided pair).
