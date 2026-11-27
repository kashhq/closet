# The changes feed: reference

Moved out of `AGENTS.md` (#723) so the auto-loaded doc keeps only invariants, gotchas and ownership. Not auto-loaded: read it before changing this area. Where it disagrees with the code or a spec, they win.

- **A feed shape is the API resource minus what tables that never move its revision derive** (decisions 2026-11-13); the client derives those from the feed's other resources. Per resource (`Synced…` beside its API resource):
  - `garment`: no `worn`, `wornSinceWash`, `lastWorn`, `cost`, `costPerWear`, `capsules` (wears, capsules).
  - `outfit`: `slots` (category, `garmentId`) for `garments` and `toBuy` (the garments'); no proposal `agent` (the token's name), `planned` or `worn` (the entries'). The agent's proposals are in it, with their reaction (decided on #607). `origin` (#659): migration 0053 re-sent only the rows it moved off `person`, so **a cached outfit without `origin` is `person`**.
  - `calendarEntry`: `outfitId` for `outfit` (its name and garments); no `selfieId`/`selfiePhoto` (the `selfie` names its entry).
  - `trip`: its stored fields, `outfits` flat (for `days`/`anyDay`), `extras`, `packedGarmentIds` (stale marks included: the reads ignore them); no `phase` (the day's), outfit garments, `wornTodayEntryId` (the calendar's) or `packing`, derived from the outfits' slots and garments.
  - `weekPlan` (no API resource): `createdAt`, `entries` (`entryId`, `outfitCreated`); not the planner's targets, the re-plan's own input.
  - `selfie`, `brandSize`, `measurements`: nothing dropped.
  - `styleProfile`: its fields and `rules` (`SyncedStyleProfile`, #716), each rule's sides without `label` or `sentence` (a garment's name: its rename never moves the profile). `outfit_rule` is the profile's child (`createsParent`: a rule before any profile creates the row), so every rule write, a garment delete's cascade included, re-sends the profile.
  - `weekTemplate` (#716, the API's `WeekTemplate`): a **stamp**, not a root (`SYNC_STAMPS`): no row of its own, its revision `user.week_template_revision` (0052's trigger), read from the user row. Every user has one: never set, it is seven empty days at revision 0, so a full sync carries it; emptied, a change, never a deletion (no tombstone).
  - `styleProfile`, `measurements`, `weekTemplate` are one per user, the change's `id` the user's; all owner-only.

- **Tests**: `test/integration/api-changes.spec.ts` (the delta across pages, a page boundary inside one revision, the backfill, a held writer, the floor, a full sync's snapshot, a grantee's feed; per owner resource group its delta, a child write resending its parent, the week template and rules across devices); `feed.spec.ts` (the registry, `isExpired`); `coverage.spec.ts` (the declared coverage); `sync-prune.spec.ts` (what the prune keeps, the floor against cursors, a prune committing under a held page).
