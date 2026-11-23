# Page audit

Commit `c2ae39c`, persona `demo`, 2026-11-19T22:57:55.390Z. 20 runs per step after 3 warm-up, 10 × Apple M4, Node v22.23.3, load average 2.9 at the start and 2.2 at the end. Server ms is the request in process (`inject`), db ms Server-Timing’s `db`; statements and rows are the median run’s, with the range when runs differed; KB decompressed, and as sent with `br`.

## #158 Today

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Today | `GET /` | 200 | 16.1 | 19.0 | 12.3 | 3 | 3 | 31.7 | 8.1 |
| Refresh an ideas row | `GET /today/ideas` | 200 | 8.0 | 9.2 | 6.3 | 2 | 2 | 8.8 | 1.9 |
| Weather summary | `GET /weather/summary` | 200 | 3.2 | 3.8 | 2.2 | 2 | 2 | 1.8 | 0.4 |
| Wear this | `POST /today/wear` | 303 | 18.9 | 21.6 | 16.6 | 7 | 7 | 0.0 | 0.0 |
| Wore it (from Today) | `POST /calendar/:id/worn` | 303 | 15.2 | 16.2 | 12.5 | 6 | 4 | 0.0 | 0.0 |
| Reminders form (this device) | `POST /push/reminders/form` | 200 | 5.5 | 7.2 | 2.0 | 2 | 2 | 3.5 | 0.9 |
| Save reminders | `POST /push/reminders` | 200 | 9.5 | 10.8 | 6.3 | 2 | 2 | 0.0 | 0.0 |

## #159 Wardrobe grid

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Grid | `GET /wardrobe` | 200 | 7.1 | 9.6 | 5.5 | 3 | 51 | 64.8 | 12.0 |
| Grid fragment (scope row, filters) | `GET /wardrobe` | 200 | 6.1 | 7.6 | 5.6 | 3 | 29 | 34.6 | 5.5 |
| Search | `GET /wardrobe` | 200 | 9.4 | 11.0 | 10.9 | 3 | 8 | 47.4 | 9.5 |
| Filters: category, colour, warmth | `GET /wardrobe` | 200 | 7.1 | 8.8 | 5.9 | 3 | 8 | 49.3 | 9.7 |
| Care filters: needs a wash, attention | `GET /wardrobe` | 200 | 7.1 | 8.5 | 6.0 | 3 | 2 | 46.9 | 9.2 |
| Show archived | `GET /wardrobe` | 200 | 8.5 | 9.5 | 6.2 | 3 | 51 | 66.0 | 12.1 |
| Capsule filter | `GET /wardrobe` | 200 | 8.2 | 9.5 | 6.9 | 3 | 31 | 57.1 | 11.0 |
| Next page (tiles) | `GET /wardrobe/tiles` | 200 | 4.6 | 5.5 | 3.1 | 2 | 33 | 13.5 | 2.0 |
| Select mode | `GET /wardrobe` | 200 | 5.7 | 7.6 | 3.6 | 3 | 51 | 59.2 | 9.6 |
| Capsule picker | `GET /wardrobe` | 200 | 5.9 | 7.2 | 3.9 | 3 | 51 | 50.6 | 8.3 |
| Tagging mode | `GET /wardrobe/tag` | 200 | 4.1 | 5.1 | 2.5 | 2 | 1 | 17.1 | 4.7 |
| Laundry tab | `GET /laundry` | 200 | 5.1 | 6.0 | 4.0 | 3 | 6 | 27.8 | 6.8 |
| Capsules tab | `GET /capsules` | 200 | 5.8 | 8.0 | 3.7 | 2 | 2 | 30.6 | 7.2 |
| A capsule | `GET /capsules/:id` | 200 | 5.6 | 8.3 | 5.7 | 4 | 32 | 29.3 | 6.9 |
| New capsule form | `GET /capsules/new` | 200 | 2.4 | 3.1 | 0.9 | 1 | 1 | 17.0 | 4.9 |
| Edit capsule form | `GET /capsules/:id/edit` | 200 | 2.9 | 3.7 | 1.3 | 2 | 2 | 17.4 | 5.0 |
| Bulk edit (select mode’s Set…) | `POST /wardrobe/bulk` | 303 | 13.5 | 18.6 | 10.9 | 5 | 3 | 0.0 | 0.0 |
| Tag a garment | `POST /wardrobe/:id/tag` | 200 | 10.2 | 11.4 | 5.0 | 3 | 3 | 2.7 | 0.5 |
| Laundry: washed | `POST /laundry` | 303 | 11.3 | 12.2 | 7.9 | 2 | 2 | 0.0 | 0.0 |
| New capsule | `POST /capsules` | 303 | 11.5 | 13.1 | 9.1 | 4 | 2 | 0.0 | 0.0 |
| Edit capsule | `POST /capsules/:id` | 303 | 11.2 | 15.0 | 7.8 | 3 | 3 | 0.0 | 0.0 |
| Capsule members (picker save) | `POST /capsules/:id/garments` | 303 | 15.2 | 16.2 | 12.6 | 6 | 2 | 0.0 | 0.0 |
| Delete capsule | `DELETE /capsules/:id` | 200 | 9.1 | 12.8 | 6.3 | 2 | 2 | 0.0 | 0.0 |

