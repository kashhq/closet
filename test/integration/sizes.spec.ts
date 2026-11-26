import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodyMeasurements, brandSize } from '../../src/db/schema';
import { createGarment, createWishlistItem } from './garments';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { html, type LinkSites, startLinkSites } from './link-sites';
import { createAccessToken, tool } from './mcp';
import { expectFragment } from './pages';

/**
 * Sizes (#24; plan section 16): measurements stored in cm and shown in the
 * person's unit, one note per brand whatever the case, the brand's note on
 * the garment form (the link import's too) and the wishlist, get_sizes, and
 * the owner-only rule: a grantee of a shared wardrobe never reads or writes
 * another's sizes, and the shared wardrobe's pages show no note at all.
 */

const HINT = 'id="brand-size-hint"';
const HINT_TRIGGER = 'hx-get="/auth/profile/sizes/hint"';
const UNIQLO_NOTE = 'Your size in Uniqlo: Medium · Runs big';

describe('sizes', () => {
  let t: TestApp;
  let sites: LinkSites;
  let ownerId: number;
  let viewer: string;
  let manager: string;
  /** The owner's: a Uniqlo tee in the closet and a Uniqlo sweater on the wishlist. */
  let tee: number;
  let sweater: number;

  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (
    url: string,
    payload: Record<string, unknown> = {},
    cookie?: string,
  ) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });
  const measurementsOf = async (userId: number) =>
    (
      await t.db
        .select()
        .from(bodyMeasurements)
        .where(eq(bodyMeasurements.userId, userId))
    )[0];
  const brandsOf = (userId: number) =>
    t.db
      .select({
        id: brandSize.id,
        brand: brandSize.brand,
        size: brandSize.size,
        note: brandSize.note,
      })
      .from(brandSize)
      .where(eq(brandSize.userId, userId))
      .orderBy(brandSize.id);
  const share = async (permission: 'VIEW' | 'MANAGE', cookie: string) => {
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission, currentPassword: TEST_PASSWORD },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    await post(`/wardrobe-share/invite/${token}/accept`, {}, cookie);
  };
  const EMPTY_MEASUREMENTS = {
    unit: 'in',
    height: '',
    neck: '',
    shoulders: '',
    chest: '',
    sleeve: '',
    waist: '',
    hips: '',
    inseam: '',
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    sites.serve(
      '/products/oxford',
      html(`<!doctype html><html><head><title>Oxford</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Oxford Shirt',
        brand: { '@type': 'Brand', name: 'UNIQLO' },
        offers: { price: '39.90', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    ownerId = await userIdOf(t, 'owner@example.com');
    tee = await createGarment(t, {
      name: 'White tee',
      category: 'tops',
      brand: 'Uniqlo',
    });
    sweater = await createWishlistItem(t, {
      name: 'Merino crew',
      brand: 'uniqlo ',
    });
    viewer = await t.register('viewer-sizes@example.com');
    manager = await t.register('manager-sizes@example.com');
    await share('VIEW', viewer);
    await share('MANAGE', manager);
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  describe('measurements', () => {
    it('is a row on Profile, the editor a tap away (#728)', async () => {
      const profile = await get('/auth/profile');
      expect(profile.statusCode).toBe(200);
      expect(profile.body).toContain(
        '<li id="sizes"><a href="/auth/profile/sizes"',
      );
      const editor = await get('/auth/profile/sizes');
      expect(editor.statusCode).toBe(200);
      // Inches until the person chooses, as the migration's default says.
      expect(editor.body).toContain('name="unit" value="in"');
      expect(editor.body).toContain('href="/auth/profile#sizes"');
    });

    it('stores lengths in cm, typed and shown in the unit', async () => {
      const res = await post('/auth/profile/sizes/measurements', {
        ...EMPTY_MEASUREMENTS,
        waist: '32',
        inseam: '32.25',
        neck: '15,5',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        '/auth/profile/sizes?saved=measurements',
      );
      expect(await measurementsOf(ownerId)).toMatchObject({
        unit: 'in',
        waistCm: 81.28,
        inseamCm: 81.92,
        neckCm: 39.37,
        heightCm: null,
      });
      const editor = await get('/auth/profile/sizes?saved=measurements');
      expect(editor.body).toContain('Measurements saved');
      expect(editor.body).toMatch(/name="waist" value="32"/);
    });

    it('switches the unit without moving a length that is saved unchanged', async () => {
      const switched = await post('/auth/profile/sizes/unit', { unit: 'cm' });
      expect(switched.statusCode).toBe(303);
      expect((await measurementsOf(ownerId)).unit).toBe('cm');
      const editor = await get('/auth/profile/sizes');
      // 81.28 cm is shown to one decimal: 81.3.
      expect(editor.body).toMatch(/name="waist" value="81.3"/);
      expect(editor.body).toContain('name="unit" value="cm"');
      await post('/auth/profile/sizes/measurements', {
        ...EMPTY_MEASUREMENTS,
        unit: 'cm',
        waist: '81.3',
        inseam: '81.9',
        neck: '39.4',
        height: '178',
      });
      // Saved as shown, the stored lengths stay where inches put them.
      expect(await measurementsOf(ownerId)).toMatchObject({
        waistCm: 81.28,
        inseamCm: 81.92,
        neckCm: 39.37,
        heightCm: 178,
      });
      await post('/auth/profile/sizes/unit', { unit: 'in' });
      const back = await get('/auth/profile/sizes');
      expect(back.body).toMatch(/name="waist" value="32"/);
      expect(back.body).toMatch(/name="inseam" value="32.25"/);
    });

    it('refuses what is not a length, keeps what was typed, and stores nothing', async () => {
      const before = await measurementsOf(ownerId);
      const res = await post('/auth/profile/sizes/measurements', {
        ...EMPTY_MEASUREMENTS,
        waist: 'thirty',
        chest: '500',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Enter a number, like 32 or 32.5.');
      expect(res.body).toContain('Enter a length from 1 to 118 in.');
      expect(res.body).toMatch(/name="waist" value="thirty"/);
      expect(await measurementsOf(ownerId)).toEqual(before);
      // Shape: a unit outside the set is a 400 error page.
      expect(
        (await post('/auth/profile/sizes/unit', { unit: 'ft' })).statusCode,
      ).toBe(400);
      expect(
        (
          await post('/auth/profile/sizes/measurements', {
            ...EMPTY_MEASUREMENTS,
            unit: 'mm',
          })
        ).statusCode,
      ).toBe(400);
    });

    it('clears a length left empty', async () => {
      await post('/auth/profile/sizes/measurements', {
        ...EMPTY_MEASUREMENTS,
        waist: '32',
      });
      expect(await measurementsOf(ownerId)).toMatchObject({
        waistCm: 81.28,
        inseamCm: null,
        heightCm: null,
      });
    });
  });

  describe('brand notes', () => {
    let uniqlo: number;

    it('adds a brand, its spelling tidied and its size normalized like a garment’s', async () => {
      const res = await post('/auth/profile/sizes/brands', {
        brand: '  Uniqlo   ',
        size: 'm',
        note: ' Runs big ',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/profile/sizes?saved=brand');
      const rows = await brandsOf(ownerId);
      expect(rows).toEqual([
        {
          id: expect.any(Number),
          brand: 'Uniqlo',
          size: 'Medium',
          note: 'Runs big',
        },
      ]);
      uniqlo = rows[0].id;
      const editor = await get('/auth/profile/sizes');
      expect(editor.body).toContain('value="Runs big"');
    });

    it('keeps one row per brand whatever the case', async () => {
      const res = await post('/auth/profile/sizes/brands', {
        brand: 'UNIQLO',
        size: 'L',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(
        'You have a row for this brand already: change that one.',
      );
      // The refused form keeps what was typed.
      expect(res.body).toContain('value="UNIQLO"');
      expect(await brandsOf(ownerId)).toHaveLength(1);
    });

    it('keeps one row per brand however its letters are typed, and finds it from any spelling', async () => {
      // One brand, typed two ways: composed é, İ and ß; then e + accent,
      // I + dot and SS. brandKey is the one rule for both the index and
      // the lookups (SQL's lower() would split them).
      const composed = 'Caf\u00e9 \u0130pek Stra\u00dfe';
      const typed = 'CAFE\u0301 I\u0307PEK STRASSE';
      const added = await post('/auth/profile/sizes/brands', {
        brand: composed,
        size: 'S',
      });
      expect(added.statusCode).toBe(303);
      const taken = await post('/auth/profile/sizes/brands', {
        brand: typed,
        size: 'L',
      });
      expect(taken.statusCode).toBe(400);
      expect(taken.body).toContain(
        'You have a row for this brand already: change that one.',
      );
      const row = (await brandsOf(ownerId)).find(
        (brand) => brand.brand === composed,
      )!;
      const note = `Your size in ${composed}: Small`;
      const garment = await createGarment(t, {
        name: 'Linen shirt',
        category: 'tops',
        brand: typed,
      });
      expect(
        unescapeHtml((await get(`/wardrobe/${garment}/edit`)).body),
      ).toContain(note);
      const hint = await get(
        `/auth/profile/sizes/hint?brand=${encodeURIComponent(typed)}`,
      );
      expect(unescapeHtml(hint.body)).toContain(note);
      await post(`/auth/profile/sizes/brands/${row.id}/delete`);
    });

    it('asks for a brand, and a size or a note', async () => {
      const blank = await post('/auth/profile/sizes/brands', {
        brand: '   ',
        size: 'M',
      });
      expect(blank.statusCode).toBe(400);
      expect(blank.body).toContain('Name the brand.');
      const empty = await post('/auth/profile/sizes/brands', {
        brand: 'Everlane',
        size: '',
        note: '',
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.body).toContain(
        'Add the size you wear there, a note, or both.',
      );
      expect(await brandsOf(ownerId)).toHaveLength(1);
    });

    it('changes and removes a row, and answers a note without a size', async () => {
      const added = await post('/auth/profile/sizes/brands', {
        brand: 'Red Wing',
        size: '9',
      });
      expect(added.statusCode).toBe(303);
      const redWing = (await brandsOf(ownerId)).find(
        (row) => row.brand === 'Red Wing',
      )!.id;
      const taken = await post(`/auth/profile/sizes/brands/${redWing}`, {
        brand: 'uniqlo',
        size: '9',
      });
      expect(taken.statusCode).toBe(400);
      const changed = await post(`/auth/profile/sizes/brands/${redWing}`, {
        brand: 'Red Wing',
        size: '',
        note: 'Runs large: size down',
      });
      expect(changed.statusCode).toBe(303);
      expect((await get('/auth/profile/sizes')).body).toContain(
        'value="Runs large: size down"',
      );
      const removed = await post(
        `/auth/profile/sizes/brands/${redWing}/delete`,
        { brand: 'Red Wing', size: '', note: 'Runs large: size down' },
      );
      expect(removed.statusCode).toBe(303);
      expect(removed.headers.location).toBe(
        '/auth/profile/sizes?saved=removed',
      );
      expect((await brandsOf(ownerId)).map((row) => row.id)).toEqual([uniqlo]);
      expect(
        (await post(`/auth/profile/sizes/brands/${redWing}/delete`)).statusCode,
      ).toBe(404);
    });

    it('answers the brand’s note as a fragment, however the brand is typed', async () => {
      const found = await get('/auth/profile/sizes/hint?brand=%20UNIQLO%20');
      expect(found.statusCode).toBe(200);
      expectFragment(found);
      expect(found.body).toContain(HINT);
      expect(found.body).toContain(UNIQLO_NOTE);
      const none = await get('/auth/profile/sizes/hint?brand=Everlane');
      expect(none.statusCode).toBe(200);
      expect(none.body).toContain(HINT);
      expect(none.body).not.toContain('data-brand-size');
      const blank = await get('/auth/profile/sizes/hint');
      expect(blank.body).not.toContain('data-brand-size');
    });
  });

  describe('where a brand’s note shows', () => {
    it('on the garment form, new and edit, with the brand field refreshing it', async () => {
      const fresh = await get('/wardrobe/new');
      expect(fresh.body).toContain(HINT);
      expect(fresh.body).toContain(HINT_TRIGGER);
      expect(fresh.body).not.toContain('data-brand-size');
      const edit = await get(`/wardrobe/${tee}/edit`);
      expect(edit.body).toContain(UNIQLO_NOTE);
      const wishlistForm = await get(`/wardrobe/${sweater}/edit`);
      expect(wishlistForm.body).toContain(UNIQLO_NOTE);
    });

    it('on the link import’s prefilled form, for the brand the page names', async () => {
      const imported = await post('/wardrobe/new/from-link?to=wishlist', {
        url: sites.url('/products/oxford'),
      });
      expect(imported.statusCode).toBe(200);
      expect(imported.body).toContain('name="brand"');
      expect(imported.body).toContain(UNIQLO_NOTE);
    });

    it('on the wishlist’s cards and a wishlist item’s page', async () => {
      const wishlist = await get('/wardrobe/wishlist');
      expect(wishlist.body).toContain(UNIQLO_NOTE);
      const item = await get(`/wardrobe/${sweater}`);
      expect(unescapeHtml(item.body)).toContain(UNIQLO_NOTE);
      // Not on a closet garment's page: its size is its own.
      expect((await get(`/wardrobe/${tee}`)).body).not.toContain(
        'data-brand-size',
      );
    });
  });

  describe('owner-only', () => {
    it('shows a shared wardrobe’s pages without any note, not even the grantee’s own', async () => {
      // The manager has a Uniqlo note of their own: it describes them, not
      // the wardrobe's owner, so it is not shown there either.
      await post(
        '/auth/profile/sizes/brands',
        { brand: 'Uniqlo', size: 'XS', note: 'Petite fit' },
        manager,
      );
      for (const [cookie, pages] of [
        [
          viewer,
          [
            `/wardrobe/wishlist?ownerId=${ownerId}`,
            `/wardrobe/${sweater}?ownerId=${ownerId}`,
          ],
        ],
        [
          manager,
          [
            `/wardrobe/wishlist?ownerId=${ownerId}`,
            `/wardrobe/${sweater}?ownerId=${ownerId}`,
            `/wardrobe/${tee}/edit?ownerId=${ownerId}`,
            `/wardrobe/${sweater}/edit?ownerId=${ownerId}`,
            `/wardrobe/new?ownerId=${ownerId}`,
          ],
        ],
      ] as const) {
        for (const url of pages) {
          const res = await get(url, cookie);
          expect(res.statusCode, url).toBe(200);
          expect(res.body, url).not.toContain('data-brand-size');
          expect(res.body, url).not.toContain(HINT);
          expect(res.body, url).not.toContain(HINT_TRIGGER);
          expect(res.body, url).not.toContain('Runs big');
          expect(res.body, url).not.toContain('Petite fit');
        }
      }
    });

    it('never reads or writes another user’s sizes', async () => {
      const [uniqlo] = await brandsOf(ownerId);
      const before = await measurementsOf(ownerId);
      for (const cookie of [viewer, manager]) {
        // Naming the owner is a 404, never their own editor under the
        // owner's address (#680).
        const editor = await get(
          `/auth/profile/sizes?ownerId=${ownerId}`,
          cookie,
        );
        expect(editor.statusCode).toBe(404);
        expect(editor.body).not.toContain('Runs big');
        expect(editor.body).not.toMatch(/name="waist" value="32"/);
        const hint = await get(
          `/auth/profile/sizes/hint?brand=Uniqlo&ownerId=${ownerId}`,
          cookie,
        );
        expect(hint.statusCode).toBe(404);
        expect(hint.body).not.toContain('Runs big');
        expect(
          (
            await post(
              `/auth/profile/sizes/brands/${uniqlo.id}`,
              { brand: 'Uniqlo', size: 'XXL', note: 'Hijacked' },
              cookie,
            )
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await post(
              `/auth/profile/sizes/brands/${uniqlo.id}/delete`,
              {},
              cookie,
            )
          ).statusCode,
        ).toBe(404);
        await post(
          '/auth/profile/sizes/measurements',
          { ...EMPTY_MEASUREMENTS, waist: '28' },
          cookie,
        );
      }
      expect(await brandsOf(ownerId)).toEqual([uniqlo]);
      expect(await measurementsOf(ownerId)).toEqual(before);
      // Their writes landed on their own rows.
      const managerId = await userIdOf(t, 'manager-sizes@example.com');
      expect((await measurementsOf(managerId)).waistCm).toBe(71.12);
    });

    it('get_sizes answers the token’s own sizes, all or one brand', async () => {
      const token = await createAccessToken(t);
      const all = await tool(t, token, 'get_sizes');
      expect(all).toEqual({
        unit: 'in',
        measurements: [{ name: 'waist', cm: 81.28, value: 32 }],
        brands: [{ brand: 'Uniqlo', size: 'Medium', note: 'Runs big' }],
      });
      expect(await tool(t, token, 'get_sizes', { brand: ' UNIQLO' })).toEqual(
        all,
      );
      expect(
        await tool(t, token, 'get_sizes', { brand: 'Everlane' }),
      ).toMatchObject({ brands: [] });
      const managerToken = await createAccessToken(t, { cookie: manager });
      expect(await tool(t, managerToken, 'get_sizes')).toEqual({
        unit: 'in',
        measurements: [{ name: 'waist', cm: 71.12, value: 28 }],
        brands: [{ brand: 'Uniqlo', size: 'X-Small', note: 'Petite fit' }],
      });
    });

    it('goes with the account', async () => {
      const leaving = await t.register('leaving-sizes@example.com');
      const leavingId = await userIdOf(t, 'leaving-sizes@example.com');
      await post(
        '/auth/profile/sizes/brands',
        { brand: 'COS', size: 'M' },
        leaving,
      );
      await post(
        '/auth/profile/sizes/measurements',
        { ...EMPTY_MEASUREMENTS, height: '70' },
        leaving,
      );
      const deleted = await post(
        '/auth/delete-account',
        { email: 'leaving-sizes@example.com', password: TEST_PASSWORD },
        leaving,
      );
      expect(deleted.statusCode).toBeLessThan(400);
      expect(await brandsOf(leavingId)).toEqual([]);
      expect(await measurementsOf(leavingId)).toBeUndefined();
    });
  });
});
