# Closet container build and deploy audit (2026-09-25)

Repo HEAD audited: `6a5e64f` (closet), `b4da522` (homelab). Read-only: nothing was edited, committed, pulled or pushed. The only local actions were a throwaway worktree build (`closet-audit:tmp`), a pruned prototype image (`closet-audit:slim`), and three short local container runs. The images and the worktree were removed afterwards. `docker builder prune --filter until=1h` also cleared older local build cache. That is cache only, but other agents' next local docker builds will start cold.

Scope note: the homelab stack config (compose, Caddy, DSM, secrets) and backups belong to another agent. Issues in those areas get one line each in section 6.

Evidence sources:
- `docker/Dockerfile`, `.github/workflows/*`, `package.json`, `scripts/write-build-info.ts`, `src/build-info.ts`, `src/main.ts`, `src/app.ts`, `src/app.module.ts`, `src/dal/dal.module.ts`, `src/dal/migrations/postgres/*`
- `homelab/deploy.sh` (`deploy_stack`, `cmd_update`), `hosts/synology/{manifest,deploy-update.*,deploy-sync.*}`, `stacks/closet/docker-compose.yml`, `docs/upgrades.md`
- GitHub Actions API for `agandhi4/closet`. The `gh` default repo in this checkout resolves to upstream the original project's repository, so a bare `gh run list` shows upstream runs. Always pass `-R agandhi4/closet`.
- Local build: cold `--no-cache` build took 62 s on 16 cores (builder `npm ci` 26 s, runtime `npm ci --omit=dev` 28 s, the two in parallel).

---

## 1. Image

### Layout

| Aspect | Finding |
|---|---|
| Stages | 2: `node:22` builder (full Debian bookworm, about 1.1 GB) and `node:22-slim` runtime |
| Pinning | Floating tags, no digest. The image contains Node 22.23.3, while `.nvmrc` says 22.20.0. A base-image move rebuilds every layer and changes the runtime silently. No Renovate or Dependabot covers the Dockerfile or the actions (`.github/` has no `dependabot.yml`). |
| Layer order | Correct. `package*.json` + `patches/` go before `npm ci` in both stages, and source is copied after. A code-only commit re-pushes only dist, views and public (about 3.7 MB), so the NAS pulls a few MB per deploy. |
| `.dockerignore` | **Missing.** CI is unaffected: a fresh checkout has no node_modules, dist, data or coverage, and COPY is selective. A local `docker build .` from the dev checkout sends `node_modules`, `data/` (dev photos and sqlite), `coverage/`, `.git` and `playwright-report/` as build context. It is slow, and dev data passes through the daemon. |
| `GIT_SHA` | `build-args: GIT_SHA=${{ github.sha }}` → `ARG`/`ENV` in the builder only (it does not leak into the runtime) → `write-build-info.ts` slices 7 chars → `public/build.json` → `BUILD_INFO.assetVersion = <version>+<sha7>`, the `?v=` key on the year-long immutable assets. This works. Side effect: every commit busts every client's static cache, including docs-only commits. |
| `.env` | `COPY .env .` bakes the tracked `.env`, which today contains only `APP_NAME=Closet` and commented flags. Harmless now, but the compose comment about "placeholder VAPID keys baked in" is stale. A secret added to `.env` in future would ship in a public image layer. |
| User | **root** (uid 0). No `USER` line. |
| HEALTHCHECK | **None.** `/healthz` exists (204, no DB touch) but nothing probes it. |
| Entrypoint | `docker-entrypoint.sh` → `npm run start:prod` → `sh -c node dist/main` → node. Three processes, npm is PID 1. |
| NODE_ENV | `production` (ENV). |
| Arch | Builds only `linux/amd64`. The NAS is a DS920+ (Celeron J4125, x86-64-v2), so this is correct. The sharp linux-x64 prebuilt needs v2, which the CPU has. |

### Signal handling (measured)

