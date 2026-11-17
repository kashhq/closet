import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IsoDate } from '../../calendar-date';
import type { Logger } from '../../logger';

// Writes land here first and are renamed into DATA_PATH when complete (same
// filesystem, so the rename is atomic). A reader, such as the thumb writer
// running while a large cutout is still arriving, sees either no file or the
// whole file, never a prefix. list() skips directories, so reconciliation
// never sees in-flight writes.
const INCOMING_DIR = '.incoming';
const STALE_INCOMING_MS = 60 * 60 * 1000;

/**
 * Reconciliation's quarantine (#649): `.trash/<YYYY-MM-DD>/<set>/<files>`,
 * one directory per day (APP_TIMEZONE) and per photo set. Under DATA_PATH,
 * so a move is a rename on one filesystem: atomic, the bytes untouched. A
 * dot-directory: list() skips it and parseStoredName refuses its name, so
 * nothing in it is scanned or served by /file/**.
 */
export const TRASH_DIR = '.trash';
// A day directory's name; anything else under .trash is not ours to purge.
const TRASH_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The directory's identity (#650): written once, by claimStorage
 * (storage-identity.ts), when this process can prove DATA_PATH is the
 * household's photo storage. A bare mountpoint (the share not mounted)
 * lacks it, so it is never read as "every photo is gone". A dotfile:
 * parseStoredName refuses it, so /file/** never serves it, and list()
 * skips it, so reconciliation never counts it.
 */
export const STORAGE_MARKER = '.closet-storage';

/**
 * A withdrawn marker is kept, never deleted, as `.closet-storage.orphan-<id>`
 * (#1049): a claim that lost its pairing may have been the real share's,
 * and `--repair-storage-identity --orphan <id>` puts it back. A marker on
 * its way out sits under WITHDRAWN_PREFIX for the moment it is checked.
 * list() skips every name starting with STORAGE_MARKER.
 */
const ORPHAN_PREFIX = `${STORAGE_MARKER}.orphan-`;
const WITHDRAWN_PREFIX = `${STORAGE_MARKER}.withdrawn-`;

/** An orphaned marker and the file it is in (orphanedMarkers). */
export interface OrphanedMarker {
  name: string;
  marker: StorageMarker;
}

export interface StorageMarker {
  /** A random UUID, stable for the life of the storage. */
  installId: string;
  /** ISO timestamp of the write. */
  createdAt: string;
}

/**
 * Why the directory is not the one this process claimed (identityProblem):
 * no marker, another install's, or a marker that cannot be read (a stale
 * NFS handle, EIO, EACCES; MALFORMED content), named by its code only.
 * `unpaired`: a marker whose install id is not the one the database
 * records (#833; storage-identity.ts asks, PhotoStorage has no database).
 */
export type IdentityProblem =
  | { kind: 'absent' }
  | { kind: 'foreign' }
  | { kind: 'unpaired' }
  | { kind: 'unreadable'; code: string };

/**
 * Whether a marker of another install than the database's is refused
 * (`enforced`: APP_ENV production) or only logged (`advisory`: dev and
 * gate, where worktrees with their own DATA_PATH share one database).
 */
export type InstallPairing = 'enforced' | 'advisory';

/** The marker file as read: never a rejection, so readiness always answers. */
export type MarkerRead =
  | { state: 'present'; marker: StorageMarker }
  | { state: 'absent' }
  | { state: 'unreadable'; code: string };

/**
 * The file operations the marker and the trash's restore use, injectable so
 * a spec can fail a read or a link, or hold a writer between its temp file
 * and its link (photo-storage.spec.ts).
 */
export interface StorageFs {
  readText(file: string): Promise<string>;
  /** Creates `file`, failing with EEXIST when it exists (`wx`). */
  writeNew(file: string, text: string): Promise<void>;
  /** A hard link: fails with EEXIST when `to` exists, so never replaces it. */
  link(from: string, to: string): Promise<void>;
  /** Atomic within the directory; replaces `to`. */
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
}

