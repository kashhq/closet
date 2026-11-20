import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import { eq } from 'drizzle-orm';
import { garment, garmentWear, outfitCalendar } from '../../src/db/schema';
import { dayColumns } from './calendar-page';
import { createGarment } from './garments';
import {
  createTestApp,
  type TestApp,
  asFixture,
  TEST_PASSWORD,
} from './harness';

/**
 * A planned outfit warns about a piece it cannot be worn with (#358;
 * docs/plans/2026-10-09-structural-refactors.md, Approach 2): a lent or
 * archived piece wears its GarmentMark on Today, the calendar and the
 * outfit page, so the owner taps Change before getting dressed. Nothing is
 * swapped. The wash only on today's cards; nothing on a past entry; away
 * never to a grantee.
 */
describe('planned outfits: unavailable pieces', () => {
  let t: TestApp;
  let jacket: number;
  let lentOutfit: number;
  let archivedOutfit: number;

  const form = (fields: Record<string, string>) => ({
    payload: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  const page = async (url: string, cookie?: string) => {
    const res = await t.inject({
      method: 'GET',
      url,
      ...(cookie && { headers: { cookie } }),
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  const marksIn = (html: string) =>
    [...html.matchAll(/data-mark="([^"]+)"/g)].map((m) => m[1]).sort();

  const createOutfit = async (name: string, garments: [string, number][]) => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: new URLSearchParams([
        ['name', name],
        ...garments.flatMap(([category, id]) => [
          ['category', category],
          ['garmentId', String(id)],
        ]),
      ]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  const plan = async (outfitId: number, occasion: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({ outfitId: String(outfitId), date: t.today(), occasion }),
    });
    expect(res.statusCode).toBe(302);
  };

  beforeAll(async () => {
    t = await createTestApp();
    jacket = await createGarment(t, {
      name: 'Lent jacket',
      category: 'outerwear',
    });
    const shirt = await createGarment(t, { name: 'Shirt', category: 'tops' });
    const jeans = await createGarment(t, {
      name: 'Jeans',
      category: 'bottoms',
    });
    const tee = await createGarment(t, { name: 'Old tee', category: 'tops' });
    const chinos = await createGarment(t, {
      name: 'Chinos',
      category: 'bottoms',
    });
    lentOutfit = await createOutfit('Lent look', [
      ['outerwear', jacket],
      ['tops', shirt],
      ['bottoms', jeans],
    ]);
    archivedOutfit = await createOutfit('Archived look', [
      ['tops', tee],
      ['bottoms', chinos],
    ]);
    await plan(lentOutfit, 'work');
    await plan(archivedOutfit, 'evening');
    // Yesterday's plan of the same outfit: a past entry is a record.
    await asFixture(t.db, (tx) =>
      tx.insert(outfitCalendar).values({
        day: addDays(t.today(), -1),
        outfitId: lentOutfit,
        ownerId: t.owner.id,
        occasion: 'work',
      }),
    );
    const lent = await t.inject({
      method: 'POST',
      url: `/wardrobe/${jacket}/away`,
      ...form({ away: 'lent', awayNote: '' }),
    });
    expect(lent.statusCode).toBe(303);
    const archived = await t.inject({
      method: 'POST',
      url: `/wardrobe/${tee}/archive`,
      headers: { 'hx-request': 'true' },
    });
    expect(archived.statusCode).toBe(200);
    // Worn today on its own: a top's one wear before a wash (limit 1).
    const worn = await t.inject({
      method: 'POST',
      url: `/wardrobe/${shirt}/wear`,
      ...form({ worn: '1' }),
    });
    expect(worn.statusCode).toBe(303);
  });

  afterAll(() => t?.cleanup());

  it("marks Today's planned cards: lent, archived and the wash", async () => {
    const html = await page('/');
    expect(marksIn(html)).toEqual(['archived', 'away:lent', 'needs-wash']);
    expect(html).toContain('>Lent</span>');
  });

  it("marks the week's rows from today on, never a past day's", async () => {
    const today = dayColumns(await page('/calendar')).get(t.today())!;
    expect(marksIn(today)).toEqual(['archived', 'away:lent', 'needs-wash']);
    const yesterday = addDays(t.today(), -1);
    const past = dayColumns(await page(`/calendar?week=${yesterday}`)).get(
      yesterday,
    )!;
    expect(past).toContain('data-occasion="work"');
    expect(marksIn(past)).toEqual([]);
  });

  it("marks the month's cell with a blocking mark, never the wash", async () => {
    const html = await page('/calendar/month');
    const cell = new RegExp(
      `data-month-day="${t.today()}"[\\s\\S]*?</td>`,
    ).exec(html)![0];
    // The cell draws its day's first entry (work before evening) with its
    // own dot, plus one hidden dot for the evening entry's archived piece.
    expect(marksIn(cell)).toEqual(['archived', 'away:lent']);
  });

  it("marks the month's cell for a lent bag it does not draw", async () => {
    const bag = await createGarment(t, { name: 'Lent bag', category: 'bags' });
    const top = await createGarment(t, { name: 'Bag top', category: 'tops' });
    const bagOutfit = await createOutfit('Bag look', [
      ['tops', top],
      ['bags', bag],
    ]);
    const day = addDays(t.today(), 1);
    const planned = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({ outfitId: String(bagOutfit), date: day, occasion: 'work' }),
    });
    expect(planned.statusCode).toBe(302);
    await t.inject({
      method: 'POST',
      url: `/wardrobe/${bag}/away`,
      ...form({ away: 'lent', awayNote: '' }),
    });
    const html = await page('/calendar/month');
    const cell = new RegExp(`data-month-day="${day}"[\\s\\S]*?</td>`).exec(
      html,
    )![0];
    // The cell draws the top only; the bag's warning is one hidden dot.
    expect(cell).toContain('aria-hidden="true"');
    expect(marksIn(cell)).toEqual(['away:lent']);
  });

  it("marks the month's cell for a later entry's lent piece", async () => {
    const first = await createGarment(t, {
      name: 'First top',
      category: 'tops',
    });
    const second = await createGarment(t, {
      name: 'Lent coat',
      category: 'outerwear',
    });
    const day = addDays(t.today(), 2);
    for (const [occasion, g, cat] of [
      ['work', first, 'tops'],
      ['evening', second, 'outerwear'],
    ] as const) {
      const outfitId = await createOutfit(`Day ${occasion}`, [[cat, g]]);
      const res = await t.inject({
        method: 'POST',
        url: '/calendar',
        ...form({ outfitId: String(outfitId), date: day, occasion }),
      });
      expect(res.statusCode).toBe(302);
    }
    await t.inject({
      method: 'POST',
      url: `/wardrobe/${second}/away`,
      ...form({ away: 'lent', awayNote: '' }),
    });
    const html = await page('/calendar/month');
    const cell = new RegExp(`data-month-day="${day}"[\\s\\S]*?</td>`).exec(
      html,
    )![0];
    expect(marksIn(cell)).toEqual(['away:lent']);
    expect(cell).toContain('aria-hidden="true"');
  });

  it('marks the outfit page, without the wash', async () => {
    // Once on the collage, once on the "Garments in this outfit" strip.
    const lentPage = await page(`/outfits/${lentOutfit}`);
    expect(marksIn(lentPage)).toEqual(['away:lent', 'away:lent']);
    const strip = lentPage.slice(lentPage.indexOf('outfit-garments-title'));
    expect(marksIn(strip)).toEqual(['away:lent']);
    expect(
      new RegExp(
        `href="/wardrobe/${jacket}"[\\s\\S]*?data-mark="away:lent"`,
      ).test(strip),
    ).toBe(true);
    expect(marksIn(await page(`/outfits/${archivedOutfit}`))).toEqual([
      'archived',
      'archived',
    ]);
  });

  it('never shows a grantee the away mark', async () => {
    const cookie = await t.register('marks-viewer@example.com');
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'MANAGE', currentPassword: TEST_PASSWORD },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      headers: { cookie },
    });
    // The lent jacket itself, shared: no away mark, and none of the
    // owner's outfits that hold it.
    const garmentPage = await page(
      `/wardrobe/${jacket}?ownerId=${t.owner.id}`,
      cookie,
    );
    expect(garmentPage).toContain('Lent jacket');
    expect(garmentPage).not.toContain('data-garment-outfit=');
    expect(garmentPage).not.toContain('data-mark="away:');
    // The owner's outfits and calendar are never the grantee's.
    const outfit = await t.inject({
      method: 'GET',
      url: `/outfits/${lentOutfit}`,
      headers: { cookie },
    });
    expect(outfit.statusCode).toBe(404);
    expect(marksIn(await page('/', cookie))).toEqual([]);
    expect(marksIn(await page('/calendar', cookie))).toEqual([]);
  });

  it('redraws the whole row when the pill is tapped: no mark and no Change once worn, both back on undo', async () => {
    const cape = await createGarment(t, {
      name: 'Lent cape',
      category: 'outerwear',
    });
    const dress = await createGarment(t, { name: 'Dress', category: 'tops' });
    const outfitId = await createOutfit('Row look', [
      ['outerwear', cape],
      ['tops', dress],
    ]);
    await plan(outfitId, 'daytime');
    const lent = await t.inject({
      method: 'POST',
      url: `/wardrobe/${cape}/away`,
      ...form({ away: 'lent', awayNote: '' }),
    });
    expect(lent.statusCode).toBe(303);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId));
    /** The daytime row's element, found by `data-occasion` alone, whole. */
    const row = (html: string) => {
      const start = /<div class="[^"]*" data-occasion="daytime"/.exec(
        html,
      )!.index;
      const tags = /<(\/?)div\b/g;
      tags.lastIndex = start;
      let depth = 0;
      for (const tag of html.matchAll(tags)) {
        depth += tag[1] ? -1 : 1;
        if (depth === 0) return html.slice(start, tag.index + '</div>'.length);
      }
      throw new Error('unclosed row');
    };
    const toggle = async (worn: '1' | '0') => {
      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${entry.id}/worn`,
        ...form({ worn, returnTo: '/' }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'hx-request': 'true',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('<html');
      return res.body;
    };
    const change = `data-change-entry="${entry.id}"`;
    const warned = 'aria-label="Row look: ';

    const planned = row(dayColumns(await page('/calendar')).get(t.today())!);
    expect(marksIn(planned)).toEqual(['away:lent']);
    expect(planned).toContain(change);

    const worn = await toggle('1');
    expect(worn.startsWith('<div')).toBe(true);
    expect(worn).toContain('data-occasion="daytime"');
    expect(marksIn(worn)).toEqual([]);
    expect(worn).not.toContain(change);
    expect(worn).not.toContain(warned);
    expect(worn).toContain('aria-label="Row look"');
    expect(worn).toContain('data-worn=""');

    const undone = await toggle('0');
    expect(marksIn(undone)).toEqual(['away:lent']);
    expect(undone).toContain(change);
    expect(undone).toContain(warned);
    // The same markup a full page load draws for the entry.
    expect(undone).toBe(planned);
  });
});

/**
 * The wash mark means "no clean copy left", the generator's rule
 * (availableGarment): one dirty copy of three is still wearable.
 */
describe('planned outfits: the wash mark counts copies', () => {
  let t: TestApp;
  let tee: number;

  const todayHtml = async () => {
    const res = await t.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  const wearOn = async (daysAgo: number[]) => {
    await asFixture(t.db, (tx) =>
      tx.insert(garmentWear).values(
        daysAgo.map((n) => ({
          garmentId: tee,
          ownerId: t.owner.id,
          day: addDays(t.today(), -n),
        })),
      ),
    );
  };

  beforeAll(async () => {
    t = await createTestApp();
    tee = await createGarment(t, { name: 'Triple tee', category: 'tops' });
    await asFixture(t.db, (tx) =>
      tx.update(garment).set({ quantity: 3 }).where(eq(garment.id, tee)),
    );
    const created = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: new URLSearchParams([
        ['name', 'Copies'],
        ['category', 'tops'],
        ['garmentId', String(tee)],
      ]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(String(created.headers.location))![1],
    );
    const planned = await t.inject({
      method: 'POST',
      url: '/calendar',
      payload: new URLSearchParams({
        outfitId: String(outfitId),
        date: t.today(),
        occasion: 'work',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(planned.statusCode).toBe(302);
  });

  afterAll(() => t?.cleanup());

  it('shows no mark while a clean copy is left, one when none is', async () => {
    // A top is washed after one wear: one wear day, one dirty copy of three.
    await wearOn([1]);
    expect(await todayHtml()).not.toContain('data-mark="needs-wash"');
    await wearOn([2, 3]);
    expect(await todayHtml()).toContain('data-mark="needs-wash"');
  });
});
