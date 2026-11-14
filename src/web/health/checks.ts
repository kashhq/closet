import {
  type CutoutQueueState,
  MODEL_UNAVAILABLE_FIX,
  type ModelUnavailableKind,
} from '../../cutout/queue-state';
import { schemaState } from '../../db/migrate';
import type { Logger } from '../../logger';
import type { StorageFailure, WriteProbe } from '../../storage-probe';

/**
 * The /health/ready contract (~/.claude/conventions/observability.md,
 * Health Contract): each check is `up` or `down`; a `required: false` one
 * is reported without making the app down. devkit's contract_probe.sh
 * (`--health`, in scripts/smoke-image.sh) asserts the shape.
 *
 * The body is unauthenticated: a check names what is wrong (a stuck job's
 * name, a pointer to the fix), never an exception's text or the roster of
 * everything that is fine. The detail goes to the log.
 */
export interface HealthCheck {
  status: 'up' | 'down';
  required: boolean;
  fix?: string;
  /** cron_jobs: the jobs whose run has been in flight past STUCK_AFTER_MS. */
  stuck?: string[];
  /** cutout_queue with CUTOUT_ENABLED=false: up (the operator's choice, not a fault) and flagged. */
  disabled?: true;
  /** cutout_queue while it waits for the model: why, a closed word (queue-state.ts). */
  reason?: ModelUnavailableKind;
  /** migrations when down with a database that answered: which way it is off (schemaState). */
  schema?: 'behind' | 'ahead';
}

export interface Readiness {
  status: 'up' | 'down';
  version: string;
  checks: Record<string, HealthCheck>;
}

/** Down exactly when a required check is down. */
export function readiness(
  version: string,
  checks: Record<string, HealthCheck>,
): Readiness {
  const down = Object.values(checks).some(
    (check) => check.required && check.status === 'down',
  );
  return { status: down ? 'down' : 'up', version, checks };
}

/** The contract's bound on the database round-trip. */
const DATABASE_TIMEOUT_MS = 3_000;

const FIX = 'see docs/operations.md#health';

const SCHEMA_AHEAD_FIX = 'see docs/operations.md#migrations-and-rollback';

/**
 * The database and the boot's migrations, from one statement:
 * `lastMigrationAt` (src/db/migrate.ts) answering within `timeoutMs` is the
 * round-trip; its value against `buildMigrations` (this build's journal) is
 * the schema, by the boot's own rule (schemaState): up only when current.
 * Behind (restored or repointed after the boot) or ahead (a newer build
 * migrated it under this one) is down, saying which. A database that does
 * not answer leaves the schema unknown, so both are down. A pool with no free
 * connection counts against the bound too: the statement still runs when
 * one frees, and the rate limit bounds how many can wait.
 */
export async function checkDatabase(
  lastMigrationAt: () => Promise<number | undefined>,
  buildMigrations: readonly number[],
  logger: Logger,
  timeoutMs: number = DATABASE_TIMEOUT_MS,
): Promise<{ database: HealthCheck; migrations: HealthCheck }> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  let last: number | undefined | 'timeout';
  try {
    // race() subscribes to the read, so its rejection after the bound is
    // handled, never an unhandled one.
    last = await Promise.race([lastMigrationAt(), expired]);
  } catch (error) {
    logger.warn({ err: error }, 'Readiness: the database query failed');
    return { database: down(true), migrations: down(true) };
  } finally {
    clearTimeout(timer);
  }
  if (last === 'timeout') {
    logger.warn(`Readiness: the database did not answer in ${timeoutMs} ms`);
    return { database: down(true), migrations: down(true) };
  }
  const database: HealthCheck = { status: 'up', required: true };
  const state = schemaState(last, buildMigrations);
  switch (state.name) {
    case 'current':
      return { database, migrations: { status: 'up', required: true } };
    case 'behind':
      logger.warn(
        `Readiness: the database's newest migration (${last ?? 'none'}) is ${state.pending} behind this build's`,
      );
      return { database, migrations: { ...down(true), schema: 'behind' } };
    case 'ahead':
      logger.warn(
        `Readiness: the database's newest migration (${state.newestAt}) is not in this build: the image is older than the database`,
      );
      return {
        database,
        migrations: {
          status: 'down',
          required: true,
          schema: 'ahead',
          fix: SCHEMA_AHEAD_FIX,
        },
      };
  }
}

