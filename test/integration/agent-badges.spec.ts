import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, startOfWeek } from '../../src/calendar-date';
import { garment, user, wardrobeShare } from '../../src/db/schema';
import { deviceToken } from './api';
import { createGarment } from './garments';
import {
  asFixture,
  createTestApp,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { createAccessToken, tool } from './mcp';
import { createTrip } from '../../src/web/trips/queries';

/**
 * What the agent did is visible in the app (#822): the badge on a calendar
 * entry, a trip's outfit, an outfit's tile and page, and a garment's page
 * and wishlist card carries the viewer's label (agentLabelSql); what a
 * person made has none.
 */
describe('agent badges (#822)', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let device: string;
  let tripId: number;
  const g: Record<string, number> = {};
  const day = (n: number) => addDays(t.today(), n);

  /** The badge names a page shows, in document order. */
  async function badges(url: string, cookie?: string): Promise<string[]> {
    const res = await t.inject({
      method: 'GET',
      url,
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode, url).toBe(200);
    return [...unescapeHtml(res.body).matchAll(/data-agent="([^"]*)"/g)].map(
      (match) => match[1],
    );
  }

  async function ownOutfit(garmentIds: number[]): Promise<number> {
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/outfits',
      payload: {
        slots: garmentIds.map((garmentId) => ({ category: 'tops', garmentId })),
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<{ id: number }>().id;
  }

  const weekOf = (on: string) => `/calendar?week=${startOfWeek(on)}`;

  beforeAll(async () => {
    sites = await startLinkSites();
    sites.serve('/img/tee.jpg', jpeg(await productShot('#223355')));
    sites.serve(
      '/products/tee',
      html(`<!doctype html><html><head><title>Pocket Tee</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Heavyweight Pocket Tee',
        image: [sites.url('/img/tee.jpg')],
        offers: { price: '48.00', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    for (const key of ['top1', 'bottom1', 'top2', 'bottom2', 'top3']) {
      g[key] = await createGarment(t, {
        name: key,
        category: key.startsWith('top') ? 'tops' : 'bottoms',
      });
    }
    token = await createAccessToken(t, { name: 'Laptop Claude' });
    device = (await deviceToken(t)).token;
    tripId = await asFixture(t.db, (tx) =>
      createTrip(tx, t.owner.id, {
        name: 'Austin',
        destination: null,
        startsOn: day(10),
        endsOn: day(12),
        notes: null,
      }),
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('badges a scheduled entry with the token name, never a hand-made one', async () => {
    const agents = await ownOutfit([g.top1, g.bottom1]);
    await tool(t, token, 'schedule_outfit', { outfitId: agents, date: day(1) });
    const mine = await ownOutfit([g.top2, g.bottom2]);
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/calendar-entries',
      payload: { outfitId: mine, day: day(30) },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await badges(weekOf(day(1)))).toEqual(['Laptop Claude']);
    expect(await badges(weekOf(day(30)))).toEqual([]);
  });

  it('badges what an agent made: a trip outfit, an outfit, a wishlist garment', async () => {
    const idea = await tool<{ outfitId: number }>(
      t,
      token,
      'plan_trip_outfit',
      { tripId, garmentIds: [g.top3, g.bottom1] },
    );
    expect(await badges(`/trips/${tripId}`)).toEqual(['Laptop Claude']);
    expect(await badges(`/outfits/${idea.outfitId}`)).toEqual([
      'Laptop Claude',
    ]);
    expect(await badges('/outfits?show=one-offs')).toContain('Laptop Claude');

    const added = await tool<{ garment: { id: number } }>(
      t,
      token,
      'add_garment_from_link',
      { url: sites.url('/products/tee') },
    );
    expect(await badges('/wardrobe/wishlist')).toEqual(['Laptop Claude']);
    expect(await badges(`/wardrobe/${added.garment.id}`)).toEqual([
      'Laptop Claude',
    ]);
  });

  it('shows a grantee agent by its token to its author, by first name to the owner, as Agent to others', async () => {
    const share = async (email: string) => {
      const cookie = await t.register(email);
      const granteeId = await userIdOf(t, email);
      await t.db.insert(wardrobeShare).values({
        grantorId: t.owner.id,
        granteeId,
        permission: email.startsWith('dana') ? 'MANAGE' : 'VIEW',
        inviteToken: randomUUID(),
        createdAt: new Date(),
        acceptedAt: new Date(),
      });
      return { cookie, granteeId };
    };
    const dana = await share('dana@example.com');
    await t.db
      .update(user)
      .set({ firstName: 'Dana' })
      .where(eq(user.id, dana.granteeId));
    const sam = await share('sam@example.com');
    const danaToken = await createAccessToken(t, {
      cookie: dana.cookie,
      name: 'Dana’s laptop',
    });
    const added = await tool<{ garment: { id: number } }>(
      t,
      danaToken,
      'add_garment_from_link',
      { url: sites.url('/products/tee'), ownerId: t.owner.id },
    );
    const page = `/wardrobe/${added.garment.id}?ownerId=${t.owner.id}`;
    expect(await badges(page)).toEqual(['Dana’s agent']);
    expect(await badges(page, dana.cookie)).toEqual(['Dana’s laptop']);
    expect(await badges(page, sam.cookie)).toEqual(['Agent']);
  });
  it("shows Today's card the badge of an agent's entry", async () => {
    const own = await ownOutfit([g.top2, g.bottom1]);
    await tool(t, token, 'schedule_outfit', { outfitId: own, date: day(0) });
    expect(await badges('/')).toEqual(['Laptop Claude']);
  });

  it("leaves the agent’s rows to their own 'From the agent': no badge on a suggested garment or a proposed outfit", async () => {
    const added = await tool<{ garment: { id: number } }>(
      t,
      token,
      'add_garment_from_link',
      { url: sites.url('/products/tee') },
    );
    const before = await badges('/wardrobe/wishlist');
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ suggestedAt: new Date() })
        .where(eq(garment.id, added.garment.id)),
    );
    expect(await badges('/wardrobe/wishlist')).toHaveLength(before.length - 1);
    expect(await badges(`/wardrobe/${added.garment.id}`)).toEqual([]);

    const proposed = await tool<{ id: number }>(t, token, 'suggest_outfit', {
      garmentIds: [g.top3, g.bottom2],
      note: 'Weekend',
    });
    expect(await badges(`/outfits/${proposed.id}`)).toEqual([]);
  });
});