- **Current image:** `docker stop` finishes in 0.85 s. npm forwards SIGTERM, and node has no handler, so it dies immediately with exit 1. The logs end with `npm error signal SIGTERM`.
  - No `enableShutdownHooks()` anywhere in `src/`. In-flight requests and uploads are cut, the pg pool is not closed, and pino's worker-thread transports can lose buffered lines.
  - Cut uploads leave orphan files, which the nightly reconciliation cleans up, so there is no photo loss. The shutdown is simply not graceful.
- **Trap:** switching CMD to `node dist/main` alone makes it worse. Measured on the prototype: node as PID 1 ignores SIGTERM, so the container waits the full 10 s and is then SIGKILLed (exit 137).
  - Any change to CMD must come with `init: true`/tini **and** `app.enableShutdownHooks()`.

### Size (docker history, uncompressed)

| Layer | Size |
|---|---|
| node:22-slim base | 247 MB |
| `npm ci --omit=dev` | **793 MB** |
| package-lock.json + package.json | 1.0 MB |
| dist / views / public | 1.9 / 0.4 / 1.35 MB |
| **Total** | **about 1.05 GB uncompressed, about 456 MB gzip** (most of it in the node_modules layer, which is about 375 MB gzip) |

### What is in `node_modules` (752 MB)

| Package | MB | Needed? |
|---|---|---|
| `@imgly/background-removal-data/dist` | 328 | Only `isnet_quint8` (44 MB) and the ort wasm (35 MB) are used, because `public/js/background-removal.js` sets `model: 'isnet_quint8'`. **`isnet` (176 MB) and `isnet_fp16` (88 MB) are dead: 264 MB, 64 chunk files.** |
| `@imgly/background-removal-data/node_modules/onnxruntime-web` | 92 | **Dead.** A nested duplicate. The app serves the top-level `onnxruntime-web` at `/modules/onnxruntime-web`. |
| `onnxruntime-web` (top level) | 93 | Needed (served to the client). Contains source maps and unused bundle variants. |
| `@img/sharp-*` | 33 | glibc 16 MB needed. **musl 17 MB dead** (Debian image). |
| `@aws-sdk` + `@smithy` | about 19 | Only for `FILE_STORAGE_TYPE=object`. Prod uses local storage, but keep them: the image is also the public upstream-style image, and CI exercises them. |
| `better-sqlite3` + `pg`/`knex` | about 15 | Both drivers. Keep them: sqlite is the default config and the integration-tier driver. |
| `*.map` across node_modules | 23 | Dead at runtime. |
| `libheif-js` | 9 | Needed (HEIC). |

Other contents:
- `dist/` ships **142 `.map` files and 54 compiled `*.spec.js`** (+ maps). `nest build` with SWC ignores the `exclude` list in `tsconfig.build.json`. None of them land in the `migrations/postgres` or `migrations/sqlite` directories the migrator globs; `postgres-indexes.spec.js` sits one level up. No dev deps are installed: the `@jest`, `@playwright` and `@typescript-eslint` dirs are empty scope dirs.
- No tests, coverage or docs directories beyond about 11 MB of package-internal docs and tests.

### Measured prototype

The prototype pruned the two unused models, the nested ort, sharp musl, all `.map` files, `dist/**/*.spec.js` and `package-lock.json`, with `USER node`.

| | Current | Pruned |
|---|---|---|
| App layer | 797 MB | **349 MB** |
| Total uncompressed | about 1.05 GB | about 596 MB |
| Total gzip | 456 MB | **168 MB (-63%)** |

The prototype still boots, and these endpoints still answer:
- `/healthz` 204
- `/bg-removal-models/resources.json` 200
- the isnet_quint8 chunk 200 (4 MB)
- `/modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm` 200

---

## 2. Build pipeline

### Job graph

Three independent workflows fire on every push to `main`, with **no `needs:` between them**:

| Workflow | What it runs | Real wall time (last 200 runs) |
|---|---|---|
| `docker-publish.yml` | build and push `:latest` + `:sha-<7>` | n=15, min 29 s, **median 239 s**, max 365 s |
| `github-actions-ci.yml` | one serial job: install/build 30 s, lint 9, unit 7, int 10, Playwright browsers 50, smoke 10, auth e2e 11, load 30, pg int 11, s3mock smoke 9, load 28, lighthouse 23 | n=11, min 198 s, **median 227 s**, max 289 s |
| `playwright.yml` | `npm ci` 32 s + browsers 54 s + full Playwright 44 s | about 140 s |

The publish often finishes **before** CI. Run 4c35046: publish done 19:41:08, CI done 19:41:53. Run 698ab03: publish done 18:11:04, CI done 18:09:06. So nothing orders them.

### Tests do not gate publish. It already happened today.

These pushes to main had failing CI and still published `:latest`, which the autoupdater then deployed:

| Commit | Failed CI step |
|---|---|
| `4dd2d63` | "start minio" |
| `67e2dce` | "start minio" |
| `3aede9a` | lighthouse |

The failures were infra, but the Postgres integration tier and the object-storage smoke **never ran** on code that reached prod.

### Publish step breakdown (warm run 36183614715, docs-only commit)

- Buildx setup 6 s, then `Build and push` 85 s, then post-buildx 13 s.
- Of the 85 s, **52 s is importing the builder's cached `npm ci` layer from the gha cache**, just so `RUN npm run build` (6 s) can run: `GIT_SHA` changes every commit, so that step always reruns.
- A lockfile change (run 36171157524): 309 s.

### Caching

| Where | State |
|---|---|
| buildx | `type=gha,mode=max`. Works, but mode=max caches the about 1 GB builder stage, which is what costs the 52 s. |
| CI job | No npm cache: `actions/setup-node@v1` without `cache: npm`, and `npm install`, **not `npm ci`**. So CI does not enforce the lockfile, although the Docker build does (the npm 11 lock gotcha in CLAUDE.md). |
| Playwright browsers | Installed twice per push (50 s + 54 s), uncached. |
| Duplication | The build is done 3 times per push: CI, playwright.yml's webServer, and Docker. |

### Tags and supply chain

- **Rollback tags exist:** `type=sha,prefix=sha-` gives `ghcr.io/agandhi4/closet:sha-6a5e64f` alongside `:latest`, confirmed in the run log. Semver tags come on `v*`. The compose file hardcodes `:latest`, so nothing consumes the sha tags.
- **Provenance:** `--attest type=provenance,mode=max`, the build-push-action default. Build args (only GIT_SHA) are recorded. **No SBOM** (`sbom: true` is not set). No cosign signing.
- **Secrets:** only `GITHUB_TOKEN` with `packages: write` / `contents: read`. That scoping is fine. CI test creds are inline dummies.
- **Action pinning:** none pinned by SHA.
  - `actions/checkout@master` is a branch, which is the worst case.
  - `actions/setup-node@v1` is deprecated (node12 runtime).
  - `harmon758/postgresql-action@v1` is a third-party mutable tag.
  - `adobe/s3mock:5` is a floating image.
  - `docker/*@v3/v5/v6` are mutable major tags with `packages: write` in scope.
  - The `npx npm-check-updates` step is informational noise.
- **Wasted deploys:** there is no `paths-ignore`, so docs-only commits (`6a5e64f`, `e3f0c28` today) rebuild, redeploy prod, and bust every client's asset cache.

---

## 3. Deploy

### How the autoupdater decides

`deploy-update.timer` fires hourly at `:40` and runs `deploy.sh update synology`. For each `# autoupdate` stack it does this:
1. `compose pull --quiet`.
2. Compares the image IDs its tags resolve to against the image IDs of all its containers, including stopped ones.
3. If they differ, it runs `deploy_stack`: `compose pull` then `compose up -d --build`.