## #160 Garment page

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Garment page | `GET /wardrobe/:id` | 200 | 10.8 | 13.4 | 7.0 | 3 | 3 | 40.9 | 10.0 |
| Wore today | `POST /wardrobe/:id/wear` | 200 | 15.6 | 17.6 | 10.0 | 3 | 3 | 2.9 | 0.9 |
| Washed | `POST /wardrobe/:id/washed` | 200 | 15.9 | 20.3 | 10.3 | 3 | 3 | 2.0 | 0.8 |
| Where it is (away) | `POST /wardrobe/:id/away` | 200 | 10.9 | 12.4 | 7.4 | 2 | 2 | 0.0 | 0.0 |
| Condition | `POST /wardrobe/:id/condition` | 200 | 10.9 | 12.2 | 7.3 | 2 | 2 | 0.0 | 0.0 |
| Capsules row (saved on change) | `POST /wardrobe/:id/capsules` | 200 | 13.1 | 16.6 | 10.6 | 5 | 2 | 0.0 | 0.0 |
| Log a repair | `POST /wardrobe/:id/repairs` | 303 | 17.1 | 19.7 | 13.4 | 7 | 5 | 0.0 | 0.0 |
| Delete a repair | `POST /wardrobe/:id/repairs/:repairId/delete` | 303 | 15.5 | 21.4 | 12.1 | 6 | 4 | 0.0 | 0.0 |
| Archive | `POST /wardrobe/:id/archive` | 200 | 12.7 | 15.6 | 10.3 | 5 | 2 | 0.0 | 0.0 |
| Restore | `POST /wardrobe/:id/restore` | 200 | 12.2 | 14.3 | 10.0 | 5 | 2 | 0.0 | 0.0 |

## #161 Add and edit a garment

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Add form | `GET /wardrobe/new` | 200 | 4.9 | 6.6 | 2.0 | 2 | 2 | 34.1 | 7.7 |
| Edit form | `GET /wardrobe/:id/edit` | 200 | 6.9 | 9.9 | 3.3 | 3 | 3 | 41.7 | 9.1 |
| Clone form | `GET /wardrobe/:id/clone` | 200 | 7.6 | 9.4 | 3.9 | 3 | 3 | 41.2 | 9.1 |
| Properties after a category change | `POST /wardrobe/properties-fragment` | 200 | 2.0 | 3.2 | 0.9 | 1 | 1 | 4.7 | 0.7 |
| Lookalike check | `GET /wardrobe/lookalikes` | 200 | 2.9 | 3.5 | 2.2 | 2 | 2 | 0.1 | 0.1 |
| Link page | `GET /wardrobe/new/from-link` | 200 | 2.3 | 3.3 | 0.8 | 1 | 1 | 17.2 | 5.0 |
| Save a new garment | `POST /wardrobe` | 302 | 10.6 | 12.2 | 7.3 | 2 | 2 | 0.0 | 0.0 |
| Save an edit | `POST /wardrobe/:id` | 302 | 10.7 | 13.0 | 7.5 | 2 | 2 | 0.0 | 0.0 |
| Import a link | `POST /wardrobe/new/from-link` | 200 | 38.2 | 43.7 | 10.0 | 6 | 3 | 39.0 | 8.5 (8.5–8.5) |
| Choose a link’s photo | `POST /wardrobe/new/from-link/photo` | 200 | 31.3 | 32.0 | 9.1 | 5 | 2 | 0.4 | 0.4 |
| Add from a photo (upload) | `POST /wardrobe/new/photo` | 303 | 33.1 | 34.4 | 10.4 | 6 | 4 | 0.0 | 0.0 |
| Add form with a pending photo | `GET /wardrobe/new` | 200 | 3.6 | 4.7 | 2.2 | 2 | 2 | 34.5 | 7.8 (7.8–7.8) |
| Clone | `POST /wardrobe/:id/clone` | 302 | 31.0 | 37.7 | 12.3 | 6 | 4 | 0.0 | 0.0 |
| Add a copy | `POST /wardrobe/:id/copies` | 303 | 6.3 | 8.1 | 6.0 | 5 | 3 | 0.0 | 0.0 |
| Delete a garment | `DELETE /wardrobe/:id` | 200 | 12.3 | 13.6 | 10.1 | 4 | 2 | 0.0 | 0.0 |
| Save with a pending photo | `POST /wardrobe` | 302 | 10.9 | 12.1 | 10.4 | 7 | 5 | 0.0 | 0.0 |
| Add several photos (a batch of drafts) | `POST /wardrobe/new/photo` | 303 | 53.9 | 55.5 | 10.1 | 7 | 4 | 0.0 | 0.0 |
| A draft’s form | `GET /wardrobe/new` | 200 | 4.0 | 4.7 | 2.3 | 2 | 2 | 36.1 | 8.2 (8.2–8.2) |
| Save a draft | `POST /wardrobe` | 303 | 10.6 | 12.9 | 10.1 | 7 | 5 | 0.0 | 0.0 |
| Discard a draft | `POST /wardrobe/new/drafts/discard` | 303 | 8.3 | 9.8 | 7.3 | 5 | 3 | 0.0 | 0.0 |

## #162 Photos and cutouts

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Original | `GET /file/:fileName` | 200 | 0.9 | 1.0 | 0.0 | 0 | 0 | 10.7 | 10.7 |
| Cutout | `GET /file/nobg/:fileName` | 200 | 0.7 | 0.8 | 0.0 | 0 | 0 | 14.3 | 14.3 |
| Thumb | `GET /file/thumb/:fileName` | 200 | 0.6 | 0.8 | 0.0 | 0 | 0 | 12.2 | 12.2 |
| Thumb, unsigned (an old page) | `GET /file/thumb/:fileName` | 200 | 2.0 | 2.8 | 1.3 | 1 | 1 | 12.2 | 12.2 |
| Thumb, regenerated | `GET /file/thumb/:fileName` | 200 | 34.5 | 38.5 | 1.0 | 1 | 1 | 12.2 | 12.2 |
| Cutout poll (pending page) | `GET /wardrobe/:id/cutout` | 200 | 4.3 | 4.9 | 3.1 | 2 | 2 | 1.8 | 0.7 |
| Upload a photo | `POST /wardrobe/:id/photo` | 303 | 37.9 | 50.6 | 13.4 | 8 | 5 | 0.0 | 0.0 |
| Save a mask edit | `POST /wardrobe/:id/nobg` | 200 | 46.6 | 47.7 | 13.3 | 6 | 4 | 0.2 (0.2–0.2) | 0.2 (0.2–0.2) |
| Rotate the photo | `POST /wardrobe/:id/photo/rotate` | 303 | 38.8 | 40.9 | 14.7 | 9 | 6 | 0.0 | 0.0 |
| Try the cutout again | `POST /wardrobe/:id/cutout/retry` | 303 | 7.7 | 8.3 | 7.3 | 5 | 3 | 0.0 | 0.0 |

