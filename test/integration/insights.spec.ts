import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  garmentWear,
  outfit,
  outfitCalendar,
} from '../../src/db/schema';
import { addDays, type IsoDate } from '../../src/calendar-date';
import { UNWORN_SHOWN } from '../../src/wardrobe/insights';
import { dateLabel } from '../../src/web/date-labels';
import { deviceToken } from './api';
import { createWishlistItem } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
} from './harness';
import { callTool, createAccessToken, tool } from './mcp';
import { expectFullPage, expectNoScriptNavigation } from './pages';

/**
 * Insights (#17, plan section 10) over a closet whose wears are written
 * here, day by day, so every figure has one right answer: worn lately,
 * unworn (with its ownership rule), most and least worn, cost per wear
 * (copies, no price, not worn yet), the pairs worn together (by day), the
 * colours, categories and brands, and condition. Wears count distinct days;
 * the closet is inCloset (an archived coat and a wishlist item worn or
 * priced change nothing), and it is the owner's alone (another user's
 * wears too). The page and wardrobe_stats agree; the page reads the owner
 * row, then two statements. The seed's Theo is insights-seed.spec.ts.
 */

const form = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
};

interface GarmentFields {
  name: string;
  category: string;
  brand?: string;
  color?: string[];
  price?: string;
  quantity?: number;
  /** Days before today it was acquired; none for no date. */
  acquired?: number;
  condition?: 'good' | 'needs_repair' | 'replace_soon';
}

/** The `data-garment-id`s of the first garment list in `id`, in order. */
function idsIn(html: string, id: string): number[] {
  const start = html.indexOf(`id="${id}"`);
  expect(start, id).toBeGreaterThan(-1);
  const end = html.indexOf('</ul>', start);
  return [...html.slice(start, end).matchAll(/data-garment-id="(\d+)"/g)].map(
    (m) => Number(m[1]),
  );
}

