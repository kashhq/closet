import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { parseStoredName } from './image-variant';
import {
  isStorageClaim,
  pairedInstallId,
  pairInstallOnce,
  photoRowNames,
  recordStorageClaim,
  repairInstallId,
} from './queries';
import {
  type IdentityProblem,
  type InstallPairing,
  type MarkerRead,
  type PhotoStorage,
  STORAGE_MARKER,
  type StorageMarker,
} from './storage';

/**
 * The share of `file` rows whose photo set an unmarked directory must hold
 * to be adopted. Not "any photo": a bare mountpoint collects stray uploads
 * while the share is unmounted (the very story of #650), so a few sets
 * prove nothing. Not every row either: a row whose original was lost
 * (reconciliation's `missingOriginals`) must not lock a real share out.
 * An existing share holds nearly all of them; a mountpoint with a night's
 * strays holds next to none.
 */
const ADOPT_MIN_COVERAGE = 0.9;

/**
 * Whether DATA_PATH is the household's photo storage (#650). Contents
 * alone cannot say: a bare mountpoint (the NFS share not mounted) reads as
 * storage whose every photo is gone, and reconciliation would act on it
 * while uploads landed where the remount hides them. So the directory
 * carries a marker (STORAGE_MARKER), written only when this process can
 * prove the directory is the right one:
 *   - the `file` table is empty: a first boot, nothing to lose (beside a
 *     database already paired, new storage with an id of its own, or
 *     refused where the pairing is enforced: #850);
 *   - the directory holds the sets of at least ADOPT_MIN_COVERAGE of the
 *     rows: an existing share from before the marker, adopted.
 * Anything else unmarked is the unmounted share or the wrong directory, and
 * so is a marker that cannot be read: refused, nothing written there.
 *
 * And the marker must be this database's (#833): the `install` row records
 * its install id, written by the claim that writes or adopts the marker
 * (or, at the first claim after that table shipped, from the marker already
 * there), so a marked share from another install, or a database restored
 * from another install's dump, is refused. A marker this claim writes
 * carries the paired id, so re-adopting a restored, unmarked share pairs.
 * Only `enforced` pairing (APP_ENV production) refuses a mismatch: in dev
 * and gate, worktrees each with their own DATA_PATH share one database, so
 * it is one warn line and the claim goes on (#650's rules apply in all).
 *
 * A marker beside a database paired with another id is refused only when
 * this database never wrote it: one whose id a claim of this database
 * recorded (storage_claim) is that claim's own, left by a crash after it
 * lost the pairing race and before it withdrew it (#1049). It is withdrawn
 * (kept as an orphan: that claim may have been the real share's, and the
 * repair command can put it back) and the directory claimed as unmarked, by
 * #650 and #850's rules.
 *
 * Called by createPhotos, so the server's boot and every CLI that writes
 * photos (reconcile, retrim, seed) refuse the same directory.
 */
export async function claimStorage(
  storage: PhotoStorage,
  db: Db,
  logger: Logger,
  pairing: InstallPairing,
): Promise<StorageMarker> {
  const pairedAtStart = await pairedInstallId(db);
  const read = await healOrphan(
    storage,
    db,
    await storage.readMarker(),
    pairedAtStart,
    logger,
  );
  if (read.state === 'unreadable') {
    throw new StorageIdentityError({ kind: 'unreadable', code: read.code });
  }
  const { marker, paired } =
    read.state === 'present'
      ? {
          marker: read.marker,
          paired:
            pairedAtStart ?? (await pair(db, read.marker.installId, logger)),
        }
      : await markUnmarked(storage, db, pairedAtStart, pairing, logger);
  if (paired !== marker.installId) {
    const mismatch = `photo storage ${marker.installId}: this database belongs to install ${paired}`;
    if (pairing === 'enforced') {
      logger.warn(`Refusing ${mismatch}`);
      throw new StorageIdentityError({ kind: 'unpaired' });
    }
    logger.warn(`Using ${mismatch} (not refused outside APP_ENV production)`);
  }
  storage.claim(marker, pairing);
  logger.info(`Photo storage ${marker.installId} (marked ${marker.createdAt})`);
  return marker;
}

// A marker this database's own claim wrote and lost the pairing with
// (claimStorage) is withdrawn, answering what DATA_PATH holds after: absent,
// or the marker a process healing beside this one wrote meanwhile.
async function healOrphan(
  storage: PhotoStorage,
  db: Db,
  read: MarkerRead,
  paired: string | undefined,
  logger: Logger,
): Promise<MarkerRead> {
  if (
    read.state !== 'present' ||
    paired === undefined ||
    read.marker.installId === paired ||
    !(await isStorageClaim(db, read.marker.installId))
  ) {
    return read;
  }
  logger.warn(
    `Photo storage ${read.marker.installId}: a claim of this database wrote this marker and lost the pairing to install ${paired}; moving it aside as an orphan (--repair-storage-identity --orphan ${read.marker.installId} puts it back)`,
  );
  await withdrawMarker(storage, read.marker);
  return storage.readMarker();
}