const NODE_STORAGE_FS: StorageFs = {
  readText: (file) => fs.promises.readFile(file, 'utf8'),
  writeNew: (file, text) => fs.promises.writeFile(file, text, { flag: 'wx' }),
  link: (from, to) => fs.promises.link(from, to),
  rename: (from, to) => fs.promises.rename(from, to),
  remove: (file) => fs.promises.rm(file, { force: true }),
};

/** One file in the photo directory; names are as stored, variants included. */
export interface StoredObject {
  name: string;
  lastModified: Date;
}

/** A quarantined photo set: `.trash/<day>/<entry>`, holding `files`. */
export interface TrashedSet {
  day: IsoDate;
  /** The set's name, with a `~<hex>` suffix when the day already held one. */
  entry: string;
  files: string[];
}

/** What a restore that went live could not remove from `.trash`. */
export interface TrashLeftover {
  /** Under `.trash`: `<day>/<entry>/<file>`, or a directory's. */
  path: string;
  error: unknown;
}

/**
 * A restore that never went live: the link (or stamp) `cause` failed and
 * the links made were taken back, except `stranded`, live names that could
 * not be unlinked (each the trash file itself, so a retry adopts it).
 */
export class RestoreFailed extends Error {
  constructor(
    cause: unknown,
    readonly stranded: readonly string[],
  ) {
    // The code only: an fs error's message carries its paths.
    super(
      `Restore from the trash failed (${String((cause as NodeJS.ErrnoException).code)})`,
      { cause },
    );
    this.name = 'RestoreFailed';
  }
}

/**
 * The photo bytes: a flat directory (DATA_PATH).
 * Knows nothing about photos; Photos (photos.ts) names, transcodes and
 * derives, and reconciliation maps names back to rows with parseStoredName.
 */
export class PhotoStorage {
  private readonly incoming: string;
  // The marker this process verified or wrote at boot (claim); compared
  // with the one on disk later, so a share swapped under a running server
  // is noticed too.
  private claimed: StorageMarker | undefined;
  private pairing: InstallPairing = 'advisory';

  constructor(
    readonly directory: string,
    private readonly logger: Logger,
    private readonly storageFs: StorageFs = NODE_STORAGE_FS,
  ) {
    this.incoming = path.join(directory, INCOMING_DIR);
  }

  /**
   * Creates the directories and removes abandoned partial writes. A temp
   * file untouched for an hour is a write whose process died (crash, kill
   * mid-upload); no row can point at it. Only stale ones go: the reconcile
   * CLI boots a second process on the same DATA_PATH while the server may
   * be mid-write, and a live write keeps its mtime fresh.
   */
  prepare(): void {
    fs.mkdirSync(this.incoming, { recursive: true });
    const staleBefore = Date.now() - STALE_INCOMING_MS;
    for (const name of fs.readdirSync(this.incoming)) {
      const tempPath = path.join(this.incoming, name);
      // Undefined when a live write was renamed into place meanwhile.
      const stat = fs.statSync(tempPath, { throwIfNoEntry: false });
      if (stat && stat.mtimeMs < staleBefore) {
        fs.rmSync(tempPath, { force: true });
        this.logger.warn(`Removed abandoned partial write ${name}`);
      }
    }
  }

  /**
   * The marker on disk. Any read error but ENOENT is `unreadable` with its
   * code, and so is content that is not a marker (MALFORMED).
   */
  readMarker(): Promise<MarkerRead> {
    return this.readMarkerAt(STORAGE_MARKER);
  }

  private async readMarkerAt(name: string): Promise<MarkerRead> {
    let text: string;
    try {
      text = await this.storageFs.readText(this.pathOf(name));
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      if (code === 'ENOENT') return { state: 'absent' };
      this.logger.warn(`${STORAGE_MARKER} could not be read (${code})`);
      return { state: 'unreadable', code };
    }
    const marker = parseMarker(text);
    if (!marker) {
      // Never overwritten: whoever left it there may know better.
      this.logger.warn(`${STORAGE_MARKER} is not a storage marker`);
      return { state: 'unreadable', code: 'MALFORMED' };
    }
    return { state: 'present', marker };
  }

