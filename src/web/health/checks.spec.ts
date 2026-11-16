import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import {
  PROBE_BYTES,
  storageFix,
  probeWritable,
  type ProbeFs,
  type WriteProbe,
} from '../../storage-probe';
import {
  checkCutoutQueue,
  checkDatabase,
  checkJobs,
  checkOrderMailOwner,
  checkTrustedProxies,
  createStorageCheck,
  type HealthCheck,
  readiness,
} from './checks';

/**
 * /health/ready's verdict and checks with their inputs stubbed: the 503
 * paths no healthy integration database can show. The real round-trip is
 * test/integration/delivery.spec.ts.
 */

const up = (required: boolean): HealthCheck => ({ status: 'up', required });
const down = (required: boolean): HealthCheck => ({ status: 'down', required });

describe('readiness', () => {
  it.each([
    ['every check up', { a: up(true), b: up(false) }, 'up'],
    ['an optional check down', { a: up(true), b: down(false) }, 'up'],
    ['a required check down', { a: down(true), b: up(false) }, 'down'],
  ])('%s: %s', (_case, checks, status) => {
    expect(readiness('abc1234', checks)).toEqual({
      status,
      version: 'abc1234',
      checks,
    });
  });
});

describe('checkDatabase', () => {
  const NEWEST = 1_700_000_000_000;
  const BUILD = [NEWEST - 2, NEWEST - 1, NEWEST];
  const { logger, logs } = captureLogs();

  it.each([
    ['current', NEWEST, 'up', undefined],
    ['ahead (an older build rolled back onto it)', NEWEST + 1, 'down', 'ahead'],
    ['with a migration this build never had', NEWEST - 3, 'down', 'ahead'],
    ['behind', NEWEST - 1, 'down', 'behind'],
    ['with no migration recorded', undefined, 'down', 'behind'],
  ])('a database %s: migrations %s', async (_case, last, status, schema) => {
    const checks = await checkDatabase(
      () => Promise.resolve(last),
      BUILD,
      logger,
    );
    expect(checks.database).toEqual(up(true));
    expect(checks.migrations).toMatchObject({ status, required: true });
    expect(checks.migrations.schema).toBe(schema);
  });

  it('a failed query is down, its text only in the log', async () => {
    logs.clear();
    const failure = new Error('connect ECONNREFUSED 10.0.0.5:5433 closet_user');
    const checks = await checkDatabase(
      () => Promise.reject(failure),
      BUILD,
      logger,
    );
    expect(checks.database.status).toBe('down');
    expect(checks.migrations.status).toBe('down');
    expect(JSON.stringify(checks)).not.toContain('ECONNREFUSED');
    expect(logs.messages('warn')).toEqual([
      'Readiness: the database query failed',
    ]);
  });

  it('a query that outlasts the bound is down', async () => {
    const checks = await checkDatabase(
      () => new Promise<never>(() => {}),
      BUILD,
      logger,
      5,
    );
    expect(checks.database).toMatchObject(down(true));
    expect(checks.migrations).toMatchObject(down(true));
  });
});

describe('checkTrustedProxies', () => {
  it('is optional: down with its fix once an untrusted peer forwarded, never naming it', () => {
    expect(checkTrustedProxies(undefined)).toEqual(up(false));
    expect(checkTrustedProxies('172.23.0.5')).toEqual({
      status: 'down',
      required: false,
      fix: 'see docs/operations.md#trusted-proxies',
    });
  });
});

describe('checkOrderMailOwner', () => {
  it('is optional: down with its fix once the owner account is missing', () => {
    expect(checkOrderMailOwner(false)).toEqual(up(false));
    expect(checkOrderMailOwner(true)).toEqual({
      status: 'down',
      required: false,
      fix: 'see docs/operations.md#health',
    });
  });
});

