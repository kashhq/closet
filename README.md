# Closet

A private, self-hosted household wardrobe PWA. Catalog garments with photos (backgrounds removed automatically), compose outfits, plan them on a calendar, and share a wardrobe between users.

A fork of [Libre Closet](https://github.com/lazztech/libre-closet) by Lazztech LLC, licensed under the AGPL-3.0.

---

## Quick start

Closet needs PostgreSQL 18, the version every test tier runs; the example below brings its own. Give the container about 5 GB of memory: the background-removal model (940 MB, downloaded on first boot into `closet_models`) runs in a child process outside Node's heap.

<!-- smoke:quickstart -->

`scripts/smoke-image.sh` runs the block below as written (the image name, the two `<...>` placeholders and the host port aside) and waits for `/health/ready`.

```yaml
services:
  closet:
    image: ghcr.io/kashhq/closet:latest
    ports:
      - '3000:3000'
    volumes:
      - closet_data:/app/data
      # The model is downloaded once; without this volume every `up -d` after a pull downloads it again.
      - closet_models:/app/models
    environment:
      # Required: signs the session cookies. openssl rand -hex 32
      ACCESS_TOKEN_SECRET: '<secret>'
      # The household's time zone: decides "today" on the calendar.
      APP_TIMEZONE: America/New_York
      # Installable app, offline shell and push reminders. Needs HTTPS: see "Behind HTTPS" below.
      PWA_ENABLED: 'false'
      # Behind HTTPS, set PWA_ENABLED to 'true' and add (SITE_URL must be https://, the VAPID subject):
      # SITE_URL: https://closet.example.com
      # TRUSTED_PROXIES: <your reverse proxy's address>
      # Generate the pair with: npx web-push generate-vapid-keys
      # PUBLIC_VAPID_KEY: '<public key>'
      # PRIVATE_VAPID_KEY: '<private key>'
      DATA_PATH: /app/data
      DATABASE_HOST: postgres
      DATABASE_NAME: closet
      DATABASE_USER: closet
      DATABASE_PASS: '<password>'
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: closet
      POSTGRES_PASSWORD: '<password>'
      POSTGRES_DB: closet
    volumes:
      # Postgres 18 images keep the version's data directory under this path.
      - closet_pg:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U closet -d closet']
      interval: 5s
      retries: 10
    restart: unless-stopped

volumes:
  closet_data:
  closet_models:
  closet_pg:
```

**Behind HTTPS.** The installed app, its offline shell and push need a secure origin. With `PWA_ENABLED: 'true'` the server refuses to start unless `SITE_URL` is an `https://` URL and both VAPID keys are set, and it names the missing key. Set `TRUSTED_PROXIES` to your reverse proxy so the client address is read correctly.

Open [http://localhost:3000](http://localhost:3000) and register an account: login is always required. Once everyone in the household has signed up, set `DISABLE_REGISTRATION=true`.

### Upgrading

Closet applies its database migrations at boot, so starting a newer image is the upgrade. Migrations only go forward: there is no downgrade. To go back, stop Closet and restore the **pair** taken before the upgrade, the Postgres dump and the `DATA_PATH` backup together (the nightly storage reconciliation deletes photos no database row references, so a mismatched pair loses photos). An older image on a newer database is unsupported; the known cases are in [docs/operations.md](docs/operations.md).

Pin an immutable image tag, not `latest`, so a pull never upgrades you unannounced: `ghcr.io/kashhq/closet:sha-<7>`, the 7-character commit shown as `version` by `/health/ready` and the About page. Only the 10 newest `sha-*` tags are kept, so move the pin forward from time to time. Before changing the pin, take a database dump and a `DATA_PATH` backup.

One-off steps after an upgrade, each needed once, by the release that introduced it:

- **Past #373 (trimmed thumbs).** Run `docker exec closet npm run maintenance:retrim-thumbs -- --dry-run`, then again without `--dry-run`, so existing cutouts get a thumb trimmed to the garment ([details](docs/operations.md)).
- **Renamed database settings (#694).** `DATABASE_SCHEMA` is now `DATABASE_NAME`; the old name still works, with a warning at boot, and is ignored when both are set. `DATABASE_SSL` takes a mode: `DATABASE_SSL=true` boots as `no-verify` with a warning, and a later release reads it as `verify`, so set `no-verify` (or `verify`, with `DATABASE_SSL_CA` for a private CA) now.
- **Moving from the Postgres 17 example (#738).** Postgres 18 keeps its data under `/var/lib/postgresql`, so pointing the quick-start block at a 17 volume starts an empty cluster and Closet migrates into an empty database: your wardrobe looks gone. To keep your data:

1. On the old stack, run `docker compose exec postgres pg_dump -U closet -d closet > closet.sql`, then stop it.
2. Start only the database of the new one: `docker compose up -d postgres`. A full `up` would start Closet, which migrates the empty cluster first and makes the restore collide with what it created.
3. Restore with `docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U closet -d closet < closet.sql`.
4. Start Closet: `docker compose up -d`.

---

## Connect your Claude

Closet is an MCP server: your own Claude (Claude Code, Claude Desktop) can search your wardrobe, add pieces from product links, build outfits and capsules, plan days, keep track of wears and laundry, and compare your closet with a wardrobe shared with you to talk through what to buy next.

1. In the app, open **Profile › Agent Access** (`/auth/tokens`) and create a token; it asks for your password, since a token keeps working after you sign out. A token only reads unless you tick **Can make changes** (needed for Muse's suggestions, outfits and plans), and **My wardrobe only** keeps it out of wardrobes shared with you; neither changes after, so make a new token for more. The token is shown once, and the page also shows the command below with it filled in.
2. Add the server to Claude Code:

   ```bash
   claude mcp add --transport http closet https://<your SITE_URL host>/mcp \
     --header "Authorization: Bearer <token>"
   ```

   In Claude Desktop, add the same URL and header as a remote MCP server.

The token acts as you, shares included: a wardrobe shared with you read-only stays read-only. Tools that write say so, and none deletes anything. Revoke a token on the same page; changing your password revokes every token. The endpoint is rate-limited per token. If the app is reachable only on a private network, an agent outside it needs a public endpoint for `/mcp` alone: a reverse proxy that forwards `POST /mcp` with the same `Authorization: Bearer <token>` header (Streamable HTTP, JSON answers) and answers 404 to everything else, so the app's pages stay private. Anything that can send a bearer header can use it; Claude's hosted connectors (claude.ai) that need OAuth still cannot, because OAuth is not built.

### Styling with an agent

An agent connected this way (Claude, or a styling agent such as Muse) suggests what to buy and how to wear it, as wishlist garments and outfits you decide on in the app.

1. **Connect** it as above, with a token of its own named for it (`Muse`): the name is how the app tells you who suggested what.
2. **The workflow** the server describes to the agent: it starts every conversation by reading what you decided since it last asked (`get_suggestion_feedback`: your choices, purchases and the outfits you loved or declined, with every reason and note) and what stands where (`list_suggestions`). It reads your style profile, your whole closet (with how often each piece is worn), your sizes per brand and photos where it needs them, and checks what your closet already covers (`get_closet_coverage`), so it proposes only real gaps and treats pieces marked replace soon as gaps. For each need it opens one on your wishlist ("A navy blazer", with a budget and why) and adds two to five real products as its options (`suggest_garment`), each with a note, its rank, the price and the size to buy. Then it proposes outfits that mix your clothes with its options (`suggest_outfit`), and ends the round (`finish_round`).
3. **What you see in the app**: a card on **Today** ("Muse: 3 outfits, 7 pieces to consider") while anything of its latest round waits, and a notification on each device where you turned on **When Muse finishes a round** (Profile, notifications); the needs and their options in **Wardrobe › Wishlist** (choose **This one**, or **Not for me** with a reason), the outfits first on **Outfits** (**Love**, **Save**, or **Not for me**), and the options in Styling with **Include picks** on.
4. **Your decisions are its feedback**: a reason you give is what it reads next time, and it never proposes again a need, product or outfit you set aside (the app refuses it). Buying stays yours: an agent never buys, marks anything owned or deletes; you tap **Bought it**, and it later learns how often you wear what you bought.

---

## Configuration

`.env` contains committed defaults. Override any value via a `.env.local` file (gitignored) or by passing real environment variables to Docker.

| Variable                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Default                                 | Example                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| `APP_NAME`                | Display name shown in the UI and navbar                                                                                                                                                                                                                                                                                                                                                                                                                                 | `Closet`                                | `My awesome Closet manager`      |
| `APP_TIMEZONE`            | The household's IANA time zone: what "today" is on the calendar and which week opens by default                                                                                                                                                                                                                                                                                                                                                                         | `America/New_York`                      | `Europe/Berlin`                  |
| `ICON_NAME`               | Icon file under `public/assets/` used for share previews and the photo watermark; the manifest, the install dialog and the home-screen icon use its `<name>-192.png` and `<name>-512.png` siblings, which must be there too                                                                                                                                                                                                                                             | `icon.png`                              | `my-icon.png`                    |
| `SITE_URL`                | Public origin, used for absolute links in share previews and as the Web Push (VAPID) contact, which must be `https:` when `PWA_ENABLED=true`                                                                                                                                                                                                                                                                                                                            | `http://localhost:3000`                 | `https://closet.example.com`     |
| `DATA_PATH`               | Directory for uploaded files                                                                                                                                                                                                                                                                                                                                                                                                                                            | `./data`                                | `./closet-data`                  |
| `DISABLE_REGISTRATION`    | Disallows user sign ups when true                                                                                                                                                                                                                                                                                                                                                                                                                                       | `false`                                 | `true`                           |
| `PASSWORD_HASH_ROUNDS`    | bcrypt cost of every password hash and sign-in comparison; below 12 only outside `APP_ENV=production` (the test tiers run at 4)                                                                                                                                                                                                                                                                                                                                         | `12`                                    | `4`                              |
| `PWA_ENABLED`             | Enable service worker, PWA install prompt and Web Push notifications                                                                                                                                                                                                                                                                                                                                                                                                    | `false`                                 | `true`                           |
| `WATERMARK_ENABLED`       | Composite the app icon onto share-link preview images                                                                                                                                                                                                                                                                                                                                                                                                                   | `false`                                 | `true`                           |
| `ACCESS_TOKEN_SECRET`     | Signs session tokens (required, at least 32 characters; the server refuses to start without it)                                                                                                                                                                                                                                                                                                                                                                         | -                                       | `<openssl rand -hex 32>`         |
| `TRUSTED_PROXIES`         | Comma-separated IPs/CIDRs of reverse proxies whose `X-Forwarded-*` headers are trusted (login rate limits, the cross-site request check, canonical URLs). Behind a reverse proxy it must include the proxy's address                                                                                                                                                                                                                                                    | `127.0.0.1,::1`                         | `172.16.0.0/12`                  |
| `LOG_LEVEL`               | pino level for the console and `LOG_FILE` (`trace` … `fatal`, or `silent`)                                                                                                                                                                                                                                                                                                                                                                                              | `info`                                  | `debug`                          |
| `LOG_FILE`                | Opt-in: also write JSON lines to this file, for hand debugging (unset: stdout only, which the container log and Loki read). Written asynchronously; a write error is logged to stdout once and the file stops. Never under `DATA_PATH` (`/file` serves it and photo backups carry it): the boot refuses it Must point into a mount writable by uid 1000 (`docs/operations.md#permissions`); a missing directory is not created: the file is skipped with one error line | unset                                   | `/app/logs/debug.log`            |
| `LOG_FORMAT`              | The shape of those lines: `json`, one object per line with `ts`, `level`, `version`, `logger` and a request's `request_id` (a job's `job_id`) (production; Loki reads it), or `text`, pino-pretty for a terminal (`npm run start:dev` sets it)                                                                                                                                                                                                                          | `json`                                  | `text`                           |
| `APP_ENV`                 | Where this process runs, as the error tracker's `environment`: `production`, `dev` (`npm run start:dev` sets it) or `gate` (the image smoke test). Never derived from `NODE_ENV`                                                                                                                                                                                                                                                                                        | `production`                            | `dev`                            |
| `DATABASE_HOST`           | Postgres host (required)                                                                                                                                                                                                                                                                                                                                                                                                                                                | -                                       | `192.0.2.10`                     |
| `DATABASE_PORT`           | Postgres port                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `5432`                                  | `9867`                           |
| `DATABASE_USER`           | Postgres user (required)                                                                                                                                                                                                                                                                                                                                                                                                                                                | -                                       | `postgres`                       |
| `DATABASE_PASS`           | Postgres password (required; may be empty for trust auth)                                                                                                                                                                                                                                                                                                                                                                                                               | -                                       | `7yfhcn2349cr32f`                |
| `DATABASE_NAME`           | Postgres database name (required; `DATABASE_SCHEMA`, its deprecated alias, is read when this is unset)                                                                                                                                                                                                                                                                                                                                                                  | -                                       | `closet`                         |
| `DATABASE_SCHEMA`         | Deprecated alias of `DATABASE_NAME` (see Upgrading)                                                                                                                                                                                                                                                                                                                                                                                                                     | -                                       | `closet`                         |
| `DATABASE_SSL`            | TLS to Postgres: `verify` (checks the server certificate and host name), `no-verify` (encrypts but trusts any certificate: only on a network you trust) or `off`. `true` still boots, as `no-verify` with a warning, until a later release makes it `verify`; `false` is `off`                                                                                                                                                                                          | `off`                                   | `verify`                         |
| `DATABASE_SSL_CA`         | PEM file of the CA that signed the Postgres certificate, for `verify` against a private CA (default: the system CAs)                                                                                                                                                                                                                                                                                                                                                    | -                                       | `/run/secrets/pg-ca.pem`         |
| `MAINTENANCE_ENABLED`     | Run the nightly storage reconciliation (03:00 in `APP_TIMEZONE`); `npm run maintenance:reconcile` runs it once regardless                                                                                                                                                                                                                                                                                                                                               | `true`                                  | `false`                          |
| `MAX_HEIC_BYTES`          | Largest HEIC/HEIF upload accepted; HEIC is decoded in memory before resizing                                                                                                                                                                                                                                                                                                                                                                                            | `41943040` (40 MB)                      | `20971520`                       |
| `CUTOUT_ENABLED`          | Background removal. `false`: no model is downloaded or run (it peaks near 3 GB, too much for a 1-2 GB host), uploads keep their original with the mask editor's pencil, and `/health/ready` reports `cutout_queue` as `disabled`                                                                                                                                                                                                                                        | `true`                                  | `false`                          |
| `MODELS_PATH`             | Where the background-removal model (940 MB) is kept; downloaded there at boot when missing and checksum-verified. A local disk, not NFS                                                                                                                                                                                                                                                                                                                                 | `./models` (`/app/models` in the image) | `/app/models`                    |
| `CUTOUT_THREADS`          | CPU threads the background-removal model uses                                                                                                                                                                                                                                                                                                                                                                                                                           | `4`                                     | `8`                              |
| `CUTOUT_POLL_SECONDS`     | How often an idle cutout queue looks for photos no notification announced (a backstop: writes notify it at once)                                                                                                                                                                                                                                                                                                                                                        | `60`                                    | `30`                             |
| `WEATHER_ENABLED`         | Weather forecasts (Open-Meteo, fetched by the server for each user's location rounded to about 1 km) on the page headers, the calendar and the MCP tools. `false` fetches nothing and stores no location                                                                                                                                                                                                                                                                | `true`                                  | `false`                          |
| `METRICS_ENABLED`         | Prometheus metrics at `GET /metrics` (request, job, push, MCP and device timings) for a scraper on the container's network; a request that came through a proxy (`X-Forwarded-For`) gets a 404 there. Pages then send their timings to `POST /metrics/vitals`                                                                                                                                                                                                           | `false`                                 | `true`                           |
| `APP_VERSION`             | The release, set by the image itself (the 7-char sha, baked in by CI); `/health/ready` reports it as `version`. Never set it in compose or `.env`: the image is its only source                                                                                                                                                                                                                                                                                         | the image's                             | `1a2b3c4`                        |
| `SENTRY_DSN`              | Error tracking: the DSN of a Sentry-compatible tracker (the homelab's Bugsink). Server errors (5xx, failed jobs, push sends, MCP tools) and the signed-in pages' script errors (`POST /errors/client`) are sent there, scrubbed of cookies and tokens. Empty: off, nothing sent and no script on pages                                                                                                                                                                  | empty                                   | `http://<key>@tracker.example/3` |
| `ORDER_MAIL_JMAP_TOKEN`   | Order email import: a read-only Fastmail API token (Email scope) for the account order emails are forwarded to. Product links in them become a "From your orders" review list. Empty: off, nothing polled. See `docs/operations.md`                                                                                                                                                                                                                                     | empty                                   | `fmu1-…`                         |
| `ORDER_MAIL_SENDERS`      | The owner's own addresses, comma-separated: only mail they forwarded, with DKIM or SPF passing, is read. Required with the token                                                                                                                                                                                                                                                                                                                                        | empty                                   | `me@gmail.com,me@work.com`       |
| `ORDER_MAIL_OWNER`        | The sign-in email of the closet account the imported items belong to. Required with the token                                                                                                                                                                                                                                                                                                                                                                           | empty                                   | `me@gmail.com`                   |
| `ORDER_MAIL_POLL_MINUTES` | How often the order mail account is checked (1-60)                                                                                                                                                                                                                                                                                                                                                                                                                      | `5`                                     | `10`                             |
| `PUBLIC_VAPID_KEY`        | Web push - required when `PWA_ENABLED=true`, generate with `npx web-push generate-vapid-keys`                                                                                                                                                                                                                                                                                                                                                                           | -                                       | `<from web-push>`                |
| `PRIVATE_VAPID_KEY`       | Web push - required when `PWA_ENABLED=true`, generate with `npx web-push generate-vapid-keys`                                                                                                                                                                                                                                                                                                                                                                           | -                                       | `<from web-push>`                |

Generate the session signing secret (anyone who knows it can sign in as any user, so never reuse an example value; changing it signs everyone out):

```bash
openssl rand -hex 32
```

Generate VAPID keys:

```bash
npx web-push generate-vapid-keys
```

---

## Development

### Prerequisites

- Node (see `.nvmrc`, Node 22, an exact version: devkit's toolchain-check holds the
  Dockerfile and workflows to it) - install via [nvm](https://github.com/nvm-sh/nvm)
- Docker, for Postgres. Development and tests use the shared local
  **pgvault-dev** (a sibling `../pgvault-dev` compose project: Postgres on
  `localhost:5432`, superuser `postgres`, trust auth).

```bash
nvm install && nvm use
npm install
make install                                      # git hooks, once per checkout or worktree
(cd ../pgvault-dev && docker compose up -d --wait)
docker compose -f ../pgvault-dev/docker-compose.yml exec postgres \
  psql -U postgres -c 'create database closet_db'   # once
cat > .env.local <<ENV                              # gitignored
ACCESS_TOKEN_SECRET=$(openssl rand -hex 32)
DATABASE_HOST=localhost
DATABASE_NAME=closet_db
DATABASE_USER=postgres
DATABASE_PASS=
ENV
npm run start:dev
```

The integration tier and the page audit never touch `closet_db`: each run
creates scratch databases on the server named by `TEST_DATABASE_URL`
(default `postgres://postgres@localhost:5432/postgres`, pgvault-dev) and drops
them afterwards.

### Scripts

```bash
npm run start:dev       # tsc --watch + node --watch + tailwind --watch
npm run build           # clean, tsc -p tsconfig.build.json (type-checked) to dist/, then generate:
                        # build-info, vendor, Tailwind, the service worker, precompress
npm run start:prod      # node dist/main.js
npm run start:test      # the build with background removal stubbed (test/support/test-server.ts: what Playwright
                        # and Lighthouse start; no model download)
npm run test            # Vitest unit projects (unit, unit-new-york): mocked DB/fs, verifies wiring
                        # (test:watch reruns on change; test:debug waits for an inspector on :9229)
npm run test:int        # Vitest integration tests (real app in-process, scratch Postgres database per
                        # file, cloned from the migrated template; no build): the default place for
                        # behavior assertions
npm run test:all        # both Vitest tiers in one run
npm run test:e2e        # build, then Playwright end-to-end (all browsers, ten critical-path scenarios;
                        # make screenshots for the shots); starts start:test on :3000 unless one is
                        # running, and the PWA scenarios skip unless PWA_ENABLED (test/AGENTS.md)
npm run test:cov        # both Vitest tiers with v8 coverage (coverage/); the plan's metrics ratchet holds lines and branches
npm run audit:pages     # every page and action measured as the demo persona, see below
npm run generate:icons  # regenerate public/assets/icon.png, icon-192.png, icon-512.png and favicon.ico from icon.svg
npm run lint            # eslint --fix over src, test, scripts; lint:check is the no-fix, cached gate
npm run format          # prettier --write (never on a bare directory); format:check is the cached gate
npm run typecheck       # tsc over app, tests and scripts, then the service worker (~3 s cold)
npm run check           # format, lint, types, unit + integration in parallel (~80 s on 16 cores;
                        # check:static is the first three; `precommit` is an alias). The plan runs
                        # the two halves as the jobs make ci-quick and make ci-db
npm run verify:push     # build + Chromium Playwright (main is verified by the plan's e2e job at deploy)
npm run precommit:full  # check + verify:push + page audit + lighthouse (minutes)
npm run maintenance:reconcile [-- --dry-run] [--force]
                        # one storage reconciliation pass (needs `npm run build`; see below)
npm run maintenance:retrim-thumbs [-- --dry-run]
                        # trim every cutout's thumb to its garment, once after upgrading past #373; see Upgrading
                        # (needs `npm run build`; on the NAS: docker exec closet npm run ...)
npm run user:set-password -- <email>
                        # set a locked-out user's password (needs `npm run build`; see below)
npm run cutout:fetch-model
                        # download or verify the background-removal model into MODELS_PATH
                        # (needs `npm run build`; see Background removal)
```

The server downloads the model (940 MB) into `MODELS_PATH` at its first boot,
so `start:dev` and `start:prod` fetch it once into `./models`; point
`MODELS_PATH` at an existing copy in `.env.local` to skip that. `npm run
test:int` includes one test with the real model; it runs only when
`MODELS_PATH` (or `./models`) holds it and is skipped otherwise (CI never
downloads it).

### The gate's jobs and the git hooks

`scripts/ci/gate_plan.sh` is the plan: the publisher host runs every job of it on
main (`devkit/bin/check_tree.sh`, at most once per 3 h window) before it ships,
and a red main files a `main-red` issue. The Makefile targets are thin callers of
the npm scripts (`ci.yml`'s manual jobs call the same ones), and each brings its
own throwaway Postgres 18 container, so none needs pgvault-dev.

```bash
make ci-deps ci-quick         # npm ci; ci-guards, secrets-check, ci-lint, ci-typecheck
make ci-unit                  # the unit projects
make ci-db                    # test:cov on Postgres 18 (coverage feeds the metrics ratchet)
make ci-e2e                   # build + Chromium Playwright, PWA on, a random PORT
                              # (each of the three reports against its budget, 60/110/180 s, and a floor)
make ci-metrics               # the metrics report (never fails, not in the plan): scripts/ci/metrics.conf
                              # vs docs/metrics/ratchet.json
make metrics-tighten          # a cleanup round keeps its gains in docs/metrics/ratchet.json
make ci-image ci-smoke CI_BUILD_VERSION=<v>   # build the image and boot it (docs/operations.md)
make review PR=<n>            # one local review round (when Codex is out of budget)
make merge PR=<n>             # squash-merge once the review rounds allow it
```

devkit is not in the tree: `.devkit-rev` pins its commit and `.devkit-bootstrap.sh`
materializes it into the gitignored `devkit/` before every `make` target and hook
(`make devkit-sync` bumps the pin). The git hooks are devkit's templates in
`.githooks/`: `make install` once per checkout or worktree materializes `devkit/`,
sets `core.hooksPath`, and `make hooks-check` reports a repoint. Their steps are `scripts/ci/hooks.conf` (ci-quick plus ci-unit, split
between pre-commit and pre-push); neither needs Postgres or a browser.

### Locked out

There is no password reset by email. Whoever runs the server sets a new
password for an account with `npm run user:set-password -- <email>` (in a
container: `docker exec -it closet npm run user:set-password -- <email>`). It
asks for the password twice without echoing it (or reads one line from piped
stdin), applies the registration rules, and signs out every existing session
of that account. An unknown email changes nothing and exits with status 1.

Neither this nor the storage maintenance command migrates the database: they
refuse, with exit status 1, a database the running build has not migrated
yet. Start the server of that build first (it migrates at boot).

### Storage maintenance

Every photo is a set of files in storage (`<uuid>.webp` plus `-nobg` and
`-thumb` variants) and one `file` row. Deleting a garment or an account
removes both, and a nightly job (03:00 in `APP_TIMEZONE`, `MAINTENANCE_ENABLED`)
keeps them describing each other: stored photo sets older than a day with no
row are deleted, rows older than a day that no garment references are deleted
with their files, and rows whose original is missing are logged. Run it by
hand, on the NAS with `docker exec closet npm run maintenance:reconcile`, or
locally after `npm run build`; `-- --dry-run` only reports.

A run that would delete anything while the `file` table is empty, more than
25 photo sets, or more than a fifth of the stored ones (once it is more than 5) deletes nothing: it logs why, reports `refused` and exits with status 3.
That is the database and the disk disagreeing wholesale (a restore, the wrong
database), not stray uploads. Check with `-- --dry-run`, then
`-- --force` deletes anyway.

### Background removal

Every garment photo gets a cutout (its background removed) on the server.
The phone first shrinks a large photo to 1600 px (JPEG) and sends only the
photo. The server queues it (the garment page shows "Removing background…"
and swaps the cutout in when it is ready, or offers "Try again" if it
failed) and runs
[BiRefNet 512x512](https://huggingface.co/onnx-community/BiRefNet_512x512-ONNX)
(MIT) with onnxruntime on the CPU, in a child process, one photo at a time:
about 3 s a photo on a recent 8-core CPU (7 s for the first after a start or
15 idle minutes, which loads the model) and up to ~3.5 GB of RAM while the
model is loaded. It needs a CPU with AVX2 or better. A photo that takes over
60 s is failed; failed ones are retried nightly (03:00 in `APP_TIMEZONE`) up
to three runs. The mask editor (the pencil on the photo) edits the cutout,
and an edited cutout is never replaced by the server's.

With `CUTOUT_ENABLED=false` none of this runs: no download, no model process,
every upload stays as taken (cutout `none`), and the pencil still draws a mask by hand.

The model is not in the image. It is downloaded into `MODELS_PATH` at boot
when it is not there yet, from a pinned URL, and refused unless its SHA-256
matches. Give it a local volume so it is fetched once; to seed or repair it:

```bash
docker exec closet npm run cutout:fetch-model   # download or verify; prints the path
```

Photos stored before background removal moved to the server (it ran in the
browser until 2026-09-26) keep the cutouts the browser made.

### Page audit

`npm run audit:pages` builds the app, boots it in process on a scratch
Postgres database with the demo persona seeded, and measures every page,
fragment, action, MCP tool and background job as Theo: server time p50/p95,
SQL statements and rows per request, response bytes. It writes
`scripts/results/audit.md` and `.json`; `-- --compare docs/perf/baseline.json`
prints what changed against the committed baseline. How a page PR uses it:
[docs/perf/README.md](docs/perf/README.md).

### Migrations

The schema is `src/db/schema.ts` (Drizzle). The app applies the migrations in
`drizzle/` on every boot, so a deploy is the migration.

```bash
# After editing src/db/schema.ts: writes drizzle/NNNN_<name>.sql and its
# snapshot. Needs no database. Read the SQL before committing it.
npx drizzle-kit generate --name <what-changed>
```

Databases created before Drizzle took over (built by MikroORM's migrations)
are adopted on their first boot: the runner checks that the last MikroORM
migration was applied and records the Drizzle baseline without running it.

A migration that converts data refuses to guess: it fails the boot, changes
nothing, and names what to fix. `0004_garment_web` (garment colours become a
fixed set, the acquisition date a plain date) stops on a colour outside the
built-in set (older builds let people type their own), an acquisition date
that is not UTC midnight, a blank category, or a share id two rows hold. To
check a database before upgrading:

```sql
SELECT DISTINCT unnest(string_to_array(color, ',')) FROM garment;  -- built-in names only
SELECT count(*) FROM garment
 WHERE (date_aquired AT TIME ZONE 'UTC')::time <> '00:00'
    OR btrim(category) = '';                                       -- 0
```

### Docker build

```bash
docker build --platform linux/amd64 --build-arg APP_VERSION=$(git rev-parse --short=7 HEAD) -t closet .
```

`--platform linux/amd64` because the Dockerfile drops the arm64 onnxruntime binding: an arm64 image boots and reports healthy, but every photo stays at "Removing background". `APP_VERSION` is what `/health/ready` and About report; without it the image says `dev`. How the published image is built and shipped: [docs/operations.md](docs/operations.md).

---

## Architecture

One Node 22 process: plain Fastify 5 serving server-rendered JSX pages with htmx, Drizzle over PostgreSQL, photos on disk under `DATA_PATH`, and background removal in a child process running an ONNX model. A Workbox service worker makes it an installable PWA, and `/mcp` exposes the wardrobe to Claude. The source tree and the area index are in [AGENTS.md](AGENTS.md#architecture), each piece in full in [docs/architecture.md](docs/architecture.md), and the web layer in [docs/web-layer.md](docs/web-layer.md).

---

## Deploy

This instance runs on the homelab, and merging to `main` deploys it: the homelab's publisher host (`make publish`, at most once per 3 h, once main's checks pass) pushes `ghcr.io/kashhq/closet:latest` and a `ship-<date>-<sha7>` tag, and the hourly autoupdater pulls the image. The pieces, the production env, deploying by hand and recovery are in [docs/operations.md](docs/operations.md).

For other self-hosters: deploy to a VPS via [Coolify](https://coolify.io/) or Portainer using the docker-compose above, with local storage. Back up both the Postgres database and `DATA_PATH`, taken close together: the nightly storage reconciliation deletes photos that no database row references.

---

## Documentation

- [AGENTS.md](AGENTS.md): rules, commands and the area index (each `src/` area has its own `AGENTS.md`).
- [docs/architecture.md](docs/architecture.md), [docs/web-layer.md](docs/web-layer.md), [docs/conventions.md](docs/conventions.md): the stack, the web layer, and conventions, config and logging in full.
- [docs/operations.md](docs/operations.md): production, environment and release.
- [docs/decisions.md](docs/decisions.md): dated decisions, newest last. [docs/history.md](docs/history.md) and [docs/PROJECT_LOG.md](docs/PROJECT_LOG.md) hold the older record.
- [docs/workflow.md](docs/workflow.md): the flow per issue slice.
- Testing: [integration](docs/testing-integration.md), [cutouts](docs/testing-cutouts.md), [service worker](docs/testing-service-worker.md), [WebKit](docs/testing-webkit.md), and page performance in [docs/perf/](docs/perf/README.md) ([baseline](docs/perf/baseline.md)).
- [docs/DESIGN.md](docs/DESIGN.md): the upstream entity model, still the reference for feature scope (its stack is stale).
- Feature designs cited from the code: [redesign](docs/plans/2026-09-26-redesign.md), [wardrobe features](docs/plans/2026-09-26-wardrobe-features.md), [caching and offline](docs/plans/2026-09-28-caching-and-offline.md), [multi-add and export](docs/plans/2026-09-28-multi-add-and-export.md), [order email import](docs/plans/2026-09-28-order-email-import.md), [yearly recap](docs/plans/2026-09-28-yearly-recap.md), [Muse suggestions](docs/plans/2026-10-05-muse-suggestions.md), [structural refactors](docs/plans/2026-10-09-structural-refactors.md), [outfit rules](docs/plans/2026-11-12-generator-rules.md), [inspiration library](docs/plans/2026-11-13-inspiration-library.md), [desktop Styling and Calendar](docs/plans/2026-11-12-desktop-styling-and-calendar.md), [the JSON API](docs/plans/2026-11-12-json-api.md), [offline queued writes](docs/plans/2026-11-12-offline-queued-writes.md), [HTTP/2 outbound](docs/plans/2026-11-13-http2-outbound.md), and the [background-removal benchmark](docs/audits/2026-09-25-program2/bg-removal-benchmark.md).
- One-off audits and superseded plans: [docs/reports/](docs/reports/), never linked from an AGENTS.md.
- Contributors and agents: see [AGENTS.md](AGENTS.md).

---

## Contributing

Closet is a hard fork and does not track upstream. This project is licensed under AGPL-3.0 - contributions must be compatible with that license.

---

## License

[GNU AGPL-3.0](LICENSE)
