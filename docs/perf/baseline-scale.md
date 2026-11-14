# Page audit

Commit `08d9927`, persona `scale`, 2026-11-14T19:48:11.423Z. 20 runs per step after 3 warm-up, 10 × Apple M4, Node v22.23.3, load average 10.1 at the start and 2.7 at the end. Server ms is the request in process (`inject`), db ms Server-Timing’s `db`; statements and rows are the median run’s, with the range when runs differed; KB decompressed, and as sent with `br`.

## #158 Today

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Today | `GET /` | 200 | 23.4 | 31.7 | 19.0 | 3 | 3 | 36.7 | 8.3 |
| Refresh an ideas row | `GET /today/ideas` | 200 | 14.3 | 24.7 | 11.7 | 2 | 2 | 8.7 | 2.0 |
| Weather summary | `GET /weather/summary` | 200 | 2.1 | 5.4 | 1.1 | 2 | 2 | 1.9 | 0.4 |
| Wear this | `POST /today/wear` | 303 | 4.6 | 6.9 | 4.3 | 7 | 7 | 0.0 | 0.0 |
| Wore it (from Today) | `POST /calendar/:id/worn` | 303 | 4.0 | 6.6 | 3.6 | 6 | 4 | 0.0 | 0.0 |
| Reminders form (this device) | `POST /push/reminders/form` | 200 | 1.8 | 4.0 | 0.7 | 2 | 2 | 3.5 | 0.9 |
| Save reminders | `POST /push/reminders` | 200 | 6.1 | 7.8 | 4.1 | 2 | 2 | 0.0 | 0.0 |

## #159 Wardrobe grid

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Grid | `GET /wardrobe` | 200 | 6.5 | 12.6 | 6.0 | 3 | 51 | 63.2 | 11.6 |
| Grid fragment (scope row, filters) | `GET /wardrobe` | 200 | 6.0 | 11.8 | 4.9 | 3 | 51 | 42.0 | 6.3 |
| Search | `GET /wardrobe` | 200 | 19.5 | 24.8 | 28.6 | 3 | 44 | 60.5 | 11.1 |
| Filters: category, colour, warmth | `GET /wardrobe` | 200 | 6.2 | 12.7 | 4.5 | 3 | 44 | 62.5 | 11.3 |
| Care filters: needs a wash, attention | `GET /wardrobe` | 200 | 5.7 | 11.7 | 4.5 | 3 | 2 | 45.0 | 8.9 |
| Show archived | `GET /wardrobe` | 200 | 5.7 | 12.7 | 4.3 | 3 | 51 | 63.7 | 11.7 |
| Capsule filter | `GET /wardrobe` | 200 | 5.5 | 11.6 | 4.3 | 3 | 31 | 55.4 | 10.6 |
| Next page (tiles) | `GET /wardrobe/tiles` | 200 | 2.5 | 6.2 | 1.1 | 2 | 50 | 19.8 | 2.8 |
| Select mode | `GET /wardrobe` | 200 | 3.1 | 8.1 | 1.8 | 3 | 51 | 58.7 | 9.4 |
| Capsule picker | `GET /wardrobe` | 200 | 3.6 | 8.6 | 1.4 | 3 | 51 | 50.1 | 8.1 |
| Tagging mode | `GET /wardrobe/tag` | 200 | 2.3 | 5.7 | 1.0 | 2 | 1 | 16.3 | 4.5 |
| Laundry tab | `GET /laundry` | 200 | 4.3 | 10.0 | 3.1 | 3 | 17 | 39.4 | 7.6 |
| Capsules tab | `GET /capsules` | 200 | 2.9 | 8.3 | 1.5 | 2 | 2 | 29.9 | 7.2 |
| A capsule | `GET /capsules/:id` | 200 | 3.0 | 7.0 | 2.8 | 4 | 32 | 28.5 | 6.7 |
| New capsule form | `GET /capsules/new` | 200 | 1.2 | 4.2 | 0.3 | 1 | 1 | 16.3 | 4.7 |
| Edit capsule form | `GET /capsules/:id/edit` | 200 | 1.4 | 5.2 | 0.5 | 2 | 2 | 16.6 | 4.8 |
| Bulk edit (select mode’s Set…) | `POST /wardrobe/bulk` | 303 | 12.7 | 16.0 | 10.4 | 5 | 3 | 0.0 | 0.0 |
| Tag a garment | `POST /wardrobe/:id/tag` | 200 | 11.6 | 13.5 | 5.6 | 3 | 3 | 2.7 | 0.5 |
| Laundry: washed | `POST /laundry` | 303 | 10.7 | 11.7 | 7.5 | 2 | 2 | 0.0 | 0.0 |
| New capsule | `POST /capsules` | 303 | 4.5 | 6.9 | 4.1 | 4 | 2 | 0.0 | 0.0 |
| Edit capsule | `POST /capsules/:id` | 303 | 7.8 | 12.4 | 5.3 | 3 | 3 | 0.0 | 0.0 |
| Capsule members (picker save) | `POST /capsules/:id/garments` | 303 | 7.4 | 15.0 | 5.6 | 6 | 2 | 0.0 | 0.0 |
| Delete capsule | `DELETE /capsules/:id` | 200 | 4.4 | 7.0 | 3.3 | 2 | 2 | 0.0 | 0.0 |

## #160 Garment page

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Garment page | `GET /wardrobe/:id` | 200 | 5.0 | 11.8 | 2.7 | 3 | 3 | 48.2 | 10.8 |
| Wore today | `POST /wardrobe/:id/wear` | 200 | 3.2 | 4.0 | 2.5 | 3 | 3 | 2.6 | 0.8 |
| Washed | `POST /wardrobe/:id/washed` | 200 | 3.3 | 3.7 | 2.8 | 3 | 3 | 1.7 | 0.7 |
| Where it is (away) | `POST /wardrobe/:id/away` | 200 | 2.9 | 3.4 | 2.4 | 2 | 2 | 0.0 | 0.0 |
| Condition | `POST /wardrobe/:id/condition` | 200 | 3.2 | 7.0 | 2.5 | 2 | 2 | 0.0 | 0.0 |
| Capsules row (saved on change) | `POST /wardrobe/:id/capsules` | 200 | 10.7 | 12.3 | 8.3 | 5 | 2 | 0.0 | 0.0 |
| Log a repair | `POST /wardrobe/:id/repairs` | 303 | 15.4 | 18.7 | 11.8 | 7 | 5 | 0.0 | 0.0 |
| Delete a repair | `POST /wardrobe/:id/repairs/:repairId/delete` | 303 | 15.5 | 19.8 | 11.9 | 6 | 4 | 0.0 | 0.0 |
| Archive | `POST /wardrobe/:id/archive` | 200 | 9.3 | 11.6 | 7.8 | 5 | 2 | 0.0 | 0.0 |
| Restore | `POST /wardrobe/:id/restore` | 200 | 11.6 | 15.9 | 9.6 | 5 | 2 | 0.0 | 0.0 |

