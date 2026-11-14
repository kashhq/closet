# Page audit

Commit `08d9927`, persona `demo`, 2026-11-14T20:06:42.424Z. 20 runs per step after 3 warm-up, 10 × Apple M4, Node v22.23.3, load average 2.6 at the start and 8.3 at the end. Server ms is the request in process (`inject`), db ms Server-Timing’s `db`; statements and rows are the median run’s, with the range when runs differed; KB decompressed, and as sent with `br`.

## #158 Today

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Today | `GET /` | 200 | 18.0 | 21.4 | 14.7 | 3 | 3 | 30.6 | 7.9 |
| Refresh an ideas row | `GET /today/ideas` | 200 | 7.6 | 9.8 | 5.7 | 2 | 2 | 8.6 | 1.9 |
| Weather summary | `GET /weather/summary` | 200 | 3.0 | 4.1 | 1.9 | 2 | 2 | 1.9 | 0.4 |
| Wear this | `POST /today/wear` | 303 | 4.3 | 9.5 | 4.0 | 7 | 7 | 0.0 | 0.0 |
| Wore it (from Today) | `POST /calendar/:id/worn` | 303 | 3.5 | 4.8 | 3.2 | 6 | 4 | 0.0 | 0.0 |
| Reminders form (this device) | `POST /push/reminders/form` | 200 | 1.0 | 1.5 | 0.5 | 2 | 2 | 3.5 | 0.9 |
| Save reminders | `POST /push/reminders` | 200 | 2.9 | 3.8 | 2.5 | 2 | 2 | 0.0 | 0.0 |

## #159 Wardrobe grid

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Grid | `GET /wardrobe` | 200 | 7.4 | 8.9 | 5.6 | 3 | 51 | 63.3 | 11.7 |
| Grid fragment (scope row, filters) | `GET /wardrobe` | 200 | 6.1 | 8.6 | 5.5 | 3 | 29 | 33.8 | 5.2 |
| Search | `GET /wardrobe` | 200 | 9.3 | 13.2 | 10.9 | 3 | 8 | 46.1 | 9.3 |
| Filters: category, colour, warmth | `GET /wardrobe` | 200 | 6.4 | 8.9 | 4.5 | 3 | 8 | 47.5 | 9.5 |
| Care filters: needs a wash, attention | `GET /wardrobe` | 200 | 7.0 | 8.4 | 5.6 | 3 | 2 | 45.0 | 8.9 |
| Show archived | `GET /wardrobe` | 200 | 6.8 | 9.1 | 5.4 | 3 | 51 | 64.3 | 11.8 |
| Capsule filter | `GET /wardrobe` | 200 | 7.2 | 9.5 | 6.2 | 3 | 31 | 55.7 | 10.7 |
| Next page (tiles) | `GET /wardrobe/tiles` | 200 | 3.6 | 7.1 | 2.3 | 2 | 33 | 14.2 | 2.0 |
| Select mode | `GET /wardrobe` | 200 | 5.7 | 8.0 | 3.5 | 3 | 51 | 58.6 | 9.5 |
| Capsule picker | `GET /wardrobe` | 200 | 5.2 | 7.0 | 3.3 | 3 | 51 | 50.1 | 8.2 |
| Tagging mode | `GET /wardrobe/tag` | 200 | 3.7 | 5.0 | 1.9 | 2 | 1 | 16.3 | 4.5 |
| Laundry tab | `GET /laundry` | 200 | 5.6 | 7.5 | 4.3 | 3 | 17 | 39.1 | 7.6 |
| Capsules tab | `GET /capsules` | 200 | 6.3 | 7.8 | 4.3 | 2 | 2 | 29.8 | 7.1 |
| A capsule | `GET /capsules/:id` | 200 | 6.1 | 7.3 | 5.9 | 4 | 32 | 28.8 | 6.7 |
| New capsule form | `GET /capsules/new` | 200 | 2.1 | 3.8 | 0.8 | 1 | 1 | 16.3 | 4.7 |
| Edit capsule form | `GET /capsules/:id/edit` | 200 | 2.8 | 4.3 | 1.3 | 2 | 2 | 16.6 | 4.8 |
| Bulk edit (select mode’s Set…) | `POST /wardrobe/bulk` | 303 | 7.0 | 10.1 | 5.8 | 5 | 3 | 0.0 | 0.0 |
| Tag a garment | `POST /wardrobe/:id/tag` | 200 | 4.5 | 9.6 | 3.3 | 3 | 3 | 2.7 | 0.5 |
| Laundry: washed | `POST /laundry` | 303 | 6.7 | 10.6 | 5.5 | 2 | 2 | 0.0 | 0.0 |
| New capsule | `POST /capsules` | 303 | 10.2 | 13.3 | 8.0 | 4 | 2 | 0.0 | 0.0 |
| Edit capsule | `POST /capsules/:id` | 303 | 9.4 | 11.7 | 7.0 | 3 | 3 | 0.0 | 0.0 |
| Capsule members (picker save) | `POST /capsules/:id/garments` | 303 | 7.0 | 9.0 | 5.4 | 6 | 2 | 0.0 | 0.0 |
| Delete capsule | `DELETE /capsules/:id` | 200 | 7.4 | 10.4 | 5.2 | 2 | 2 | 0.0 | 0.0 |

