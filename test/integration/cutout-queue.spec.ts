import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { settlesWithin } from '../../src/cutout/deadline';
import { ModelChecksumError, ModelDownloadError } from '../../src/cutout/model';
import { CUTOUT_LEASE_MS } from '../../src/cutout/queries';
import { retryFailedCutouts } from '../../src/cutout/queue';
import { MODEL_UNAVAILABLE_FIX } from '../../src/cutout/queue-state';
import { file } from '../../src/db/schema';
import type { Readiness } from '../../src/web/health/checks';
import {
  alphaAt,
  eventually,
  fakeRunner,
  halfMask,
  storedCutout,
} from './cutouts';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import { createTestApp, multipart, type TestApp, asFixture } from './harness';
import { silentLogger } from './logger';

/**
 * The background-removal queue (src/cutout/queue.ts) against the real
 * database, Photos and state machine, with the model replaced by a fake
 * runner: every job ends in exactly one allowed state, and no result lands
 * on a photo that was edited, replaced or changed while the job ran. A job
 * leases its row while it runs (#45) and every ending clears the lease.
 */

/** The lease columns of a row no job holds. */
const NO_LEASE = { cutoutWorker: null, cutoutStartedAt: null };
describe('cutout queue', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    // The database failing a job's own write (a dropped connection, a
    // failover): every UPDATE of a photo listed here raises.
    await t.db.execute(
      sql`create table spec_refused_update (file_name text primary key)`,
    );
    await t.db.execute(sql`
      create function spec_refuse_update() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from spec_refused_update where file_name = old.file_name) then
          raise exception 'spec: update refused for %', old.file_name;
        end if;
        return new;
      end $$`);
    await t.db.execute(sql`
      create trigger spec_refuse_update before update on file
      for each row execute function spec_refuse_update()`);
  });

  afterEach(async () => {
    await t.cutouts.stop();
    await allowUpdates();
  });

  /** From now on, every write to the photo's row fails. */
  async function refuseUpdates(fileName: string) {
    await t.db.execute(
      sql`insert into spec_refused_update (file_name) values (${fileName})`,
    );
  }

  /** The database is back: every photo's row takes writes again. */
  async function allowUpdates() {
    await t.db.execute(sql`delete from spec_refused_update`);
  }

  /**
   * A runner whose one job hangs until stop() closes it, as the model child
   * killed by a shutdown does: `during` runs first, inside the job, while
   * this server holds the lease. `running` resolves once the job hangs.
   */
  function interruptibleRunner(
    during: () => Promise<void> = () => Promise.resolve(),
  ) {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let kill!: (error: Error) => void;
    const runner = fakeRunner(async () => {
      await during();
      return new Promise<Buffer>((_resolve, reject) => {
        kill = reject;
        started();
      });
    });
    runner.close = () => {
      kill(new Error('Model process exited (SIGTERM)'));
      return Promise.resolve();
    };
    return { runner, running };
  }

  /** Ages the row's lease past CUTOUT_LEASE_MS: its holder is presumed dead. */
  async function lapseLease(fileName: string) {
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({
          cutoutStartedAt: sql`now() - make_interval(secs => ${CUTOUT_LEASE_MS / 1000 + 1})`,
        })
        .where(eq(file.fileName, fileName)),
    );
  }

  afterAll(() => t?.cleanup());

  /** A garment with a 1200x800 photo (stored at 1080x720), queued by its upload. */
  async function queuedPhoto(name: string) {
    const garmentId = await createGarment(t, { name });
    await uploadPhoto(t, garmentId, await jpegPhoto(1200, 800));
    return { garmentId, fileName: await photoFileName(t, garmentId) };
  }

  it('makes the cutout from the mask: ready, new version, square with the background clear', async () => {
    const { garmentId, fileName } = await queuedPhoto('Queued shirt');
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 2,
      cutoutAttempts: 1,
      cutoutJobVersion: null,
      ...NO_LEASE,
    });
    const cutout = await storedCutout(t, fileName);
    expect(cutout).toBeDefined();
    const meta = await sharp(cutout).metadata();
    expect(meta).toMatchObject({
      format: 'webp',
      width: 1080,
      height: 1080,
      hasAlpha: true,
    });
    // The photo is centred (720 of 1080 high): the mask's garment half is
    // opaque, its background half and the padding transparent.
    expect(await alphaAt(cutout!, 800, 540)).toBeGreaterThan(250);
    expect(await alphaAt(cutout!, 200, 540)).toBeLessThan(5);
    expect(await alphaAt(cutout!, 800, 60)).toBe(0);

    // The thumb is rebuilt from the cutout and the pages show the new version.
    const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(grid.body).toContain(`/file/thumb/${fileName}?v=2`);
    const thumb = await t.inject({
      method: 'GET',
      url: `/file/thumb/${fileName}?v=2`,
    });
    expect((await sharp(thumb.rawPayload).metadata()).hasAlpha).toBe(true);

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Cutout ready: garment ${garmentId} photo \\d+ \\(${fileName.slice(0, 8)}\\), version 2; queue wait \\d+ ms, inference 7 ms, total \\d+ ms$`,
        ),
      ),
    );
  });

  it('marks a failed run failed, and a retry runs it again', async () => {
    const { fileName } = await queuedPhoto('Failing shirt');
    const runner = fakeRunner((call) => {
      if (call === 1) throw new Error('model exploded');
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'failed',
      version: 1,
      cutoutAttempts: 1,
      ...NO_LEASE,
    });
    expect(await storedCutout(t, fileName)).toBeUndefined();
    expect(t.logs.messages('error', 'Cutout')).toContainEqual(
      expect.stringMatching(/^Cutout failed: garment \d+ .*, attempt 1, after/),
    );

    await retryFailedCutouts(t.db, silentLogger);
    await t.cutouts.whenIdle();

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 2,
      cutoutAttempts: 2,
    });
  });

  it('discards a result for a photo version that changed meanwhile, then runs the new one', async () => {
    const { fileName } = await queuedPhoto('Changing shirt');
    const runner = fakeRunner(async (call) => {
      if (call === 1) {
        await asFixture(t.db, (tx) =>
          tx
            .update(file)
            .set({ version: sql`${file.version} + 1` })
            .where(eq(file.fileName, fileName)),
        );
      }
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      // The row stays pending for the new version: its lease is given back
      // at once, rather than left to lapse.
      expect.stringMatching(/^Cutout discarded \(stale\): .*; lease released$/),
    );
    expect(runner.calls).toBe(2);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 3,
      cutoutAttempts: 2,
    });
  });

  it('never overwrites a cutout the user edited while the job ran', async () => {
    const { garmentId, fileName } = await queuedPhoto('Edited shirt');
    let edited: Buffer | undefined;
    const runner = fakeRunner(async () => {
      const body = await multipart(
        {},
        {
          nobgPhoto: {
            data: await pngCutout(),
            filename: 'cutout.png',
            contentType: 'image/png',
          },
        },
      );
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${garmentId}/nobg`,
        payload: body.payload,
        headers: body.headers,
      });
      expect(res.json()).toMatchObject({ version: 2 });
      edited = await storedCutout(t, fileName);
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(/^Cutout discarded \(not-allowed\): /),
    );
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'edited',
      version: 2,
      ...NO_LEASE,
    });
    expect(edited).toBeDefined();
    expect((await storedCutout(t, fileName))!.equals(edited!)).toBe(true);
  });

  it('writes nothing for a photo replaced while the job ran', async () => {
    const { garmentId, fileName } = await queuedPhoto('Replaced shirt');
    // Only the first job replaces the photo; the replacement is queued in
    // its own right and runs next.
    const runner = fakeRunner(async (call) => {
      if (call === 1) {
        await uploadPhoto(t, garmentId, await jpegPhoto(900, 900));
      }
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(/^Cutout discarded \(gone\): /),
    );
    expect(await photoRow(t, fileName)).toBeUndefined();
    expect(await storedCutout(t, fileName)).toBeUndefined();
    expect(runner.calls).toBe(2);
    expect(await photoRow(t, await photoFileName(t, garmentId))).toMatchObject({
      cutoutStatus: 'ready',
    });
  });

  it('resumes a job a restart interrupted', async () => {
    const garmentId = await createGarment(t, { name: 'Interrupted shirt' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
    // As a server killed mid-job leaves it: started, still pending.
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({
          cutoutStatus: 'pending',
          cutoutAttempts: 1,
          cutoutJobVersion: 1,
          cutoutRequestedAt: new Date(Date.now() - 60_000),
        })
        .where(eq(file.fileName, fileName)),
    );

    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
    });
  });

  it('leases the row while the job runs, and releases it when the server stops mid-run', async () => {
    const { fileName } = await queuedPhoto('Shutdown shirt');
    const { runner, running } = interruptibleRunner();

    t.cutouts.start(runner);
    await running;
    const leased = await photoRow(t, fileName);
    expect(leased).toMatchObject({
      cutoutStatus: 'pending',
      cutoutJobVersion: 1,
    });
    expect(leased!.cutoutWorker).toMatch(/^.+:\d+:[0-9a-f]{8}$/);
    expect(leased!.cutoutStartedAt).toBeInstanceOf(Date);
    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringContaining(`started as worker ${leased!.cutoutWorker};`),
    );

    await t.cutouts.stop();

    // Released rather than left to lapse: the job has ended here, so the
    // next server runs the photo at once instead of in five minutes.
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 1,
      cutoutJobVersion: null,
      ...NO_LEASE,
    });
    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(
        /interrupted by shutdown: .*; stays pending, lease released$/,
      ),
    );

    const next = fakeRunner();
    t.cutouts.start(next);
    await t.cutouts.whenIdle();
    expect(next.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
      ...NO_LEASE,
    });
  });

  /** A pending row as another server's job leaves it: started, leased `ageMs` ago. */
  async function leasedElsewhere(fileName: string, ageMs: number) {
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({
          cutoutAttempts: 1,
          cutoutJobVersion: 1,
          cutoutWorker: 'other-box:1:0badf00d',
          cutoutStartedAt: sql`now() - make_interval(secs => ${ageMs / 1000})`,
        })
        .where(eq(file.fileName, fileName)),
    );
  }

  it("never runs a photo another server's live job holds", async () => {
    const { fileName } = await queuedPhoto('Leased shirt');
    await leasedElsewhere(fileName, CUTOUT_LEASE_MS - 60_000);
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(0);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 1,
      cutoutWorker: 'other-box:1:0badf00d',
    });
    // The other server "crashes": later tests find nothing left pending.
    await leasedElsewhere(fileName, CUTOUT_LEASE_MS + 1_000);
    await t.cutouts.whenIdle();
    expect(runner.calls).toBe(1);
  });

  it('never claims or leases an unwanted photo (an outfit selfie)', async () => {
    const { fileName } = await queuedPhoto('Selfie-like shirt');
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ cutoutStatus: 'unwanted', cutoutRequestedAt: null })
        .where(eq(file.fileName, fileName)),
    );
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(0);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'unwanted',
      cutoutAttempts: 0,
      ...NO_LEASE,
    });
  });

  it("runs a crashed server's job once its lease has lapsed", async () => {
    const { fileName } = await queuedPhoto('Orphaned shirt');
    await leasedElsewhere(fileName, CUTOUT_LEASE_MS + 1_000);
    const runner = fakeRunner();

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
      ...NO_LEASE,
    });
    expect(t.logs.messages('warn', 'Cutout')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Cutout lease of worker other-box:1:0badf00d lapsed after 5 min; running garment \\d+ photo \\d+ \\(${fileName.slice(0, 8)}\\) again$`,
        ),
      ),
    );
  });

  it('ignores "Try again" on a photo whose job is running, and keeps its result', async () => {
    const { garmentId, fileName } = await queuedPhoto('Impatient shirt');
    const runner = fakeRunner(async () => {
      const retry = await t.inject({
        method: 'POST',
        url: `/wardrobe/${garmentId}/cutout/retry`,
      });
      expect(retry.statusCode).toBe(303);
      return halfMask();
    });

    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    expect(runner.calls).toBe(1);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      version: 2,
      cutoutAttempts: 1,
      ...NO_LEASE,
    });
    expect(t.logs.ops('garment.cutout.requeued')).toContainEqual(
      expect.objectContaining({
        garmentId,
        changed: false,
        reason: 'not-allowed',
      }),
    );
  });

  it('claims nothing while the runner cannot ready its model, and still stops promptly', async () => {
    const { fileName } = await queuedPhoto('Modelless shirt');
    const runner = fakeRunner();
    runner.ready = () =>
      Promise.reject(new ModelDownloadError('Model download failed'));

    t.cutouts.start(runner);
    await eventually('the queue to wait for the model', () =>
      Promise.resolve(t.cutouts.state.name === 'waiting-for-model'),
    );
    // Its five-minute wait ends with the queue.
    expect(await settlesWithin(t.cutouts.stop(), 2_000)).toBe(true);
    expect(t.cutouts.state).toEqual({ name: 'stopped' });

    expect(runner.calls).toBe(0);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 0,
      ...NO_LEASE,
    });
  });

  // #689: a model that cannot load used to read `up` with every photo
  // pending forever and a warning every 5 min as the only sign.
  it('waits for a model it cannot have visibly, once per kind, and drains when it can without a restart', async () => {
    const { fileName } = await queuedPhoto('Patient shirt');
    // The lines are counted per outage: none from an earlier spec's queue.
    t.logs.clear();
    const refusals = [
      new ModelDownloadError(
        'Model download failed: HTTP 403 from models.test',
      ),
      new ModelDownloadError(
        'Model download failed: HTTP 403 from models.test',
      ),
      new ModelChecksumError('/models/m.onnx', 'aa', 'bb'),
    ];
    let readies = 0;
    const runner = fakeRunner();
    runner.ready = () => {
      const refusal = refusals[readies];
      readies += 1;
      return refusal ? Promise.reject(refusal) : Promise.resolve();
    };
    const cutoutQueue = async () => {
      const res = await t.inject({ method: 'GET', url: '/health/ready' });
      // Optional: the app stays up while photos wait.
      expect(res.statusCode).toBe(200);
      return res.json<Readiness>().checks.cutout_queue;
    };

    t.cutouts.start(runner);
    await eventually('the first refusal', () =>
      Promise.resolve(t.cutouts.state.name === 'waiting-for-model'),
    );
    expect(await cutoutQueue()).toEqual({
      status: 'down',
      required: false,
      reason: 'download',
      fix: MODEL_UNAVAILABLE_FIX.download,
    });
    // Each retry (woken here rather than after 5 min) is refused again.
    for (const tries of [2, 3]) {
      t.cutouts.wake();
      await eventually(`try ${tries}`, () =>
        Promise.resolve(readies === tries),
      );
    }
    await eventually('the checksum refusal', () =>
      Promise.resolve(
        t.cutouts.state.name === 'waiting-for-model' &&
          t.cutouts.state.kind === 'checksum',
      ),
    );
    expect(await cutoutQueue()).toMatchObject({ reason: 'checksum' });
    // Readiness reads the queue's state in memory: it never asks the runner
    // (whose ready() is what forks the binding probe's model process).
    const triesBefore = readies;
    for (let call = 0; call < 5; call++) await cutoutQueue();
    expect(readies).toBe(triesBefore);
    expect(runner.calls).toBe(0);
    // One warning with the fix, the one captured, per kind; a retry of a
    // kind already seen says only that it still waits.
    const warnings = t.logs.messages('warn', 'Cutout');
    expect(warnings.filter((line) => line.includes('. Fix: '))).toEqual([
      `Cutout queue waiting for the model (download); pending cutouts wait, trying again in 5 min. Fix: ${MODEL_UNAVAILABLE_FIX.download}`,
      `Cutout queue waiting for the model (checksum); pending cutouts wait, trying again in 5 min. Fix: ${MODEL_UNAVAILABLE_FIX.checksum}`,
    ]);
    expect(warnings).toContain(
      'Cutout queue still waiting for the model (download); trying again in 5 min',
    );

    // The model is back: the next look drains the queue.
    await t.cutouts.whenIdle();
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      ...NO_LEASE,
    });
    expect(await cutoutQueue()).toEqual({ status: 'up', required: false });
    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(
        /^Cutout model available after \d+ s waiting; draining pending cutouts$/,
      ),
    );
  });

  it('the nightly retry requeues failed cutouts under three attempts only', async () => {
    const retried = await queuedPhoto('Retried shirt');
    const exhausted = await queuedPhoto('Exhausted shirt');
    for (const [{ fileName }, attempts] of [
      [retried, 2],
      [exhausted, 3],
    ] as const) {
      await asFixture(t.db, (tx) =>
        tx
          .update(file)
          .set({ cutoutStatus: 'failed', cutoutAttempts: attempts })
          .where(eq(file.fileName, fileName)),
      );
    }

    await expect(retryFailedCutouts(t.db, silentLogger)).resolves.toBe(1);

    expect(await photoRow(t, retried.fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 2,
    });
    expect(await photoRow(t, exhausted.fileName)).toMatchObject({
      cutoutStatus: 'failed',
      cutoutAttempts: 3,
    });

    // The requeued photo runs: nothing is left pending for later cases.
    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();
    expect(await photoRow(t, retried.fileName)).toMatchObject({
      cutoutStatus: 'ready',
    });
  });

  /**
   * Releasing is best effort. A job that ends without a result gives its
   * lease back so the photo runs again at once; when it cannot, the lease
   * still keeps a second run from starting beside a job that may be alive,
   * and its lapse is what runs the photo again. Each case leaves nothing
   * pending, as the cases above expect.
   */
  describe('when a lease cannot be released', () => {
    it('keeps the lease when the database fails the release at shutdown, and runs the photo once it lapses', async () => {
      const { fileName } = await queuedPhoto('Unreleased shirt');
      const { runner, running } = interruptibleRunner(() =>
        refuseUpdates(fileName),
      );

      t.cutouts.start(runner);
      await running;
      const { cutoutWorker: worker } = (await photoRow(t, fileName))!;
      await t.cutouts.stop();

      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'pending',
        cutoutAttempts: 1,
        cutoutJobVersion: 1,
        cutoutWorker: worker,
      });
      expect(t.logs.messages('error', 'Cutout')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Could not release the lease on garment \\d+ photo \\d+ \\(${fileName.slice(0, 8)}\\); its lease lapses in 5 min$`,
          ),
        ),
      );
      expect(t.logs.messages('info', 'Cutout')).toContainEqual(
        expect.stringMatching(
          /interrupted by shutdown: .*; stays pending, its lease lapses in 5 min$/,
        ),
      );

      // The database back, the next start leaves the leased photo alone...
      await allowUpdates();
      const next = fakeRunner();
      t.cutouts.start(next);
      await t.cutouts.whenIdle();
      expect(next.calls).toBe(0);

      // ...until the lease has lapsed.
      await lapseLease(fileName);
      await t.cutouts.whenIdle();
      expect(next.calls).toBe(1);
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'ready',
        cutoutAttempts: 2,
        ...NO_LEASE,
      });
      expect(t.logs.messages('warn', 'Cutout')).toContainEqual(
        expect.stringMatching(
          new RegExp(`^Cutout lease of worker ${worker} lapsed after 5 min;`),
        ),
      );
    });

    it('never releases a lease another server took over meanwhile', async () => {
      const { fileName } = await queuedPhoto('Taken-over shirt');
      // This job's lease lapsed (a stalled server) and another server
      // claimed the photo; then this job ends with the shutdown.
      const { runner, running } = interruptibleRunner(() =>
        leasedElsewhere(fileName, 0),
      );

      t.cutouts.start(runner);
      await running;
      await t.cutouts.stop();

      expect(t.logs.messages('info', 'Cutout')).toContainEqual(
        expect.stringMatching(
          /interrupted by shutdown: .*; stays pending, its lease is another worker's now$/,
        ),
      );
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'pending',
        cutoutWorker: 'other-box:1:0badf00d',
      });

      // The other server "crashes": its lease lapses and the photo runs.
      await lapseLease(fileName);
      t.cutouts.start(fakeRunner());
      await t.cutouts.whenIdle();
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'ready',
        ...NO_LEASE,
      });
    });

    it.each([
      {
        change: 'the user saved a mask',
        answer: 'no lease left to release',
        during: async (garmentId: number) => {
          const body = await multipart(
            {},
            {
              nobgPhoto: {
                data: await pngCutout(),
                filename: 'cutout.png',
                contentType: 'image/png',
              },
            },
          );
          const res = await t.inject({
            method: 'POST',
            url: `/wardrobe/${garmentId}/nobg`,
            payload: body.payload,
            headers: body.headers,
          });
          expect(res.statusCode).toBe(200);
        },
        row: { cutoutStatus: 'edited', ...NO_LEASE },
      },
      {
        change: 'the photo was replaced',
        answer: 'the photo is gone',
        during: async (garmentId: number) => {
          await uploadPhoto(t, garmentId, await jpegPhoto(900, 900));
        },
        row: undefined,
      },
    ])(
      'has no lease to release at shutdown when $change during the job',
      async ({ answer, during, row }) => {
        const { garmentId, fileName } = await queuedPhoto(`Shirt: ${answer}`);
        const { runner, running } = interruptibleRunner(() =>
          during(garmentId),
        );

        t.cutouts.start(runner);
        await running;
        await t.cutouts.stop();

        expect(t.logs.messages('info', 'Cutout')).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `\\(${fileName.slice(0, 8)}\\); stays pending, ${answer}$`,
            ),
          ),
        );
        if (row) {
          expect(await photoRow(t, fileName)).toMatchObject(row);
        } else {
          expect(await photoRow(t, fileName)).toBeUndefined();
        }
        // A replacement is queued in its own right: run it, so the queue
        // is empty for the next case.
        t.cutouts.start(fakeRunner());
        await t.cutouts.whenIdle();
      },
    );

    it('leaves a failed job leased when its failure cannot be recorded, and runs it again once the lease lapses', async () => {
      const { fileName } = await queuedPhoto('Unrecorded shirt');
      const runner = fakeRunner(async (call) => {
        if (call === 1) {
          await refuseUpdates(fileName);
          throw new Error('model exploded');
        }
        return halfMask();
      });

      t.cutouts.start(runner);
      await t.cutouts.whenIdle();

      const errors = t.logs.messages('error', 'Cutout');
      expect(errors).toContainEqual(
        expect.stringMatching(
          /^Cutout failed: garment \d+ .*, attempt 1, after \d+ ms$/,
        ),
      );
      expect(errors).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Could not record failure of garment \\d+ photo \\d+ \\(${fileName.slice(0, 8)}\\)$`,
          ),
        ),
      );
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'pending',
        cutoutAttempts: 1,
        cutoutJobVersion: 1,
        cutoutWorker: expect.any(String) as unknown,
      });

      // Neither failed nor free: nothing runs it until the lease lapses.
      await allowUpdates();
      await t.cutouts.whenIdle();
      expect(runner.calls).toBe(1);
      await lapseLease(fileName);
      await t.cutouts.whenIdle();
      expect(runner.calls).toBe(2);
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'ready',
        cutoutAttempts: 2,
        ...NO_LEASE,
      });
    });

    it('releases a failed job for a photo version that changed meanwhile, and runs the new version', async () => {
      const { fileName } = await queuedPhoto('Changed failing shirt');
      const runner = fakeRunner(async (call) => {
        if (call === 1) {
          await asFixture(t.db, (tx) =>
            tx
              .update(file)
              .set({ version: sql`${file.version} + 1` })
              .where(eq(file.fileName, fileName)),
          );
          throw new Error('model exploded');
        }
        return halfMask();
      });

      t.cutouts.start(runner);
      await t.cutouts.whenIdle();

      // Not a failure of the version the photo is now: not recorded, and
      // the row is free for its new version at once.
      expect(t.logs.messages('error', 'Cutout')).toContainEqual(
        expect.stringMatching(
          /^Cutout failed: .*, attempt 1, after \d+ ms \(not recorded: stale; lease released\)$/,
        ),
      );
      expect(runner.calls).toBe(2);
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'ready',
        version: 3,
        cutoutAttempts: 2,
        ...NO_LEASE,
      });
    });
  });
});
