import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, recordQueries, type TestApp } from './harness';
import { expectFullPage, expectNoScriptNavigation } from './pages';

/**
 * The first-run gate (#666): until the closet can be dressed as an outfit
 * (a top and a bottom, or a dress: canProduceOutfit), Today is the
 * first-run path, a welcome and one primary action opening the add sheet,
 * and Today, the calendar week and Styling offer no plan and no picks.
 */
describe('First run', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  const get = (url: string) => t.inject({ method: 'GET', url });

  const addGarment = async (name: string, category: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { name, category },
    });
    expect(res.statusCode).toBe(302);
  };

  /** The page's filled buttons and links (daisyUI's btn-primary). */
  const primaries = (html: string) =>
    [
      ...html.matchAll(
        /<(?:a|button)\b[^>]*class="[^"]*\bbtn-primary\b[^>]*>([^<]*)</g,
      ),
    ].map((m) => m[1].trim());

  it('greets an empty closet with one primary action and no plan', async () => {
    let res = await get('/');
    const record = await recordQueries(async () => {
      res = await get('/');
    });
    expectFullPage(res);
    expectNoScriptNavigation(res);
    const html = res.body;
    expect(html).toContain('data-first-run="empty"');
    expect(primaries(html)).toEqual(['Add your first garment']);
    // The button opens the add sheet in place, camera first.
    expect(html).toMatch(/data-first-run-add=""/);
    expect(html).toContain('id="add-sheet"');
    expect(html.indexOf('data-photo-source="camera"')).toBeLessThan(
      html.indexOf('data-photo-source="library"'),
    );
    expect(html).not.toContain('Plan my week');
    expect(html).not.toContain('Plan another outfit');
    // The city comes once a garment is in; ideas once an outfit could be.
    expect(html).not.toContain('data-today-row');
    // The session, then the day's one statement: no idea is drawn.
    expect(record.statements).toBe(2);
  });

  it('hides Plan my week on the calendar and Include picks in Styling', async () => {
    const calendar = (await get('/calendar')).body;
    expect(calendar).not.toContain('Plan my week');
    expect(calendar).not.toContain('data-day-plan');
    const styling = (await get('/styling')).body;
    expect(styling).not.toContain('data-styling-picks');
  });

  it('asks for more while the closet holds no outfit, then shows the normal Today', async () => {
    await addGarment('White tee', 'tops');
    const partial = (await get('/')).body;
    expect(partial).toContain('data-first-run="incomplete"');
    expect(primaries(partial)).toEqual(['Add a garment']);
    expect(partial).not.toContain('Plan my week');
    expect((await get('/styling')).body).not.toContain('data-styling-picks');

    await addGarment('Jeans', 'bottoms');
    const ready = (await get('/')).body;
    expect(ready).not.toContain('data-first-run');
    expect(ready).not.toContain('id="add-sheet"');
    expect(ready).toContain('Plan my week');
    expect(ready).toContain('data-today-row="ideas"');
    const calendar = (await get('/calendar')).body;
    expect(calendar).toContain('Plan my week');
    expect(calendar).toContain('data-day-plan');
    expect((await get('/styling')).body).toContain('data-styling-picks');
  });

  it('draws a photoless garment as its role, and an empty list as the hanger', async () => {
    await addGarment('Sneakers', 'footwear');
    const grid = (await get('/wardrobe')).body;
    expect(grid).toContain('data-silhouette="top"');
    expect(grid).toContain('data-silhouette="footwear"');
    // The dock's hanger is EmptyState's icon (the empty Trips page's).
    const trips = (await get('/trips')).body;
    const main = trips.slice(0, trips.indexOf('class="dock"'));
    expect(main).toContain('d="M10 6.40476');
    // The dock's svg sets the tabs' weight; the paths must not override it.
    expect(trips).not.toMatch(/<path d="M4\.12572[^>]*stroke-width/);
    expect(trips).toMatch(
      /<svg[^>]*stroke-width="1\.5"[^>]*>\s*<path d="M4\.12572/,
    );
  });
});