Timing from push to prod: publish takes about 4 min, then the wait for the next `:40` averages about 30 min (max about 64 min). CLAUDE.md says "within the hour".

### Downtime per deploy

`up -d` recreates the container: stop, remove, create, start. There is no overlap.
- **Stop:** about 1 s (measured; not graceful).
- **Boot to listen:** 1.5 s measured locally with sqlite. Expect several seconds on a J4125 against pgvault, plus migration time.
- **Pull:** a few MB for code-only changes. When the lockfile or the gha cache changes, the NAS pulls the about 375 MB node_modules layer.

Result: about 5–15 s of 502s from Caddy each deploy, and longer with slow migrations. Acceptable for a household app, but there is no health gate at all.

### Migrations on boot

`AppModule.onModuleInit` awaits `orm.migrator.up()` **before `listen()`**. Postgres uses `transactional: true, allOrNothing: false`, so each migration gets its own transaction.

What happens on failure (verified by booting against an unreachable Postgres):
- A failure throws out of `NestFactory.create`, the floating `bootstrap()` rejects, and node exits 1 about 1 s after start.
- `restart: unless-stopped` then crash-loops with Docker's backoff.
- The old container is already gone, so **prod stays down** until someone acts.
- `deploy.sh update` reports success: it never waits for health.
- Migrations that committed before the failing one stay applied.

A slow migration means the port stays closed (502) for its whole duration. There is no `statement_timeout` or `lock_timeout` anywhere.

### CONCURRENTLY migrations

`Migration20260925181256` and `Migration20260925183958` correctly return `isTransactional() = false`, and `allOrNothing: false` keeps them out of a batch transaction. There is a real trap, though:
1. If a `CREATE INDEX CONCURRENTLY` fails mid-build (deadlock, cancel, container killed by a deploy or restart), it leaves an **INVALID** index.
2. On the next boot, `IF NOT EXISTS` sees the name and **silently skips** it.
3. The migration is then recorded as done, with a permanently invalid index. The planner ignores invalid indexes.

The file comment admits "idempotent once the invalid index has been dropped", which means a manual step nobody will know to do. `postgres-indexes.spec.ts` checks only the SQL text. The fix is one of these:
- Precede each create with `DROP INDEX CONCURRENTLY IF EXISTS` where `pg_index.indisvalid = false`.
- Assert `indisvalid` after the migration.

### Rollback

There is **no working one-command rollback**:
- Retagging a local older image as `:latest` on the NAS is undone within the hour: `update` pulls `:latest` from GHCR and sees the digest differ.
- Editing the compose file on the NAS to `:sha-xxxx` dirties the tracked file and breaks `deploy-sync`'s `git pull --ff-only`.

The durable paths today are:
- Re-point `:latest` in the registry from a workstation: `docker buildx imagetools create -t ghcr.io/agandhi4/closet:latest ghcr.io/agandhi4/closet:sha-<good>`, then `deploy.sh update synology` on the NAS. This takes about 1 min.
- `git revert` + push. This takes about 4 min to publish, plus up to 64 min.

Schema: migrations are forward-only and have no down path on boot. Rolling back across a migration runs old code on the new schema. The migrations so far are additive (indexes, tables), which old code tolerates.

---

## 4. Risks (ranked)

1. **Ungated auto-deploy.** Any push to main reaches prod within about 1 h whether CI passes or not. This happened three times today.
   - The tests exist and are good (both drivers, s3mock, auth e2e). They just are not in the path.
2. **Failed or slow boot equals an outage with no signal.** There is no HEALTHCHECK, no post-deploy health wait, no auto-rollback, and no alert.
   - A bad migration or config error crash-loops, and `deploy.sh update` logs "updated: closet".
