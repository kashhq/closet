import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { file, selfie } from '../../src/db/schema';
import {
  reconcileStorage,
  reconcileStorageWhole,
  type ReconcileOptions,
  type ReconciliationReport,
} from '../../src/maintenance/reconcile';
import { PartialFailure } from '../../src/metrics/partial-failure';
import { restoreFromTrash } from '../../src/maintenance/trash';
import { addDays, todayIn } from '../../src/calendar-date';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  PhotoStorage,
  RestoreFailed,
  STORAGE_MARKER,
  TRASH_DIR,
} from '../../src/web/files/storage';
import { captureLogs } from '../support/log-capture';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  photoRowCount,
  pngCutout,
  uploadPhoto,
} from './garments';
import { createTestApp, TestApp, asFixture } from './harness';
import { silentLogger } from './logger';
import { planEntry, takeSelfie } from './selfies';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The three reconciliation passes against the real app: storage without
 * rows, rows without garments, rows without storage. The deletion guard
 * has its own spec (reconcile-guard.spec.ts).
 */
describe('storage reconciliation', () => {
  let t: TestApp;
  const reconcile = (options?: ReconcileOptions) =>
    reconcileStorage(
      {
        db: t.db,
        photos: t.photos,
        logger: silentLogger,
        timeZone: t.timeZone,
      },
      options,
    );

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();

  const writeAged = async (name: string, ageMs: number) => {
    const path = join(t.dataPath, name);
    await writeFile(path, `bytes of ${name}`);
    const then = new Date(Date.now() - ageMs);
    await utimes(path, then, then);
  };

  const ageRow = async (fileName: string, ageMs: number) => {
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ createdOn: new Date(Date.now() - ageMs).toISOString() })
        .where(eq(file.fileName, fileName)),
    );
  };

  const orphanRow = async (ageMs: number) => {
    const fileName = `${randomUUID()}.webp`;
    await asFixture(t.db, (tx) =>
      tx.insert(file).values({
        fileName,
        shareableId: randomUUID(),
        createdOn: new Date(Date.now() - ageMs).toISOString(),
        createdById: t.owner.id,
      }),
    );
    return fileName;
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('deletes stale orphans only, reports lost originals, and a dry run changes nothing', async () => {
    // A live photo: row referenced by a garment, bytes present. Untouchable.
    const liveGarment = await createGarment(t, { name: 'Live' });
    await uploadPhoto(t, liveGarment, await jpegPhoto());
    const live = await photoFileName(t, liveGarment);
    await ageRow(live, 3 * DAY_MS);

    // A referenced row whose original vanished from disk: reported, kept.
    const lostGarment = await createGarment(t, { name: 'Lost' });
    await uploadPhoto(t, lostGarment, await jpegPhoto(300, 300));
    const lost = await photoFileName(t, lostGarment);
    await ageRow(lost, 3 * DAY_MS);
    await rm(join(t.dataPath, lost));

    // Storage without rows: a two-day-old full set and a fresh original.
    const staleOrphan = `${randomUUID()}.webp`;
    for (const variant of ['original', 'nobg', 'thumb'] as const) {
      await writeAged(variantFileName(staleOrphan, variant), 2 * DAY_MS);
    }
    const recentOrphan = `${randomUUID()}.webp`;
    await writeAged(recentOrphan, 0);

    // Rows without garments: one old (with bytes), one from just now.
    const staleRow = await orphanRow(2 * DAY_MS);
    await writeAged(staleRow, 2 * DAY_MS);
    await writeAged(variantFileName(staleRow, 'thumb'), 2 * DAY_MS);
    const recentRow = await orphanRow(0);

    // Not a photo: whatever else lives under DATA_PATH stays.
    await writeAged('notes.txt', 5 * DAY_MS);

    const filesBefore = await storedFiles();
    const rowsBefore = await photoRowCount(t);
    // Files only: DATA_PATH/.incoming (in-flight writes) is not an object,
    // nor is the storage marker.
    const objectsBefore = (
      await readdir(t.dataPath, { withFileTypes: true })
    ).filter((entry) => entry.isFile() && entry.name !== STORAGE_MARKER).length;
    const expected: Omit<ReconciliationReport, 'durationMs' | 'dryRun'> = {
      storedObjects: objectsBefore,
      // live, lost (its thumb), staleOrphan, recentOrphan, staleRow
      storedPhotoSets: 5,
      orphanedSetsQuarantined: 1,
      trashSetsPurged: 0,
      orphanedRowsDeleted: 1,
      missingOriginals: 1,
      missingOriginalPhotos: [lost],
      // `lost` keeps only its thumb: its pages cannot show it (#917).
      photosMarkedMissing: 1,
      photosNoLongerMissing: 0,
      // Link imports have their own pass (link-import.spec.ts).
      pendingPhotosDeleted: 0,
      pendingRowsWithoutFiles: 0,
      supersededVariantsDeleted: 0,
    };

    const dryRun = await reconcile({ dryRun: true });
    expect(dryRun).toMatchObject({ ...expected, dryRun: true });
    expect(dryRun.refused).toBeUndefined();
    expect(await storedFiles()).toEqual(filesBefore);
    expect(await photoRowCount(t)).toBe(rowsBefore);

    const report = await reconcile();
    expect(report).toMatchObject({ ...expected, dryRun: false });
    expect(report.refused).toBeUndefined();

    const files = await storedFiles();
    expect(files).toContain(live);
    expect(files).toContain(variantFileName(live, 'thumb'));
    expect(files).toContain(variantFileName(lost, 'thumb'));
    expect(files).toContain(recentOrphan);
    for (const variant of ['original', 'nobg', 'thumb'] as const) {
      expect(files).not.toContain(variantFileName(staleOrphan, variant));
    }
    // Quarantined, not deleted (#649).
    expect((await t.photos.storage.trash()).map((set) => set.entry)).toContain(
      staleOrphan,
    );
    expect(files).not.toContain(staleRow);
    expect(files).not.toContain(variantFileName(staleRow, 'thumb'));
    expect(await readdir(t.dataPath)).toContain('notes.txt');

    expect(await photoRow(t, live)).toBeDefined();
    expect(await photoRow(t, lost)).toBeDefined();
    expect(await photoRow(t, recentRow)).toBeDefined();
    expect(await photoRow(t, staleRow)).toBeUndefined();
    expect(await photoRowCount(t)).toBe(rowsBefore - 1);

    // A second pass finds nothing new to delete.
    const again = await reconcile();
    expect(again).toMatchObject({
      orphanedSetsQuarantined: 0,
      orphanedRowsDeleted: 0,
      missingOriginals: 1,
    });
  });

  // #141: a cutout is stored under a variant key before its row points at
  // it, so a write that died before its swap (or whose clean-up failed)
  // leaves files the base name alone cannot tell from the live ones.
  /** A garment photo with a mask edit: its row keyed, its set aged `ageMs`. */
  const keyedPhoto = async (name: string, ageMs: number) => {
    const garmentId = await createGarment(t, { name });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
    await ageRow(fileName, 5 * DAY_MS);
    await t.photos.saveEditedCutout(Readable.from(await pngCutout()), fileName);
    const { variantKey } = (await photoRow(t, fileName))!;
    const current = variantSet(fileName, variantKey);
    const then = new Date(Date.now() - ageMs);
    for (const name of current) {
      await utimes(join(t.dataPath, name), then, then);
    }
    return { fileName, variantKey, current };
  };

  const variantSet = (fileName: string, key: string | null) =>
    (['nobg', 'thumb'] as const).map((variant) =>
      variantFileName(fileName, variant, key),
    );

  const reconcileLogged = (options?: ReconcileOptions) =>
    reconcileStorage(
      { db: t.db, photos: t.photos, logger: t.logger, timeZone: t.timeZone },
      options,
    );

  it("deletes a live photo's day-old variants under another key than its row's", async () => {
    // Old as they are, the row's own files stay.
    const { fileName, current } = await keyedPhoto('Recut', 2 * DAY_MS);
    // Older than the row's set: a write that died before an earlier swap.
    const died = variantSet(fileName, '0123456789ab');
    for (const name of died) await writeAged(name, 3 * DAY_MS);
    // A thumb backfilled for a request that raced the swap.
    const unkeyedThumb = variantFileName(fileName, 'thumb');
    await writeAged(unkeyedThumb, 3 * DAY_MS);
    // A write between its files and its swap right now.
    const inFlight = variantFileName(fileName, 'nobg', 'abcdefabcdef');
    await writeAged(inFlight, 0);

    const dryRun = await reconcile({ dryRun: true });
    expect(dryRun.supersededVariantsDeleted).toBe(3);
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([...died, unkeyedThumb]),
    );

    const report = await reconcile();
    expect(report.refused).toBeUndefined();
    expect(report.supersededVariantsDeleted).toBe(3);
    const files = await storedFiles();
    expect(files).toEqual(
      expect.arrayContaining([fileName, ...current, inFlight]),
    );
    for (const name of [...died, unkeyedThumb]) {
      expect(files).not.toContain(name);
    }
    expect((await reconcile()).supersededVariantsDeleted).toBe(0);
  });

  // A database restored from a backup taken before an edit: the row names
  // the older key, and the newer set is the photo's real cutout. Deleting
  // it would lose the only copy; before #141 a restore never deleted bytes.
  it("keeps a set newer than the row's, warning of a restore behind storage", async () => {
    const { fileName, variantKey, current } = await keyedPhoto(
      'Restored',
      4 * DAY_MS,
    );
    const newer = variantSet(fileName, 'fedcba987654');
    for (const name of newer) await writeAged(name, 2 * DAY_MS);
    t.logs.clear();

    const report = await reconcileLogged();

    expect(report.supersededVariantsDeleted).toBe(0);
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([...current, ...newer]),
    );
    expect(t.logs.messages('warn')).toContainEqual(
      `Keeping variant key fedcba987654 of ${fileName}: newer than the row's variant (key ${variantKey}): database restored behind storage?`,
    );
  });

  // A thumb backfilled across a swap: a request that resolved the old key
  // regenerates its thumb after the swap deleted it. Derived, never the one
  // copy of anything, so no restore warning keeps it.
  it("deletes a lone superseded thumb newer than the row's set, without a restore warning", async () => {
    const { fileName, current } = await keyedPhoto('Backfilled', 4 * DAY_MS);
    const loneThumb = variantFileName(fileName, 'thumb', 'aaaaaaaaaaaa');
    await writeAged(loneThumb, 2 * DAY_MS);
    t.logs.clear();

    const report = await reconcileLogged();

    expect(report.supersededVariantsDeleted).toBe(1);
    const files = await storedFiles();
    expect(files).not.toContain(loneThumb);
    expect(files).toEqual(expect.arrayContaining(current));
    expect(
      t.logs.messages('warn').filter((message) => message.includes(fileName)),
    ).toEqual([]);
  });

  it("keeps a lone superseded cutout newer than the row's set, with the warning", async () => {
    const { fileName, variantKey } = await keyedPhoto('Lone cut', 4 * DAY_MS);
    const loneNobg = variantFileName(fileName, 'nobg', 'bbbbbbbbbbbb');
    await writeAged(loneNobg, 2 * DAY_MS);
    t.logs.clear();

    await reconcileLogged();

    expect(await storedFiles()).toContain(loneNobg);
    expect(t.logs.messages('warn')).toContainEqual(
      `Keeping variant key bbbbbbbbbbbb of ${fileName}: newer than the row's variant (key ${variantKey}): database restored behind storage?`,
    );
  });

  it("deletes nothing of a photo whose row's own set is missing", async () => {
    const { fileName, variantKey, current } = await keyedPhoto(
      'Lost cut',
      2 * DAY_MS,
    );
    for (const name of current) await rm(join(t.dataPath, name));
    const older = variantSet(fileName, '0123456789ab');
    for (const name of older) await writeAged(name, 3 * DAY_MS);
    t.logs.clear();

    const report = await reconcileLogged();

    expect(report.supersededVariantsDeleted).toBe(0);
    expect(await storedFiles()).toEqual(expect.arrayContaining(older));
    expect(t.logs.messages('warn')).toContainEqual(
      `Keeping every variant of ${fileName}: the files of its row's variant (key ${variantKey}) are not in storage`,
    );
  });

  describe('the quarantine (#649)', () => {
    const now = new Date();
    const today = () => todayIn(t.timeZone, now);
    const reconcileAt = (at: Date = now) =>
      reconcileStorage(
        {
          db: t.db,
          photos: t.photos,
          logger: silentLogger,
          timeZone: t.timeZone,
        },
        { now: at },
      );
    const hashOf = async (path: string) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    const trashPath = (...parts: string[]) =>
      join(t.dataPath, TRASH_DIR, ...parts);
    const listed = async () => {
      const names: string[] = [];
      for await (const object of t.photos.storage.list()) {
        names.push(object.name);
      }
      return names;
    };

    /** A two-day-old photo set with no row: what a database restore leaves. */
    const restoredAway = async () => {
      const baseName = `${randomUUID()}.webp`;
      const names = (['original', 'nobg', 'thumb'] as const).map((variant) =>
        variantFileName(baseName, variant),
      );
      for (const name of names) await writeAged(name, 2 * DAY_MS);
      const hashes = await Promise.all(
        names.map((name) => hashOf(join(t.dataPath, name))),
      );
      return { baseName, names, hashes };
    };

    it('moves a day-old set with no row to .trash/<today>/ with its bytes, and restores it', async () => {
      const { baseName, names, hashes } = await restoredAway();

      const report = await reconcileAt();
      expect(report.refused).toBeUndefined();
      expect(report.orphanedSetsQuarantined).toBe(1);
      const afterRun = await listed();
      for (const name of names) expect(afterRun).not.toContain(name);
      for (const [i, name] of names.entries()) {
        expect(await hashOf(trashPath(today(), baseName, name))).toBe(
          hashes[i],
        );
      }
      // The trash is not storage: nothing in it is an orphan again.
      expect((await reconcileAt()).orphanedSetsQuarantined).toBe(0);

      expect(
        await restoreFromTrash(t.photos.storage, baseName, silentLogger, now),
      ).toMatchObject({ restored: [{ day: today(), entry: baseName }] });
      expect(await listed()).toEqual(expect.arrayContaining(names));
      for (const [i, name] of names.entries()) {
        expect(await hashOf(join(t.dataPath, name))).toBe(hashes[i]);
      }
      expect(
        (await t.photos.storage.trash()).some((set) => set.entry === baseName),
      ).toBe(false);
      // Stamped at the restore: the 03:00 run hours later leaves it a day.
      const hoursLater = new Date(now.getTime() + 6 * 60 * 60 * 1000);
      expect((await reconcileAt(hoursLater)).orphanedSetsQuarantined).toBe(0);
      expect(await listed()).toEqual(expect.arrayContaining(names));
      await t.photos.deleteFiles(names);
    });

    it('restores a set a failed quarantine split across entries, whole', async () => {
      const { baseName, names, hashes } = await restoredAway();
      const [original, ...variants] = names;
      await t.photos.storage.quarantine(baseName, [original], today());
      const rest = await t.photos.storage.quarantine(
        baseName,
        variants,
        today(),
      );
      expect(rest?.entry).not.toBe(baseName);

      const outcome = await restoreFromTrash(
        t.photos.storage,
        baseName,
        silentLogger,
        now,
      );
      expect(outcome).toHaveProperty('restored', expect.any(Array));
      for (const [i, name] of names.entries()) {
        expect(await hashOf(join(t.dataPath, name))).toBe(hashes[i]);
      }
      expect(
        (await t.photos.storage.trash()).some((set) =>
          set.entry.startsWith(baseName),
        ),
      ).toBe(false);
      await t.photos.deleteFiles(names);
    });

    it('never overwrites: a second set of a name gets its own entry, and a live set refuses the restore', async () => {
      const { baseName, names, hashes } = await restoredAway();
      const first = await t.photos.storage.quarantine(baseName, names, today());
      for (const name of names) await writeAged(name, 2 * DAY_MS);
      const second = await t.photos.storage.quarantine(
        baseName,
        names,
        today(),
      );
      expect(first?.entry).toBe(baseName);
      expect(second?.entry).toMatch(new RegExp(`^${baseName}~[0-9a-f]{8}$`));
      expect(await hashOf(trashPath(today(), baseName, names[0]))).toBe(
        hashes[0],
      );

      // Both match the base name: the operator names one.
      expect(
        await restoreFromTrash(t.photos.storage, baseName, silentLogger),
      ).toHaveProperty('refused', expect.stringContaining('more than once'));
      expect(
        await restoreFromTrash(
          t.photos.storage,
          `${today()}/${second!.entry}`,
          silentLogger,
        ),
      ).toHaveProperty('restored');
      // Its set is live now, so the other copy may not land on it.
      expect(
        await restoreFromTrash(
          t.photos.storage,
          `${today()}/${baseName}`,
          silentLogger,
        ),
      ).toHaveProperty('refused', expect.stringContaining('already holds'));
      expect(await hashOf(trashPath(today(), baseName, names[0]))).toBe(
        hashes[0],
      );
      await t.photos.deleteFiles(names);
    });

    // #841: the outcome line says what storage holds, and a partial
    // outcome is finished by running the restore again.
    describe('a restore that fails partway', () => {
      const eio = () =>
        Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      /** Storage whose `fail`-matching calls reject with EIO, once each. */
      const failingStorage = (fail: {
        link?: (to: string) => boolean;
        remove?: (file: string) => boolean;
      }) => {
        const failed = new Set<string>();
        const once = (kind: string, path: string, matches?: boolean) =>
          matches === true && !failed.has(`${kind} ${path}`)
            ? (failed.add(`${kind} ${path}`), true)
            : false;
        return new PhotoStorage(t.dataPath, silentLogger, {
          readText: (path) => readFile(path, 'utf8'),
          writeNew: (path, text) => writeFile(path, text, { flag: 'wx' }),
          link: (from, to) =>
            once('link', to, fail.link?.(to)) ? eio() : link(from, to),
          rename: (from, to) => rename(from, to),
          remove: (path) =>
            once('remove', path, fail.remove?.(path))
              ? eio()
              : rm(path, { force: true }),
        });
      };
      const expectRestored = async (names: string[], hashes: string[]) => {
        for (const [i, name] of names.entries()) {
          expect(await hashOf(join(t.dataPath, name))).toBe(hashes[i]);
        }
      };

      it('once live, says the trash kept a name (never "rolled back"), and a second run clears it', async () => {
        const { baseName, names, hashes } = await restoredAway();
        await t.photos.storage.quarantine(baseName, names, today());
        const { logger, logs } = captureLogs();
        const stuck = failingStorage({
          remove: (path) => path === trashPath(today(), baseName, names[0]),
        });

        expect(
          await restoreFromTrash(stuck, baseName, logger, now),
        ).toMatchObject({
          restored: [{ entry: baseName }],
          leftInTrash: [`${today()}/${baseName}/${names[0]}`],
        });
        await expectRestored(names, hashes);
        expect(logs.messages('warn')).toEqual([
          `Restored, but .trash still holds ${today()}/${baseName}/${names[0]}; run --restore-from-trash ${baseName} again to clear it`,
        ]);

        // The live original is the trash file itself: no refusal.
        expect(
          await restoreFromTrash(t.photos.storage, baseName, silentLogger, now),
        ).toMatchObject({ restored: [{ entry: baseName }], leftInTrash: [] });
        await expectRestored(names, hashes);
        expect(
          (await t.photos.storage.trash()).some((s) => s.entry === baseName),
        ).toBe(false);
        await t.photos.deleteFiles(names);
      });

      it('rolled back but for a name it could not unlink: says so, and a second run restores the rest', async () => {
        const { baseName, names, hashes } = await restoredAway();
        await t.photos.storage.quarantine(baseName, names, today());
        // In the order the restore links them: the trash lists them sorted.
        const [first, second, third] = [...names].sort();
        const { logger, logs } = captureLogs();
        const stuck = failingStorage({
          link: (to) => to === join(t.dataPath, third),
          remove: (path) => path === join(t.dataPath, first),
        });

        await expect(
          restoreFromTrash(stuck, baseName, logger, now),
        ).rejects.toBeInstanceOf(RestoreFailed);
        expect(logs.messages('warn')).toEqual([
          `Restore of ${today()}/${baseName} failed; ${first} could not be taken back (live, and still in the trash); run --restore-from-trash ${baseName} again`,
        ]);
        // Only the stranded one is live; the trash still holds all three.
        const live = await listed();
        expect(live).toContain(first);
        expect(live).not.toContain(second);
        for (const [i, name] of names.entries()) {
          expect(await hashOf(trashPath(today(), baseName, name))).toBe(
            hashes[i],
          );
        }

        expect(
          await restoreFromTrash(t.photos.storage, baseName, silentLogger, now),
        ).toMatchObject({ restored: [{ entry: baseName }], leftInTrash: [] });
        await expectRestored(names, hashes);
        await t.photos.deleteFiles(names);
      });
    });

    it('purges trash days past the retention, never newer ones or foreign directories', async () => {
      const expired = addDays(today(), -31);
      const kept = addDays(today(), -30);
      for (const day of [expired, kept]) {
        await mkdir(trashPath(day, `${randomUUID()}.webp`), {
          recursive: true,
        });
      }
      await mkdir(trashPath('not-a-day'), { recursive: true });

      const report = await reconcileAt();
      expect(report.refused).toBeUndefined();
      expect(report.trashSetsPurged).toBe(1);
      const left = await readdir(trashPath());
      expect(left).not.toContain(expired);
      expect(left).toContain(kept);
      expect(left).toContain('not-a-day');

      // The clock is the run's: a day later the kept one is past it too.
      const later = await reconcileAt(new Date(now.getTime() + DAY_MS));
      expect(later.trashSetsPurged).toBe(1);
      expect(await readdir(trashPath())).not.toContain(kept);
    });
  });
});