## #161 Add and edit a garment

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Add form | `GET /wardrobe/new` | 200 | 2.5 | 6.3 | 1.1 | 2 | 2 | 33.4 | 7.5 |
| Edit form | `GET /wardrobe/:id/edit` | 200 | 3.3 | 8.2 | 1.4 | 3 | 3 | 39.9 | 8.7 |
| Clone form | `GET /wardrobe/:id/clone` | 200 | 4.0 | 8.8 | 1.8 | 3 | 3 | 40.5 | 8.9 |
| Properties after a category change | `POST /wardrobe/properties-fragment` | 200 | 1.1 | 3.2 | 0.4 | 1 | 1 | 4.7 | 0.7 |
| Lookalike check | `GET /wardrobe/lookalikes` | 200 | 1.3 | 3.7 | 0.9 | 2 | 2 | 0.1 | 0.1 |
| Link page | `GET /wardrobe/new/from-link` | 200 | 1.2 | 3.5 | 0.3 | 1 | 1 | 16.4 | 4.8 |
| Save a new garment | `POST /wardrobe` | 302 | 8.4 | 10.6 | 5.8 | 2 | 2 | 0.0 | 0.0 |
| Save an edit | `POST /wardrobe/:id` | 302 | 6.5 | 9.0 | 5.0 | 2 | 2 | 0.0 | 0.0 |
| Import a link | `POST /wardrobe/new/from-link` | 200 | 37.0 | 43.7 | 8.5 | 6 | 3 | 38.2 | 8.4 (8.4–8.4) |
| Choose a link’s photo | `POST /wardrobe/new/from-link/photo` | 200 | 30.6 | 30.9 | 7.0 | 5 | 2 | 0.4 | 0.4 |
| Add from a photo (upload) | `POST /wardrobe/new/photo` | 303 | 31.4 | 35.6 | 7.7 | 6 | 4 | 0.0 | 0.0 |
| Add form with a pending photo | `GET /wardrobe/new` | 200 | 4.4 | 5.1 | 3.0 | 2 | 2 | 33.7 | 7.7 (7.7–7.7) |
| Clone | `POST /wardrobe/:id/clone` | 302 | 29.3 | 37.5 | 9.2 | 6 | 4 | 0.0 | 0.0 |
| Add a copy | `POST /wardrobe/:id/copies` | 303 | 4.7 | 5.6 | 4.5 | 5 | 3 | 0.0 | 0.0 |
| Delete a garment | `DELETE /wardrobe/:id` | 200 | 7.9 | 11.1 | 6.7 | 4 | 2 | 0.0 | 0.0 |
| Save with a pending photo | `POST /wardrobe` | 302 | 10.1 | 20.3 | 9.8 | 7 | 5 | 0.0 | 0.0 |
| Add several photos (a batch of drafts) | `POST /wardrobe/new/photo` | 303 | 131.3 | 189.6 | 8.9 | 7 | 4 | 0.0 | 0.0 |
| A draft’s form | `GET /wardrobe/new` | 200 | 7.0 | 10.0 | 2.3 | 2 | 2 | 35.4 | 8.1 (8.1–8.1) |
| Save a draft | `POST /wardrobe` | 303 | 10.0 | 14.4 | 8.7 | 7 | 5 | 0.0 | 0.0 |
| Discard a draft | `POST /wardrobe/new/drafts/discard` | 303 | 7.1 | 9.2 | 5.3 | 5 | 3 | 0.0 | 0.0 |

## #162 Photos and cutouts

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Original | `GET /file/:fileName` | 200 | 0.5 | 0.9 | 0.0 | 0 | 0 | 10.7 | 10.7 |
| Cutout | `GET /file/nobg/:fileName` | 200 | 0.4 | 0.8 | 0.0 | 0 | 0 | 14.3 | 14.3 |
| Thumb | `GET /file/thumb/:fileName` | 200 | 0.4 | 0.7 | 0.0 | 0 | 0 | 12.2 | 12.2 |
| Thumb, unsigned (an old page) | `GET /file/thumb/:fileName` | 200 | 0.8 | 2.4 | 0.5 | 1 | 1 | 12.2 | 12.2 |
| Thumb, regenerated | `GET /file/thumb/:fileName` | 200 | 25.1 | 37.8 | 0.7 | 1 | 1 | 12.2 | 12.2 |
| Cutout poll (pending page) | `GET /wardrobe/:id/cutout` | 200 | 2.9 | 4.5 | 1.6 | 2 | 2 | 1.8 | 0.7 |
| Upload a photo | `POST /wardrobe/:id/photo` | 303 | 57.4 | 63.3 | 10.3 | 8 | 5 | 0.0 | 0.0 |
| Save a mask edit | `POST /wardrobe/:id/nobg` | 200 | 50.1 | 105.9 | 9.6 | 6 | 4 | 0.2 (0.2–0.2) | 0.2 (0.2–0.2) |
| Rotate the photo | `POST /wardrobe/:id/photo/rotate` | 303 | 39.2 | 43.5 | 12.5 | 9 | 6 | 0.0 | 0.0 |
| Try the cutout again | `POST /wardrobe/:id/cutout/retry` | 303 | 4.8 | 6.1 | 4.1 | 5 | 3 | 0.0 | 0.0 |