  /**
   * Creates the marker exclusively and returns the one on disk: ours, or,
   * when another process (the server and a CLI booting together) linked
   * its own first, that one, so both claim the same install id. When the
   * one that won cannot be read, that is returned as `unreadable` (its
   * code, never a path) for claimStorage to refuse. The temp
   * file is linked, never renamed: a rename replaces, a link fails with
   * EEXIST. A reader sees no marker or a whole one. Only claimStorage
   * decides that one may be written, and with which install id (the
   * database's, once it is paired: #833).
   */
  async createMarker(
    installId: string = randomUUID(),
    now: Date = new Date(),
  ): Promise<Exclude<MarkerRead, { state: 'absent' }>> {
    const marker: StorageMarker = {
      installId,
      createdAt: now.toISOString(),
    };
    const tempPath = path.join(this.incoming, `${randomUUID()}-marker`);
    try {
      await this.storageFs.writeNew(tempPath, `${JSON.stringify(marker)}\n`);
      await this.storageFs.link(tempPath, this.pathOf(STORAGE_MARKER));
      return { state: 'present', marker };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readMarker();
      // Gone again between the link and the read: nothing to explain it.
      if (existing.state === 'absent') throw error;
      if (existing.state === 'present') {
        this.logger.info(
          `${STORAGE_MARKER} was written by another process meanwhile; using its install ${existing.marker.installId}`,
        );
      }
      return existing;
    } finally {
      await this.storageFs.remove(tempPath);
    }
  }

