import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageUrl } from '../../src/web/files/image-url';
import { readPhotoRef } from '../../src/web/files/queries';
import { variantFileName } from '../../src/web/files/image-variant';
import { createGarment, garmentRow, jpegPhoto, uploadPhoto } from './garments';
import {
  createTestApp,
  hxLocationPath,
  imgTags,
  TestApp,
  unescapeHtml,
} from './harness';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('wardrobe', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('garment photo lifecycle', () => {
    // Sequential: each step builds on the garment the previous one made.
    let garmentId: number;
    let fileName: string;
    const filePath = (variant: 'original' | 'nobg' | 'thumb') =>
      join(t.dataPath, variantFileName(fileName, variant));

    it('stores a File row plus original and thumb variants on upload', async () => {
      garmentId = await createGarment(t, { name: 'Green shirt' });
      await uploadPhoto(t, garmentId, await jpegPhoto(1200, 800));

      const garment = (await garmentRow(t, garmentId))!;
      expect(garment.photo?.fileName).toMatch(/^[0-9a-f-]{36}\.webp$/);
      expect(garment.photo?.version).toBe(1);
      fileName = garment.photo!.fileName;

      const original = await sharp(filePath('original')).metadata();
      expect(original.format).toBe('webp');
      expect(original.width).toBe(1080);

      const thumb = await sharp(filePath('thumb')).metadata();
      expect(thumb.format).toBe('webp');
      expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(400);

      expect(await exists(filePath('nobg'))).toBe(false);
    });

    it('renders the grid with versioned thumbs, eager above the fold and lazy below', async () => {
      // The URL a page renders: signed (#162).
      const thumbUrl = imageUrl(
        readPhotoRef({ fileName, version: 1, variantKey: null }),
        'thumb',
      );
      const tileFor = (html: string) =>
        imgTags(unescapeHtml(html)).find((tag) =>
          tag.includes(`src="${thumbUrl}"`),
        );

      const first = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(first.statusCode).toBe(200);
      const eager = tileFor(first.body);
      expect(eager).toBeDefined();
      expect(eager).toContain('width="400"');
      expect(eager).toContain('height="400"');
      expect(eager).not.toContain('loading="lazy"');

      // Newest first: eight newer garments push the photo to index 8.
      for (let i = 0; i < 8; i++) {
        await createGarment(t, { name: `Filler ${i}` });
      }
      const second = await t.inject({ method: 'GET', url: '/wardrobe' });
      const lazy = tileFor(second.body);
      expect(lazy).toBeDefined();
      expect(lazy).toContain('loading="lazy"');
    });

    it('serves the thumb as immutable webp', async () => {
      const res = await t.inject({
        method: 'GET',
        url: `/file/thumb/${fileName}?v=1`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
      expect(res.rawPayload.equals(await readFile(filePath('thumb')))).toBe(
        true,
      );
    });

    it('falls back to the original when no cutout exists', async () => {
      const res = await t.inject({
        method: 'GET',
        url: `/file/nobg/${fileName}?v=1`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.rawPayload.equals(await readFile(filePath('original')))).toBe(
        true,
      );
    });

    it('DELETE removes the row and every variant file', async () => {
      const res = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/${garmentId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(hxLocationPath(res)).toBe('/wardrobe');

      expect(await garmentRow(t, garmentId)).toBeUndefined();
      expect(await exists(filePath('original'))).toBe(false);
      expect(await exists(filePath('thumb'))).toBe(false);

      const gone = await t.inject({
        method: 'GET',
        url: `/file/thumb/${fileName}?v=1`,
      });
      expect(gone.statusCode).toBe(404);
    });
  });

  describe('the filter sheet (#674)', () => {
    const sheet = async (query = '') => {
      const res = await t.inject({ method: 'GET', url: `/wardrobe${query}` });
      expect(res.statusCode).toBe(200);
      return filterDialog(unescapeHtml(res.body));
    };
    const filterDialog = (html: string) =>
      /<dialog id="filter-modal"[\s\S]*?<\/dialog>/.exec(html)![0];

    beforeAll(async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          name: 'Typed shirt',
          category: 'tops',
          props: '1',
          type: 'shirt',
          color: 'blue',
        },
      });
      expect(res.statusCode).toBe(302);
    });

    it('is named by its heading, and every chip is a focusable input with a name', async () => {
      const html = await sheet();
      expect(html).toContain('aria-labelledby="filter-modal-title"');
      expect(html).toContain('id="filter-modal-title"');
      const chips = [
        ...html.matchAll(/<input\b[^>]*name="(category|color|type)"[^>]*>/g),
      ];
      expect(chips.length).toBeGreaterThan(10);
      for (const [chip] of chips) {
        expect(chip).toContain('type="radio"');
        expect(chip).toMatch(/aria-label="[^"]+"/);
        expect(chip).not.toMatch(/class="[^"]*\bhidden\b/);
      }
    });

    it('renders the type chips before any category is applied, revealed by the chosen category', async () => {
      const html = await sheet();
      expect(html).toContain('id="filter-type-tops-title"');
      expect(html).toMatch(/<input[^>]*name="type"[^>]*value="shirt"[^>]*>/);
      expect(html).toContain(
        'group-has-[input[name=category][value=tops]:checked]/filter:block',
      );
    });

    it('keeps a type only while its own category is applied (a cleared category drops a stale hidden type)', async () => {
      const post = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          name: 'Typed tee',
          category: 'tops',
          props: '1',
          type: 't-shirt',
        },
      });
      expect(post.statusCode).toBe(302);
      const names = async (query: string) => {
        const res = await t.inject({ method: 'GET', url: `/wardrobe${query}` });
        expect(res.statusCode).toBe(200);
        const html = unescapeHtml(res.body);
        return {
          shirt: html.includes('Typed shirt'),
          tee: html.includes('Typed tee'),
        };
      };
      expect(await names('?category=tops&type=shirt')).toEqual({
        shirt: true,
        tee: false,
      });
      // The sheet posts category= (cleared) with the hidden group's checked type.
      const both = { shirt: true, tee: true };
      expect(await names('?category=&type=shirt')).toEqual(both);
      expect(await names('?type=shirt')).toEqual(both);
    });

    it('checks the applied type only inside the applied category (a shared type name stays unchecked elsewhere)', async () => {
      for (const category of ['accessories', 'bags']) {
        const post = await t.inject({
          method: 'POST',
          url: '/wardrobe',
          payload: {
            name: `Other ${category}`,
            category,
            props: '1',
            type: 'other',
          },
        });
        expect(post.statusCode).toBe(302);
      }
      const html = await sheet('?category=accessories&type=other');
      const checked = [
        ...html.matchAll(
          /<input[^>]*name="type"[^>]*value="other"[^>]*checked[^>]*>/g,
        ),
      ];
      expect(checked).toHaveLength(1);
      const group = html
        .split('role="group"')
        .find((chunk) => chunk.includes(checked[0][0]))!;
      expect(group).toContain('filter-type-accessories-title');
    });

    it('is the facets aside, posting the scope row’s keyword, the page’s only one (#1067)', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe?keyword=shirt&category=tops',
      });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      expect(html).toMatch(
        /<main class="page-shell[^"]*" data-layout="facets"><aside id="wardrobe-aside" class="page-aside" aria-label="Filters"><dialog id="filter-modal"[^>]*data-sheet="filters"/,
      );
      // One keyword field, so a keyword typed and not yet searched is the
      // one Apply and Clear send: two would each hold one.
      expect(html.match(/<input\b[^>]*\bname="keyword"/g)).toHaveLength(1);
      expect(html).toMatch(
        /<form[^>]*id="search-form"[\s\S]*?name="keyword" value="shirt"[\s\S]*?<\/form>/,
      );
      const dialog = filterDialog(html);
      expect(dialog).not.toContain('name="keyword"');
      const include = 'hx-include="#search-form [name=\'keyword\']"';
      expect(
        /<form\b[^>]*hx-get="\/wardrobe"[^>]*>/.exec(dialog)![0],
      ).toContain(include);
      expect(
        /<button\b[^>]*id="filter-clear"[^>]*>/.exec(dialog)![0],
      ).toContain(include);
    });

    it('asks search, a chip’s × and the capsule menu from the filter form, so an unapplied tick rides along (#1144)', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe?keyword=shirt&category=tops&color=blue',
      });
      const html = unescapeHtml(res.body);
      const fromFilters = `hx-get="/wardrobe" hx-include="#filter-form, #search-form [name='keyword']"`;
      expect(filterDialog(html)).toMatch(/<form\b[^>]*id="filter-form"/);
      // Search's Enter submits the filter form (its fields, the keyword
      // through its include), never its own request, whose hidden filters
      // are the no-script GET's and would go twice.
      const search = /<form\b[^>]*id="search-form"[^>]*>/.exec(html)![0];
      expect(search).toContain('data-submits-via="filter-form"');
      expect(search).toContain('hx-boost="false"');
      expect(search).not.toContain('hx-get');
      // Each chip leaves its own filter out of the form's; without the
      // form its href, every other filter in it, is followed natively.
      expect(html).toContain('data-native-without="filter-form"');
      expect(html).toContain(
        `href="/wardrobe?keyword=shirt&color=blue" ${fromFilters} hx-params="not category"`,
      );
      expect(html).toContain(
        `href="/wardrobe?keyword=shirt&category=tops" ${fromFilters} hx-params="not color"`,
      );
    });

    it('answers a fragment with the body, and the facets’ content and the bar out of band', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe?category=tops',
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      expect(html.trimStart()).toMatch(/^<div id="wardrobe-body"/);
      // Swapped into the aside, never kept: htmx's history snapshot holds
      // attributes, so the markup must be the URL's filters.
      expect(html).toMatch(
        /<aside id="wardrobe-aside" class="page-aside" hx-swap-oob="innerHTML"/,
      );
      expect(filterDialog(html)).toMatch(
        /name="category" value="tops"[^>]*checked/,
      );
      expect(html).toMatch(
        /<div id="wardrobe-actions" hidden="" hx-swap-oob="true"/,
      );
    });

    it('offers a clear chip only beside a chosen value, and keeps the chosen one checked', async () => {
      const plain = await sheet();
      expect(plain).not.toContain('value=""');
      const chosen = await sheet('?category=tops&type=shirt&color=blue');
      expect(chosen.match(/<input[^>]*value=""[^>]*>/g)).toHaveLength(3);
      expect(chosen).toMatch(
        /<input[^>]*name="type"[^>]*value="shirt"[^>]*checked/,
      );
    });
  });
});