## #160 Garment page

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Garment page | `GET /wardrobe/:id` | 200 | 11.3 | 15.4 | 6.9 | 3 | 3 | 40.8 | 9.9 |
| Wore today | `POST /wardrobe/:id/wear` | 200 | 14.1 | 17.4 | 8.8 | 3 | 3 | 2.6 | 0.8 |
| Washed | `POST /wardrobe/:id/washed` | 200 | 14.9 | 17.0 | 9.4 | 3 | 3 | 1.7 | 0.7 |
| Where it is (away) | `POST /wardrobe/:id/away` | 200 | 7.7 | 11.8 | 5.5 | 2 | 2 | 0.0 | 0.0 |
| Condition | `POST /wardrobe/:id/condition` | 200 | 7.8 | 10.9 | 5.2 | 2 | 2 | 0.0 | 0.0 |
| Capsules row (saved on change) | `POST /wardrobe/:id/capsules` | 200 | 11.4 | 17.2 | 9.1 | 5 | 2 | 0.0 | 0.0 |
| Log a repair | `POST /wardrobe/:id/repairs` | 303 | 11.3 | 17.2 | 8.4 | 7 | 5 | 0.0 | 0.0 |
| Delete a repair | `POST /wardrobe/:id/repairs/:repairId/delete` | 303 | 14.1 | 16.9 | 11.2 | 6 | 4 | 0.0 | 0.0 |
| Archive | `POST /wardrobe/:id/archive` | 200 | 11.0 | 12.9 | 9.1 | 5 | 2 | 0.0 | 0.0 |
| Restore | `POST /wardrobe/:id/restore` | 200 | 11.5 | 15.3 | 9.4 | 5 | 2 | 0.0 | 0.0 |

## #161 Add and edit a garment

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Add form | `GET /wardrobe/new` | 200 | 3.8 | 6.1 | 1.8 | 2 | 2 | 33.4 | 7.5 |
| Edit form | `GET /wardrobe/:id/edit` | 200 | 6.0 | 8.8 | 3.1 | 3 | 3 | 39.9 | 8.7 |
| Clone form | `GET /wardrobe/:id/clone` | 200 | 6.6 | 10.2 | 3.8 | 3 | 3 | 39.4 | 8.7 |
| Properties after a category change | `POST /wardrobe/properties-fragment` | 200 | 1.8 | 3.7 | 0.8 | 1 | 1 | 4.7 | 0.7 |
| Lookalike check | `GET /wardrobe/lookalikes` | 200 | 2.7 | 3.5 | 2.0 | 2 | 2 | 0.1 | 0.1 |
| Link page | `GET /wardrobe/new/from-link` | 200 | 2.4 | 3.5 | 0.7 | 1 | 1 | 16.4 | 4.8 |
| Save a new garment | `POST /wardrobe` | 302 | 6.0 | 7.5 | 3.8 | 2 | 2 | 0.0 | 0.0 |
| Save an edit | `POST /wardrobe/:id` | 302 | 8.0 | 9.9 | 5.3 | 2 | 2 | 0.0 | 0.0 |
| Import a link | `POST /wardrobe/new/from-link` | 200 | 35.1 | 43.0 | 7.5 | 6 | 3 | 38.2 | 8.4 (8.4–8.4) |
| Choose a link’s photo | `POST /wardrobe/new/from-link/photo` | 200 | 29.7 | 29.9 | 6.9 | 5 | 2 | 0.4 | 0.4 |
| Add from a photo (upload) | `POST /wardrobe/new/photo` | 303 | 30.8 | 31.9 | 8.0 | 6 | 4 | 0.0 | 0.0 |
| Add form with a pending photo | `GET /wardrobe/new` | 200 | 3.5 | 3.8 | 2.0 | 2 | 2 | 33.7 | 7.7 (7.7–7.7) |
| Clone | `POST /wardrobe/:id/clone` | 302 | 29.2 | 36.8 | 10.1 | 6 | 4 | 0.0 | 0.0 |
| Add a copy | `POST /wardrobe/:id/copies` | 303 | 5.8 | 7.2 | 5.7 | 5 | 3 | 0.0 | 0.0 |
| Delete a garment | `DELETE /wardrobe/:id` | 200 | 6.3 | 11.5 | 5.7 | 4 | 2 | 0.0 | 0.0 |
| Save with a pending photo | `POST /wardrobe` | 302 | 9.7 | 17.1 | 9.4 | 7 | 5 | 0.0 | 0.0 |
| Add several photos (a batch of drafts) | `POST /wardrobe/new/photo` | 303 | 59.4 | 75.7 | 9.2 | 7 | 4 | 0.0 | 0.0 |
| A draft’s form | `GET /wardrobe/new` | 200 | 3.3 | 4.0 | 1.4 | 2 | 2 | 35.4 | 8.1 (8.1–8.1) |
| Save a draft | `POST /wardrobe` | 303 | 15.0 | 28.4 | 14.0 | 7 | 5 | 0.0 | 0.0 |
| Discard a draft | `POST /wardrobe/new/drafts/discard` | 303 | 9.3 | 16.2 | 7.8 | 5 | 3 | 0.0 | 0.0 |

