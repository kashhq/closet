import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestApp } from './harness';

/**
 * The wardrobe filter modal is built from SELECT DISTINCT queries per
 * column; the rendered radio options are what the user sees, so assert on
 * those rather than on the service result.
 */
describe('wardrobe filters', () => {
  let t: TestApp;

  const create = async (fields: Record<string, string>) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { category: 'shirt', ...fields },
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(res.headers.location as string)![1],
    );
  };

  /** The filter sheet's choices for one query parameter (not its clear chip, value ''). */
  const optionValues = (html: string, name: string) => {
    const modal = /<dialog id="filter-modal"[\s\S]*?<\/dialog>/.exec(html)![0];
    return [
      ...modal.matchAll(
        new RegExp(`type="radio" name="${name}" value="([^"]+)"`, 'g'),
      ),
    ].map((m) => m[1]);
  };

  beforeAll(async () => {
    t = await createTestApp();
    await create({ name: 'Tee 1', brand: 'Uniqlo', size: 'Large' });
    await create({ name: 'Tee 2', brand: 'Uniqlo', size: 'L' });
    await create({ name: 'Tee 3', brand: 'Patagonia', size: 'XS' });
    await create({
      name: 'Jeans',
      category: 'pants',
      brand: "Levi's",
      size: '32',
    });
    await create({ name: 'Coat', category: 'jacket', size: 'XX-Large' });
    await create({ name: 'No brand or size' });
    const archived = await create({
      name: 'Old hat',
      category: 'hat',
      brand: 'Archived Co',
      size: '5XL',
    });
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${archived}/archive`,
    });
    expect(res.statusCode).toBeLessThan(300);
  });

  afterAll(() => t?.cleanup());

  it('lists each category once, sorted, including archived garments', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(res.statusCode).toBe(200);
    expect(optionValues(res.body, 'category')).toEqual([
      'hat',
      'jacket',
      'pants',
      'shirt',
    ]);
  });

  it('lists each normalized size once in canonical order, custom sizes last', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(optionValues(res.body, 'size')).toEqual([
      'X-Small',
      'Large',
      'XX-Large',
      '5X-Large',
      '32',
    ]);
  });

  it('offers the same distinct values on the garment form', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/new' });
    expect(res.statusCode).toBe(200);
    // Enum categories first, then the custom "hat" once, even though the
    // only garment carrying it is archived.
    const hatOptions = res.body.match(/value="hat"/g) ?? [];
    expect(hatOptions).toHaveLength(1);
  });
});