## #163 Styling

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Styling | `GET /styling` | 200 | 7.6 | 10.4 | 3.0 | 2 | 2 | 102.3 | 11.5 |
| Style this (?with=) | `GET /styling` | 200 | 23.6 | 26.3 | 15.1 | 3 | 3 | 140.8 | 14.1 |
| Edit an outfit (?outfit=) | `GET /styling` | 200 | 9.4 | 12.5 | 4.1 | 2 | 2 | 124.3 | 13.1 |
| For a planned evening (?for=) | `GET /styling` | 200 | 8.4 | 10.2 | 3.4 | 2 | 2 | 102.5 | 11.5 |
| Shuffle, one row locked | `GET /styling/shuffle` | 200 | 23.5 | 25.3 | 16.2 | 3 | 3 | 117.8 | 8.6 |
| Add a row | `GET /styling/row` | 200 | 7.5 | 9.4 | 3.5 | 2 | 2 | 82.1 | 6.4 |
| Strip paging | `GET /styling/garments` | 200 | 3.6 | 5.2 | 1.6 | 2 | 12 | 8.5 | 1.1 |
| Old builder link (/outfits/new) | `GET /outfits/new` | 302 | 1.2 | 1.9 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Old edit link (/outfits/:id/edit) | `GET /outfits/:id/edit` | 302 | 1.0 | 1.7 | 0.5 | 1 | 1 | 0.0 | 0.0 |
| Save an outfit | `POST /styling` | 303 | 8.7 | 11.4 | 7.7 | 6 | 4 | 0.0 | 0.0 |
| Save refused, the page again (an archived garment) | `POST /styling` | 409 | 13.4 | 17.8 | 8.4 | 7 | 6 | 112.1 | 12.3 |

## #164 Outfits and saved outfits

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Outfits (Saved) | `GET /outfits` | 200 | 8.1 | 18.7 | 5.7 | 2 | 2 | 71.9 | 11.7 |
| Saved, a deep page (tiles) | `GET /outfits/tiles` | 200 | 4.7 | 9.7 | 2.9 | 2 | 2 | 56.0 | 6.9 |
| Saved, picking for a day | `GET /outfits` | 200 | 7.0 | 11.8 | 3.4 | 2 | 2 | 78.2 | 11.9 |
| Outfit page (Worn strip) | `GET /outfits/:id` | 200 | 4.4 | 8.7 | 1.8 | 2 | 2 | 110.2 | 7.9 |
| Create an outfit | `POST /outfits` | 302 | 6.3 | 7.0 | 5.9 | 6 | 3 | 0.0 | 0.0 |
| Edit an outfit | `POST /outfits/:id` | 302 | 5.3 | 7.8 | 4.8 | 7 | 5 | 0.0 | 0.0 |
| Delete an outfit | `DELETE /outfits/:id` | 200 | 3.8 | 5.5 | 3.3 | 7 | 5 | 0.0 | 0.0 |

## #165 Calendar and week plan

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Week agenda | `GET /calendar` | 200 | 6.2 | 12.4 | 3.1 | 2 | 2 | 109.1 | 11.6 |
| Next week | `GET /calendar` | 200 | 5.7 | 10.6 | 3.3 | 2 | 2 | 79.4 | 10.3 |
| Month collages | `GET /calendar/month` | 200 | 5.2 | 9.4 | 3.3 | 2 | 2 | 56.8 | 9.6 |
| Last month | `GET /calendar/month` | 200 | 5.5 | 9.4 | 3.4 | 2 | 2 | 61.0 | 9.1 |
| Month weather chips | `GET /weather/summary` | 200 | 2.0 | 4.1 | 1.2 | 2 | 2 | 3.6 | 0.3 |
| + Plan sheet | `GET /calendar/plan` | 200 | 6.2 | 10.1 | 3.3 | 2 | 2 | 70.3 | 11.5 |
| Selfie | `GET /selfies/:fileName` | 200 | 1.8 | 3.9 | 0.9 | 2 | 2 | 13.4 | 13.4 |
| Selfie thumb | `GET /selfies/thumb/:fileName` | 200 | 1.3 | 3.2 | 0.7 | 2 | 2 | 3.2 | 3.2 |
| Plan an outfit on a day | `POST /calendar` | 302 | 3.8 | 4.2 | 3.4 | 6 | 4 | 0.0 | 0.0 |
| Remove a planned entry | `POST /calendar/:id/delete` | 303 | 3.5 | 5.1 | 3.0 | 6 | 3 | 0.0 | 0.0 |
| Mark worn (calendar) | `POST /calendar/:id/worn` | 303 | 3.6 | 4.5 | 3.3 | 6 | 4 | 0.0 | 0.0 |
| Plan my week | `POST /calendar/plan-week` | 303 | 4.1 | 5.9 | 3.7 | 6 | 4 | 0.0 | 0.0 |
| Undo Plan my week | `POST /calendar/plan-week/:id/undo` | 303 | 4.3 | 5.5 | 3.9 | 8 | 5 | 0.0 | 0.0 |
| Save the week template | `POST /auth/profile/week` | 303 | 3.0 | 3.7 | 2.8 | 5 | 1 | 0.0 | 0.0 |
| Add a selfie | `POST /calendar/:id/selfie` | 303 | 35.1 | 41.2 | 9.1 | 10 | 6 | 0.0 | 0.0 |
| Remove a selfie | `POST /selfies/:id/delete` | 303 | 5.8 | 6.5 | 5.0 | 2 | 2 | 0.0 | 0.0 |