describe('checkJobs and checkCutoutQueue', () => {
  it('are optional, down when nothing was started or a job is stuck', () => {
    expect(checkJobs([])).toEqual(up(false));
    expect(checkJobs(undefined)).toMatchObject(down(false));
    expect(checkJobs(['Week re-plan'])).toMatchObject({
      ...down(false),
      stuck: ['Week re-plan'],
    });
    expect(checkCutoutQueue({ name: 'running' })).toEqual(up(false));
    expect(checkCutoutQueue({ name: 'stopped' })).toMatchObject(down(false));
    expect(checkCutoutQueue({ name: 'disabled' })).toEqual({
      ...up(false),
      disabled: true,
    });
    // Waiting for the model: the kind and its own fix, never the error.
    expect(
      checkCutoutQueue({
        name: 'waiting-for-model',
        kind: 'checksum',
        since: 0,
        captured: ['download', 'checksum'],
      }),
    ).toEqual({
      status: 'down',
      required: false,
      reason: 'checksum',
      fix: 'the file in MODELS_PATH is not the pinned model: run npm run cutout:fetch-model to replace it; see docs/operations.md#health',
    });
  });
});

describe('storageFix', () => {
  const uid = `${process.getuid?.()}:${process.getgid?.()}`;

  it.each([
    [
      'EACCES',
      `chown -R ${uid} the host directory mounted at /d; docs/operations.md#permissions`,
    ],
    [
      'EPERM',
      `chown -R ${uid} the host directory mounted at /d; docs/operations.md#permissions`,
    ],
    ['ENOSPC', 'the share mounted at /d is full'],
    ['EDQUOT', 'the share mounted at /d is full'],
    ['TIMEOUT', 'the share mounted at /d is not answering (NFS stalled?)'],
    ['EROFS', '/d cannot be written; docs/operations.md#permissions'],
  ])('%s', (code, fix) => {
    expect(storageFix([{ directory: '/d', code }])).toBe(fix);
  });

  it('names each kind once, with the directories it applies to', () => {
    expect(
      storageFix([
        { directory: '/a', code: 'ENOSPC' },
        { directory: '/b', code: 'TIMEOUT' },
        { directory: '/c', code: 'EDQUOT' },
      ]),
    ).toBe(
      'the share mounted at /a and /c is full; the share mounted at /b is not answering (NFS stalled?)',
    );
  });
});

