import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file, garmentWear, outfitCalendar, selfie } from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { imageUrl } from '../../src/web/files/image-url';
import { readPhotoRef } from '../../src/web/files/queries';
import { variantFileName } from '../../src/web/files/image-variant';
import { createGarment } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  TEST_PASSWORD,
  unescapeHtml,
  userIdOf,
} from './harness';
import { createAccessToken, tool } from './mcp';
import { expectFullPage } from './pages';
import {
  mirrorPhoto,
  planEntry,
  postSelfie,
  selfieOf,
  takeSelfie,
} from './selfies';

/**
 * Outfit selfies (#19, plan section 13): a mirror photo as the record of
 * what was worn. Taking one stores it through Photos without a cutout and
 * marks the entry worn in the same transaction; the calendar, Today and the
 * outfit page's Worn strip show it through the owner-only /selfies/ route
 * (never the public /file/**); replacing, removing and deleting the entry
 * unlink its files after commit; deleting the outfit keeps it as a look on
 * its day; deleting the account takes every one. Refusals by other users
 * are in authorization-outfits.spec.ts, reconciliation's in reconcile.spec.ts.
 */
describe('outfit selfies', () => {
  let t: TestApp;
  const today = () => t.today();

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const variantsOf = (name: string) =>
    [
      name,
      variantFileName(name, 'thumb'),
      variantFileName(name, 'nobg'),
    ] as const;

  /** A garment, an outfit wearing it and its entry on `day`. */
  const outfitOn = async (name: string, day = today(), cookie?: string) => {
    const garmentId = await createGarment(t, { name: `${name} tee`, cookie });
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: { name, category: 'shirt', garmentId: String(garmentId) },
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode).toBe(302);
    const outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(res.headers.location as string)![1],
    );
    const entryId = await planEntry(t, outfitId, day, cookie);
    return { garmentId, outfitId, entryId };
  };

  const entryRow = async (id: number) =>
    (
      await t.db.select().from(outfitCalendar).where(eq(outfitCalendar.id, id))
    ).at(0);

  const fileRow = async (fileName: string) =>
    (await t.db.select().from(file).where(eq(file.fileName, fileName))).at(0);

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('stores a selfie with its background, no cutout queued, and marks the entry worn with its wears', async () => {
    const { garmentId, entryId } = await outfitOn('Mirror check');

    const res = await postSelfie(
      t,
      entryId,
      { data: await mirrorPhoto(900, 1200) },
      { returnTo: '/' },
    );

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    const stored = await selfieOf(t, entryId);
    const [row] = await t.db
      .select()
      .from(selfie)
      .where(eq(selfie.id, stored.id));
    expect(row).toMatchObject({
      ownerId: t.owner.id,
      day: today(),
      outfitCalendarId: entryId,
    });
    // The cutout state machine's terminal status: nothing queued, ever.
    expect(await fileRow(stored.fileName)).toMatchObject({
      createdById: t.owner.id,
      cutoutStatus: 'unwanted',
      cutoutRequestedAt: null,
    });
    const [original, thumb, nobg] = variantsOf(stored.fileName);
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([original, thumb]),
    );
    expect(await storedFiles()).not.toContain(nobg);
    // Opaque and portrait, as taken: the thumb is the photo scaled, not a cutout.
    const meta = await sharp(join(t.dataPath, thumb)).metadata();
    expect(meta.height).toBe(400);
    expect(meta.width).toBe(300);

    // Worn, through setEntryWorn: the outfit's garment has its wear.
    expect((await entryRow(entryId))!.wornAt).not.toBeNull();
    expect(
      await t.db
        .select({ day: garmentWear.day })
        .from(garmentWear)
        .where(eq(garmentWear.garmentId, garmentId)),
    ).toEqual([{ day: today() }]);
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Selfie ${stored.id} of calendar entry ${entryId} taken by user ${t.owner.id}: ${stored.fileName}; entry marked worn \\(1 wears logged\\)$`,
        ),
      ),
    );
  });

  it('shows the look on the calendar, Today and the outfit page, only through /selfies/', async () => {
    const { outfitId, entryId } = await outfitOn('Shown everywhere');
    const { fileName } = await takeSelfie(t, entryId);
    const thumb = `/selfies/thumb/${fileName}?v=1`;

    const calendar = await t.inject({
      method: 'GET',
      url: `/calendar?week=${today()}`,
    });
    expectFullPage(calendar);
    const home = await t.inject({ method: 'GET', url: '/' });
    expectFullPage(home);
    const outfitPage = await t.inject({
      method: 'GET',
      url: `/outfits/${outfitId}`,
    });
    expectFullPage(outfitPage);

    for (const page of [calendar, home, outfitPage]) {
      const html = unescapeHtml(page.body);
      expect(html).toContain(`src="${thumb}"`);
      // The whole photo loads in the dialog only.
      expect(html).toContain(`src="/selfies/${fileName}?v=1"`);
      expect(html).not.toContain(`/file/${fileName}`);
      expect(html).not.toContain(`/file/thumb/${fileName}`);
      // Removal, and (for an entry) another photo from the camera or the library.
      expect(html).toContain('/selfies/');
      expect(html).toMatch(/capture="environment"/);
    }
    // The calendar's row sends a new photo or a removal back to its day,
    // not the top of its week.
    const back = encodeURIComponent(`/calendar?week=${today()}#day-${today()}`);
    const week = unescapeHtml(calendar.body);
    expect(week).toContain(
      `action="/calendar/${entryId}/selfie?returnTo=${back}"`,
    );
    expect(week).toContain(
      `name="returnTo" value="/calendar?week=${today()}#day-${today()}"`,
    );
    const strip = unescapeHtml(outfitPage.body);
    expect(strip).toContain('data-worn-strip');
    expect(strip).toContain(`data-worn-day="${today()}"`);
  });

  it('serves a selfie to its owner only, privately cached; never on the public /file routes', async () => {
    const { entryId } = await outfitOn('Private');
    const { fileName } = await takeSelfie(t, entryId);

    for (const url of [
      `/selfies/${fileName}?v=1`,
      `/selfies/thumb/${fileName}?v=1`,
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
    }

    const stranger = await t.register('selfie-stranger@example.com');
    const theirs = await t.inject({
      method: 'GET',
      url: `/selfies/thumb/${fileName}`,
      headers: { cookie: stranger },
    });
    expect(theirs.statusCode).toBe(404);
    const signedOut = await t.inject({
      method: 'GET',
      url: `/selfies/thumb/${fileName}`,
      anonymous: true,
    });
    expect(signedOut.statusCode).toBe(302);

    // The public routes serve by name alone: a selfie's name gets nothing,
    // signed in or not.
    for (const url of [
      `/file/${fileName}`,
      `/file/thumb/${fileName}`,
      `/file/nobg/${fileName}`,
    ]) {
      expect((await t.inject({ method: 'GET', url })).statusCode).toBe(404);
      expect(
        (await t.inject({ method: 'GET', url, anonymous: true })).statusCode,
      ).toBe(404);
    }
    // A signature is the server's word that a name is no selfie's (#162):
    // one made for another photo does not carry over to this name.
    const signedForAnother = imageUrl(
      readPhotoRef({
        fileName: `${randomUUID()}.webp`,
        version: 1,
        variantKey: null,
      }),
      'thumb',
    );
    const borrowed = `/file/thumb/${fileName}?${signedForAnother.split('?')[1]}`;
    expect((await t.inject({ method: 'GET', url: borrowed })).statusCode).toBe(
      404,
    );
    // Not a photo name at all is a 404 too, like /file's.
    expect(
      (await t.inject({ method: 'GET', url: '/selfies/app.log' })).statusCode,
    ).toBe(404);
  });

  it('replacing a selfie unlinks the old photo; removing one keeps the entry worn', async () => {
    const { entryId } = await outfitOn('Retaken');
    const first = await takeSelfie(t, entryId);
    const second = await takeSelfie(t, entryId);

    expect(second.id).toBe(first.id);
    expect(second.fileName).not.toBe(first.fileName);
    expect(await fileRow(first.fileName)).toBeUndefined();
    const files = await storedFiles();
    for (const name of variantsOf(first.fileName)) {
      expect(files).not.toContain(name);
    }
    expect(files).toContain(second.fileName);

    const removed = await t.inject({
      method: 'POST',
      url: `/selfies/${second.id}/delete`,
      payload: { returnTo: `/calendar?week=${today()}` },
    });
    expect(removed.statusCode).toBe(303);
    expect(removed.headers.location).toBe(`/calendar?week=${today()}`);
    expect(await selfieOf(t, entryId)).toBeUndefined();
    expect(await fileRow(second.fileName)).toBeUndefined();
    expect(await storedFiles()).not.toContain(second.fileName);
    expect((await entryRow(entryId))!.wornAt).not.toBeNull();

    const again = await t.inject({
      method: 'POST',
      url: `/selfies/${second.id}/delete`,
    });
    expect(again.statusCode).toBe(404);
  });

  // #165: production pays a ~114 ms round trip per statement. The session,
  // the entry looked up before the upload is read, then one owner
  // transaction that setEntryWorn joins (no savepoint, no second lock):
  // begin, the lock, the entry locked, (marked worn,) the previous selfie,
  // the photo row, the selfie, (the replaced photo row,) commit.
  it('takes a selfie in ten statements, and replaces one in as many', async () => {
    const { entryId } = await outfitOn('Counted');
    const photo = { data: await mirrorPhoto() };
    const taken = await recordQueries(async () => {
      expect((await postSelfie(t, entryId, photo)).statusCode).toBe(303);
    });
    expect(taken.statements).toBe(10);
    // Worn already: nothing to mark, and the old photo row goes instead.
    const replaced = await recordQueries(async () => {
      expect((await postSelfie(t, entryId, photo)).statusCode).toBe(303);
    });
    expect(replaced.statements).toBe(10);
    for (const record of [taken, replaced]) {
      const sql = record.sql.join('\n');
      expect(sql).not.toMatch(/savepoint/);
      expect(sql.match(/for no key update/g)).toHaveLength(1);
    }
  });

  it('refuses a planned day (409), a missing photo (400) and anyone else (404), storing nothing', async () => {
    const tomorrow = addDays(today(), 1);
    const { entryId: planned } = await outfitOn('Tomorrow', tomorrow);
    const { entryId: mine } = await outfitOn('Not yours');
    const stranger = await t.register('selfie-intruder@example.com');
    const filesBefore = (await storedFiles()).sort();
    const [{ rows: rowsBefore }] = await t.db
      .select({ rows: count() })
      .from(file);

    const ahead = await postSelfie(t, planned, { data: await mirrorPhoto() });
    expect(ahead.statusCode).toBe(409);
    const intruder = await postSelfie(
      t,
      mine,
      { data: await mirrorPhoto() },
      { cookie: stranger },
    );
    expect(intruder.statusCode).toBe(404);
    const missing = await postSelfie(t, 2_000_000_000, {
      data: await mirrorPhoto(),
    });
    expect(missing.statusCode).toBe(404);
    const notImage = await postSelfie(t, mine, {
      data: Buffer.from('not a photo'),
      filename: 'notes.txt',
      contentType: 'text/plain',
    });
    expect(notImage.statusCode).toBe(400);

    expect((await storedFiles()).sort()).toEqual(filesBefore);
    const [{ rows: rowsAfter }] = await t.db
      .select({ rows: count() })
      .from(file);
    expect(rowsAfter).toBe(rowsBefore);
    expect((await entryRow(planned))!.wornAt).toBeNull();
    expect((await entryRow(mine))!.wornAt).toBeNull();
  });

  it('takes a HEIC from an iPhone through the same pipeline', async () => {
    const { entryId } = await outfitOn('From an iPhone');
    const heic = await readFile(join(__dirname, '../fixtures/example.heic'));

    const res = await postSelfie(t, entryId, {
      data: heic,
      filename: 'IMG_0042.HEIC',
      contentType: 'image/heic',
    });

    expect(res.statusCode).toBe(303);
    const { fileName } = await selfieOf(t, entryId);
    const meta = await sharp(join(t.dataPath, fileName)).metadata();
    expect(meta.format).toBe('webp');
    expect((await fileRow(fileName))!.cutoutStatus).toBe('unwanted');
  });

  it('deleting the entry removes its selfie, row and files', async () => {
    const { entryId } = await outfitOn('Wrong entry');
    const { id, fileName } = await takeSelfie(t, entryId);

    const res = await t.inject({
      method: 'POST',
      url: `/calendar/${entryId}/delete`,
      payload: { week: today() },
    });

    expect(res.statusCode).toBe(303);
    expect(await entryRow(entryId)).toBeUndefined();
    expect(await t.db.select().from(selfie).where(eq(selfie.id, id))).toEqual(
      [],
    );
    expect(await fileRow(fileName)).toBeUndefined();
    const files = await storedFiles();
    for (const name of variantsOf(fileName)) expect(files).not.toContain(name);
    expect(t.logs.ops('calendar.entry.deleted').at(-1)).toMatchObject({
      userId: t.owner.id,
      entryId,
      changed: true,
      selfies: [fileName],
    });
  });

  it('deleting the outfit keeps its selfie as a look on its day, which can still be removed', async () => {
    const { outfitId, entryId } = await outfitOn('Tidied away');
    const { id, fileName } = await takeSelfie(t, entryId);

    const deleted = await t.inject({
      method: 'DELETE',
      url: `/outfits/${outfitId}`,
      headers: { 'hx-request': 'true' },
    });
    expect(deleted.statusCode).toBe(200);

    expect(await entryRow(entryId)).toBeUndefined();
    const [look] = await t.db.select().from(selfie).where(eq(selfie.id, id));
    expect(look).toMatchObject({
      outfitCalendarId: null,
      day: today(),
      ownerId: t.owner.id,
    });
    expect(await fileRow(fileName)).toBeDefined();
    expect(await storedFiles()).toContain(fileName);

    const week = unescapeHtml(
      (await t.inject({ method: 'GET', url: `/calendar?week=${today()}` }))
        .body,
    );
    expect(week).toContain(`data-looks="${today()}"`);
    expect(week).toContain(`/selfies/thumb/${fileName}?v=1`);
    // A look has no entry to take another photo for: removal only.
    expect(week).toContain(`action="/selfies/${id}/delete"`);

    const removed = await t.inject({
      method: 'POST',
      url: `/selfies/${id}/delete`,
    });
    expect(removed.statusCode).toBe(303);
    expect(await storedFiles()).not.toContain(fileName);
  });

  it('deleting the account removes every selfie with its files', async () => {
    const email = 'selfie-leaver@example.com';
    const cookie = await t.register(email);
    const { entryId } = await outfitOn('Leaving', today(), cookie);
    const { fileName } = await takeSelfie(t, entryId, cookie);
    const userId = await userIdOf(t, email);

    const res = await t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      payload: { email, password: TEST_PASSWORD },
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(
      await t.db.select().from(selfie).where(eq(selfie.ownerId, userId)),
    ).toEqual([]);
    expect(await fileRow(fileName)).toBeUndefined();
    const files = await storedFiles();
    for (const name of variantsOf(fileName)) expect(files).not.toContain(name);
  });

  it('get_calendar says which entries have a selfie, never the image', async () => {
    const token = await createAccessToken(t);
    const day = addDays(today(), -20);
    const { entryId: pictured } = await outfitOn('Pictured for MCP', day);
    const { entryId: plain } = await outfitOn('Plain for MCP', day);
    const { fileName } = await takeSelfie(t, pictured);

    const answer = await tool<{
      entries: { id: number; selfie: boolean }[];
    }>(t, token, 'get_calendar', { from: day, to: day });

    expect(answer.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pictured, selfie: true }),
        expect.objectContaining({ id: plain, selfie: false }),
      ]),
    );
    expect(JSON.stringify(answer)).not.toContain(fileName);
  });
});