## #163 Styling

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Styling | `GET /styling` | 200 | 6.5 | 8.2 | 3.3 | 2 | 2 | 92.4 | 10.9 |
| Style this (?with=) | `GET /styling` | 200 | 14.1 | 16.6 | 10.3 | 3 | 3 | 106.8 | 11.9 |
| Edit an outfit (?outfit=) | `GET /styling` | 200 | 8.7 | 9.9 | 5.4 | 2 | 2 | 103.9 | 11.7 |
| For a planned evening (?for=) | `GET /styling` | 200 | 7.0 | 9.8 | 3.8 | 2 | 2 | 92.5 | 10.8 |
| Shuffle, one row locked | `GET /styling/shuffle` | 200 | 14.3 | 15.6 | 10.7 | 3 | 3 | 83.5 | 6.4 |
| Add a row | `GET /styling/row` | 200 | 5.6 | 6.9 | 3.6 | 2 | 2 | 71.8 | 5.7 |
| Strip paging | `GET /styling/garments` | 200 | 2.9 | 4.0 | 1.9 | 2 | 12 | 8.4 | 1.1 |
| Old builder link (/outfits/new) | `GET /outfits/new` | 302 | 1.0 | 1.9 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Old edit link (/outfits/:id/edit) | `GET /outfits/:id/edit` | 302 | 0.9 | 1.6 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Save an outfit | `POST /styling` | 303 | 15.7 | 17.4 | 13.4 | 6 | 4 | 0.0 | 0.0 |
| Save refused, the page again (an archived garment) | `POST /styling` | 409 | 23.0 | 28.6 | 13.4 | 7 | 6 | 95.8 | 11.2 |

## #164 Outfits and saved outfits

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Outfits (Saved) | `GET /outfits` | 200 | 12.1 | 14.8 | 8.9 | 2 | 2 | 65.5 | 9.2 |
| Saved, a deep page (tiles) | `GET /outfits/tiles` | 200 | 4.5 | 5.5 | 3.9 | 2 | 2 | 0.0 | 0.0 |
| Saved, picking for a day | `GET /outfits` | 200 | 8.7 | 9.9 | 5.5 | 2 | 2 | 71.1 | 9.4 |
| Outfit page (Worn strip) | `GET /outfits/:id` | 200 | 6.5 | 7.7 | 3.3 | 2 | 2 | 76.9 | 7.8 |
| Create an outfit | `POST /outfits` | 302 | 15.7 | 18.0 | 13.2 | 6 | 3 | 0.0 | 0.0 |
| Edit an outfit | `POST /outfits/:id` | 302 | 16.8 | 19.8 | 14.5 | 7 | 5 | 0.0 | 0.0 |
| Delete an outfit | `DELETE /outfits/:id` | 200 | 16.5 | 18.8 | 14.2 | 7 | 5 | 0.0 | 0.0 |

## #165 Calendar and week plan

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Week agenda | `GET /calendar` | 200 | 8.7 | 11.2 | 5.2 | 2 | 2 | 71.0 | 9.9 |
| Next week | `GET /calendar` | 200 | 8.4 | 10.9 | 4.9 | 2 | 2 | 66.4 | 9.0 |
| Month collages | `GET /calendar/month` | 200 | 9.5 | 10.8 | 6.2 | 2 | 2 | 62.4 | 8.3 |
| Last month | `GET /calendar/month` | 200 | 11.1 | 16.3 | 7.4 | 2 | 2 | 65.6 | 7.1 |
| Month weather chips | `GET /weather/summary` | 200 | 3.2 | 5.6 | 2.0 | 2 | 2 | 2.7 | 0.3 |
| + Plan sheet | `GET /calendar/plan` | 200 | 8.9 | 11.1 | 5.2 | 2 | 2 | 63.7 | 9.1 |
| Selfie | `GET /selfies/:fileName` | 200 | 2.9 | 3.8 | 1.6 | 2 | 2 | 11.1 | 11.1 |
| Selfie thumb | `GET /selfies/thumb/:fileName` | 200 | 2.0 | 3.4 | 1.3 | 2 | 2 | 2.7 | 2.7 |
| Plan an outfit on a day | `POST /calendar` | 302 | 11.6 | 17.3 | 10.7 | 6 | 4 | 0.0 | 0.0 |
| Remove a planned entry | `POST /calendar/:id/delete` | 303 | 13.9 | 15.2 | 11.6 | 6 | 3 | 0.0 | 0.0 |
| Mark worn (calendar) | `POST /calendar/:id/worn` | 303 | 14.5 | 16.8 | 12.1 | 6 | 4 | 0.0 | 0.0 |
| Plan my week | `POST /calendar/plan-week` | 303 | 16.9 | 19.9 | 13.7 | 6 | 4 | 0.0 | 0.0 |
| Undo Plan my week | `POST /calendar/plan-week/:id/undo` | 303 | 7.5 | 14.4 | 6.2 | 8 | 5 | 0.0 | 0.0 |
| Save the week template | `POST /auth/profile/week` | 303 | 13.1 | 17.8 | 10.6 | 5 | 1 | 0.0 | 0.0 |
| Add a selfie | `POST /calendar/:id/selfie` | 303 | 33.3 | 34.8 | 11.1 | 10 | 6 | 0.0 | 0.0 |
| Remove a selfie | `POST /selfies/:id/delete` | 303 | 6.8 | 8.1 | 5.8 | 2 | 2 | 0.0 | 0.0 |