describe('createStorageCheck', () => {
  const { logger, logs } = captureLogs();
  let root: string;
  let writable: string;
  let readOnly: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'closet-storage-'));
    writable = join(root, 'data');
    readOnly = join(root, 'models');
    // A mount that exists but cannot be written, so the probe's own
    // subdirectory cannot be made.
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
  });
  afterAll(async () => {
    await chmod(readOnly, 0o755);
    await rm(root, { recursive: true, force: true });
  });

  const IDENTITY_FIX = 'see docs/operations.md#photo-storage-marker';
  const check = (
    directories: string[],
    identity: () => Promise<string | undefined> = () =>
      Promise.resolve(undefined),
  ) =>
    createStorageCheck({
      directories,
      probe: probeWritable,
      fix: storageFix,
      identity,
      identityFix: IDENTITY_FIX,
      logger,
    })();

  it('is up when every directory can be written, created if missing, and leaves nothing behind', async () => {
    expect(await check([writable])).toEqual(up(true));
    expect(await readdir(join(writable, '.closet-probe'))).toEqual([]);
  });

  // Root writes through mode bits: the read-only case means nothing there.
  it.skipIf(process.getuid?.() === 0)(
    'is down with the chown for exactly the read-only directory, the error code only in the log',
    async () => {
      logs.clear();
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      expect(await check([writable, readOnly])).toEqual({
        status: 'down',
        required: true,
        fix: `chown -R ${uid}:${gid} the host directory mounted at ${readOnly}; docs/operations.md#permissions`,
      });
      expect(logs.messages('warn')).toEqual([
        `Readiness: ${readOnly} is not writable by this process (EACCES)`,
      ]);
    },
  );

  // #650: an unmounted share is a writable, empty mountpoint.
  it('is down with the marker pointer when DATA_PATH is not the claimed storage', async () => {
    logs.clear();
    expect(await check([writable], () => Promise.resolve('no marker'))).toEqual(
      { status: 'down', required: true, fix: IDENTITY_FIX },
    );
    expect(logs.messages('warn')).toEqual(['Readiness: no marker']);
  });

  it('is down, never a rejection, when the marker check itself fails', async () => {
    logs.clear();
    expect(
      await check([writable], () => Promise.reject(new Error('EIO'))),
    ).toEqual({ status: 'down', required: true, fix: IDENTITY_FIX });
    expect(logs.messages('warn')).toEqual([
      'Readiness: the storage marker check failed',
      'Readiness: the storage marker could not be checked',
    ]);
  });

  it('probes once per TTL, concurrent callers sharing the probe', async () => {
    let probes = 0;
    let clock = 0;
    const storage = createStorageCheck({
      directories: ['/app/data', '/app/models'],
      probe: (): Promise<WriteProbe> => {
        probes += 1;
        return Promise.resolve({ writable: true });
      },
      fix: storageFix,
      identity: () => Promise.resolve(undefined),
      identityFix: IDENTITY_FIX,
      logger,
      ttlMs: 5_000,
      now: () => clock,
    });
    await Promise.all([storage(), storage(), storage()]);
    expect(probes).toBe(2);
    clock = 4_999;
    await storage();
    expect(probes).toBe(2);
    clock = 5_000;
    await storage();
    expect(probes).toBe(4);
  });

  describe('a full disk and a stalled share', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const enospc = (): never => {
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    };
    /** A probe file under /app/data/.closet-probe: a random id and a counter. */
    const PROBE_FILE =
      /\/app\/data\/\.closet-probe\/\.write-probe-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/;

    // #857: the pid is 1 in most containers, so two on one share would
    // mint the same names and one's `wx` would meet the other's file.
    it("names its files for the process's random id, never the pid, and a counter", async () => {
      const written: string[] = [];
      const fs: ProbeFs = {
        mkdir: () => Promise.resolve(),
        writeFile: (path) => {
          written.push(path);
          return Promise.resolve();
        },
        rm: () => Promise.resolve(),
        readdir: () => Promise.resolve([]),
      };
      await probeWritable('/app/data', { fs });
      await probeWritable('/app/data', { fs });
      const [first, second] = written.map((path) => PROBE_FILE.exec(path));
      expect(first?.[1]).toBeDefined();
      expect(second?.[1]).toBe(first?.[1]);
      expect(Number(second?.[2])).toBe(Number(first?.[2]) + 1);
    });

    it('gives concurrent probes of one directory their own files and leaves every other file alone', async () => {
      const dir = join(root, 'shared');
      await probeWritable(dir);
      const probes = join(dir, '.closet-probe');
      await writeFile(join(probes, '.write-probe-1-1'), 'a dead process');
      const results = await Promise.all([
        probeWritable(dir),
        probeWritable(dir),
        probeWritable(dir),
      ]);
      expect(results).toEqual(Array(3).fill({ writable: true }));
      expect(await readdir(probes)).toEqual(['.write-probe-1-1']);
      expect(await readdir(dir)).toEqual(['.closet-probe']);
    });

    // #855, #856: no listing (O(1) on a large share), and only its own file
    // decides the verdict.
    it('makes exactly a mkdir, its own write and its unlink', async () => {
      const calls: string[] = [];
      const fs: ProbeFs = {
        mkdir: (directory) => {
          calls.push(`mkdir ${directory}`);
          return Promise.resolve();
        },
        writeFile: (path) => {
          calls.push(`write ${path}`);
          return Promise.resolve();
        },
        rm: (path) => {
          calls.push(`rm ${path}`);
          return Promise.resolve();
        },
        readdir: () => Promise.resolve([]),
      };
      await probeWritable('/app/data', { fs }); // the one-time sweep
      calls.length = 0;
      expect(await probeWritable('/app/data', { fs })).toEqual({
        writable: true,
      });
      expect(calls).toHaveLength(3);
      const [, write, unlink] = calls;
      expect(calls[0]).toBe('mkdir /app/data/.closet-probe');
      expect(write).toMatch(PROBE_FILE);
      expect(unlink).toBe(write?.replace(/^write/, 'rm'));
    });

    it('writes PROBE_BYTES and reports ENOSPC from the write, code only, cleaning up', async () => {
      const writes: number[] = [];
      const removed: string[] = [];
      const fs: ProbeFs = {
        mkdir: () => Promise.resolve(),
        writeFile: (_path, data) => {
          writes.push(data.byteLength);
          return Promise.resolve().then(enospc);
        },
        rm: (path) => {
          removed.push(path);
          return Promise.resolve();
        },
        readdir: () => Promise.resolve([]),
      };
      expect(await probeWritable('/app/data', { fs })).toEqual({
        writable: false,
        code: 'ENOSPC',
      });
      expect(writes).toEqual([PROBE_BYTES]);
      expect(removed.at(-1)).toMatch(PROBE_FILE);

      logs.clear();
      const storage = createStorageCheck({
        directories: ['/app/data'],
        probe: (directory) => probeWritable(directory, { fs }),
        fix: storageFix,
        identity: () => Promise.resolve(undefined),
        identityFix: IDENTITY_FIX,
        logger,
      });
      expect(await storage()).toMatchObject({ status: 'down', required: true });
      expect(logs.messages('warn')).toEqual([
        'Readiness: /app/data is not writable by this process (ENOSPC)',
      ]);
    });

    it('reports TIMEOUT at 3 s, starts nothing while the probe hangs across many windows, and probes again once it settles', async () => {
      vi.useFakeTimers();
      logs.clear();
      let probes = 0;
      let release: (() => void) | undefined;
      const storage = createStorageCheck({
        directories: ['/app/data'],
        probe: (): Promise<WriteProbe> => {
          probes += 1;
          return probes === 1
            ? new Promise<WriteProbe>((resolve) => {
                release = () => resolve({ writable: true });
              })
            : Promise.resolve({ writable: true });
        },
        fix: storageFix,
        identity: () => Promise.resolve(undefined),
        identityFix: IDENTITY_FIX,
        logger,
      });
      let verdict: HealthCheck | undefined;
      void storage().then((v) => (verdict = v));
      await vi.advanceTimersByTimeAsync(2_999);
      expect(verdict).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(verdict).toMatchObject({
        status: 'down',
        required: true,
        fix: 'the share mounted at /app/data is not answering (NFS stalled?)',
      });

      // Many windows later: each joins the one hung probe and answers at
      // its own 3 s bound, never early; one probe, one log line.
      for (let window = 0; window < 10; window++) {
        await vi.advanceTimersByTimeAsync(2_000);
        let again: HealthCheck | undefined;
        void storage().then((v) => (again = v));
        await vi.advanceTimersByTimeAsync(2_999);
        expect(again).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(again).toMatchObject({ status: 'down' });
      }
      expect(probes).toBe(1);
      expect(logs.messages('warn')).toEqual([
        'Readiness: /app/data is not writable by this process (TIMEOUT)',
      ]);

      release?.();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await storage()).toEqual(up(true));
      expect(probes).toBe(2);
    });

    it('joins one in-flight run for concurrent readiness checks, answering when it settles', async () => {
      vi.useFakeTimers();
      let probes = 0;
      let release: (() => void) | undefined;
      const storage = () =>
        createStorageCheck({
          directories: ['/app/data'],
          probe: (): Promise<WriteProbe> => {
            probes += 1;
            return new Promise<WriteProbe>((resolve) => {
              release = () => resolve({ writable: true });
            });
          },
          fix: storageFix,
          identity: () => Promise.resolve(undefined),
          identityFix: IDENTITY_FIX,
          logger,
          ttlMs: 0,
        });
      // Same probe, no shared check: only the directory's flight joins them.
      const shared = storage();
      const verdicts: HealthCheck[] = [];
      void shared().then((v) => verdicts.push(v));
      await vi.advanceTimersByTimeAsync(1_000);
      void shared().then((v) => verdicts.push(v));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probes).toBe(1);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(verdicts).toEqual([up(true), up(true)]);
    });
  });
});

