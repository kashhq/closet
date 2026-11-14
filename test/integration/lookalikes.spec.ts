import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { acceptInvite, createInvite } from '../../src/web/sharing/queries';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import {
  expectAutosaveControls,
  expectFragment,
  expectNativePostForms,
  HX_FRAGMENT,
} from './pages';

/**
 * The duplicate check (#20; docs/plans/2026-09-26-wardrobe-features.md,
 * section 18): the garment form, when it adds to the closet, names the
 * closet garments it looks like (18b's nearDuplicates with sameBrand,
 * unit-tested in src/wardrobe/goes-with.spec.ts) and offers "Add a copy"
 * (POST /wardrobe/:id/copies) instead; "Not the same" keeps a list the
 * refresh sends. It never blocks a save. The grantee and stranger rows are
 * in authorization-wardrobe.spec.ts, the MCP side in mcp.spec.ts.
 */

type Fields = Record<string, string | string[]>;

/** The ids the region lists, in order. */
function matchesIn(html: string): number[] {
  return [...html.matchAll(/data-lookalike="(\d+)"/g)].map((m) => Number(m[1]));
}

describe('the duplicate check', () => {
  let t: TestApp;
  let whiteTee: number;
  let greyTop: number;
  let fullTee: number;
  let archivedTee: number;
  let wishedTee: number;
  let manager: { cookie: string; id: number };

  const post = (url: string, payload: Fields, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });
  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  const idOf = (location: unknown) =>
    Number(/^\/wardrobe\/(\d+)/.exec(String(location))![1]);

  const add = async (name: string, fields: Fields): Promise<number> => {
    const res = await post('/wardrobe', { name, props: '1', ...fields });
    expect(res.statusCode, res.body).toBe(302);
    return idOf(res.headers.location);
  };

  const quantityOf = async (id: number) => {
    const [row] = await t.db
      .select({ quantity: garment.quantity })
      .from(garment)
      .where(eq(garment.id, id));
    return row.quantity;
  };

  const check = (query: string, cookie?: string) =>
    t.inject({
      method: 'GET',
      url: `/wardrobe/lookalikes?${query}`,
      headers: { ...HX_FRAGMENT, ...(cookie ? { cookie } : {}) },
    });

  const tee = { category: 'tops', type: 't-shirt', color: 'white' };

  beforeAll(async () => {
    t = await createTestApp();
    whiteTee = await add('White tee', { ...tee, brand: 'Uniqlo' });
    greyTop = await add('Grey top', { category: 'tops', color: 'grey' });
    fullTee = await add('Black tees', {
      category: 'tops',
      type: 't-shirt',
      color: 'black',
      care: '1',
      quantity: '30',
    });
    archivedTee = await add('Old white tee', tee);
    expect(
      (await post(`/wardrobe/${archivedTee}/archive`, {})).statusCode,
    ).toBeLessThan(400);
    wishedTee = await add('Wished white tee', {
      ...tee,
      to: 'wishlist',
      wishlist: '1',
      replaces: '',
    });
    const cookie = await t.register('manager@example.com');
    manager = { cookie, id: await userIdOf(t, 'manager@example.com') };
    const invite = await createInvite(t.db, t.owner.id, 'MANAGE');
    expect(
      (await acceptInvite(t.db, invite.inviteToken, manager.id)).accepted,
    ).toBe(true);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it('puts the region and its copy form on the new garment form, empty until it is filled in', async () => {
    const res = await get('/wardrobe/new');
    expect(res.statusCode).toBe(200);
    expectNativePostForms(res);
    expectAutosaveControls(res);
    const body = unescapeHtml(res.body);
    expect(body).toContain('id="garment-lookalikes"');
    expect(body).toContain('hx-get="/wardrobe/lookalikes"');
    expect(body).toContain('id="garment-lookalike-copy"');
    expect(matchesIn(body)).toEqual([]);
    // The copy form comes after the garment form: its buttons are never
    // the garment form's default button.
    const saveForm = body.indexOf('action="/wardrobe"');
    expect(body.indexOf('id="garment-lookalike-copy"')).toBeGreaterThan(
      body.indexOf('</form>', saveForm),
    );
  });

  it('lists the closet garments of the same kind and colours, never archived or wishlist ones', async () => {
    const res = await check('category=Tops&type=t-shirt&color=white');
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    const body = unescapeHtml(res.body);
    expect(matchesIn(body)).toEqual([whiteTee]);
    expect(body).toContain(`formaction="/wardrobe/${whiteTee}/copies"`);
    expect(body).toContain('form="garment-lookalike-copy"');
  });

  it('matches a brand however it is spelled, or a blank one, but not another brand', async () => {
    const same = await check(
      'category=tops&type=t-shirt&color=white&brand=UNIQLO%20',
    );
    expect(matchesIn(same.body)).toEqual([whiteTee]);
    const other = await check(
      'category=tops&type=t-shirt&color=white&brand=Hanes',
    );
    expect(matchesIn(other.body)).toEqual([]);
    // Another colour set, or none, is not a match.
    const twoColours = await check(
      'category=tops&type=t-shirt&color=white&color=black',
    );
    expect(matchesIn(twoColours.body)).toEqual([]);
    const none = await check('category=tops&type=t-shirt');
    expect(matchesIn(none.body)).toEqual([]);
  });

  it('reads a type of another category as none, as the save does', async () => {
    const res = await check('category=tops&type=jeans&color=grey');
    expect(matchesIn(res.body)).toEqual([greyTop]);
  });

  it('offers no copy of a garment at the most copies', async () => {
    const body = unescapeHtml(
      (await check('category=tops&type=t-shirt&color=black')).body,
    );
    expect(matchesIn(body)).toEqual([fullTee]);
    expect(body).not.toContain(`/wardrobe/${fullTee}/copies`);
  });

  it('keeps dismissed matches away, and "Not the same" adds the ones shown', async () => {
    const shown = unescapeHtml(
      (
        await check(
          'category=tops&type=t-shirt&color=white&lookalikesDismissed=999',
        )
      ).body,
    );
    expect(shown).toContain('name="lookalikesDismissed" value="999"');
    expect(shown).toContain(`{"lookalikesDismissed":"999,${whiteTee}"}`);
    const dismissed = unescapeHtml(
      (
        await check(
          `category=tops&type=t-shirt&color=white&lookalikesDismissed=999,${whiteTee}`,
        )
      ).body,
    );
    expect(matchesIn(dismissed)).toEqual([]);
    expect(dismissed).not.toContain('data-lookalikes=');
    expect(dismissed).toContain(
      `name="lookalikesDismissed" value="999,${whiteTee}"`,
    );
    // Malformed ids are navigation state: dropped, not a 400.
    const junk = await check(
      'category=tops&type=t-shirt&color=white&lookalikesDismissed=x,-3,,',
    );
    expect(junk.statusCode).toBe(200);
    expect(matchesIn(junk.body)).toEqual([whiteTee]);
  });

  it('renders the matches with a clone, and none on an edit or a wishlist form', async () => {
    const clone = unescapeHtml((await get(`/wardrobe/${whiteTee}/clone`)).body);
    expect(matchesIn(clone)).toEqual([whiteTee]);
    const edit = unescapeHtml((await get(`/wardrobe/${whiteTee}/edit`)).body);
    expect(edit).not.toContain('id="garment-lookalikes"');
    const wishlist = unescapeHtml(
      (await get('/wardrobe/new?to=wishlist')).body,
    );
    expect(wishlist).not.toContain('id="garment-lookalikes"');
    // A wishlist item's clone lands on the wishlist.
    const wishClone = unescapeHtml(
      (await get(`/wardrobe/${wishedTee}/clone`)).body,
    );
    expect(wishClone).not.toContain('id="garment-lookalikes"');
  });

  it('never blocks a save, and a refused save keeps what was dismissed', async () => {
    const refused = await post('/wardrobe', {
      name: 'Another white tee',
      props: '1',
      product: '1',
      price: 'lots',
      lookalikesDismissed: String(whiteTee),
      ...tee,
    });
    expect(refused.statusCode).toBe(400);
    const body = unescapeHtml(refused.body);
    expect(matchesIn(body)).toEqual([]);
    expect(body).toContain(`name="lookalikesDismissed" value="${whiteTee}"`);
    const saved = await add('Another white tee', tee);
    expect(saved).toBeGreaterThan(whiteTee);
    await post(`/wardrobe/${saved}/archive`, {});
  });

  it('"Add a copy" adds one to the garment, writing nothing else', async () => {
    const before = await t.db.$count(garment);
    const res = await post(`/wardrobe/${whiteTee}/copies`, {});
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/wardrobe/${whiteTee}?copyAdded=1`);
    expect(await quantityOf(whiteTee)).toBe(2);
    expect(await t.db.$count(garment)).toBe(before);
    expect(t.logs.ops('garment.copies.added')).toContainEqual(
      expect.objectContaining({ garmentId: whiteTee, from: 1, to: 2 }),
    );
    const page = await get(`/wardrobe/${whiteTee}?copyAdded=1`);
    expect(page.body).toContain('id="copy-added-toast"');
    // The region now says how many there are.
    const region = await check('category=tops&type=t-shirt&color=white');
    expect(region.body).toContain('2 copies');
  });

  it('refuses a copy of a garment not in the closet, past the most copies, or not in the wardrobe', async () => {
    for (const id of [archivedTee, wishedTee]) {
      const res = await post(`/wardrobe/${id}/copies`, {});
      expect(res.statusCode).toBe(409);
      expect(await quantityOf(id)).toBe(1);
    }
    const full = await post(`/wardrobe/${fullTee}/copies`, {});
    expect(full.statusCode).toBe(409);
    expect(await quantityOf(fullTee)).toBe(30);
    const missing = await post('/wardrobe/2147483647/copies', {});
    expect(missing.statusCode).toBe(404);
  });

  it('works for a MANAGE grantee in the shared wardrobe', async () => {
    const form = unescapeHtml(
      (await get(`/wardrobe/new?ownerId=${t.owner.id}`, manager.cookie)).body,
    );
    expect(form).toContain(
      `hx-get="/wardrobe/lookalikes?ownerId=${t.owner.id}"`,
    );
    const region = unescapeHtml(
      (
        await check(
          `ownerId=${t.owner.id}&category=tops&type=t-shirt&color=white`,
          manager.cookie,
        )
      ).body,
    );
    expect(matchesIn(region)).toEqual([whiteTee]);
    expect(region).toContain(
      `formaction="/wardrobe/${whiteTee}/copies?ownerId=${t.owner.id}"`,
    );
    const before = await quantityOf(whiteTee);
    const res = await post(
      `/wardrobe/${whiteTee}/copies?ownerId=${t.owner.id}`,
      {},
      manager.cookie,
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(
      `/wardrobe/${whiteTee}?copyAdded=1&ownerId=${t.owner.id}`,
    );
    expect(await quantityOf(whiteTee)).toBe(before + 1);
    // Their own closet is empty: nothing matches there.
    const own = await check(
      'category=tops&type=t-shirt&color=white',
      manager.cookie,
    );
    expect(matchesIn(own.body)).toEqual([]);
  });
});