## #166 Trips and packing

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Trips | `GET /trips` | 200 | 3.3 | 4.9 | 1.5 | 2 | 2 | 16.8 | 4.9 |
| Trip page and packing list | `GET /trips/:id` | 200 | 8.8 | 12.9 | 5.5 | 2 | 2 | 54.4 | 8.5 |
| New trip form | `GET /trips/new` | 200 | 2.6 | 4.0 | 1.0 | 1 | 1 | 18.1 | 5.0 |
| Edit trip form | `GET /trips/:id/edit` | 200 | 3.1 | 4.1 | 1.2 | 2 | 2 | 18.0 | 5.0 |
| Add-an-outfit page | `GET /trips/:id/outfits/new` | 200 | 10.2 | 13.9 | 6.2 | 2 | 2 | 63.7 | 9.1 |
| Trip weather | `GET /trips/:id/weather` | 200 | 2.7 | 3.8 | 2.1 | 2 | 2 | 0.1 | 0.1 |
| Ideas for the trip | `GET /outfits/ideas` | 200 | 10.3 | 14.2 | 6.2 | 3 | 3 | 42.3 | 7.5 |
| Create a trip | `POST /trips` | 303 | 6.6 | 7.5 | 6.3 | 5 | 2 | 0.0 | 0.0 |
| Edit a trip | `POST /trips/:id` | 303 | 13.2 | 16.0 | 10.9 | 5 | 3 | 0.0 | 0.0 |
| Delete a trip | `DELETE /trips/:id` | 200 | 10.3 | 12.1 | 7.3 | 2 | 2 | 0.0 | 0.0 |
| Add an outfit to the trip | `POST /trips/:id/outfits` | 303 | 13.5 | 16.4 | 11.1 | 5 | 3 | 0.0 | 0.0 |
| Remove a trip outfit | `POST /trips/:id/outfits/:tripOutfitId/delete` | 303 | 11.9 | 13.6 | 9.9 | 5 | 2 | 0.0 | 0.0 |
| Wear on a trip day | `POST /trips/:id/outfits/:tripOutfitId/wear` | 303 | 14.2 | 17.4 | 11.6 | 6 | 4 | 0.0 | 0.0 |
| Pack garments | `POST /trips/:id/packed` | 303 | 7.2 | 15.3 | 6.5 | 2 | 2 | 0.0 | 0.0 |
| Add a packing item | `POST /trips/:id/items` | 303 | 8.9 | 12.3 | 6.3 | 2 | 2 | 0.0 | 0.0 |
| Pack items | `POST /trips/:id/items/packed` | 303 | 10.1 | 11.9 | 7.4 | 2 | 2 | 0.0 | 0.0 |
| Remove a packing item | `POST /trips/:id/items/:itemId/delete` | 303 | 9.9 | 12.0 | 6.8 | 2 | 2 | 0.0 | 0.0 |
| Copy another trip’s items | `POST /trips/:id/items/copy` | 303 | 10.1 | 13.1 | 7.8 | 2 | 2 | 0.0 | 0.0 |
| Destination search | `GET /trips/:id/places` | 200 | 2.6 | 3.5 | 1.3 | 2 | 2 | 0.5 | 0.5 |
| Set the destination | `POST /trips/:id/destination` | 303 | 6.4 | 10.3 | 5.4 | 2 | 2 | 0.0 | 0.0 |

## #167 Wishlist and Bought it

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Wishlist | `GET /wardrobe/wishlist` | 200 | 9.6 | 12.4 | 5.8 | 2 | 2 | 26.8 | 7.1 |
| Wishlist item | `GET /wardrobe/:id` | 200 | 17.9 | 22.1 | 4.6 | 3 | 3 | 34.2 | 9.1 |
| Wishlist form | `GET /wardrobe/new` | 200 | 7.5 | 11.1 | 4.3 | 3 | 3 | 39.7 | 8.8 |
| Bought it form | `GET /wardrobe/:id/bought` | 200 | 4.9 | 6.2 | 2.8 | 3 | 3 | 17.5 | 5.0 |
| Style profile | `GET /auth/profile/style` | 200 | 6.5 | 9.2 | 3.2 | 2 | 2 | 45.9 | 8.5 |
| From your orders | `GET /wardrobe/orders` | 200 | 3.5 | 5.0 | 1.6 | 2 | 7 | 21.9 | 5.1 |
| Bought it | `POST /wardrobe/:id/bought` | 303 | 19.7 | 24.1 | 17.6 | 11 | 4 | 0.0 | 0.0 |
| Save the style profile | `POST /auth/profile/style` | 303 | 10.0 | 11.2 | 6.8 | 2 | 1 | 0.0 | 0.0 |
| Add an order item to the closet | `POST /wardrobe/orders/:id/add` | 200 | 39.5 | 44.5 | 12.2 | 7 | 5 | 39.2 | 8.6 (8.6–8.6) |
| Dismiss an order item | `POST /wardrobe/orders/:id/dismiss` | 303 | 4.9 | 7.0 | 4.5 | 2 | 2 | 0.0 | 0.0 |