// Removes this claim's own marker, a filesystem failure refused like an
// unreadable marker: the code, never the path.
async function withdrawMarker(
  storage: PhotoStorage,
  marker: StorageMarker,
): Promise<void> {
  try {
    await storage.withdrawMarker(marker);
  } catch (error) {
    throw new StorageIdentityError({
      kind: 'unreadable',
      code: String((error as NodeJS.ErrnoException).code),
    });
  }
}

// Pairs an unpaired database with `installId`, answering the id it is paired
// with: a process claiming beside this one may have paired first.
async function pair(
  db: Db,
  installId: string,
  logger: Logger,
): Promise<string> {
  const paired = await pairInstallOnce(db, installId);
  if (paired === installId) {
    logger.info(`Photo storage ${installId} paired with this database`);
  }
  return paired;
}

// An unmarked DATA_PATH: marked when #650's rules prove it is ours. Every
// crash point must heal at the next boot, so an unpaired database is paired
// only after the marker exists (a marker beside an unpaired database is
// adopted: claimStorage), never before it: a pairing whose marker write
// failed would leave a database whose next boot over that directory, with
// no photo rows, refuses forever (#850's rule). A pairing that loses to
// another claim (another DATA_PATH on this database) withdraws the marker
// this claim wrote and marks as beside a paired database; a marker linked
// first by a process booting on this directory is that process's, and both
// pair with it (#851).
async function markUnmarked(
  storage: PhotoStorage,
  db: Db,
  pairedAtStart: string | undefined,
  pairing: InstallPairing,
  logger: Logger,
): Promise<{ marker: StorageMarker; paired: string }> {
  const rows = await photoRowNames(db);
  const covered = rows.length === 0 ? 0 : await coveredRows(storage, rows);
  if (rows.length > 0 && covered < rows.length * ADOPT_MIN_COVERAGE) {
    logger.warn(
      `Refusing an unmarked DATA_PATH holding the photos of ${covered} of ${rows.length} rows`,
    );
    throw new StorageIdentityError({ kind: 'absent' });
  }
  const proof: RowProof =
    rows.length === 0 ? undefined : { covered, rows: rows.length };
  let paired = pairedAtStart;
  if (paired === undefined) {
    const marked = await markThenPair(storage, db, proof, logger);
    if ('marker' in marked) return marked;
    paired = marked.lostTo;
  }
  const installId =
    proof === undefined
      ? newStorageBesidePaired(paired, pairing, logger)
      : paired;
  const marker = await createMarker(storage, installId);
  if (marker.installId === installId) {
    logMarked(logger, marker, proof, true);
  }
  return { marker, paired };
}

type RowProof = { covered: number; rows: number } | undefined;

// An unpaired database: the marker first, with an id of its own, then the
// pairing with whichever marker is on disk now. Answers `lostTo` when
// another claim paired the database meanwhile, with this claim's marker
// withdrawn: the caller marks as beside that pairing. The id is recorded
// before the marker, so a crash before the withdrawal leaves a marker the
// next boot knows as its own (healOrphan), never as another install's.
async function markThenPair(
  storage: PhotoStorage,
  db: Db,
  proof: RowProof,
  logger: Logger,
): Promise<{ marker: StorageMarker; paired: string } | { lostTo: string }> {
  const ownId = randomUUID();
  await recordStorageClaim(db, ownId);
  const marker = await createMarker(storage, ownId);
  const paired = await pair(db, marker.installId, logger);
  const ours = marker.installId === ownId;
  // Another process's marker: claimStorage's comparison decides.
  if (!ours) return { marker, paired };
  if (paired === ownId) {
    logMarked(logger, marker, proof, false);
    return { marker, paired };
  }
  logger.warn(
    `Photo storage ${ownId}: this database was paired with install ${paired} meanwhile; withdrawing the marker`,
  );
  await withdrawMarker(storage, marker);
  return { lostTo: paired };
}

// Ours, or the marker a process booting beside this one linked first.
async function createMarker(
  storage: PhotoStorage,
  installId: string,
): Promise<StorageMarker> {
  const created = await storage.createMarker(installId);
  if (created.state === 'unreadable') {
    throw new StorageIdentityError({ kind: 'unreadable', code: created.code });
  }
  return created.marker;
}

function logMarked(
  logger: Logger,
  marker: StorageMarker,
  proof: RowProof,
  besidePaired: boolean,
): void {
  if (proof) {
    logger.warn(
      `Photo storage ${marker.installId}: adopted an unmarked directory holding the photos of ${proof.covered} of ${proof.rows} rows`,
    );
  } else {
    logger.info(
      besidePaired
        ? `Photo storage ${marker.installId}: marked as new storage (no photo rows)`
        : `Photo storage ${marker.installId}: marked (no photo rows yet: a first boot)`,
    );
  }
}

