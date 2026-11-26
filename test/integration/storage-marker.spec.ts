import { randomUUID } from 'node:crypto';
import {
  link,
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
import { repairInstallId } from '../../src/web/files/queries';
import {
  PhotoStorage,
  STORAGE_MARKER,
  type StorageFs,
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
  const diskFs: StorageFs = {
    readText: (path) => readFile(path, 'utf8'),
    writeNew: (path, text) => writeFile(path, text, { flag: 'wx' }),
    link: (from, to) => link(from, to),
    rename: (from, to) => rename(from, to),
    remove: (path) => rm(path, { force: true }),
  };
  const fsError = (code: string) =>
    Object.assign(new Error(`${code}: /secret/path`), { code });
  // Empties the file table (an install with no photos yet), answering how
  // to put it back.
  const stashPhotoRows = async () => {
    const rows = await t.db.select().from(file);
    const shown = await t.db
      .select({ id: garment.id, photoId: garment.photoId })
      .from(garment)
      .where(isNotNull(garment.photoId));
    await asFixture(t.db, (tx) => tx.delete(file));
    return () =>
      asFixture(t.db, async (tx) => {
        await tx.insert(file).values(rows);
        for (const { id, photoId } of shown) {
          await tx.update(garment).set({ photoId }).where(eq(garment.id, id));
        }
      });
  };
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
    await repairInstallId(t.db, installIdOf(marker));
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
    const restoreRows = await stashPhotoRows();
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
      await restoreRows();
    }
  });

  /**
   * A fresh install's first claim (no photo rows, database unpaired) cut
   * short at each point between the marker and the pairing. The marker is
   * written first, so every crash leaves either nothing (the next boot is a
   * first boot) or a marker beside an unpaired database (adopted). Paired
   * first, a failed marker write left a database paired with an id no
   * marker carries, and #850's rule refused every boot after.
   */
  describe('a first claim cut short', () => {
    let restoreRows: () => Promise<void>;
    let directory = '';
    const racer = randomUUID();
    const otherShare = randomUUID();
    const markerIn = (dir: string) => join(dir, STORAGE_MARKER);
    const onDisk = async () =>
      installIdOf(await readFile(markerIn(directory), 'utf8'));
    const storageOver = (dir: string, fs: StorageFs = diskFs) => {
      const storage = new PhotoStorage(dir, silentLogger, fs);
      storage.prepare();
      return storage;
    };
    // The process dies once its marker is linked, before it pairs.
    class DiesAfterMarking extends PhotoStorage {
      override async createMarker(installId?: string): Promise<never> {
        await super.createMarker(installId);
        throw new Error('killed');
      }
    }
    // Another DATA_PATH's claim pairs this database between this claim's
    // marker and its pairing.
    class OutPaired extends PhotoStorage {
      override async createMarker(installId?: string) {
        const created = await super.createMarker(installId);
        await t.db
          .insert(install)
          .values({ installId: otherShare })
          .onConflictDoNothing();
        return created;
      }
    }
    // Loses the pairing as OutPaired, then dies before withdrawing its
    // marker (#1049).
    class OutPairedThenDies extends OutPaired {
      override withdrawMarker(): Promise<never> {
        return Promise.reject(new Error('killed'));
      }
    }

    beforeAll(async () => {
      restoreRows = await stashPhotoRows();
    });
    afterAll(() => restoreRows());
    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    interface CrashPoint {
      point: string;
      first: (dir: string) => PhotoStorage;
      claimed: 'rejects' | 'claims';
      /** What the cut-short claim says, when it says more than "rejects". */
      refused?: RegExp;
      next: 'paired' | { refused: RegExp; paired: string | undefined };
      pairedWith?: string;
      /**
       * The claim's marker is kept as an orphan, and the repair command
       * pairs it back (#1049: it may have been the real share's).
       */
      orphaned?: true;
    }
    const crashPoints: CrashPoint[] = [
      {
        point: 'the marker write fails (ENOSPC)',
        first: (dir) =>
          storageOver(dir, {
            ...diskFs,
            writeNew: () => Promise.reject(fsError('ENOSPC')),
          }),
        claimed: 'rejects',
        next: 'paired',
      },
      {
        point: 'the marker link fails (EIO)',
        first: (dir) =>
          storageOver(dir, {
            ...diskFs,
            link: () => Promise.reject(fsError('EIO')),
          }),
        claimed: 'rejects',
        next: 'paired',
      },
      {
        point: 'the process dies after the marker, before the pairing',
        first: (dir) => {
          const storage = new DiesAfterMarking(dir, silentLogger);
          storage.prepare();
          return storage;
        },
        claimed: 'rejects',
        next: 'paired',
      },
      {
        point: 'a process booting on this directory links its marker first',
        first: (dir) =>
          storageOver(dir, {
            ...diskFs,
            link: async () => {
              await writeFile(
                markerIn(dir),
                JSON.stringify({ installId: racer, createdAt: 'then' }),
              );
              throw fsError('EEXIST');
            },
          }),
        claimed: 'claims',
        next: 'paired',
        pairedWith: racer,
      },
      {
        // A human must look: the racer's marker is not one (operations.md).
        point: 'the racing process leaves a malformed marker',
        first: (dir) =>
          storageOver(dir, {
            ...diskFs,
            link: async () => {
              await writeFile(markerIn(dir), 'not json');
              throw fsError('EEXIST');
            },
          }),
        claimed: 'rejects',
        next: {
          refused: /^DATA_PATH storage unreadable: MALFORMED /,
          paired: undefined,
        },
      },
      {
        // A human must look: two shares claimed one database at once, and
        // this one, with no photo rows, proves nothing (#850).
        point: 'another share pairs the database first',
        first: (dir) => {
          const storage = new OutPaired(dir, silentLogger);
          storage.prepare();
          return storage;
        },
        claimed: 'rejects',
        next: {
          refused: /^DATA_PATH has no \.closet-storage marker/,
          paired: otherShare,
        },
        orphaned: true,
      },
      {
        // #1049: its marker, beside a database paired with the other share,
        // is this database's own claim (storage_claim), never another
        // install's: kept as an orphan, then the same refusal as the row
        // above. Also the real share's claim losing to a bare mountpoint's:
        // the next boot must not destroy the only marker the repair can pair.
        point:
          'the process dies after losing the pairing, before withdrawing its marker',
        first: (dir) => {
          const storage = new OutPairedThenDies(dir, silentLogger);
          storage.prepare();
          return storage;
        },
        claimed: 'rejects',
        next: {
          refused: /^DATA_PATH has no \.closet-storage marker/,
          paired: otherShare,
        },
        orphaned: true,
      },
      {
        point: 'the withdrawal of its marker fails (EACCES)',
        first: (dir) => {
          const storage = new OutPaired(dir, silentLogger, {
            ...diskFs,
            rename: (from, to) =>
              from === markerIn(dir)
                ? Promise.reject(fsError('EACCES'))
                : diskFs.rename(from, to),
          });
          storage.prepare();
          return storage;
        },
        claimed: 'rejects',
        refused: /^DATA_PATH storage unreadable: EACCES /,
        next: {
          refused: /^DATA_PATH has no \.closet-storage marker/,
          paired: otherShare,
        },
        orphaned: true,
      },
      {
        // The withdrawal's one rename lands and the process dies before it
        // reads what it took: the name left is an orphan's, which the
        // repair finds by its content.
        point: 'the process dies right after its withdrawal renames the marker',
        first: (dir) => {
          const storage = new OutPaired(dir, silentLogger, {
            ...diskFs,
            rename: async (from, to) => {
              await diskFs.rename(from, to);
              if (from === markerIn(dir)) throw new Error('killed');
            },
          });
          storage.prepare();
          return storage;
        },
        claimed: 'rejects',
        next: {
          refused: /^DATA_PATH has no \.closet-storage marker/,
          paired: otherShare,
        },
        orphaned: true,
      },
    ];

    it.each(crashPoints)('$point: the next boot heals', async (row) => {
      await t.db.delete(install);
      directory = await mkdtemp(join(tmpdir(), 'closet-first-claim-'));
      const claim = (storage: PhotoStorage) =>
        claimStorage(storage, t.db, silentLogger, 'enforced');
      const first = claim(row.first(directory));
      if (row.claimed === 'rejects') {
        if (!row.refused) await expect(first).rejects.toThrow();
        else {
          await expect(first).rejects.toThrow(row.refused);
          await expect(first).rejects.toBeInstanceOf(StorageIdentityError);
          await expect(first).rejects.not.toThrow(directory);
        }
      } else {
        await first;
      }
      const next = claim(storageOver(directory));
      if (row.next === 'paired') {
        const claimed = await next;
        expect(await pairedIds()).toEqual([claimed.installId]);
        expect(await onDisk()).toBe(claimed.installId);
        if (row.pairedWith) expect(claimed.installId).toBe(row.pairedWith);
      } else {
        await expect(next).rejects.toThrow(row.next.refused);
        // Named by its key and code only.
        await expect(next).rejects.not.toThrow(directory);
        expect(await pairedIds()).toEqual(
          row.next.paired === undefined ? [] : [row.next.paired],
        );
      }
      if (!row.orphaned) return;
      const storage = storageOver(directory);
      const [orphan] = (await storage.orphanedMarkers()).map((o) => o.marker);
      expect(await repairStorageIdentity(storage, t.db, silentLogger)).toEqual({
        refused: expect.stringMatching(/^DATA_PATH has no/),
        orphans: [orphan],
      });
      expect(
        await repairStorageIdentity(storage, t.db, silentLogger, {
          orphan: orphan.installId,
        }),
      ).toEqual({ paired: orphan.installId });
      expect(await onDisk()).toBe(orphan.installId);
      expect(await storage.orphanedMarkers()).toEqual([]);
      expect((await claim(storageOver(directory))).installId).toBe(
        orphan.installId,
      );
    });

    // Only a claim that never paired leaves an orphan: a share once paired
    // and then re-paired away (a restore onto new storage) is another
    // install's, refused with its marker kept.
    it('never withdraws a marker that was paired once, then re-paired away', async () => {
      await t.db.delete(install);
      directory = await mkdtemp(join(tmpdir(), 'closet-first-claim-'));
      const claim = () =>
        claimStorage(storageOver(directory), t.db, silentLogger, 'enforced');
      const own = await claim();
      await repairInstallId(t.db, otherShare);
      await expect(claim()).rejects.toThrow(OTHER_INSTALL);
      expect(await onDisk()).toBe(own.installId);
    });

    it('withdraws only its own marker when it loses the pairing', async () => {
      await t.db.delete(install);
      directory = await mkdtemp(join(tmpdir(), 'closet-first-claim-'));
      const storage = new OutPaired(directory, silentLogger);
      storage.prepare();
      await expect(
        claimStorage(storage, t.db, silentLogger, 'enforced'),
      ).rejects.toThrow(/^DATA_PATH has no \.closet-storage marker/);
      expect(await readdir(directory)).not.toContain(STORAGE_MARKER);
      const another = { installId: randomUUID(), createdAt: 'then' };
      await writeFile(markerIn(directory), JSON.stringify(another));
      expect(
        await storage.withdrawMarker({ ...another, createdAt: 'now' }),
      ).toBe(false);
      expect(await onDisk()).toBe(another.installId);
    });
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