/**
 * Outfit selfies (#19) are photos no garment points at: before
 * photoIsReferenced counted them, every one was an unreferenced `file` row
 * and the night after it was taken reconciliation deleted it, row and
 * bytes. An entry's selfie and a look kept after its outfit was deleted
 * (no entry any more) must both survive, a day old and older, beside a
 * real orphan the same run deletes.
 */
describe('storage reconciliation and outfit selfies', () => {
  let t: TestApp;

  const age = async (fileName: string, ageMs: number) => {
    const then = new Date(Date.now() - ageMs);
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ createdOn: then.toISOString() })
        .where(eq(file.fileName, fileName)),
    );
    const stored = await readdir(t.dataPath);
    for (const variant of ['original', 'nobg', 'thumb'] as const) {
      const name = variantFileName(fileName, variant);
      if (stored.includes(name))
        await utimes(join(t.dataPath, name), then, then);
    }
  };

  /** An outfit planned on `day` with a selfie taken; its ids and photo. */
  const selfieOn = async (name: string, day: string) => {
    const garmentId = await createGarment(t, { name: `${name} shirt` });
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: { name, category: 'shirt', garmentId: String(garmentId) },
    });
    const outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(res.headers.location as string)![1],
    );
    const entryId = await planEntry(t, outfitId, day);
    return { outfitId, ...(await takeSelfie(t, entryId)) };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('never deletes a selfie as an orphan, an entry’s or a look kept after its outfit', async () => {
    const day = addDays(t.today(), -3);
    const entrySelfie = await selfieOn('Date night', day);
    const kept = await selfieOn('Deleted later', day);
    const deleted = await t.inject({
      method: 'DELETE',
      url: `/outfits/${kept.outfitId}`,
      headers: { 'hx-request': 'true' },
    });
    expect(deleted.statusCode).toBe(200);
    const [look] = await t.db
      .select({ entry: selfie.outfitCalendarId })
      .from(selfie)
      .where(eq(selfie.id, kept.id));
    expect(look.entry).toBeNull();

    // A real orphan: a `file` row nothing references, with its bytes.
    const orphan = `${randomUUID()}.webp`;
    await asFixture(t.db, (tx) =>
      tx.insert(file).values({
        fileName: orphan,
        shareableId: randomUUID(),
        createdOn: new Date().toISOString(),
        createdById: t.owner.id,
      }),
    );
    await writeFile(join(t.dataPath, orphan), 'bytes of an orphan');
    for (const name of [entrySelfie.fileName, kept.fileName, orphan]) {
      await age(name, 3 * DAY_MS);
    }

    const report = await reconcileStorage({
      db: t.db,
      photos: t.photos,
      timeZone: t.timeZone,
      logger: silentLogger,
    });

    expect(report.refused).toBeUndefined();
    expect(report).toMatchObject({
      orphanedRowsDeleted: 1,
      orphanedSetsQuarantined: 0,
      missingOriginals: 0,
    });
    const files = await readdir(t.dataPath);
    for (const { fileName } of [entrySelfie, kept]) {
      expect(await photoRow(t, fileName)).toBeDefined();
      expect(files).toContain(fileName);
      expect(files).toContain(variantFileName(fileName, 'thumb'));
    }
    expect(
      await t.db.$count(selfie, inArray(selfie.id, [entrySelfie.id, kept.id])),
    ).toBe(2);
    expect(await photoRow(t, orphan)).toBeUndefined();
    expect(files).not.toContain(orphan);
  });

  it('ends the nightly run as a PartialFailure while a row lacks its original (#687)', async () => {
    const lostGarment = await createGarment(t, {
      name: 'Lost for the nightly',
    });
    await uploadPhoto(t, lostGarment, await jpegPhoto(310, 310));
    const lost = await photoFileName(t, lostGarment);
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ createdOn: new Date(Date.now() - 3 * DAY_MS).toISOString() })
        .where(eq(file.fileName, lost)),
    );
    await rm(join(t.dataPath, lost));

    const failure = await reconcileStorageWhole({
      db: t.db,
      photos: t.photos,
      logger: silentLogger,
      timeZone: t.timeZone,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PartialFailure);
    expect(failure).toMatchObject({
      job: 'reconciliation',
      counts: { 'rows missing their original': expect.any(Number) },
    });
    expect(failure).not.toHaveProperty('counts.refused');
  });
});