## #166 Trips and packing

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Trips | `GET /trips` | 200 | 1.9 | 4.7 | 0.8 | 2 | 2 | 16.0 | 4.7 |
| Trip page and packing list | `GET /trips/:id` | 200 | 5.7 | 9.2 | 3.4 | 2 | 2 | 52.9 | 8.1 |
| New trip form | `GET /trips/new` | 200 | 1.8 | 4.8 | 0.6 | 1 | 1 | 17.3 | 4.9 |
| Edit trip form | `GET /trips/:id/edit` | 200 | 1.9 | 4.8 | 0.7 | 2 | 2 | 17.3 | 4.9 |
| Add-an-outfit page | `GET /trips/:id/outfits/new` | 200 | 6.1 | 10.3 | 3.7 | 2 | 2 | 70.5 | 11.5 |
| Trip weather | `GET /trips/:id/weather` | 200 | 1.4 | 3.0 | 0.9 | 2 | 2 | 0.1 | 0.1 |
| Ideas for the trip | `GET /outfits/ideas` | 200 | 18.7 | 23.8 | 15.3 | 3 | 3 | 41.6 | 7.4 |
| Create a trip | `POST /trips` | 303 | 5.6 | 7.4 | 5.2 | 5 | 2 | 0.0 | 0.0 |
| Edit a trip | `POST /trips/:id` | 303 | 9.1 | 12.2 | 7.7 | 5 | 3 | 0.0 | 0.0 |
| Delete a trip | `DELETE /trips/:id` | 200 | 6.1 | 11.6 | 5.0 | 2 | 2 | 0.0 | 0.0 |
| Add an outfit to the trip | `POST /trips/:id/outfits` | 303 | 10.4 | 13.9 | 8.6 | 5 | 3 | 0.0 | 0.0 |
| Remove a trip outfit | `POST /trips/:id/outfits/:tripOutfitId/delete` | 303 | 9.5 | 14.8 | 7.6 | 5 | 2 | 0.0 | 0.0 |
| Wear on a trip day | `POST /trips/:id/outfits/:tripOutfitId/wear` | 303 | 3.7 | 4.1 | 3.3 | 6 | 4 | 0.0 | 0.0 |
| Pack garments | `POST /trips/:id/packed` | 303 | 3.4 | 4.2 | 2.8 | 2 | 2 | 0.0 | 0.0 |
| Add a packing item | `POST /trips/:id/items` | 303 | 1.9 | 2.6 | 1.5 | 2 | 2 | 0.0 | 0.0 |
| Pack items | `POST /trips/:id/items/packed` | 303 | 2.3 | 4.3 | 1.9 | 2 | 2 | 0.0 | 0.0 |
| Remove a packing item | `POST /trips/:id/items/:itemId/delete` | 303 | 2.2 | 2.7 | 1.8 | 2 | 2 | 0.0 | 0.0 |
| Copy another trip’s items | `POST /trips/:id/items/copy` | 303 | 2.5 | 2.7 | 2.0 | 2 | 2 | 0.0 | 0.0 |
| Destination search | `GET /trips/:id/places` | 200 | 1.1 | 1.5 | 0.4 | 2 | 2 | 0.5 | 0.5 |
| Set the destination | `POST /trips/:id/destination` | 303 | 2.1 | 2.7 | 1.8 | 2 | 2 | 0.0 | 0.0 |

## #167 Wishlist and Bought it

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Wishlist | `GET /wardrobe/wishlist` | 200 | 6.4 | 10.4 | 4.3 | 2 | 2 | 26.2 | 6.9 |
| Wishlist item | `GET /wardrobe/:id` | 200 | 41.8 | 78.0 | 3.1 | 3 | 3 | 33.3 | 8.9 |
| Wishlist form | `GET /wardrobe/new` | 200 | 8.2 | 11.4 | 5.1 | 3 | 3 | 57.1 | 10.8 |
| Bought it form | `GET /wardrobe/:id/bought` | 200 | 3.3 | 6.2 | 1.9 | 3 | 3 | 16.7 | 4.8 |
| Style profile | `GET /auth/profile/style` | 200 | 6.1 | 10.9 | 3.7 | 2 | 2 | 90.0 | 10.3 |
| From your orders | `GET /wardrobe/orders` | 200 | 2.3 | 4.5 | 1.1 | 2 | 7 | 21.0 | 4.9 |
| Bought it | `POST /wardrobe/:id/bought` | 303 | 4.3 | 5.3 | 4.0 | 11 | 4 | 0.0 | 0.0 |
| Save the style profile | `POST /auth/profile/style` | 303 | 2.1 | 3.4 | 1.7 | 2 | 1 | 0.0 | 0.0 |
| Add an order item to the closet | `POST /wardrobe/orders/:id/add` | 200 | 40.3 | 45.6 | 10.2 | 7 | 5 | 38.4 | 8.4 (8.4–8.4) |
| Dismiss an order item | `POST /wardrobe/orders/:id/dismiss` | 303 | 2.2 | 2.6 | 2.0 | 2 | 2 | 0.0 | 0.0 |

## #168 Ideas gallery

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Ideas | `GET /outfits/ideas` | 200 | 19.1 | 20.5 | 12.2 | 2 | 2 | 52.1 | 8.0 |
| Ideas for a planned evening | `GET /outfits/ideas` | 200 | 19.7 | 21.1 | 12.6 | 2 | 2 | 58.1 | 8.1 |
| Ideas with a garment | `GET /outfits/ideas` | 200 | 21.2 | 23.4 | 13.5 | 3 | 3 | 54.3 | 7.8 |
| More ideas (page 2) | `GET /outfits/ideas/more` | 200 | 17.6 | 20.1 | 12.4 | 2 | 2 | 33.9 | 3.0 |
| More ideas (page 50, the cap) | `GET /outfits/ideas/more` | 200 | 39.2 | 42.3 | 12.9 | 2 | 2 | 33.6 | 2.8 |
| Pick an idea | `POST /outfits/ideas/pick` | 303 | 4.5 | 7.3 | 3.8 | 6 | 6 | 0.0 | 0.0 |
| Never pair these (clash) | `POST /outfits/ideas/avoid` | 303 | 1.8 | 2.6 | 1.0 | 2 | 2 | 0.0 | 0.0 |
| Pair them again | `POST /outfits/ideas/allow` | 303 | 1.7 | 2.2 | 0.9 | 2 | 2 | 0.0 | 0.0 |
| Too warm | `POST /outfits/ideas/feedback` | 303 | 1.7 | 2.2 | 1.0 | 2 | 2 | 0.0 | 0.0 |

## #169 Insights and yearly recap

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Insights | `GET /wardrobe/insights` | 200 | 15.8 | 20.7 | 13.7 | 3 | 503 | 73.8 | 11.0 |
| Insights, unworn 30 days | `GET /wardrobe/insights` | 200 | 14.2 | 22.5 | 12.4 | 3 | 503 | 73.8 | 11.0 |
| Year in review | `GET /wardrobe/recap` | 200 | 10.2 | 17.9 | 10.7 | 3 | 506 | 30.6 | 7.0 |
| Year in review, last year | `GET /wardrobe/recap` | 200 | 9.3 | 17.0 | 7.5 | 3 | 506 | 30.7 | 7.2 |