3. **Silent INVALID index** after an interrupted CONCURRENTLY build (see 3). A deploy or restart during an index build is exactly how that interruption happens.
4. **Rollback reverts itself** unless it is done in the registry. The procedure is undocumented.
5. **Unpinned actions with `packages: write`**, `checkout@master`, and a third-party Postgres action.
   - A compromised or mutated action can publish `:latest`, which the NAS runs as root with the photo volume mounted.
6. **Root container** with write access to the photo bind mount. Any RCE (sharp, libheif or heic-convert on untrusted uploads) can delete or encrypt every photo.
   - This is the main "lose photos" vector in this scope. Backups are out of scope, so their coverage is not verified here.
7. **Floating base images**: `node:22` / `node:22-slim` with no digest. Supply chain and silent Node minor changes; nothing bumps them deliberately.
8. **Non-graceful shutdown**: in-flight uploads are dropped, which the reconciler recovers, and there is log loss. A naive CMD fix makes it a 10 s SIGKILL instead.
9. **CI does not use `npm ci`**, so lock drift is caught only by the publish.

---

## 5. Target pipeline

### Workflow shape

One workflow on push to main, with `concurrency: deploy-main`:

```
test (CI job, npm ci + cache, playwright browsers cached)  ─┐
playwright (full suite, reuses built artifacts)             ─┼─► publish (needs: [test, playwright])
                                                             ┘     tags: sha-<7>, then :latest last
paths-ignore: docs/**, **/*.md, AGENTS.md, CHANGELOG.md
```

### Concrete changes