## #168 Ideas gallery

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Ideas | `GET /outfits/ideas` | 200 | 10.8 | 16.5 | 6.3 | 2 | 2 | 51.2 | 7.9 |
| Ideas for a planned evening | `GET /outfits/ideas` | 200 | 16.9 | 22.3 | 9.3 | 3 | 6 | 58.8 | 7.7 |
| Ideas with a garment | `GET /outfits/ideas` | 200 | 13.1 | 15.0 | 8.4 | 3 | 3 | 54.9 | 7.5 |
| More ideas (page 2) | `GET /outfits/ideas/more` | 200 | 10.3 | 14.4 | 6.8 | 2 | 2 | 30.6 | 2.3 |
| More ideas (page 50, the cap) | `GET /outfits/ideas/more` | 200 | 27.9 | 35.1 | 6.0 | 2 | 2 | 30.5 | 2.5 |
| Pick an idea | `POST /outfits/ideas/pick` | 303 | 15.0 | 17.1 | 13.1 | 6 | 6 | 0.0 | 0.0 |
| Never pair these (clash) | `POST /outfits/ideas/avoid` | 303 | 9.0 | 10.4 | 6.6 | 2 | 2 | 0.0 | 0.0 |
| Pair them again | `POST /outfits/ideas/allow` | 303 | 6.0 | 7.5 | 3.9 | 2 | 2 | 0.0 | 0.0 |
| Too warm | `POST /outfits/ideas/feedback` | 303 | 9.1 | 12.7 | 6.5 | 2 | 2 | 0.0 | 0.0 |

## #169 Insights and yearly recap

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Insights | `GET /wardrobe/insights` | 200 | 9.4 | 11.9 | 8.1 | 3 | 86 | 50.3 | 8.8 |
| Insights, unworn 30 days | `GET /wardrobe/insights` | 200 | 7.5 | 9.2 | 7.0 | 3 | 86 | 50.3 | 8.8 |
| Year in review | `GET /wardrobe/recap` | 200 | 7.6 | 9.4 | 8.3 | 3 | 89 | 31.3 | 7.3 |
| Year in review, last year | `GET /wardrobe/recap` | 200 | 5.4 | 7.3 | 4.9 | 3 | 84 | 17.7 | 4.9 |

## #170 Sharing and shared views

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Shared wardrobe | `GET /wardrobe` | 200 | 5.9 | 7.1 | 4.5 | 3 | 14 | 37.3 | 8.6 |
| Shared garment | `GET /wardrobe/:id` | 200 | 5.8 | 6.3 | 3.3 | 3 | 3 | 26.5 | 7.5 |
| Shared capsules | `GET /capsules` | 200 | 5.1 | 6.2 | 3.3 | 2 | 2 | 26.0 | 6.6 |
| Shared wishlist | `GET /wardrobe/wishlist` | 200 | 5.3 | 6.9 | 3.5 | 2 | 2 | 24.3 | 6.3 |
| Styling a shared wardrobe | `GET /styling` | 200 | 5.7 | 7.1 | 3.5 | 2 | 2 | 55.4 | 7.5 |
| Share page, garment (signed out) | `GET /share` | 200 | 2.6 | 3.7 | 1.3 | 1 | 1 | 9.9 | 3.1 |
| Share page, outfit (signed out) | `GET /share` | 200 | 3.4 | 6.0 | 2.0 | 1 | 1 | 10.4 | 3.3 |
| Share preview image | `GET /file/watermark/:shareableId` | 200 | 16.7 | 19.6 | 1.8 | 1 | 1 | 29.1 | 29.1 |
| Old manage page | `GET /wardrobe-share/manage` | 301 | 2.0 | 2.4 | 1.5 | 1 | 1 | 0.0 | 0.0 |
| Create an invite link | `POST /wardrobe-share/create-invite-link` | 200 | 8.3 | 10.2 | 5.8 | 2 | 2 | 0.7 | 0.7 |
| Invite landing | `GET /wardrobe-share/invite/:token` | 200 | 2.6 | 3.6 |  | 2 | 2 | 16.9 (16.9–16.9) | 4.8 (4.8–4.8) |
| Accept an invite | `POST /wardrobe-share/invite/:token/accept` | 302 | 7.2 | 8.6 |  | 3 | 3 | 0.0 | 0.0 |
| Decline an invite | `POST /wardrobe-share/invite/:token/decline` | 302 | 1.7 | 2.9 |  | 2 | 1 | 0.0 | 0.0 |
| Remove a share | `POST /wardrobe-share/:id/remove` | 302 | 5.5 | 6.4 | 5.2 | 2 | 2 | 0.0 | 0.0 |
| Edit a shared garment (MANAGE) | `POST /wardrobe/:id` | 302 | 6.1 | 7.6 | 5.7 | 2 | 2 | 0.0 | 0.0 |

