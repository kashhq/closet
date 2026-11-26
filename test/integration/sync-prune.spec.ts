import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncTombstone, user } from '../../src/db/schema';
import { pruneSyncTombstones } from '../../src/maintenance/sync-prune';
import { deviceToken, expectProblem } from './api';
import { createTestApp, type TestApp, userIdOf } from './harness';
import { interleave } from './interleave';

/**
 * The changes feed's tombstone prune (#196b-3, src/maintenance/sync-prune.ts)
 * against the feed it serves. Every age is Postgres's now() less an
 * interval, the clock the prune reads, so the gate's clock shift (JS's Date
 * only) moves nothing here.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.cleanup();
});

interface Page {
  changes: { resource: string; id: number }[];
  deletions: { resource: string; id: number }[];
  cursor: string;
  more: boolean;
  snapshot?: { wardrobes: number[] };
}

async function account(email: string) {
  await t.register(email);
  return {
    id: await userIdOf(t, email),
    token: (await deviceToken(t, { email })).token,
  };
}

const get = (token: string, url: string) =>
  t.api(token, { method: 'GET', url: `/api/v1${url}` });

async function changes(
  token: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<Page> {
  const params = new URLSearchParams();
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit ?? 100));
  const res = await get(token, `/changes?${params}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Page>();
}

async function newGarment(token: string, clientId?: string): Promise<number> {
  const res = await t.api(token, {
    method: 'POST',
    url: '/api/v1/garments',
    payload: {
      category: 'shirt',
      name: 'Shirt',
      ...(clientId && { clientId }),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

async function deleteGarment(token: string, id: number): Promise<void> {
  const res = await t.api(token, {
    method: 'DELETE',
    url: `/api/v1/garments/${id}`,
  });
  expect(res.statusCode, res.body).toBe(204);
}

/** The garments' tombstones dated `days` before Postgres's now(). */
const age = (garmentIds: number[], days: number) =>
  t.db
    .update(syncTombstone)
    .set({ deletedAt: sql`now() - make_interval(days => ${days})` })
    .where(inArray(syncTombstone.resourceId, garmentIds));

const tombstonesOf = (ownerId: number) =>
  t.db
    .select({ id: syncTombstone.resourceId, revision: syncTombstone.revision })
    .from(syncTombstone)
    .where(eq(syncTombstone.ownerId, ownerId))
    .orderBy(asc(syncTombstone.revision));

const floorOf = async (userId: number) =>
  (
    await t.db
      .select({ floor: user.syncFloor })
      .from(user)
      .where(eq(user.id, userId))
  )[0].floor;

const prune = (batch?: number) =>
  pruneSyncTombstones(
    { db: t.db, logger: t.logger.child({ logger: 'Sync' }) },
    batch,
  );

const keys = (items: { resource: string; id: number }[]) =>
  items.map((item) => `${item.resource}:${item.id}`);

