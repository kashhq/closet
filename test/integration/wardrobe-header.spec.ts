import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file, garment } from '../../src/db/schema';
import { createGarment } from './garments';
import {
  createTestApp,
  type TestApp,
  unescapeHtml,
  asFixture,
  TEST_PASSWORD,
} from './harness';
import { expectFullPage, HX_FRAGMENT } from './pages';

/**
 * The Wardrobe's header and tabs (redesign R3, #83): the switcher in the
 * title, the ⋯ menu, the add sheet and the tabs on every tab page,
 * select mode as a task with its own bar, and the grid's tiles drawn on
 * the plinth. The grid's paging and filters are wardrobe-grid.spec.ts's,
 * the capsule scope capsules.spec.ts's, the switcher's wardrobes
 * share-lifecycle.spec.ts's.
 */
describe('the Wardrobe header and tabs', () => {
  let t: TestApp;
  let ownerId: number;
  let viewer: string;
  let manager: string;

  const get = async (url: string, cookie?: string, fragment = false) => {
    const res = await t.inject({
      method: 'GET',
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(fragment ? HX_FRAGMENT : {}),
      },
    });
    expect(res.statusCode).toBe(200);
    return unescapeHtml(res.body);
  };

  const element = (html: string, pattern: RegExp) => pattern.exec(html)?.[0];
  const menuOf = (html: string) =>
    element(html, /<details[^>]*id="wardrobe-menu"[\s\S]*?<\/details>/);
  const sheetOf = (html: string) =>
    element(html, /<dialog id="add-sheet"[\s\S]*?<\/dialog>/);
  const tabsOf = (html: string) =>
    element(html, /<nav [^>]*id="wardrobe-tabs">[\s\S]*?<\/nav>/);
  const activeTab = (html: string) =>
    /class="tab tab-active" aria-current="page">([^<]*)</.exec(html)?.[1];

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
    const accepted = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      payload: {},
      headers: { cookie },
    });
    expect(accepted.statusCode).toBe(302);
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = t.owner.id;
    await createGarment(t, { name: 'White tee', category: 'tops' });
    await createGarment(t, { name: 'Jeans', category: 'bottoms' });
    viewer = await t.register('viewer-header@example.com');
    manager = await t.register('manager-header@example.com');
    await share('VIEW', viewer);
    await share('MANAGE', manager);
  });

  afterAll(() => t?.cleanup());

  it('gives every tab the header and the four tabs, each tab its own page', async () => {
    const tabs: [path: string, label: string][] = [
      ['/wardrobe', 'Closet'],
      ['/capsules', 'Capsules'],
      ['/laundry', 'Laundry'],
      ['/wardrobe/wishlist', 'Wishlist'],
    ];
    for (const [path, label] of tabs) {
      const res = await t.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(activeTab(html), path).toBe(label);
      expect(tabsOf(html), path).toMatch(
        /href="\/wardrobe"[\s\S]*href="\/capsules"[\s\S]*href="\/laundry"[\s\S]*href="\/wardrobe\/wishlist"/,
      );
      // The tab row is a labelled <nav> (a landmark), not loose links (#730).
      expect(tabsOf(html), path).toContain('aria-label="Wardrobe sections"');
      expect(html, path).toContain('id="title-menu"');
      expect(menuOf(html), path).toBeDefined();
      expect(sheetOf(html), path).toBeDefined();
      // The dock marks the Wardrobe on every one, the laundry included.
      expect(html, path).toMatch(
        /<a class="dock-active" aria-current="page" href="\/wardrobe">/,
      );
    }
  });

  it('leaves Laundry out of a shared wardrobe’s tabs: it is the user’s own', async () => {
    const html = await get(`/wardrobe?ownerId=${ownerId}`, viewer);
    const tabs = tabsOf(html)!;
    expect(tabs).toContain(`href="/wardrobe?ownerId=${ownerId}"`);
    expect(tabs).toContain(`href="/capsules?ownerId=${ownerId}"`);
    expect(tabs).toContain(`href="/wardrobe/wishlist?ownerId=${ownerId}"`);
    expect(tabs).not.toContain('/laundry');
  });

  it('puts Select (with the grid’s filters), tagging, Insights and the year in review in ⋯', async () => {
    const menu = menuOf(await get('/wardrobe?category=tops'))!;
    expect(menu).toContain('href="/wardrobe?category=tops&select=1"');
    expect(menu).toContain('href="/wardrobe/tag"');
    expect(menu).toContain('href="/wardrobe/insights"');
    expect(menu).toContain('href="/wardrobe/recap"');
  });

  it('gives a filtered grid’s fragment the ⋯ menu out of band, so Select keeps the new filters', async () => {
    const html = await get('/wardrobe?category=bottoms', undefined, true);
    expect(html).toMatch(/^<div id="wardrobe-main"/);
    const menu = menuOf(html)!;
    expect(menu).toContain('hx-swap-oob="true"');
    expect(menu).toContain('href="/wardrobe?category=bottoms&select=1"');
  });

  it('offers a VIEW grantee no Select, tagging or add, their own Insights, and no year in review', async () => {
    const html = await get(`/wardrobe?ownerId=${ownerId}`, viewer);
    const menu = menuOf(html)!;
    expect(menu).not.toContain('select=1');
    expect(menu).not.toContain('/wardrobe/tag');
    expect(menu).toContain('href="/wardrobe/insights"');
    // The recap is the wear log: never offered inside someone else's wardrobe.
    expect(menu).not.toContain('/wardrobe/recap');
    expect(sheetOf(html)).toBeUndefined();
    expect(html).not.toContain('aria-label="Add"');
  });

  it('gives a VIEW grantee’s filtered-grid fragment a ⋯ menu still without Select or tagging', async () => {
    const html = await get(
      `/wardrobe?ownerId=${ownerId}&category=bottoms`,
      viewer,
      true,
    );
    expect(html).toMatch(/^<div id="wardrobe-main"/);
    const menu = menuOf(html)!;
    expect(menu).toContain('hx-swap-oob="true"');
    expect(menu).not.toContain('select=1');
    expect(menu).not.toContain('/wardrobe/tag');
    expect(menu).toContain('href="/wardrobe/insights"');
    expect(sheetOf(html)).toBeUndefined();
    expect(html).not.toContain('aria-label="Add"');
  });

  it('adds to the closet or the wishlist from the sheet, in the shared wardrobe for a MANAGE grantee', async () => {
    const own = sheetOf(await get('/wardrobe'))!;
    expect(own).toContain('href="/wardrobe/new/from-link"');
    expect(own).toContain('href="/wardrobe/new"');
    expect(own).toContain('href="/wardrobe/new/from-link?to=wishlist"');
    expect(own).toContain('href="/wardrobe/new?to=wishlist"');
    expect(own).not.toContain('/capsules/new');
    // The closet first, except on the Wishlist tab.
    expect(own.indexOf('To the closet')).toBeLessThan(
      own.indexOf('To the wishlist'),
    );
    const wishlist = sheetOf(await get('/wardrobe/wishlist'))!;
    expect(wishlist.indexOf('To the wishlist')).toBeLessThan(
      wishlist.indexOf('To the closet'),
    );

    const managed = sheetOf(
      await get(`/wardrobe?ownerId=${ownerId}`, manager),
    )!;
    expect(managed).toContain(`href="/wardrobe/new?ownerId=${ownerId}"`);
    expect(managed).toContain(
      `href="/wardrobe/new/from-link?to=wishlist&ownerId=${ownerId}"`,
    );
  });

  it('offers "New capsule" in the owner’s Capsules tab sheet, never a grantee’s', async () => {
    expect(sheetOf(await get('/capsules'))).toContain('href="/capsules/new"');
    const managed = sheetOf(await get(`/capsules?ownerId=${ownerId}`, manager));
    expect(managed).toBeDefined();
    expect(managed).not.toContain('/capsules/new');
  });

  it('opens select mode as a task: its own title and Cancel back to the grid as filtered, no tabs', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe?category=tops&select=1',
    });
    expectFullPage(res);
    const html = unescapeHtml(res.body);
    expect(html).toMatch(/<h1[^>]*>Select garments<\/h1>/);
    expect(html).toMatch(
      /<a href="\/wardrobe\?category=tops" class="btn btn-ghost btn-sm">Cancel<\/a>/,
    );
    expect(tabsOf(html)).toBeUndefined();
    expect(html).not.toContain('id="scope-row"');
    expect(html).toContain('id="bulk-form"');
  });

  it('draws a cutout contained on the plinth and a photo still without one covering it', async () => {
    const photo = async (status: 'ready' | 'pending', name: string) => {
      const [row] = await asFixture(t.db, (tx) =>
        tx
          .insert(file)
          .values({
            fileName: `${randomUUID()}.webp`,
            shareableId: randomUUID(),
            createdOn: new Date().toISOString(),
            createdById: ownerId,
            cutoutStatus: status,
          })
          .returning({ id: file.id, fileName: file.fileName }),
      );
      const id = await createGarment(t, { name, category: 'tops' });
      await asFixture(t.db, (tx) =>
        tx.update(garment).set({ photoId: row.id }).where(eq(garment.id, id)),
      );
      return row.fileName;
    };
    const cut = await photo('ready', 'Cut tee');
    const raw = await photo('pending', 'Raw tee');
    const html = await get('/wardrobe');
    const img = (fileName: string) =>
      new RegExp(
        `<img src="/file/thumb/${fileName}\\?v=1&s=[\\w-]{16}" alt="" class="([^"]*)"`,
      ).exec(html)?.[1];
    expect(img(cut)).toContain('object-contain');
    expect(img(raw)).toContain('object-cover');
    // The tiles are the plinth, 4:5, without card chrome.
    expect(html).toMatch(
      /<figure class="relative overflow-hidden bg-base-200 aspect-\[4\/5\] rounded-box/,
    );
    expect(html).not.toMatch(/id="wardrobe-grid"[\s\S]*class="card /);
  });
});