## #170 Sharing and shared views

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Shared wardrobe | `GET /wardrobe` | 200 | 3.3 | 7.1 | 1.7 | 3 | 14 | 36.5 | 8.3 |
| Shared garment | `GET /wardrobe/:id` | 200 | 2.7 | 6.8 | 1.1 | 3 | 3 | 25.6 | 7.3 |
| Shared capsules | `GET /capsules` | 200 | 2.6 | 7.1 | 1.1 | 2 | 2 | 25.2 | 6.4 |
| Shared wishlist | `GET /wardrobe/wishlist` | 200 | 2.9 | 6.8 | 1.6 | 2 | 2 | 23.7 | 6.2 |
| Styling a shared wardrobe | `GET /styling` | 200 | 2.8 | 7.0 | 1.1 | 2 | 2 | 55.6 | 7.5 |
| Share page, garment (signed out) | `GET /share` | 200 | 1.4 | 3.7 | 0.5 | 1 | 1 | 9.4 | 3.0 |
| Share page, outfit (signed out) | `GET /share` | 200 | 1.5 | 5.5 | 0.6 | 1 | 1 | 10.0 | 3.1 |
| Share preview image | `GET /file/watermark/:shareableId` | 200 | 12.0 | 23.3 | 0.7 | 1 | 1 | 29.1 | 29.1 |
| Old manage page | `GET /wardrobe-share/manage` | 301 | 1.0 | 2.0 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Create an invite link | `POST /wardrobe-share/create-invite-link` | 200 | 1.8 | 2.2 | 1.5 | 2 | 2 | 0.7 | 0.7 |
| Invite landing | `GET /wardrobe-share/invite/:token` | 200 | 2.4 | 3.3 |  | 2 | 2 | 13.0 (13.0–13.0) | 3.7 (3.7–3.7) |
| Accept an invite | `POST /wardrobe-share/invite/:token/accept` | 302 | 5.0 | 5.8 |  | 3 | 3 | 0.0 | 0.0 |
| Decline an invite | `POST /wardrobe-share/invite/:token/decline` | 302 | 1.6 | 2.2 |  | 2 | 1 | 0.0 | 0.0 |
| Remove a share | `POST /wardrobe-share/:id/remove` | 302 | 4.0 | 4.6 | 3.6 | 2 | 2 | 0.0 | 0.0 |
| Edit a shared garment (MANAGE) | `POST /wardrobe/:id` | 302 | 4.0 | 5.9 | 3.2 | 2 | 2 | 0.0 | 0.0 |

## #171 Auth, account and push

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Profile | `GET /auth/profile` | 200 | 3.0 | 6.7 | 4.7 | 7 | 25 | 34.7 | 8.1 |
| Sign-in page | `GET /auth/login` | 200 | 0.6 | 1.6 | 0.0 | 0 | 0 | 10.1 | 3.1 |
| Registration page | `GET /auth/register` | 200 | 0.6 | 1.4 | 0.0 | 0 | 0 | 10.5 | 3.1 |
| Change email page | `GET /auth/update-email` | 200 | 1.4 | 3.4 | 0.5 | 1 | 1 | 16.7 | 4.7 |
| Change password page | `GET /auth/change-password` | 200 | 1.2 | 3.9 | 0.4 | 1 | 1 | 16.9 | 4.8 |
| Sign out everywhere page | `GET /auth/sign-out-everywhere` | 200 | 1.1 | 4.1 | 0.3 | 1 | 1 | 16.6 | 4.8 |
| Delete account page | `GET /auth/delete-account` | 200 | 1.1 | 3.6 | 0.3 | 1 | 1 | 16.7 | 4.8 |
| Agent access (tokens) | `GET /auth/tokens` | 200 | 1.8 | 5.2 | 0.6 | 2 | 13 | 21.8 | 4.7 |
| Sign-out page | `GET /auth/logout` | 200 | 1.3 | 3.3 | 0.4 | 1 | 1 | 15.3 | 4.4 |
| Sizes | `GET /auth/profile/sizes` | 200 | 2.8 | 6.2 | 1.6 | 3 | 10 | 31.5 | 6.0 |
| Brand size hint | `GET /auth/profile/sizes/hint` | 200 | 1.3 | 3.0 | 0.9 | 2 | 2 | 0.2 | 0.2 |
| VAPID public key | `GET /push/vapid-public-key` | 200 | 0.5 | 1.6 | 0.3 | 1 | 1 | 0.1 | 0.1 |
| Sign in | `POST /auth/login` | 302 | 222.5 | 253.8 |  | 1 | 1 | 0.0 | 0.0 |
| Register | `POST /auth/register` | 302 | 216.7 | 221.8 | 5.7 | 1 | 1 | 0.0 | 0.0 |
| Validate registration (as typed) | `POST /auth/validate/register` | 200 | 0.1 | 0.1 | 0.0 | 0 | 0 | 0.4 | 0.4 |
| Validate an email change | `POST /auth/validate/update-email` | 200 | 0.8 | 1.9 | 0.5 | 1 | 1 | 0.1 | 0.1 |
| Change email | `POST /auth/update-email` | 302 | 219.7 | 223.4 |  | 2 | 2 | 0.0 | 0.0 |
| Change password | `POST /auth/change-password` | 302 | 441.3 | 445.9 |  | 5 | 3 | 0.0 | 0.0 |
| Delete account | `POST /auth/delete-account` | 302 | 227.0 | 229.8 |  | 6 | 3 | 0.0 | 0.0 |
| Create an access token | `POST /auth/tokens` | 200 | 224.9 | 229.7 |  | 6 | 3 | 16.9 | 4.8 (4.8–4.8) |
| Revoke an access token | `POST /auth/tokens/:id/revoke` | 303 | 2.9 | 4.4 | 2.6 | 2 | 2 | 0.0 | 0.0 |
| Sign out | `POST /auth/logout` | 303 | 0.4 | 0.6 | 0.3 | 1 | 1 | 0.0 | 0.0 |
| Subscribe a device | `POST /push/subscribe` | 204 | 2.7 | 3.6 | 2.3 | 2 | 2 | 0.0 | 0.0 |
| Unsubscribe a device | `POST /push/unsubscribe` | 204 | 5.8 | 8.1 | 4.0 | 2 | 2 | 0.0 | 0.0 |
| Send a test notification | `POST /push/test` | 200 | 4.6 | 12.0 | 2.2 | 2 | 25 | 0.1 | 0.1 |
| Sizes: unit | `POST /auth/profile/sizes/unit` | 303 | 5.6 | 7.0 | 3.3 | 2 | 1 | 0.0 | 0.0 |
| Sizes: measurements | `POST /auth/profile/sizes/measurements` | 303 | 7.1 | 10.0 | 4.7 | 3 | 2 | 0.0 | 0.0 |
| Sizes: add a brand | `POST /auth/profile/sizes/brands` | 303 | 5.5 | 10.0 | 4.9 | 4 | 2 | 0.0 | 0.0 |
| Sizes: edit a brand | `POST /auth/profile/sizes/brands/:id` | 303 | 5.5 | 9.3 | 4.3 | 2 | 2 | 0.0 | 0.0 |
| Sizes: remove a brand | `POST /auth/profile/sizes/brands/:id/delete` | 303 | 5.9 | 7.2 | 4.1 | 2 | 2 | 0.0 | 0.0 |
| Weather: city search | `GET /weather/places` | 200 | 4.3 | 5.9 | 1.4 | 1 | 1 | 0.5 | 0.5 |
| Weather: set home | `POST /weather/home` | 200 | 8.6 | 11.3 | 5.4 | 3 | 2 | 1.6 | 0.6 |
| Weather: use this phone’s location | `POST /weather/here` | 200 | 10.1 | 11.7 | 5.8 | 3 | 2 | 1.3 | 0.5 |
| Weather: stop using this phone’s location | `POST /weather/here/clear` | 200 | 7.2 | 10.9 | 4.7 | 3 | 2 | 1.6 | 0.6 |
| Weather: unit | `POST /weather/unit` | 200 | 7.4 | 11.0 | 5.2 | 3 | 2 | 0.9 | 0.9 |
| Weather: feels warmer or colder | `POST /weather/feedback` | 200 | 4.5 | 6.2 | 4.2 | 3 | 3 | 0.8 (0.6–0.8) | 0.8 (0.6–0.8) |
| Weather: reset the offset | `POST /weather/offset/reset` | 200 | 4.4 | 4.9 | 4.1 | 3 | 2 | 0.6 | 0.6 |
| Weather: remove home | `POST /weather/home/clear` | 200 | 5.0 | 5.6 | 4.3 | 3 | 2 | 1.5 | 0.6 |
| Weather: set home again | `POST /weather/home` | 200 | 5.5 | 5.5 | 4.2 | 3 | 2 | 1.6 | 0.6 |

