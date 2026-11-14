import { randomUUID } from 'node:crypto';
import {
  copyFile,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordCutoutEvent } from '../../src/cutout/queries';
import { file, syncEpoch, userDevice } from '../../src/db/schema';
import {
  afterRestore,
  garmentsShowingStatement,
} from '../../src/maintenance/after-restore';
import {
  missingMarksStatement,
  reconcileStorage,
  writeMissingMarks,
} from '../../src/maintenance/reconcile';
import { repointCutout } from '../../src/maintenance/repoint-cutout';
import { PROJECT_ROOT } from '../../src/project-root';
import { variantFileName } from '../../src/web/files/image-variant';
import { deviceToken } from './api';
import {
  createGarment,
  garmentRow,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  asFixture,
  createTestApp,
  subscribeAs,
  TEST_PASSWORD,
  type TestApp,
} from './harness';
import { silentLogger } from './logger';
import { createAccessToken, mcpRequest } from './mcp';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recovering from a database restore (#653): the post-restore command,
 * reconciliation's missing marks and the placeholder they draw, the writes
 * that must ignore the placeholder, the cutout repoint, and the by-hand
 * recipe of src/db/AGENTS.md, all against the real sync triggers.
 */
describe('after a database restore', () => {
  let t: TestApp;
  const deps = () => ({
    db: t.db,
    photos: t.photos,
    logger: silentLogger,
    timeZone: t.timeZone,
  });
  const reconcile = () => reconcileStorage(deps());

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();
  /** The stored files of a photo set: its original's name without `.webp`. */
  const setFiles = async (fileName: string) =>
    (await storedFiles()).filter((name) =>
      name.startsWith(fileName.replace(/\.webp$/, '')),
    );

  /** A garment with a photo stored three days ago (past the cutoff). */
  const garmentWithPhoto = async (name: string) => {
    const id = await createGarment(t, { name });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ createdOn: new Date(Date.now() - 3 * DAY_MS).toISOString() })
        .where(eq(file.fileName, fileName)),
    );
    return { id, fileName };
  };

  /** Removes the photo's whole set, returning its bytes to put back. */
  const loseSet = async (fileName: string) => {
    const lost = new Map<string, Buffer>();
    for (const name of await setFiles(fileName)) {
      lost.set(name, await readFile(join(t.dataPath, name)));
      await rm(join(t.dataPath, name));
    }
    return lost;
  };

  /** A garment whose photo reconciliation marked missing. */
  const markedGarment = async (name: string) => {
    const garment = await garmentWithPhoto(name);
    const lost = await loseSet(garment.fileName);
    await reconcile();
    expect(
      (await photoRow(t, garment.fileName))?.originalMissingSince,
    ).toBeInstanceOf(Date);
    return { ...garment, lost };
  };

  /** after-restore ends the owner's session too: t.inject() needs a new one. */
  const signOwnerInAgain = async () => {
    t.owner.cookie = await t.login(t.owner.email);
  };

  const revisionOf = async (id: number) => (await garmentRow(t, id))!.revision;
  const currentEpoch = async () => {
    const [row] = await t.db.select({ epoch: syncEpoch.epoch }).from(syncEpoch);
    return row?.epoch;
  };

  beforeAll(async () => {
    // Every restore ends the owner's session, and each spec signs it in
    // again: past SIGN_IN_ACCOUNT_LIMIT's 5 a minute for one account.
    t = await createTestApp({}, { signInAccountMax: Number.MAX_SAFE_INTEGER });
  });

  afterAll(() => t?.cleanup());

  // Must stay the first spec: it needs a database never restored, so the
  // cookies signed in now carry no `sep` (the shape issued before #908).
  it('a cookie without `sep`, valid until the first restore, is refused after it (#908)', async () => {
    const cookie = await t.login(t.owner.email);
    expect(
      jwt.decode(cookie.replace(/^access_token=/, '')),
      'a never-restored database issues no sep',
    ).not.toHaveProperty('sep');
    const get = (headers: Record<string, string>) =>
      t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { cookie, ...headers },
      });
    expect((await get({})).statusCode).toBe(200);

    await afterRestore(deps());

    const page = await get({});
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toMatch(/^\/auth\/login/);
    const fragment = await get({
      'hx-request': 'true',
      'sec-fetch-mode': 'cors',
    });
    expect(fragment.statusCode).toBe(401);
    expect(fragment.headers['hx-redirect']).toBe('/auth/login');
    await signOwnerInAgain();
  });

  it('after-restore bumps the epoch, revokes push, frees dead leases and lists missing originals, deleting and marking nothing', async () => {
    const gone = await garmentWithPhoto('Gone tee');
    await loseSet(gone.fileName);
    // Only its original lost: listed, and marked though its thumb is
    // stored: its pages load the nobg or the original (#917).
    const thumbOnly = await garmentWithPhoto('Thumb only');
    await rm(join(t.dataPath, thumbOnly.fileName));
    // A photo added after the dump: bytes with no row, two days old.
    const added = `${randomUUID()}.webp`;
    await writeFile(join(t.dataPath, added), 'bytes added after the dump');
    const then = new Date(Date.now() - 2 * DAY_MS);
    await utimes(join(t.dataPath, added), then, then);
    // A lease the dump brought back (a dead process's) and a live one.
    const dead = await garmentWithPhoto('Dead lease');
    const live = await garmentWithPhoto('Live lease');
    expect(
      await recordCutoutEvent(t.db, dead.fileName, {
        type: 'start',
        worker: 'dead:1:aaaa',
      }),
    ).toMatchObject({ ok: true });
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ cutoutStartedAt: sql`now() - interval '10 minutes'` })
        .where(eq(file.fileName, dead.fileName)),
    );
    expect(
      await recordCutoutEvent(t.db, live.fileName, {
        type: 'start',
        worker: 'live:1:bbbb',
      }),
    ).toMatchObject({ ok: true });
    await subscribeAs(t.db, t.owner.id, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/after-restore',
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    });

    const epochBefore = await currentEpoch();
    const filesBefore = await storedFiles();
    const rowsBefore = await t.db.$count(file);
    const report = await afterRestore(deps());

    expect(report.syncEpoch).not.toBe(epochBefore);
    expect(await currentEpoch()).toBe(report.syncEpoch);
    expect(report.pushDevicesRevoked).toBe(1);
    expect(await t.db.$count(userDevice)).toBe(0);
    expect(report.cutoutLeasesReleased).toBe(1);
    expect((await photoRow(t, dead.fileName))?.cutoutWorker).toBeNull();
    expect((await photoRow(t, live.fileName))?.cutoutWorker).toBe(
      'live:1:bbbb',
    );
    expect(report.missingOriginals).toEqual([
      {
        garmentId: gone.id,
        name: 'Gone tee',
        ownerId: t.owner.id,
        photo: gone.fileName,
      },
      {
        garmentId: thumbOnly.id,
        name: 'Thumb only',
        ownerId: t.owner.id,
        photo: thumbOnly.fileName,
      },
    ]);
    // A dry run: the quarantine, the pending pass and the marks only counted.
    expect(report.reconciliation).toMatchObject({
      dryRun: true,
      orphanedSetsQuarantined: 1,
      photosMarkedMissing: 2,
    });
    expect(await storedFiles()).toEqual(filesBefore);
    expect(await t.photos.storage.trash()).toEqual([]);
    expect(await t.db.$count(file)).toBe(rowsBefore);
    expect(
      await t.db.$count(file, sql`${file.originalMissingSince} is not null`),
    ).toBe(0);

    // Twice is safe: another epoch, nothing left to revoke or release.
    const again = await afterRestore(deps());
    expect(again.syncEpoch).not.toBe(report.syncEpoch);
    expect(again).toMatchObject({
      accessTokensRevoked: { mcp: 0, device: 0 },
      pushDevicesRevoked: 0,
      cutoutLeasesReleased: 0,
    });
    expect(again.missingOriginals).toEqual(report.missingOriginals);
    expect(await storedFiles()).toEqual(filesBefore);
    await signOwnerInAgain();
  });

  it('after-restore ends every session and revokes every agent and device token (#908)', async () => {
    const otherCookie = await t.register('restored@example.com');
    const agent = await createAccessToken(t);
    const { token: device } = await deviceToken(t);
    const me = (token: string) =>
      t.api(token, { method: 'GET', url: '/api/v1/me' });
    expect((await mcpRequest(t, agent, 'tools/list')).statusCode).toBe(200);
    expect((await me(device)).statusCode).toBe(200);

    const report = await afterRestore(deps());
    expect(report.accessTokensRevoked).toEqual({ mcp: 1, device: 1 });

    for (const cookie of [t.owner.cookie, otherCookie]) {
      const page = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { cookie },
      });
      expect(page.statusCode).toBe(302);
      expect(page.headers.location).toMatch(/^\/auth\/login/);
    }
    expect((await mcpRequest(t, agent, 'tools/list')).statusCode).toBe(401);
    expect((await me(device)).statusCode).toBe(401);

    // Every cookie issued after the restore carries the new epoch and stays
    // open: a sign-in, a registration, a new password's reissue.
    const opens = async (cookie: string) =>
      (await t.inject({ method: 'GET', url: '/wardrobe', headers: { cookie } }))
        .statusCode === 200;
    await signOwnerInAgain();
    expect(await opens(t.owner.cookie)).toBe(true);
    const registered = await t.register('joined-after@example.com');
    expect(await opens(registered)).toBe(true);
    const changed = await t.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'Another-pass-2',
        confirmPassword: 'Another-pass-2',
      },
      headers: { cookie: registered },
    });
    const reissued = changed.cookies.find((c) => c.name === 'access_token');
    expect(reissued?.value).toEqual(expect.any(String));
    expect(await opens(`access_token=${reissued?.value}`)).toBe(true);
  });

  it('reconciliation marks a photo with nothing left, every surface shows the placeholder, and the mark clears when its bytes are back', async () => {
    const garment = await garmentWithPhoto('Restored blazer');
    const uuid = garment.fileName.replace(/\.webp$/, '');
    const lost = await loseSet(garment.fileName);
    const before = await revisionOf(garment.id);

    const report = await reconcile();
    expect(report.photosMarkedMissing).toBeGreaterThanOrEqual(1);
    expect(report.marksFailed).toBeUndefined();
    expect(
      (await photoRow(t, garment.fileName))?.originalMissingSince,
    ).toBeInstanceOf(Date);
    const marked = await revisionOf(garment.id);
    expect(marked).toBeGreaterThan(before);

    const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(grid.statusCode).toBe(200);
    expect(grid.body).toContain('Restored blazer');
    expect(grid.body).not.toContain(uuid);
    const page = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garment.id}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(uuid);

    const { token } = await deviceToken(t);
    const read = async () => {
      const res = await t.api(token, {
        method: 'GET',
        url: `/api/v1/garments/${garment.id}`,
      });
      expect(res.statusCode).toBe(200);
      return res.json<{
        photo?: unknown;
        photoMissingSince?: string;
        revision: number;
      }>();
    };
    const missing = await read();
    expect(missing.photo).toBeUndefined();
    expect(missing.photoMissingSince).toEqual(expect.any(String));

    for (const [name, bytes] of lost)
      await writeFile(join(t.dataPath, name), bytes);
    const back = await reconcile();
    expect(back.photosNoLongerMissing).toBeGreaterThanOrEqual(1);
    expect(
      (await photoRow(t, garment.fileName))?.originalMissingSince,
    ).toBeNull();
    expect(await revisionOf(garment.id)).toBeGreaterThan(marked);
    const shown = await read();
    expect(shown.photo).toBeDefined();
    expect(shown.photoMissingSince).toBeUndefined();
  });

  it('a marked photo is still its garment’s to every write: an edit keeps it, a new photo and a delete remove its row', async () => {
    const edited = await markedGarment('Kept through an edit');
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${edited.id}`,
      payload: { name: 'Edited while missing', category: 'shirt' },
    });
    expect(res.statusCode).toBe(302);
    const row = await garmentRow(t, edited.id);
    expect(row?.name).toBe('Edited while missing');
    expect(row?.photo?.fileName).toBe(edited.fileName);
    expect(row?.photo?.originalMissingSince).toBeInstanceOf(Date);

    const exported = await t.inject({
      method: 'GET',
      url: '/wardrobe/export.json',
    });
    const bundle = exported.json<{
      garments: { id: number; photo: unknown }[];
    }>();
    expect(bundle.garments.find((g) => g.id === edited.id)?.photo).toBeNull();

    const replaced = await markedGarment('New photo');
    await uploadPhoto(t, replaced.id, await jpegPhoto());
    const now = await garmentRow(t, replaced.id);
    expect(now?.photo?.fileName).not.toBe(replaced.fileName);
    expect(now?.photo?.originalMissingSince).toBeNull();
    expect(await photoRow(t, replaced.fileName)).toBeUndefined();

    const deleted = await markedGarment('Deleted while missing');
    const gone = await t.inject({
      method: 'DELETE',
      url: `/wardrobe/${deleted.id}`,
    });
    expect(gone.statusCode).toBe(200);
    expect(await garmentRow(t, deleted.id)).toBeUndefined();
    expect(await photoRow(t, deleted.fileName)).toBeUndefined();
    expect(await setFiles(deleted.fileName)).toEqual([]);
  });

  /** Copies the photo's thumb as a nobg and thumb under `key`: a set in storage. */
  const storeSetUnder = async (
    fileName: string,
    key: string,
    from = fileName,
  ) => {
    const source = (await setFiles(from)).find((name) =>
      name.includes('-thumb'),
    )!;
    for (const variant of ['nobg', 'thumb'] as const) {
      await copyFile(
        join(t.dataPath, source),
        join(t.dataPath, variantFileName(fileName, variant, key)),
      );
    }
  };
  const repoint = (photo: string, key: string) =>
    repointCutout(
      { db: t.db, storage: t.photos.storage, logger: silentLogger },
      photo,
      key,
    );

  it('repoint-cutout moves an edited row through rederive, its status kept and its garment’s revision moved', async () => {
    const garment = await garmentWithPhoto('Restored mask');
    await t.photos.saveEditedCutout(
      Readable.from(await pngCutout()),
      garment.fileName,
    );
    const row = (await photoRow(t, garment.fileName))!;
    expect(row.cutoutStatus).toBe('edited');
    await storeSetUnder(garment.fileName, 'abcdef012345');
    const before = await revisionOf(garment.id);

    expect(await repoint(garment.fileName, 'abcdef012345')).toMatchObject({
      repointed: true,
      from: row.variantKey,
      to: 'abcdef012345',
      status: 'edited',
      version: row.version + 1,
    });
    expect(await photoRow(t, garment.fileName)).toMatchObject({
      variantKey: 'abcdef012345',
      version: row.version + 1,
      cutoutStatus: 'edited',
    });
    expect(await revisionOf(garment.id)).toBeGreaterThan(before);

    // Files not in storage: refused, the row as it was.
    expect(await repoint(garment.fileName, '0123456789ab')).toMatchObject({
      repointed: false,
      refused: expect.stringContaining('not in storage'),
    });
    expect((await photoRow(t, garment.fileName))?.variantKey).toBe(
      'abcdef012345',
    );
  });

  it('repoint-cutout on a pending row takes edit, and the running job’s result is then refused', async () => {
    const garment = await garmentWithPhoto('Pending at the restore');
    const started = await recordCutoutEvent(t.db, garment.fileName, {
      type: 'start',
      worker: 'job:1:cccc',
    });
    expect(started).toMatchObject({ ok: true });
    const jobVersion = (await photoRow(t, garment.fileName))!.version;
    await storeSetUnder(garment.fileName, 'fedcba987654');

    expect(await repoint(garment.fileName, 'fedcba987654')).toMatchObject({
      repointed: true,
      status: 'edited',
    });
    expect(await photoRow(t, garment.fileName)).toMatchObject({
      cutoutStatus: 'edited',
      cutoutWorker: null,
    });
    expect(
      await recordCutoutEvent(t.db, garment.fileName, {
        type: 'succeed',
        jobVersion,
        variantKey: '111111111111',
      }),
    ).toMatchObject({ ok: false });
    expect((await photoRow(t, garment.fileName))?.variantKey).toBe(
      'fedcba987654',
    );
  });

  it('repoint-cutout unkeyed on a pending row takes edit, not the already-there shortcut, and the job’s result is refused', async () => {
    const garment = await garmentWithPhoto('Pending, unkeyed set');
    await recordCutoutEvent(t.db, garment.fileName, {
      type: 'start',
      worker: 'job:2:dddd',
    });
    const jobVersion = (await photoRow(t, garment.fileName))!.version;
    const thumb = (await setFiles(garment.fileName)).find((name) =>
      name.includes('-thumb'),
    )!;
    for (const variant of ['nobg', 'thumb'] as const) {
      const target = variantFileName(garment.fileName, variant, null);
      if (target !== thumb)
        await copyFile(join(t.dataPath, thumb), join(t.dataPath, target));
    }

    expect(await repoint(garment.fileName, 'unkeyed')).toMatchObject({
      repointed: true,
      status: 'edited',
    });
    expect(await photoRow(t, garment.fileName)).toMatchObject({
      cutoutStatus: 'edited',
      cutoutWorker: null,
    });
    expect(
      await recordCutoutEvent(t.db, garment.fileName, {
        type: 'succeed',
        jobVersion,
        variantKey: '222222222222',
      }),
    ).toMatchObject({ ok: false });
  });

  it('a lone thumb is no photo to its pages: marked without the original and the nobg, not with the nobg (#917)', async () => {
    const thumbOnly = await garmentWithPhoto('Thumb alone');
    const withCutout = await garmentWithPhoto('Cutout kept');
    // The row's own (unkeyed) nobg, which its pages load without the original.
    await copyFile(
      join(t.dataPath, withCutout.fileName),
      join(t.dataPath, variantFileName(withCutout.fileName, 'nobg')),
    );
    for (const { fileName } of [thumbOnly, withCutout]) {
      expect(await setFiles(fileName)).toContain(
        variantFileName(fileName, 'thumb'),
      );
      await rm(join(t.dataPath, fileName));
    }

    await reconcile();
    expect(
      (await photoRow(t, thumbOnly.fileName))?.originalMissingSince,
    ).toBeInstanceOf(Date);
    expect(
      (await photoRow(t, withCutout.fileName))?.originalMissingSince,
    ).toBeNull();
  });

  it('the missing-originals statement binds the names once, so its parameter count does not grow with them (#916)', () => {
    const names = (n: number) =>
      Array.from({ length: n }, () => `${randomUUID()}.webp`);
    const small = garmentsShowingStatement(t.db, names(2)).toSQL();
    const large = garmentsShowingStatement(t.db, names(30_000)).toSQL();
    expect(large.params.length).toBe(small.params.length);
    expect(large.params.length).toBeLessThan(5);
  });

  it('the marks statement binds each id set once, so its parameter count does not grow with the ids', () => {
    const marks = (n: number) => ({
      mark: Array.from({ length: n }, (_, i) => i + 1),
      clear: Array.from({ length: n }, (_, i) => n + i + 1),
    });
    const small = missingMarksStatement(t.db, marks(2)).toSQL();
    const large = missingMarksStatement(t.db, marks(30_000)).toSQL();
    expect(large.params.length).toBe(small.params.length);
    expect(large.params.length).toBeLessThan(10);
  });

  it('the mark counts are the rows the UPDATE changed: a row its WHERE skips is not counted', async () => {
    const already = await markedGarment('Already marked');
    const fresh = await garmentWithPhoto('Not yet marked');
    const alreadyId = (await photoRow(t, already.fileName))!.id;
    const freshId = (await photoRow(t, fresh.fileName))!.id;
    // `mark` names both; the already-marked row is re-asserted out.
    expect(
      await writeMissingMarks(
        { db: t.db, logger: silentLogger } as Parameters<
          typeof writeMissingMarks
        >[0],
        { mark: [alreadyId, freshId], clear: [] },
      ),
    ).toEqual({ marked: 1, cleared: 0 });
  });

  it('repoint-cutout clears a missing mark once its files are stored', async () => {
    const helper = await garmentWithPhoto('Bytes donor');
    const garment = await markedGarment('Repointed back');
    await storeSetUnder(garment.fileName, '0a0b0c0d0e0f', helper.fileName);
    const before = await revisionOf(garment.id);
    expect(await repoint(garment.fileName, '0a0b0c0d0e0f')).toMatchObject({
      repointed: true,
      unmarked: true,
    });
    expect(
      (await photoRow(t, garment.fileName))?.originalMissingSince,
    ).toBeNull();
    expect(await revisionOf(garment.id)).toBeGreaterThan(before);
  });

  it('the by-hand recipe in src/db/AGENTS.md passes the sync triggers, and the same write without it does not', async () => {
    const doc = await readFile(join(PROJECT_ROOT, 'src/db/AGENTS.md'), 'utf8');
    const recipe = /<!-- by-hand-recipe -->\n```sql\n([\s\S]*?)```/.exec(
      doc,
    )?.[1];
    if (!recipe) throw new Error('No by-hand recipe in src/db/AGENTS.md');
    const id = await createGarment(t, { name: 'Shirt' });
    const before = await revisionOf(id);

    await expect(
      t.db.execute(sql`update garment set name = 'Unlocked' where id = ${id}`),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/owner lock not held/) },
    });

    // psql's variables, as the operator passes them with -v.
    const filled = recipe
      .replaceAll(':owner', String(t.owner.id))
      .replaceAll(':garment', String(id));
    await t.db.$client.query(filled);
    const row = await garmentRow(t, id);
    expect(row?.name).toBe('Linen shirt');
    expect(row!.revision).toBeGreaterThan(before);
  });

  it('a missing sync_epoch row is corruption, not "never restored": every session is refused and logged', async () => {
    const cookie = await t.login(t.owner.email);
    await t.db.delete(syncEpoch);
    try {
      const page = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { cookie },
      });
      expect(page.statusCode).toBe(302);
      expect(page.headers.location).toMatch(/^\/auth\/login/);
      const fragment = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: {
          cookie,
          'hx-request': 'true',
          'sec-fetch-mode': 'cors',
        },
      });
      expect(fragment.statusCode).toBe(401);
      expect(t.logs.messages('error', 'Session').length).toBeGreaterThan(0);
    } finally {
      await t.db.insert(syncEpoch).values({});
    }
    await signOwnerInAgain();
  });
});
