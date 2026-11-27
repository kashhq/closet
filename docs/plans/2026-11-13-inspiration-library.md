# Inspiration library and "recreate this look" (#22)

Status: recommendations adopted by the coordinator 2026-11-13 under the owner's standing instruction to keep building on plan recommendations; the owner may veto any decision in "Owner decisions".

## 1. What exists

- **Link import** (`src/web/wardrobe/link-import/`): `importLink` fetches a page or an image through
  the outbound fetcher, `extractProduct` reads JSON-LD, Open Graph and `<title>`, up to 6 image
  candidates become previews, and the pick is stored as a **pending photo** (bytes plus a
  `pending_photo` row, claimed by the save). A shop that refuses us is `blocked-by-site`, never retried.
- **The share target** (`share_target` in `src/web/shell/manifest.ts`) is a GET to the link page that
  fetches nothing until the person taps Fetch. It has one destination today.
- **Photos** (`src/web/files/`): `Photos.storeUpload` writes the bytes, the caller inserts the `file`
  row in its own transaction. The cutout queue (`src/cutout/`, BiRefNet, one child process, a state
  machine in `state.ts`) makes a cutout of every uploaded photo.
- **Matching** (`src/wardrobe/generator.ts`, `goes-with.ts`, `outfit-rules.ts`): `categoryRole` gives
  a garment's role, `colorsGoTogether` and `neutralFor` judge colours, `hardRules().compatible`
  judges a set, `goesWith` finds the best outfits holding one garment, and `goes_with_closet`
  already judges a **wishlist item** against the closet. `createOutfit` (`outfits/pick.ts`) saves an
  outfit and accepts a wishlist garment while nothing holds the outfit (#335).
- **Muse** (`src/web/mcp/`): suggests wishlist garments and outfits; the owner reacts.

Nothing stores a look the owner *saw*, and nothing maps a look to the closet.

## 2. What an inspiration is

A saved look: **a photo** (uploaded, or shared from another app through the share target) **or a link**
(a pasted URL: a lookbook page, a pin, a post), with an optional note and the **pieces** the owner
read in it. It is the owner's own and private, like the style profile; nothing in it is a garment
until the owner says so.

Three ways in, one writer (`saveInspiration`):
- **Upload** on the Inspiration page: the add sheet's photo input (`photo-input.js`), a native `PostForm`.
- **Share**: the manifest gets a second share target, or the existing one learns to route. A shared
  image file needs a **POST** `multipart/form-data` target, which breaks the GET rule ("a GET never
  writes") and has to pass the same-origin check. Recommendation: keep the link target as it is, add
  `POST /inspiration/share` for files only, and open the saved look's page on success (the person has
  already chosen to share, so a post is the intent). A shared link opens the same page it does today,
  with "Save as inspiration" beside "Add from a link".
- **Paste a URL**: through `importLink` with `accept: ['html', 'image']`, so the outbound fetcher,
  `LINK_IMPORT_LIMIT`, the 2 MB cap and `blocked-by-site` all apply. A blocked page keeps the link and
  asks for a photo (the person can screenshot it). Social pages mostly block us; this is honest, not a bug.

## 3. Storage

- `inspiration` (owner_id, id, title, note, source_url, photo_id nullable, created_at): at least one
  of `photo_id` and `source_url` by check constraint; `owner_id` indexed, cascade on user delete.
- `inspiration_piece` (inspiration_id, position, role, type, colors[], pattern, matched_garment_id
  nullable, `ON DELETE SET NULL`, indexed): what the owner read. Roles, types, colours and patterns
  come from `properties.ts`, checked in the database like `outfit_rule`'s matchers.
- **The photo** goes through the existing pipeline: `Photos.storeUpload`, `insertPhotoRow` with the
  row, pending photos while a form is open, a cap per user. The cutout is **not** queued: a look is
  a whole picture, a cutout of it would remove the person's outfit with the background. So the
  cutout state is `none` for these rows, and `references.ts` learns that `inspiration.photo_id`
  references a file and is **private** (never public by name, like a selfie). Reconciliation and
  account deletion each gain the new reference, the way selfies did (`deleteVariants` after commit).

## 4. "Recreate this look"

**Reading the look (v1: the owner tags it).** The look's page shows the photo and "Add a piece": each
piece is a role (top, bottom, layer, shoes, accessory...), a type, up to two colours and a pattern,
the same picker the garment form uses. When the look came from a link, `extractProduct` and
`guess.ts` pre-fill what the page says (a title naming "navy blazer" becomes a layer, navy), which the
owner confirms; this is a hint, never a result. The page's own words rarely name every piece, so
manual tagging is the real v1.

**Automatic recognition is out of v1.** Finding the garments in a photo and naming their type and
colour needs a vision model (a detector or a multimodal LLM). The server has none: BiRefNet only
separates foreground from background, and it cannot say what the foreground is. It can help one
narrow thing, a **colour read of a tagged piece**: the owner taps a region, and the cutout's pixels
give a dominant colour mapped onto `GARMENT_COLORS`. That is a possible slice after v1 (see 6),
not a promise. A hosted vision model is an outbound call with the owner's photos: a decision for
section 7, and it would go through `createOutboundFetcher` or an MCP route, never the client.

**Matching a piece to the closet** is a pure module, `src/wardrobe/recreate.ts`, beside `goes-with.ts`:
- candidates are the closet's garments of the piece's role (`inCloset`, available ones first);
- score by type equal, then colour equal (the stored `GARMENT_COLORS`; a close shade, e.g. navy and
  black, scores lower), then pattern; a tie goes to the most rested (`rotationWeight`);
- **the matches must go together**: the top match per piece is checked with `hardRules().compatible`
  and `colorsGoTogether`; when the best set clashes (the look pairs them, the closet's closest do not),
  the next-best for the loudest piece is tried, and the page says which one it could not fix;
- a piece with no candidate above a floor is **missing**. Same function serves the page and MCP.

**The match view** (`/inspiration/:id/recreate`): the photo above, each piece with its top 3 matches
as a `SnapStrip` (swipe to choose), and each missing piece as "Find this". Then:
- **Save as an outfit**: `createOutfit` with the chosen garments, named after the look. Missing pieces
  are left out (a complete outfit), or "Save with wishlist pieces" adds the wishlist items from "Find
  this" (allowed by #335 while nothing holds it).
- **Find this** creates a wishlist garment from the piece (role, type, colour pre-filled, and the look's
  link as its product link) through the ordinary wishlist writer: it lands in the inbox like any item,
  and "Goes with my closet" then judges it.

## 5. Surfaces, MCP, sharing, rules

- **Navigation.** An **Inspiration** tab on the Outfits page (Saved, Ideas, Inspiration) through
  `OutfitTabs`/`LinkTabs`; the dock does not grow (five tabs already). `/inspiration` is under the
  `outfits` section in `sections.ts`. The list is a two-column grid like Saved's, each tile with its
  piece count and "n of m in your closet"; the look's page (photo, note, link, pieces) and the match
  view are two pages in `src/web/inspiration/` (a plugin, `AGENTS.md` beside it, a row in the area
  index and the docs index).
- **Server owns the HTML**: htmx for the match strips and picks, native `PostForm`s for every write,
  the piece form built with `FormField`/`inputAttributes`, every string in `lang.json`. Images only from
  `/file/**` (the CSP allows no other origin); a link's remote image is never shown, only stored.
- **Offline-first.** The list and a look's page are cached reads showing freshness; the add and the
  save are disabled offline with a reason, not queued (a photo upload is not in the queued-writes
  design, `2026-11-12-offline-queued-writes.md`).
- **MCP** (`tools/inspiration.ts`): `list_inspiration` and `get_inspiration` (pieces and the matches,
  the same function as the page) are reads; writes are `add_inspiration` (a URL through `importLink`;
  `blocked-by-site` leads the error as for link import, `MCP_LINK_IMPORT_LIMIT` applies) and
  `set_inspiration_pieces` (so Muse reads a link's text and tags it, which is the vision step done by
  the agent with no server model). Muse may then `suggest` the missing pieces as ordinary wishlist
  suggestions. `tools.md` and the contract spec list them.
- **Sharing: owner-only**, stated in `src/web/sharing/AGENTS.md`: `sessionUserId` alone, no `?ownerId=`,
  a row in `authorization-*.routes.ts` (another user's look is a 404, a grantee gets nothing). Matches
  read the owner's closet alone, as ideas do.

## 6. Tests and slices

- **Unit** (`recreate.spec.ts`): type, colour and pattern ranking; the clash re-pick; a missing piece;
  determinism; a closet with no garment of a role.
- **Integration:** upload, paste, share POST and the blocked page (fixtures from `link-sites.ts`);
  tagging and a 400 for a bad value; the match page; save as outfit and "Find this" creating one
  wishlist garment; deleting a garment (`SET NULL`), a look and its photo (bytes unlinked, reconcile
  clean); the owner-only matrix; one statement for the match page, counted.
- **No new Playwright scenario**: nothing here needs a browser but the share sheet, which no test can
  open. The share target is checked on a phone by hand before it is called done.

Slices, each at most M:
- **22a:** `inspiration` and `inspiration_piece`, the photo through the pipeline and its references,
  the Inspiration tab with upload and paste, the look's page.
- **22b:** `recreate.ts` and its specs; the piece form with metadata pre-fill; the match view.
- **22c:** save as an outfit, "Find this" to the wishlist.
- **22d:** the share POST target and the link's "Save as inspiration"; MCP's four tools.
- **Later:** a colour read from the cutout; a vision model, if the owner decides to take one.

## 7. Owner decisions

1. **Reading a look: manual tagging or a vision model in v1?** Recommend **manual tagging**, with the
   page's metadata as a hint and Muse able to tag through MCP. A vision model is a new dependency, a
   cost and a privacy question (photos leave the house); revisit it once tagging shows how often
   it is tedious.
2. **Where it lives.** Recommend a **tab on Outfits** (Saved, Ideas, Inspiration): a look is the
   start of an outfit, and the dock stays at five. The alternative, a Wardrobe tab, mixes looks
   with garments.
3. **Share target.** Recommend adding a **POST target for images** only (links keep the GET that
   fetches nothing). Alternative: links only, and photos by upload.
4. **Cutout for the photo.** Recommend **none** (a look is a whole picture).
5. **Missing pieces.** Recommend "Find this" creating a **wishlist item** at once (one tap, reversible)
   rather than a confirm step; "save with wishlist pieces" off by default.
6. **Shared closets.** Recommend **owner-only** like the style profile, since a look is taste.
