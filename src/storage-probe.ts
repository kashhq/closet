import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './logger';

/**
 * The bytes a probe writes: enough that a full disk or an exhausted quota
 * (ENOSPC, EDQUOT) refuses the write, as it would an upload, where an empty
 * file would still be created.
 */
export const PROBE_BYTES = 4096;

/**
 * The bound on one directory's probe, as the database's: under the
 * readiness TTL (src/web/health/checks.ts).
 */
export const STORAGE_PROBE_TIMEOUT_MS = 3_000;

/** The filesystem calls a probe makes; the unit specs inject failing ones. */
export interface ProbeFs {
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (
    path: string,
    data: Uint8Array,
    options: { flag: 'wx' },
  ) => Promise<void>;
  rm: (path: string, options: { force: true }) => Promise<void>;
  readdir: (directory: string) => Promise<string[]>;
}

/**
 * A directory the process writes at runtime, with the config key that names
 * it: the key is what logs say, never the path (the storage check's rule:
 * only the code, never the path, reaches the log).
 */
export interface StorageDirectory {
  key: 'DATA_PATH' | 'MODELS_PATH';
  path: string;
}

/** Where a probe's one-time sweep reports, and the key it names the directory by. */
export interface SweepLog {
  logger: Logger;
  label: StorageDirectory['key'];
}

const nodeFs: ProbeFs = { mkdir, writeFile, rm, readdir };

/**
 * Where a share's probe files live, so the probe's one-time sweep lists this small
 * directory and never the share (#901: a readdir of a large NFS share is the
 * cost the probes avoid). A dot-directory beside `.incoming` and `.trash`:
 * PhotoStorage.list() skips directories and reconciliation only reads
 * through it, so neither sees it; it sits inside the mount the image
 * already chowns (docs/operations.md#permissions).
 */
export const PROBE_DIRECTORY = '.closet-probe';

/** Every probe file's name starts so, whichever process wrote it. */
const PROBE_FAMILY = '.write-probe-';
/**
 * This process's names carry a random id, never the pid, which is 1 in
 * most containers: two containers on one share (production and its HTTP
 * twin) would mint the same names, and one's `wx` write would meet the
 * other's file (#857). Not seededRandom's business: that rule is for data
 * that must come out the same, and this must not.
 */
const PROBE_PREFIX = `${PROBE_FAMILY}${randomUUID()}-`;
let probeCounter = 0;

/**
 * Whether this process can write a directory it needs at runtime: DATA_PATH
 * (photos) and MODELS_PATH (the cutout model's download). Used by
 * main.ts (DATA_PATH at boot) and
 * /health/ready's `storage` check (src/web/health/checks.ts).
 *
 * Why a real write and not mode bits or access(W_OK): the image runs as an
 * unprivileged user (uid 1000, docs/operations.md#permissions) and its
 * directories are host bind mounts, one of them NFS with all users squashed
 * to the NAS admin. Only the server decides there, and a create + unlink is
 * the one question every filesystem answers truthfully.
 *
 * The directory is created when missing, as its writers do (PhotoStorage's
 * prepare, CutoutModel's download), so "not writable" means exactly what
 * the first upload or download would hit. The probe file lives in
 * PROBE_DIRECTORY: reconciliation and the /file routes only ever see stored
 * photo names.
 *
 * O(1) in the share's size (#855): a mkdir, one named write and its unlink,
 * never a listing of the share, and nothing but its own file decides the
 * verdict (#856). Each probe's file is named for this process's random id
 * and a counter, so no two probes anywhere share one (DATA_PATH and
 * MODELS_PATH may be the same; two containers may mount one share). A write
 * that hangs on a stalled share unlinks once it settles.
 *
 * The first probe of a directory, once per process, also sweeps the files a
 * dead process left in PROBE_DIRECTORY (a write that hung until its
 * container stopped): it lists that small directory, never the share, and
 * removes every `.write-probe-` file. This is a step of the probe, not a
 * second operation, so it runs inside the caller's deadline and the check's
 * single-flight (a separate sweep collided with the readiness probe, #1074,
 * #1075). Any such file is fair game: another live process's is only ever
 * mid-write, and removing it costs that probe nothing (its bytes go to the
 * unlinked inode, its own rm is `force`). The sweep is best effort and
 * attempted once per process per directory, whatever its outcome (a failing
 * or stalled list is never retried: it would re-run, and re-log, every
 * window); the write, not the sweep, says whether the directory can be
 * written. The boot's check passes `sweep: false`: it must stay a bounded
 * write, and only a readiness probe, which has a deadline, lists.
 */