/**
 * The timers serve() started (JobRoster.stuck): optional, since every page
 * still serves while a job is stuck, and a restart loop would cost the
 * household the app for a job that may finish. Down when nothing was
 * adopted: this process schedules nothing (the integration harness).
 */
export function checkJobs(stuck: string[] | undefined): HealthCheck {
  if (stuck === undefined) return down(false);
  if (stuck.length > 0) return { ...down(false), stuck };
  return { status: 'up', required: false };
}

/**
 * The background-removal queue (CutoutQueue.state); optional like the
 * timers. Down when it was never started or is stopping, and while it waits
 * for a model it cannot have (#689), naming the kind and its fix: photos
 * stay pending until then. `disabled` (CUTOUT_ENABLED=false) is up
 * and flagged: the operator's choice, not a fault.
 */
export function checkCutoutQueue(state: CutoutQueueState): HealthCheck {
  switch (state.name) {
    case 'running':
      return { status: 'up', required: false };
    case 'stopped':
      return down(false);
    case 'disabled':
      return { status: 'up', required: false, disabled: true };
    case 'waiting-for-model':
      return {
        status: 'down',
        required: false,
        reason: state.kind,
        fix: MODEL_UNAVAILABLE_FIX[state.kind],
      };
  }
}

const TRUSTED_PROXIES_FIX = 'see docs/operations.md#trusted-proxies';

/**
 * `trusted_proxies` (optional, #671): down once a peer outside
 * TRUSTED_PROXIES has sent X-Forwarded-For this boot (UntrustedProxyWatch).
 * Every page still serves, but the sign-in and credential rate limits count
 * that proxy's whole clientele as one address, so one person's typos lock
 * the household out: worth reporting, not worth a restart loop. The peer's
 * address goes to the log, never the body.
 */
export function checkTrustedProxies(
  untrustedPeer: string | undefined,
): HealthCheck {
  return untrustedPeer === undefined
    ? { status: 'up', required: false }
    : { status: 'down', required: false, fix: TRUSTED_PROXIES_FIX };
}

const ORDER_MAIL_OWNER_FIX = 'see docs/operations.md#health';

/**
 * `order_mail_owner` (optional, #706): down once ORDER_MAIL_OWNER named no
 * account, at boot or after the account was deleted. Only the order mail is
 * off (no poll, no review list); a refused boot would cost the household the
 * app for a mail setting. The key goes to the log, never the address.
 */
export function checkOrderMailOwner(missing: boolean): HealthCheck {
  return missing
    ? { status: 'down', required: false, fix: ORDER_MAIL_OWNER_FIX }
    : { status: 'up', required: false };
}

/** How long a storage verdict is reused: a probe writes to disk (and NFS). */
const STORAGE_PROBE_TTL_MS = 5_000;

/** The bound on one directory's probe, as the database's: under the TTL. */
const STORAGE_PROBE_TIMEOUT_MS = 3_000;