describe('the prune', () => {
  it("deletes only deletions without a client id past 90 days, raising each owner's floor to the newest pruned, a batch at a time; timed as a job", async () => {
    const a = await account('prune-a@example.com');
    const b = await account('prune-b@example.com');
    const [old1, old2, young] = [
      await newGarment(a.token),
      await newGarment(a.token),
      await newGarment(a.token),
    ];
    const replayable = await newGarment(
      a.token,
      'a3c1d2e4-5f60-4718-9a2b-3c4d5e6f7081',
    );
    const other = await newGarment(b.token);
    for (const id of [old1, old2, replayable, young]) {
      await deleteGarment(a.token, id);
    }
    await deleteGarment(b.token, other);
    await age([old1, old2, replayable, other], 91);
    await age([young], 89);
    // a's in deletion order: old1, old2, then the two kept.
    const [revisionA, revisionB] = [
      (await tombstonesOf(a.id))[1].revision,
      (await tombstonesOf(b.id))[0].revision,
    ];

    // Batches of one: a's two, b's one, then an empty one ends the run.
    const run = t.metrics.timeJob('sync_prune', () => prune(1));
    expect(await run()).toEqual({ pruned: 3, owners: 2 });

    expect((await tombstonesOf(a.id)).map((row) => row.id)).toEqual([
      replayable,
      young,
    ]);
    expect(await tombstonesOf(b.id)).toEqual([]);
    expect(await floorOf(a.id)).toBe(revisionA);
    expect(await floorOf(b.id)).toBe(revisionB);
    expect(t.logs.messages('info', 'Sync')).toContainEqual(
      expect.stringMatching(
        /^Pruned 3 sync tombstone\(s\) older than 90 days of 2 owner\(s\) in 4 batch\(es\), \d+ ms$/,
      ),
    );
    const { body } = await t.metrics.exposition();
    expect(body).toMatch(
      /^job_duration_seconds_count\{name="sync_prune",outcome="success"\} 1$/m,
    );

    // Nothing left to prune; the floor never moves back.
    expect(await prune()).toEqual({ pruned: 0, owners: 0 });
    expect(await floorOf(a.id)).toBe(revisionA);
  });

  it("prunes several owners in one batch, each floor raised to that owner's own newest pruned revision", async () => {
    const a = await account('prune-multi-a@example.com');
    const b = await account('prune-multi-b@example.com');
    const mine = [await newGarment(a.token), await newGarment(a.token)];
    const theirs = [await newGarment(b.token), await newGarment(b.token)];
    // Revisions count per owner: b's run ahead of a's, so one max for the
    // batch would over-raise a.
    await newGarment(b.token);
    await newGarment(b.token);
    for (const id of theirs) await deleteGarment(b.token, id);
    for (const id of mine) await deleteGarment(a.token, id);
    const replayable = await newGarment(
      b.token,
      'b4d2e3f5-6071-4829-8b3c-4d5e6f708192',
    );
    await deleteGarment(b.token, replayable);
    await age([...mine, ...theirs, replayable], 91);
    const [revisionA, revisionB] = [
      (await tombstonesOf(a.id)).at(-1)!.revision,
      (await tombstonesOf(b.id)).filter((row) => row.id !== replayable).at(-1)!
        .revision,
    ];
    expect(revisionB).not.toBe(revisionA);

    expect(await prune()).toEqual({ pruned: 4, owners: 2 });

    expect(await tombstonesOf(a.id)).toEqual([]);
    expect((await tombstonesOf(b.id)).map((row) => row.id)).toEqual([
      replayable,
    ]);
    expect(await floorOf(a.id)).toBe(revisionA);
    expect(await floorOf(b.id)).toBe(revisionB);
  });

  it('a cursor older than the new floor is a 410; one exactly at it misses no pruned deletion', async () => {
    const a = await account('prune-floor@example.com');
    const kept = await newGarment(a.token);
    const gone = await newGarment(a.token);
    const before = await changes(a.token);
    await deleteGarment(a.token, gone);
    const at = await changes(a.token, { cursor: before.cursor });
    expect(keys(at.deletions)).toEqual([`garment:${gone}`]);
    const [tombstone] = await tombstonesOf(a.id);

    await age([gone], 91);
    expect(await prune()).toEqual({ pruned: 1, owners: 1 });
    expect(await floorOf(a.id)).toBe(tombstone.revision);

    expectProblem(
      await get(a.token, `/changes?cursor=${before.cursor}`),
      410,
      'cursor_expired',
    );
    expect(await changes(a.token, { cursor: at.cursor })).toMatchObject({
      changes: [],
      deletions: [],
      more: false,
    });
    // A full sync opens with the user's week template (revision 0, #716).
    const fresh = await changes(a.token);
    expect(keys(fresh.changes)).toEqual([
      `weekTemplate:${a.id}`,
      `garment:${kept}`,
    ]);
    expect(fresh.deletions).toEqual([]);
  });

  it('racing a paginating reader never yields a wrong delta: the held page reads the old snapshot whole, the next one the floor', async () => {
    const a = await account('prune-race@example.com');
    const kept = await newGarment(a.token);
    const gone = await newGarment(a.token);
    const before = await changes(a.token);
    await deleteGarment(a.token, gone);
    const later = await newGarment(a.token);
    await age([gone], 91);

    // The reader's page takes its snapshot (the wardrobes' read), then waits
    // on its keyset read, which reads `garment`, locked by the first
    // connection; the prune commits on a third meanwhile.
    const [, held] = await interleave(
      t.db,
      (tx) => tx.execute(sql`lock table garment in access exclusive mode`),
      () => get(a.token, `/changes?cursor=${before.cursor}&limit=1`),
      async () => expect(await prune()).toEqual({ pruned: 1, owners: 1 }),
    );
    expect(held.statusCode, held.body).toBe(200);
    const page = held.json<Page>();
    expect(keys(page.deletions)).toEqual([`garment:${gone}`]);
    expect(page.more).toBe(true);

    // The next page's snapshot has the floor at the pruned deletion's
    // revision: the reader stood among its deletions, so it syncs in full.
    expectProblem(
      await get(a.token, `/changes?cursor=${page.cursor}`),
      410,
      'cursor_expired',
    );
    const fresh = await changes(a.token);
    expect(keys(fresh.changes)).toEqual([
      `weekTemplate:${a.id}`,
      `garment:${kept}`,
      `garment:${later}`,
    ]);
    expect(fresh.deletions).toEqual([]);
    expect(fresh.snapshot).toEqual({ wardrobes: [a.id] });
  });
});