export type WriteProbe = { writable: true } | { writable: false; code: string };

const sweepAttempted = new Set<string>();

async function sweepLeftovers(
  directory: string,
  probeDirectory: string,
  fs: ProbeFs,
  log: SweepLog | undefined,
): Promise<void> {
  // Recorded before the list, so an attempt that stalls past the probe's
  // deadline or fails is still the one attempt.
  sweepAttempted.add(directory);
  try {
    const leftovers = (await fs.readdir(probeDirectory)).filter((name) =>
      name.startsWith(PROBE_FAMILY),
    );
    for (const name of leftovers) {
      await fs.rm(join(probeDirectory, name), { force: true });
    }
    if (leftovers.length > 0) {
      log?.logger.info(
        { directory: log.label, removed: leftovers.length },
        'Removed probe leftovers',
      );
    }
  } catch (error) {
    // Once per process, and the config key, never the path: the storage check's log rules.
    log?.logger.warn(
      {
        directory: log.label,
        code: String((error as NodeJS.ErrnoException).code),
      },
      'Could not sweep probe leftovers',
    );
  }
}

export async function probeWritable(
  directory: string,
  {
    fs = nodeFs,
    log,
    sweep = true,
  }: { fs?: ProbeFs; log?: SweepLog; sweep?: boolean } = {},
): Promise<WriteProbe> {
  const probeDirectory = join(directory, PROBE_DIRECTORY);
  const probe = join(probeDirectory, `${PROBE_PREFIX}${++probeCounter}`);
  try {
    // Also makes `directory`, as its writers do.
    await fs.mkdir(probeDirectory, { recursive: true });
    if (sweep && !sweepAttempted.has(directory)) {
      await sweepLeftovers(directory, probeDirectory, fs, log);
    }
    // `wx`: never truncate or follow anything already at that name.
    await fs.writeFile(probe, new Uint8Array(PROBE_BYTES), { flag: 'wx' });
    await fs.rm(probe, { force: true });
    return { writable: true };
  } catch (error) {
    // A write that failed midway (ENOSPC) can leave a partial file.
    await fs.rm(probe, { force: true }).catch(() => undefined);
    // fs/promises rejects with ErrnoExceptions, so `code` is always set.
    return {
      writable: false,
      code: String((error as NodeJS.ErrnoException).code),
    };
  }
}

export interface StorageFailure {
  directory: string;
  code: string;
}

/**
 * What the operator does about each kind of failed probe, keyed by its code
 * (the table is the one place a new code gets its words). The directories
 * are named as the container sees them, since only the host knows what is
 * mounted there; the chown carries this process's own uid:gid, never a
 * hardcoded one.
 */
const FIXES: readonly {
  codes: readonly string[];
  say: (where: string) => string;
}[] = [
  {
    codes: ['EACCES', 'EPERM'],
    say: (where) =>
      `chown -R ${processOwner()} the host directory mounted at ${where}; docs/operations.md#permissions`,
  },
  {
    codes: ['ENOSPC', 'EDQUOT'],
    say: (where) => `the share mounted at ${where} is full`,
  },
  {
    codes: ['TIMEOUT'],
    say: (where) =>
      `the share mounted at ${where} is not answering (NFS stalled?)`,
  },
];

/** Used for a code no row claims (EROFS, EIO, ENOTDIR, ...). */
const GENERIC_FIX = (where: string): string =>
  `${where} cannot be written; docs/operations.md#permissions`;

/** The fix for each distinct kind of failure, joined; never the path value of an error. */
export function storageFix(failures: readonly StorageFailure[]): string {
  const claimed = new Set(FIXES.flatMap((row) => row.codes));
  const groups = [
    ...FIXES.map((row) => ({
      say: row.say,
      failures: failures.filter((f) => row.codes.includes(f.code)),
    })),
    {
      say: GENERIC_FIX,
      failures: failures.filter((f) => !claimed.has(f.code)),
    },
  ];
  return groups
    .filter((group) => group.failures.length > 0)
    .map((group) =>
      group.say(group.failures.map((f) => f.directory).join(' and ')),
    )
    .join('; ');
}

function processOwner(): string {
  // Both exist on every platform closet runs on (POSIX; Windows is not one).
  const { getuid, getgid } = process as Required<
    Pick<NodeJS.Process, 'getuid' | 'getgid'>
  >;
  return `${getuid()}:${getgid()}`;
}
