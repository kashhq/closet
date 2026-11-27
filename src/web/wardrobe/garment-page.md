# The garment page's reads

Part of the Wardrobe (`AGENTS.md` in this directory): `GET /wardrobe/:id` and the wear line's Wore today and Washed (`POST /wardrobe/:id/wear`, `/washed`, the wears plugin).

## What each statement reads, and why

Production reaches Postgres over a link that costs a round trip per statement (about 114 ms, homelab #40), so the page's cost is its statement count (#156, #160). `garment-page.spec.ts` asserts every count below; a new read joins a statement that already runs, never a new one.

- **The session** (`select ... from "user"`): the root hook's, every page's (#174). A grantee's page reads the share in the same statement (`authorizeWardrobe` finds it on the request, #170; see Sharing).
- **The garment** (`findGarment`): what the page shows of it, and its status, which decides what is read next.
- **The context** (`garmentContext`, `garment-context.ts`): one row of scalar subqueries (`selectScalars`, `src/db/select-scalars.ts`), since they share no rows; lists arrive as JSON. Which parts are read is decided there and nowhere else, from the status and the access, and a part the page does not show is never read:
  - `capsules`: the capsules row (`capsulesOfGarmentSql`), for anything owned, anyone who sees it;
  - `replaces`: the garment it replaces (`garmentRefSql`), when it names one;
  - `replacedBy`: "On the wishlist" (`replacementsOfSql`), for a closet garment;
  - `own`: **the owner's records, read only for the owner of an owned garment**: the wear line (`wearSummarySql`, its repair sum included), "In N outfits" (`outfitsWithGarmentSql`: the count and the newest `GARMENT_OUTFITS_SHOWN` with their garments; no notes or shareable id, which the strip never showed), "Never paired with" (`avoidedWithSql`) and the repair log (`repairLogSql`; "Spent on it" is the wear line's sum, `RepairLog.total`);
  - `goesWith`: "Goes with my closet"'s inputs for the owner's wishlist item (`goesWithInputsSql`: the item, the whole closet, the avoided pairs; `judgeGoesWithCloset` searches them after the statement);
  - `brandSize`: the owner's note for a wishlist item's brand (`brandSizeSql`);
  - `suggestion`: an agent suggestion's provenance and its need with the need's picks (`suggestionContextSql`, #333), for anyone who sees it, read only when `suggested_at` is set (`findGarment` carries it).
- **So**: the owner's closet garment and their wishlist item are 3 statements, and so is a grantee's page (4 until #170). Before #160 the owner's page was 9 (seven reads in parallel after the garment, each its own round trip and pool connection) and the wishlist item 7.

## Wore today, Washed and Where it is

Each writer refuses what it may not change itself: `setWoreToday` is one statement (a CTE finds the owner's garment and the write reads it; `'not-found'` or `'wishlist'` write nothing), `markWashed` and `setAway` filter by `ownedGarment`. So the routes look nothing up before writing; only a write that changed nothing reads the garment, to answer 404 or 409 (`refusalOf`, `src/web/wears/routes.tsx`). The htmx answer, `#garment-wear-status`, is `wearStatusOf`: the garment's wear fields and `wearSummarySql` in one statement. Wore today and Washed are 3 statements (the session, the write, the answer), Where it is 2. Before #160 they were 6 and 5.

## Gotchas

- **Drizzle writes a single-table select's columns unqualified, inside embedded `sql` fragments too.** `db.select({ ..., summary: wearSummarySql(...) }).from(garment)` renders the subquery's `"garment"."id"` and `"garment_wear"."day"` as `"id"` and `"day"`, and Postgres calls `"id"` ambiguous. A fragment that names its own tables rides in `selectScalars` (a bare `select` through `db.execute`, which qualifies every column), never as a column of a one-table Drizzle select.
- **JSON has no numeric or date**: a `numeric` in `json_build_object` arrives as a number (`25.00` as `25`), so `repairLogSql` and `wearStatusOf` cast costs and prices `::text`; a `date` arrives as its ISO string, which is what the `mode: 'string'` columns hold anyway.