## #171 Auth, account and push

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Profile | `GET /auth/profile` | 200 | 3.7 | 4.6 | 5.3 | 5 | 16 | 22.3 | 5.7 |
| Sign-in page | `GET /auth/login` | 200 | 0.8 | 1.1 | 0.0 | 0 | 0 | 10.6 | 3.2 |
| Registration page | `GET /auth/register` | 200 | 0.8 | 1.0 | 0.0 | 0 | 0 | 11.0 | 3.3 |
| Change email page | `GET /auth/update-email` | 200 | 2.0 | 3.0 | 0.9 | 1 | 1 | 17.4 | 4.9 |
| Change password page | `GET /auth/change-password` | 200 | 2.0 | 3.1 | 0.8 | 1 | 1 | 17.7 | 5.0 |
| Sign out everywhere page | `GET /auth/sign-out-everywhere` | 200 | 1.7 | 2.5 | 0.8 | 1 | 1 | 17.3 | 5.0 |
| Delete account page | `GET /auth/delete-account` | 200 | 1.6 | 2.1 | 0.6 | 1 | 1 | 17.4 | 5.0 |
| Agent access (tokens) | `GET /auth/tokens` | 200 | 2.9 | 3.7 | 1.2 | 2 | 13 | 26.3 | 5.9 |
| Sign-out page | `GET /auth/logout` | 200 | 1.7 | 2.3 | 0.7 | 1 | 1 | 16.0 | 4.6 |
| Sizes | `GET /auth/profile/sizes` | 200 | 3.1 | 4.5 | 2.2 | 3 | 10 | 32.8 | 6.3 |
| Brand size hint | `GET /auth/profile/sizes/hint` | 200 | 1.8 | 2.5 | 1.4 | 2 | 2 | 0.2 | 0.2 |
| VAPID public key | `GET /push/vapid-public-key` | 200 | 0.8 | 1.1 | 0.6 | 1 | 1 | 0.1 | 0.1 |
| Sign in | `POST /auth/login` | 302 | 203.1 | 239.9 |  | 1 | 1 | 0.0 | 0.0 |
| Register | `POST /auth/register` | 302 | 210.7 | 214.3 | 7.2 | 1 | 1 | 0.0 | 0.0 |
| Validate registration (as typed) | `POST /auth/validate/register` | 200 | 0.1 | 0.1 | 0.0 | 0 | 0 | 0.4 | 0.4 |
| Validate an email change | `POST /auth/validate/update-email` | 200 | 0.7 | 1.2 | 0.6 | 1 | 1 | 0.1 | 0.1 |
| Change email | `POST /auth/update-email` | 302 | 215.1 | 217.8 |  | 2 | 2 | 0.0 | 0.0 |
| Change password | `POST /auth/change-password` | 302 | 429.3 | 435.5 |  | 5 | 3 | 0.0 | 0.0 |
| Delete account | `POST /auth/delete-account` | 302 | 223.2 | 229.5 |  | 6 | 3 | 0.0 | 0.0 |
| Create an access token | `POST /auth/tokens` | 200 | 222.0 | 228.0 |  | 6 | 3 | 21.5 | 6.0 (6.0–6.0) |
| Revoke an access token | `POST /auth/tokens/:id/revoke` | 303 | 4.8 | 6.1 | 4.3 | 2 | 2 | 0.0 | 0.0 |
| Sign out | `POST /auth/logout` | 303 | 1.5 | 2.4 | 0.7 | 1 | 1 | 0.0 | 0.0 |
| Subscribe a device | `POST /push/subscribe` | 204 | 7.5 | 9.6 | 5.7 | 2 | 2 | 0.0 | 0.0 |
| Unsubscribe a device | `POST /push/unsubscribe` | 204 | 8.5 | 9.5 | 6.3 | 2 | 2 | 0.0 | 0.0 |
| Send a test notification | `POST /push/test` | 200 | 5.9 | 8.9 | 2.8 | 2 | 25 | 0.1 | 0.1 |
| Sizes: unit | `POST /auth/profile/sizes/unit` | 303 | 9.5 | 11.6 | 6.5 | 2 | 1 | 0.0 | 0.0 |
| Sizes: measurements | `POST /auth/profile/sizes/measurements` | 303 | 11.6 | 12.8 | 8.0 | 3 | 2 | 0.0 | 0.0 |
| Sizes: add a brand | `POST /auth/profile/sizes/brands` | 303 | 11.3 | 12.3 | 9.0 | 4 | 2 | 0.0 | 0.0 |
| Sizes: edit a brand | `POST /auth/profile/sizes/brands/:id` | 303 | 9.2 | 10.8 | 6.5 | 2 | 2 | 0.0 | 0.0 |
| Sizes: remove a brand | `POST /auth/profile/sizes/brands/:id/delete` | 303 | 9.1 | 11.1 | 6.3 | 2 | 2 | 0.0 | 0.0 |
| Weather: city search | `GET /weather/places` | 200 | 5.5 | 6.2 | 1.6 | 1 | 1 | 0.5 | 0.5 |
| Weather: set home | `POST /weather/home` | 200 | 6.1 | 15.2 | 4.3 | 3 | 2 | 1.6 | 0.6 |
| Weather: use this phone’s location | `POST /weather/here` | 200 | 6.1 | 6.6 | 5.2 | 3 | 2 | 1.3 | 0.5 |
| Weather: stop using this phone’s location | `POST /weather/here/clear` | 200 | 12.2 | 14.0 | 7.7 | 3 | 2 | 1.6 | 0.6 |
| Weather: unit | `POST /weather/unit` | 200 | 10.0 | 12.3 | 6.7 | 3 | 2 | 0.9 | 0.9 |
| Weather: feels warmer or colder | `POST /weather/feedback` | 200 | 9.4 | 12.6 | 6.5 | 3 | 3 | 0.8 (0.6–0.8) | 0.8 (0.6–0.8) |
| Weather: reset the offset | `POST /weather/offset/reset` | 200 | 9.8 | 11.8 | 6.7 | 3 | 2 | 0.6 | 0.6 |
| Weather: remove home | `POST /weather/home/clear` | 200 | 12.0 | 13.2 | 7.5 | 3 | 2 | 1.5 | 0.6 |
| Weather: set home again | `POST /weather/home` | 200 | 11.2 | 11.2 | 6.4 | 3 | 2 | 1.6 | 0.6 |