  /**
   * Moves the marker aside as `.closet-storage.orphan-<id>` only while it is
   * `marker` (same id, same timestamp): claimStorage's own, written by a
   * claim whose pairing lost to another install's. Answers whether it did.
   *
   * Atomic against a second withdrawer (#1049): the marker is renamed to a
   * name of this call's own first and only then read, so what is judged is
   * exactly what was taken. A read-then-remove let one healer delete the
   * marker another had just linked. What was taken and is not `marker` is
   * linked back (never over a marker linked meanwhile; that one wins and
   * the taken one is kept as an orphan). `marker.installId` is always an id
   * a claim minted (randomUUID or a storage_claim row), so it is a safe name.
   */
  async withdrawMarker(marker: StorageMarker): Promise<boolean> {
    const aside = `${WITHDRAWN_PREFIX}${randomUUID()}`;
    try {
      await this.storageFs.rename(
        this.pathOf(STORAGE_MARKER),
        this.pathOf(aside),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const taken = await this.readMarkerAt(aside);
    if (
      taken.state === 'present' &&
      taken.marker.installId === marker.installId &&
      taken.marker.createdAt === marker.createdAt
    ) {
      await this.storageFs.rename(
        this.pathOf(aside),
        this.pathOf(`${ORPHAN_PREFIX}${marker.installId}`),
      );
      this.logger.warn(
        `${STORAGE_MARKER} of install ${marker.installId} moved aside as ${ORPHAN_PREFIX}${marker.installId}`,
      );
      return true;
    }
    try {
      await this.storageFs.link(
        this.pathOf(aside),
        this.pathOf(STORAGE_MARKER),
      );
      await this.storageFs.remove(this.pathOf(aside));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const kept = `${ORPHAN_PREFIX}${randomUUID()}`;
      await this.storageFs.rename(this.pathOf(aside), this.pathOf(kept));
      this.logger.warn(
        `${STORAGE_MARKER} taken by a withdrawal was replaced meanwhile; kept as ${kept}`,
      );
    }
    return false;
  }

  /** The markers withdrawn as orphans (withdrawMarker), for the repair command to offer. */
  async orphanedMarkers(): Promise<OrphanedMarker[]> {
    const names = (await fs.promises.readdir(this.directory)).filter((name) =>
      name.startsWith(ORPHAN_PREFIX),
    );
    const orphans: OrphanedMarker[] = [];
    for (const name of names) {
      const read = await this.readMarkerAt(name);
      if (read.state === 'present') orphans.push({ name, marker: read.marker });
    }
    return orphans;
  }

  /**
   * Puts an orphaned marker back as the marker, linked, so never over one
   * present. Answers whether it did: false when no orphan carries
   * `installId` or a marker is there already.
   */
  async restoreOrphan(installId: string): Promise<boolean> {
    const orphan = (await this.orphanedMarkers()).find(
      ({ marker }) => marker.installId === installId,
    );
    if (!orphan) return false;
    try {
      await this.storageFs.link(
        this.pathOf(orphan.name),
        this.pathOf(STORAGE_MARKER),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    await this.storageFs.remove(this.pathOf(orphan.name));
    return true;
  }

  /**
   * Records the marker claimStorage verified (identityProblem compares with
   * it) and whether the database's pairing with it is enforced, which
   * storageIdentityProblem reads (#833: production only).
   */
  claim(marker: StorageMarker, pairing: InstallPairing): void {
    this.claimed = marker;
    this.pairing = pairing;
  }

  /** The install id claimed at boot: what the database's pairing is compared with. */
  get claimedInstallId(): string | undefined {
    return this.claimed?.installId;
  }

  get installPairing(): InstallPairing {
    return this.pairing;
  }

  /**
   * Whether the directory is still the one this process claimed: no
   * marker (unmounted, or never claimed), another install's, one that
   * cannot be read, or undefined. Read on every call (readiness and each
   * reconciliation run ask: a share can be unmounted under a server), and
   * never rejects for the disk's sake.
   */
  async identityProblem(): Promise<IdentityProblem | undefined> {
    const read = await this.readMarker();
    if (read.state === 'absent') return { kind: 'absent' };
    if (read.state === 'unreadable') {
      return { kind: 'unreadable', code: read.code };
    }
    if (this.claimed && read.marker.installId !== this.claimed.installId) {
      return { kind: 'foreign' };
    }
    return undefined;
  }

  /**
   * The file's bytes, or undefined when there is no such file. Opened before
   * returning, so a file deleted afterwards still streams whole and a
   * missing one is never a stream that fails later.
   */
  async get(fileName: string): Promise<Readable | undefined> {
    try {
      const handle = await fs.promises.open(this.pathOf(fileName), 'r');
      return handle.createReadStream();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async exists(fileName: string): Promise<boolean> {
    const stat = await fs.promises
      .stat(this.pathOf(fileName))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      });
    return stat?.isFile() ?? false;
  }

  /**
   * Atomic: until it resolves, readers see no file under `fileName` (or the
   * previous one), never a partial write; a rejected store leaves nothing
   * behind. Photo and cutout are written concurrently and the thumb writer
   * reads whichever exists, which is why this matters (AGENTS.md Gotchas).
   */
  async store(fileName: string, stream: Readable): Promise<void> {
    const tempPath = path.join(this.incoming, `${randomUUID()}-${fileName}`);
    try {
      await pipeline(stream, fs.createWriteStream(tempPath));
      await fs.promises.rename(tempPath, this.pathOf(fileName));
    } catch (error) {
      // `force` covers a stream that failed before the file was opened.
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }
  }

  /**
   * A missing file is not an error: most photos have no cutout, so
   * deleteVariants asks for files that were never written.
   */
  async delete(fileName: string): Promise<void> {
    await fs.promises.unlink(this.pathOf(fileName)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /** Every file in the directory but the markers; the caller filters. */
  async *list(): AsyncIterable<StoredObject> {
    const entries = await fs.promises.readdir(this.directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      // The marker, its orphans and a withdrawal in flight.
      if (!entry.isFile() || entry.name.startsWith(STORAGE_MARKER)) continue;
      const stat = await fs.promises
        .stat(this.pathOf(entry.name))
        .catch((error: unknown) => {
          // Deleted between the listing and now: no longer an object.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          }
          throw error;
        });
      if (stat) yield { name: entry.name, lastModified: stat.mtime };
    }
  }

  /**
   * Moves `names` (one photo set) into `.trash/<day>/<setName>/`, by
   * rename, never a copy: atomic and byte-preserving. A set of that name
   * already in the day's folder (quarantined, restored, quarantined again)
   * gets a fresh suffixed directory, so nothing in the trash is ever
   * overwritten. A file gone meanwhile is skipped; undefined when none was
   * there to move.
   */
  async quarantine(
    setName: string,
    names: readonly string[],
    day: IsoDate,
  ): Promise<TrashedSet | undefined> {
    const dayDir = path.join(this.directory, TRASH_DIR, day);
    await fs.promises.mkdir(dayDir, { recursive: true });
    const entry = await createFreshDirectory(dayDir, path.basename(setName));
    const files: string[] = [];
    for (const name of names) {
      const file = path.basename(name);
      try {
        await fs.promises.rename(
          this.pathOf(file),
          path.join(dayDir, entry, file),
        );
        files.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (files.length === 0) {
      await fs.promises.rmdir(path.join(dayDir, entry));
      return undefined;
    }
    return { day, entry, files };
  }

  /** Every quarantined set, by day directory; none when nothing was quarantined. */
  async trash(): Promise<TrashedSet[]> {
    const root = path.join(this.directory, TRASH_DIR);
    const sets: TrashedSet[] = [];
    for (const day of await directoriesIn(root)) {
      if (!TRASH_DAY.test(day)) continue;
      for (const entry of await directoriesIn(path.join(root, day))) {
        const files = await fs.promises.readdir(path.join(root, day, entry));
        sets.push({ day, entry, files: files.sort() });
      }
    }
    return sets;
  }

  /** The day directories of `.trash`, oldest first. */
  async trashDays(): Promise<IsoDate[]> {
    const days = await directoriesIn(path.join(this.directory, TRASH_DIR));
    return days.filter((day) => TRASH_DAY.test(day)).sort();
  }

  /** Deletes one day's quarantine, every set in it. */
  async removeTrashDay(day: IsoDate): Promise<void> {
    if (!TRASH_DAY.test(day)) throw new Error(`Not a trash day: ${day}`);
    await fs.promises.rm(path.join(this.directory, TRASH_DIR, day), {
      recursive: true,
    });
  }

  /**
   * Moves quarantined entries (one photo set, possibly split across
   * entries by a quarantine that failed mid-set) back into DATA_PATH, where
   * list() finds them, whole or not at all: every file is linked first (a
   * link fails with EEXIST rather than replace a live file), and the trash
   * lets go only once all are. A failed link unlinks the ones this call
   * made and throws RestoreFailed, naming any it could not unlink. Every
   * restored file's mtime becomes `now`, so reconciliation's day-old grace
   * starts at the restore rather than at the upload.
   *
   * Once every file is live the restore has happened, so letting go of the
   * trash (its names, then emptied directories) is best effort: what stays
   * is answered as `leftInTrash`, never a rejection (#841). A live name
   * that already is its trash file (the same inode: an earlier restore
   * linked it, then could not let go) counts as restored, so running the
   * restore again finishes the job.
   */
  async restore(
    sets: readonly TrashedSet[],
    now: Date,
  ): Promise<{ leftInTrash: TrashLeftover[] }> {
    const moves = sets.flatMap((set) =>
      set.files.map((file) => ({
        from: path.join(this.trashEntryPath(set), path.basename(file)),
        to: this.pathOf(file),
      })),
    );
    // Only names this call made: one live before it is never taken back.
    const linked: string[] = [];
    try {
      for (const { from, to } of moves) {
        if (await this.linkBack(from, to)) linked.push(to);
      }
      for (const { to } of moves) await fs.promises.utimes(to, now, now);
    } catch (error) {
      // Each is a second name of a file the trash still holds.
      const stranded: string[] = [];
      for (const to of linked) {
        await this.storageFs
          .remove(to)
          .catch(() => stranded.push(path.basename(to)));
      }
      throw new RestoreFailed(error, stranded);
    }
    const leftInTrash: TrashLeftover[] = [];
    const letGo = (where: string, work: Promise<void>) =>
      work.catch((error: unknown) => {
        leftInTrash.push({ path: this.trashRelative(where), error });
      });
    for (const { from } of moves) {
      await letGo(from, this.storageFs.remove(from));
    }
    for (const set of sets) {
      const entry = this.trashEntryPath(set);
      await letGo(entry, removeIfEmpty(entry));
      // Other sets quarantined that day stay.
      await letGo(path.dirname(entry), removeIfEmpty(path.dirname(entry)));
    }
    return { leftInTrash };
  }

  /**
   * The names of `sets`' files whose live name in DATA_PATH is the trash
   * file itself (a hard link a restore made): restored already, never a
   * live set the restore would land on.
   */
  async liveFromTrash(sets: readonly TrashedSet[]): Promise<Set<string>> {
    const live = new Set<string>();
    for (const set of sets) {
      for (const file of set.files) {
        const from = path.join(this.trashEntryPath(set), path.basename(file));
        if (await sameFile(from, this.pathOf(file))) live.add(file);
      }
    }
    return live;
  }

  // Links a trash file back, answering whether this call made the name:
  // false when it already is that file (restored before).
  private async linkBack(from: string, to: string): Promise<boolean> {
    try {
      await this.storageFs.link(from, to);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' && (await sameFile(from, to))) return false;
      throw error;
    }
  }

  // `<day>/<entry>[/<file>]`: what an operator finds under .trash.
  private trashRelative(where: string): string {
    return path.relative(path.join(this.directory, TRASH_DIR), where);
  }

  private trashEntryPath(set: TrashedSet): string {
    return path.join(
      this.directory,
      TRASH_DIR,
      path.basename(set.day),
      path.basename(set.entry),
    );
  }

  // Names come from our own code (variantFileName of a stored name, or a
  // route segment parseStoredName accepted); basename() is the last line
  // against a path ever leaving the directory.
  private pathOf(fileName: string): string {
    return path.join(this.directory, path.basename(fileName));
  }
}

// Whether two paths name one file (a hard link); false when either is gone.
async function sameFile(a: string, b: string): Promise<boolean> {
  const stat = (file: string) =>
    fs.promises.stat(file).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  const [first, second] = await Promise.all([stat(a), stat(b)]);
  return (
    first !== undefined &&
    second !== undefined &&
    first.dev === second.dev &&
    first.ino === second.ino
  );
}

// The subdirectories of `directory`; none when it does not exist.
async function directoriesIn(directory: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

// A directory already gone (the second set of one day) is as good as removed.
async function removeIfEmpty(directory: string): Promise<void> {
  await fs.promises.rmdir(directory).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error;
  });
}

// mkdir fails with EEXIST rather than reuse a directory, so the name
// returned is one this call created, empty.
async function createFreshDirectory(
  parent: string,
  name: string,
): Promise<string> {
  for (
    let candidate = name;
    ;
    candidate = `${name}~${randomUUID().slice(0, 8)}`
  ) {
    try {
      await fs.promises.mkdir(path.join(parent, candidate));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function parseMarker(text: string): StorageMarker | undefined {
  try {
    const value = JSON.parse(text) as Partial<StorageMarker> | null;
    if (
      typeof value?.installId === 'string' &&
      value.installId.length > 0 &&
      typeof value.createdAt === 'string'
    ) {
      return { installId: value.installId, createdAt: value.createdAt };
    }
  } catch {
    // Not JSON: not ours.
  }
  return undefined;
}