export interface StorageCheckDeps {
  /** DATA_PATH and MODELS_PATH, as the process sees them. */
  directories: readonly string[];
  /** probeWritable (src/storage-probe.ts); the specs pass it too, on tmp dirs. */
  probe: (directory: string) => Promise<WriteProbe>;
  /** storageFix (src/storage-probe.ts): the operator's step for each failure code. */
  fix: (failures: readonly StorageFailure[]) => string;
  /**
   * Why DATA_PATH is not the storage this process claimed at boot, or
   * undefined when it is (PhotoStorage.identityProblem, the marker: #650).
   */
  identity: () => Promise<string | undefined>;
  /** Where the operator reads how to remount or re-adopt (STORAGE_MARKER_FIX). */
  identityFix: string;
  logger: Logger;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * `storage` (required): every directory the process writes at runtime is
 * writable by it, and DATA_PATH still carries the marker the boot claimed
 * (an NFS share unmounted under a running server leaves a writable, empty
 * mountpoint: uploads would land where the remount hides them). Required because the image runs non-root and its
 * directories are host mounts (docs/operations.md#permissions): with a
 * root-owned one every page would serve and the first upload or the model
 * download would fail, so readiness would lie. The fix is per failure code (storageFix).
 *
 * One probe per STORAGE_PROBE_TTL_MS whatever the request rate (the
 * HEALTHCHECK, the smoke's poll and anyone within HEALTH_LIMIT share it),
 * and concurrent callers await the same probe. Each directory's probe is
 * bounded by `timeoutMs` (code `TIMEOUT`: a stalled NFS share never answers),
 * which is under the TTL, so the cached verdict always settles. A timed-out
 * probe cannot be cancelled, so at most ONE is in flight per directory: while
 * it is pending, later windows report TIMEOUT at once and start nothing (each
 * abandoned fs call would hold one of libuv's four pool threads, and a few
 * stall every fs call and DNS lookup in the process); a new probe starts only
 * after the pending one settles. A problem is logged when it appears or
 * changes, not per probe.
 */
export function createStorageCheck({
  directories,
  probe,
  fix,
  identity,
  identityFix,
  logger,
  ttlMs = STORAGE_PROBE_TTL_MS,
  timeoutMs = STORAGE_PROBE_TIMEOUT_MS,
  now = Date.now,
}: StorageCheckDeps): () => Promise<HealthCheck> {
  let cached: { at: number; verdict: Promise<HealthCheck> } | undefined;
  let reported = '';
  const pending = new Map<string, Promise<WriteProbe>>();
  const bounded = (directory: string): Promise<WriteProbe> => {
    if (pending.has(directory)) {
      return Promise.resolve({ writable: false, code: 'TIMEOUT' });
    }
    const started = probe(directory);
    const forget = (): void => {
      pending.delete(directory);
    };
    pending.set(directory, started);
    started.then(forget, forget);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<WriteProbe>((resolve) => {
      timer = setTimeout(
        () => resolve({ writable: false, code: 'TIMEOUT' }),
        timeoutMs,
      );
    });
    return Promise.race([started, expired]).finally(() => clearTimeout(timer));
  };
  const run = async (): Promise<HealthCheck> => {
    // One probe per distinct directory (DATA_PATH may equal MODELS_PATH).
    const distinct = [...new Set(directories)];
    const [probed, problem] = await Promise.all([
      Promise.all(distinct.map(bounded)),
      // identityProblem never rejects for the disk's sake; anything else
      // still reads as down, never as a rejected readiness check.
      identity().catch((error: unknown) => {
        logger.warn(
          { err: error },
          'Readiness: the storage marker check failed',
        );
        return 'the storage marker could not be checked';
      }),
    ]);
    const results = directories.map(
      (directory) => probed[distinct.indexOf(directory)],
    );
    const messages: string[] = [];
    const unwritable: StorageFailure[] = [];
    directories.forEach((directory, i) => {
      const result = results[i];
      if (result.writable) return;
      messages.push(
        `Readiness: ${directory} is not writable by this process (${result.code})`,
      );
      unwritable.push({ directory, code: result.code });
    });
    if (problem) messages.push(`Readiness: ${problem}`);
    const state = messages.join('\n');
    if (state !== reported) {
      for (const message of messages) logger.warn(message);
      if (messages.length === 0) logger.info('Readiness: storage is healthy');
      reported = state;
    }
    const fixes = [
      ...(unwritable.length > 0 ? [fix(unwritable)] : []),
      ...(problem ? [identityFix] : []),
    ];
    return fixes.length === 0
      ? { status: 'up', required: true }
      : { status: 'down', required: true, fix: fixes.join('; ') };
  };
  return () => {
    const at = now();
    if (!cached || at - cached.at >= ttlMs) {
      cached = { at, verdict: run() };
    }
    return cached.verdict;
  };
}

function down(required: boolean): HealthCheck {
  return { status: 'down', required, fix: FIX };
}
