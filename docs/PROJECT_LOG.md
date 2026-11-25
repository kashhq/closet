# The early project log

The project's early record, by date: what was decided in a session whose result is not a file in the repo. Decisions since 2026-10 are dated entries in `docs/decisions.md`.

## 2026-09-25

The fork becomes **Closet**, a private household app: rebranded, marketing/privacy/terms pages removed, one account for now with registration locked.

Deployment decisions: pgvault Postgres over SQLite (nightly dumps, shared triage tooling); an HTTPS hostname is the canonical URL because the PWA needs a secure context, an `http://` hostname is the plain twin; the image publishes on every push to `main` and the homelab autoupdater deploys it, so pushing `main` is deploying.

Performance program (audit, then six phases, all shipped the same day): image asset model with thumbnails and immutable versioned URLs; one session resolution per request; an in-process integration test tier run on SQLite and Postgres in CI; cache-first PWA shell and lazy model loading; indexes on every relation with concurrent Postgres backfill and transactional writes; boilerplate removal and a 54% smaller image; nightly storage reconciliation, HEIC support and safe user deletion. Grid image payload went from 28.6 MB uncached to 1.3 MB cached. Two production bugs found on the way: `garment.color` had become a smallint on Postgres, and an undecodable upload could crash the process.


## 2026-09-26

Program 2 (audit, then gate, correctness, simplification, speed), all shipped within two days. Record: `docs/reports/2026-09-26-audits-2026-09-25-program2-*.md` (eight audits, `…-plan.md` with every decision) and the background-removal benchmark in `docs/audits/2026-09-25-program2/`, CHANGELOG "Unreleased".

Found live and fixed first: `/file/app.log` served the request log (session cookies included) publicly; every real photo upload with a cutout failed (the thumbnail read a half-written file); the owner was locked out (a browser-generated password on an htmx-submitted form was never saved) and email reset could not work. Leak cleanup: log route closed, cookies redacted, the secret rotated, the old log deleted, Loki's copies deleted.

Decisions by the owner:
- **Postgres only.** SQLite hid production-only bugs and its own migrations deleted data.
- **Login always required; email reset replaced** by an in-app change password and a `user:set-password` recovery command.
- **English only. Sharing kept** (deprioritised). **Web Push kept** and repaired; what it is for is still open.
- **Platform:** Drizzle replaces MikroORM, plain Fastify replaces NestJS, typed JSX (hono/jsx, escape by default) replaces Handlebars, Vitest replaces Jest; done feature by feature with the tests as the parity proof. Drizzle became the only migration authority by recording a baseline on production's MikroORM-built database.
- **Background removal on the server** (BiRefNet 512, MIT), and the whole stack **moved from the NAS to the production host** because the NAS CPU has no AVX. Photos stay on the NAS over NFS; the database stays on pgvault.
- **Backups** are a separate homelab effort (they were found failing silently).

Gate: publishing waits for CI; pre-commit runs format, lint, types and both test tiers; pre-push runs the browser suite in production configuration; 800+ tests including an authorization matrix, a schema-drift test and a native-post guard.

Numbers: `/wardrobe` at 1,500 garments 63 ms to 6.5 ms and 870 KB to 42 KB; boot 650 to 430 ms; idle memory 225 to 162 MB; service worker 30 to 10 KB gzipped; image 1.47 GB to 0.59 GB; high-severity advisories 9 to 0; type errors 790 to 0.

## 2026-10-09

Structural refactor epic (#351), recorded from the retired Graphiti store on 2026-10-12. A planned outfit whose piece became unavailable (lent, at repair, archived) gets a `GarmentMark` warning; nothing ever rewrites a hand-picked outfit, and the daily re-plan still touches only planner-made entries. There is exactly one status renderer, `garmentMarks()` in `src/wardrobe/marks.ts` plus `<GarmentMark>`, and "needs-wash" means no clean copy is left, matching the generator's own availability rule. Accessible names of outfit links carry the warnings because an `aria-label` overrides descendant sr-only text.

Gotcha: the installed PWA keeps stale-while-revalidate tab roots across a deploy, so a change to an htmx response's shape must set `HX-Retarget`/`HX-Reswap` on the server relative to a selector old and new markup share (the worn POST answers the whole occasion row retargeted to `closest [data-occasion]`). When a state-dependent piece sits outside the swap target, swap the whole row from the page model rather than patching the pill. Rule: `docs/web-layer.md#htmx`.

Process: Codex and Claude reviews caught different bug classes on this epic (Codex the a11y override and the cached-markup break, Claude the behaviour-equivalence diffs), so both gates stay.
