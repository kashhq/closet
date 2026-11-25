# Platform history

Read on demand (not auto-loaded). What the stack used to be and when it changed, so a leftover name in a comment or an old PR makes sense. None of it is a rule: the rules are in the root `CLAUDE.md`. Moved out of the root in #259.

## Where it began

The project began in 2026 from an open-source starting point, and the repo (now `kashhq/closet`) has had no upstream remote and no merges since 2026-09-28. On 2026-11-25 it was relicensed MIT, after every inherited line had been rewritten (#1225; `make upstream-check` proves the tree). The history before that commit keeps its original licence. The inherited design doc went with the rewrite: the area docs and the roadmap (#27) hold the feature scope.

## The platform migration (finished 2026-09-26)

In order: Jest to Vitest, MikroORM to Drizzle, Handlebars to JSX (`hono/jsx`), then NestJS to plain Fastify 5. NestJS left on 2026-09-26, the last step. The MikroORM and SQLite history and the legacy migration tree: `src/db/CLAUDE.md` (index and constraint names are still MikroORM's, kept).

## Removed on 2026-09-26

- **`_hyperscript`** (172 KB, the largest script in the shell): its 13 attributes were each a few lines of htmx, CSS or a one-line inline handler. `expectFullPage` in `test/integration/pages.ts` fails a page with an `_=` attribute.
- **The in-browser cutout model** (`@imgly/background-removal`, `onnxruntime-web`) and the `CUTOUT_MODE` switch: background removal runs on the server only (`src/cutout/CLAUDE.md`).
- **The S3 storage backend**, `nestjs-s3` and the AWS SDK: production never used them; local disk under `DATA_PATH` is the only backend.
- **The other five languages**: English only, `src/i18n/en/lang.json`.

## Dated incidents that shaped rules

- **2026-09-26, `expectNativePostForms`** caught three boosted post forms on landing: the outfit save form, the garment form and the share revoke/leave buttons. Until 2026-09-27 the garment page's photo sheet was an `hx-post` form (`hx-swap="none"`) the check cannot see, and swallowed every refused upload. Detail: `docs/web-layer.md#native-posts-and-postform`.
- **2026-09-27 00:01 UTC, main went red**: the authorization matrix planned its fixture entry on UTC's today; the same PR had passed before midnight UTC. Hence the `todayIn` rule: `docs/conventions.md#today`.
- **The `ChangeMe!` secret default** let anyone who read the repo mint a session for any user id; `ACCESS_TOKEN_SECRET` now has no default (`docs/conventions.md#config`).
