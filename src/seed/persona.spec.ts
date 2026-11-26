import { describe, expect, it } from 'vitest';
import { BibleError } from './bible';
import { loadPersona, parsePersona, PERSONA_KEYS } from './persona';

/** The bibles are the seed's data: they parse, and a table the app would not store fails loudly. */
describe('persona bibles', () => {
  it.each(PERSONA_KEYS)('%s.md parses through the garment form', (key) => {
    expect(() => loadPersona(key)).not.toThrow();
  });

  it('reads Theo’s Austin conference (#10): its days, outfits, extras and packed garments', () => {
    const [trip] = loadPersona('demo').trips;
    expect(trip.fields).toMatchObject({
      name: 'Austin conference',
      startsOn: '2026-08-19',
      endsOn: '2026-08-21',
    });
    expect(trip.location).toEqual({ latitude: 30.27, longitude: -97.74 });
    expect(trip.outfits.map((o) => [o.day, o.occasion, o.outfit])).toEqual([
      ['2026-08-19', 'all-day', 'Conference travel'],
      ['2026-08-20', 'workout', 'Run'],
      ['2026-08-20', 'work', 'Sweater-polo office'],
      ['2026-08-20', 'evening', 'Rooftop drinks'],
      ['2026-08-21', 'all-day', 'Conference travel'],
    ]);
    expect(trip.extras.filter((e) => e.packed)).toHaveLength(3);
    expect(trip.packed).toHaveLength(9);
    expect(loadPersona('fresh').trips).toEqual([]);
    expect(loadPersona('sparse').trips).toEqual([]);
  });

  it('reads Theo whole: 83 garments, 26 outfits, the week, events and laundry', () => {
    const demo = loadPersona('demo');
    expect(demo.account).toEqual({
      email: 'demo@closet.invalid',
      firstName: 'Theo',
      lastName: 'Marsh',
    });
    expect(demo.weather).toEqual({
      home: {
        name: 'Fort Greene, Brooklyn',
        location: { latitude: 40.69, longitude: -73.98 },
      },
      unit: 'fahrenheit',
    });
    expect(loadPersona('fresh').weather).toBeNull();
    expect(demo.garments).toHaveLength(83);
    expect(demo.garments.filter((g) => g.archivedOn)).toHaveLength(3);
    expect(demo.outfits).toHaveLength(26);
    expect(demo.week?.[3]).toEqual({
      draws: ['office'],
      occasion: 'work',
      workout: undefined,
    });
    // The morning workouts (#13): runs on Monday and Thursday, the gym on
    // Saturday; weekends and home days are all day.
    expect(demo.week?.map((day) => day.workout)).toEqual([
      undefined,
      'Run',
      undefined,
      undefined,
      'Run',
      undefined,
      'Gym',
    ]);
    expect(demo.week?.map((day) => day.occasion)).toEqual([
      'all-day',
      'all-day',
      'work',
      'work',
      'work',
      'all-day',
      'all-day',
    ]);
    expect(demo.events.find((e) => e.wears === 'Wedding')?.from).toBe(
      '2026-08-29',
    );

    const tee = demo.garments.find((g) => g.id === 'T01')!;
    expect(tee).toMatchObject({ role: 'top', away: null });
    expect(tee.fields).toMatchObject({
      quantity: 3,
      // The app's default for a top: the form's "the usual".
      washAfterWears: null,
      condition: 'good',
      conditionNote: null,
    });
    expect(tee.fields).toMatchObject({
      name: 'White tee',
      brand: 'Uniqlo',
      category: 'tops',
      type: 't-shirt',
      size: 'Medium',
      colors: ['white'],
      price: '24.90',
      sleeve: 'short',
    });
    // Paid, not list: the first amount in the cell.
    expect(demo.garments.find((g) => g.id === 'O02')!.fields.price).toBe(
      '400.00',
    );
    // "(same page)" rows carry the page's own link.
    expect(demo.garments.find((g) => g.id === 'T02')!.fields.sourceUrl).toBe(
      demo.garments.find((g) => g.id === 'T01')!.fields.sourceUrl,
    );
    const office = demo.outfits[0];
    expect(office).toMatchObject({ name: 'Office uniform', favourite: true });

    expect(demo.capsules.map((c) => c.fields.name)).toEqual([
      'Office',
      'Weekend',
      'Date night',
      'Travel',
    ]);
    expect(demo.capsules[3].fields.notes).toMatch(/Austin/);
    // An archived garment can be a member (it keeps its membership).
    expect(demo.capsules[1].garmentIds).toContain('Z03');
  });

  it('turns the Laundry, Condition and Away tables into garment form fields and away', () => {
    const demo = loadPersona('demo');
    const garment = (id: string) => demo.garments.find((g) => g.id === id)!;
    // Only where Theo differs from the app's defaults: sweaters 2, the raw
    // denim never (NEVER_WASH), the socks every wear; six socks.
    expect(garment('T20').fields.washAfterWears).toBe(2);
    expect(garment('B01').fields.washAfterWears).toBe(0);
    expect(garment('B02').fields.washAfterWears).toBeNull();
    expect(garment('A11').fields).toMatchObject({
      washAfterWears: 1,
      quantity: 6,
    });
    expect(garment('T21').fields).toMatchObject({
      condition: 'replace_soon',
      conditionNote: expect.stringMatching(/Pilling/) as string,
    });
    expect(garment('B02').fields.condition).toBe('needs_repair');
    expect(garment('G04').away).toEqual({
      reason: 'lent',
      note: expect.stringMatching(/Dana/) as string,
    });
    expect(garment('F07').away).toMatchObject({ reason: 'repair' });
    expect(demo.garments.filter((g) => g.away)).toHaveLength(2);
  });

  it('gives every labelled garment its materials’ care, the Care labels table overriding, and the Repairs log (#23)', () => {
    const demo = loadPersona('demo');
    const garment = (id: string) => demo.garments.find((g) => g.id === id)!;
    // Cotton's usual care; shoes have no label.
    expect(garment('T01').fields).toMatchObject({
      careWash: 'warm',
      careDry: 'tumble',
      careDryClean: null,
    });
    expect(garment('F01').fields.careWash).toBeNull();
    // The coat's label says otherwise; `—` keeps wool and cashmere's.
    expect(garment('O04').fields).toMatchObject({
      careWash: 'do_not_wash',
      careDry: 'flat',
      careDryClean: 'only',
    });
    expect(garment('O03').repairs).toEqual([
      {
        day: '2025-03-22',
        kind: 'alteration',
        note: expect.stringMatching(/Sleeves shortened/) as string,
        cost: '25.00',
      },
    ]);
    expect(garment('T13').repairs[0].cost).toBeNull();
    expect(demo.garments.flatMap((g) => g.repairs)).toHaveLength(5);
  });

  it('gives Dana and Riley no capsules', () => {
    expect(loadPersona('sparse').capsules).toEqual([]);
    expect(loadPersona('fresh').capsules).toEqual([]);
  });

  it("reads Theo's style profile through its form (#34)", () => {
    const demo = loadPersona('demo');
    expect(demo.styleProfile).toEqual({
      styles: ['elevated-basics', 'smart-casual', 'outdoor-technical'],
      budget: 'mid',
      palette: ['green', 'blue', 'black', 'white', 'grey', 'beige', 'brown'],
      notes: expect.stringMatching(/One pattern at a time/) as string,
    });
    // His week template (#16) is his week table: the day's Calendar
    // occasion, and the runs and the gym as workouts.
    expect(
      demo.weekTemplate?.map((slot) => `${slot.weekday} ${slot.occasion}`),
    ).toEqual([
      '0 all-day',
      '1 all-day',
      '1 workout',
      '2 work',
      '3 work',
      '4 workout',
      '4 work',
      '5 all-day',
      '6 all-day',
      '6 workout',
    ]);
    expect(loadPersona('fresh').weekTemplate).toBeNull();
    expect(loadPersona('fresh').styleProfile).toBeNull();
    expect(loadPersona('sparse').styleProfile).toBeNull();
  });

  it("reads Theo's sizes through the Sizes editor's readers (#24); Dana and Riley have none", () => {
    const { sizes } = loadPersona('demo');
    expect(sizes?.unit).toBe('in');
    // 32 in, stored in cm.
    expect(sizes?.lengths).toMatchObject({ waist: 81.28, neck: 39.37 });
    expect(sizes?.brands).toContainEqual({
      brand: 'Uniqlo',
      size: 'Medium',
      note: 'Uniqlo U runs big and boxy: M, never L. Trousers 32.',
    });
    expect(sizes?.brands.map((b) => b.brand)).toContain('Allbirds');
    expect(loadPersona('sparse').sizes).toBeNull();
    expect(loadPersona('fresh').sizes).toBeNull();
  });

  it("reads Theo's clashes, the generator's avoided pairs (#9); Dana and Riley have none", () => {
    expect(loadPersona('demo').avoid).toEqual([
      ['B06', 'O11'],
      ['T15', 'O01'],
    ]);
    expect(loadPersona('sparse').avoid).toEqual([]);
    expect(loadPersona('fresh').avoid).toEqual([]);
  });

  it("reads Theo's wishlist: three items, the merino replacing the pilling one", () => {
    const demo = loadPersona('demo');
    expect(
      demo.wishlist.map(({ id, replaces, fields }) => ({
        id,
        replaces,
        category: fields.category,
        price: fields.price,
        acquiredOn: fields.acquiredOn,
      })),
    ).toEqual([
      {
        id: 'W01',
        replaces: 'T21',
        category: 'tops',
        price: '49.90',
        acquiredOn: null,
      },
      {
        id: 'W02',
        replaces: null,
        category: 'outerwear',
        price: '89.90',
        acquiredOn: null,
      },
      {
        id: 'W03',
        replaces: null,
        category: 'footwear',
        price: '98.00',
        acquiredOn: null,
      },
    ]);
    // Owned garments only: a wishlist id is in no other table.
    expect(demo.garments.map((g) => g.id)).not.toContain('W01');
    expect(demo.garments.find((g) => g.id === 'T21')!.fields.condition).toBe(
      'replace_soon',
    );
    expect(loadPersona('fresh').wishlist).toEqual([]);
  });

  it('reads Dana: a custom category, four garments without a photo, a share with Theo', () => {
    const sparse = loadPersona('sparse');
    expect(sparse.garments.map((g) => g.fields.category)).toContain('scrubs');
    expect(sparse.garments.filter((g) => !g.photo)).toHaveLength(4);
    expect(sparse.sharesWith).toEqual([
      { persona: 'demo', permission: 'MANAGE' },
      { persona: 'scale', permission: 'MANAGE' },
    ]);
    expect(sparse.outfits).toEqual([
      expect.objectContaining({
        name: null,
        occasions: [],
        garmentIds: ['S01', 'S04'],
      }),
    ]);
  });

  const bible = (
    garmentRow: string,
    header = '| id | Name in the app | Type | Colours | Sleeve |',
  ) =>
    `## Account\n\n| Field | Value |\n|---|---|\n| Email | x@closet.invalid |\n| First name | X |\n| Last name | Y |\n\n### Footwear\n\n${header}\n|---|---|---|---|---|\n${garmentRow}\n`;

  // A week whose Wednesday says `wednesday` in the given column.
  const week = (column: 'Calendar' | 'Workout', wednesday: string) =>
    `${bible('| F01 | Shoes | sneakers | white | — |')}\n## His week\n\n| Day | Draws from | ${column} |\n|---|---|---|\n${[
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
    ]
      .map((day) => `| ${day} | weekend | ${day === 'Wed' ? wednesday : '—'} |`)
      .join('\n')}\n`;

  // A trip over a closet of two, its outfit "Look" holding F01 only.
  const trips = (outfitRow: string, packedRow: string, endsOn = '2026-08-21') =>
    `${bible('| F01 | Shoes | sneakers | white | — |\n| F02 | Boots | boots | brown | — |')}\n## Saved outfits\n\n| # | Name | Occasion | Bands | Garments |\n|---|---|---|---|---|\n| 1 | Look | travel | any | F01 |\n\n## Trips\n\n| Trip | From | To | Destination | Location | Notes |\n|---|---|---|---|---|---|\n| Trip | 2026-08-19 | ${endsOn} | Austin | 30.27, -97.74 | — |\n\n### Trip outfits\n\n| Trip | Day | Occasion | Outfit |\n|---|---|---|---|\n${outfitRow}\n\n### Trip packing\n\n| Trip | Garments packed |\n|---|---|\n${packedRow}\n`;

  it.each([
    [
      'a calendar occasion the app does not have',
      week('Calendar', 'office'),
      /Wed's calendar occasion office/,
    ],
    [
      'a workout that is not a saved outfit',
      week('Workout', 'Yoga'),
      /Wed's workout: no saved outfit is called "Yoga"/,
    ],
    [
      'a sleeve on shoes (the form would drop it)',
      bible('| F01 | Shoes | sneakers | white | long |'),
      /drops sleeve/,
    ],
    [
      'a weather location more precise than the app stores',
      bible('| F01 | Shoes | sneakers | white | — |').replace(
        '| Last name | Y |',
        '| Last name | Y |\n| Weather home | Here |\n| Weather location | 40.6892, -73.97 |\n| Temperature unit | celsius |',
      ),
      /Weather location is not a rounded/,
    ],
    [
      'a temperature unit the app does not have',
      bible('| F01 | Shoes | sneakers | white | — |').replace(
        '| Last name | Y |',
        '| Last name | Y |\n| Weather home | Here |\n| Weather location | 40.69, -73.97 |\n| Temperature unit | kelvin |',
      ),
      /Temperature unit is not one: kelvin/,
    ],
    [
      'a care label on shoes',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Care labels\n\n| Garment | Wash | Bleach | Dry | Iron | Dry cleaning |\n|---|---|---|---|---|---|\n| F01 | hand | — | — | — | — |\n`,
      /a care label on a role without one/,
    ],
    [
      'a repair logged before the garment was bought',
      `${bible('| F01 | Shoes | sneakers | white | — |').replace('| Last name | Y |', '| Last name | Y |')}\n## Repairs\n\n| Garment | Day | Kind | What was done | Cost |\n|---|---|---|---|---|\n| F01 | 2099-01-01 | repair | Resoled | $40 |\n`,
      /Log it on the day it was done/,
    ],
    [
      'a type from another category',
      bible('| F01 | Shoes | t-shirt | white | — |'),
      /drops type/,
    ],
    [
      'a colour outside the set',
      bible('| F01 | Shoes | sneakers | teal | — |'),
      /UNKNOWN_COLOR|teal/,
    ],
    [
      'an unknown column',
      bible(
        '| F01 | Shoes | sneakers | white | x |',
        '| id | Name in the app | Type | Colours | Heel |',
      ),
      /unknown garment column "Heel"/,
    ],
    [
      'a short row',
      bible('| F01 | Shoes | sneakers | white |'),
      /4 cells for 5 columns/,
    ],
    [
      'a capsule naming an unknown garment',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Capsules\n\n| Capsule | Garments | Notes |\n|---|---|---|\n| Shoes | F01, F99 | — |\n`,
      /capsule "Shoes": unknown garments: F99/,
    ],
    [
      'two capsules of one name, in any case',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Capsules\n\n| Capsule | Garments | Notes |\n|---|---|---|\n| Shoes | F01 | — |\n| SHOES | F01 | — |\n`,
      /two capsules are called "SHOES"/,
    ],
    [
      'a condition the app does not have',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Condition\n\n| Garment | Condition | Note |\n|---|---|---|\n| F01 | shabby | — |\n`,
      /not a garment form post/,
    ],
    [
      'a trip outfit on a day outside the trip',
      trips('| Trip | 2026-08-22 | evening | Look |', '| Trip | F01 |'),
      /trip "Trip" on 2026-08-22: not a day of the trip/,
    ],
    [
      'a trip outfit that is not a saved outfit',
      trips('| Trip | 2026-08-20 | evening | Nope |', '| Trip | F01 |'),
      /no saved outfit is called "Nope"/,
    ],
    [
      'a packed garment in no outfit of the trip',
      trips('| Trip | 2026-08-20 | — | Look |', '| Trip | F01, F02 |'),
      /Trip packing: F02 is in no outfit of "Trip"/,
    ],
    [
      'a trip ending before it starts',
      trips('| Trip | 2026-08-20 | — | Look |', '| Trip | F01 |', '2026-08-18'),
      /ENDS_BEFORE_START|endsOn/,
    ],
    [
      'away for a garment that is not there',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Away\n\n| Garment | Away | Note |\n|---|---|---|\n| F02 | lent | — |\n`,
      /Away: "F02" is not a garment/,
    ],
    [
      'an away reason the app does not have',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Away\n\n| Garment | Away | Note |\n|---|---|---|\n| F01 | stolen | — |\n`,
      /away: "stolen" is not lent or repair/,
    ],
    [
      'a capsule without a name',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Capsules\n\n| Capsule | Garments | Notes |\n|---|---|---|\n| — | F01 | — |\n`,
      /CAPSULE_NAME_REQUIRED|Give the capsule a name/,
    ],
    [
      'a wishlist item replacing a garment that is not owned',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Wishlist\n\n| id | Name in the app | Category / type | Colours | Replaces |\n|---|---|---|---|---|\n| W01 | New shoes | footwear / sneakers | white | F02 |\n`,
      /replaces "F02", not an owned garment/,
    ],
    [
      'an outfit wearing a wishlist item',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Wishlist\n\n| id | Name in the app | Category / type | Colours | Replaces |\n|---|---|---|---|---|\n| W01 | New shoes | footwear / sneakers | white | F01 |\n\n## Saved outfits\n\n| # | Name | Occasion | Bands | Garments |\n|---|---|---|---|---|\n| 1 | Look | weekend | any | F01, W01 |\n`,
      /unknown garments: W01/,
    ],
    [
      'a week whose day is dressed for an evening',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## His week\n\n| Day | Draws from | Calendar |\n|---|---|---|\n| Sun | weekend | all-day |\n| Mon | weekend | all-day |\n| Tue | weekend | all-day |\n| Wed | weekend | all-day |\n| Thu | weekend | all-day |\n| Fri | weekend | evening |\n| Sat | weekend | all-day |\n`,
      /week template: evening is not an outfit for the day/,
    ],
    [
      'a measurement out of range',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Measurements\n\n| Measurement | Value |\n|---|---|\n| Unit | in |\n| Waist | 900 |\n`,
      /sizes: .*Enter a length from 1 to 118 in/,
    ],
    [
      'a brand twice, in another case',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Brand sizes\n\n| Brand | Size | Note |\n|---|---|---|\n| Uniqlo | M | — |\n| UNIQLO | L | — |\n`,
      /sizes: a brand is listed twice/,
    ],
    [
      'a brand without a size or a note',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n### Brand sizes\n\n| Brand | Size | Note |\n|---|---|---|\n| Uniqlo | — | — |\n`,
      /sizes brand "Uniqlo"/,
    ],
    [
      'a clash naming a garment that is not there',
      `${bible('| F01 | Shoes | sneakers | white | — |')}\n## Clashes\n\n| Garment | Never with | Why |\n|---|---|---|\n| F01 | F02 | — |\n`,
      /Clashes: "F01" and "F02" are not two owned garments/,
    ],
    [
      'a clash inside a saved outfit',
      `${bible('| F01 | Shoes | sneakers | white | — |\n| F02 | Boots | boots | brown | — |')}\n## Saved outfits\n\n| # | Name | Occasion | Bands | Garments |\n|---|---|---|---|---|\n| 1 | Look | weekend | any | F01, F02 |\n\n## Clashes\n\n| Garment | Never with | Why |\n|---|---|---|\n| F02 | F01 | — |\n`,
      /Clashes: F02 and F01 are together in a saved outfit/,
    ],
  ])('refuses %s', (_, markdown, message) => {
    expect(() => parsePersona('fresh', markdown)).toThrow(BibleError);
    expect(() => parsePersona('fresh', markdown)).toThrow(message);
  });
});
