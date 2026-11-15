import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { parseStoredName } from './image-variant';
import {
  pairedInstallId,
  pairInstallOnce,
  photoRowNames,
  repairInstallId,
} from './queries';
import {
  type IdentityProblem,
  type InstallPairing,
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
export const ADOPT_MIN_COVERAGE = 0.9;

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
 * Called by createPhotos, so the server's boot and every CLI that writes
 * photos (reconcile, retrim, seed) refuse the same directory.
 */
export async function claimStorage(
  storage: PhotoStorage,
  db: Db,
  logger: Logger,
  pairing: InstallPairing,
): Promise<StorageMarker> {
  const read = await storage.readMarker();
  if (read.state === 'unreadable') {
    throw new StorageIdentityError({ kind: 'unreadable', code: read.code });
  }
  const pairedAtStart = await pairedInstallId(db);
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

// An unmarked DATA_PATH: marked when #650's rules prove it is ours. The id
// it gets is settled before anything is written (#851): an unpaired
// database is paired first, so a claim that loses the pairing race writes
// the winner's id, never a marker of its own that the database refuses
// forever after. The marker is still created exclusively (createMarker:
// written new, then linked).
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
  const paired = pairedAtStart ?? (await pair(db, randomUUID(), logger));
  const installId =
    pairedAtStart === undefined || rows.length > 0
      ? paired
      : newStorageBesidePaired(paired, pairing, logger);
  // Ours, or the marker a process booting beside this one linked first.
  const created = await storage.createMarker(installId);
  if (created.state === 'unreadable') {
    throw new StorageIdentityError({ kind: 'unreadable', code: created.code });
  }
  const { marker } = created;
  if (rows.length === 0) {
    logger.info(
      pairedAtStart === undefined
        ? `Photo storage ${marker.installId}: marked (no photo rows yet: a first boot)`
        : `Photo storage ${marker.installId}: marked as new storage (no photo rows)`,
    );
  } else {
    logger.warn(
      `Photo storage ${marker.installId}: adopted an unmarked directory holding the photos of ${covered} of ${rows.length} rows`,
    );
  }
  return { marker, paired };
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

export type StorageRepair = { paired: string } | { refused: string };

/**
 * `maintenance:reconcile -- --repair-storage-identity --confirm`: pairs the
 * database with the marker DATA_PATH holds now, once an operator checked it
 * is the right share (a deliberate restore onto new storage:
 * docs/operations.md#photo-storage-marker). Never writes the marker, so an
 * unmounted share (no marker) is refused, never paired. Runs without
 * claimStorage, which refuses exactly this storage.
 */
export async function repairStorageIdentity(
  storage: PhotoStorage,
  db: Db,
  logger: Logger,
): Promise<StorageRepair> {
  const read = await storage.readMarker();
  if (read.state === 'absent') {
    return { refused: identityRefusal({ kind: 'absent' }) };
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