## #162 Photos and cutouts

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Original | `GET /file/:fileName` | 200 | 0.8 | 1.1 | 0.0 | 0 | 0 | 10.7 | 10.7 |
| Cutout | `GET /file/nobg/:fileName` | 200 | 0.6 | 0.8 | 0.0 | 0 | 0 | 14.3 | 14.3 |
| Thumb | `GET /file/thumb/:fileName` | 200 | 0.5 | 0.8 | 0.0 | 0 | 0 | 12.2 | 12.2 |
| Thumb, unsigned (an old page) | `GET /file/thumb/:fileName` | 200 | 1.6 | 2.9 | 1.0 | 1 | 1 | 12.2 | 12.2 |
| Thumb, regenerated | `GET /file/thumb/:fileName` | 200 | 32.1 | 37.9 | 0.9 | 1 | 1 | 12.2 | 12.2 |
| Cutout poll (pending page) | `GET /wardrobe/:id/cutout` | 200 | 4.3 | 4.8 | 3.2 | 2 | 2 | 1.8 | 0.7 |
| Upload a photo | `POST /wardrobe/:id/photo` | 303 | 36.6 | 70.2 | 11.2 | 8 | 5 | 0.0 | 0.0 |
| Save a mask edit | `POST /wardrobe/:id/nobg` | 200 | 51.0 | 57.4 | 12.6 | 6 | 4 | 0.2 (0.2–0.2) | 0.2 (0.2–0.2) |
| Rotate the photo | `POST /wardrobe/:id/photo/rotate` | 303 | 36.6 | 39.3 | 12.9 | 9 | 6 | 0.0 | 0.0 |
| Try the cutout again | `POST /wardrobe/:id/cutout/retry` | 303 | 3.8 | 4.1 | 3.4 | 5 | 3 | 0.0 | 0.0 |

## #163 Styling

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Styling | `GET /styling` | 200 | 7.1 | 7.4 | 4.2 | 2 | 2 | 92.9 | 10.9 |
| Style this (?with=) | `GET /styling` | 200 | 15.0 | 16.8 | 11.1 | 3 | 3 | 110.4 | 12.2 |
| Edit an outfit (?outfit=) | `GET /styling` | 200 | 7.7 | 8.6 | 4.3 | 2 | 2 | 111.2 | 12.2 |
| For a planned evening (?for=) | `GET /styling` | 200 | 6.1 | 7.6 | 3.0 | 2 | 2 | 92.9 | 10.8 |
| Shuffle, one row locked | `GET /styling/shuffle` | 200 | 13.2 | 15.6 | 9.5 | 3 | 3 | 90.8 | 6.9 |
| Add a row | `GET /styling/row` | 200 | 5.4 | 12.5 | 3.2 | 2 | 2 | 72.6 | 5.8 |
| Strip paging | `GET /styling/garments` | 200 | 2.7 | 4.3 | 1.7 | 2 | 12 | 8.5 | 1.1 |
| Old builder link (/outfits/new) | `GET /outfits/new` | 302 | 0.9 | 1.2 | 0.5 | 1 | 1 | 0.0 | 0.0 |
| Old edit link (/outfits/:id/edit) | `GET /outfits/:id/edit` | 302 | 0.8 | 1.0 | 0.5 | 1 | 1 | 0.0 | 0.0 |
| Save an outfit | `POST /styling` | 303 | 4.9 | 6.0 | 4.5 | 6 | 4 | 0.0 | 0.0 |
| Save refused, the page again (an archived garment) | `POST /styling` | 409 | 19.4 | 25.9 | 11.4 | 7 | 6 | 96.2 | 11.2 |

## #164 Outfits and saved outfits

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Outfits (Saved) | `GET /outfits` | 200 | 12.8 | 15.2 | 9.8 | 2 | 2 | 64.9 | 9.0 |
| Saved, a deep page (tiles) | `GET /outfits/tiles` | 200 | 3.7 | 4.0 | 3.0 | 2 | 2 | 0.0 | 0.0 |
| Saved, picking for a day | `GET /outfits` | 200 | 8.4 | 10.9 | 5.1 | 2 | 2 | 70.4 | 9.2 |
| Outfit page (Worn strip) | `GET /outfits/:id` | 200 | 5.3 | 7.6 | 2.5 | 2 | 2 | 73.4 | 7.5 |
| Create an outfit | `POST /outfits` | 302 | 13.5 | 17.6 | 11.4 | 6 | 3 | 0.0 | 0.0 |
| Edit an outfit | `POST /outfits/:id` | 302 | 10.6 | 19.0 | 9.9 | 7 | 5 | 0.0 | 0.0 |
| Delete an outfit | `DELETE /outfits/:id` | 200 | 8.1 | 12.5 | 6.8 | 7 | 5 | 0.0 | 0.0 |

## #165 Calendar and week plan

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Week agenda | `GET /calendar` | 200 | 8.5 | 10.7 | 4.6 | 2 | 2 | 109.3 | 11.3 |
| Next week | `GET /calendar` | 200 | 8.0 | 9.4 | 4.8 | 2 | 2 | 70.8 | 9.3 |
| Month collages | `GET /calendar/month` | 200 | 9.2 | 10.7 | 6.3 | 2 | 2 | 56.8 | 8.4 |
| Last month | `GET /calendar/month` | 200 | 10.2 | 13.5 | 7.0 | 2 | 2 | 62.7 | 7.1 |
| Month weather chips | `GET /weather/summary` | 200 | 3.1 | 4.8 | 2.0 | 2 | 2 | 3.6 | 0.3 |
| + Plan sheet | `GET /calendar/plan` | 200 | 8.6 | 13.0 | 5.2 | 2 | 2 | 62.9 | 8.9 |
| Selfie | `GET /selfies/:fileName` | 200 | 2.6 | 4.8 | 1.4 | 2 | 2 | 10.9 | 10.9 |
| Selfie thumb | `GET /selfies/thumb/:fileName` | 200 | 1.9 | 3.4 | 1.1 | 2 | 2 | 2.6 | 2.6 |
| Plan an outfit on a day | `POST /calendar` | 302 | 14.5 | 17.7 | 12.4 | 6 | 4 | 0.0 | 0.0 |
| Remove a planned entry | `POST /calendar/:id/delete` | 303 | 13.1 | 17.0 | 11.0 | 6 | 3 | 0.0 | 0.0 |
| Mark worn (calendar) | `POST /calendar/:id/worn` | 303 | 10.5 | 17.1 | 8.8 | 6 | 4 | 0.0 | 0.0 |
| Plan my week | `POST /calendar/plan-week` | 303 | 11.3 | 20.8 | 8.8 | 6 | 4 | 0.0 | 0.0 |
| Undo Plan my week | `POST /calendar/plan-week/:id/undo` | 303 | 11.9 | 15.7 | 10.1 | 8 | 5 | 0.0 | 0.0 |
| Save the week template | `POST /auth/profile/week` | 303 | 11.2 | 13.6 | 8.6 | 5 | 1 | 0.0 | 0.0 |
| Add a selfie | `POST /calendar/:id/selfie` | 303 | 32.5 | 34.4 | 10.5 | 10 | 6 | 0.0 | 0.0 |
| Remove a selfie | `POST /selfies/:id/delete` | 303 | 6.1 | 7.1 | 5.3 | 2 | 2 | 0.0 | 0.0 |

