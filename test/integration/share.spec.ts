import { desc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SharePermission, user, wardrobeShare } from '../../src/db/schema';
import {
  authorizeWardrobe,
  can,
  type Capability,
  managesWardrobeSql,
} from '../../src/web/sharing/access';
import { deviceToken } from './api';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  garmentsNamed,
} from './garments';
import { createTestApp, TEST_PASSWORD, TestApp, userIdOf } from './harness';
import { callTool, createAccessToken, mcpRequest, tool } from './mcp';

describe('wardrobe sharing', () => {
  let t: TestApp;
  let alice: { id: number; cookie: string };
  let bob: { id: number; cookie: string };

  const userId = async (email: string) => userIdOf(t, email);

  /**
   * Profile › Sharing's view link (the htmx form, answering the link) or
   * the edit link's step-up page (a native post with the password, #668,
   * landing on the section): the new invite's token, from its row.
   */
  const createInvite = async (
    cookie: string,
    permission: 'VIEW' | 'MANAGE',
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission, currentPassword: TEST_PASSWORD },
      headers:
        permission === 'VIEW' ? { cookie, 'hx-request': 'true' } : { cookie },
    });
    expect(res.statusCode).toBe(permission === 'VIEW' ? 200 : 302);
    const [row] = await t.db
      .select({ token: wardrobeShare.inviteToken })
      .from(wardrobeShare)
      .where(isNull(wardrobeShare.acceptedAt))
      .orderBy(desc(wardrobeShare.id))
      .limit(1);
    if (permission === 'VIEW') expect(res.body).toContain(row.token!);
    return row.token!;
  };

  const acceptInvite = async (cookie: string, token: string) => {
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    // Accepted lands on the grantor's wardrobe (#661); a refusal on
    // Profile › Sharing with ?shareError=.
    expect(res.headers.location).toBe(`/wardrobe?ownerId=${alice.id}`);
  };

  beforeAll(async () => {
    t = await createTestApp();
    alice = {
      cookie: await t.register('alice@example.com'),
      id: await userId('alice@example.com'),
    };
    bob = {
      cookie: await t.register('bob@example.com'),
      id: await userId('bob@example.com'),
    };
    await createGarment(t, { name: 'Alice coat', cookie: alice.cookie });
  });

  afterAll(() => t?.cleanup());

  it('a VIEW invite lets the grantee read but not write', async () => {
    const token = await createInvite(alice.cookie, 'VIEW');

    const landing = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${token}`,
    });
    expect(landing.statusCode).toBe(200);

    await acceptInvite(bob.cookie, token);

    const shared = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${alice.id}`,
      headers: { cookie: bob.cookie },
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.body).toContain('Alice coat');

    const own = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: bob.cookie },
    });
    expect(own.body).not.toContain('Alice coat');

    const write = await t.inject({
      method: 'POST',
      url: `/wardrobe?ownerId=${alice.id}`,
      payload: { name: 'Bob addition', category: 'shirt' },
      headers: { cookie: bob.cookie },
    });
    expect(write.statusCode).toBe(403);
    expect(await garmentsNamed(t, 'Bob addition')).toBe(0);
  });

  it('a MANAGE invite upgrades the share and lets the grantee create', async () => {
    const token = await createInvite(alice.cookie, 'MANAGE');
    await acceptInvite(bob.cookie, token);

    const garmentId = await createGarment(t, {
      name: 'Bob addition',
      cookie: bob.cookie,
      ownerId: alice.id,
    });
    expect((await garmentRow(t, garmentId))?.ownerId).toBe(alice.id);

    const grid = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${alice.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(grid.body).toContain('Bob addition');
  });

  // #680: one scope, two forms. A batched read (the feed's garments) asks
  // managesWardrobeSql per row; everything else asks the resolver's role.
  // The SQL form answers `manage`, `launder` and `private` alike, and
  // nothing where the resolver sees no wardrobe.
  it('answers managesWardrobeSql as the resolver answers manage, launder and private', async () => {
    const owner = alice.id;
    const actor = async (
      role: SharePermission | 'none',
    ): Promise<{ role: SharePermission | 'OWN' | 'none'; id: number }> => {
      const email = `scope-${role.toLowerCase()}@example.com`;
      await t.register(email);
      const id = await userId(email);
      if (role !== 'none') {
        await t.db.insert(wardrobeShare).values({
          grantorId: owner,
          granteeId: id,
          permission: role,
          acceptedAt: new Date(),
          createdAt: new Date(),
        });
      }
      return { role, id };
    };
    const actors = [
      { role: 'OWN' as const, id: owner },
      await actor('MANAGE'),
      await actor('VIEW'),
      await actor('none'),
    ];
    const capabilities: Capability[] = ['manage', 'launder', 'private'];
    for (const { role, id } of actors) {
      const [{ manages }] = await t.db
        .select({ manages: managesWardrobeSql(user.id, id) })
        .from(user)
        .where(eq(user.id, owner));
      const resolved = authorizeWardrobe(
        t.db,
        { userId: id, surface: 'page' },
        owner,
        'view',
        'wardrobe',
      );
      if (role === 'none') {
        await expect(resolved).rejects.toMatchObject({ statusCode: 404 });
        expect(manages, role).toBe(false);
        continue;
      }
      const { access } = await resolved;
      expect(access.role).toBe(role);
      for (const capability of capabilities) {
        expect(manages, `${role} ${capability}`).toBe(can(role, capability));
      }
    }
  });

  // #680, owner decision 2026-11-25: a garment's price and notes are the
  // `private` capability's. One garment and one wishlist item carry
  // sentinels; every reader a grantee reaches is asked by the owner, a
  // MANAGE grantee (both fields) and a VIEW grantee (neither, and its
  // keyword search never matches the notes). The changes feed's case is
  // api-changes.spec.ts's.
  describe('price and notes', () => {
    const PRICE = '987.65';
    const NOTES = 'Zanzibar stitching';
    const LISTED = '123.45';
    let owner: number;
    let garmentId: number;
    const readers: Record<
      'OWN' | 'MANAGE' | 'VIEW',
      { cookie: string; device: string; agent: string }
    > = {} as never;

    beforeAll(async () => {
      const email = 'private-owner@example.com';
      const ownerCookie = await t.register(email);
      owner = await userId(email);
      const created = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          name: 'Private coat',
          category: 'outerwear',
          notes: NOTES,
          product: '1',
          price: PRICE,
          sourceUrl: '',
        },
        headers: { cookie: ownerCookie },
      });
      expect(created.statusCode).toBe(302);
      garmentId = Number(
        /^\/wardrobe\/(\d+)/.exec(created.headers.location!)![1],
      );
      await createWishlistItem(t, {
        name: 'Private wish',
        cookie: ownerCookie,
        price: LISTED,
      });
      const reader = async (email: string, cookie: string) => ({
        cookie,
        device: (await deviceToken(t, { email })).token,
        agent: await createAccessToken(t, { cookie }),
      });
      readers.OWN = await reader(email, ownerCookie);
      for (const permission of ['MANAGE', 'VIEW'] as const) {
        const grantee = `private-${permission.toLowerCase()}@example.com`;
        const cookie = await t.register(grantee);
        await t.db.insert(wardrobeShare).values({
          grantorId: owner,
          granteeId: await userId(grantee),
          permission,
          acceptedAt: new Date(),
          createdAt: new Date(),
        });
        readers[permission] = await reader(grantee, cookie);
      }
    });

    /** Every answer `role` gets that could carry the fields, as text. */
    async function answers(role: 'OWN' | 'MANAGE' | 'VIEW') {
      const { cookie, device, agent } = readers[role];
      const page = (url: string) =>
        t.inject({ method: 'GET', url, headers: { cookie } });
      const api = (url: string) =>
        t.api(device, { method: 'GET', url: `/api/v1${url}` });
      const all = await Promise.all([
        page(`/wardrobe/${garmentId}?ownerId=${owner}`),
        page(`/wardrobe/wishlist?ownerId=${owner}`),
        api(`/garments/${garmentId}?ownerId=${owner}`),
        api(`/garments?ownerId=${owner}`),
        api(`/wishlist?ownerId=${owner}`),
      ]);
      for (const res of all) expect(res.statusCode, res.body).toBe(200);
      const mcp = await Promise.all([
        tool(t, agent, 'get_garment', { id: garmentId, ownerId: owner }),
        tool(t, agent, 'search_garments', { ownerId: owner }),
        tool(t, agent, 'list_wishlist', { ownerId: owner }),
      ]);
      return {
        page: all.slice(0, 2).map((res) => res.body),
        json: [
          ...all.slice(2).map((res) => res.body),
          ...mcp.map((answer) => JSON.stringify(answer)),
        ],
      };
    }

    it('reach the owner and a MANAGE grantee on every surface', async () => {
      for (const role of ['OWN', 'MANAGE'] as const) {
        const { page, json } = await answers(role);
        expect(page[0], role).toContain(`$${PRICE}`);
        expect(page[0], role).toContain(NOTES);
        expect(page[1], role).toContain(`$${LISTED}`);
        // The detail, the list, the wishlist; get_garment, the search, the wishlist.
        for (const [i, text] of json.entries()) {
          expect(text, `${role} ${i}`).toContain(i % 3 === 2 ? LISTED : PRICE);
        }
        expect(json[0], role).toContain(NOTES);
        expect(json[3], role).toContain(NOTES);
      }
    });

    it('never reach a VIEW grantee: absent, not null', async () => {
      const { page, json } = await answers('VIEW');
      for (const text of [...page, ...json]) {
        expect(text).toContain('Private');
        expect(text).not.toContain(PRICE);
        expect(text).not.toContain(LISTED);
        expect(text).not.toContain(NOTES);
      }
      const detail = JSON.parse(json[0]) as Record<string, unknown>;
      expect(detail).not.toHaveProperty('price');
      expect(detail).not.toHaveProperty('notes');
      const agent = JSON.parse(json[3]) as Record<string, unknown>;
      expect(agent).not.toHaveProperty('price');
      expect(agent).not.toHaveProperty('notes');
    });

    // Every read-only tool that addresses a wardrobe, asked of the shared
    // one (with the garment's id where it takes one): a tool added later is
    // held too, whatever its reader (guards.conf @garment-private's
    // comment says what text cannot see).
    it('no read-only MCP tool answers a VIEW grantee them', async () => {
      const { agent } = readers.VIEW;
      const listed = await mcpRequest(t, agent, 'tools/list');
      expect(listed.statusCode).toBe(200);
      const { tools } = listed.json<{
        result: {
          tools: {
            name: string;
            inputSchema: { properties?: Record<string, unknown> };
            annotations?: { readOnlyHint?: boolean };
          }[];
        };
      }>().result;
      const asked = tools.filter(
        (one) =>
          one.annotations?.readOnlyHint === true &&
          one.inputSchema.properties?.ownerId !== undefined,
      );
      let answered = 0;
      for (const { name, inputSchema } of asked) {
        const args: Record<string, unknown> = { ownerId: owner };
        if (inputSchema.properties?.id !== undefined) args.id = garmentId;
        const { value, isError } = await callTool(t, agent, name, args);
        const text = JSON.stringify(value);
        expect(text, name).not.toContain(PRICE);
        expect(text, name).not.toContain(LISTED);
        expect(text, name).not.toContain(NOTES);
        if (!isError) answered += 1;
      }
      // get_garment, get_wardrobe, search_garments, list_wishlist at least.
      expect(answered).toBeGreaterThanOrEqual(4);
    });

    it("a VIEW grantee's keyword search ignores the notes, silently", async () => {
      const found = async (role: 'OWN' | 'MANAGE' | 'VIEW') => {
        const { cookie, device, agent } = readers[role];
        const grid = await t.inject({
          method: 'GET',
          url: `/wardrobe?ownerId=${owner}&keyword=zanzibar`,
          headers: { cookie },
        });
        expect(grid.statusCode).toBe(200);
        const list = await t.api(device, {
          method: 'GET',
          url: `/api/v1/garments?ownerId=${owner}&keyword=zanzibar`,
        });
        expect(list.statusCode).toBe(200);
        const search = await tool<{ total: number }>(
          t,
          agent,
          'search_garments',
          { ownerId: owner, keyword: 'zanzibar' },
        );
        return [
          grid.body.includes('Private coat'),
          list.body.includes('Private coat'),
          search.total > 0,
        ];
      };
      expect(await found('OWN')).toEqual([true, true, true]);
      expect(await found('MANAGE')).toEqual([true, true, true]);
      expect(await found('VIEW')).toEqual([false, false, false]);
    });

    it("a VIEW grantee's clone starts without them", async () => {
      const { device } = readers.VIEW;
      const res = await t.api(device, {
        method: 'POST',
        url: `/api/v1/garments/${garmentId}/clones?ownerId=${owner}`,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(201);
      const clone = await garmentRow(t, res.json<{ id: number }>().id);
      expect(clone).toMatchObject({ price: null, notes: null });
    });
  });
});
