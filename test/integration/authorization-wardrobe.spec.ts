import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { garmentWear } from '../../src/db/schema';
import { describeMatrix } from './authorization-matrix';
import { unescapeHtml } from './harness';
import { ROUTES } from './authorization-wardrobe.routes';

describeMatrix('wardrobe', ROUTES, (m) => {
  // The page offers what the routes allow: clone to anyone who can see the
  // garment, edit (and condition) and the wear section (Wore today, Washed:
  // #680) to the owner and a MANAGE grantee, archive, delete and where it
  // is to the owner only.
  it.each([
    ['owner', { clone: true, edit: true, wear: true, remove: true }],
    ['manager', { clone: true, edit: true, wear: true, remove: false }],
    ['viewer', { clone: true, edit: false, wear: false, remove: false }],
  ] as const)(
    'the garment page shows %s the actions they may take',
    async (actor, can) => {
      const q = `?ownerId=${m.actors.owner.id}`;
      const res = await m.t.inject({
        method: 'GET',
        url: `/wardrobe/${m.shared.garmentId}${q}`,
        headers: { cookie: m.actors[actor].cookie },
      });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      const id = m.shared.garmentId;
      expect(html.includes(`href="/wardrobe/${id}/clone`)).toBe(can.clone);
      expect(html.includes(`href="/wardrobe/${id}/edit`)).toBe(can.edit);
      expect(html.includes('name="photo"')).toBe(can.edit);
      expect(html.includes(`hx-delete="/wardrobe/${id}`)).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/archive`)).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/condition`)).toBe(can.edit);
      expect(html.includes('id="garment-wear"')).toBe(can.wear);
      // Into the wardrobe the page is of: the owner's links carry no ?ownerId=.
      expect(html.includes(`action="/wardrobe/${id}/wear${q}"`)).toBe(
        can.wear && actor !== 'owner',
      );
      expect(html.includes(`action="/wardrobe/${id}/wear"`)).toBe(
        actor === 'owner',
      );
      expect(html.includes('id="garment-away"')).toBe(can.remove);
    },
  );

  // "Goes with my closet" (#18b) judges a wishlist item against the owner's
  // closet and clashes: the owner's alone, like ideas, though every grantee
  // reads the item itself (mcp-seed.spec.ts refuses goes_with_closet to a
  // grantee's token).
  it.each([
    ['owner', true],
    ['manager', false],
    ['viewer', false],
  ] as const)(
    'a wishlist item’s page shows %s "Goes with my closet": %s',
    async (actor, shown) => {
      const res = await m.t.inject({
        method: 'GET',
        url: `/wardrobe/${m.shared.wishlistId}?ownerId=${m.actors.owner.id}`,
        headers: { cookie: m.actors[actor].cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(m.shared.wishlistName);
      expect(res.body.includes('id="goes-with"')).toBe(shown);
    },
  );

  // Its API read (#194b) likewise: a grantee naming the owner is a 403,
  // without ?ownerId= the item is not in their wardrobe (a 404), and
  // neither answer judges the owner's closet.
  it("GET /api/v1/garments/:id/goes-with is the owner's alone", async () => {
    const url = `/api/v1/garments/${m.shared.wishlistId}/goes-with`;
    const named = `${url}?ownerId=${m.actors.owner.id}`;
    const owner = await m.t.api(m.actors.owner.token, { method: 'GET', url });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ pairsWith: expect.any(Array) });
    const ownNamed = await m.t.api(m.actors.owner.token, {
      method: 'GET',
      url: named,
    });
    expect(ownNamed.statusCode).toBe(200);
    for (const actor of ['manager', 'viewer', 'stranger'] as const) {
      const { token } = m.actors[actor];
      const own = await m.t.api(token, { method: 'GET', url });
      const shared = await m.t.api(token, { method: 'GET', url: named });
      expect([own.statusCode, shared.statusCode], actor).toEqual(
        actor === 'stranger' ? [404, 404] : [404, 403],
      );
      expect(shared.body).not.toContain('pairsWith');
    }
    // A closet garment is no wishlist item: the owner's 404 too.
    const closet = await m.t.api(m.actors.owner.token, {
      method: 'GET',
      url: `/api/v1/garments/${m.shared.garmentId}/goes-with`,
    });
    expect(closet.statusCode).toBe(404);
  });

  // The wear's undo (#193a) is wearGarment behind the same guard as its
  // PUT, so it answers as the PUT's matrix cases do; its own case needs a
  // wear to undo, which the shared fixture must not have
  // (authorization-coverage.spec.ts, EXEMPT): the MANAGE partner's undo
  // (#680) takes it off again.
  it('DELETE /api/v1/garments/:id/wears/:day answers as its PUT does', async () => {
    const { garmentId, today } = m.shared;
    const url = `/api/v1/garments/${garmentId}/wears/${today}`;
    const owner = m.actors.owner.token!;
    const wearsOf = () =>
      m.t.db.$count(garmentWear, eq(garmentWear.garmentId, garmentId));
    const worn = await m.t.api(owner, { method: 'PUT', url });
    expect(worn.json()).toMatchObject({ worn: true, changed: true });
    const before = await wearsOf();
    for (const actor of ['viewer', 'stranger'] as const) {
      const token = m.actors[actor].token!;
      const own = await m.t.api(token, { method: 'DELETE', url });
      const named = await m.t.api(token, {
        method: 'DELETE',
        url: `${url}?ownerId=${m.actors.owner.id}`,
      });
      expect([own.statusCode, named.statusCode], actor).toEqual(
        actor === 'stranger' ? [404, 404] : [404, 403],
      );
      expect(named.body).not.toContain(m.shared.garmentName);
    }
    expect(await wearsOf()).toBe(before);
    const manager = m.actors.manager.token!;
    const own = await m.t.api(manager, { method: 'DELETE', url });
    expect(own.statusCode).toBe(404);
    const undone = await m.t.api(manager, {
      method: 'DELETE',
      url: `${url}?ownerId=${m.actors.owner.id}`,
    });
    expect(undone.json()).toMatchObject({ worn: false, changed: true });
    expect(await wearsOf()).toBe(before - 1);
  });
});
