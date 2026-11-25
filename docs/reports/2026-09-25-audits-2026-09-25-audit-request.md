# Closet — Request Path & Code Structure Audit

## 1. Request lifecycle (as code actually runs)

### Every request reaching the Fastify instance (page, htmx fragment, AND static asset)

```
fastify root preHandler hook (main.ts:34-36)
  -> ViewContextService.buildContext(req)   (view-context/view-context.service.ts:22)
       - reads `access_token` cookie
       - if present: jwtService.verifyAsync()          [JWT verify #1]
       - if valid:   userRepository.findOne({id})       [DB query #1]
       - builds OG/i18n/locale/app-name context, always
onSend hook: sets 5 security headers (main.ts:40-53)
```

This hook is added directly on the **root** Fastify instance before any
`app.useStaticAssets()` call. Fastify hooks registered on a parent
encapsulation context run for every route registered afterward, including
child plugin contexts — so **`@fastify/static`-served CSS/JS/images/fonts,
htmx/hyperscript bundles, and PWA model files all pay for a cookie parse +
JWT verify + i18n resolve + OG-string building on every single request**,
including the dozens of static requests an installed PWA fires on boot.
None of that work is used for a static response.

### Guarded controller routes (page or htmx fragment), `AUTH_ENABLED=true`

```
ConditionalAuthGuard or AuthGuard (class- and/or method-level @UseGuards)
  - cookie -> jwtService.verifyAsync()              [JWT verify #2]
  - authService.verifyPwf(payload)
      -> userRepository.findOneOrFail({id})          [DB query #2]
      -> compares last 8 chars of password hash to payload.pwf
  - sets request.user = <JWT payload only>  (not the entity fetched above)
controller method
  -> reads request.user.userId via a private `userId(req)` helper
     duplicated verbatim in wardrobe/outfit/calendar controllers
  -> service call, @Render('feature/view') or reply.view(...)
```

`WardrobeShareController` (src/wardrobe-share/wardrobe-share.controller.ts:26,
33,65,88,99,126,151) stacks **both** `ConditionalAuthGuard` at class level and
`AuthGuard` at method level on almost every route. Guards run in
class-then-method order, so those routes execute the JWT-verify +
`verifyPwf` DB-lookup sequence **twice**, on top of the preHandler's own
verify + lookup.

**Net redundancy on a single authenticated GET to `/wardrobe-share/manage`:**
JWT decoded/verified 3×, `User` row fetched 3× (once by cookie in
view-context, twice by `verifyPwf`), entirely independently, with no shared
cache on `request`. On plain `ConditionalAuthGuard`-only routes (most of
`wardrobe`, `outfits`, `calendar`) it's still 2× verify + 2× DB fetch.

### htmx fragment requests

No `HX-Request` branching inside shared routes for `wardrobe`/`outfits`
(good — see §4 "what's fine"). `calendar.controller.ts:61,91` branches on
`req.headers['hx-request']` inline, duplicating a status-code/redirect
decision and, in `toggleWorn` (calendar.controller.ts:88-104), building
button label/class strings with `i18n.t()` directly in the controller
instead of a template or view-model.

### 404 static asset / unmatched route

Same preHandler cost as above, then Fastify's own 404 handler. `.well-known/*`
is caught explicitly (app.controller.ts:120-123) to avoid log noise — fine.

### File download (`GET /file/:fileName`, `GET /file/nobg/:fileName`)

**No guard at all** (file.controller.ts:61-93). Still pays the global
preHandler cost, then streams the file with no ownership check — see §2
Finding 4.

---

## 2. Findings, ordered by impact

### Finding 1 — Three independent, uncoordinated JWT-verify/DB-lookup paths (L, high impact)

`ViewContextService.buildContext` (view-context/view-context.service.ts:64-75),
`AuthGuard.canActivate` (auth/auth.guard.ts:31-41), and
`ConditionalAuthGuard.canActivate` (auth/conditional-auth.guard.ts:29-40) each
independently decode the cookie, call `jwtService.verifyAsync`, and (for the
guards) call `AuthService.verifyPwf` which does its own
`userRepository.findOneOrFail` (auth/auth.service.ts:80-88). None of the
three shares state via `request` — each re-does the crypto verify and DB
round trip. `WardrobeShareController`'s guard stacking (see above) makes this
3× per request on that controller.

