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
 * readiness TTL (src/web/health/checks.ts). The boot's sweep gets the same.
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
}

/** What the boot's sweep of leftover probe files needs. */
export interface SweepFs {
  readdir: (directory: string) => Promise<string[]>;
  rm: (path: string, options: { force: true }) => Promise<void>;
}

const nodeFs: ProbeFs & SweepFs = { mkdir, writeFile, rm, readdir };

/**
 * Where a share's probe files live, so the boot's sweep lists this small
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
 * O(1) in the directory's size (#855): a mkdir, one named write and its
 * unlink, never a listing, which on a large NFS share could outlast the
 * readiness bound; and nothing but its own file decides the verdict (#856).
 * Each probe's file is named for this process's random id and a counter,
 * so no two probes anywhere share one (DATA_PATH and MODELS_PATH may be
 * the same; the boot probe and the readiness check overlap; two
 * containers may mount one share). A write that
 * hangs on a stalled share unlinks once it settles; only a process that
 * died first leaves its file behind, for the next boot's
 * sweepProbeLeftovers.
 */
export type WriteProbe = { writable: true } | { writable: false; code: string };

export async function probeWritable(
  directory: string,
  fs: ProbeFs = nodeFs,
): Promise<WriteProbe> {
  const probeDirectory = join(directory, PROBE_DIRECTORY);
  const probe = join(probeDirectory, `${PROBE_PREFIX}${++probeCounter}`);
  try {
    // Also makes `directory`, as its writers do.
    await fs.mkdir(probeDirectory, { recursive: true });
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

export type ProbeSweep =
  | { swept: true; removed: number }
  | { swept: false; code: string };

/**
 * Removes the probe files dead processes left in `directory`'s
 * PROBE_DIRECTORY (a write that hung until its container stopped); it lists
 * only that directory, which holds a few probe files, never the share. Files
 * builds before this left in the share's root are not swept (that would be
 * the listing this avoids); they are harmless dotfiles. Run once per boot (sweepLeftoversInBackground), so a
 * listing's cost is never paid inside the readiness bound. Any
 * `.write-probe-` file is fair game: another live process's is only ever
 * mid-write, and removing it costs that probe nothing (its bytes go to the
 * unlinked inode, its own rm is `force`). Never rejects: the probe, not the
 * sweep, says whether the directory can be written.
 */
export async function sweepProbeLeftovers(
  directory: string,
  fs: SweepFs = nodeFs,
): Promise<ProbeSweep> {
  const probeDirectory = join(directory, PROBE_DIRECTORY);
  try {
    const leftovers = (await fs.readdir(probeDirectory)).filter((name) =>
      name.startsWith(PROBE_FAMILY),
    );
    for (const name of leftovers) {
      await fs.rm(join(probeDirectory, name), { force: true });
    }
    return { swept: true, removed: leftovers.length };
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    // No probe directory yet holds no leftovers; the probe makes it.
    return code === 'ENOENT'
      ? { swept: true, removed: 0 }
      : { swept: false, code };
  }
}

/**
 * At most ONE fs operation in flight per directory, across every caller that
 * shares an instance. A timeout cannot cancel an fs call, and each abandoned
 * one holds one of libuv's four pool threads (a few stall every fs call and
 * DNS lookup in the process), so a caller whose directory is busy gets
 * `undefined` and starts nothing. The slot frees when the operation settles.
 */
export interface DirectoryFlights {
  tryStart: <T>(
    directory: string,
    run: () => Promise<T>,
  ) => Promise<T> | undefined;
}

export function createDirectoryFlights(): DirectoryFlights {
  const busy = new Set<string>();
  return {
    tryStart: (directory, run) => {
      if (busy.has(directory)) return undefined;
      busy.add(directory);
      const started = (async () => run())();
      const free = (): void => {
        busy.delete(directory);
      };
      started.then(free, free);
      return started;
    },
  };
}

/**
 * The process's flights: /health/ready's storage check (routes.ts) and the
 * boot's sweep share it, so a sweep's readdir and a readiness probe never
 * hold two threads on one share. Specs build their own.
 */
export const storageFlights = createDirectoryFlights();

/**
 * Sweeps each distinct directory's leftovers without ever delaying the
 * caller: a readdir on a stalled share never settles, and the boot must
 * still listen (readiness reports that share as `storage` down, #688). Each
 * sweep runs in the directory's flight (a share the readiness probe is
 * already stuck on is skipped, logged) and is bounded by
 * STORAGE_PROBE_TIMEOUT_MS; one line logs its outcome. A timeout cannot
 * cancel the readdir, so it stops being waited on and its eventual outcome
 * is logged when it settles (`late`). Called by main.ts after serve() is
 * listening; the returned promise never rejects and exists for the specs.
 */
export function sweepLeftoversInBackground(
  directories: readonly string[],
  log: Logger,
  {
    fs = nodeFs,
    timeoutMs = STORAGE_PROBE_TIMEOUT_MS,
    flights = storageFlights,
  }: { fs?: SweepFs; timeoutMs?: number; flights?: DirectoryFlights } = {},
): Promise<void> {
  const report = (
    directory: string,
    sweep: ProbeSweep,
    late: true | undefined,
  ): void => {
    if (!sweep.swept) {
      log.warn(
        { directory, code: sweep.code, late },
        'Could not sweep probe leftovers',
      );
    } else if (sweep.removed > 0 || late) {
      log.info(
        { directory, removed: sweep.removed, late },
        'Removed probe leftovers',
      );
    }
  };
  const one = async (directory: string): Promise<void> => {
    const started = flights.tryStart(directory, () =>
      sweepProbeLeftovers(directory, fs),
    );
    if (!started) {
      log.warn(
        { directory },
        'Probe leftover sweep skipped; another storage call on the share has not settled',
      );
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref();
    });
    const sweep = await Promise.race([started, timedOut]);
    clearTimeout(timer);
    if (sweep === 'timeout') {
      log.warn(
        { directory, timeout_ms: timeoutMs },
        'Probe leftover sweep timed out; the share is not answering',
      );
      // sweepProbeLeftovers never rejects.
      void started.then((late) => report(directory, late, true));
    } else {
      report(directory, sweep, undefined);
    }
  };
  return Promise.all([...new Set(directories)].map(one)).then(() => undefined);
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
