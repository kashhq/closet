import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capsule, capsuleGarment, garment } from '../../src/db/schema';
import { recordStatements } from '../support/query-recorder';
import { createGarment } from './garments';
import {
  createTestApp,
  type TestApp,
  unescapeHtml,
  userIdOf,
  TEST_PASSWORD,
} from './harness';
import {
  expectFragment,
  expectFullPage,
  expectNativePostForms,
  expectNoRawI18nKeys,
  expectOfflineGuarded,
} from './pages';

/**
 * Capsules (#8, plan section 2, and the owner's decision on the issue):
 * named subsets of one wardrobe. The owner creates, renames and deletes
 * them; membership is set through the grid's select mode (the picker,
 * `?pick=`) and the garment page's toggles; the grid filters by one
 * (`?capsule=`) and the outfit builder builds from one. Only the wardrobe's
 * own garments can be members; archived members are hidden but keep their
 * membership. A share reaches capsules: a VIEW grantee reads them, a MANAGE
 * grantee also changes membership. authorization-capsules.spec.ts holds the full
 * matrix; this spec proves the behavior.
 */
describe('capsules', () => {
  let t: TestApp;
  let ownerId: number;
  let viewer: string;
  let manager: string;
  let stranger: string;
  let ids: Record<'tee' | 'shirt' | 'jeans' | 'boots' | 'old', number>;

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: object, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });

  const createCapsule = async (name: string, notes = '') => {
    const res = await post('/capsules', { name, notes });
    expect(res.statusCode).toBe(303);
    const match = /^\/capsules\/(\d+)\?created=1$/.exec(
      String(res.headers.location),
    );
    if (!match) throw new Error(`Unexpected redirect ${res.headers.location}`);
    return Number(match[1]);
  };

  const members = async (capsuleId: number) =>
    (
      await t.db
        .select({ id: capsuleGarment.garmentId })
        .from(capsuleGarment)
        .where(eq(capsuleGarment.capsuleId, capsuleId))
        .orderBy(capsuleGarment.garmentId)
    ).map((row) => row.id);

  const tileNames = (html: string) =>
    [...html.matchAll(/data-tile-name="">([^<]*)</g)].map((match) => match[1]);

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

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    ids = {
      tee: await createGarment(t, { name: 'White tee', category: 'tops' }),
      shirt: await createGarment(t, { name: 'Oxford', category: 'tops' }),
      jeans: await createGarment(t, { name: 'Jeans', category: 'bottoms' }),
      boots: await createGarment(t, { name: 'Boots', category: 'footwear' }),
      old: await createGarment(t, { name: 'Old tee', category: 'tops' }),
    };
    viewer = await t.register('viewer-capsules@example.com');
    manager = await t.register('manager-capsules@example.com');
    stranger = await t.register('stranger-capsules@example.com');
    await share('VIEW', viewer);
    await share('MANAGE', manager);
  });

  afterAll(() => t?.cleanup());

  describe('create, rename, delete', () => {
    it('creates a capsule from the form, trimmed, and says so once', async () => {
      const form = await get('/capsules/new');
      expect(form.statusCode).toBe(200);
      expectFullPage(form);
      expect(form.body).toMatch(/<form method="post" action="\/capsules"/);

      const id = await createCapsule('  Studio  ', '  Tue to Thu  ');
      const [row] = await t.db.select().from(capsule).where(eq(capsule.id, id));
      expect(row).toMatchObject({
        ownerId,
        name: 'Studio',
        notes: 'Tue to Thu',
      });
      const page = await get(`/capsules/${id}?created=1`);
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      expect(page.body).toContain('Capsule created');
      expect(page.body).toContain('"created","added","removed"');
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Capsule ${id} created by user ${ownerId}`,
      );
    });

    it('is disabled offline, new and edit alike, Delete too: a cached copy must not post into the offline page', async () => {
      const id = await createCapsule('Offline');
      const create = await get('/capsules/new');
      expect(create.statusCode).toBe(200);
      expectOfflineGuarded(create, '/capsules');
      const edit = await get(`/capsules/${id}/edit`);
      expect(edit.statusCode).toBe(200);
      expectOfflineGuarded(edit, `/capsules/${id}`);
      expect(edit.body).toContain(`hx-delete="/capsules/${id}"`);
    });

    it('refuses a blank name with the form again, and a long one with a 400', async () => {
      const before = await t.db.$count(capsule);
      const blank = await post('/capsules', { name: '   ', notes: 'kept' });
      expect(blank.statusCode).toBe(400);
      expectFullPage(blank);
      expect(blank.body).toContain('Give the capsule a name');
      expect(blank.body).toContain('kept');
      const long = await post('/capsules', { name: 'x'.repeat(81) });
      expect(long.statusCode).toBe(400);
      expect(await t.db.$count(capsule)).toBe(before);
    });

    it('renames it and clears blank notes', async () => {
      const id = await createCapsule('Summr', 'typo');
      const edit = await get(`/capsules/${id}/edit`);
      expect(edit.statusCode).toBe(200);
      expectFullPage(edit);
      expect(edit.body).toContain('value="Summr"');
      const res = await post(`/capsules/${id}`, { name: 'Summer', notes: '' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/capsules/${id}`);
      const [row] = await t.db.select().from(capsule).where(eq(capsule.id, id));
      expect(row).toMatchObject({ name: 'Summer', notes: null });
      const blank = await post(`/capsules/${id}`, { name: '' });
      expect(blank.statusCode).toBe(400);
      expect(blank.body).toContain('Give the capsule a name');
    });

    it('refuses a name the owner already uses, in any case, and keeps what was typed', async () => {
      await createCapsule('Gym');
      const before = await t.db.$count(capsule);
      for (const name of ['Gym', '  gYM  ']) {
        const res = await post('/capsules', { name, notes: 'Saturdays' });
        expect({ name, status: res.statusCode }).toEqual({ name, status: 400 });
        expectFullPage(res);
        expect(res.body).toContain('You already have a capsule with this name');
        expect(res.body).toContain('Saturdays');
      }
      expect(await t.db.$count(capsule)).toBe(before);
      expect(t.logs.messages('warn', 'Web')).toContainEqual(
        'Capsule form refused (new): You already have a capsule with this name',
      );
    });

    it('refuses renaming to another capsule’s name, in any case, but not to its own', async () => {
      const beach = await createCapsule('Beach');
      await createCapsule('Lake');
      for (const name of ['Lake', 'LAKE']) {
        const res = await post(`/capsules/${beach}`, { name });
        expect({ name, status: res.statusCode }).toEqual({ name, status: 400 });
        expect(res.body).toContain('You already have a capsule with this name');
        expect(res.body).toContain(`action="/capsules/${beach}"`);
      }
      // A change of case to its own name is a rename, not a clash.
      const recased = await post(`/capsules/${beach}`, { name: 'BEACH' });
      expect(recased.statusCode).toBe(303);
      const [row] = await t.db
        .select()
        .from(capsule)
        .where(eq(capsule.id, beach));
      expect(row.name).toBe('BEACH');
    });

    it('lets another owner use the same name', async () => {
      await createCapsule('Ski');
      const theirs = await post('/capsules', { name: 'Ski' }, stranger);
      expect(theirs.statusCode).toBe(303);
      expect(await t.db.$count(capsule, eq(capsule.name, 'Ski'))).toBe(2);
    });

    it('deletes it with its membership, never its garments', async () => {
      const id = await createCapsule('Doomed');
      await post(`/capsules/${id}/garments`, { ids: [ids.tee] });
      const res = await t.inject({
        method: 'DELETE',
        url: `/capsules/${id}`,
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(String(res.headers['hx-location']))).toMatchObject({
        path: '/capsules',
      });
      expect(await t.db.$count(capsule, eq(capsule.id, id))).toBe(0);
      expect(await members(id)).toEqual([]);
      expect(await t.db.$count(garment, eq(garment.id, ids.tee))).toBe(1);
    });

    it('answers 404 for a capsule outside the wardrobe, like an unknown id', async () => {
      const theirs = await post(
        '/capsules',
        { name: 'Stranger capsule' },
        stranger,
      );
      const theirId = Number(
        /\/capsules\/(\d+)/.exec(String(theirs.headers.location))![1],
      );
      for (const url of [
        `/capsules/${theirId}`,
        `/capsules/${theirId}/edit`,
        '/capsules/999999',
      ]) {
        const res = await get(url);
        expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
        expect(res.body).not.toContain('Stranger capsule');
      }
      const rename = await post(`/capsules/${theirId}`, { name: 'Mine now' });
      expect(rename.statusCode).toBe(404);
      const [row] = await t.db
        .select()
        .from(capsule)
        .where(eq(capsule.id, theirId));
      expect(row.name).toBe('Stranger capsule');
    });
  });

  describe('membership', () => {
    let office: number;

    beforeAll(async () => {
      office = await createCapsule('Office');
    });

    it('the picker is select mode with the members checked and every tile marked shown', async () => {
      await post(`/capsules/${office}/garments`, {
        ids: [ids.shirt],
        shown: [ids.shirt],
      });
      const res = await get(`/wardrobe?pick=${office}`);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      expectNativePostForms(res);
      const html = unescapeHtml(res.body);
      expect(html).toContain('Garments in Office');
      expect(html).toMatch(
        new RegExp(
          `<form id="pick-form" method="post" action="/capsules/${office}/garments"`,
        ),
      );
      expect(html).toMatch(
        new RegExp(`name="ids" value="${ids.shirt}" checked=""`),
      );
      expect(html).toMatch(new RegExp(`name="ids" value="${ids.jeans}" class`));
      expect(html).toContain(`name="shown" value="${ids.jeans}"`);
      // No bulk dialog, no filter bar: Save and Cancel (back to the capsule).
      expect(html).not.toContain('id="bulk-dialog"');
      expect(html).not.toContain('id="search-form"');
      expect(html).toContain(`href="/capsules/${office}"`);
      // One member on screen, counted; later pages' are counted as they
      // arrive by the page's module (test/capsules.spec.ts (retired 2026-10-13)).
      expect(html).toMatch(/id="selected-count"[^>]*>1</);
      expect(html).toContain('<div data-select-count');
      expect(html).toContain(`import 'select-count';`);
    });

    it('asks for later pages as picker tiles', async () => {
      const res = await get(
        `/wardrobe/tiles?pick=${office}&before=${ids.jeans}`,
        { 'hx-request': 'true' },
      );
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      const html = unescapeHtml(res.body);
      expect(html).toMatch(
        new RegExp(`name="ids" value="${ids.shirt}" checked=""`),
      );
      expect(html).toContain(`name="shown" value="${ids.tee}"`);
    });

    it('saves what the picker showed and leaves the rest alone', async () => {
      // The boots joined earlier and were not on screen (another page, a
      // filter): they stay. The shirt was shown and unchecked: it leaves.
      await post(`/capsules/${office}/garments`, { ids: [ids.boots] });
      const res = await post(`/capsules/${office}/garments`, {
        ids: [ids.tee, ids.jeans],
        shown: [ids.tee, ids.shirt, ids.jeans],
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `/capsules/${office}?added=2&removed=1`,
      );
      expect(await members(office)).toEqual(
        [ids.tee, ids.jeans, ids.boots].sort((a, b) => a - b),
      );
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Capsule ${office} garments chosen by user ${ownerId} in wardrobe ${ownerId}: 2 added, 1 removed, 3 shown$`,
          ),
        ),
      );
      const page = await get(`/capsules/${office}?added=2&removed=1`);
      expect(page.body).toContain('2 added · 1 removed');
    });

    it('drops ids outside the wardrobe', async () => {
      const theirs = await createGarment(t, {
        name: 'Their coat',
        cookie: stranger,
      });
      const before = await members(office);
      const res = await post(`/capsules/${office}/garments`, {
        ids: [theirs],
        shown: [theirs],
      });
      expect(res.headers.location).toBe(
        `/capsules/${office}?added=0&removed=0`,
      );
      expect(await members(office)).toEqual(before);
    });

    it('keeps an archived member but hides it from the capsule', async () => {
      await post(`/capsules/${office}/garments`, { ids: [ids.old] });
      const archive = await t.inject({
        method: 'POST',
        url: `/wardrobe/${ids.old}/archive`,
        headers: { 'hx-request': 'true' },
      });
      expect(archive.statusCode).toBe(200);
      expect(await members(office)).toContain(ids.old);

      const page = await get(`/capsules/${office}`);
      expect(tileNames(page.body)).not.toContain('Old tee');
      expect(page.body).toContain('3 garments');
      const list = await get('/capsules');
      expect(list.body).toMatch(/Office<\/h2>\s*<span[^>]*>3 garments</);
      const grid = await get(`/wardrobe?capsule=${office}`);
      expect(tileNames(grid.body)).not.toContain('Old tee');
      // The picker does not show it either, so saving keeps it.
      const picker = await get(`/wardrobe?pick=${office}`);
      expect(picker.body).not.toContain(`name="shown" value="${ids.old}"`);
      // "Show archived" brings it back, still a member.
      const archived = await get(`/wardrobe?capsule=${office}&archived=true`);
      expect(tileNames(archived.body)).toContain('Old tee');
    });

    it('toggles capsules from the garment page, leaving capsules it did not list', async () => {
      const weekend = await createCapsule('Weekend');
      const page = await get(`/wardrobe/${ids.jeans}`);
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      const html = unescapeHtml(page.body);
      expect(html).toContain('>Capsules</h2>');
      expect(html).toContain(`hx-post="/wardrobe/${ids.jeans}/capsules"`);
      expect(html).toMatch(
        new RegExp(
          `value="${office}" class="[^"]*" aria-label="Office" checked`,
        ),
      );

      // Listed: Office and Weekend. A capsule made meanwhile is not.
      const later = await createCapsule('Later');
      await post(`/capsules/${later}/garments`, { ids: [ids.jeans] });
      const res = await post(`/wardrobe/${ids.jeans}/capsules`, {
        capsuleIds: [weekend],
        shown: [office, weekend],
      });
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      // The form's status line only: the toggles are what the person set
      // (src/web/autosave.tsx).
      expect(res.body).toBe('<span class="text-success">Saved</span>');
      expect(await members(office)).not.toContain(ids.jeans);
      expect(await members(weekend)).toEqual([ids.jeans]);
      expect(await members(later)).toEqual([ids.jeans]);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Garment ${ids.jeans} capsules set by user ${ownerId} in wardrobe ${ownerId}: 1 added, 1 removed`,
      );
    });

    // A round trip per statement in production (#156): neither the picker's
    // Save nor the toggles read the capsule or the garment before writing
    // (#251). changeMembership locks both sides in one statement and says
    // which took part, so the session, then the transaction: begin, the
    // lock, the delete, the insert, commit.
    describe('statements per request', () => {
      const sqlOf = async (work: () => Promise<{ statusCode: number }>) => {
        const { result, statements } = await recordStatements(work);
        return { status: result.statusCode, sql: statements.map((s) => s.sql) };
      };

      it('the picker’s Save: the session, then the write (6)', async () => {
        const saved = await sqlOf(() =>
          post(`/capsules/${office}/garments`, {
            ids: [ids.tee],
            shown: [ids.tee, ids.boots],
          }),
        );
        expect(saved.status).toBe(303);
        expect(saved.sql).toHaveLength(6); // 7 before #251
        expect(saved.sql[1]).toBe('begin');
      });

      it('the garment page’s toggles: the session, then the write (6)', async () => {
        const weekend = await createCapsule('Weekend toggles');
        const saved = await sqlOf(() =>
          post(`/wardrobe/${ids.boots}/capsules`, {
            capsuleIds: [weekend],
            shown: [office, weekend],
          }),
        );
        expect(saved.status).toBe(200);
        expect(saved.sql).toHaveLength(6); // 7 before #251
        expect(saved.sql[1]).toBe('begin');
      });

      it('another wardrobe’s capsule or garment is a 404 after a write that changed nothing', async () => {
        const before = await members(office);
        const capsuleRefused = await sqlOf(() =>
          post(`/capsules/${office}/garments`, { shown: before }, stranger),
        );
        expect(capsuleRefused.status).toBe(404);
        // The session, begin, the lock, commit: nothing to delete or add.
        expect(capsuleRefused.sql).toHaveLength(4);
        const garmentRefused = await sqlOf(() =>
          post(`/wardrobe/${ids.tee}/capsules`, { shown: [office] }, stranger),
        );
        expect(garmentRefused.status).toBe(404);
        expect(garmentRefused.sql).toHaveLength(4);
        expect(await members(office)).toEqual(before);
      });
    });

    it('drops a garment from every capsule when it is deleted', async () => {
      const doomed = await createGarment(t, {
        name: 'Doomed',
        category: 'tops',
      });
      await post(`/capsules/${office}/garments`, { ids: [doomed] });
      await t.inject({
        method: 'DELETE',
        url: `/wardrobe/${doomed}`,
        headers: { 'hx-request': 'true' },
      });
      expect(
        await t.db.$count(capsuleGarment, eq(capsuleGarment.garmentId, doomed)),
      ).toBe(0);
    });
  });

  describe('the grid and the list', () => {
    let travel: number;

    beforeAll(async () => {
      travel = await createCapsule('Travel');
      await post(`/capsules/${travel}/garments`, {
        ids: [ids.tee, ids.boots],
      });
    });

    it('scopes the grid to a capsule, the scope row naming it and the filter in every link', async () => {
      const res = await get(`/wardrobe?capsule=${travel}`);
      expect(res.statusCode).toBe(200);
      expectNoRawI18nKeys(res);
      const html = unescapeHtml(res.body);
      expect(tileNames(html)).toEqual(['Boots', 'White tee']);
      // The scope row's capsule menu names it and offers the closet, every
      // capsule and the Capsules tab.
      const scope =
        /<details class="dropdown shrink-0" id="capsule-scope">[\s\S]*?<\/details>/.exec(
          html,
        )![0];
      expect(scope).toMatch(/<summary[^>]*>\s*<span class="truncate">Travel</);
      expect(scope).toContain('href="/wardrobe" hx-get="/wardrobe"');
      expect(scope).toMatch(
        new RegExp(
          `href="/wardrobe\\?capsule=${travel}"[^>]*aria-current="true"`,
        ),
      );
      expect(scope).toContain('href="/capsules"');
      const form = html.slice(html.indexOf('id="search-form"'));
      expect(form).toMatch(
        new RegExp(`type="hidden" name="capsule" value="${travel}"`),
      );
      // The modal carries the scope along, and so does its Clear.
      const modal = /<dialog id="filter-modal"[\s\S]*?<\/dialog>/.exec(
        html,
      )![0];
      expect(modal).toMatch(
        new RegExp(`type="hidden" name="capsule" value="${travel}"`),
      );
      expect(modal).toContain(`hx-get="/wardrobe?capsule=${travel}"`);
      expect(html).toContain('2 results');
    });

    it('refuses a capsule that is not an id (400) or not the wardrobe’s (404)', async () => {
      expect((await get('/wardrobe?capsule=abc')).statusCode).toBe(400);
      expect((await get('/wardrobe?capsule=999999')).statusCode).toBe(404);
      expect((await get('/wardrobe?pick=999999')).statusCode).toBe(404);
    });

    it('lists the closet first, then the capsules by name with counts and thumbs', async () => {
      const res = await get('/capsules');
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      const cards = [
        ...html.matchAll(
          /<h2 class="text-lg font-semibold truncate">([^<]*)</g,
        ),
      ].map((match) => match[1]);
      expect(cards[0]).toBe('All garments');
      expect(cards.slice(1)).toEqual([...cards.slice(1)].sort());
      expect(cards).toContain('Travel');
      // "New capsule" is the add sheet's, for the owner.
      const sheet = /<dialog id="add-sheet"[\s\S]*?<\/dialog>/.exec(html)![0];
      expect(sheet).toContain('href="/capsules/new"');
      expect(html).toContain('aria-label="Wardrobe sections"');
      expect(html).toMatch(/class="tab tab-active"[^>]*>Capsules</);
    });

    it('shows the tabs on the wardrobe grid too', async () => {
      const html = unescapeHtml((await get('/wardrobe')).body);
      expect(html).toMatch(/class="tab tab-active"[^>]*>Closet</);
      expect(html).toContain('href="/capsules"');
    });

    it('shows a capsule’s garments and where it leads', async () => {
      const res = await get(`/capsules/${travel}`);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(tileNames(html)).toEqual(['Boots', 'White tee']);
      expect(html).toContain(`href="/wardrobe?pick=${travel}"`);
      expect(html).toContain(`href="/wardrobe?capsule=${travel}"`);
      expect(html).toContain(`href="/styling?capsule=${travel}"`);
      expect(html).toContain(`href="/capsules/${travel}/edit"`);
    });

    // A round trip per statement in production (#156, #159): the session,
    // then the capsule's lookup, its tiles and its count all at once, since
    // inCapsule needs no lookup first.
    it('reads a capsule’s page in 4 statements, the last three in one round trip', async () => {
      const { result: res, statements } = await recordStatements(() =>
        get(`/capsules/${travel}`),
      );
      expect(res.statusCode).toBe(200);
      expect(statements).toHaveLength(4);
      const reads = statements.slice(1);
      const lastSent = Math.max(...reads.map((s) => s.startedAt));
      const firstAnswered = Math.min(...reads.map((s) => s.startedAt + s.ms));
      expect(lastSent).toBeLessThan(firstAnswered);
    });

    it('is a 404 for another wardrobe’s capsule, whatever its reads found', async () => {
      const theirs = await t.register('other-capsules@example.com');
      const res = await get(`/capsules/${travel}`, { cookie: theirs });
      expect(res.statusCode).toBe(404);
    });

    it('shows a new user the empty state', async () => {
      const fresh = await t.register('fresh-capsules@example.com');
      const res = await get('/capsules', { cookie: fresh });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('No capsules yet');
      expect(res.body).toContain('Create your first capsule');
      expect(res.body).toContain('0 garments');
    });
  });

  describe('through a share', () => {
    let shared: number;

    beforeAll(async () => {
      shared = await createCapsule('Shared look');
      await post(`/capsules/${shared}/garments`, { ids: [ids.shirt] });
    });

    it('a VIEW grantee lists, opens and filters by the owner’s capsules, and changes nothing', async () => {
      const q = `ownerId=${ownerId}`;
      const list = unescapeHtml(
        (await get(`/capsules?${q}`, { cookie: viewer })).body,
      );
      expect(list).toContain('Shared look');
      expect(list).not.toContain('href="/capsules/new"');
      expect(list).toContain(`href="/capsules/${shared}?${q}"`);
      expect(list).toContain(`href="/wardrobe?${q}"`);

      const page = await get(`/capsules/${shared}?${q}`, { cookie: viewer });
      expect(page.statusCode).toBe(200);
      const html = unescapeHtml(page.body);
      expect(tileNames(html)).toEqual(['Oxford']);
      expect(html).toContain(`href="/wardrobe/${ids.shirt}?${q}"`);
      expect(html).not.toContain('pick=');
      expect(html).not.toContain('/edit');
      // Styling browses the shared capsule; nothing it composes is saved.
      expect(html).toContain(`href="/styling?capsule=${shared}&${q}"`);

      const grid = await get(`/wardrobe?capsule=${shared}&${q}`, {
        cookie: viewer,
      });
      expect(tileNames(grid.body)).toEqual(['Oxford']);

      // Membership shown as links, no toggles.
      const garmentPage = unescapeHtml(
        (await get(`/wardrobe/${ids.shirt}?${q}`, { cookie: viewer })).body,
      );
      expect(garmentPage).toContain(`href="/capsules/${shared}?${q}"`);
      expect(garmentPage).not.toContain('name="capsuleIds"');

      const refused = await post(
        `/capsules/${shared}/garments?${q}`,
        { shown: [ids.shirt] },
        viewer,
      );
      expect(refused.statusCode).toBe(403);
      expect(await members(shared)).toEqual([ids.shirt]);
    });

    it('a MANAGE grantee chooses garments but cannot rename or delete', async () => {
      const q = `ownerId=${ownerId}`;
      const page = unescapeHtml(
        (await get(`/capsules/${shared}?${q}`, { cookie: manager })).body,
      );
      expect(page).toContain(`href="/wardrobe?pick=${shared}&${q}"`);
      expect(page).not.toContain(`/capsules/${shared}/edit`);

      const picker = await get(`/wardrobe?pick=${shared}&${q}`, {
        cookie: manager,
      });
      expect(unescapeHtml(picker.body)).toContain(
        `action="/capsules/${shared}/garments?${q}"`,
      );
      const res = await post(
        `/capsules/${shared}/garments?${q}`,
        { ids: [ids.tee], shown: [ids.tee, ids.shirt] },
        manager,
      );
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `/capsules/${shared}?added=1&removed=1&${q}`,
      );
      expect(await members(shared)).toEqual([ids.tee]);

      expect(
        (await post(`/capsules/${shared}?${q}`, { name: 'Mine' }, manager))
          .statusCode,
      ).toBe(403);
      expect(
        (await post(`/capsules?${q}`, { name: 'Planted' }, manager)).statusCode,
      ).toBe(403);
    });

    it('a MANAGE grantee’s ids from their own wardrobe are dropped', async () => {
      const q = `ownerId=${ownerId}`;
      const own = await createGarment(t, {
        name: 'Manager tee',
        cookie: manager,
      });
      await post(`/capsules/${shared}/garments?${q}`, { ids: [own] }, manager);
      expect(await members(shared)).not.toContain(own);
    });
  });

  describe('Styling from a capsule (#42)', () => {
    let capsuleId: number;

    beforeAll(async () => {
      capsuleId = await createCapsule('Builder');
      await post(`/capsules/${capsuleId}/garments`, {
        ids: [ids.shirt, ids.boots],
      });
    });

    it('stacks only its garments: a row per role it holds', async () => {
      const res = await get(`/styling?capsule=${capsuleId}`);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      // The scope menu names it; the rows post it back.
      expect(html).toContain('Builder');
      expect(html).toContain(`name="capsule" value="${capsuleId}"`);
      // Tops: the oxford alone (the tee is newer but not in the capsule);
      // no bottoms in the capsule, so no bottoms row.
      expect(html).toContain('data-styling-row="top"');
      expect(html).toContain(`data-snap-value="${ids.shirt}"`);
      expect(html).not.toContain(`data-snap-value="${ids.tee}"`);
      expect(html).not.toContain('data-styling-row="bottom"');
    });

    it('pages a strip within the capsule', async () => {
      const inside = await get(
        `/styling/garments?role=top&before=2147483647&capsule=${capsuleId}`,
        { 'hx-request': 'true' },
      );
      expect(inside.statusCode).toBe(200);
      expectFragment(inside);
      expect(inside.body).toContain(`data-snap-value="${ids.shirt}"`);
      expect(inside.body).not.toContain(`data-snap-value="${ids.tee}"`);
      const closet = await get('/styling/garments?role=top&before=2147483647', {
        'hx-request': 'true',
      });
      expect(closet.body).toContain(`data-snap-value="${ids.tee}"`);
    });

    it('refuses someone else’s capsule and a malformed one', async () => {
      const [theirs] = await t.db
        .select({ id: capsule.id })
        .from(capsule)
        .where(and(eq(capsule.name, 'Stranger capsule')));
      expect((await get(`/styling?capsule=${theirs.id}`)).statusCode).toBe(404);
      expect((await get('/styling?capsule=abc')).statusCode).toBe(400);
    });
  });
});
