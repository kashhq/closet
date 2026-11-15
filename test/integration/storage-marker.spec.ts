import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { file, garment, install, pendingPhoto } from '../../src/db/schema';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import {
  PhotoStorage,
  STORAGE_MARKER,
  type StorageMarker,
} from '../../src/web/files/storage';
import {
  claimStorage,
  repairStorageIdentity,
  StorageIdentityError,
  storageIdentityProblem,
} from '../../src/web/files/storage-identity';
import { captureLogs } from '../support/log-capture';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  uploadPhoto,
} from './garments';
import { asFixture, createTestApp, type TestApp } from './harness';
import { silentLogger } from './logger';

const TWO_DAYS_AGO = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const installIdOf = (text: string) =>
  (JSON.parse(text) as StorageMarker).installId;
const OTHER_INSTALL =
  /^DATA_PATH holds the \.closet-storage of another install than the one this database belongs to/;

/**
 * #650: DATA_PATH's identity is a marker, never its contents. An unmounted
 * NFS share is a writable, empty mountpoint: without the marker the boot
 * refuses, readiness is down, and reconciliation deletes nothing (pending
 * rows included) instead of reading every photo as gone.
 */
describe('the photo storage marker', () => {
  let t: TestApp;
  let live: string;
  let marker: string;
  const markerPath = () => join(t.dataPath, STORAGE_MARKER);
  const reconcile = (force = false) =>
    reconcileStorage(
      {
        db: t.db,
        photos: t.photos,
        logger: silentLogger,
        timeZone: t.timeZone,
      },
      { force },
    );
  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));
  const pairedIds = async () =>
    (await t.db.select({ id: install.installId }).from(install)).map(
      (row) => row.id,
    );
  // The pairing is enforced only there (#833).
  const production = () => ({ ...t.config, APP_ENV: 'production' as const });
  const otherInstallMarker = () =>
    JSON.stringify({ installId: randomUUID(), createdAt: 'then' });
  const pendingNames = async () =>
    (await t.db.select({ name: pendingPhoto.fileName }).from(pendingPhoto))
      .map((row) => row.name)
      .sort();

  beforeAll(async () => {
    t = await createTestApp();
    const id = await createGarment(t, { name: 'Marked' });
    await uploadPhoto(t, id, await jpegPhoto(300, 300));
    live = await photoFileName(t, id);
    marker = await readFile(markerPath(), 'utf8');
    // Two day-old pending photos, one with its bytes and one without: what
    // an unguarded run deletes first.
    const withBytes = `${randomUUID()}.webp`;
    await writeFile(join(t.dataPath, withBytes), 'bytes');
    await utimes(join(t.dataPath, withBytes), TWO_DAYS_AGO(), TWO_DAYS_AGO());
    await t.db.insert(pendingPhoto).values(
      [withBytes, `${randomUUID()}.webp`].map((fileName) => ({
        fileName,
        userId: t.owner.id,
        createdAt: TWO_DAYS_AGO(),
      })),
    );
  });

  // Every test leaves the marker the app booted with, and its pairing.
  afterEach(async () => {
    await writeFile(markerPath(), marker);
    await t.db.update(install).set({ installId: installIdOf(marker) });
  });

  afterAll(() => t?.cleanup());

  it('is written by a first boot, never served and never listed', async () => {
    expect(JSON.parse(marker)).toEqual({
      installId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      createdAt: expect.any(String),
    });
    // #833: the same claim paired the database with it.
    expect(await pairedIds()).toEqual([installIdOf(marker)]);
    const res = await t.inject({
      method: 'GET',
      url: `/file/${STORAGE_MARKER}`,
    });
    expect(res.statusCode).toBe(404);
    const listed: string[] = [];
    for await (const object of t.photos.storage.list()) {
      listed.push(object.name);
    }
    expect(listed).not.toContain(STORAGE_MARKER);
  });

  it('missing under a running server: readiness is down with the pointer', async () => {
    await rm(markerPath());
    const res = await t.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(
      res.json<{ checks: Record<string, unknown> }>().checks.storage,
    ).toEqual({
      status: 'down',
      required: true,
      fix: 'see docs/operations.md#photo-storage-marker',
    });
    expect(t.logs.messages('warn')).toContainEqual(
      expect.stringMatching(
        /^Readiness: DATA_PATH has no \.closet-storage marker/,
      ),
    );
  });

  it.each([
    ['absent', () => rm(markerPath()), /no \.closet-storage marker/],
    [
      "another install's",
      () =>
        writeFile(
          markerPath(),
          JSON.stringify({ installId: randomUUID(), createdAt: 'then' }),
        ),
      /another install's/,
    ],
  ])(
    'refuses reconciliation with the marker %s, forced or not, deleting nothing',
    async (_, change, reason) => {
      const files = await storedFiles();
      const pending = await pendingNames();
      await change();
      for (const force of [false, true]) {
        const report = await reconcile(force);
        expect(report.refused).toMatch(reason);
        expect(report).toMatchObject({
          pendingPhotosDeleted: 0,
          pendingRowsWithoutFiles: 0,
          orphanedSetsQuarantined: 0,
          orphanedRowsDeleted: 0,
        });
      }
      expect(await storedFiles()).toEqual(files);
      expect(await pendingNames()).toEqual(pending);
    },
  );

  it('refuses reconciliation over file rows with no stored photo at all, marker or not', async () => {
    // Set aside in a subdirectory, which storage never lists.
    const aside = join(t.dataPath, 'aside');
    await mkdir(aside);
    const files = await storedFiles();
    for (const name of files) {
      await rename(join(t.dataPath, name), join(aside, name));
    }
    const pending = await pendingNames();
    try {
      const report = await reconcile(true);
      expect(report.refused).toMatch(
        /file table has 1 rows while storage holds no photo sets/,
      );
      expect(report.pendingRowsWithoutFiles).toBe(0);
      expect(await pendingNames()).toEqual(pending);
      expect(
        await t.db.select().from(file).where(eq(file.fileName, live)),
      ).toHaveLength(1);
    } finally {
      for (const name of files) {
        await rename(join(aside, name), join(t.dataPath, name));
      }
      await rm(aside, { recursive: true });
    }
  });

  it('refuses reconciliation when every file row is gone and only a pending photo remains', async () => {
    const aside = join(t.dataPath, 'aside');
    await mkdir(aside);
    const pending = await pendingNames();
    const files = (await storedFiles()).filter(
      (name) => !pending.includes(name),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      await rename(join(t.dataPath, name), join(aside, name));
    }
    const stored = await storedFiles();
    expect(stored.filter((name) => pending.includes(name))).toHaveLength(1);
    try {
      const report = await reconcile(true);
      expect(report.refused).toMatch(
        /file table has 1 rows while storage holds no photo sets/,
      );
      expect(report.orphanedRowsDeleted).toBe(0);
      expect(await storedFiles()).toEqual(stored);
      expect(await pendingNames()).toEqual(pending);
      expect(
        await t.db.select().from(file).where(eq(file.fileName, live)),
      ).toHaveLength(1);
    } finally {
      for (const name of files) {
        await rename(join(aside, name), join(t.dataPath, name));
      }
      await rm(aside, { recursive: true });
    }
  });

  it('refuses a boot whose DATA_PATH lacks it while the database has photo rows', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'closet-unmounted-'));
    try {
      const boot = createApp({ ...t.config, DATA_PATH: empty }, silentLogger);
      await expect(boot).rejects.toThrow(StorageIdentityError);
      await expect(boot).rejects.toThrow(
        /^DATA_PATH has no \.closet-storage marker: the photo share is not mounted/,
      );
      // Named by its key only, and nothing written beside the share.
      await expect(boot).rejects.not.toThrow(empty);
      expect(await readdir(empty)).not.toContain(STORAGE_MARKER);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('is adopted by a boot over an unmarked share holding photos and their rows', async () => {
    await rm(markerPath());
    const second = await createApp(t.config, silentLogger);
    await second.app.close();
    // A new marker carrying the install id the database is paired with
    // (#833): a restored share that lost its marker re-adopts as itself.
    const adopted = await readFile(markerPath(), 'utf8');
    expect(adopted).not.toBe(marker);
    expect(installIdOf(adopted)).toBe(installIdOf(marker));
    expect(await storedFiles()).toContain(live);
  });

  // #833: a marked share is this database's only when its install id is
  // the one the database is paired with, enforced in production only.
  it("refuses a production boot over another install's marked share, naming DATA_PATH only; dev boots with a warning", async () => {
    const other = await mkdtemp(join(tmpdir(), 'closet-other-install-'));
    const foreign = otherInstallMarker();
    try {
      await writeFile(join(other, STORAGE_MARKER), foreign);
      const boot = createApp(
        { ...production(), DATA_PATH: other },
        silentLogger,
      );
      await expect(boot).rejects.toThrow(StorageIdentityError);
      await expect(boot).rejects.toThrow(OTHER_INSTALL);
      await expect(boot).rejects.not.toThrow(other);
      expect(await readFile(join(other, STORAGE_MARKER), 'utf8')).toBe(foreign);

      // Dev (worktrees with their own DATA_PATH on one database): one warn
      // line, and the boot goes on.
      const { logger, logs } = captureLogs();
      const dev = await createApp({ ...t.config, DATA_PATH: other }, logger);
      await dev.app.close();
      expect(
        logs
          .messages('warn')
          .filter((line) => line.includes(installIdOf(foreign))),
      ).toEqual([
        `Using photo storage ${installIdOf(foreign)}: this database belongs to install ${installIdOf(marker)} (not refused outside APP_ENV production)`,
      ]);
      expect(await pairedIds()).toEqual([installIdOf(marker)]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('paired with another install under a running production server: reconciliation refuses, deleting nothing; readiness reads no row', async () => {
    const second = await createApp(production(), silentLogger);
    try {
      // The database restored from another install's dump, or repointed.
      await t.db.update(install).set({ installId: randomUUID() });
      // Readiness compares the marker with the boot's claim only: the
      // database's health is its own check.
      const res = await second.app.inject({
        method: 'GET',
        url: '/health/ready',
      });
      expect(
        res.json<{ checks: Record<string, unknown> }>().checks.storage,
      ).toEqual({ status: 'up', required: true });
      const files = await storedFiles();
      const pending = await pendingNames();
      for (const force of [false, true]) {
        const report = await reconcileStorage(
          {
            db: t.db,
            photos: second.photos,
            logger: silentLogger,
            timeZone: t.timeZone,
          },
          { force },
        );
        expect(report.refused).toMatch(OTHER_INSTALL);
        expect(report).toMatchObject({
          pendingPhotosDeleted: 0,
          orphanedSetsQuarantined: 0,
          orphanedRowsDeleted: 0,
        });
      }
      expect(await storedFiles()).toEqual(files);
      expect(await pendingNames()).toEqual(pending);
      // Outside production the pairing is advisory: no refusal, no read.
      expect(
        await storageIdentityProblem(t.photos.storage, t.db),
      ).toBeUndefined();
    } finally {
      await second.app.close();
    }
  });

  it('is paired by the first claim after the deploy, from the marker already there', async () => {
    await t.db.delete(install);
    const second = await createApp(production(), silentLogger);
    await second.app.close();
    expect(await pairedIds()).toEqual([installIdOf(marker)]);
    expect(await readFile(markerPath(), 'utf8')).toBe(marker);
  });

  it('is re-paired by the repair command after a deliberate restore onto new storage', async () => {
    const restored = otherInstallMarker();
    await writeFile(markerPath(), restored);
    await expect(createApp(production(), silentLogger)).rejects.toThrow(
      OTHER_INSTALL,
    );
    const storage = new PhotoStorage(t.dataPath, silentLogger);
    expect(await repairStorageIdentity(storage, t.db, silentLogger)).toEqual({
      paired: installIdOf(restored),
    });
    expect(await pairedIds()).toEqual([installIdOf(restored)]);
    const second = await createApp(production(), silentLogger);
    await second.app.close();
    expect(await readFile(markerPath(), 'utf8')).toBe(restored);
  });

  it('is never re-paired with a DATA_PATH that has no marker', async () => {
    await rm(markerPath());
    const storage = new PhotoStorage(t.dataPath, silentLogger);
    expect(await repairStorageIdentity(storage, t.db, silentLogger)).toEqual({
      refused: expect.stringMatching(
        /^DATA_PATH has no \.closet-storage marker/,
      ),
    });
    expect(await pairedIds()).toEqual([installIdOf(marker)]);
    expect(await readdir(t.dataPath)).not.toContain(STORAGE_MARKER);
  });

  // #851: the marker used to be written with a fresh id before the pairing,
  // so a claim that lost the pairing race left a marker its database
  // refuses on every boot after.
  it('marks an unmarked share with the id a racing claim paired first, never one of its own', async () => {
    await rm(markerPath());
    await t.db.delete(install);
    const winner = randomUUID();
    // The racing claim pairs while this one scans the share (the adoption's
    // listing, after this claim found the database unpaired).
    class PairedMidScan extends PhotoStorage {
      override async *list() {
        await t.db.insert(install).values({ installId: winner });
        yield* super.list();
      }
    }
    const storage = new PairedMidScan(t.dataPath, silentLogger);
    const claimed = await claimStorage(storage, t.db, silentLogger, 'enforced');
    expect(claimed.installId).toBe(winner);
    expect(installIdOf(await readFile(markerPath(), 'utf8'))).toBe(winner);
    expect(await pairedIds()).toEqual([winner]);
  });

  // #850: with no photo rows, a bare mountpoint marked with the paired id
  // would pass for the real share once that was mounted over it.
  it('never gives an unmarked directory with no photo rows the id of the share the database is paired with', async () => {
    const rows = await t.db.select().from(file);
    const shown = await t.db
      .select({ id: garment.id, photoId: garment.photoId })
      .from(garment)
      .where(isNotNull(garment.photoId));
    await asFixture(t.db, (tx) => tx.delete(file));
    const mountpoint = await mkdtemp(join(tmpdir(), 'closet-bare-'));
    try {
      const boot = createApp(
        { ...production(), DATA_PATH: mountpoint },
        silentLogger,
      );
      await expect(boot).rejects.toThrow(
        /^DATA_PATH has no \.closet-storage marker/,
      );
      expect(await readdir(mountpoint)).not.toContain(STORAGE_MARKER);

      // Elsewhere it is new storage of its own: the real share, mounted
      // over it later, reads as foreign.
      const dev = await createApp(
        { ...t.config, DATA_PATH: mountpoint },
        silentLogger,
      );
      await dev.app.close();
      const own = installIdOf(
        await readFile(join(mountpoint, STORAGE_MARKER), 'utf8'),
      );
      expect(own).not.toBe(installIdOf(marker));
      expect(await pairedIds()).toEqual([installIdOf(marker)]);
      const remounted = new PhotoStorage(mountpoint, silentLogger);
      remounted.claim({ installId: own, createdAt: 'then' }, 'advisory');
      await writeFile(join(mountpoint, STORAGE_MARKER), marker);
      expect(await remounted.identityProblem()).toEqual({ kind: 'foreign' });
    } finally {
      await rm(mountpoint, { recursive: true, force: true });
      await asFixture(t.db, async (tx) => {
        await tx.insert(file).values(rows);
        for (const { id, photoId } of shown) {
          await tx.update(garment).set({ photoId }).where(eq(garment.id, id));
        }
      });
    }
  });

  it('refuses a boot whose racing process left a malformed marker, naming the code only', async () => {
    await rm(markerPath());
    const racing = new PhotoStorage(t.dataPath, silentLogger, {
      readText: (path) => readFile(path, 'utf8'),
      writeNew: (path, text) => writeFile(path, text, { flag: 'wx' }),
      link: async () => {
        await writeFile(markerPath(), 'not json');
        throw Object.assign(new Error('EEXIST: /secret/path'), {
          code: 'EEXIST',
        });
      },
      remove: (path) => rm(path, { force: true }),
    });
    const error = await claimStorage(
      racing,
      t.db,
      silentLogger,
      'enforced',
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageIdentityError);
    expect((error as StorageIdentityError).message).toMatch(
      /^DATA_PATH storage unreadable: MALFORMED /,
    );
    expect((error as StorageIdentityError).message).not.toContain(t.dataPath);
    expect(await readFile(markerPath(), 'utf8')).toBe('not json');
  });

  // The bug's own story: uploads made while the share was unmounted left
  // a few sets (with rows) on the bare mountpoint. They must not adopt it.
  it("refuses an unmarked directory holding only a few of the rows' sets", async () => {
    const names = Array.from({ length: 99 }, () => `${randomUUID()}.webp`);
    await asFixture(t.db, (tx) =>
      tx.insert(file).values(
        names.map((fileName) => ({
          fileName,
          shareableId: randomUUID(),
          createdOn: TWO_DAYS_AGO().toISOString(),
          createdById: t.owner.id,
        })),
      ),
    );
    const mountpoint = await mkdtemp(join(tmpdir(), 'closet-strays-'));
    try {
      for (const name of names.slice(0, 3)) {
        await writeFile(join(mountpoint, name), 'a stray upload');
      }
      // 3 of 100 rows' sets: far under ADOPT_MIN_COVERAGE.
      await expect(
        createApp({ ...t.config, DATA_PATH: mountpoint }, silentLogger),
      ).rejects.toThrow(/^DATA_PATH has no \.closet-storage marker/);
      expect(await readdir(mountpoint)).not.toContain(STORAGE_MARKER);
    } finally {
      await rm(mountpoint, { recursive: true, force: true });
      await asFixture(t.db, (tx) =>
        tx.delete(file).where(inArray(file.fileName, names)),
      );
    }
  });
});