## #166 Trips and packing

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Trips | `GET /trips` | 200 | 3.2 | 5.0 | 1.3 | 2 | 2 | 16.0 | 4.7 |
| Trip page and packing list | `GET /trips/:id` | 200 | 8.9 | 11.6 | 5.1 | 2 | 2 | 52.9 | 8.1 |
| New trip form | `GET /trips/new` | 200 | 2.2 | 3.7 | 0.7 | 1 | 1 | 17.3 | 4.9 |
| Edit trip form | `GET /trips/:id/edit` | 200 | 3.0 | 4.9 | 1.2 | 2 | 2 | 17.3 | 4.9 |
| Add-an-outfit page | `GET /trips/:id/outfits/new` | 200 | 9.4 | 13.0 | 5.8 | 2 | 2 | 63.1 | 8.8 |
| Trip weather | `GET /trips/:id/weather` | 200 | 1.9 | 3.4 | 1.3 | 2 | 2 | 0.1 | 0.1 |
| Ideas for the trip | `GET /outfits/ideas` | 200 | 8.9 | 13.5 | 5.7 | 3 | 3 | 41.3 | 7.1 |
| Create a trip | `POST /trips` | 303 | 7.1 | 9.5 | 6.5 | 5 | 2 | 0.0 | 0.0 |
| Edit a trip | `POST /trips/:id` | 303 | 14.1 | 16.7 | 11.8 | 5 | 3 | 0.0 | 0.0 |
| Delete a trip | `DELETE /trips/:id` | 200 | 8.0 | 10.3 | 5.8 | 2 | 2 | 0.0 | 0.0 |
| Add an outfit to the trip | `POST /trips/:id/outfits` | 303 | 12.9 | 15.3 | 10.9 | 5 | 3 | 0.0 | 0.0 |
| Remove a trip outfit | `POST /trips/:id/outfits/:tripOutfitId/delete` | 303 | 4.6 | 9.9 | 3.7 | 5 | 2 | 0.0 | 0.0 |
| Wear on a trip day | `POST /trips/:id/outfits/:tripOutfitId/wear` | 303 | 12.4 | 14.9 | 10.3 | 6 | 4 | 0.0 | 0.0 |
| Pack garments | `POST /trips/:id/packed` | 303 | 11.9 | 13.6 | 8.7 | 2 | 2 | 0.0 | 0.0 |
| Add a packing item | `POST /trips/:id/items` | 303 | 6.1 | 9.0 | 3.8 | 2 | 2 | 0.0 | 0.0 |
| Pack items | `POST /trips/:id/items/packed` | 303 | 7.4 | 9.0 | 5.2 | 2 | 2 | 0.0 | 0.0 |
| Remove a packing item | `POST /trips/:id/items/:itemId/delete` | 303 | 8.7 | 10.4 | 6.2 | 2 | 2 | 0.0 | 0.0 |
| Copy another trip’s items | `POST /trips/:id/items/copy` | 303 | 6.9 | 14.5 | 6.0 | 2 | 2 | 0.0 | 0.0 |
| Destination search | `GET /trips/:id/places` | 200 | 3.7 | 4.9 | 1.4 | 2 | 2 | 0.5 | 0.5 |
| Set the destination | `POST /trips/:id/destination` | 303 | 7.2 | 8.5 | 4.9 | 2 | 2 | 0.0 | 0.0 |

## #167 Wishlist and Bought it

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Wishlist | `GET /wardrobe/wishlist` | 200 | 9.0 | 12.9 | 5.8 | 2 | 2 | 26.2 | 6.9 |
| Wishlist item | `GET /wardrobe/:id` | 200 | 16.6 | 21.1 | 4.0 | 3 | 3 | 33.3 | 8.9 |
| Wishlist form | `GET /wardrobe/new` | 200 | 8.1 | 9.8 | 4.9 | 3 | 3 | 38.9 | 8.6 |
| Bought it form | `GET /wardrobe/:id/bought` | 200 | 4.7 | 5.8 | 2.8 | 3 | 3 | 16.7 | 4.8 |
| Style profile | `GET /auth/profile/style` | 200 | 6.4 | 8.7 | 3.6 | 2 | 2 | 44.5 | 8.2 |
| From your orders | `GET /wardrobe/orders` | 200 | 3.6 | 4.6 | 1.6 | 2 | 7 | 21.0 | 4.9 |
| Bought it | `POST /wardrobe/:id/bought` | 303 | 19.1 | 26.2 | 17.1 | 11 | 4 | 0.0 | 0.0 |
| Save the style profile | `POST /auth/profile/style` | 303 | 5.6 | 10.0 | 3.7 | 2 | 1 | 0.0 | 0.0 |
| Add an order item to the closet | `POST /wardrobe/orders/:id/add` | 200 | 37.4 | 43.3 | 10.6 | 7 | 5 | 38.4 | 8.4 (8.4–8.4) |
| Dismiss an order item | `POST /wardrobe/orders/:id/dismiss` | 303 | 4.1 | 5.1 | 3.8 | 2 | 2 | 0.0 | 0.0 |

