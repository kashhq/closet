import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import {
  expectFragment,
  expectNativePostForms,
  expectNoRawI18nKeys,
} from './pages';

/**
 * The wardrobe grid's property filters, select mode and bulk edit (#12,
 * slice 12b): filters narrow by type (with its category), warmth, formality
 * and material and offer only values the wardrobe holds; select mode turns
 * tiles into checkboxes of one native form (later pages included); a bulk
 * edit sets one property on the selected garments its role allows, ignores
 * ids outside the wardrobe, and returns to the same filters with a toast.
 */

type Props = Record<string, unknown>;

describe('property filters, select mode and bulk edit', () => {
  let t: TestApp;
  let ids: Record<'tee' | 'heavyTee' | 'jeans' | 'boots', number>;
  /** A VIEW grantee of the owner's wardrobe, and the owner's id. */
  let viewer: string;
  let ownerId: number;

  const post = (url: string, payload: Props, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });
  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });

  const create = async (payload: Props, cookie?: string) => {
    const res = await post('/wardrobe', { props: '1', ...payload }, cookie);
    expect(res.statusCode).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };
  const rows = (garmentIds: number[]) =>
    t.db
      .select()
      .from(garment)
      .where(inArray(garment.id, garmentIds))
      .orderBy(garment.id);
  const names = (html: string) =>
    [...html.matchAll(/data-tile-name="">([^<]*)</g)].map((match) => match[1]);

  beforeAll(async () => {
    t = await createTestApp();
    ids = {
      tee: await create({
        name: 'Light tee',
        category: 'tops',
        type: 't-shirt',
        warmth: '2',
        materials: ['cotton'],
      }),
      heavyTee: await create({
        name: 'Heavy tee',
        category: 'tops',
        type: 't-shirt',
        warmth: '3',
        formality: '2',
        materials: ['cotton', 'linen'],
      }),
      jeans: await create({
        name: 'Jeans',
        category: 'bottoms',
        type: 'jeans',
        warmth: '3',
        materials: ['denim'],
      }),
      boots: await create({
        name: 'Boots',
        category: 'footwear',
        type: 'boots',
        warmth: '4',
        formality: '3',
      }),
    };
    ownerId = await userIdOf(t, 'owner@example.com');
    viewer = await t.register('viewer-bulk@example.com');
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    await post(`/wardrobe-share/invite/${token}/accept`, {}, viewer);
  });

  afterAll(() => t?.cleanup());

  describe('filters', () => {
    it.each([
      ['?warmth=3', ['Jeans', 'Heavy tee']],
      ['?formality=3', ['Boots']],
      ['?material=cotton', ['Heavy tee', 'Light tee']],
      ['?material=denim&warmth=3', ['Jeans']],
      ['?category=tops&type=t-shirt&warmth=2', ['Light tee']],
    ])('%s finds %j', async (query, expected) => {
      const res = await get(`/wardrobe${query}`);
      expect(res.statusCode).toBe(200);
      expect(names(res.body)).toEqual(expected);
    });

    it('drops a type without its category rather than filter by it', async () => {
      const res = await get('/wardrobe?category=bottoms&type=t-shirt');
      expect(names(res.body)).toEqual(['Jeans']);
      // No type pill for a type that was dropped.
      expect(res.body).not.toContain('T-shirt ×');
    });

    it('says nothing matches, not that the wardrobe is empty', async () => {
      const res = await get('/wardrobe?warmth=5&material=silk');
      expect(res.body).toContain('No garments match these filters.');
      expect(res.body).not.toContain('Add a garment to start');
    });

    it('refuses a warmth or material outside its set', async () => {
      expect((await get('/wardrobe?warmth=9')).statusCode).toBe(400);
      expect((await get('/wardrobe?material=vinyl')).statusCode).toBe(400);
    });

    it('offers only the values the wardrobe holds', async () => {
      const html = (await get('/wardrobe?category=tops')).body;
      const modal = html.slice(html.indexOf('id="filter-modal"'));
      expect(modal).toContain('name="type" value="t-shirt"');
      expect(modal).not.toContain('name="type" value="sweater"');
      expect(modal).toContain('name="material" value="denim"');
      expect(modal).not.toContain('name="material" value="silk"');
      expect(modal).toContain('name="warmth" value="4"');
      expect(modal).not.toContain('name="warmth" value="5"');
      // Types are in the sheet before any category is applied (revealed by
      // the chosen category chip, #674), still only those the wardrobe holds.
      const unfiltered = (await get('/wardrobe')).body;
      expect(unfiltered).toContain('name="type" value="t-shirt"');
      expect(unfiltered).not.toContain('name="type" value="sweater"');
    });

    it('shows a pill for each property filter and keeps them in the search form', async () => {
      const res = await get('/wardrobe?warmth=3&material=cotton');
      expectNoRawI18nKeys(res);
      expect(res.body).toContain('Warmth: Medium ×');
      expect(res.body).toContain('Cotton ×');
      const form = res.body.slice(res.body.indexOf('id="search-form"'));
      expect(form).toMatch(/type="hidden" name="warmth" value="3"/);
      expect(form).toMatch(/type="hidden" name="material" value="cotton"/);
    });
  });

  describe('select mode', () => {
    it('turns tiles into checkboxes of one native post form, with the filters in its action', async () => {
      const res = await get('/wardrobe?select=1&warmth=3');
      expect(res.statusCode).toBe(200);
      expectNoRawI18nKeys(res);
      expectNativePostForms(res);
      const html = unescapeHtml(res.body);
      expect(html).toMatch(
        /<form id="bulk-form" method="post" action="\/wardrobe\/bulk\?warmth=3"/,
      );
      expect(html).toContain(`name="ids" value="${ids.jeans}"`);
      expect(html).not.toContain(`href="/wardrobe/${ids.jeans}"`);
      expect(html).toContain('id="bulk-dialog"');
      // The dialog's inputs join the form from outside it.
      expect(html).toMatch(/name="property" value="warmth" form="bulk-form"/);
    });

    it('asks for later pages as checkbox tiles too', async () => {
      const res = await get(`/wardrobe/tiles?select=1&before=${ids.boots}`, {
        'hx-request': 'true',
      });
      expectFragment(res);
      expect(res.body).toContain(`name="ids" value="${ids.jeans}"`);
    });

    it('is not offered to someone who cannot edit', async () => {
      const res = await get(`/wardrobe?select=1&ownerId=${ownerId}`, {
        cookie: viewer,
      });
      expect(res.statusCode).toBe(200);
      // The owner's garments, as links: no checkboxes, no bulk form.
      expect(res.body).toContain('Heavy tee');
      expect(res.body).not.toContain('name="ids"');
      expect(res.body).not.toContain('id="bulk-form"');
    });
  });

  describe('POST /wardrobe/bulk', () => {
    it('sets the property where the role has it and skips the rest', async () => {
      const res = await post('/wardrobe/bulk?warmth=3', {
        ids: [ids.tee, ids.jeans, ids.boots],
        property: 'sleeve',
        sleeve: 'long',
      });
      expect(res.statusCode).toBe(303);
      // Back to select mode on the same filters, the selection kept
      // (#677), with the toast's flags.
      expect(res.headers.location).toBe(
        `/wardrobe?warmth=3&select=1&selected=${ids.tee}%2C${ids.jeans}%2C${ids.boots}&bulkUpdated=1&bulkSkipped=2`,
      );
      const [tee, jeans, boots] = await rows([ids.tee, ids.jeans, ids.boots]);
      expect(tee.sleeve).toBe('long');
      expect(jeans.sleeve).toBeNull();
      expect(boots.sleeve).toBeNull();
    });

    it('clears a property with the Not set chip', async () => {
      await post('/wardrobe/bulk', {
        ids: [ids.boots],
        property: 'formality',
        formality: '',
      });
      expect((await rows([ids.boots]))[0].formality).toBeNull();
    });

    it('adds a material once, keeping the others', async () => {
      await post('/wardrobe/bulk', {
        ids: [ids.tee, ids.heavyTee],
        property: 'materials',
        material: 'linen',
      });
      const [tee, heavyTee] = await rows([ids.tee, ids.heavyTee]);
      expect(tee.materials).toEqual(['cotton', 'linen']);
      expect(heavyTee.materials).toEqual(['cotton', 'linen']);
    });

    it('stores the set in MATERIALS order, as the garment form does', async () => {
      // Denim comes after cotton in MATERIALS: appended, it would come first.
      const res = await post('/wardrobe/bulk', {
        ids: [ids.jeans, ids.tee],
        property: 'materials',
        material: 'cotton',
      });
      expect(res.headers.location).toContain('bulkUpdated=2');
      const [tee, jeans] = await rows([ids.tee, ids.jeans]);
      expect(jeans.materials).toEqual(['cotton', 'denim']);
      expect(tee.materials).toEqual(['cotton', 'linen']);
    });

    it('leaves the property alone when its tab’s chips were not touched', async () => {
      const before = await rows([ids.boots]);
      // Another tab's value rides along; the chosen tab posted nothing.
      const res = await post('/wardrobe/bulk', {
        ids: [ids.boots],
        property: 'warmth',
        fit: 'slim',
      });
      expect(res.headers.location).toContain('bulkUpdated=0');
      expect(await rows([ids.boots])).toEqual(before);
    });

    it('uses only the chosen tab’s value', async () => {
      await post('/wardrobe/bulk', {
        ids: [ids.jeans],
        property: 'fit',
        fit: 'relaxed',
        warmth: '5',
      });
      const [jeans] = await rows([ids.jeans]);
      expect(jeans.fit).toBe('relaxed');
      expect(jeans.warmth).toBe(3);
    });

    it('ignores ids outside the addressed wardrobe', async () => {
      const other = await t.register('other-bulk@example.com');
      const theirs = await create(
        { name: 'Theirs', category: 'tops', warmth: '1' },
        other,
      );
      const res = await post('/wardrobe/bulk', {
        ids: [theirs, ids.tee],
        property: 'warmth',
        warmth: '5',
      });
      expect(res.headers.location).toContain('bulkUpdated=1');
      const [mine, stranger] = await rows([ids.tee, theirs]);
      expect(mine.warmth).toBe(5);
      expect(stranger.warmth).toBe(1);
    });

    it('changes nothing with no selection or no material picked', async () => {
      const before = await rows(Object.values(ids));
      for (const payload of [
        { property: 'warmth', warmth: '1' },
        { ids: [ids.jeans], property: 'materials' },
      ]) {
        const res = await post('/wardrobe/bulk', payload);
        expect(res.headers.location).toContain('bulkUpdated=0');
      }
      expect(await rows(Object.values(ids))).toEqual(before);
    });

    it('logs what it did', async () => {
      await post('/wardrobe/bulk', {
        ids: [ids.jeans],
        property: 'pattern',
        pattern: 'solid',
      });
      expect(t.logs.ops('garments.property.set')).toContainEqual(
        expect.objectContaining({
          property: 'pattern',
          updated: 1,
          skipped: 0,
          asked: 1,
        }),
      );
    });

    it('shows the result once as a toast', async () => {
      const res = await get('/wardrobe?bulkUpdated=3&bulkSkipped=1');
      expectNoRawI18nKeys(res);
      expect(res.body).toContain('Set on 3 garments · 1 skipped');
      expect(res.body).toContain('data-strip-flags="bulkUpdated bulkSkipped ');
    });

    it('writes nothing for a VIEW grantee', async () => {
      const res = await post(
        `/wardrobe/bulk?ownerId=${ownerId}`,
        { ids: [ids.boots], property: 'warmth', warmth: '1' },
        viewer,
      );
      expect(res.statusCode).toBe(403);
      const [boots] = await t.db
        .select()
        .from(garment)
        .where(eq(garment.id, ids.boots));
      expect(boots.warmth).toBe(4);
    });
  });
});
