import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
    // Created by the probe, as its writers would.
    await probeWritable(readOnly);
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
    expect(await readdir(writable)).toEqual([]);
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

    it('gives concurrent probes of one directory their own files and cleans only stale ones', async () => {
      const dir = join(root, 'shared');
      const stale = `.write-probe-${process.pid}-0`;
      await probeWritable(dir);
      await writeFile(join(dir, stale), 'left by a hung write');
      await writeFile(join(dir, '.write-probe-0-1'), 'another process');
      const results = await Promise.all([
        probeWritable(dir),
        probeWritable(dir),
        probeWritable(dir),
      ]);
      expect(results).toEqual(Array(3).fill({ writable: true }));
      expect(await readdir(dir)).toEqual(['.write-probe-0-1']);
    });

    it('writes PROBE_BYTES and reports ENOSPC from the write, code only, cleaning up', async () => {
      const writes: number[] = [];
      const removed: string[] = [];
      const fs: ProbeFs = {
        mkdir: () => Promise.resolve(),
        readdir: () => Promise.resolve([]),
        writeFile: (_path, data) => {
          writes.push(data.byteLength);
          return Promise.resolve().then(enospc);
        },
        rm: (path) => {
          removed.push(path);
          return Promise.resolve();
        },
      };
      expect(await probeWritable('/app/data', fs)).toEqual({
        writable: false,
        code: 'ENOSPC',
      });
      expect(writes).toEqual([PROBE_BYTES]);
      expect(removed.at(-1)).toMatch(
        new RegExp(`^/app/data/\\.write-probe-${process.pid}-\\d+$`),
      );

      logs.clear();
      const storage = createStorageCheck({
        directories: ['/app/data'],
        probe: (directory) => probeWritable(directory, fs),
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

      // Many windows later: still down at once, still the one probe, one log line.
      for (let window = 0; window < 10; window++) {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await storage()).toMatchObject({ status: 'down' });
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
  });
});