## #168 Ideas gallery

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Ideas | `GET /outfits/ideas` | 200 | 12.6 | 14.5 | 7.8 | 2 | 2 | 51.7 | 7.7 |
| Ideas for a planned evening | `GET /outfits/ideas` | 200 | 14.9 | 17.6 | 7.8 | 2 | 2 | 57.8 | 7.7 |
| Ideas with a garment | `GET /outfits/ideas` | 200 | 13.5 | 17.6 | 9.0 | 3 | 3 | 53.9 | 7.3 |
| More ideas (page 2) | `GET /outfits/ideas/more` | 200 | 10.7 | 13.9 | 7.5 | 2 | 2 | 33.5 | 2.6 |
| More ideas (page 50, the cap) | `GET /outfits/ideas/more` | 200 | 27.4 | 33.6 | 6.3 | 2 | 2 | 33.2 | 2.4 |
| Pick an idea | `POST /outfits/ideas/pick` | 303 | 14.0 | 18.3 | 12.2 | 6 | 6 | 0.0 | 0.0 |
| Never pair these (clash) | `POST /outfits/ideas/avoid` | 303 | 4.5 | 5.8 | 2.9 | 2 | 2 | 0.0 | 0.0 |
| Pair them again | `POST /outfits/ideas/allow` | 303 | 4.3 | 6.8 | 3.0 | 2 | 2 | 0.0 | 0.0 |
| Too warm | `POST /outfits/ideas/feedback` | 303 | 7.1 | 9.1 | 5.2 | 2 | 2 | 0.0 | 0.0 |

## #169 Insights and yearly recap

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Insights | `GET /wardrobe/insights` | 200 | 9.9 | 10.9 | 10.7 | 3 | 86 | 58.8 | 9.4 |
| Insights, unworn 30 days | `GET /wardrobe/insights` | 200 | 9.5 | 11.3 | 9.5 | 3 | 86 | 69.7 | 10.5 |
| Year in review | `GET /wardrobe/recap` | 200 | 8.1 | 9.2 | 9.4 | 3 | 89 | 30.5 | 7.1 |
| Year in review, last year | `GET /wardrobe/recap` | 200 | 5.4 | 7.0 | 5.2 | 3 | 84 | 16.9 | 4.7 |

## #170 Sharing and shared views

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Shared wardrobe | `GET /wardrobe` | 200 | 6.1 | 6.9 | 4.8 | 3 | 14 | 36.5 | 8.3 |
| Shared garment | `GET /wardrobe/:id` | 200 | 5.7 | 6.8 | 3.5 | 3 | 3 | 25.6 | 7.3 |
| Shared capsules | `GET /capsules` | 200 | 5.8 | 7.8 | 4.0 | 2 | 2 | 25.2 | 6.4 |
| Shared wishlist | `GET /wardrobe/wishlist` | 200 | 6.2 | 7.3 | 4.3 | 2 | 2 | 23.7 | 6.2 |
| Styling a shared wardrobe | `GET /styling` | 200 | 6.0 | 6.9 | 3.5 | 2 | 2 | 55.6 | 7.5 |
| Share page, garment (signed out) | `GET /share` | 200 | 2.7 | 3.3 | 1.3 | 1 | 1 | 9.4 | 3.0 |
| Share page, outfit (signed out) | `GET /share` | 200 | 3.4 | 3.9 | 1.9 | 1 | 1 | 10.0 | 3.1 |
| Share preview image | `GET /file/watermark/:shareableId` | 200 | 17.4 | 20.5 | 1.9 | 1 | 1 | 29.1 | 29.1 |
| Old manage page | `GET /wardrobe-share/manage` | 301 | 1.8 | 2.3 | 1.4 | 1 | 1 | 0.0 | 0.0 |
| Create an invite link | `POST /wardrobe-share/create-invite-link` | 200 | 5.1 | 7.5 | 3.8 | 2 | 2 | 0.7 | 0.7 |
| Invite landing | `GET /wardrobe-share/invite/:token` | 200 | 2.5 | 2.9 |  | 2 | 2 | 13.0 (13.0–13.0) | 3.7 (3.7–3.7) |
| Accept an invite | `POST /wardrobe-share/invite/:token/accept` | 302 | 5.5 | 6.7 |  | 3 | 3 | 0.0 | 0.0 |
| Decline an invite | `POST /wardrobe-share/invite/:token/decline` | 302 | 1.8 | 2.3 |  | 2 | 1 | 0.0 | 0.0 |
| Remove a share | `POST /wardrobe-share/:id/remove` | 302 | 4.1 | 4.9 | 3.8 | 2 | 2 | 0.0 | 0.0 |
| Edit a shared garment (MANAGE) | `POST /wardrobe/:id` | 302 | 2.8 | 3.7 | 2.4 | 2 | 2 | 0.0 | 0.0 |