function section(html: string, sectionId: string): string {
  const start = html.indexOf(`id="${sectionId}"`);
  expect(start, sectionId).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

describe('insights', () => {
  let t: TestApp;
  let ownerId: number;
  const daysAgo = (days: number): IsoDate => addDays(t.today(), -days);
  const g: Record<string, number> = {};

  async function newGarment(fields: GarmentFields, cookie?: string) {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({
        name: fields.name,
        category: fields.category,
        brand: fields.brand ?? '',
        color: fields.color ?? [],
        dateAquired:
          fields.acquired === undefined ? '' : daysAgo(fields.acquired),
        product: '1',
        price: fields.price ?? '',
        sourceUrl: '',
        care: '1',
        quantity: String(fields.quantity ?? 1),
        washAfterWears: '',
        condition: fields.condition ?? 'good',
      }),
      ...(cookie && {
        headers: { ...form({}).headers, cookie },
      }),
    });
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/wardrobe\/(\d+)\?/.exec(res.headers.location!)![1]);
  }

  /** One garment_wear row: a day-level wear, or one of entry `entryId`. */
  async function wear(
    garmentId: number,
    days: number,
    entryId: number | null = null,
    owner = ownerId,
  ) {
    await asFixture(t.db, (tx) =>
      tx.insert(garmentWear).values({
        garmentId,
        ownerId: owner,
        day: daysAgo(days),
        outfitCalendarId: entryId,
      }),
    );
  }

  /** A worn calendar entry of a new outfit, `days` ago. */
  async function wornEntry(days: number): Promise<number> {
    const [made] = await asFixture(t.db, (tx) =>
      tx
        .insert(outfit)
        .values({ shareableId: randomUUID(), ownerId, name: `Day ${days}` })
        .returning({ id: outfit.id }),
    );
    const [entry] = await asFixture(t.db, (tx) =>
      tx
        .insert(outfitCalendar)
        .values({
          day: daysAgo(days),
          outfitId: made.id,
          ownerId,
          wornAt: new Date(),
        })
        .returning({ id: outfitCalendar.id }),
    );
    return entry.id;
  }

  const page = async (query = '') => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/insights${query}`,
    });
    expect(res.statusCode).toBe(200);
    return { res, html: unescapeHtml(res.body) };
  };

  beforeAll(async () => {
    t = await createTestApp();
    const { cookie } = t.owner;
    ownerId = t.owner.id;
    const own = (fields: GarmentFields) => newGarment(fields, cookie);
    g.tee = await own({
      name: 'White tee',
      category: 'tops',
      brand: 'Uniqlo',
      color: ['white'],
      price: '20',
      quantity: 3,
      acquired: 400,
    });
    g.jeans = await own({
      name: 'Blue jeans',
      category: 'bottoms',
      brand: ' uniqlo ',
      color: ['blue'],
      price: '100',
      acquired: 400,
    });
    g.jacket = await own({
      name: 'Waxed jacket',
      category: 'outerwear',
      brand: 'Barbour',
      color: ['green', 'brown'],
      price: '300',
      acquired: 200,
      condition: 'needs_repair',
    });
    g.boots = await own({
      name: 'Old boots',
      category: 'footwear',
      condition: 'replace_soon',
    });
    g.shirt = await own({
      name: 'New shirt',
      category: 'tops',
      brand: 'COS',
      color: ['black'],
      price: '50',
      acquired: 10,
    });
    g.scarf = await own({
      name: 'Red scarf',
      category: 'accessories',
      color: ['red'],
      price: '40',
      acquired: 500,
    });
    g.sandals = await own({
      name: 'Sandals',
      category: 'footwear',
      color: ['brown'],
      price: '60',
      acquired: 400,
    });
    g.belt = await own({
      name: 'Black belt',
      category: 'accessories',
      color: ['black'],
      acquired: 400,
    });
    // Out of the closet: an archived coat worn with the tee, and a
    // wishlist item with a price.
    g.coat = await own({
      name: 'Archived coat',
      category: 'outerwear',
      price: '500',
      color: ['black'],
      acquired: 400,
    });
    g.wish = await createWishlistItem(t, {
      name: 'Wished loafers',
      category: 'footwear',
      price: '80',
      cookie,
    });

    // Yesterday was a two-outfit day: the tee in both entries (one wear),
    // the jeans in the first, the jacket in the second.
    const work = await wornEntry(1);
    const evening = await wornEntry(1);
    await wear(g.tee, 1, work);
    await wear(g.tee, 1, evening);
    await wear(g.jeans, 1, work);
    await wear(g.jacket, 1, evening);
    for (const days of [0, 5, 40, 100, 300]) await wear(g.tee, days);
    for (const days of [5, 40, 100]) await wear(g.jeans, days);
    for (const days of [5, 60]) await wear(g.jacket, days);
    await wear(g.boots, 35);
    await wear(g.scarf, 200);
    await wear(g.belt, 120);
    for (const days of [0, 2, 3]) await wear(g.coat, days);
    const archived = await t.inject({
      method: 'POST',
      url: `/wardrobe/${g.coat}/archive`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBeLessThan(400);
    const [coat] = await t.db
      .select({ status: garment.status })
      .from(garment)
      .where(eq(garment.id, g.coat));
    expect(coat.status).toBe('archived');

    // Another user's closet, worn every day: none of it is the owner's.
    const strangerCookie = await t.register('stranger@example.com');
    const strangerId = await userIdOf(t, 'stranger@example.com');
    const theirs = await newGarment(
      { name: 'Stranger tee', category: 'tops', price: '10' },
      strangerCookie,
    );
    for (const days of [0, 1, 2, 3]) await wear(theirs, days, null, strangerId);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it('renders a full page, linked from the Wardrobe’s ⋯ menu', async () => {
    const { res } = await page();
    expectFullPage(res);
    expectNoScriptNavigation(res);
    const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(section(wardrobe.body, 'wardrobe-menu')).toContain(
      'href="/wardrobe/insights"',
    );
  });

  it('counts the closet by garment, and its pieces by copy', async () => {
    const { html } = await page();
    expect(section(html, 'insights-closet')).toContain(
      '8 garments in your closet · 10 pieces',
    );
  });

  it('worn lately: garments worn in the last 30, 90 and 365 days', async () => {
    const { html } = await page();
    const worn = section(html, 'insights-worn');
    // 30: tee, jeans, jacket. 90: + boots (35 days). 365: + scarf, belt.
    expect(worn).toMatch(/data-window="30"[^]*?38%[^]*?3 of 8/);
    expect(worn).toMatch(/data-window="90"[^]*?50%[^]*?4 of 8/);
    expect(worn).toMatch(/data-window="365"[^]*?75%[^]*?6 of 8/);
  });

  it.each([
    // Never worn first, then the longest since; a garment owned for less
    // than the window (the new shirt) is not judged; no acquired date is
    // owned long enough (the boots).
    ['?unworn=30', ['sandals', 'scarf', 'belt', 'boots']],
    ['', ['sandals', 'scarf', 'belt']],
    ['?unworn=180', ['sandals', 'scarf']],
    // Navigation state: anything else is the default.
    ['?unworn=45', ['sandals', 'scarf', 'belt']],
    ['?unworn=abc', ['sandals', 'scarf', 'belt']],
    // However long (#123): a length limit would answer 400 first.
    ['?unworn=not-a-window', ['sandals', 'scarf', 'belt']],
  ])('unworn %s', async (query, names) => {
    const { html } = await page(query);
    expect(idsIn(html, 'insights-unworn')).toEqual(names.map((n) => g[n]));
  });

  it('offers "Style this" (Styling locked on it, #42) on every unworn garment', async () => {
    const { html } = await page();
    const unworn = section(html, 'insights-unworn');
    expect(unworn.match(/>Style this</g)).toHaveLength(3);
    expect(unworn).toContain(`href="/styling?with=${g.sandals}"`);
    expect(unworn).toContain('Never worn');
    expect(unworn).toContain(`Last worn ${dateLabel(daysAgo(200), t.today())}`);
  });

  it('most worn by wear days, ties the most recent first; least worn among garments owned 90 days', async () => {
    const { html } = await page();
    // The tee's two entries yesterday are one wear: 6 days.
    expect(idsIn(html, 'insights-most-worn')).toEqual([
      g.tee,
      g.jeans,
      g.jacket,
      g.boots,
      g.belt,
    ]);
    expect(section(html, 'insights-most-worn')).toContain('Worn 6 times');
    // The new shirt (10 days) is too new; the most worn are left out.
    expect(idsIn(html, 'insights-least-worn')).toEqual([g.sandals, g.scarf]);
  });

  it('cost per wear: price × copies over wear days; no price left out; not worn yet never divided', async () => {
    const { html } = await page();
    const cost = section(html, 'insights-cost');
    // 20 + 100 + 300 + 50 + 40 + 60 (the tee's three copies at 20 each).
    expect(cost).toContain('data-closet-value="610.00"');
    expect(cost).toContain(
      'Your closet cost $610.00, repairs included · 2 without a price',
    );
    expect(idsIn(cost, 'insights-best-value')).toEqual([g.tee, g.jeans]);
    expect(cost).toContain('$10.00 a wear · $60.00 over 6 days');
    expect(idsIn(cost, 'insights-most-per-wear')).toEqual([g.jacket, g.scarf]);
    expect(cost).toContain('$100.00 a wear · $300.00 over 3 days');
    expect(cost).toContain('$40.00 a wear · worn once');
    expect(idsIn(cost, 'insights-not-worn-yet')).toEqual([g.sandals, g.shirt]);
    expect(cost).toContain('Paid for, not worn yet (2)');
    expect(cost).toContain('$60.00 · not worn yet');
  });

  it('pairs worn on the same days, whichever outfits held them', async () => {
    const { html } = await page();
    const pairs = [
      ...section(html, 'insights-pairs').matchAll(
        /data-pair="(\d+)-(\d+)" data-days="(\d+)"/g,
      ),
    ].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    // Yesterday's jeans (work) and jacket (evening) count as together;
    // the archived coat, worn with the tee on two days, is not a pair.
    expect(pairs).toEqual([
      [g.tee, g.jeans, 4],
      [g.tee, g.jacket, 2],
      [g.jeans, g.jacket, 2],
    ]);
  });

  it('colours: the closet’s share and the worn share, two-colour garments halved', async () => {
    const { html } = await page();
    const colours = section(html, 'insights-colours');
    const strip = (name: string) =>
      Object.fromEntries(
        [
          ...colours
            .slice(colours.indexOf(`data-strip="${name}"`))
            .split('</div></div>')[0]
            .matchAll(/data-colour="(\w+)" data-share="(\d+)"/g),
        ].map((m) => [m[1], Number(m[2])]),
      );
    // Shares of the whole closet (#123): eight garments, seven coloured:
    // black 2 (shirt, belt), brown 1.5, blue, red, white 1 each, green 0.5;
    // the boots have none, and are the strip's plain end.
    expect(strip('closet')).toEqual({
      black: 25,
      brown: 19,
      blue: 13,
      red: 13,
      white: 13,
      green: 6,
    });
    // 16 wear days in the year: tee 6, jeans 4, jacket 3 (half green, half
    // brown), scarf 1, belt 1, and the boots' 1.
    expect(strip('worn')).toEqual({
      black: 6,
      brown: 9,
      blue: 25,
      red: 6,
      white: 38,
      green: 9,
    });
    const plainEnd = (name: string) =>
      /data-uncoloured="" data-share="(\d+)"/.exec(
        colours
          .slice(colours.indexOf(`data-strip="${name}"`))
          .split('</div></div>')[0],
      )?.[1];
    expect([plainEnd('closet'), plainEnd('worn')]).toEqual(['13', '6']);
    expect(colours).toContain(
      '1 without a colour: 13% of the closet, 6% of what you wear',
    );
  });

  it('categories and brands: garments, pieces and share of wears', async () => {
    const { html } = await page();
    const keys = (id: string) =>
      [...section(html, id).matchAll(/data-key="([^"]*)"/g)].map((m) => m[1]);
    expect(keys('insights-categories')).toEqual([
      'tops',
      'accessories',
      'footwear',
      'bottoms',
      'outerwear',
    ]);
    // Tops: the tee (3 copies) and the shirt; 6 of the 16 wear days.
    expect(section(html, 'insights-categories')).toContain(
      '2 garments · 4 pieces · 38% of wears',
    );
    // " uniqlo " is Uniqlo, spelled as the first garment added has it.
    expect(keys('insights-brands')).toEqual(['Uniqlo', 'Barbour', 'COS']);
    expect(section(html, 'insights-brands')).toContain(
      '2 garments · 4 pieces · 63% of wears',
    );
    expect(section(html, 'insights-brands')).toContain('4 without a brand');
  });

  it('condition: counts linking to the Needs attention filter', async () => {
    const { html } = await page();
    const attention = section(html, 'insights-attention');
    expect(attention).toContain('Needs repair: 1 · Replace soon: 1');
    expect(attention).toContain('href="/wardrobe?attention=true"');
  });

  it('reads the owner row, then two statements, whatever the wear log holds', async () => {
    const record = await recordQueries(() => page());
    expect(record.statements).toBe(3);
    // The user, a row per closet garment, the three pairs.
    expect(record.rows).toBe(1 + 8 + 3);
    // Another unworn window is computed from the same rows (#169).
    const unworn = await recordQueries(() => page('?unworn=30'));
    expect(unworn.statements).toBe(3);
    expect(unworn.rows).toBe(1 + 8 + 3);
  });

  // #680: an owner-only page naming another's wardrobe is a 404, reading
  // nothing past the session (no share, no insights statement).
  it('is the signed-in user’s own: a foreign ?ownerId= is a 404', async () => {
    const cookie = await t.login('stranger@example.com');
    const request = () =>
      t.inject({
        method: 'GET',
        url: `/wardrobe/insights?ownerId=${ownerId}`,
        headers: { cookie },
      });
    expect((await recordQueries(request)).statements).toBe(1);
    const other = await request();
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain('White tee');
  });

  it('the unworn page lists every garment, past the five of the dashboard and the 48 of the API', async () => {
    const cookie = await t.register('many@example.com');
    const total = UNWORN_SHOWN + 4;
    for (let n = 0; n < total; n++) {
      await newGarment({ name: `Sock ${n}`, category: 'Socks' }, cookie);
    }
    const read = (url: string) =>
      t.inject({ method: 'GET', url, headers: { cookie } });
    const dashboard = (await read('/wardrobe/insights')).body;
    expect(idsIn(dashboard, 'insights-unworn')).toHaveLength(5);
    expect(dashboard).toContain('data-see-all');
    const all = (await read('/wardrobe/insights/unworn')).body;
    expect(idsIn(all, 'insights-unworn')).toHaveLength(total);
    expect(all).toContain(`data-unworn-count="${total}"`);
  });

  it('an empty closet says what to do', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe/insights',
      headers: { cookie: await t.register('empty@example.com') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Nothing to measure yet.');
    expect(res.body).not.toContain('id="insights-worn"');
  });

  it('wardrobe_stats answers the same figures', async () => {
    const token = await createAccessToken(t);
    const stats = await tool<{
      closet: { garments: number; pieces: number };
      worn: { days: number; worn: number; percent: number }[];
      unworn: { days: number; count: number; garments: { id: number }[] };
      mostWorn: { id: number; wearDays: number }[];
      leastWorn: { id: number }[];
      costPerWear: {
        best: { id: number; cost: string; costPerWear: string }[];
        worst: { id: number }[];
        notWornYet: { id: number; costPerWear: null }[];
        closetValue: string;
        unpriced: number;
      };
      pairs: { garments: { id: number }[]; days: number }[];
      colours: { colour: string; closetPercent: number }[];
      uncoloured: number;
      categories: { category: string }[];
      brands: { brand: string | null }[];
      condition: { needsRepair: number; replaceSoon: number };
    }>(t, token, 'wardrobe_stats', { unwornDays: 180 });
    expect(stats.closet).toEqual({ garments: 8, pieces: 10 });
    expect(stats.worn.map((w) => [w.days, w.worn, w.percent])).toEqual([
      [30, 3, 38],
      [90, 4, 50],
      [365, 6, 75],
    ]);
    expect(stats.unworn).toMatchObject({ days: 180, count: 2 });
    expect(stats.unworn.garments.map((x) => x.id)).toEqual([
      g.sandals,
      g.scarf,
    ]);
    expect(stats.mostWorn[0]).toMatchObject({ id: g.tee, wearDays: 6 });
    expect(stats.leastWorn.map((x) => x.id)).toEqual([g.sandals, g.scarf]);
    expect(stats.costPerWear.best[0]).toMatchObject({
      id: g.tee,
      cost: '60.00',
      costPerWear: '10.00',
    });
    expect(stats.costPerWear.worst.map((x) => x.id)).toEqual([
      g.jacket,
      g.scarf,
    ]);
    expect(stats.costPerWear.notWornYet.map((x) => x.costPerWear)).toEqual([
      null,
      null,
    ]);
    expect(stats.costPerWear).toMatchObject({
      closetValue: '610.00',
      unpriced: 2,
    });
    expect(
      stats.pairs.map((p) => [...p.garments.map((x) => x.id), p.days]),
    ).toEqual([
      [g.tee, g.jeans, 4],
      [g.tee, g.jacket, 2],
      [g.jeans, g.jacket, 2],
    ]);
    // Of the whole closet and all wear days, the boots without a colour too.
    expect(stats.colours[0]).toEqual({
      colour: 'black',
      closetPercent: 25,
      wornPercent: 6,
    });
    expect(stats.uncoloured).toBe(1);
    expect(stats.categories.map((c) => c.category)[0]).toBe('tops');
    expect(stats.brands.map((b) => b.brand)).toEqual([
      'Uniqlo',
      'Barbour',
      'COS',
    ]);
    expect(stats.condition).toEqual({ needsRepair: 1, replaceSoon: 1 });
  });

  it('GET /api/v1/insights maps the page’s figures: money strings, shares, pairs', async () => {
    const { token } = await deviceToken(t);
    const res = await t.api(token, {
      method: 'GET',
      url: '/api/v1/insights?unwornDays=180',
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      closet: unknown;
      cost: {
        best: { garment: { id: number }; cost: string; perWear: string }[];
        worst: { garment: { id: number }; cost: string; perWear: string }[];
        notWornYet: { garment: { id: number }; cost: string }[];
        notWornYetCount: number;
        closetValue: string;
        priced: number;
        unpriced: number;
      };
      pairs: { garments: { id: number }[]; days: number }[];
      colours: { colour: string; closetPercent: number; wornPercent: number }[];
      uncoloured: unknown;
      categories: { key: string; garments: number; pieces: number }[];
      brands: { key: string; closetPercent?: number; wornPercent: number }[];
    }>();
    // The page's own strings (cost per wear test above), as decimals.
    expect(body.cost.closetValue).toBe('610.00');
    expect(body.cost.best[0]).toMatchObject({
      garment: { id: g.tee },
      cost: '60.00',
      perWear: '10.00',
    });
    expect(body.cost.best[1]).toMatchObject({
      garment: { id: g.jeans },
      cost: '100.00',
      perWear: '25.00',
    });
    expect(
      body.cost.worst.map((w) => [w.garment.id, w.cost, w.perWear]),
    ).toEqual([
      [g.jacket, '300.00', '100.00'],
      [g.scarf, '40.00', '40.00'],
    ]);
    expect(body.cost.notWornYet.map((n) => [n.garment.id, n.cost])).toEqual([
      [g.sandals, '60.00'],
      [g.shirt, '50.00'],
    ]);
    expect(body.cost).toMatchObject({
      notWornYetCount: 2,
      priced: 6,
      unpriced: 2,
    });
    expect(
      body.pairs.map((p) => [...p.garments.map((x) => x.id), p.days]),
    ).toEqual([
      [g.tee, g.jeans, 4],
      [g.tee, g.jacket, 2],
      [g.jeans, g.jacket, 2],
    ]);
    expect(body.colours).toContainEqual({
      colour: 'white',
      closetPercent: 13,
      wornPercent: 38,
    });
    expect(body.uncoloured).toEqual({
      garments: 1,
      closetPercent: 13,
      wornPercent: 6,
    });
    expect(body.categories[0]).toMatchObject({
      key: 'tops',
      garments: 2,
      pieces: 4,
    });
    expect(body.brands[0]).toMatchObject({ key: 'Uniqlo', wornPercent: 63 });
  });

  it('GET /api/v1/insights/recap maps the year’s pair and best value', async () => {
    // Last year's fixed days, so the figures hold on any day of this one. The
    // coat, dearer per wear, is the cost list's "worst", not the recap's best.
    const email = 'recap@example.com';
    const cookie = await t.register(email);
    const recapOwner = await userIdOf(t, email);
    const coat = await newGarment(
      { name: 'Recap coat', category: 'outerwear', price: '45.5' },
      cookie,
    );
    const hat = await newGarment(
      { name: 'Recap hat', category: 'accessories', price: '12' },
      cookie,
    );
    const year = Number(t.today().slice(0, 4)) - 1;
    await asFixture(t.db, (tx) =>
      tx.insert(garmentWear).values(
        [coat, hat].flatMap((garmentId) =>
          [`${year}-03-01`, `${year}-03-02`].map((day) => ({
            garmentId,
            ownerId: recapOwner,
            day,
          })),
        ),
      ),
    );
    const { token } = await deviceToken(t, { email });
    const res = await t.api(token, {
      method: 'GET',
      url: `/api/v1/insights/recap?year=${year}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      wears: number;
      piecesWorn: number;
      enough: boolean;
      bestValue: { garment: { id: number }; cost: string; perWear: string }[];
      pair: { garments: { id: number }[]; days: number };
    }>();
    expect(body).toMatchObject({ wears: 4, piecesWorn: 2, enough: false });
    expect(
      body.bestValue.map((b) => [b.garment.id, b.cost, b.perWear]),
    ).toEqual([[hat, '12.00', '6.00']]);
    expect(body.pair.garments.map((x) => x.id).sort()).toEqual(
      [coat, hat].sort(),
    );
    expect(body.pair.days).toBe(2);
  });

  it('wardrobe_stats refuses a window outside the choices', async () => {
    const token = await createAccessToken(t);
    const answer = await callTool(t, token, 'wardrobe_stats', {
      unwornDays: 45,
    });
    expect(answer.isError).toBe(true);
  });
});