## #172 MCP tools

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| get_today | `mcp get_today` | 200 | 14.4 | 19.1 |  | 3 | 3 | 2.2 (2.2–2.2) | 0.8 (0.8–0.8) |
| search_garments | `mcp search_garments` | 200 | 1.6 | 2.2 |  | 3 | 51 | 11.6 | 0.4 (0.4–0.4) |
| search_garments (keyword) | `mcp search_garments` | 200 | 11.8 | 13.5 |  | 3 | 51 | 12.9 | 0.6 |
| get_wardrobe | `mcp get_wardrobe` | 200 | 8.6 | 10.6 |  | 3 | 1086 | 160.4 | 9.7 (9.7–9.7) |
| get_garment | `mcp get_garment` | 200 | 3.0 | 3.7 |  | 3 | 3 | 3.4 (3.4–3.4) | 0.8 (0.8–0.8) |
| get_garment_photo | `mcp get_garment_photo` | 200 | 2.8 | 6.4 |  | 3 | 3 | 1.1 | 0.7 (0.7–0.7) |
| update_garment | `mcp update_garment` | 200 | 7.3 | 9.3 |  | 4 | 4 | 1.2 | 0.6 (0.6–0.6) |
| add_garment_copy | `mcp add_garment_copy` | 200 | 20.8 | 24.1 |  | 7 | 5 | 0.9 | 0.9 |
| list_wishlist | `mcp list_wishlist` | 200 | 7.7 | 9.7 |  | 2 | 4 | 0.7 | 0.7 |
| add_garment_from_link | `mcp add_garment_from_link` | 200 | 47.8 | 49.6 |  | 13 | 8 | 1.2 | 0.6 |
| list_capsules | `mcp list_capsules` | 200 | 4.4 | 5.1 |  | 2 | 2 | 1.5 | 0.2 (0.2–0.2) |
| get_capsule | `mcp get_capsule` | 200 | 3.3 | 4.6 |  | 3 | 29 | 7.5 | 1.3 (1.3–1.3) |
| set_capsule_membership | `mcp set_capsule_membership` | 200 | 3.8 | 4.3 |  | 5 | 2 | 0.1 | 0.1 |
| list_outfits | `mcp list_outfits` | 200 | 4.9 | 8.0 |  | 2 | 2 | 10.1 | 1.9 (1.9–1.9) |
| get_outfit | `mcp get_outfit` | 200 | 3.2 | 4.0 |  | 2 | 2 | 0.3 | 0.3 |
| create_outfit | `mcp create_outfit` | 200 | 18.6 | 23.4 |  | 7 | 7 | 0.1 | 0.1 |
| schedule_outfit | `mcp schedule_outfit` | 200 | 13.5 | 24.1 |  | 6 | 4 | 0.2 | 0.2 |
| suggest_outfits | `mcp suggest_outfits` | 200 | 16.6 | 21.4 |  | 3 | 26 | 3.9 | 0.9 |
| goes_with_closet | `mcp goes_with_closet` | 200 | 41.0 | 42.2 |  | 2 | 2 | 2.3 | 0.6 (0.6–0.6) |
| pick_outfit | `mcp pick_outfit` | 200 | 6.8 | 8.2 |  | 7 | 7 | 0.2 | 0.2 |
| get_calendar | `mcp get_calendar` | 200 | 7.4 | 8.3 |  | 3 | 26 | 12.1 | 1.5 (1.5–1.5) |
| laundry_status | `mcp laundry_status` | 200 | 9.3 | 12.1 |  | 2 | 16 | 1.8 | 0.4 |
| mark_worn | `mcp mark_worn` | 200 | 2.8 | 3.3 |  | 2 | 2 | 0.1 | 0.1 |
| mark_washed | `mcp mark_washed` | 200 | 3.6 | 4.1 |  | 2 | 2 | 0.1 | 0.1 |
| plan_week | `mcp plan_week` | 200 | 5.8 | 7.0 |  | 6 | 4 | 0.2 | 0.2 |
| list_trips | `mcp list_trips` | 200 | 3.8 | 5.1 |  | 2 | 71 | 12.3 | 0.4 |
| get_trip | `mcp get_trip` | 200 | 7.2 | 12.8 |  | 2 | 2 | 5.5 | 0.9 |
| plan_trip_outfit | `mcp plan_trip_outfit` | 200 | 11.0 | 14.2 |  | 5 | 3 | 0.2 | 0.2 |
| wardrobe_stats | `mcp wardrobe_stats` | 200 | 11.0 | 14.4 |  | 3 | 664 | 17.4 | 2.2 |
| get_weather | `mcp get_weather` | 200 | 2.0 | 2.7 |  | 3 | 26 | 1.8 | 0.5 |
| list_shared_wardrobes | `mcp list_shared_wardrobes` | 200 | 0.9 | 1.1 |  | 2 | 2 | 0.1 | 0.1 |
| compare_with_shared_wardrobe | `mcp compare_with_shared_wardrobe` | 200 | 7.6 | 9.2 |  | 4 | 672 | 121.8 | 8.5 (8.5–8.5) |
| get_style_profile | `mcp get_style_profile` | 200 | 1.9 | 2.2 |  | 2 | 2 | 1.0 | 0.4 |
| get_sizes | `mcp get_sizes` | 200 | 1.4 | 1.5 |  | 3 | 33 | 2.7 | 0.5 |
| get_closet_coverage | `mcp get_closet_coverage` | 200 | 8.1 | 10.3 |  | 2 | 659 | 0.5 | 0.5 |
| list_suggestions | `mcp list_suggestions` | 200 | 9.9 | 16.0 |  | 3 | 3 | 0.2 | 0.2 |
| get_suggestion_feedback | `mcp get_suggestion_feedback` | 200 | 3.9 | 5.0 |  | 2 | 2 | 0.2 (0.2–0.2) | 0.2 (0.2–0.2) |
| create_option_group | `mcp create_option_group` | 200 | 9.7 | 13.7 |  | 5 | 3 | 0.1 (0.1–0.1) | 0.1 (0.1–0.1) |
| suggest_garment | `mcp suggest_garment` | 200 | 53.9 | 78.7 |  | 18 (18–19) | 11 | 0.3 | 0.3 |
| suggest_outfit | `mcp suggest_outfit` | 200 | 7.1 | 11.6 |  | 7 | 7 | 0.1 | 0.1 |
| finish_round | `mcp finish_round` | 200 | 3.8 | 5.1 |  | 6 | 3 | 0.1 | 0.1 |

