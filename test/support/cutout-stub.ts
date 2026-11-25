import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { Pool, type PoolConfig } from 'pg';
import type { CutoutRunner } from '../../src/cutout/runner';
import type { Logger } from '../../src/logger';

/**
 * The test server's stand-in for the background-removal model
 * (test-server.ts), and the control a spec holds a cutout pending through.
 *
 * The queue runs one photo at a time for the whole server, and every
 * Playwright worker shares it, so the stub answers at once: a spec's cutout
 * waits only for the photos queued before it, a few ms each, never for
 * other specs' timers (#230: 3 s a photo pushed a spec's cutout past its
 * wait whenever other specs had uploaded).
 *
 * A spec that shows the pending state holds its owner's cutouts instead
 * (`cutouts.hold(email)`, cutout-hold.ts): the stub keeps any job for a
 * photo that owner uploaded inside mask() until the spec releases it, so
 * "Cutting out the background…" is on the page for as long as the spec looks. The
 * queue waits meanwhile, so a spec releases as soon as it has seen the
 * pending page; the fixture releases what a failed spec left held, and
 * HOLD_LIMIT_MS bounds a hold whose worker died.
 */

/**
 * Where the control listens: a fixed offset from PORT, because the
 * Playwright process must reach it without a handshake with the server (so
 * port 0 won't do). Following PORT keeps worktrees running side by side
 * apart, and +20000 stays clear of the local gate's 3200-3799 range.
 */
const CUTOUT_STUB_PORT = Number(process.env.PORT ?? '3000') + 20000;
export const CUTOUT_STUB_ORIGIN = `http://127.0.0.1:${CUTOUT_STUB_PORT}`;

// Longer than any spec holds (it releases once the pending page shows),
// short enough that a hold nobody releases cannot stall the queue for the
// rest of a run.
const HOLD_LIMIT_MS = 20_000;
const SIZE = 64;

// An ellipse of garment on background.
function ellipseMask(): Buffer {
  const mask = Buffer.alloc(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - SIZE / 2) / (SIZE * 0.35);
      const dy = (y - SIZE / 2) / (SIZE * 0.45);
      if (dx * dx + dy * dy <= 1) mask[y * SIZE + x] = 255;
    }
  }
  return mask;
}

interface Hold {
  released: Promise<void>;
  release(): void;
}

function newHold(): Hold {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { released, release };
}

export interface CutoutStub {
  runner: CutoutRunner;
  /** Stops the control and its database pool. */
  close(): Promise<void>;
}

/**
 * `database`: the server's own (connectionOptions), for reading whose photo
 * the running job is. Rejects when CUTOUT_STUB_PORT is taken.
 */
export async function startCutoutStub(
  database: PoolConfig,
  logger: Logger,
): Promise<CutoutStub> {
  const log = logger.child({ logger: 'CutoutStub' });
  const mask = ellipseMask();
  const holds = new Map<string, Hold>();
  // Asked only while a hold exists, one query at a time (the queue's).
  const pool = new Pool({ ...database, max: 1 });
  pool.on('error', (error) => {
    log.warn({ err: error }, 'Cutout stub lost its database connection');
  });

  // The queue in this process leases the row it runs, one at a time, as
  // `<host>:<pid>:<suffix>` (CutoutQueue.start, src/cutout/queue.ts), so the
  // leased pending row under this process's prefix is the job in mask().
  const workerPrefix = `${hostname()}:${process.pid}:`;
  async function runningJob(): Promise<
    { owner: string; fileName: string } | undefined
  > {
    const { rows } = await pool.query<{ owner: string; fileName: string }>(
      `select lower(u.email) as owner, f.file_name as "fileName"
         from file f join "user" u on u.id = f.created_by_id
        where f.cutout_status = 'pending'
          and starts_with(f.cutout_worker, $1)
        order by f.cutout_started_at desc
        limit 1`,
      [workerPrefix],
    );
    return rows[0];
  }

  const runner: CutoutRunner = {
    inputSize: SIZE,
    ready: () => Promise.resolve(),
    async mask() {
      if (holds.size > 0) {
        const job = await runningJob();
        const hold = job && holds.get(job.owner);
        if (job && hold) {
          const label = `${job.fileName.slice(0, 8)} of ${job.owner}`;
          log.info(`Holding the cutout of ${label} until released`);
          let timer: NodeJS.Timeout | undefined;
          const limit = new Promise<'limit'>((resolve) => {
            timer = setTimeout(() => resolve('limit'), HOLD_LIMIT_MS);
          });
          const ending = await Promise.race([hold.released, limit]);
          clearTimeout(timer);
          if (ending === 'limit') {
            holds.delete(job.owner);
            log.warn(
              `Hold on ${job.owner} not released within ${HOLD_LIMIT_MS / 1000} s; cutting out ${label} and dropping the hold`,
            );
          } else {
            log.info(`Released the cutout of ${label}`);
          }
        }
      }
      return { mask, inferenceMs: 0 };
    },
    // The queue stops before the app's pool ends: nothing held outlives it.
    close() {
      for (const hold of holds.values()) hold.release();
      holds.clear();
      return Promise.resolve();
    },
  };

  // PUT /holds/<email> holds that owner's cutouts; DELETE releases them.
  // Both are idempotent and answer 204.
  const server = createServer((request, response) => {
    const match = /^\/holds\/([^/]+)$/.exec(request.url ?? '');
    if (!match || (request.method !== 'PUT' && request.method !== 'DELETE')) {
      response.writeHead(404).end();
      return;
    }
    const owner = decodeURIComponent(match[1]).toLowerCase();
    if (request.method === 'PUT') {
      if (!holds.has(owner)) {
        holds.set(owner, newHold());
        log.info(`Holding cutouts of ${owner}`);
      }
    } else {
      const hold = holds.get(owner);
      if (hold) {
        holds.delete(owner);
        hold.release();
        log.info(`Releasing cutouts of ${owner}`);
      }
    }
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(CUTOUT_STUB_PORT, '127.0.0.1', resolve);
  });

  return {
    runner,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}