## #172 MCP tools

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| get_today | `mcp get_today` | 200 | 11.7 | 19.7 |  | 3 | 3 | 1.4 (1.4–1.4) | 0.6 (0.6–0.6) |
| search_garments | `mcp search_garments` | 200 | 3.7 | 4.7 |  | 3 | 51 | 11.6 | 0.4 (0.4–0.4) |
| search_garments (keyword) | `mcp search_garments` | 200 | 8.5 | 12.6 |  | 3 | 31 | 7.8 | 0.5 |
| get_wardrobe | `mcp get_wardrobe` | 200 | 7.9 | 13.2 |  | 3 | 276 | 51.1 | 3.3 |
| get_garment | `mcp get_garment` | 200 | 11.5 | 16.1 |  | 3 | 3 | 3.5 (3.5–3.5) | 0.8 |
| get_garment_photo | `mcp get_garment_photo` | 200 | 6.6 | 10.8 |  | 3 | 3 | 1.1 | 0.7 (0.7–0.7) |
| update_garment | `mcp update_garment` | 200 | 25.3 | 28.8 |  | 4 | 4 | 1.2 | 0.6 (0.6–0.6) |
| add_garment_copy | `mcp add_garment_copy` | 200 | 25.6 | 27.8 |  | 7 | 5 | 1.0 | 1.0 |
| list_wishlist | `mcp list_wishlist` | 200 | 7.9 | 10.3 |  | 2 | 4 | 0.7 | 0.7 |
| add_garment_from_link | `mcp add_garment_from_link` | 200 | 49.9 | 61.7 |  | 13 | 8 | 1.0 | 1.0 |
| list_capsules | `mcp list_capsules` | 200 | 3.7 | 5.4 |  | 2 | 2 | 1.5 | 0.2 (0.2–0.2) |
| get_capsule | `mcp get_capsule` | 200 | 3.7 | 5.3 |  | 3 | 29 | 7.5 | 1.3 (1.3–1.3) |
| set_capsule_membership | `mcp set_capsule_membership` | 200 | 7.3 | 14.3 |  | 5 | 2 | 0.1 | 0.1 |
| list_outfits | `mcp list_outfits` | 200 | 14.7 | 18.0 |  | 2 | 2 | 17.9 | 1.8 |
| get_outfit | `mcp get_outfit` | 200 | 6.7 | 8.7 |  | 2 | 2 | 0.6 | 0.6 |
| create_outfit | `mcp create_outfit` | 200 | 16.4 | 21.5 |  | 7 | 7 | 0.1 | 0.1 |
| schedule_outfit | `mcp schedule_outfit` | 200 | 17.9 | 20.3 |  | 6 | 4 | 0.2 | 0.2 |
| suggest_outfits | `mcp suggest_outfits` | 200 | 11.4 | 13.6 |  | 2 | 2 | 3.7 | 0.7 (0.7–0.7) |
| goes_with_closet | `mcp goes_with_closet` | 200 | 9.2 | 10.9 |  | 2 | 2 | 2.3 | 0.6 |
| pick_outfit | `mcp pick_outfit` | 200 | 10.4 | 16.5 |  | 7 | 7 | 0.2 | 0.2 |
| get_calendar | `mcp get_calendar` | 200 | 10.6 | 13.0 |  | 3 | 6 | 19.0 | 2.0 |
| laundry_status | `mcp laundry_status` | 200 | 9.4 | 11.3 |  | 2 | 5 | 0.5 | 0.5 |
| mark_worn | `mcp mark_worn` | 200 | 6.0 | 8.4 |  | 2 | 2 | 0.1 | 0.1 |
| mark_washed | `mcp mark_washed` | 200 | 6.5 | 10.8 |  | 2 | 2 | 0.1 | 0.1 |
| plan_week | `mcp plan_week` | 200 | 17.4 | 22.9 |  | 6 | 4 | 0.2 | 0.2 |
| list_trips | `mcp list_trips` | 200 | 4.6 | 8.3 |  | 2 | 71 | 12.3 | 0.4 (0.4–0.4) |
| get_trip | `mcp get_trip` | 200 | 7.8 | 12.7 |  | 2 | 2 | 6.6 | 1.0 (1.0–1.0) |
| plan_trip_outfit | `mcp plan_trip_outfit` | 200 | 16.3 | 20.1 |  | 5 | 3 | 0.2 | 0.2 |
| wardrobe_stats | `mcp wardrobe_stats` | 200 | 11.3 | 15.5 |  | 3 | 247 | 17.1 | 2.0 (2.0–2.0) |
| get_weather | `mcp get_weather` | 200 | 9.7 | 11.7 |  | 3 | 6 | 1.8 | 0.5 |
| list_shared_wardrobes | `mcp list_shared_wardrobes` | 200 | 4.4 | 6.7 |  | 2 | 2 | 0.1 | 0.1 |
| compare_with_shared_wardrobe | `mcp compare_with_shared_wardrobe` | 200 | 9.2 | 11.4 |  | 4 | 255 | 38.0 | 5.1 |
| get_style_profile | `mcp get_style_profile` | 200 | 3.3 | 3.9 |  | 2 | 2 | 1.0 | 0.4 |
| get_sizes | `mcp get_sizes` | 200 | 2.5 | 3.2 |  | 3 | 33 | 2.7 | 0.5 |
| get_closet_coverage | `mcp get_closet_coverage` | 200 | 6.0 | 8.4 |  | 2 | 242 | 0.5 | 0.5 |
| list_suggestions | `mcp list_suggestions` | 200 | 12.9 | 14.7 |  | 3 | 3 | 0.2 | 0.2 |
| get_suggestion_feedback | `mcp get_suggestion_feedback` | 200 | 9.2 | 10.6 |  | 2 | 2 | 0.2 (0.2–0.2) | 0.2 (0.2–0.2) |
| create_option_group | `mcp create_option_group` | 200 | 14.5 | 17.9 |  | 5 | 3 | 0.1 (0.1–0.1) | 0.1 (0.1–0.1) |
| suggest_garment | `mcp suggest_garment` | 200 | 51.7 | 90.9 |  | 18 (18–19) | 11 | 0.3 | 0.3 |
| suggest_outfit | `mcp suggest_outfit` | 200 | 8.9 | 20.6 |  | 7 | 7 | 0.1 (0.1–0.1) | 0.1 (0.1–0.1) |
| finish_round | `mcp finish_round` | 200 | 16.4 | 21.5 |  | 6 | 3 | 0.1 | 0.1 |

