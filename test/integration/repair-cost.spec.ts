import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { garmentRepair, garmentWear, wardrobeShare } from '../../src/db/schema';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
} from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * Repair costs in cost per wear (#151): what a garment cost is its price ×
 * copies plus its repairs (totalCost), on every surface the owner sees it:
 * the garment page's wear line and its htmx answer, insights (and "your
 * closet cost"), a past year's recap (repairs dated up to its December 31,
 * like wears), wardrobe_stats and get_garment. An unpriced garment stays
 * out, repaired or not. Repairs are the owner's own record, and the price
 * the `private` capability's (#680): a VIEW grantee sees neither, nor a
 * cost that holds them. The clock is pinned to
 * 2026-09-27 in New York so the repairs and wears fall in known years.
 */

const NOW = '2026-09-27T16:00:00Z';

/** Ten days in 2025, one a month and October's. */
const WORN_2025 = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((month) => `2025-0${month}-10`),
  '2025-10-10',
];

function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start, id).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

describe('repair costs in cost per wear', () => {
  let t: TestApp;
  let viewerCookie: string;
  const g: Record<string, number> = {};

  async function newGarment(
    fields: { name: string; category: string; price?: string },
    cookie?: string,
  ) {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: new URLSearchParams({
        name: fields.name,
        category: fields.category,
        product: '1',
        price: fields.price ?? '',
        sourceUrl: '',
        dateAquired: '2025-01-01',
      }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie && { cookie }),
      },
    });
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/wardrobe\/(\d+)\?/.exec(res.headers.location!)![1]);
  }

  async function wear(garmentId: number, days: string[], ownerId: number) {
    await asFixture(t.db, (tx) =>
      tx
        .insert(garmentWear)
        .values(days.map((day) => ({ garmentId, ownerId, day }))),
    );
  }

  async function repair(
    garmentId: number,
    day: string,
    cost: string,
    cookie?: string,
  ) {
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/repairs`,
      payload: { day, kind: 'repair', note: `Mended ${day}`, cost },
      ...(cookie && { headers: { cookie } }),
    });
    expect(res.statusCode, res.body).toBe(303);
  }

  const get = async (url: string, cookie?: string) => {
    const res = await t.inject({
      method: 'GET',
      url,
      ...(cookie && { headers: { cookie } }),
    });
    expect(res.statusCode, res.body).toBe(200);
    return unescapeHtml(res.body);
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
    t = await createTestApp();
    const ownerId = t.owner.id;
    // The boots: 100.00, worn ten days in 2025, resoled that June (20.00)
    // and re-heeled this March (30.00), and a repair without a cost.
    g.boots = await newGarment({
      name: 'Boots',
      category: 'footwear',
      price: '100',
    });
    await wear(g.boots, WORN_2025, ownerId);
    await repair(g.boots, '2025-06-01', '20');
    await repair(g.boots, '2026-03-01', '30');
    await repair(g.boots, '2026-03-02', '');
    // The coat: 180.00 over the same ten days, never repaired.
    g.coat = await newGarment({
      name: 'Coat',
      category: 'outerwear',
      price: '180',
    });
    await wear(g.coat, WORN_2025, ownerId);
    // The tee: 20.00 over two days this year, never repaired.
    g.tee = await newGarment({ name: 'Tee', category: 'tops', price: '20' });
    await wear(g.tee, ['2026-09-01', '2026-09-02'], ownerId);
    // The scarf: no price, a 40.00 repair; still no cost per wear.
    g.scarf = await newGarment({ name: 'Scarf', category: 'accessories' });
    await wear(g.scarf, ['2026-09-03'], ownerId);
    await repair(g.scarf, '2026-09-03', '40');

    viewerCookie = await t.register('viewer@example.com');
    await t.db.insert(wardrobeShare).values({
      grantorId: ownerId,
      granteeId: await userIdOf(t, 'viewer@example.com'),
      permission: 'VIEW',
      inviteToken: randomUUID(),
      createdAt: new Date(),
      acceptedAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await t?.cleanup();
  });

  describe('the owner', () => {
    it('sees the repairs in the garment page’s cost per wear', async () => {
      // (100 + 20 + 30) / 10: 15.00, where the price alone was 10.00.
      const boots = await get(`/wardrobe/${g.boots}`);
      expect(section(boots, 'garment-wear')).toContain('$15.00 a wear');
      expect(boots).toContain('Spent on it: $50.00');
      // Without repairs the price is the cost.
      const tee = await get(`/wardrobe/${g.tee}`);
      expect(section(tee, 'garment-wear')).toContain('$10.00 a wear');
      // Without a price a repair makes no cost per wear.
      const scarf = await get(`/wardrobe/${g.scarf}`);
      expect(section(scarf, 'garment-wear')).not.toContain('a wear');
    });

    it('“Spent on it” and the wear line add the one same sum', async () => {
      // A hat, 10.00, worn twice, mended today for 10.00. A row dated
      // tomorrow (no form writes one: readRepairDay refuses it) proves both
      // figures read wearSummarySql's repairCost, bounded by today, rather
      // than the log's entries summed apart. Another user's, so the
      // owner's insights figures stay as the tests below pin them.
      const cookie = await t.register('hatter@example.com');
      const hat = await newGarment(
        { name: 'Hat', category: 'accessories', price: '10' },
        cookie,
      );
      await wear(
        hat,
        ['2026-09-20', '2026-09-21'],
        await userIdOf(t, 'hatter@example.com'),
      );
      await repair(hat, '2026-09-27', '10', cookie);
      await asFixture(t.db, (tx) =>
        tx.insert(garmentRepair).values({
          garmentId: hat,
          day: '2026-09-28',
          kind: 'repair',
          note: 'Not done yet',
          cost: '100.00',
        }),
      );
      const html = await get(`/wardrobe/${hat}`, cookie);
      // (10 + 10) / 2, and the 10.00 it adds.
      expect(section(html, 'garment-wear')).toContain('$10.00 a wear');
      expect(section(html, 'garment-repairs')).toContain('Spent on it: $10.00');
    });

    it('sees them in the wear line “Wore today” answers', async () => {
      const cookie = await t.register('mender@example.com');
      const belt = await newGarment(
        { name: 'Belt', category: 'accessories', price: '30' },
        cookie,
      );
      await repair(belt, '2026-09-27', '15', cookie);
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${belt}/wear`,
        payload: { worn: '1' },
        headers: { cookie, 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(unescapeHtml(res.body)).toContain('$45.00 a wear');
    });

    it('insights ranks by the cost with repairs, and the closet’s cost includes them', async () => {
      const cost = section(await get('/wardrobe/insights'), 'insights-cost');
      // Tee 20 + boots 150 + coat 180; the scarf has no price.
      expect(cost).toContain('data-closet-value="350.00"');
      expect(cost).toContain(
        'Your closet cost $350.00, repairs included · 1 without a price',
      );
      expect(cost).toContain('plus its repairs');
      // Best: the tee (10.00), the boots (15.00); worst: the coat (18.00).
      expect(cost).toContain('$10.00 a wear · $20.00 over 2 days');
      expect(cost).toContain('$15.00 a wear · $150.00 over 10 days');
      expect(cost).toContain('$18.00 a wear · $180.00 over 10 days');
    });

    it('still reads the owner row and two statements', async () => {
      const record = await recordQueries(() => get('/wardrobe/insights'));
      expect(record.statements).toBe(3);
    });

    it('a past year’s recap counts the repairs done by its December 31', async () => {
      // 2025: the resole (20.00) but not this March's heel: (100 + 20) / 10.
      const html = await get('/wardrobe/recap?year=2025');
      const best = section(html, 'recap-best-value');
      expect(best).toContain('$12.00 a wear · $120.00 over 10 days');
      expect(best).toContain('counting every wear and repair up to');
      const island =
        /data-card="(\{.*?\})" data-page-module="recap-export"/s.exec(html);
      const card = JSON.parse(island![1]) as {
        bestValue: { garment: { name: string; detail: string } } | null;
      };
      expect(card.bestValue!.garment).toMatchObject({
        name: 'Boots',
        detail: '$12.00 a wear',
      });
    });

    it('wardrobe_stats answers the cost with repairs, and the repairs apart', async () => {
      const token = await createAccessToken(t);
      const stats = await tool<{
        costPerWear: {
          best: {
            id: number;
            price: string;
            repairCost: string | null;
            cost: string;
            costPerWear: string;
          }[];
          closetValue: string;
          unpriced: number;
        };
      }>(t, token, 'wardrobe_stats', {});
      expect(stats.costPerWear.best).toEqual([
        expect.objectContaining({
          id: g.tee,
          price: '20.00',
          repairCost: null,
          cost: '20.00',
          costPerWear: '10.00',
        }),
        expect.objectContaining({
          id: g.boots,
          price: '100.00',
          repairCost: '50.00',
          cost: '150.00',
          costPerWear: '15.00',
        }),
      ]);
      expect(stats.costPerWear).toMatchObject({
        closetValue: '350.00',
        unpriced: 1,
      });
    });

    it('get_garment answers what it cost and its cost per wear', async () => {
      const token = await createAccessToken(t);
      const care = async (id: number) =>
        (
          await tool<{
            care: { cost: string | null; costPerWear: string | null };
          }>(t, token, 'get_garment', { id })
        ).care;
      expect(await care(g.boots)).toMatchObject({
        cost: '150.00',
        costPerWear: '15.00',
      });
      expect(await care(g.tee)).toMatchObject({
        cost: '20.00',
        costPerWear: '10.00',
      });
      expect(await care(g.scarf)).toMatchObject({
        cost: null,
        costPerWear: null,
      });
    });
  });

  describe('a grantee', () => {
    it('sees neither the price on the shared garment page nor a cost with repairs', async () => {
      const html = await get(
        `/wardrobe/${g.boots}?ownerId=${t.owner.id}`,
        viewerCookie,
      );
      expect(html).toContain('Boots');
      expect(html).not.toContain('$100.00');
      expect(html).not.toContain('a wear');
      expect(html).not.toContain('$150.00');
      expect(html).not.toContain('$50.00');
      expect(html).not.toContain('garment-repairs');
    });

    it('gets no price and no cost from get_garment on the shared wardrobe', async () => {
      const token = await createAccessToken(t, { cookie: viewerCookie });
      const detail = await tool<Record<string, unknown>>(
        t,
        token,
        'get_garment',
        { id: g.boots, ownerId: t.owner.id },
      );
      expect(detail.name).toBe('Boots');
      expect(detail).not.toHaveProperty('price');
      expect(detail.care).toBeUndefined();
      expect(detail.repairs).toBeUndefined();
      const answer = JSON.stringify(detail);
      expect(answer).not.toContain('100.00');
      expect(answer).not.toContain('150.00');
      expect(answer).not.toContain('costPerWear');
    });

    it('sees their own insights and stats, never the owner’s costs', async () => {
      // Insights are owner-only: naming the owner is a 404 (#680).
      const named = await t.inject({
        method: 'GET',
        url: `/wardrobe/insights?ownerId=${t.owner.id}`,
        headers: { cookie: viewerCookie },
      });
      expect(named.statusCode).toBe(404);
      expect(named.body).not.toContain('350.00');
      const cost = await get('/wardrobe/insights', viewerCookie);
      expect(cost).not.toContain('350.00');
      expect(cost).not.toContain('$15.00');
      const token = await createAccessToken(t, { cookie: viewerCookie });
      const stats = await tool<{ costPerWear: { closetValue: string } }>(
        t,
        token,
        'wardrobe_stats',
        {},
      );
      expect(stats.costPerWear.closetValue).toBe('0.00');
    });
  });
});