describe('the probe leftover sweep', () => {
  const { logger, logs } = captureLogs();
  afterEach(() => {
    vi.useRealTimers();
    logs.clear();
  });

  interface Calls {
    lists: string[];
    removed: string[];
  }
  const fakeFs = (
    names: string[],
    list?: () => Promise<string[]>,
  ): { fs: ProbeFs; calls: Calls } => {
    const calls: Calls = { lists: [], removed: [] };
    const fs: ProbeFs = {
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      rm: (path) => {
        calls.removed.push(path);
        return Promise.resolve();
      },
      readdir: (directory) => {
        calls.lists.push(directory);
        return list ? list() : Promise.resolve(names);
      },
    };
    return { fs, calls };
  };

  it("runs on the first probe of a directory, removing every process's probe files and nothing else, and not on a later one", async () => {
    const { fs, calls } = fakeFs([
      '.write-probe-1-3',
      '.write-probe-7b0c2f4e-0d3a-4c5e-9f1a-2b3c4d5e6f70-1',
      '.closet-storage',
      'a1b2.webp',
    ]);
    expect(await probeWritable('/sweep/first', { fs, log: logger })).toEqual({
      writable: true,
    });
    // Only the small probe directory, never the share (#901).
    expect(calls.lists).toEqual(['/sweep/first/.closet-probe']);
    expect(calls.removed.filter((path) => path.includes('1-3'))).toEqual([
      '/sweep/first/.closet-probe/.write-probe-1-3',
    ]);
    expect(
      calls.removed.filter((path) => path.includes('7b0c2f4e')),
    ).toHaveLength(1);
    expect(logs.records).toMatchObject([
      { level: 'info', directory: '/sweep/first', removed: 2 },
    ]);

    await probeWritable('/sweep/first', { fs });
    await probeWritable('/sweep/first', { fs });
    expect(calls.lists).toHaveLength(1);
  });

  it('times out at the deadline, never early, while the list is held, and the next run does not retry the sweep', async () => {
    vi.useFakeTimers();
    let fail: (error: Error) => void = () => undefined;
    const { fs, calls } = fakeFs(
      [],
      () => new Promise<string[]>((_, reject) => (fail = reject)),
    );
    const check = createStorageCheck({
      directories: ['/sweep/held'],
      probe: (directory) => probeWritable(directory, { fs }),
      fix: storageFix,
      identity: () => Promise.resolve(undefined),
      identityFix: 'see marker',
      logger,
      ttlMs: 0,
    });
    let verdict: HealthCheck | undefined;
    void check().then((v) => (verdict = v));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(verdict).toMatchObject({ status: 'down', required: true });

    fail(Object.assign(new Error('x'), { code: 'EIO' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await check()).toEqual(up(true));
    expect(calls.lists).toHaveLength(1);
  });

  it('attempts a failing list once, logs it once without the path, and never retries', async () => {
    const { fs, calls } = fakeFs([], () =>
      Promise.reject(Object.assign(new Error('x'), { code: 'EIO' })),
    );
    for (let run = 0; run < 3; run++) {
      expect(await probeWritable('/sweep/retry', { fs, log: logger })).toEqual({
        writable: true,
      });
    }
    expect(calls.lists).toHaveLength(1);
    expect(logs.records).toHaveLength(1);
    expect(logs.records[0]).toMatchObject({ level: 'warn', code: 'EIO' });
    expect(JSON.stringify(logs.records)).not.toContain('/sweep/retry');
  });

  it('never lists when the caller is the boot (sweep: false)', async () => {
    const { fs, calls } = fakeFs(['.write-probe-1-3']);
    expect(
      await probeWritable('/sweep/boot', { fs, log: logger, sweep: false }),
    ).toEqual({ writable: true });
    expect(calls.lists).toEqual([]);
    // A later readiness probe still performs the one sweep.
    await probeWritable('/sweep/boot', { fs });
    expect(calls.lists).toHaveLength(1);
  });
});