## #173 Background jobs

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Morning reminders (with the re-plan first) | `job reminders` |  | 0.8 | 1.9 |  | 1 | 1 | 0.0 | 0.0 |
| Evening reminders | `job reminders` |  | 7.0 | 9.6 |  | 3 | 3 | 0.0 | 0.0 |
| Reminders, nothing due | `job reminders` |  | 0.8 | 1.1 |  | 1 | 1 | 0.0 | 0.0 |
| Reminder claims prune | `job reminder_prune` |  | 0.9 | 1.9 |  | 1 | 0 | 0.0 | 0.0 |
| Week re-plan | `job replan` |  | 22.8 | 26.6 |  | 8 | 18 | 0.0 | 0.0 |
| Week re-plan, already done today | `job replan` |  | 0.7 | 1.1 |  | 1 | 0 | 0.0 | 0.0 |
| Re-plan claims prune | `job replan_prune` |  | 0.3 | 0.3 |  | 1 | 0 | 0.0 | 0.0 |
| Forecast refresh | `job weather refresh` |  | 1.1 | 2.2 |  | 1 | 1 | 0.0 | 0.0 |
| Cutout of an uploaded photo | `job cutout` |  | 72.5 | 76.0 |  | 11 | 4 | 0.0 | 0.0 |
| Cutout retry (nightly) | `job cutout_retry` |  | 0.3 | 0.5 |  | 1 | 0 | 0.0 | 0.0 |
| Storage reconciliation (nightly) | `job reconciliation` |  | 13.0 | 14.9 |  | 4 | 196 | 0.0 | 0.0 |
| Order mail poll (one new order email) | `job order_mail` |  | 13.3 | 15.9 |  | 6 | 3 | 0.0 | 0.0 |
| Order mail poll, nothing new | `job order_mail` |  | 2.4 | 3.2 |  | 2 | 2 | 0.0 | 0.0 |

## #174 Per-request platform overhead

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Health check | `GET /healthz` | 200 | 0.8 | 1.3 | 0.6 | 1 | 1 | 0.4 | 0.4 |
| Liveness | `GET /health/live` | 200 | 0.1 | 0.1 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| Readiness | `GET /health/ready` | 200 | 0.6 | 1.0 | 0.5 | 1 | 1 | 0.4 | 0.4 |
| About, signed in | `GET /about` | 200 | 1.7 | 1.8 | 0.6 | 1 | 1 | 16.9 | 5.0 |
| About, signed out | `GET /about` | 200 | 0.7 | 0.9 | 0.0 | 0 | 0 | 10.3 | 3.4 |
| Offline page | `GET /offline.html` | 200 | 1.7 | 2.3 | 0.6 | 1 | 1 | 16.9 | 4.7 |
| Manifest | `GET /manifest.json` | 200 | 0.3 | 0.4 | 0.0 | 0 | 0 | 1.1 | 0.5 |
| Asset links | `GET /.well-known/*` | 200 | 0.1 | 0.2 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| Stylesheet | `GET /*` | 200 | 0.8 | 1.0 | 0.0 | 0 | 0 | 167.7 | 23.0 |
| Service worker | `GET /*` | 200 | 0.6 | 0.7 | 0.0 | 0 | 0 | 61.2 | 18.9 |
| A page script | `GET /*` | 200 | 0.4 | 0.5 | 0.0 | 0 | 0 | 4.0 | 1.5 |
| Not found page | `GET (unmatched)` | 404 | 2.8 | 3.1 | 0.9 | 1 | 1 | 16.8 | 4.6 |
| Metrics scrape | `GET /metrics` | 200 | 3.4 | 5.3 | 0.0 | 1 | 1 | 192.0 (190.7–192.6) | 11.3 (11.2–11.4) |
| Device timings beacon | `POST /metrics/vitals` | 204 | 2.8 | 4.0 | 1.1 | 1 | 1 | 0.0 | 0.0 |
| Script error beacon | `POST /errors/client` | 204 | 3.8 | 6.1 | 1.4 | 1 | 1 | 0.0 | 0.0 |

## Accessibility

68 pages at 390 × 844 in Chromium, axe-core 4.14.1; counts are violating nodes. `field font < 16 px` is a text field iOS zooms into, `target < 44 px` a tap target a 44 px fingertip disc does not wholly reach (hit tested by `tapMisses`).

| Rule | Impact | Nodes | Pages |
| --- | --- | --: | --- |
| `target < 44 px` | measure | 71 | #159 Grid (2), #159 Search (1), #159 Filters: category, colour, warmth (5), #159 Care filters: needs a wash, attention (4), #159 Show archived (3), #159 Capsule filter (2), #159 Select mode (1), #159 Laundry tab (1), #159 Capsules tab (1), #161 Add form (1), #161 Edit form (1), #161 Clone form (1), #163 Styling (8), #163 Style this (?with=) (7), #163 Edit an outfit (?outfit=) (7), #163 For a planned evening (?for=) (8), #167 Wishlist (4), #167 Style profile (1), #170 Shared wardrobe (2), #170 Shared capsules (1), #170 Shared wishlist (1), #170 Styling a shared wardrobe (8), #171 Sizes (1) |

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
- `/auth/devices`
- `/auth/devices/:id/revoke`
- `/auth/profile/notifications`
- `/auth/profile/sharing`
- `/auth/profile/style/rules`
- `/auth/profile/style/rules/:id/delete`
- `/auth/profile/weather`
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
- `/wardrobe/insights/unworn`
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
