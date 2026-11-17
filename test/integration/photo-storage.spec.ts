import { randomBytes, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type StorageFs,
  PhotoStorage,
  STORAGE_MARKER,
  TRASH_DIR,
} from '../../src/web/files/storage';
import { captureLogs } from '../support/log-capture';

/**
 * PhotoStorage (src/web/files/storage.ts) on a real directory: the races
 * between a reader, a writer and a delete of one name, and the line between
 * a missing file (an answer) and a broken DATA_PATH (an error). That line
 * matters downstream: reconciliation deletes what list() and exists() say
 * is gone, so a dead NFS mount must throw, never read as "no photos".
 */
describe('photo storage on disk', () => {
  let directory: string;
  let storage: PhotoStorage;
  let logs: ReturnType<typeof captureLogs>['logs'];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'closet-storage-'));
    const captured = captureLogs();
    logs = captured.logs;
    storage = new PhotoStorage(directory, captured.logger);
    storage.prepare();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const incoming = () => readdir(join(directory, '.incoming'));

  /** `chunks` pieces, `gapMs` apart: a write still arriving. */
  function slowStream(chunks: Buffer[], gapMs: number): Readable {
    return Readable.from(
      (async function* () {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          yield chunk;
        }
      })(),
    );
  }

  it('boots by removing partial writes abandoned over an hour ago, never a live one', async () => {
    await writeFile(join(directory, '.incoming', 'dead-a.webp'), 'partial');
    await writeFile(join(directory, '.incoming', 'live-b.webp'), 'arriving');
    // Both ages from the clock prepare() reads, not the filesystem's: under the
    // gate's clock shift a file written just now is a month old to the app.
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await utimes(
      join(directory, '.incoming', 'dead-a.webp'),
      twoHoursAgo,
      twoHoursAgo,
    );
    await utimes(join(directory, '.incoming', 'live-b.webp'), now, now);

    storage.prepare();

    expect(await incoming()).toEqual(['live-b.webp']);
    expect(logs.messages('warn')).toEqual([
      'Removed abandoned partial write dead-a.webp',
    ]);
  });

  it('never shows a reader a partial write: the old file whole until the new one is', async () => {
    const before = randomBytes(64 * 1024);
    await storage.store('a.webp', Readable.from([before]));
    const after = [randomBytes(64 * 1024), randomBytes(64 * 1024)];

    let stored = false;
    const writing = storage
      .store('a.webp', slowStream(after, 30))
      .then(() => (stored = true));
    const seen: Buffer[] = [];
    while (!stored) {
      const stream = await storage.get('a.webp');
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(chunk as Buffer);
      seen.push(Buffer.concat(chunks));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await writing;

    // Every read got one of the two files whole; the ones made while the
    // new bytes were still arriving got the old file.
    const whole = Buffer.concat(after);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0].equals(before)).toBe(true);
    for (const bytes of seen) {
      expect(bytes.equals(before) || bytes.equals(whole)).toBe(true);
    }
    expect((await readFile(join(directory, 'a.webp'))).equals(whole)).toBe(
      true,
    );
    expect(await incoming()).toEqual([]);
  });

  it('leaves the previous file and no temp file when a write fails midway', async () => {
    await storage.store('b.webp', Readable.from([Buffer.from('previous')]));
    const failing = Readable.from(
      (async function* () {
        yield Buffer.from('half a pho');
        await Promise.resolve();
        throw new Error('upload reset by peer');
      })(),
    );

    await expect(storage.store('b.webp', failing)).rejects.toThrow(
      'upload reset by peer',
    );

    expect(await readFile(join(directory, 'b.webp'), 'utf8')).toBe('previous');
    expect(await incoming()).toEqual([]);
  });

  it('streams a file whole that is deleted after it was opened', async () => {
    await storage.store('c.webp', Readable.from([Buffer.from('still here')]));

    const stream = await storage.get('c.webp');
    await storage.delete('c.webp');

    expect(await text(stream!)).toBe('still here');
    expect(await storage.get('c.webp')).toBeUndefined();
    expect(await storage.exists('c.webp')).toBe(false);
  });

  it('answers a missing file as absent, and deleting one as done', async () => {
    expect(await storage.get('never.webp')).toBeUndefined();
    expect(await storage.exists('never.webp')).toBe(false);
    await expect(storage.delete('never.webp')).resolves.toBeUndefined();
  });

  it('counts only files as objects: a directory is neither one nor listed', async () => {
    await storage.store('d.webp', Readable.from([Buffer.from('d')]));
    await mkdir(join(directory, 'not-a-photo'));

    expect(await storage.exists('d.webp')).toBe(true);
    expect(await storage.exists('not-a-photo')).toBe(false);
    expect(await storage.exists('.incoming')).toBe(false);
    const names: string[] = [];
    for await (const object of storage.list()) names.push(object.name);
    expect(names).toEqual(['d.webp']);
  });

  it('lists what is still there when files are deleted during the listing', async () => {
    const names = ['e1.webp', 'e2.webp', 'e3.webp', 'e4.webp'];
    for (const name of names) {
      await storage.store(name, Readable.from([Buffer.from(name)]));
    }

    // The directory is read once, before the first object; each is then
    // stat'ed as the caller asks. Deleting the rest after the first object
    // is the nightly reconciliation racing a garment deletion.
    const listed: string[] = [];
    let survivor: string | undefined;
    for await (const object of storage.list()) {
      if (listed.length === 0) {
        const others = names.filter((name) => name !== object.name);
        survivor = others[0];
        await Promise.all(
          others.slice(1).map((name) => unlink(join(directory, name))),
        );
      }
      listed.push(object.name);
      expect(object.lastModified).toBeInstanceOf(Date);
    }

    expect(listed).toEqual([listed[0], survivor]);
  });

  describe('when DATA_PATH is not a directory (a mount gone wrong)', () => {
    let broken: PhotoStorage;

    beforeEach(async () => {
      const notADirectory = join(directory, 'mount');
      await writeFile(notADirectory, 'a file where the photos should be');
      broken = new PhotoStorage(notADirectory, captureLogs().logger);
    });

    it('fails every read instead of answering "no such photo"', async () => {
      await expect(broken.get('f.webp')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
      await expect(broken.exists('f.webp')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
      await expect(
        broken.list()[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });

    it('fails a delete instead of reporting it done', async () => {
      await expect(broken.delete('f.webp')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });
  });

  // #650's marker: what the disk does to it, injected.
  describe('the storage marker', () => {
    const nodeFs: StorageFs = {
      readText: (file) => readFile(file, 'utf8'),
      writeNew: (file, content) => writeFile(file, content, { flag: 'wx' }),
      link: (from, to) => link(from, to),
      rename: (from, to) => rename(from, to),
      remove: (file) => rm(file, { force: true }),
    };
    const errno = (code: string) =>
      Object.assign(new Error(`${code}: on /secret/path`), { code });

    it('reads a failing read as unreadable by its code, never as a rejection', async () => {
      const stale = new PhotoStorage(directory, captureLogs().logger, {
        ...nodeFs,
        readText: () => Promise.reject(errno('ESTALE')),
      });
      expect(await stale.identityProblem()).toEqual({
        kind: 'unreadable',
        code: 'ESTALE',
      });
      expect(await stale.readMarker()).toEqual({
        state: 'unreadable',
        code: 'ESTALE',
      });
    });

    it('reads content that is not a marker as unreadable, and never replaces it', async () => {
      await writeFile(join(directory, STORAGE_MARKER), 'not json');
      expect(await storage.identityProblem()).toEqual({
        kind: 'unreadable',
        code: 'MALFORMED',
      });
    });

    it('reports the marker that won the race as unreadable, by code only, when it is malformed', async () => {
      const racing = new PhotoStorage(directory, captureLogs().logger, {
        ...nodeFs,
        link: async () => {
          await writeFile(join(directory, STORAGE_MARKER), 'not json');
          throw errno('EEXIST');
        },
      });
      expect(await racing.createMarker()).toEqual({
        state: 'unreadable',
        code: 'MALFORMED',
      });
      expect(await incoming()).toEqual([]);
    });

    it('two processes creating it at once end with one install id both claim', async () => {
      // The first is held between its temp file and its link while the
      // second creates the marker whole.
      let written!: () => void;
      const tempWritten = new Promise<void>((resolve) => {
        written = resolve;
      });
      let release!: () => void;
      const linkAllowed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = new PhotoStorage(directory, captureLogs().logger, {
        ...nodeFs,
        writeNew: async (file, content) => {
          await nodeFs.writeNew(file, content);
          written();
        },
        link: async (from, to) => {
          await linkAllowed;
          return nodeFs.link(from, to);
        },
      });
      const second = new PhotoStorage(directory, captureLogs().logger, nodeFs);

      const firstCreated = first.createMarker();
      await tempWritten;
      const secondCreated = await second.createMarker();
      release();
      expect(await firstCreated).toEqual(secondCreated);
      if (secondCreated.state !== 'present') throw new Error('not present');
      const secondMarker = secondCreated.marker;

      first.claim(secondMarker, 'advisory');
      second.claim(secondMarker, 'advisory');
      expect(await first.identityProblem()).toBeUndefined();
      expect(await second.identityProblem()).toBeUndefined();
      expect(
        JSON.parse(await readFile(join(directory, STORAGE_MARKER), 'utf8')),
      ).toEqual(secondMarker);
      // Neither temp file is left behind.
      expect(await incoming()).toEqual([]);
    });

    // #1049: two healers of one orphan. The second read the orphan, then is
    // held before its rename while the first moves it aside and links a new
    // marker: the second must take that one, see it is not the orphan, and
    // put it back.
    it('two withdrawers of one marker never remove the marker linked between them', async () => {
      const markerPath = join(directory, STORAGE_MARKER);
      const orphan = { installId: randomUUID(), createdAt: 'then' };
      await writeFile(markerPath, JSON.stringify(orphan));
      let release!: () => void;
      const renameAllowed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      const second = new PhotoStorage(directory, captureLogs().logger, {
        ...nodeFs,
        rename: async (from, to) => {
          if (!held) {
            held = true;
            await renameAllowed;
          }
          return nodeFs.rename(from, to);
        },
      });
      const first = new PhotoStorage(directory, captureLogs().logger, nodeFs);

      expect(await second.readMarker()).toEqual({
        state: 'present',
        marker: orphan,
      });
      const secondWithdrew = second.withdrawMarker(orphan);
      expect(await first.withdrawMarker(orphan)).toBe(true);
      const created = await first.createMarker();
      release();
      expect(await secondWithdrew).toBe(false);

      expect(await first.readMarker()).toEqual(created);
      expect((await first.orphanedMarkers()).map((o) => o.marker)).toEqual([
        orphan,
      ]);
      // The marker and the one orphan: the second's take was put back.
      expect(
        (await readdir(directory)).filter((name) =>
          name.startsWith(STORAGE_MARKER),
        ),
      ).toHaveLength(2);
    });

    // #649: restoring from the trash is whole or nothing.
    it('rolls a restore back when a link fails midway: storage and the trash as before', async () => {
      const names = ['a.webp', 'a-nobg.webp', 'a-thumb.webp'];
      for (const name of names) {
        await writeFile(join(directory, name), `bytes of ${name}`);
      }
      const trashed = await storage.quarantine('a.webp', names, '2026-01-01');
      let links = 0;
      const failing = new PhotoStorage(directory, captureLogs().logger, {
        ...nodeFs,
        link: (from, to) => {
          links += 1;
          return links === 2 ? Promise.reject(errno('EIO')) : link(from, to);
        },
      });

      await expect(failing.restore([trashed!], new Date())).rejects.toThrow(
        'EIO',
      );
      expect(
        (await readdir(directory)).filter((name) => name.endsWith('.webp')),
      ).toEqual([]);
      expect(await storage.trash()).toEqual([
        { ...trashed, files: [...names].sort() },
      ]);
      for (const name of names) {
        expect(
          await readFile(
            join(directory, TRASH_DIR, '2026-01-01', 'a.webp', name),
            'utf8',
          ),
        ).toBe(`bytes of ${name}`);
      }
    });
  });
});