**Why it matters:** every authenticated page load costs 2-3 JWT verifications
and 2-3 database round trips before a controller runs, for data (`User`
entity, payload) that's identical every time. This is the actual "per-request
overhead" the audit was asked to quantify, and it compounds badly on an
installed-PWA target where the same page fires several htmx fragment
follow-ups per interaction.

**Structural fix:** collapse to one authentication step. Add a single
preHandler/guard that verifies the JWT once, does the `verifyPwf` DB check
once, and caches the resolved `User` entity on `request` (e.g.
`request.authUser`). `ViewContextService.buildContext` and the `@User()`
decorator both read that cached value instead of re-verifying. Guards become
a check of `request.authUser` presence, not a re-verify. Delete the
method-level `AuthGuard` on `WardrobeShareController` routes that already
carry the class-level `ConditionalAuthGuard` — pick one semantic (redirect
vs. 401) per controller, not both per route. This also fixes Finding 2's root
cause: once there's one place that resolves "who is this user and what do
they own," the ownership-check duplication in wardrobe.controller.ts has a
natural home.

### Finding 2 — Ownership/sharing authorization logic duplicated 6× in `WardrobeController`, absent from `OutfitController`/`CalendarController` (M, high impact)

`wardrobe.controller.ts` repeats this exact shape inline in `create` (150-156),
`editForm` (240-245), `update` (363-369), `uploadPhoto` (397-403), and
`updateNobg` (445-451): when a signed-in user acts on another owner's
wardrobe, ask the share service whether the user may manage it, and refuse
with a 403 when not.
plus a second, differently-shaped variant in `show` (202-214) that computes
`canEdit`/`canDelete`/`canClone` from `getSharePermission`. `GarmentService.findOne`
(garment.service.ts:97-117) does a _third_, independent version of the same
owner/share check inside the service layer, so the controller-level checks in
`editForm`/`cloneForm`/`update` are partially redundant with what
`findOne`/`update` already enforce — it's not obvious from reading one call
site which layer is the actual source of truth.

