# Page performance

`npm run audit:pages` (#157) measures every page, fragment, action, MCP tool
and background job the page audits name (#158 to #174, epic #156), on the
production build, over one of two seeded personas (#707):

| Persona | Closet | Baseline |
| --- | --- | --- |
| `demo` (default) | Theo: 83 garments, 26 outfits, 13 weeks of wears | `baseline.md`, `baseline.json` |
| `scale` | Theo grown to the 0.1 target: 500 garments, 1,000 outfits, 1,095 days (1,043 worn entries, 4,550 wears), Dana sharing her wardrobe | `baseline-scale.md`, `baseline-scale.json` |

Demo's baseline is #722's run at `4fc5b86` (2026-11-19, Apple M4 10
cores, Node 22.23.3, load average 5.8 falling to 2.5), the first with the
accessibility counts. Scale's is the run on `main` at `08d9927`
(2026-11-14, load average 10.1 falling to 2.7, other agents' runs sharing
the box: times rough, counts and bytes exact), without them (its compare
skips the pass until it is refreshed); its Styling (#163) and Ideas gallery
(#168) steps were measured again by #996's `--only` runs and merged in.
Every page PR shows its before and after
against the one that fits it; a perf-sensitive one against both
(`make perf-compare`).

**The scale persona** is a generator over demo's bible, not a second bible
(`src/seed/scale.ts`, `src/seed/AGENTS.md`): demo's rows first and
unchanged, then clones of its garments and swaps of its outfits' garments
within a category. `npm run seed -- --persona scale` (never in `--persona
all`) is deterministic (`scale.spec.ts`; `test/integration/seed.spec.ts`
for the rows) and took 42 s on this box at load 8 (3 s for demo): the
generated art of 500 garments is most of it. Seeding is part of the audit's
"Ready in": 47 s for scale, 6 s for demo.

## The threshold

A **page or fragment read** at scale is over the line when its p50 is above
**50 ms** (a phone's 100 ms budget is half server), it sends more than
**15 statements**, or its body is above **256 KB** decompressed (HTML the
phone parses on every visit). Statements and bytes are exact; a time is
over only past the noise below. A page over the line is a finding for the
owner to schedule, not a failing gate: `make perf-compare` prints what
moved, and fails only on a new accessibility violation kind (Accessibility, below). Writes, MCP tools and jobs are read for their
statements and times too, but the hashing steps (sign-in, register, change
password: 220 to 440 ms by design) and the photo pipeline are not pages.

## What it does

1. Builds (`npm run build`), then boots `dist/` **in process** with
   `createApp`, the way the integration harness boots `src/`, with
   production's flags (`NODE_ENV=production`, PWA, weather, metrics,
   error tracking and the order mail on) on a throwaway database on the shared local Postgres
   (`TEST_DATABASE_URL`, default a local Postgres on :5432) and a temporary
   `DATA_PATH`. The database is dropped at the end, whatever happened.
2. Seeds Theo (`--persona`, `demo` or `scale`) and Dana (`sparse`, who
   shares her wardrobe with Theo) through the seed, anchored on today, runs `ANALYZE` (a production
   database has planner statistics; a fresh one guesses), and signs in as
   Theo.
3. Walks `scripts/audit/steps.ts`: pages over the seed as it is, then the
   writes, the MCP tools and the jobs. Each step runs 3 times untimed, then
   20 times timed (fewer where a run is costly: the step says so). A step
   on a rate-limited route waits for room in its budget first (Rate limits,
   below). A write that needs something to act on (a garment to delete, a
   fresh account to change the password of) makes it first, unmeasured.
4. Writes `scripts/results/audit.md` (a table per audit issue) and
   `audit.json` (the numbers, and each step's SQL, for a later diff), plus
   `scripts/results/audit.app.log`, the app's own log of the run (always
   under `scripts/results/`, whatever `--out` says).

Per step it records:

| Column | What |
| --- | --- |
| p50 ms, p95 ms | Wall time of the request in process (`app.inject`: routing, hooks, handler, render, compression; no network), or of the job's run |
| db ms | Server-Timing's `db` (connection time; concurrent queries add up, so it can exceed the total). Empty where the answer has none: a checked password or token, a static path, a job |
| Statements, Rows | SQL statements the request sent and the rows they returned (the median run; a range when runs differed) |
| KB, Wire KB | The body as the browser reads it, and as sent with `Accept-Encoding: br, gzip` |

The report's last section, **Not walked**, lists route templates and MCP tools no step
requested. It should be empty; a new route should keep it so by joining its audit
issue's group in `steps.ts`. At `08d9927` it is not: 148 entries, the `/api/v1` routes
(#190) and the later pages' fragments, inspiration, the style rules, the
shopping list and the bulk actions among them (the list is in each baseline's
`unwalked`; the first baseline of this issue was at 2 before them).

**How SQL is recorded**: `test/support/query-recorder.ts` wraps
node-postgres's `Client.prototype.query` in the audit's own process, only
while a step's request runs (the integration harness's `recordQueries` is
the same wrapper). Nothing is added to the app or its request path, and no
environment flag exists that could turn it on in production.

**The outside world** is the tests' stand-ins: Open-Meteo
(`test/support/weather-stub.ts`), a shop for the link import and the order
mail's links (`test/integration/link-sites.ts`,
`test/support/order-mail-shop.ts`), Fastmail's JMAP
(`test/support/jmap-stub.ts`: the fixture's `ORDER_MAIL_*` are stand-ins and
nothing reaches Fastmail), Bugsink (`test/support/sentry-stub.ts`), and
web-push's send, which answers in process. The order mail's owner is Theo:
"From your orders" starts with a seeded order of six items, written as the
poll writes them, and each run of the poll step reads one new copy of the
forwarded order email (`test/fixtures/order-mail/`). Background removal is an
instant stand-in held behind a gate that only the cutout step opens, so an
upload's cutout never runs while another step is measured.

## Using it on a page PR

```bash
npm run audit:pages -- --only '#159' --compare docs/perf/baseline.json
npm run audit:pages -- --persona scale --only '#164' --compare docs/perf/baseline-scale.json
make perf-compare             # both personas, whole walk (about 36 minutes, most of it rate-limit waits), on a throwaway Postgres
```

A report names its persona, and `--compare` refuses a baseline of the other
one.

- `--only TEXT` keeps the steps whose issue (`#159`), name or target contains
  TEXT; the rest are skipped (and the Not walked check with them).
- `--compare FILE` prints, and writes to `audit.compare.md`, every step whose
  statements, rows or bytes changed, and every time past the noise below,
  with the SQL each step gained or lost.
- `--explain` adds `audit.explain.md`: `EXPLAIN (ANALYZE, BUFFERS)` of each
  step's three slowest statements, each run in a transaction rolled back (a
  write's plan is measured and undone).
- `--runs N`, `--warmup N` (20 and 3), `--out PREFIX` (`scripts/results/audit`).

Put the comparison in the PR: the steps of the issue's scope, before and
after. Statements, rows and bytes are exact for a seed day, so any change is
real; a time is a change only past the noise.

**Refresh the baseline** in the PR that changes it (after merging `main`),
so the next PR compares against the new state:

```bash
npm run audit:pages -- --out docs/perf/baseline
npm run audit:pages -- --persona scale --out docs/perf/baseline-scale
```

## Noise

Measured on the production host (Ryzen 7 8845HS, 16 threads, Postgres
18) on 2026-09-28, with two runs of the same build one after the other
(the baseline, then `--compare` against it), while other agents' test runs
shared the box (load average 5 to 15). The change of each step's p50 from
one run to the other, as a fraction of the first:

| Steps | n | Median change | 90th percentile | Median ms | 90th percentile ms |
| --- | --: | --: | --: | --: | --: |
| All | 274 | 19.0% | 35.4% | 0.73 | 2.48 |
| Pages | 81 | 22.5% | 32.2% | 1.51 | 2.42 |
| Fragments | 21 | 20.7% | 31.1% | 0.75 | 2.10 |
| Actions | 101 | 15.8% | 36.2% | 0.50 | 2.58 |
| MCP tools | 40 | 5.7% | 23.6% | 0.41 | 1.49 |
| Jobs | 11 | 29.5% | 57.0% | 0.29 | 3.87 |

The second run was faster on 186 steps and slower on 88: most of it is the
box getting quieter between the two, not per-step jitter. So a time counts
as changed only past 35% **and** 2 ms, both ways (`TIME_NOISE`,
`scripts/audit/report.ts`); between these two runs that flags 3 steps of
274. A first attempt with each step's runs back to back, not in rounds, on a
busier box (load average 16 to 24) disagreed by 29% at the median and 61% at
the 90th percentile: the reads now run in rounds (`Phase.interleave`,
`scripts/audit/walk.ts`), so a burst of load elsewhere lands on one sample of
many steps rather than on every sample of one.

Statements, rows and bytes did not move between the runs (the one exception
is `/metrics`, whose body grows as the run records), so any change in them is
real.

Things that make times noisier: another heavy process on the box (a build,
Playwright, another agent's tests, a second audit). The report's header says
the load average at the start and end of the walk; compare runs made under
similar load, from the same machine: CI's nightly run
(`.github/workflows/nightly.yml`) compares against this baseline too, but
its times are a different machine's; only its counts and bytes compare.

## Accessibility

Before the walk, every page step a browser can open (a GET answering 200,
nothing to prepare, not htmx) loads in Chromium at 390 × 844
(`scripts/audit/a11y.ts`, #722) as its step's user, and the report's `a11y`
holds per page, per measure, the violating node count and the sorted list of
violating element kinds (`kindOf`, `scripts/audit/a11y-report.ts`: read off
the element in the browser, never off axe's selector: its tag, explicit role,
an input's or button's type, its design-system classes (main.css's and
daisyUI's, never a utility), a link's route shape and its nearest region (a form by its action, a
named section, a landmark), from an axe run the page held still through
(rerun twice, then the page fails); an attribute value counts only as a code word,
lower-case letters and hyphens, else `*`, so a calendar grid is one kind and
no seeded date, id or name reaches one): each axe-core rule (all
of axe's default rules), `field font < 16 px` (a text field iOS zooms the
page into on focus, shown or not) and `target < 44 px` (a visible tap
target a fingertip does not wholly reach: a 44 px disc on it, hit tested
by the browser, lands elsewhere at its centre or rim, so main.css's hit
areas and a control's labels count and a neighbour's area over it counts
against; each rim probe's pixel ends on the rim, so a box 43 px across
passes and 42 px fails (#1209);
`tapMisses`, `test/support/tap-area.ts`, #1210; a link inside running text
is exempt). The browser's writes are answered 204
in the browser, so the walk still starts on the seed and no budget is spent.

**`--compare` fails on a new kind**: a (page, rule, kind) triple the baseline
lacks, which is deterministic across days and OSes. A node count above the
baseline's prints as `WORSE accessibility nodes` and never fails: counts follow
the seed's dates and font rounding, and the nightly gates no deploy. A page the
baseline lacks is reported as new, a baseline page this run lacks as missing,
neither fails: refresh with `npm run audit:pages -- --out docs/perf/baseline`
(refused with `--only`, which would truncate it). Every offending node, with
axe's failure summary or the size, is in `scripts/results/<name>.a11y-nodes.json`.
A PR that fixes some refreshes the baseline in the same change.

## Rate limits

The walk is one user (Theo) on one address, so it meets the app's rate
limits (`src/web/security/rate-limit.ts`), and two steps can spend one
counter: the link import and its photo choice, or the MCP tools
`add_garment_from_link` and `suggest_garment` (#374: 18 calls on a budget of
10 a minute, a 429 every night). So:

- **A step that hits a rate-limited route or tool declares it**: `limits`
  on the step, an entry of `LIMIT` in `steps.ts` (or the MCP helper's
  per-token one), built by `auditLimit()` from the app's own constant, so
  `max` and the window cannot drift from the app. One entry per counter
  the app keeps: steps sharing a counter share the entry.
- **The walk paces every declared budget** (`scripts/audit/budget.ts`, one
  tracker for the whole walk, across phases): before each run, warm-up
  included, it waits until each budget has room, and logs
  `waiting N s for the <key> budget`. The summary line says how long the
  walk waited in all.
- **Never size `runs` to dodge a limit.** `runs` is how many samples a step
  is worth; a step with a small budget keeps few runs only because each
  run past the budget costs a wait.

## What it does not measure

- The browser: layout, script execution, LCP and INP. The devices report
  those in production (`public/js/vitals.js`, `client_timing_seconds` in
  Grafana); the report's Wire KB is the transfer side of it.
- Concurrency and throughput: every request runs alone.
- The network: `inject` has no socket, so no TCP or TLS, and Caddy is not
  in the path.

## Gotchas

- **Rows and counts depend on the seed day.** The seed is anchored on
  today, so the planned week, Today's ideas and the calendar move with the
  date. Compare runs from the same day where a step's rows changed and
  nothing in the diff explains it.
- **Steps share Theo.** The writes run after the pages and change his
  wardrobe (a garment worn, a plan added), so a write's numbers are those of
  the state the steps before it left. Order matters: add a step to the end
  of its group.
- **A killed run leaves its scratch database** (`closet_audit_*`); Ctrl-C
  drops it, and the integration tier's sweep drops a killed one after an
  hour.
- **Rate-limited steps keep fewer runs** (link import, weather location and
  search, the script error beacon, the link-taking MCP tools): their `n`
  is lower, their p95 rougher, and a walk that needs more of them than a
  budget allows waits (Rate limits).