## #171 Auth, account and push

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Profile | `GET /auth/profile` | 200 | 4.6 | 6.0 | 9.8 | 7 | 25 | 34.7 | 8.1 |
| Sign-in page | `GET /auth/login` | 200 | 0.8 | 1.1 | 0.0 | 0 | 0 | 10.1 | 3.1 |
| Registration page | `GET /auth/register` | 200 | 0.8 | 1.0 | 0.0 | 0 | 0 | 10.5 | 3.1 |
| Change email page | `GET /auth/update-email` | 200 | 2.0 | 2.9 | 0.8 | 1 | 1 | 16.7 | 4.7 |
| Change password page | `GET /auth/change-password` | 200 | 1.8 | 2.2 | 0.7 | 1 | 1 | 16.9 | 4.8 |
| Sign out everywhere page | `GET /auth/sign-out-everywhere` | 200 | 1.7 | 2.2 | 0.6 | 1 | 1 | 16.6 | 4.8 |
| Delete account page | `GET /auth/delete-account` | 200 | 1.7 | 2.8 | 0.6 | 1 | 1 | 16.7 | 4.8 |
| Agent access (tokens) | `GET /auth/tokens` | 200 | 2.7 | 3.7 | 1.3 | 2 | 13 | 21.8 | 4.7 |
| Sign-out page | `GET /auth/logout` | 200 | 1.7 | 3.0 | 0.6 | 1 | 1 | 15.3 | 4.4 |
| Sizes | `GET /auth/profile/sizes` | 200 | 3.4 | 4.5 | 2.3 | 3 | 10 | 31.5 | 6.0 |
| Brand size hint | `GET /auth/profile/sizes/hint` | 200 | 1.8 | 2.2 | 1.4 | 2 | 2 | 0.2 | 0.2 |
| VAPID public key | `GET /push/vapid-public-key` | 200 | 1.0 | 1.1 | 0.7 | 1 | 1 | 0.1 | 0.1 |
| Sign in | `POST /auth/login` | 302 | 237.4 | 255.9 |  | 1 | 1 | 0.0 | 0.0 |
| Register | `POST /auth/register` | 302 | 212.8 | 216.4 | 5.8 | 1 | 1 | 0.0 | 0.0 |
| Validate registration (as typed) | `POST /auth/validate/register` | 200 | 0.1 | 0.2 | 0.0 | 0 | 0 | 0.4 | 0.4 |
| Validate an email change | `POST /auth/validate/update-email` | 200 | 0.7 | 0.7 | 0.5 | 1 | 1 | 0.1 | 0.1 |
| Change email | `POST /auth/update-email` | 302 | 217.0 | 219.9 |  | 2 | 2 | 0.0 | 0.0 |
| Change password | `POST /auth/change-password` | 302 | 433.4 | 436.6 |  | 5 | 3 | 0.0 | 0.0 |
| Delete account | `POST /auth/delete-account` | 302 | 223.1 | 225.7 |  | 6 | 3 | 0.0 | 0.0 |
| Create an access token | `POST /auth/tokens` | 200 | 223.5 | 226.9 |  | 6 | 3 | 16.9 | 4.8 (4.8–4.8) |
| Revoke an access token | `POST /auth/tokens/:id/revoke` | 303 | 2.6 | 4.8 | 2.1 | 2 | 2 | 0.0 | 0.0 |
| Sign out | `POST /auth/logout` | 303 | 0.4 | 0.4 | 0.2 | 1 | 1 | 0.0 | 0.0 |
| Subscribe a device | `POST /push/subscribe` | 204 | 2.0 | 2.2 | 1.6 | 2 | 2 | 0.0 | 0.0 |
| Unsubscribe a device | `POST /push/unsubscribe` | 204 | 2.4 | 3.4 | 2.0 | 2 | 2 | 0.0 | 0.0 |
| Send a test notification | `POST /push/test` | 200 | 6.4 | 11.4 | 3.3 | 2 | 25 | 0.1 | 0.1 |
| Sizes: unit | `POST /auth/profile/sizes/unit` | 303 | 8.9 | 10.9 | 6.0 | 2 | 1 | 0.0 | 0.0 |
| Sizes: measurements | `POST /auth/profile/sizes/measurements` | 303 | 9.2 | 16.1 | 6.3 | 3 | 2 | 0.0 | 0.0 |
| Sizes: add a brand | `POST /auth/profile/sizes/brands` | 303 | 5.2 | 5.9 | 4.8 | 4 | 2 | 0.0 | 0.0 |
| Sizes: edit a brand | `POST /auth/profile/sizes/brands/:id` | 303 | 4.6 | 5.6 | 3.3 | 2 | 2 | 0.0 | 0.0 |
| Sizes: remove a brand | `POST /auth/profile/sizes/brands/:id/delete` | 303 | 7.5 | 9.3 | 5.1 | 2 | 2 | 0.0 | 0.0 |
| Weather: city search | `GET /weather/places` | 200 | 2.2 | 3.9 | 0.8 | 1 | 1 | 0.5 | 0.5 |
| Weather: set home | `POST /weather/home` | 200 | 5.5 | 6.0 | 4.3 | 3 | 2 | 1.6 | 0.6 |
| Weather: use this phone’s location | `POST /weather/here` | 200 | 9.2 | 12.7 | 5.3 | 3 | 2 | 1.3 | 0.5 |
| Weather: stop using this phone’s location | `POST /weather/here/clear` | 200 | 9.7 | 11.7 | 5.7 | 3 | 2 | 1.6 | 0.6 |
| Weather: unit | `POST /weather/unit` | 200 | 7.3 | 10.0 | 4.7 | 3 | 2 | 0.9 | 0.9 |
| Weather: feels warmer or colder | `POST /weather/feedback` | 200 | 6.0 | 10.3 | 4.0 | 3 | 3 | 0.8 (0.6–0.8) | 0.8 (0.6–0.8) |
| Weather: reset the offset | `POST /weather/offset/reset` | 200 | 4.4 | 5.2 | 4.0 | 3 | 2 | 0.6 | 0.6 |
| Weather: remove home | `POST /weather/home/clear` | 200 | 9.0 | 10.6 | 5.5 | 3 | 2 | 1.5 | 0.6 |
| Weather: set home again | `POST /weather/home` | 200 | 12.0 | 12.0 | 6.5 | 3 | 2 | 1.6 | 0.6 |