Meanwhile `OutfitController` and `CalendarController` have **no** viewOwner /
sharing support at all — they only ever operate on `this.userId(req)`. That
asymmetry is either a missing feature (outfits/calendar can't be shared even
though garments can, which is surprising given wardrobe-share's name) or
correct-but-undocumented scope; either way it's the kind of thing that should
be a comment on `WardrobeShareModule`, not something a reader has to infer
from absence.

**Structural fix:** a single `WardrobeShareService.resolveAccess(userId,
resourceOwnerId, required: 'view' | 'manage')` (or an
`AuthorizationResolver` covering garments/outfits/calendar uniformly) that
every controller and `GarmentService.findOne`-style method calls once. That
removes 5 copies of the same branch, makes the owner-vs-viewOwner semantics
inspectable in one place, and makes it a one-line change to extend sharing to
outfits/calendar if that's ever wanted.

### Finding 3 — `ThrottlerGuard` is effectively keyed to one bucket in production (S, security/UX impact)

`main.ts:20`: `trustProxy: ['127.0.0.1', '::1']`. Per CLAUDE.md, the app runs
behind the shared Caddy on `homeinfra_web`, reached over the Docker bridge
network, not loopback. `ThrottlerModule.forRoot()` (app.module.ts:191) uses
Nest's default IP-based tracker, which under an untrusted proxy falls back to
the immediate socket peer — the Caddy container's bridge IP — for every
request. Every real client is bucketed together, so the throttler either
does nothing useful (if the shared bucket's limit is high enough that no
single household member trips it) or blocks the whole household as soon as
one member's polling/htmx traffic adds up. This is the exact case the brief
flagged; confirmed in code, not just suspected.

**Fix:** trust the Docker bridge/Caddy hop (its actual CIDR, not just
loopback) so `X-Forwarded-For` is honored, or key the throttler off the
authenticated `userId` when present instead of IP.

### Finding 4 — `/file/:fileName` and `/file/nobg/:fileName` have no auth guard or ownership check (S, security-adjacent)

`file.controller.ts:61-65,75-93`. Any request for a known/guessed filename
streams the image back with no session or ownership check — no guard
annotation at all, unlike every other route in the file. Filenames are
`randomUUID()`-based (garment.service.ts:265, local-file.service.ts:51,91),
so this is a bearer-token-by-obscurity design, which is a defensible choice
for a two-person household app and is probably intentional (thumbnails need
to be embeddable/cacheable without cookies for OG previews). It should be a
stated decision, not silent: a one-line comment noting "unauthenticated by
design, protected by UUID unguessability, needed for OG image embeds" would
prevent a future contributor from either "fixing" it into a breaking change
or copying the no-guard pattern onto something that does need protection.

### Finding 5 — `ErrorViewFilter` re-derives context that's already on the reply (S, low impact but wrong precedent)

`error-view.filter.ts:41-43` takes the view context from the reply's
`locals`, cast through `any`, and builds it again from the request when that
is missing.
`response` **is** the `FastifyReply` decorated with `locals` by the root
preHandler (main.ts:33-36), which always runs before a route handler can
throw. The fallback branch is dead in every real request path (it would only
fire if the preHandler itself threw before setting `locals`, in which case
`buildContext` would likely throw again too). Harmless today, but it repeats
the JWT-verify + DB-lookup cost described in Finding 1 whenever it _does_
fire, and it's the kind of defensive-but-wrong-layer code that invites
copy-paste elsewhere. Fix falls out of Finding 1: once `locals`/`authUser` is
guaranteed set by a single early hook, delete the fallback.

---

## 3. Removable boilerplate

| Item                                                         | Files                                                                       | Approx. lines   | Notes                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE chat demo (`/chat`, `/sse`, `/message`)                  | `app.controller.ts:53-59,65-118`, `views/chat.hbs`, `AppService.getHello()` | ~70 + 57 (view) | Hardcoded "Hello World" htmx-SSE demo from the boilerplate. No guard, not linked from any nav/layout partial, unrelated to wardrobe. Referenced only defensively in `views/assets/src-sw.ts:44` (a comment noting it must not be cached as a navigation).        |
| Generic file-gallery feature (`/file/files`, `/file/upload`) | `file.controller.ts:33-59`, `views/files.hbs`                               | ~30 + 77 (view) | A standalone upload-and-list-my-files page, separate from and redundant with the garment-photo pipeline (`GarmentService`/`/wardrobe/:id/photo`). Not linked from layout/nav either; looks like the boilerplate's original single-purpose demo of `FileService`. |
| `NotificationController.postTest`                            | `notification.controller.ts:44-52`                                          | ~9              | Dev-only "send myself a test push" endpoint, guarded but with no UI entry point found; fine to keep behind a debug flag but currently ships unconditionally.                                                                                                     |

Confirm before deleting: grep templates/nav for `/chat`, `/file/files`,
`/file/upload` one more time in case a hidden dev link exists (none found in
`views/layout.hbs` or `views/partials/`).

---

## 4. What's fine

- **htmx full-page vs. fragment split**: the app does _not_ branch on
  `HX-Request` inside shared routes for garments/outfits (the pattern the
  brief worried about). Instead it uses dedicated fragment routes
  (`reply.viewPartial('partials/outfit_row', …)`,
  `partials/calendar_worn_button`, `wardrobe-share/partials/invite-link-result`)
  — a clean, locality-of-behavior-respecting pattern, not copy-paste.
- **Config discipline**: `ConfigService` + Joi schema in `app.module.ts` is
  the single source of truth for env vars, consistently used; no stray
  `process.env` reads found outside `main.ts` in the audited paths.
- **Cookie-not-secure convention** and the `.well-known/*` catch-all are
  both deliberate, documented (CLAUDE.md / inline comment) choices, correctly
  implemented.
- **DTO/validation pipe usage** in the audited controllers (`ParseIntPipe`,
  typed DTOs) is consistent; no obvious whitelist/forbidNonWhitelisted gaps
  spotted in the files read.