## #173 Background jobs

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Morning reminders (with the re-plan first) | `job reminders` |  | 0.2 | 0.3 |  | 1 | 1 | 0.0 | 0.0 |
| Evening reminders | `job reminders` |  | 1.9 | 2.5 |  | 3 | 3 | 0.0 | 0.0 |
| Reminders, nothing due | `job reminders` |  | 0.2 | 0.2 |  | 1 | 1 | 0.0 | 0.0 |
| Reminder claims prune | `job reminder_prune` |  | 0.1 | 0.2 |  | 1 | 0 | 0.0 | 0.0 |
| Week re-plan | `job replan` |  | 13.8 | 15.5 |  | 8 | 38 | 0.0 | 0.0 |
| Week re-plan, already done today | `job replan` |  | 0.3 | 0.3 |  | 1 | 0 | 0.0 | 0.0 |
| Re-plan claims prune | `job replan_prune` |  | 0.2 | 0.2 |  | 1 | 0 | 0.0 | 0.0 |
| Forecast refresh | `job weather refresh` |  | 0.5 | 0.5 |  | 1 | 1 | 0.0 | 0.0 |
| Cutout of an uploaded photo | `job cutout` |  | 80.9 | 90.5 |  | 11 | 4 | 0.0 | 0.0 |
| Cutout retry (nightly) | `job cutout_retry` |  | 0.5 | 1.2 |  | 1 | 0 | 0.0 | 0.0 |
| Storage reconciliation (nightly) | `job reconciliation` |  | 30.9 | 43.7 |  | 4 | 613 | 0.0 | 0.0 |
| Order mail poll (one new order email) | `job order_mail` |  | 10.7 | 13.3 |  | 6 | 3 | 0.0 | 0.0 |
| Order mail poll, nothing new | `job order_mail` |  | 1.1 | 1.7 |  | 2 | 2 | 0.0 | 0.0 |

## #174 Per-request platform overhead

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Health check | `GET /healthz` | 200 | 0.5 | 1.9 | 0.3 | 1 | 1 | 0.4 | 0.4 |
| Liveness | `GET /health/live` | 200 | 0.1 | 0.3 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| Readiness | `GET /health/ready` | 200 | 0.3 | 1.1 | 0.3 | 1 | 1 | 0.4 | 0.4 |
| About, signed in | `GET /about` | 200 | 1.1 | 3.1 | 0.3 | 1 | 1 | 16.1 | 4.8 |
| About, signed out | `GET /about` | 200 | 0.5 | 1.8 | 0.0 | 0 | 0 | 9.7 | 3.1 |
| Offline page | `GET /offline.html` | 200 | 1.0 | 3.6 | 0.3 | 1 | 1 | 16.1 | 4.4 |
| Manifest | `GET /manifest.json` | 200 | 0.2 | 0.9 | 0.0 | 0 | 0 | 1.1 | 0.5 |
| Asset links | `GET /.well-known/*` | 200 | 0.1 | 0.3 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| Stylesheet | `GET /*` | 200 | 0.6 | 1.3 | 0.0 | 0 | 0 | 154.5 | 21.3 |
| Service worker | `GET /*` | 200 | 0.4 | 1.0 | 0.0 | 0 | 0 | 54.7 | 17.0 |
| A page script | `GET /*` | 200 | 0.3 | 1.0 | 0.0 | 0 | 0 | 4.0 | 1.5 |
| Not found page | `GET (unmatched)` | 404 | 1.6 | 5.3 | 0.4 | 1 | 1 | 16.0 | 4.5 |
| Metrics scrape | `GET /metrics` | 200 | 2.3 | 6.1 | 0.0 | 1 | 1 | 188.8 (186.1–188.9) | 11.1 (10.9–11.1) |
| Device timings beacon | `POST /metrics/vitals` | 204 | 1.0 | 1.8 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Script error beacon | `POST /errors/client` | 204 | 1.5 | 2.9 | 0.6 | 1 | 1 | 0.0 | 0.0 |