// An unmarked DATA_PATH with no photo rows beside a database already paired
// with a share (#850). Coverage is what proves a directory is the paired
// share (a restore re-adopting as itself); an empty table proves only that
// nothing is lost, and a bare mountpoint is exactly that. Given the paired
// id, it would pass for the real share once that is mounted over it, and
// the uploads made meanwhile would vanish unseen. So it is never given that
// id: production refuses it, as an unmounted share; elsewhere (worktrees on
// one database) it is new storage with an id of its own, which the claim
// then warns about, and a remount reads as foreign.
function newStorageBesidePaired(
  paired: string,
  pairing: InstallPairing,
  logger: Logger,
): string {
  if (pairing === 'enforced') {
    logger.warn(
      `Refusing an unmarked DATA_PATH with no photo rows: this database belongs to photo storage ${paired}`,
    );
    throw new StorageIdentityError({ kind: 'absent' });
  }
  return randomUUID();
}

/**
 * Whether DATA_PATH is still the storage this process claimed and, where
 * the pairing is enforced, the one the database is paired with: every
 * reconciliation run asks (a job may read the row; the database can be
 * restored or repointed under a running server). Readiness asks only
 * PhotoStorage.identityProblem, the marker against the id claimed at boot,
 * never the database: storage and database health stay separate checks.
 */
export async function storageIdentityProblem(
  storage: PhotoStorage,
  db: Db,
): Promise<IdentityProblem | undefined> {
  const problem = await storage.identityProblem();
  if (problem || storage.installPairing === 'advisory') return problem;
  const paired = await pairedInstallId(db);
  return paired === storage.claimedInstallId ? undefined : { kind: 'unpaired' };
}

export type StorageRepair =
  | { paired: string }
  | { refused: string; orphans?: StorageMarker[] };

/**
 * `maintenance:reconcile -- --repair-storage-identity --confirm`: pairs the
 * database with the marker DATA_PATH holds now, once an operator checked it
 * is the right share (a deliberate restore onto new storage:
 * docs/operations.md#photo-storage-marker). Never writes a new marker, so
 * an unmounted share (no marker) is refused, never paired; the refusal
 * lists the orphaned markers there (withdrawn by a claim that lost its
 * pairing, #1049), and `--orphan <id>` puts that one back and pairs it.
 * Runs without claimStorage, which refuses exactly this storage.
 */
export async function repairStorageIdentity(
  storage: PhotoStorage,
  db: Db,
  logger: Logger,
  { orphan }: { orphan?: string } = {},
): Promise<StorageRepair> {
  if (orphan !== undefined) {
    if (!(await storage.restoreOrphan(orphan))) {
      return {
        refused: `DATA_PATH holds a ${STORAGE_MARKER} already, or no orphaned marker of install ${orphan}`,
        orphans: (await storage.orphanedMarkers()).map((o) => o.marker),
      };
    }
    logger.warn(`Storage identity: put back the orphaned marker of ${orphan}`);
  }
  const read = await storage.readMarker();
  if (read.state === 'absent') {
    const orphans = (await storage.orphanedMarkers()).map((o) => o.marker);
    return {
      refused: identityRefusal({ kind: 'absent' }),
      ...(orphans.length > 0 && { orphans }),
    };
  }
  if (read.state === 'unreadable') {
    return {
      refused: identityRefusal({ kind: 'unreadable', code: read.code }),
    };
  }
  const was = await pairedInstallId(db);
  await repairInstallId(db, read.marker.installId);
  logger.warn(
    `Storage identity repaired: the database now belongs to photo storage ${read.marker.installId} (was ${was ?? 'unpaired'})`,
  );
  return { paired: read.marker.installId };
}

/** Where an operator reads what the marker is and how to re-adopt. */
export const STORAGE_MARKER_FIX = 'docs/operations.md#photo-storage-marker';

/**
 * The refusal, naming the key and never its value (the boot logged that
 * already): main.ts logs it through identityRefusal, like a ConfigError.
 */
export class StorageIdentityError extends Error {
  constructor(readonly problem: IdentityProblem) {
    super(identityRefusal(problem));
    this.name = 'StorageIdentityError';
  }
}

/** One wording for the boot, readiness's log line and reconciliation. */
export function identityRefusal(problem: IdentityProblem): string {
  switch (problem.kind) {
    case 'absent':
      return (
        `DATA_PATH has no ${STORAGE_MARKER} marker: ` +
        `the photo share is not mounted, or DATA_PATH is the wrong directory (${STORAGE_MARKER_FIX})`
      );
    case 'foreign':
      return (
        `DATA_PATH holds another install's ${STORAGE_MARKER} than the one this process booted with: ` +
        `a different share was mounted (${STORAGE_MARKER_FIX})`
      );
    case 'unpaired':
      return (
        `DATA_PATH holds the ${STORAGE_MARKER} of another install than the one this database belongs to: ` +
        `another household's or a copy's share, or a restore onto new storage (${STORAGE_MARKER_FIX})`
      );
    case 'unreadable':
      return `DATA_PATH storage unreadable: ${problem.code} (${STORAGE_MARKER_FIX})`;
  }
}

// How many rows have any file of their set in storage, from one listing.
async function coveredRows(
  storage: PhotoStorage,
  rows: readonly string[],
): Promise<number> {
  const stored = new Set<string>();
  for await (const object of storage.list()) {
    const parsed = parseStoredName(object.name);
    if (parsed) stored.add(parsed.baseName);
  }
  return rows.filter((name) => stored.has(name)).length;
}