| # | Change | Where | Cost | Effect |
|---|---|---|---|---|
| 1 | Merge the three workflows. `publish` `needs:` both test jobs. Keep `workflow_dispatch` for manual releases. | `.github/workflows` | 1 h. Adds about 4 min to commit→image (tests about 4 min, publish about 1.5 min, so about 6 min vs about 4 min today), which is dwarfed by the hourly timer. | Closes risk 1. |
| 2 | `paths-ignore` for docs/markdown on the publish path | same | 5 min | No prod restart or cache bust for docs commits (2 of today's last 3 pushes). |
| 3 | CI: `actions/setup-node@v4` with `cache: npm`, `npm ci`, cache `~/.cache/ms-playwright` keyed on the Playwright version | same | 30 min | About 30 s + about 50 s off each test job. Lock drift caught in CI. |
| 4 | Pin every action by SHA (`actions/checkout@<sha> # v4`), replace `checkout@master` and `setup-node@v1`, pin `adobe/s3mock` by digest. Add `.github/dependabot.yml` (github-actions + docker + npm, weekly). | same | 30 min, plus ongoing PR review | Closes risk 5. |
| 5 | Pin `FROM node:22.20.0-bookworm-slim@sha256:…` and the builder likewise. Match `.nvmrc`. Dependabot bumps them. | Dockerfile | 10 min | Reproducible builds; closes risk 7. |
| 6 | Prune in the image: a builder-side prune step before `COPY --from` (remove non-quint8 model chunks by reading `resources.json`, the nested onnxruntime-web, sharp musl via `npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc` or `rm`, `*.map`), and exclude `*.spec.*` and maps from dist. Needs a CI assert that the configured `model:` is still present in the image. | Dockerfile | 2 h incl. the assertion | Measured: **456 MB → 168 MB gzip, 1.05 GB → 0.6 GB on disk**. The lockfile-change pull on the NAS drops from about 375 MB to about 100 MB. |
| 7 | `USER node`, `tini` (or compose `init: true`), `CMD ["node","dist/main"]`, and `app.enableShutdownHooks()` in `createApp` | Dockerfile + `src/app.ts` | 1 h. One-time `chown -R 1000:1000 <the data directory>` on the NAS (coordinate with the stack owner). | Graceful stop under 1 s with requests drained; closes risk 6 for the image side. **Do not ship the CMD change without the init + shutdown hooks** (measured: 10 s SIGKILL). |
| 8 | `HEALTHCHECK --interval=30s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`. `/healthz` only answers after migrations and `listen()`, so it is the right readiness signal. | Dockerfile | 15 min | Enables 9. |
| 9 | `deploy.sh update`: after `deploy_stack`, wait up to N s for `health=healthy`. On failure, re-point the service to the previous image ID (`docker tag <prev-id> …:latest && compose up -d`), mark the stack as held (for example a `hosts/synology/.held/closet` file that `update` skips until cleared), and log or ntfy it. | homelab `deploy.sh` (cross-stack; coordinate with the stack owner) | 3–4 h | Closes risk 2. A failed deploy becomes about 1 min of downtime instead of an outage. |
| 10 | Rollback by variable: `image: ghcr.io/agandhi4/closet:${CLOSET_TAG:-latest}` in compose, with `CLOSET_TAG=sha-xxxx` in the gitignored `closet.env`. Document "registry retag with `imagetools create`" as the primary rollback in CLAUDE.md. | homelab compose (stack owner) + CLAUDE.md | 15 min | Closes risk 4. |
| 11 | Index migrations: drop invalid leftovers before `create … concurrently if not exists`, and add a CI assertion that `pg_index.indisvalid` is true for all indexes after `migration:up`. Also set a `lock_timeout` on the migration connection so a blocked DDL fails fast rather than holding boot. | `src/dal/migrations/postgres/*`, the integration harness | 1–2 h | Closes risk 3. |
| 12 | `sbom: true` on build-push-action; optionally keyless cosign signing | workflow | 10 min (+30 min for cosign) | Supply-chain record; a small add to publish time. |
| 13 | Add `.dockerignore` (node_modules, dist, data, coverage, .git, test-results, playwright-report, `.env.*`) | repo root | 5 min | Local builds from the dev checkout are fast and never see dev photos. |
| 14 | Timer: every 15 min instead of hourly (`OnCalendar=*:10/15`, still systemd-219-safe) | homelab | 5 min, 4× more registry polls | Mean push→prod goes from about 34 min to about 14 min. |
| 15 | Optional: build `dist` once in the test job and ship it to the image job as an artifact, so the runtime-only Dockerfile never restores the 1 GB builder cache | workflow + Dockerfile | 2 h | Publish goes from about 85 s to about 35 s warm. Only worth it after 1–13. |

### Expected end state

| Metric | Current | Target |
|---|---|---|
| Image size | 456 MB gzip / 1.05 GB | 168 MB gzip / about 0.6 GB (measured) |
| Commit → image | about 4 min | about 6 min, gated on green tests |
| Commit → prod | about 34 min mean | about 14 min mean with the 15-min timer |
| Deploy downtime | about 5–15 s | about 5–10 s (graceful stop, same recreate model) |
| Failed deploy | outage until noticed | auto-reverted in about 1–2 min, stack held, alert sent |
| Rollback | undocumented | `imagetools create` retag, or `CLOSET_TAG` in env: about 1 min |

Zero-downtime blue/green behind Caddy (two containers + `lb_try_duration`) is possible but not worth it for a two-person household app.

---

## 6. Out of scope, noted only (stack and backup owner)

- The compose file has no `logging:` block. The homeinfra `x-logging` anchor (json-file, 10m) is not applied to closet.
- `app.log` in `DATA_PATH` grows unbounded and is written by pino-pretty with `colorize: true`, so the file contains ANSI escapes.
- No `mem_limit` (finplat uses 512m). Measured idle RSS is 203 MB, and HEIC decoding buffers can spike.
- No `depends_on`/wait on pgvault (a separate stack). A pgvault restart during closet boot crash-loops closet until it recovers.
- `deploy.sh` never prunes images. Every lockfile change leaves about 800 MB of old image on the NAS.
- The compose comment about "placeholder VAPID keys baked into the image" is stale: `.env` now carries only `APP_NAME`.
- Hyper Backup coverage of `<the data directory>` is not visible in git and not verified here. The compose file says "back up as files".