## Not walked

- `/api/v1/auth/token`
- `/api/v1/calendar-entries`
- `/api/v1/calendar-entries/:id`
- `/api/v1/calendar-entries/:id/outfit`
- `/api/v1/calendar-entries/:id/selfie`
- `/api/v1/calendar-entries/:id/worn`
- `/api/v1/capsules`
- `/api/v1/capsules/:id`
- `/api/v1/capsules/:id/members`
- `/api/v1/changes`
- `/api/v1/garments`
- `/api/v1/garments/:id`
- `/api/v1/garments/:id/away`
- `/api/v1/garments/:id/capsules`
- `/api/v1/garments/:id/clashes/:otherId`
- `/api/v1/garments/:id/clones`
- `/api/v1/garments/:id/condition`
- `/api/v1/garments/:id/copies`
- `/api/v1/garments/:id/decisions`
- `/api/v1/garments/:id/goes-with`
- `/api/v1/garments/:id/photo`
- `/api/v1/garments/:id/photo/cutout`
- `/api/v1/garments/:id/photo/cutout/retries`
- `/api/v1/garments/:id/photo/rotations`
- `/api/v1/garments/:id/purchases`
- `/api/v1/garments/:id/repairs`
- `/api/v1/garments/:id/repairs/:repairId`
- `/api/v1/garments/:id/returns`
- `/api/v1/garments/:id/status`
- `/api/v1/garments/:id/tags`
- `/api/v1/garments/:id/washes`
- `/api/v1/garments/:id/wears/:day`
- `/api/v1/garments/link-imports`
- `/api/v1/garments/washes`
- `/api/v1/ideas`
- `/api/v1/insights`
- `/api/v1/insights/recap`
- `/api/v1/look-photos/:fileName`
- `/api/v1/looks`
- `/api/v1/looks/:id`
- `/api/v1/looks/:id/outfits`
- `/api/v1/looks/:id/photo`
- `/api/v1/looks/:id/pieces`
- `/api/v1/looks/:id/pieces/:position`
- `/api/v1/looks/:id/pieces/:position/wishlist-item`
- `/api/v1/looks/:id/recreation`
- `/api/v1/looks/link-imports`
- `/api/v1/me`
- `/api/v1/openapi.json`
- `/api/v1/outfit-picks`
- `/api/v1/outfit-rules`
- `/api/v1/outfit-rules/:id`
- `/api/v1/outfit-wears`
- `/api/v1/outfits`
- `/api/v1/outfits/:id`
- `/api/v1/outfits/:id/reactions`
- `/api/v1/selfie-photos/:fileName`
- `/api/v1/selfies/:id`
- `/api/v1/shared-wardrobes`
- `/api/v1/sizes`
- `/api/v1/sizes/brands`
- `/api/v1/sizes/brands/:id`
- `/api/v1/sizes/measurements`
- `/api/v1/sizes/unit`
- `/api/v1/style-profile`
- `/api/v1/today`
- `/api/v1/trips`
- `/api/v1/trips/:id`
- `/api/v1/trips/:id/destination`
- `/api/v1/trips/:id/items`
- `/api/v1/trips/:id/items/:itemId`
- `/api/v1/trips/:id/items/copies`
- `/api/v1/trips/:id/outfits`
- `/api/v1/trips/:id/outfits/:tripOutfitId`
- `/api/v1/trips/:id/outfits/:tripOutfitId/wears`
- `/api/v1/trips/:id/packing/:garmentId`
- `/api/v1/trips/:id/weather`
- `/api/v1/weather`
- `/api/v1/weather/feedback`
- `/api/v1/weather/here`
- `/api/v1/weather/home`
- `/api/v1/weather/offset`
- `/api/v1/weather/places`
- `/api/v1/weather/unit`
- `/api/v1/week-plans`
- `/api/v1/week-plans/:id`
- `/api/v1/week-template`
- `/api/v1/wishlist`
- `/api/v1/wishlist/needs/:id`
- `/api/v1/wishlist/needs/:id/decisions`
- `/api/v1/wishlist/seen`
- `/auth/devices/:id/revoke`
- `/auth/profile/style/rules`
- `/auth/profile/style/rules/:id/delete`
- `/calendar/plan/more`
- `/calendar/restore`
- `/inspiration`
- `/inspiration/:id`
- `/inspiration/:id/delete`
- `/inspiration/:id/photo`
- `/inspiration/:id/pieces`
- `/inspiration/:id/pieces/:position`
- `/inspiration/:id/pieces/:position/delete`
- `/inspiration/:id/pieces/:position/find`
- `/inspiration/:id/recreate`
- `/inspiration/:id/recreate/outfit`
- `/inspiration/link`
- `/inspiration/new`
- `/inspiration/photo/:fileName`
- `/inspiration/photo/thumb/:fileName`
- `/inspiration/share`
- `/inspiration/share/confirm`
- `/offline/warm`
- `/outfits/:id/dismiss`
- `/outfits/:id/love`
- `/outfits/:id/share`
- `/outfits/:id/share/stop`
- `/outfits/:id/undo`
- `/styling/fit`
- `/trips/:id/outfits/new/more`
- `/trips/new/destination`
- `/trips/new/place`
- `/trips/new/places`
- `/wardrobe-share/edit-invite`
- `/wardrobe/:id/choose`
- `/wardrobe/:id/dismiss`
- `/wardrobe/:id/plan-items`
- `/wardrobe/:id/returned`
- `/wardrobe/:id/share`
- `/wardrobe/:id/share/stop`
- `/wardrobe/:id/undo`
- `/wardrobe/bulk/archive`
- `/wardrobe/bulk/capsule`
- `/wardrobe/bulk/washed`
- `/wardrobe/export.csv`
- `/wardrobe/export.json`
- `/wardrobe/plans`
- `/wardrobe/plans/*`
- `/wardrobe/shopping`
- `/wardrobe/wishlist/more`
- `/wardrobe/wishlist/needs/:id`
- `/wardrobe/wishlist/needs/:id/dismiss`
- `/wardrobe/wishlist/needs/:id/undo`
- `/wardrobe/wishlist/seen`
- `mcp list_inspiration`
- `mcp get_inspiration`
- `mcp add_inspiration`
- `mcp set_inspiration_pieces`