## #172 MCP tools

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| get_today | `mcp get_today` | 200 | 10.9 | 18.2 |  | 3 | 3 | 1.7 (1.7–1.7) | 0.7 (0.7–0.7) |
| search_garments | `mcp search_garments` | 200 | 2.1 | 2.5 |  | 3 | 51 | 11.6 | 0.4 (0.4–0.4) |
| search_garments (keyword) | `mcp search_garments` | 200 | 6.0 | 8.0 |  | 3 | 31 | 7.8 | 0.5 |
| get_wardrobe | `mcp get_wardrobe` | 200 | 5.2 | 6.7 |  | 3 | 276 | 51.1 | 3.2 (3.2–3.2) |
| get_garment | `mcp get_garment` | 200 | 4.2 | 5.1 |  | 3 | 3 | 3.4 (3.4–3.4) | 0.8 (0.8–0.8) |
| get_garment_photo | `mcp get_garment_photo` | 200 | 3.4 | 4.0 |  | 3 | 3 | 1.1 | 0.7 (0.7–0.7) |
| update_garment | `mcp update_garment` | 200 | 4.8 | 6.4 |  | 4 | 4 | 1.2 | 0.6 (0.6–0.6) |
| add_garment_copy | `mcp add_garment_copy` | 200 | 5.4 | 8.2 |  | 7 | 5 | 0.9 | 0.9 |
| list_wishlist | `mcp list_wishlist` | 200 | 1.4 | 1.8 |  | 2 | 4 | 0.7 | 0.7 |
| add_garment_from_link | `mcp add_garment_from_link` | 200 | 36.8 | 39.0 |  | 13 | 8 | 1.2 | 0.6 |
| list_capsules | `mcp list_capsules` | 200 | 1.5 | 1.7 |  | 2 | 2 | 1.5 | 0.2 (0.2–0.2) |
| get_capsule | `mcp get_capsule` | 200 | 1.6 | 2.5 |  | 3 | 29 | 7.5 | 1.3 (1.3–1.3) |
| set_capsule_membership | `mcp set_capsule_membership` | 200 | 2.8 | 4.0 |  | 5 | 2 | 0.1 | 0.1 |
| list_outfits | `mcp list_outfits` | 200 | 2.8 | 6.3 |  | 2 | 2 | 9.0 | 1.5 |
| get_outfit | `mcp get_outfit` | 200 | 1.0 | 1.3 |  | 2 | 2 | 0.3 | 0.3 |
| create_outfit | `mcp create_outfit` | 200 | 3.6 | 3.9 |  | 7 | 7 | 0.1 | 0.1 |
| schedule_outfit | `mcp schedule_outfit` | 200 | 3.5 | 3.9 |  | 6 | 4 | 0.2 | 0.2 |
| suggest_outfits | `mcp suggest_outfits` | 200 | 5.7 | 6.3 |  | 3 | 6 | 3.6 | 0.7 (0.7–0.7) |
| goes_with_closet | `mcp goes_with_closet` | 200 | 6.0 | 6.9 |  | 2 | 2 | 2.3 | 0.6 |
| pick_outfit | `mcp pick_outfit` | 200 | 5.0 | 7.5 |  | 7 | 7 | 0.2 | 0.2 |
| get_calendar | `mcp get_calendar` | 200 | 3.8 | 4.4 |  | 3 | 6 | 10.3 | 1.4 |
| laundry_status | `mcp laundry_status` | 200 | 1.8 | 2.5 |  | 2 | 15 | 1.7 | 0.3 |
| mark_worn | `mcp mark_worn` | 200 | 2.7 | 3.3 |  | 2 | 2 | 0.1 | 0.1 |
| mark_washed | `mcp mark_washed` | 200 | 2.9 | 3.1 |  | 2 | 2 | 0.1 | 0.1 |
| plan_week | `mcp plan_week` | 200 | 5.2 | 6.7 |  | 6 | 4 | 0.2 | 0.2 |
| list_trips | `mcp list_trips` | 200 | 1.8 | 2.1 |  | 2 | 71 | 12.3 | 0.4 |
| get_trip | `mcp get_trip` | 200 | 2.3 | 2.6 |  | 2 | 2 | 5.5 | 0.9 (0.9–0.9) |
| plan_trip_outfit | `mcp plan_trip_outfit` | 200 | 3.5 | 4.5 |  | 5 | 3 | 0.2 | 0.2 |
| wardrobe_stats | `mcp wardrobe_stats` | 200 | 6.4 | 6.8 |  | 3 | 247 | 17.1 | 2.0 (2.0–2.0) |
| get_weather | `mcp get_weather` | 200 | 3.1 | 4.1 |  | 3 | 6 | 1.8 | 0.5 |
| list_shared_wardrobes | `mcp list_shared_wardrobes` | 200 | 1.0 | 2.9 |  | 2 | 2 | 0.1 | 0.1 |
| compare_with_shared_wardrobe | `mcp compare_with_shared_wardrobe` | 200 | 5.6 | 6.8 |  | 4 | 255 | 38.0 | 5.1 |
| get_style_profile | `mcp get_style_profile` | 200 | 1.7 | 2.8 |  | 2 | 2 | 1.0 | 0.4 |
| get_sizes | `mcp get_sizes` | 200 | 1.3 | 1.9 |  | 3 | 33 | 2.7 | 0.5 |
| get_closet_coverage | `mcp get_closet_coverage` | 200 | 2.3 | 3.4 |  | 2 | 242 | 0.5 | 0.5 |
| list_suggestions | `mcp list_suggestions` | 200 | 2.9 | 3.7 |  | 3 | 3 | 0.2 | 0.2 |
| get_suggestion_feedback | `mcp get_suggestion_feedback` | 200 | 2.0 | 2.9 |  | 2 | 2 | 0.2 (0.2–0.2) | 0.2 (0.2–0.2) |
| create_option_group | `mcp create_option_group` | 200 | 3.2 | 5.9 |  | 5 | 3 | 0.1 (0.1–0.1) | 0.1 (0.1–0.1) |
| suggest_garment | `mcp suggest_garment` | 200 | 71.7 | 113.6 |  | 18 (18–19) | 11 | 0.3 | 0.3 |
| suggest_outfit | `mcp suggest_outfit` | 200 | 11.4 | 22.0 |  | 7 | 7 | 0.1 (0.1–0.1) | 0.1 (0.1–0.1) |
| finish_round | `mcp finish_round` | 200 | 7.8 | 9.8 |  | 6 | 3 | 0.1 | 0.1 |

