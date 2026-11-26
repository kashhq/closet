# demo: Theo Marsh

> A 31-year-old backend engineer in Brooklyn who dresses like he thought about it once, properly, and
> now doesn't have to. Elevated basics all week, a sharper version for meeting days and dates.
> Neutrals so everything goes with everything. Buys in bursts, keeps things for years.

This file is the persona's character bible **and the seed's data**: `npm run seed` reads the tables
below (`src/seed/bible.ts`) and simulates Theo's history from them (`src/seed/simulate.ts`). Edit a
table and the next `--reset` shows it; the prose explains the rules the simulation implements. The
demo doubles as the owner's aspirational target wardrobe (owner, 2026-09-26): what a well-built NYC
tech-worker closet looks like, with real products to Clone and, later, buy (#18, #34).

## Account

| Field | Value |
|---|---|
| Email | demo@closet.invalid |
| First name | Theo |
| Last name | Marsh |
| Weather home | Fort Greene, Brooklyn |
| Weather location | 40.69, -73.98 |
| Temperature unit | fahrenheit |

`.invalid` is reserved (RFC 2606): the address can never be a real person's or collide with a
household account. The weather home (#14) is Fort Greene Park rounded to two decimals, about a
kilometre, as the app stores every location; he reads temperatures in °F. Riley and Dana have none: the
fresh account's header asks for a city, and Dana has never opened the profile.

## Who he is

- **Theo Marsh**, 31. Senior backend engineer (payments platform) at a ~400-person fintech with an
  office on Broadway at 19th St (Flatiron). Moved to New York from Minneapolis in October 2023 for the
  job; promoted to senior in March 2025.
- Lives in a one-bedroom walk-up in **Fort Greene**, Brooklyn. Commute: Q train DeKalb Av to Union Sq,
  25 minutes door to desk; walks the last blocks up Broadway. No car. Walks everywhere on weekends
  (Fort Greene Park, the Saturday greenmarket, Atlantic Terminal errands, Prospect Heights bars).
- Runs in Fort Greene Park before work twice a week and lifts at a gym on Flatbush on Saturdays.
- Single-ish: has been seeing someone since June; dinner or drinks roughly once a week, usually Friday
  or Saturday.
- Sizes: tops M, trousers 32 waist / 32 leg, belt 34, US shoe 10.
- Budget: most pieces $30-150; a few investment pieces $200-400 (the blazer, the Red Wings, the
  coat), three splurges above that (the AllSaints leather jacket on the October 2025 sale, the
  Patagonia parka for his first winter, the Allen Edmonds for the wedding; kept, owner 2026-09-26).
- Palette: navy, white, grey, black, stone/beige, with olive and brown as accents. One pattern at a
  time (a Breton stripe or a flannel check), never two.

## His week

`Draws from` is the occasions a day's outfit comes from (the Occasion column of Saved outfits).
`Calendar` is the part of the day that outfit is planned for on the calendar (#13: `all-day` or
`work`), and `Workout` the saved outfit of the morning's workout, a calendar entry of its own
(`workout`) before it. The table is also his **week template** (#16, Profile › Your week): each
day's `Calendar` occasion, plus a workout where the day has one (Monday and Thursday runs, the
Saturday gym), which "Plan my week" fills; date nights and nights out come some weeks, not on a
weekday, so they are not in it and he plans them himself.

| Day | Draws from | Calendar | Workout | Where | What he wears | Notes |
|---|---|---|---|---|---|---|
| Sun | weekend, wfh | all-day | — | home | lounge, brunch nearby | **laundry** (wash-and-fold on DeKalb Av, 10 am drop-off, 6 pm pick-up) |
| Mon | wfh | all-day | Run | home | lounge: tee or hoodie, joggers or sweatpants, slides | 7 am run |
| Tue | office | work | — | office | smart casual: oxford or knit polo, chinos, loafers or white sneakers | team day |
| Wed | office | work | — | office | smart casual; **the blazer on meeting days** (every other Wednesday: architecture review) | |
| Thu | office | work | Run | office | the most relaxed office day (tee + chore coat or merino, jeans allowed) | 7 am run |
| Fri | wfh | all-day | — | home | casual; **date night** some weeks (Fri or Sat) | |
| Sat | weekend | all-day | Gym | out | gym in the morning, errands and the greenmarket, sometimes dinner or drinks | |

## Events

Days the rules do not decide: `Wears` names the saved outfit worn (or `not recorded`), `Weather` shifts
the day's temperature. Dates are reference dates (see Simulation).

| From | To | Event | Wears | Weather |
|---|---|---|---|---|
| 2026-07-18 | 2026-07-18 | Rockaway Beach with friends | Rockaway | — |
| 2026-07-21 | 2026-07-25 | Heat wave (feels-like 95-100°F) | — | +8 |
| 2026-08-19 | 2026-08-19 | Flies to a conference in Austin (hot) with the duffel and the sling | Conference travel | — |
| 2026-08-20 | 2026-08-20 | At the conference; forgets to log it | not recorded | — |
| 2026-08-21 | 2026-08-21 | Flies home in the same travel outfit | Conference travel | — |
| 2026-08-29 | 2026-08-29 | Friend's wedding in the Hudson Valley: the one formality-4 day | Wedding | — |
| 2026-09-24 | 2026-09-24 | First cool morning (low 55°F): chore coat over the henley | Thursday chore coat | -8 |

Shopping bursts are the garments' Acquired dates: the move (2023-10-21), Black Friday 2024
(2024-11-29), the promotion (2025-03-15), summer 2025 (2025-06-14), fall 2025 (2025-10-25), the tee
reset (2026-05-09), the wedding (2026-08-15: tie and dress shoes), the fall refresh (2026-09-12: the
chore coat, the waffle henley, the Red Wings).

## Trips (#10)

The Austin conference of the Events table, as the trip he planned before it: a trip is a standalone list
of outfits for its days and occasions (not the calendar), and its packing list is derived from them. He
packed the night before and left the office outfit and the rooftop evening's out of the duffel until the
morning, so the list is partly packed. Dates are reference dates and move with the Events (see
Simulation); the destination is located (rounded like the weather home) only when the app has weather on.
Written through the trip form (`readTripForm`, `createTrip`), `setTripDestination`, `addTripOutfit`,
`addTripItems`, `setItemsPacked` and `setPacked`.

| Trip | From | To | Destination | Location | Notes |
|---|---|---|---|---|---|
| Austin conference | 2026-08-19 | 2026-08-21 | Austin, Texas, United States | 30.27, -97.74 | Hot: nothing that wrinkles, one bag. |

### Trip outfits

`Outfit` is a saved outfit's name; `Occasion` the part of the day it is for (`—`: not said).

| Trip | Day | Occasion | Outfit |
|---|---|---|---|
| Austin conference | 2026-08-19 | all-day | Conference travel |
| Austin conference | 2026-08-20 | workout | Run |
| Austin conference | 2026-08-20 | work | Sweater-polo office |
| Austin conference | 2026-08-20 | evening | Rooftop drinks |
| Austin conference | 2026-08-21 | all-day | Conference travel |

### Trip extras

| Trip | Extra | Packed |
|---|---|---|
| Austin conference | Laptop and charger | yes |
| Austin conference | Phone charger | yes |
| Austin conference | Toiletry kit | yes |
| Austin conference | Conference badge | no |
| Austin conference | Sunscreen | no |

### Trip packing

The garments marked packed: the travel outfit and the run's; the office outfit and the rooftop tee not yet.

| Trip | Garments packed |
|---|---|
| Austin conference | T08, B06, F02, G04, G03, T09, B13, F04, A01 |

## His taste (what he buys, and why)

- **Elevated basics**: Uniqlo U and Everlane for the everyday tees; Buck Mason, COS and J.Crew for the
  heavier and better-cut versions. He learned he prefers a 6-7 oz tee that holds its shape and does
  not show through a chore coat.
- **Smart casual / date-night sharp**: Suitsupply for the blazer and wool trousers, J.Crew for oxfords
  and knit polos, AllSaints for the one good leather jacket, penny loafers and suede Chelsea boots.
- **The tech-worker layer he will not give up**: Patagonia (Better Sweater, Down Sweater, Torrentshell),
  Allbirds, an Aer backpack. He knows.
- **Denim**: a 14.5 oz raw selvedge pair he is breaking in (bought May 2026: not washed yet, on
  purpose), Levi's 501s for everything else, black 511s for nights out.
- **Multiples**: white Uniqlo U tee x3 (one per office day), black Bombas socks x6 (the `Qty` column:
  one garment with that many identical copies, #7).
- **Archived**: the tees and shoes he replaced (kept in the app, not the closet).

## Next buys (his wishlist, #18)

The same grey merino crewneck again, before the old one's elbows go (T21 is `replace_soon`); a padded
shirt jacket for November; and white Allbirds Couriers, the sensible stand-in for the Common Projects
Achilles he keeps talking himself out of. Written with status `wishlist` (the seed's own table below):
not in the closet, the builder, capsules or laundry until "Bought it". Links checked on 2026-09-26
(`verified` = the brand's page or catalog answered). Price is the listed price; no acquired date.

### Wishlist

| id | Name in the app | Brand | Category / type | Colours | Product | Price | Size | Warmth | Form. | Materials | Pattern | Fit | Sleeve | Replaces | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| W01 | New grey merino crewneck | Uniqlo | tops / sweater | grey | [Uniqlo Merino Sweater (crew), Gray](https://www.uniqlo.com/us/en/products/E450535-000/00) (verified; same page as T20) | $49.90 | M | 3* | 3 | merino | solid | regular | long | T21 | Like for like: the one he has is pilling at the elbows. |
| W02 | Padded shirt jacket | Uniqlo | outerwear / jacket | brown | [Uniqlo Padded Shirt Jacket, Dark Brown](https://www.uniqlo.com/us/en/products/E489492-000/00) (verified) | $89.90 | M | 3 | 2 | — | — | regular | — | — | November, between the chore coat and the parka. |
| W03 | White Couriers | Allbirds | footwear / sneakers | white | [Allbirds Men's Courier, Blizzard](https://www.allbirds.com/products/mens-couriers-blizzard) (verified) | $98 | 10 | 2 | 2 | — | — | — | — | — | The sensible pair; the Common Projects stay a fantasy. |

## His style profile (#34)

What he dresses for and toward: the style profile (`src/wardrobe/style.ts`'s sets, the palette in
`GARMENT_COLORS`). The week's rhythm it shows (work 3× a week, all day 4×, workouts 3×) is derived
from his week template, the week table above (#16), not stored with the profile. His home location
is the weather's (#14), not the profile's. Posted through the style profile form's own validation
(`readStyleProfileForm`).

### Style profile

| Setting | Value |
|---|---|
| Styles | elevated-basics, smart-casual, outdoor-technical |
| Budget | mid |
| Palette | blue, white, grey, black, beige, green, brown |
| Notes | One pattern at a time, never two. A few investment pieces: the blazer, the boots, the coat. |

## His sizes (#24)

What fits him, in Profile › Sizes: his measurements (a tailor took them for the blazer) and the size
he wears in the brands he buys, with how each runs. Private to him; the garment form and his wishlist
show a brand's note, so the two Uniqlo items and the Allbirds on his Wishlist say "Your size in ...".
He reads lengths in inches (`Unit`). Posted through the Sizes editor's own readers
(`readMeasurementsForm`, `readBrandSizeForm`): a length out of range, or a brand with neither a size
nor a note, fails the seed.

### Measurements

| Measurement | Value |
|---|---|
| Unit | in |
| Height | 70 |
| Neck | 15.5 |
| Shoulders | 18 |
| Chest | 39 |
| Sleeve | 34 |
| Waist | 32 |
| Hips | 38 |
| Inseam | 32 |

### Brand sizes

| Brand | Size | Note |
|---|---|---|
| Uniqlo | M | Uniqlo U runs big and boxy: M, never L. Trousers 32. |
| Allbirds | 10 | Whole sizes only; true to size. |
| Red Wing | 9 | Runs large: a full size down from his sneakers. |
| L.L.Bean | 9 | Bean Boots run large: size down. |
| G.H. Bass | 9.5 | Weejuns run half a size large. |
| Suitsupply | 40R | Trousers 32 (EU 48). |
| J.Crew | M | Slim fit in shirts; chinos 32x32. |
| Everlane | M | Runs small, but he likes the tees fitted. |

## What he owns (83 garments: 80 in the closet, 3 archived)

Every garment names a real product on sale on 2026-09-26 (researched and checked that day: `verified`
= the brand's page was fetched; `search` = found in search results, the site blocks bots). Values are
the app's own sets: categories and types from `src/wardrobe/properties.ts`, colours from
`GARMENT_COLORS` (`src/wardrobe/properties.ts`), warmth 1-5, formality 1-4, materials, pattern, fit,
sleeve and length from `properties.ts`. Warmth follows the type preset and weight steps unless marked
`*` (set by hand, as the form allows; the marks differ from the preset on purpose, so "your value is
kept when the type changes" has real examples). Weight is what Theo typed, in oz. `WR` =
water-resistant. Sizes as he types them (`M` is stored `Medium`). Price is what he paid. The seed
posts every row through the garment form's own validation (`readGarmentForm`), so a value the app
would not store fails the seed. `—` is empty.

**Photos are generated art** (owner, 2026-09-26): a flat-lay silhouette of each garment's type in its
colours and pattern, drawn at seed time (`src/seed/art.ts`), stored through `Photos` as its own
cutout. No image files in the repo.

### Tops

| id | Name in the app | Brand | Type | Colours | Product | Price | Size | Warmth | Form. | Materials | Pattern | Fit | Sleeve | Weight | Qty | Acquired | Why he owns it |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T01 | White tee | Uniqlo | t-shirt | white | [Uniqlo U Crew Neck T-Shirt, 00 White](https://www.uniqlo.com/us/en/products/E422992-000/00) (verified) | $24.90 | M | 2 | 2 | cotton | solid | regular | short | — | **3** | 2026-05-09 | The base of everything; three so every office day has a clean one until Sunday. |
| T02 | Black tee | Uniqlo | t-shirt | black | [Uniqlo U Crew Neck T-Shirt, 09 Black](https://www.uniqlo.com/us/en/products/E422992-000/00) (same page as T01) | $24.90 | M | 2 | 2 | cotton | solid | regular | short | — | 1 | 2026-05-09 | Nights out under the leather jacket; with black jeans. |
| T03 | Grey tee | Uniqlo | t-shirt | grey | [Uniqlo U Crew Neck T-Shirt, 03 Gray](https://www.uniqlo.com/us/en/products/E422992-000/00) (same page as T01) | $24.90 | M | 2 | 2 | cotton | solid | regular | short | — | 1 | 2026-05-09 | WFH and gym-adjacent days. |
| T04 | Navy tee | Everlane | t-shirt | blue | [Everlane The Essential Organic Crew, Deep Navy](https://www.everlane.com/products/mens-essential-organic-crew-uniform-deep-navy) (verified) | $34 | M | 2 | 2 | cotton | solid | slim | short | — | 1 | 2025-06-14 | The lightest tee he owns: July. |
| T05 | Olive slub tee | Buck Mason | t-shirt | green | [Buck Mason Slub Classic Tee, Olive Drab](https://www.buckmason.com/products/olive-drab-slub-classic-tee) (verified) | $48 | M | 2 | 2 | cotton | solid | regular | short | 4.3 oz | 1 | 2025-06-14 | The one colour accent tee; weekends with navy shorts. |
| T06 | White heavyweight tee | Everlane | t-shirt | white | [Everlane The Premium-Weight Relaxed Crew, White](https://www.everlane.com/products/mens-hvywt-ovrszd-crew-white) (verified) | $48 | M | 3 | 2 | cotton | solid | relaxed | short | 6.2 oz | 1 | 2026-05-09 | A tee that holds its shape on its own; errands with 501s. |
| T07 | Black heavyweight tee | J.Crew | t-shirt | black | [J.Crew Relaxed Premium-weight Cotton T-shirt](https://www.jcrew.com/p/mens/categories/clothing/tshirts-and-polos/t-shirts/relaxed-premium-weight-cotton-t-shirt/BN184) (search) | ~$48 | M | 3 | 2 | cotton | solid | relaxed | short | 7.4 oz | 1 | 2026-05-09 | Rooftop drinks without looking like he is at the gym. |
| T08 | Charcoal heavyweight tee | COS | t-shirt | grey | [COS Relaxed Heavyweight Washed-Cotton T-Shirt, washed charcoal](https://www.cos.com/en-us/men/menswear/tshirts/relaxed-fit/product/heavyweight-cotton-t-shirt-washed-charcoal-1327375001) (search) | ~$49 | M | 3 | 2 | cotton | solid | relaxed | short | 8.5 oz | 1 | 2026-05-23 | Travel tee: does not wrinkle in a duffel (the Austin conference). |
| T09 | Running tee | Uniqlo | sports-top | grey | [Uniqlo DRY-EX T-Shirt, 08 Dark Gray](https://www.uniqlo.com/us/en/products/E482299-000/00) (verified) | $24.90 | M | 1 | 1 | polyester, nylon | solid | regular | short | — | 1 | 2025-04-05 | Fort Greene Park runs. |
| T10 | Navy long-sleeve tee | Uniqlo | long-sleeve-tee | blue | [Uniqlo Soft Brushed T-Shirt Long Sleeve, 69 Navy](https://www.uniqlo.com/us/en/products/E450179-000/00) (verified) | $29.90 | M | 2 | 2 | cotton | solid | regular | long | — | 1 | 2025-10-18 | Shoulder-season layer under the chore coat. |
| T11 | Breton stripe | Saint James | long-sleeve-tee | white, blue | [Saint James Minquiers Modern, Ecru/Navy](https://us.saint-james.com/products/minquiers-modern-authentic-breton-stripe-shirt-soft-cotton-men-fit-ecru-navy) (verified) | $139 | M | 2 | 2 | cotton | stripes | regular | long | — | 1 | 2025-04-12 | His one pattern; brunch and a September date. |
| T12 | Waffle henley | Uniqlo | long-sleeve-tee | grey | [Uniqlo Waffle Henley Neck T-Shirt Long Sleeve, 08 Dark Gray](https://www.uniqlo.com/us/en/products/E482766-000/00) (verified) | $29.90 | M | 2 | 2 | cotton, polyester | solid | regular | long | — | 1 | 2026-09-12 | Fall refresh: first cool mornings under the chore coat. |
| T13 | White oxford | J.Crew | shirt | white | [J.Crew Broken-in Organic Cotton Oxford Shirt](https://www.jcrew.com/p/mens/categories/clothing/shirts/broken-in-oxford/broken-in-organic-cotton-oxford-shirt/BE996) (search) | $98 | M | 2 | 3 | cotton | solid | regular | long | — | 1 | 2025-03-15 | Promotion burst: the office uniform, and the wedding shirt. |
| T14 | Blue oxford | Uniqlo | shirt | blue | [Uniqlo Oxford Slim Shirt, 64 Blue](https://www.uniqlo.com/us/en/products/E456630-000/00) (verified) | $49.90 | M | 2 | 3 | cotton | solid | slim | long | — | 1 | 2025-03-15 | Second office shirt; with navy chinos. |
| T15 | Western denim shirt | Levi's | shirt | blue | [Levi's Barstow Standard Western Denim Shirt, Medium Wash](https://www.levi.com/US/en_US/sale/mens-sale/barstow-western-denim-shirt/p/857440030) (search) | $69.50 | M | 2 | 2* | denim | solid | regular | long | — | 1 | 2024-11-29 | Over a white tee, open, on fall weekends. Never with jeans. |
| T16 | Plaid flannel | J.Crew | shirt | green, blue | [J.Crew Wallace & Barnes Heavyweight Flannel Shirt, Vista Plaid](https://www.jcrew.com/p/mens/categories/clothing/shirts/classic/wallace-amp-barnes-heavyweight-flannel-shirt-in-vista-plaid/K2519) (verified; plaid colours unconfirmed) | ~$98 | M | 3* | 2* | cotton | check | regular | long | — | 1 | 2025-10-18 | Fall weekends; the only check he owns. |
| T17 | White linen shirt | Uniqlo | shirt | white | [Uniqlo Premium Linen Shirt, White](https://www.uniqlo.com/us/en/products/E455957-000/00) (verified) | $49.90 | M | 1* | 3 | linen | solid | regular | long | — | 1 | 2025-06-14 | July and August office days; summer dates. |
| T18 | Navy sweater-polo | J.Crew | polo | blue | [J.Crew Heritage Cotton Sweater-polo, Darkest Indigo Navy](https://www.jcrew.com/p/mens/categories/clothing/polos/sweater-polos/heritage-cotton-sweater-polo/CF782) (search) | $118 | M | 2 | 3* | cotton, knit | solid | regular | short | — | 1 | 2026-04-18 | Smart without a collar that wilts in humidity; office and dates. |
| T19 | Gym tank | Uniqlo | sports-top | black | [Uniqlo AIRism Anti-Odor Mesh Tank Top, Black](https://www.uniqlo.com/us/en/products/E464310-000/00) (verified) | $14.90 | M | 1 | 1 | nylon | solid | slim | sleeveless | — | 1 | 2025-04-05 | Saturday lifting; heat-wave WFH. |
| T20 | Navy merino crewneck | Uniqlo | sweater | blue | [Uniqlo Merino Sweater (crew), Navy](https://www.uniqlo.com/us/en/products/E450535-000/00) (verified) | $49.90 | M | 3* | 3 | merino | solid | regular | long | — | 1 | 2023-10-21 | The move: first NYC winter. Over an oxford on meeting days. |
| T21 | Grey merino crewneck | Uniqlo | sweater | grey | [Uniqlo Merino Sweater (crew), Gray](https://www.uniqlo.com/us/en/products/E450535-000/00) (same page as T20) | $49.90 | M | 3* | 3 | merino | solid | regular | long | — | 1 | 2023-10-21 | Bought with the navy one; pilling now (a "next buys" item). |
| T22 | Oat cashmere crewneck | Naadam | sweater | beige | [Naadam The Original Cashmere Crewneck, Oat](https://naadam.co/products/the-original-cashmere-crewneck-sweater-mens) (verified) | $98 | M | 4 | 3 | cashmere | solid | regular | long | — | 1 | 2025-10-25 | Winter dates; the softest thing he owns. |
| T23 | Charcoal cardigan | Everlane | cardigan | grey | [Everlane Luxe Merino Crew Cardigan, Heathered Charcoal](https://www.everlane.com/products/mens-luxe-merino-crew-cardigan-heathered-charcoal) (verified) | $168 | M | 3 | 3 | merino | solid | relaxed | long | — | 1 | 2024-11-29 | The office is cold in August: lives on the back of his chair. |
| T24 | Black merino roll-neck | COS | turtleneck | black | [COS The Merino Wool Roll-Neck Jumper](https://www.cos.com/en-us/men/menswear/knitwear/jumpers/merino/product/the-merino-wool-roll-neck-jumper-dark-green-1208558001) (search; black unconfirmed) | ~$99 | M | 3 | 3 | merino | solid | slim | long | — | 1 | 2025-10-25 | Under the leather jacket for fall dates. |
| T25 | Grey hoodie | Reigning Champ | hoodie | grey | [Reigning Champ Midweight Terry Standard Hoodie, Heather Grey](https://reigningchamp.com/products/midweight-terry-standard-hoodie-heather-grey) (verified) | $128 | M | 3 | 1 | cotton | solid | regular | long | 11.5 oz | 1 | 2024-11-29 | WFH uniform. 390 gsm: just under the 400 gsm step, so warmth 3. |
| T26 | Black zip hoodie | Uniqlo | hoodie | black | [Uniqlo Sweat Full-Zip Hoodie, Black](https://www.uniqlo.com/us/en/products/E486119-000/00) (verified) | $49.90 | M | 3 | 1 | cotton | solid | regular | long | — | 1 | 2023-10-21 | Over a gym tank; late-summer evenings. |
| T27 | Navy crewneck sweatshirt | Champion | sweatshirt | blue | [Champion Reverse Weave 12 oz Crew, Navy](https://www.amazon.com/Champion-Reverse-Weave-Crew-Medium/dp/B014WBH7TE) (search) | ~$55 | M | 4 | 1 | cotton, polyester | solid | relaxed | long | 12 oz | 1 | 2024-11-29 | Heavy fleece for cold Sundays. |

### Bottoms

| id | Name in the app | Brand | Type | Colours | Product | Price | Size | Warmth | Form. | Materials | Pattern | Fit | Length | Weight | Acquired | Why he owns it |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B01 | Raw selvedge jeans | The Unbranded Brand | jeans | blue | [The Unbranded Brand UB201 Tapered, 14.5 oz Indigo Selvedge](https://theunbrandedbrand.com/products/ub201-tapered-fit-indigo-selvedge) (verified) | $112 | 32x32 | 4 | 2 | denim | solid | slim | full | **14.5 oz** | 2026-05-02 | Breaking them in: worn hard, **never washed yet** (laundry skips them). Too warm for July. |
| B02 | 501s | Levi's | jeans | blue | [Levi's 501 Original Fit, Medium Stonewash](https://www.levi.com/US/en_US/clothing/men/jeans/straight/501-original-mens-jeans/p/005010193) (search) | $79.50 | 32x32 | 3 | 2 | denim | solid | regular | full | 12.5 oz | 2026-01-17 | Replaced the worn-through 511s (Z03); everything jeans. |
| B03 | Black jeans | Levi's | jeans | black | [Levi's 511 Slim Fit, Black](https://www.levi.com/US/en_US/clothing/men/jeans/slim/511-slim-fit-mens-jeans/p/045114406) (search) | $69.50 | 32x32 | 3 | 2 | denim | solid | slim | full | — | 2024-11-29 | Nights out, with the leather jacket. |
| B04 | Khaki chinos | J.Crew | chinos | beige | [J.Crew 770 Straight-fit Stretch Chino, Khaki](https://www.jcrew.com/p/mens/categories/clothing/pants-and-chinos/chino/770trade-straight-fit-stretch-chino-pant/AR886) (verified) | $98 | 32x32 | 2 | 3 | cotton | solid | regular | full | — | 2025-03-15 | The office uniform's bottom half. |
| B05 | Navy chinos | Uniqlo | chinos | blue | [Uniqlo Slim Chino Pants, Navy](https://www.uniqlo.com/us/en/products/E450251-000/00) (verified) | $29.90 | 32x32 | 2 | 3 | cotton | solid | slim | full | — | 2025-03-15 | Second office pair; with the blue oxford or the linen shirt. |
| B06 | Olive chinos | J.Crew | chinos | green | [J.Crew 484 Slim-fit Stretch Chino, Catskill Green](https://www.jcrew.com/p/mens/categories/clothing/pants-and-chinos/chino/484-slim-fit-stretch-chino-pant/AR885) (verified) | $98 | 32x32 | 2 | 3 | cotton | solid | slim | full | — | 2025-06-14 | The accent bottom: black or charcoal tees, travel. |
| B07 | Grey flannel trousers | Suitsupply | trousers | grey | [Suitsupply Straight Leg Pants, Mid Grey S120's wool flannel](https://suitsupply.com/en-us/men/trousers/mid-grey-straight-leg-pants/B6906.html) (verified) | $199 | 32 | 3* | 4* | wool | solid | regular | full | — | 2025-03-15 | Meeting days with the blazer; the wedding. |
| B08 | Black smart pants | Uniqlo | trousers | black | [Uniqlo Smart Pants, Black](https://www.uniqlo.com/us/en/products/E491784-000/00) (verified) | $59.90 | 32 | 2 | 3 | polyester, synthetic | solid | slim | full | — | 2023-10-21 | Came with him from Minneapolis; now the rainy-office trouser. |
| B09 | Black joggers | lululemon | joggers | black | [lululemon ABC Jogger, Black](https://shop.lululemon.com/p/men-joggers/Abc-Jogger/_/prod8530240) (search) | $128 | M | 2* | 2* | polyester | solid | slim | full | — | 2024-11-29 | WFH that can survive a Zoom and a bodega run. |
| B10 | Grey sweatpants | Reigning Champ | sweatpants | grey | [Reigning Champ Midweight Terry Standard Sweatpant, Heather Grey](https://reigningchamp.com/products/midweight-terry-standard-sweatpant-heather-grey) (verified) | $118 | M | 3 | 1 | cotton | solid | regular | full | — | 2024-11-29 | Sundays. Matches the hoodie, on purpose. |
| B11 | Khaki shorts | J.Crew | shorts | beige | [J.Crew 7" Harbor Stretch Chino Short, Khaki](https://www.jcrew.com/p/mens/categories/clothing/shorts/stretch-chino/7quot-harbor-stretch-chino-short/CV235) (verified) | $79.50 | 32 | 1 | 2 | cotton | solid | regular | short | — | 2025-06-14 | Summer weekends. |
| B12 | Navy shorts | J.Crew | shorts | blue | [J.Crew 7" Harbor Stretch Chino Short, Navy](https://www.jcrew.com/p/mens/categories/clothing/shorts/stretch-chino/7quot-harbor-stretch-chino-short/CV235) (same page as B11) | $79.50 | 32 | 1 | 2 | cotton | solid | regular | short | — | 2025-06-14 | Summer weekends, with the olive tee. |
| B13 | Running shorts | lululemon | running-shorts | black | [lululemon Pace Breaker Lined Short 7", Black](https://shop.lululemon.com/p/men-shorts/Pace-Breaker-Short-NF-7-Lined-Update/_/prod11400110) (search) | $78 | M | 1 | 1 | polyester | solid | regular | short | — | 2025-04-05 | Runs and the gym. |
| B14 | Swim trunks | J.Crew | swimwear | blue | [J.Crew 6" Stretch Swim Trunk with ECONYL, Navy](https://www.jcrew.com/p/mens/categories/clothing/swim/6-inch-swim-trunk/6-stretch-swim-trunk-with-econylreg-nylon/CG551) (verified) | $89.50 | M | 1 | 1 | nylon | solid | regular | short | — | 2025-06-14 | Rockaway, twice a summer. |

### Outerwear

| id | Name in the app | Brand | Type | Colours | Product | Price | Size | Warmth | Form. | Materials | Fit | Weight | WR | Acquired | Why he owns it |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| O01 | Denim jacket | Levi's | denim-jacket | blue | [Levi's Trucker Jacket, Medium Wash](https://www.levi.com/US/en_US/clothing/men/outerwear/trucker-jacket/p/723340457) (search) | $89.50 | M | 3 | 2 | denim | regular | 14 oz | no | 2024-04-06 | Spring and fall weekends, over any tee. |
| O02 | Leather jacket | AllSaints | leather-jacket | black | [AllSaints Milo Leather Biker Jacket, Black](https://www.allsaints.com/us/men/sale/milo-asymmetric-zip-leather-biker-jacket/US0889059716243.html) (search) | $400 (on sale; $649 list) | M | 3 | 3 | leather | slim | — | no | 2025-10-25 | The splurge. Date nights from October to April. |
| O03 | Navy blazer | Suitsupply | blazer | blue | [Suitsupply Navy Tailored Fit Havana Blazer](https://suitsupply.com/en-us/men/jackets/navy-tailored-fit-havana-blazer/C25216.html) (verified) | $399 | 40R | 2 | 4 | wool | slim | — | no | 2025-03-15 | Promotion burst. Meeting Wednesdays over a tee or oxford; the wedding. |
| O04 | Brown wool coat | Uniqlo | coat | brown | [Uniqlo Wool Cashmere Chesterfield Coat, Brown](https://www.uniqlo.com/us/en/products/E470082-000/00) (verified) | $199.90 | M | 4 | 4 | wool, cashmere | regular | — | no | 2025-10-25 | Office winters over merino; dinners. |
| O05 | Winter parka | Patagonia | parka | black | [Patagonia Jackson Glacier Waterproof Down Parka, Black](https://www.patagonia.com/product/mens-jackson-glacier-waterproof-down-parka/27911.html) (search) | $599 | M | 5 | 2 | polyester, down | regular | — | yes | 2023-10-21 | The move. January on the Q platform. |
| O06 | Down Sweater | Patagonia | puffer | black | [Patagonia Down Sweater, Black](https://www.patagonia.com/product/mens-down-sweater-insulated-jacket/84675.html) (search) | $279 | M | 4* | 2 | nylon, down | regular | — | no | 2024-11-29 | November and March; packs into its pocket. |
| O07 | Trench coat | Uniqlo | trench | beige | [Uniqlo U Single-Breasted Trench Coat, Beige](https://www.uniqlo.com/us/en/products/E437143-000/00) (verified) | $149.90 | M | 3 | 3* | cotton, nylon | relaxed | — | yes | 2024-04-06 | Rainy office days in spring and fall. |
| O08 | Rain shell | Patagonia | rain-jacket | black | [Patagonia Torrentshell 3L, Black](https://www.patagonia.com/product/mens-torrentshell-3l-rain-jacket/85241.html) (verified) | $179 | M | 2 | 2 | nylon | regular | 3.5 oz | yes | 2024-04-06 | Summer thunderstorms; runs in the rain. |
| O09 | Grey Better Sweater | Patagonia | fleece | grey | [Patagonia Better Sweater 1/4-Zip, Seabird Grey](https://www.patagonia.com/product/mens-better-sweater-quarter-zip-fleece-pullover/25523.html) (verified) | $139 | M | 3 | 2* | fleece | regular | — | no | 2024-11-29 | He knows. Office AC and chilly WFH mornings. |
| O10 | Navy down vest | Uniqlo | vest | blue | [Uniqlo Ultra Light Down Vest, Navy](https://www.uniqlo.com/us/en/products/E472294-000/00) (verified) | $59.90 | M | 2* | 2 | nylon, down | regular | — | no | 2023-10-21 | A layer under the parka or over a merino. |
| O11 | Olive chore coat | Carhartt WIP | jacket | green | [Carhartt WIP Michigan Coat, Leaf Green](https://us.carhartt-wip.com/en-us/collections/men-jackets-michigan-chore-coat) (search; collection page) | $245 | M | 3 | 2 | cotton | regular | 12 oz | no | 2026-09-12 | Fall refresh; worn almost daily from the first cool morning. |

### Footwear

| id | Name in the app | Brand | Type | Colours | Product | Price | Size | Warmth | Form. | Materials | WR | Acquired | Why he owns it |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F01 | White sneakers | Veja | sneakers | white | [Veja Campo ChromeFree Leather, White Natural](https://www.veja-store.com/en_us/p/campo-leather-white-natural-CP0502429.html) (verified) | $175 | 10 | 2 | 2 | leather, suede | no | 2025-04-12 | Everything casual, and Thursday office. |
| F02 | Grey wool runners | Allbirds | sneakers | grey | [Allbirds Men's Wool Runner, Natural Grey](https://www.allbirds.com/products/mens-wool-runners) (verified) | $110 | 10 | 2 | 2 | wool | no | 2024-11-29 | Travel days and errands. |
| F03 | Black canvas low-tops | Converse | sneakers | black | [Converse Chuck 70 Canvas Low Top, Black](https://www.converse.com/shop/p/chuck-70-canvas-unisex-low-top-shoe/162062MP.html) (search) | $90 | 10 | 2 | 1* | cotton | no | 2024-06-01 | Bars and shows; black on black. |
| F04 | Running shoes | Hoka | running-shoes | black | [Hoka Clifton 11, Black](https://www.hoka.com/en/us/mens-everyday-running-gear/clifton-11/1176572.html) (search) | $154.95 | 10 | 2 | 1 | synthetic | no | 2026-04-04 | Replaced the Pegasus (Z02). |
| F05 | Suede Chelsea boots | Thursday Boot Co. | boots | brown | [Thursday Boot Co. Duke Chelsea, Chocolate Suede](https://thursdayboots.com/products/mens-duke-chelsea-boot-chocolate-suede) (verified) | $199 | 10 | 3* | 3 | suede | no | 2025-03-15 | Date nights and meeting days, fall to spring. |
| F06 | Iron Rangers | Red Wing | boots | brown | [Red Wing Heritage Iron Ranger 8111, Amber Harness](https://www.redwingshoes.com/heritage/mens/iron-ranger/Iron-Ranger-08111.html) (verified) | $349.99 | 9 | 4 | 2* | leather | no | 2026-09-12 | Fall refresh investment; with the raw denim. (Sized down half, as Red Wing advises.) |
| F07 | Bean Boots | L.L.Bean | boots | brown | [L.L.Bean Bean Boots 8", Tan/Brown](https://www.llbean.com/llb/shop/129628) (verified) | $150 | 9 | 4 | 2* | leather, other | yes | 2023-10-21 | The move. Snow and slush only. |
| F08 | Penny loafers | G.H. Bass | loafers | brown | [G.H. Bass Larson Weejuns Penny Loafer, Melon](https://www.ghbass.com/products/men-larson-weejuns-penny-loafer-wine) (verified; Melon is the tan-brown colourway on the same page) | $195 | 9.5 | 2 | 3 | leather | no | 2025-03-15 | Office summers without socks; dates. |
| F09 | Dress shoes | Allen Edmonds | dress-shoes | brown | [Allen Edmonds Park Avenue Cap-Toe Oxford, Walnut](https://www.allenedmonds.com/product/mens-park-avenue-cap-toe-oxford-dress-shoe-3023014) (search) | ~$450 | 10 | 2 | 4 | leather | no | 2026-08-15 | Bought for the wedding; worn twice a year. |
| F10 | Birkenstocks | Birkenstock | sandals | beige | [Birkenstock Arizona Suede, Taupe](https://www.birkenstock.com/us/arizona-suede-leather-taupe/arizona-core-suedeleather-0-eva-u_46.html) (verified) | $139.95 | 43 | 1 | 2 | suede | no | 2025-06-14 | Summer weekends and the greenmarket. |
| F11 | Slides | adidas | slides | black, white | [adidas Adilette Aqua Slides, Core Black / Cloud White](https://www.adidas.com/us/adilette-aqua-slides/F35543.html) (search) | $30 | 10 | 1 | 1 | synthetic | no | 2024-06-01 | WFH, the gym shower, the beach. |

### Accessories

| id | Name in the app | Brand | Type | Colours | Product | Price | Size | Warmth | Form. | Materials | Pattern | WR | Qty | Acquired | Why he owns it |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A01 | Navy cap | J.Crew | cap | blue | [J.Crew Garment-dyed Baseball Cap, Navy](https://www.jcrew.com/p/mens_category/scarveshatsgloves/hats/jcrew-always-baseball-cap-in-garmentdyed-cotton/L2241?color_name=navy) (search) | ~$50 | One Size | 1* | 1 | cotton | solid | no | 1 | 2025-06-14 | Runs and bad-hair Saturdays. |
| A02 | Navy beanie | Carhartt | beanie | blue | [Carhartt Knit Cuffed Beanie (A18), Navy](https://www.carhartt.com/product/A18/iconic-a18-watch-cap-beanie) (search) | $19.99 | One Size | 4 | 1 | knit, synthetic | solid | no | 1 | 2023-10-21 | The move. |
| A03 | Grey cashmere scarf | Uniqlo | scarf | grey | [Uniqlo Cashmere Scarf, 03 Gray](https://www.uniqlo.com/us/en/products/E486760-000/00) (verified) | $69.90 | One Size | 4 | 3 | cashmere | solid | no | 1 | 2025-10-25 | With the coat. |
| A04 | Leather gloves | J.Crew | gloves | black | [J.Crew Leather Gloves with Wool-Cashmere Lining](https://www.jcrew.com/p/mens/categories/accessories/more-accessories/hats-scarves-and-gloves/gloves/leather-gloves-with-wool-cashmere-lining/H2738) (search) | ~$98 | M | 4 | 3 | leather, cashmere | solid | no | 1 | 2023-10-21 | The move. Touchscreen tips for the subway. |
| A05 | Brown belt | J.Crew | belt | brown | [J.Crew Italian Leather Dress Belt, Brown](https://www.jcrew.com/p/mens/categories/accessories/belts/italian-leather-dress-belt/E3145) (search) | $79.50 | 34 | 1* | 3 | leather | solid | no | 1 | 2025-03-15 | With the loafers and Chelseas. |
| A06 | Black belt | Uniqlo | belt | black | [Uniqlo Italian Leather Stitched Belt, Black](https://www.uniqlo.com/us/en/products/E463729-000/00) (verified) | $29.90 | 34 | 1* | 3 | leather | solid | no | 1 | 2023-10-21 | With black jeans and the smart pants. |
| A07 | Wayfarers | Ray-Ban | sunglasses | black | [Ray-Ban Original Wayfarer Classic RB2140, Black / G-15](https://www.ray-ban.com/usa/sunglasses/RB2140original%20wayfarer%20classic-black/805289126577) (search) | ~$191 | 50-22 | 1* | 2 | other | solid | no | 1 | 2025-06-14 | Every sunny day from May to September. |
| A08 | Timex Marlin | Timex | watch | silver, black | [Timex Marlin Hand-Wound 34mm, TW2R47900](https://timex.com/products/marlin-hand-wound-34mm-leather-strap-watch-tw2r47900) (verified) | $259 | 34 mm | 1* | 3 | leather, other | solid | no | 1 | 2025-03-22 | The promotion present to himself. |
| A09 | Silver chain | Mejuri | jewelry | silver | [Mejuri Cable Chain Necklace, Sterling Silver](https://mejuri.com/products/cable-chain-necklace?Material=Sterling+Silver) (verified) | $98 | 20" | 1* | 2* | other | solid | no | 1 | 2025-12-25 | A gift; with open collars on dates. |
| A10 | Navy knit tie | The Tie Bar | tie | blue | [The Tie Bar Silk Knit Navy Tie](https://www.thetiebar.com/product/tie-6178-0251) (verified) | $28 | One Size | 1* | 4 | silk, knit | solid | no | 1 | 2026-08-15 | Bought for the wedding; his only tie. |
| A11 | Black socks | Bombas | socks | black | [Bombas Men's Calf Sock 6-Pack](https://bombas.com/products/mens-calf-sock-6-pack) (unverified URL) | ~$17.50 | L | 2 | 1 | cotton | solid | no | **6** | 2026-01-10 | Multiples; one of the few things he restocks every year. |
| A12 | Bucket hat | J.Crew | hat | beige | [J.Crew Garment-dyed Ripstop Bucket Hat](https://www.jcrew.com/p/mens/categories/accessories/scarves-hats-and-gloves/hats/garment-dyed-ripstop-bucket-hat/BE675) (search; beige unconfirmed) | ~$50 | L/XL | 1* | 1 | cotton | solid | no | 1 | 2025-06-14 | Rockaway and the greenmarket. |

The socks (A11) are typed `socks` (#685), which no outfit idea draws, so the closet reads as fully tagged
and the demo shows no "needs details" prompt. Warmth on the accessories that do not warm anyone (belts,
sunglasses, the watch) is set by hand to 1.

### Bags and other

| id | Name in the app | Brand | Category / type | Colours | Product | Price | Warmth | Form. | Materials | Pattern | WR | Acquired | Why he owns it |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| G01 | Backpack | Aer | bags / backpack | black | [Aer Day Pack 3, Black](https://aersf.com/products/day-pack-3) (verified) | $159 | — | 2 | nylon | solid | yes | 2024-04-06 | Every office day (bought as Day Pack 2; this is its successor). |
| G02 | Canvas tote | L.L.Bean | bags / tote | beige, blue | [L.L.Bean Boat and Tote, Medium, Blue trim](https://www.llbean.com/llb/shop/33381?page=boat-and-tote-bag-open-top) (verified) | $49.95 | — | 1* | cotton | solid | no | 2023-10-21 | Greenmarket, the beach, the laundry run. |
| G03 | Sling | Bellroy | bags / crossbody | black | [Bellroy Venture Sling 6L, Black](https://bellroy.com/products/venture-sling-6l) (search) | $139 | — | 2 | nylon | solid | no | 2025-06-14 | Weekends and travel days. |
| G04 | Duffel | Patagonia | bags / duffel | black | [Patagonia Black Hole Duffel 55L](https://www.patagonia.com/shop/gear/bags/black-hole) (search; category page) | $179 | — | 1 | polyester | solid | yes | 2024-04-06 | Conference trips and weddings upstate. |
| X01 | Umbrella | Repel | other | black | [Repel Windproof Travel Umbrella, Black](https://www.repelumbrella.com/products/repel-easy-touch-umbrella-black) (verified) | $39.99 | 1* | 1* | other | solid | — | 2023-10-21 | Exercises a garment the generator never uses. |

The umbrella (X01) is `other`: role none, never generated into an outfit.

### Archived

| id | Name in the app | Brand | Category / type | Colours | Product | Size | Warmth | Form. | Materials | Pattern | Fit | Sleeve | Length | Weight | Acquired | Archived | Why he owns it |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Z01 | Old grey tee | Hanes | tops / t-shirt | grey | Hanes ComfortSoft crew (no URL) | M | 2 | 1* | cotton | solid | regular | short | — | 5 oz | 2021-08-14 | 2026-05-09 | Collar gone; replaced in the tee reset. |
| Z02 | Pegasus 39 | Nike | footwear / running-shoes | grey | Nike Air Zoom Pegasus 39 (discontinued) | 10 | 2 | 1 | synthetic | — | — | — | — | — | 2022-08-20 | 2026-04-04 | 600 miles; replaced by the Cliftons. |
| Z03 | Old 511s | Levi's | bottoms / jeans | blue | Levi's 511 Slim, indigo (no URL) | 32x32 | 3 | 2 | denim | solid | slim | — | full | — | 2022-03-05 | 2026-01-17 | Worn through; replaced by the 501s and, later, the raw denim. |

Archived garments stay in their outfits (AGENTS.md Outfits) but are never worn after their archive date.
Z03 is in one outfit saved in 2025 ("Old weekend jeans"), which is how the edit form's "archived
garment in a slot" marking shows up in the demo.

### Coverage

- Categories: tops, bottoms, outerwear, footwear, accessories, bags, other. **Not dresses**: Dana's
  dress covers them (sparse.md; owner, 2026-09-26).
- Types: 48 of 56. Tops 10/11 (no `blouse`), bottoms 6/8 (no `skirt`, `leggings`), outerwear 11/11,
  footwear 7/8 (no `heels`), accessories 10/10, bags 4/5 (no `handbag`), dresses 0/3.
- Property values never used by demo: fit `oversized`; patterns `print`, `graphic`, `floral`, `other`;
  sleeve `three-quarter`; lengths `knee`, `midi` (Dana's wrap dress has `midi`). Everything else,
  warmth 1-5 and formality 1-4 included, appears at least once.

## Saved outfits

Named as he would name them; slots are written in builder order (outerwear, tops, bottoms, footwear,
accessories, bags). `*` after a name = favourite (drawn three times as often). Occasions: `office`,
`meeting`, `rain`, `weekend`, `wfh`, `workout`, `date`, `night-out`, `formal`, `travel`, `beach`; `—`
is never drawn. Bands are the day's feels-like high (see Simulation); `any` is every band.

| # | Name | Occasion | Bands | Garments |
|---|---|---|---|---|
| 1 | Office uniform * | office | warm, mild | T13 white oxford, B04 khaki chinos, F08 loafers, A05 brown belt, A08 watch, G01 backpack |
| 2 | Blue oxford, navy chinos | office | warm, mild, cool | T14, B05, F01, A08, G01 |
| 3 | Meeting day: blazer and tee | meeting | mild, cool | O03 blazer, T01 white tee, B07 grey flannel, F08 loafers, A05, A08, G01 |
| 4 | Meeting day: blazer and oxford | meeting | cool, cold | O03, T13, B07, F05 Chelseas, A05, A08, G01 |
| 5 | Sweater-polo office * | office | hot, warm | T18 sweater-polo, B04, F01, A08, G01 |
| 6 | Linen office | office | hot | T17 linen, B05 navy chinos, F08, A07 Wayfarers, G01 |
| 7 | Merino office | office | cool, cold | T20 navy merino, B04, F05, A05, G01 |
| 8 | Thursday chore coat | office | cool | O11 chore coat, T12 waffle henley, B02 501s, F01, G01 |
| 9 | Rainy office | office, rain | warm, mild | O08 rain shell, T14, B08 smart pants, F02 wool runners, G01 |
| 10 | White tee and raw denim * | weekend | mild, cool | T01, B01 raw jeans, F01, A07 |
| 11 | Heavyweight and 501s | weekend | warm, mild | T06 white heavyweight, B02, F02, G02 tote |
| 12 | Summer shorts | weekend | hot, warm | T04 navy tee, B11 khaki shorts, F10 Birkenstocks, A01 cap, A07 |
| 13 | Olive and navy | weekend | hot, warm | T05 olive tee, B12 navy shorts, F01, A07, G03 sling |
| 14 | Sunday brunch | weekend | mild, cool | T11 Breton, B02, F01, A07 |
| 15 | WFH lounge * | wfh | mild, cool | T25 grey hoodie, B10 sweatpants, F11 slides |
| 16 | WFH summer * | wfh | hot, warm | T03 grey tee, B09 joggers, F11 |
| 17 | Run | workout | hot, warm, mild, cool, cold | T09 running tee, B13 running shorts, F04 Hokas, A01 |
| 18 | Gym | workout | any | T19 tank, T26 zip hoodie, B13, F04 |
| 19 | Summer date | date | hot, warm | T17 linen, B06 olive chinos, F08, A09 chain, A07 |
| 20 | Rooftop drinks | night-out | hot, warm | T07 black heavyweight, B06, F01, A08 |
| 21 | Date night: leather * | date | cool, cold | O02 leather jacket, T24 roll-neck, B03 black jeans, F05, A08 |
| 22 | Black on black | night-out | warm, mild | T02 black tee, B03, F03 Chucks, A06 black belt |
| 23 | Wedding | formal | any | O03, T13, A10 tie, B07, F09 dress shoes, A05, A08 |
| 24 | Conference travel | travel | hot, warm | T08 charcoal heavyweight, B06, F02, G04 duffel, G03 |
| 25 | Rockaway | beach | hot | T05, B14 swim trunks, F11, A12 bucket hat, A07, G02 |
| 26 | Old weekend jeans | — | — | T15 western shirt, Z03 old 511s (archived), F03 |

"Old weekend jeans" was saved in 2025 and is never worn in the window. The workouts (17, 18) are never
drawn: they are the week's `Workout` column, a morning entry before the day's outfit.

## Capsules

Named subsets of the closet (#8), each for a part of his life; the closet itself is every garment
he has not archived and is never a row. A garment can be in several (the white tee is in three).
Written through the app's own writers (`createCapsule`, then `changeMembership`), in this order.
`Garments` are ids.

| Capsule | Garments | Notes |
|---|---|---|
| Office | T01, T12, T13, T14, T17, T18, T20, T21, T23, B02, B04, B05, B07, B08, O03, O04, O07, O08, O09, O11, F01, F02, F05, F08, A03, A04, A05, A08, G01 | Tuesday to Thursday at Flatiron: smart casual, the blazer on meeting Wednesdays, jeans only on Thursdays. |
| Weekend | T01, T04, T05, T06, T11, T15, T16, B01, B02, B11, B12, O01, O11, F01, F02, F06, F10, A01, A07, A12, G02, G03, Z03 | Fort Greene Park, the greenmarket, brunch, errands on foot. |
| Date night | T02, T07, T11, T17, T18, T22, T24, B03, B06, B07, O02, O04, F03, F05, F08, A06, A08, A09 | Friday or Saturday: the sharper version of every day. |
| Travel | T01, T08, T09, T13, T18, B02, B06, B13, O08, F02, F04, F11, A07, A11, G03, G04 | The Austin conference duffel: three days, one bag, nothing that wrinkles. |

Weekend still holds the old 511s (Z03), put in before they were archived: a capsule's pages leave an
archived garment out but keep its membership, so the demo shows the rule (22 of 23 shown).

## Laundry

What makes a garment dirty, and so unavailable until Sunday's wash. The app's defaults decide most of
it (#7, `src/wardrobe/availability.ts`: tops and dresses after 1 wear, bottoms after 3, outerwear after
10, footwear, accessories and bags never); this table is where Theo differs, written as each garment's
"Wash after" through the garment form. `Garments` is a role, `type: <types>`, or a garment id; an id
beats a type, a type beats a role. Wears are counted by day, and multiples count copies: three white
tees are three wears.

| Garments | Wears before a wash |
|---|---|
| type: sweater, cardigan, turtleneck, hoodie, sweatshirt | 2 |
| B01 | never |
| A11 | 1 |

B01 is the raw denim: never washed in the window, on purpose. A11 is the socks: an accessory, which the
app never launders by default, but socks go in the wash after every wear.

## Condition

What is wearing out (#7). Still in the closet and still worn: condition never makes a garment
unavailable. Written through the garment form's Condition. Values are the app's (`good`, `needs_repair`,
`replace_soon`); unlisted is `good`.

| Garment | Condition | Note |
|---|---|---|
| T21 | replace_soon | Pilling at the elbows; a new one is on the wishlist |
| B02 | needs_repair | Back belt loop tore off; the tailor on DeKalb Av |

## Away

Out of the closet at the anchor (#7): lent to someone or at a repair shop, so the outfit generator skips
them. Written by the garment page's "Where it is" (`setAway`). Neither is in an outfit he plans to wear.

| Garment | Away | Note |
|---|---|---|
| G04 | lent | Dana has it for her October wedding weekend |
| F07 | repair | Sent back to L.L.Bean for a resole before winter |

## Care labels

What the label inside says (#23), where it differs from what the materials suggest. Every other garment
with a label (not shoes or bags) carries its materials' usual care, as the garment form's material chips
fill it in (`carePresetsFor`, `src/wardrobe/care.ts`); `—` keeps that suggestion. Values are the app's
(`CARE_WASH`, `CARE_BLEACH`, `CARE_DRY`, `CARE_IRON`, `CARE_DRY_CLEAN`). Dry cleaning is never suggested:
only these rows say it.

| Garment | Wash | Bleach | Dry | Iron | Dry cleaning |
|---|---|---|---|---|---|
| O03 | do_not_wash | — | — | — | only |
| O04 | do_not_wash | — | — | — | only |
| B07 | do_not_wash | — | — | — | only |
| T22 | — | — | — | — | allowed |
| O05 | — | — | — | — | never |

## Repairs

What has been mended or altered (#23): the garment page's log, the owner's own record. Dated as the
bible's acquisitions are (they move with the anchor), never before the garment was bought; costs are
what he paid, shown beside the log and counted in cost per wear (#151). B02's torn belt loop (Condition) and
F07's resole (Away) are not done yet, so not here.

| Garment | Day | Kind | What was done | Cost |
|---|---|---|---|---|
| O03 | 2025-03-22 | alteration | Sleeves shortened 1 cm, the tailor on DeKalb Av | $25 |
| B07 | 2025-03-22 | alteration | Hemmed to a no-break length | $20 |
| B01 | 2026-05-09 | alteration | Chain-stitch hem, 5 cm off, keeping the selvedge | $15 |
| F07 | 2025-02-08 | repair | New laces and the heel re-glued | $12 |
| T13 | 2025-11-08 | repair | Collar button sewn back on | — |

## Clashes

Pairs Theo told the outfit gallery never to put together (#9: "Not this", then the two that clash),
stored through `avoidPair` as `generator_avoid` rows, so the generator never draws them in one idea
again; each garment's page lists its pair with "Allow again". Neither pair is in a saved outfit (the
seed refuses one that is).

| Garment | Never with | Why |
|---|---|---|
| B06 | O11 | Olive chinos under the olive chore coat: one olive too many |
| T15 | O01 | The western denim shirt under the denim jacket: a Canadian tuxedo |

## Simulation (how the history is generated)

The seed does not store a hand-written calendar: it **simulates** Theo's days (`src/seed/simulate.ts`)
from the tables above. Deterministic: every random draw comes from a stream keyed by persona,
subsystem and day (`src/seed/random.ts`), so the same anchor gives the same history, and a new
subsystem never reshuffles an old one's draws.

**Window**: the reference anchor is **Saturday 2026-09-26**. The history is the 91 days ending on the
anchor (the seed's `--anchor`, default today in `APP_TIMEZONE`), then a planned week after it. Seeded on
another date, the reference dates (acquisitions, archives, events) shift by whole weeks so weekdays
keep their meaning, and the weather follows the real dates of the window.

**Weather** (`src/seed/weather.ts`; pure, no network; the app's real forecasts are #14's, from Open-Meteo,
for his weather home; the tests' stand-in for Open-Meteo serves these same simulated days, hour by hour, so
the planned week's weather on the calendar is the weather it was drawn for):
- Daily normal high for Central Park by day of year (1991-2020 normals, linearly interpolated between
  month mid-points): Jan 39, Feb 42, Mar 50, Apr 62, May 72, Jun 80, Jul 84, Aug 83, Sep 76, Oct 64,
  Nov 54, Dec 44 °F.
- Noise: an AR(1) anomaly (persistence 0.6, sd 5 °F), so warm and cool spells last a few days, plus the
  Events' shifts. Humidity adds up to 6 °F of feels-like above 80 °F.
- Rain: a probability by month (Jul 0.30, Aug 0.28, Sep 0.25; NOAA's days with 0.1 in or more).
- Bands on the feels-like high: **hot** 85 and up, **warm** 75-84, **mild** 65-74, **cool** 52-64,
  **cold** 38-51, **freezing** under 38. As the app's weather matching (`src/weather/match.ts`) reads the
  same days, each band asks for a torso warmth (top plus layer) in a range: hot 1-2, warm 1-4, mild 3-5,
  cool 4-7, cold 6-9, freezing 8-9, rising band by band (`weather.spec.ts`).
- Each day as a forecast: the feels-like runs from its low at 6:00 to its high at 15:00 (a 12 to 18 °F
  swing), and a rainy day's rain is a spell of 3 to 8 hours starting between 6:00 and 18:00.

**Each day**:
1. The Event's outfit, if the day has one. Otherwise the week's `Draws from`; a meeting Wednesday
   (every other Wednesday, the reference 2026-07-01 first) draws `meeting` instead of `office`.
2. Candidates: saved outfits with one of those occasions whose bands include the day's; minus any with
   a garment not yet acquired, archived by then, or dirty (Laundry). With none left, the neighbouring
   band is tried, then dirty garments are allowed (he wears it again).
3. Draw with weights: 1, favourites 3; × 0.2 if worn yesterday, × 0.5 if worn in the three days before;
   × 4 for a `rain` outfit on a rainy day.
4. **Evenings**: a `date` outfit in three weeks out of four (probability 0.75), on Friday (60 %) or
   Saturday; a `night-out` every third week on Thursday or Saturday. The evening is a second calendar
   entry that day, planned for the `evening` (a date) or the `night-out`.
5. **Workouts**: the week's `Workout` outfit in the morning (the Monday and Thursday runs, the Saturday
   gym), a calendar entry for the `workout` before the day's own; skipped one time in five, when the
   day's band is not one of the outfit's (no run in freezing weather), and on Event days. The day's
   outfit is planned for its week row's `Calendar` occasion (an Event's outfit the weekday does not draw
   from, the wedding or the beach, is `all-day`). A day of a run, the office and a night out is three
   entries; a garment in two of a day's entries is one wear.
6. **Logging**: Theo records a past day on 85 % of days; a recorded past entry is worn (that evening,
   21:00). On 4 % of office days the planned outfit stayed unworn (rain changed his mind) and the one he
   wore is a second, worn entry. Before a date or a night out he takes a mirror selfie: every worn
   `evening` and `night-out` entry of the last 28 days has one (#19; a drawing of the outfit's garments
   on him in the hall mirror, `src/seed/selfie-art.ts`), stored through the selfie's own writer, which
   marks the entry worn.
7. **Planned week**: the seven days after the anchor, planned and not worn. He plans by hand only
   what comes some weeks (a date night, a night out, drawn by the same rules) and an Event's outfit;
   the rest, his week template's slots (the day's outfit, the workouts), is **"Plan my week"** (#16):
   the app's own planner over his closet as the anchor leaves it (the week's wears still in the
   hamper), with the forecast the tests' Open-Meteo stand-in serves for those days, each entry
   marked Auto. The rules still draw every day's outfit, so the evenings are the ones they always
   were.
   **The anchor is today, half lived** (Today, #15): the morning's workout is done and worn (by the
   end of its window, 9:00), the evening planned and not worn yet, and the day's own outfit not
   chosen, so Today suggests one; an Event's outfit is decided already and planned. At the reference
   anchor that is Saturday's date night, "Summer date", with three ideas for the day. The day's
   outfit is still drawn, unrecorded, so the planned week is the one it always was.
8. **Laundry Sundays** wash everything worn since the last wash that ever gets washed (the rules in
   Laundry): each garment's `last_washed_on` is its last Sunday up to the anchor. A day's wears are
   counted once, however many outfits that day used the garment, as the app counts them. The anchor is a
   Saturday, so the week's wears are still in the hamper: the demo's laundry page is Saturday afternoon's.
9. **Wears**: every worn entry is marked through the app's own `setEntryWorn`, so each garment's wear
   log is the outfits' garments on those days.

**Seasonal drift**: the rules choose by band, not by month. At the reference anchor the window is a
warm summer: shorts, linen, the sweater-polo and slides; the raw denim (bands `mild`, `cool`) mostly sits
out, and the chore coat arrives for the first cool Thursday. The winter pieces (parka, Bean Boots, coat,
gloves, scarf, beanie, cashmere, Down Sweater) and the garments no saved outfit uses are never worn in
the window, which is what an "unworn in 90 days" insight (#17) should flag. Seeded in January, the same
rules reach for the merino office outfit, the leather jacket and the hoodie.

**What later features add** (plan section 10): wears and washes (#7, done: quantities 3 and 6, the
worn entries as wears, laundry Sundays as washes, the Condition and Away tables), occasions on each entry (#13, done: work days, evenings and nights out, the morning workouts), weather (#14, done: his
Fort Greene home in °F, the simulated days served as forecasts in the tests), the conference as a trip
with a packing list (#10, done: the Trips tables, partly packed; the Travel capsule is its pool), the gallery's clashes (#9, done: the Clashes
table, olive chinos + olive chore coat and the double denim), and the Next buys as wishlist items (#18,
done: the Wishlist table, W01 replacing T21). The outfit gallery (#9, done) draws its ideas from the
closet or a capsule, rotating what the simulation left unworn. The style profile (#34, done: above;
his plan went with wardrobe plans, #337).
Today (#15, done): the anchor is today, half lived (step 7), so his home screen shows the evening's
plan and ideas for the day. Outfit selfies (#19, done): his recent evenings carry a mirror selfie (step
6), so the calendar's history weeks and his date-night outfits' Worn strips show the looks.
The weekly auto-plan (#16, done): his week template is the week table, and the planned week is "Plan my week"'s (step 7).
Sizes (#24, done): his measurements and brand notes are the His sizes tables, so the wishlist shows his size in Uniqlo and Allbirds.
Care labels and repairs (#23, done): every labelled garment carries its materials' care, the Care labels table
where the label says otherwise (the blazer, coat and flannels dry clean only), and the Repairs table's log.
The year in review (#26, done): the thirteen weeks and the year's acquisitions are his "2026 so far"; nothing is added for it.
