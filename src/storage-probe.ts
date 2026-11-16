import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The bytes a probe writes: enough that a full disk or an exhausted quota
 * (ENOSPC, EDQUOT) refuses the write, as it would an upload, where an empty
 * file would still be created.
 */
export const PROBE_BYTES = 4096;

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
 * the first upload or download would hit. The probe file is a dotfile:
 * reconciliation and the /file routes only ever see stored photo names.
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
  const probe = join(directory, `${PROBE_PREFIX}${++probeCounter}`);
  try {
    await fs.mkdir(directory, { recursive: true });
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
 * Removes the probe files dead processes left in `directory` (a write that
 * hung until its container stopped), the pid-named ones of builds before
 * #857 included. Run once per boot (main.ts), before its first probe, so a
 * listing's cost is paid there and never inside the readiness bound. Any
 * `.write-probe-` file is fair game: another live process's is only ever
 * mid-write, and removing it costs that probe nothing (its bytes go to the
 * unlinked inode, its own rm is `force`). Never rejects: the probe, not the
 * sweep, says whether the directory can be written.
 */
export async function sweepProbeLeftovers(
  directory: string,
  fs: SweepFs = nodeFs,
): Promise<ProbeSweep> {
  try {
    const leftovers = (await fs.readdir(directory)).filter((name) =>
      name.startsWith(PROBE_FAMILY),
    );
    for (const name of leftovers) {
      await fs.rm(join(directory, name), { force: true });
    }
    return { swept: true, removed: leftovers.length };
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    // A directory not made yet holds no leftovers; the probe makes it.
    return code === 'ENOENT'
      ? { swept: true, removed: 0 }
      : { swept: false, code };
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