## #173 Background jobs

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Morning reminders (with the re-plan first) | `job reminders` |  | 0.6 | 0.9 |  | 1 | 1 | 0.0 | 0.0 |
| Evening reminders | `job reminders` |  | 2.9 | 4.7 |  | 3 | 3 | 0.0 | 0.0 |
| Reminders, nothing due | `job reminders` |  | 0.5 | 0.7 |  | 1 | 1 | 0.0 | 0.0 |
| Reminder claims prune | `job reminder_prune` |  | 0.3 | 0.4 |  | 1 | 0 | 0.0 | 0.0 |
| Week re-plan | `job replan` |  | 15.8 | 25.9 |  | 8 | 17 | 0.0 | 0.0 |
| Week re-plan, already done today | `job replan` |  | 0.9 | 1.9 |  | 1 | 0 | 0.0 | 0.0 |
| Re-plan claims prune | `job replan_prune` |  | 0.3 | 0.8 |  | 1 | 0 | 0.0 | 0.0 |
| Forecast refresh | `job weather refresh` |  | 1.3 | 3.1 |  | 1 | 1 | 0.0 | 0.0 |
| Cutout of an uploaded photo | `job cutout` |  | 103.9 | 122.3 |  | 11 | 4 | 0.0 | 0.0 |
| Cutout retry (nightly) | `job cutout_retry` |  | 1.1 | 1.9 |  | 1 | 0 | 0.0 | 0.0 |
| Storage reconciliation (nightly) | `job reconciliation` |  | 38.2 | 42.8 |  | 4 | 197 | 0.0 | 0.0 |
| Order mail poll (one new order email) | `job order_mail` |  | 18.0 | 23.3 |  | 6 | 3 | 0.0 | 0.0 |
| Order mail poll, nothing new | `job order_mail` |  | 4.1 | 5.7 |  | 2 | 2 | 0.0 | 0.0 |

## #174 Per-request platform overhead

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Health check | `GET /healthz` | 200 | 0.8 | 1.7 | 0.6 | 1 | 1 | 0.4 | 0.4 |
| Liveness | `GET /health/live` | 200 | 0.1 | 0.1 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| Readiness | `GET /health/ready` | 200 | 0.7 | 1.1 | 0.6 | 1 | 1 | 0.4 | 0.4 |
| About, signed in | `GET /about` | 200 | 1.7 | 2.2 | 0.6 | 1 | 1 | 16.1 | 4.8 |
| About, signed out | `GET /about` | 200 | 0.7 | 0.8 | 0.0 | 0 | 0 | 9.7 | 3.1 |
| Offline page | `GET /offline.html` | 200 | 1.5 | 2.1 | 0.6 | 1 | 1 | 16.1 | 4.4 |
| Manifest | `GET /manifest.json` | 200 | 0.4 | 0.5 | 0.0 | 0 | 0 | 1.1 | 0.5 |
| Asset links | `GET /.well-known/*` | 200 | 0.1 | 0.2 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| Stylesheet | `GET /*` | 200 | 0.9 | 1.0 | 0.0 | 0 | 0 | 154.5 | 21.3 |
| Service worker | `GET /*` | 200 | 0.6 | 0.8 | 0.0 | 0 | 0 | 54.7 | 17.0 |
| A page script | `GET /*` | 200 | 0.5 | 0.7 | 0.0 | 0 | 0 | 4.0 | 1.5 |
| Not found page | `GET (unmatched)` | 404 | 2.5 | 3.1 | 0.7 | 1 | 1 | 16.0 | 4.5 |
| Metrics scrape | `GET /metrics` | 200 | 3.2 | 4.1 | 0.0 | 1 | 1 (0–1) | 188.8 (186.2–188.8) | 10.9 (10.7–11.0) |
| Device timings beacon | `POST /metrics/vitals` | 204 | 2.9 | 5.1 | 1.2 | 1 | 1 | 0.0 | 0.0 |
| Script error beacon | `POST /errors/client` | 204 | 1.8 | 3.5 | 0.8 | 1 | 1 | 0.0 | 0.0 |

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
