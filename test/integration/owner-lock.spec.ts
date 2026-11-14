import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/client';
import {
  file,
  garment,
  inspiration,
  outfit,
  outfitCalendar,
  outfitSlot,
  pendingPhoto,
  user,
  weekPlan,
  weekReplan,
} from '../../src/db/schema';
import type { Occasion } from '../../src/wardrobe/occasions';
import { lockOwner, lockOwnerQuery } from '../../src/web/auth/queries';
import { addDays, type IsoDate } from '../../src/calendar-date';
import {
  deleteEntry,
  insertEntry,
  scheduleOutfit,
} from '../../src/web/calendar/queries';
import { replaceEntryOutfit } from '../../src/web/calendar/replace';
import { pickIdea } from '../../src/web/outfits/pick';
import type { Actor } from '../../src/web/sharing/access';
import { setGarmentStatus } from '../../src/web/wardrobe/status';
import {
  createWeekPlan,
  recordAutoEntry,
} from '../../src/web/week-plan/queries';
import { type ReplanDeps, replanToday } from '../../src/web/week-plan/replan';
import { deleteAccount } from '../../src/web/auth/account';
import {
  lockCutoutRowQuery,
  lockCutoutRowsQuery,
} from '../../src/cutout/queries';
import { LOCKED_OWNERS_SETTING, ownerLockCte } from '../../src/db/owner-lock';
import { REPAIR_KINDS } from '../../src/wardrobe/care';
import {
  changeMembership,
  createCapsule,
  lockMembersSql,
} from '../../src/web/capsules/queries';
import { deleteOutfit } from '../../src/web/outfits/queries';
import { lockTripQuery, setPacked } from '../../src/web/trips/packed';
import {
  addTripItems,
  addTripOutfit,
  createTrip,
  deleteTrip,
} from '../../src/web/trips/queries';
import { addRepair } from '../../src/web/wardrobe/repairs';
import {
  deleteGarment,
  lockGarmentQuery,
  updateGarmentProperties,
} from '../../src/web/wardrobe/queries';
import {
  insertPhotoRow,
  lockOwnersAndPhotoName,
} from '../../src/web/files/queries';
import { readGarmentForm } from '../../src/web/wardrobe/garment-input';
import {
  createGarmentWithPendingPhoto,
  discardPendingPhoto,
  keepPendingPhoto,
} from '../../src/web/wardrobe/writes';
import { saveInspirationWithPendingPhoto } from '../../src/web/inspiration/queries';
import { setWoreToday } from '../../src/web/wears/queries';
import { saveWeekTemplate } from '../../src/web/week-plan/template';
import { createGarment, garmentRow, jpegPhoto } from './garments';
import { createTestApp, type TestApp, asFixture, userIdOf } from './harness';
import {
  backendPid,
  interleave as interleaveOn,
  waitForBlockedOn,
} from './interleave';
import { silentLogger } from './logger';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * The owner lock (#122, src/web/calendar/AGENTS.md): every writer of the
 * calendar and the plan tables runs in ownerTransaction, so a write that
 * judges several rows (a replace, the daily re-plan) never has another of
 * the owner's writes land between its read and its write; and a pick holds
 * its garments until its outfit is saved. Each case holds one writer's
 * transaction open, proves the other waits on it, then lets the first
 * commit: the second must find what the first did, whichever goes first.
 */

type Fields = Record<string, string | string[]>;

function formPayload(fields: Fields) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

/** A node of EXPLAIN (VERBOSE, FORMAT JSON)'s plan. */
interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  'Subplan Name'?: string;
  'CTE Name'?: string;
  'One-Time Filter'?: string;
  Filter?: string;
  Output?: string[];
  Plans?: PlanNode[];
}

/** `node` and every node below it, depth first. */
function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

function outputOf(node: PlanNode): string {
  return (node.Output ?? []).join(' ');
}

/** `node` and what it reads its rows from, not the InitPlans and SubPlans hung on the way. */
function inputsOf(node: PlanNode): PlanNode[] {
  return [
    node,
    ...(node.Plans ?? [])
      .filter(
        (child) =>
          child['Parent Relationship'] !== 'InitPlan' &&
          child['Parent Relationship'] !== 'SubPlan',
      )
      .flatMap(inputsOf),
  ];
}

/** The LockRows node whose input scans `relation`. */
function lockRowsOn(plan: PlanNode, relation: string): PlanNode {
  const lock = nodesOf(plan).find(
    (node) =>
      node['Node Type'] === 'LockRows' &&
      inputsOf(node).some((input) => input['Relation Name'] === relation),
  );
  if (!lock) throw new Error(`no LockRows over ${relation}`);
  return lock;
}

/** The scan of `relation` among `node`'s inputs. */
function scanOf(node: PlanNode, relation: string): PlanNode {
  return inputsOf(node).find((input) => input['Relation Name'] === relation)!;
}

describe('the owner lock', () => {
  let t: TestApp;

  /** EXPLAIN (VERBOSE, FORMAT JSON) of `query`: its plan's top node. */
  const planOf = async (query: SQL): Promise<PlanNode> => {
    const { rows } = await t.db.execute<{
      'QUERY PLAN': [{ Plan: PlanNode }];
    }>(sql`explain (verbose, format json) ${query}`);
    return rows[0]['QUERY PLAN'][0].Plan;
  };

  /**
   * A folded owner lock (src/db/owner-lock.ts) comes before `relation`'s
   * row lock: the `owner_lock` CTE locks the user rows, and is read only
   * by an aggregate over all of it (ownerLocked's count, lockCutoutRows'
   * `max`), run as an InitPlan or SubPlan that a node below `relation`'s
   * LockRows evaluates (its one-time filter, before the scan returns a
   * row, or its own output, before the row is locked). A CTE read any
   * other way (a join input, `exists`, a `limit`) is read lazily and could
   * lock only some owners before the first row lock (#556).
   */
  const expectOwnerLockFirst = async (query: SQL, relation: string) => {
    const plan = await planOf(query);
    const nodes = nodesOf(plan);
    const cte = nodes.find((node) => node['Subplan Name'] === 'CTE owner_lock');
    expect(cte, 'the owner_lock CTE').toBeDefined();
    lockRowsOn(cte!, 'user');
    const readers = nodes.filter((node) =>
      (node.Plans ?? []).some(
        (child) =>
          child['Node Type'] === 'CTE Scan' &&
          child['CTE Name'] === 'owner_lock',
      ),
    );
    expect(readers.length, JSON.stringify(plan)).toBeGreaterThan(0);
    for (const reader of readers) {
      expect(reader['Node Type'], JSON.stringify(plan)).toBe('Aggregate');
    }
    const gates = nodes
      .filter(
        (node) =>
          node['Subplan Name'] !== undefined &&
          nodesOf(node).some((inner) => readers.includes(inner)),
      )
      .map((node) => new RegExp(`\\b${node['Subplan Name']}\\b`));
    const below = nodesOf(lockRowsOn(plan, relation)).filter(
      (node) => !nodesOf(cte!).includes(node),
    );
    expect(
      below.some((node) =>
        gates.some(
          (gate) =>
            gate.test(node['One-Time Filter'] ?? '') ||
            gate.test(outputOf(node)),
        ),
      ),
      JSON.stringify(plan),
    ).toBe(true);
  };

  /** The owner as replaceEntryOutfit's actor (#188). */
  let owner: Actor;
  let tops: number[];
  let bottoms: number[];
  let shoes: number[];

  const garmentIn = async (name: string, category: string, color: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...formPayload({
        name,
        category,
        props: '1',
        formality: '2',
        pattern: 'solid',
        color: [color],
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  /** Holds `first` open while `second` waits on it (interleave.ts). */
  const interleave = <A, B>(
    first: (tx: Queryable) => Promise<A>,
    second: () => Promise<B>,
    meanwhile?: () => Promise<unknown>,
  ) => interleaveOn(t.db, first, second, meanwhile);

  /** A saved outfit of the owner's, of these garments. */
  const outfitOf = async (garmentIds: number[]) => {
    const saved = await pickIdea(t.db, t.owner.id, {
      garmentIds,
      origin: 'person',
      madeBy: BY_PERSON,
    });
    if (saved === 'not-found') throw new Error('garments not found');
    return saved.id;
  };

  /** The owner's entries on `day`, by id. */
  const entriesOn = (day: IsoDate) =>
    t.db
      .select({
        id: outfitCalendar.id,
        outfitId: outfitCalendar.outfitId,
        occasion: outfitCalendar.occasion,
        plannedBy: outfitCalendar.plannedBy,
      })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.ownerId, t.owner.id),
          eq(outfitCalendar.day, day),
        ),
      )
      .orderBy(asc(outfitCalendar.id));

  /** An entry "Plan my week" made: planned 'auto', recorded in a batch. */
  const autoEntry = (garmentIds: number[], day: IsoDate, occasion: Occasion) =>
    asFixture(t.db, async (tx) => {
      const weekPlanId = await createWeekPlan(tx, t.owner.id);
      const picked = await pickIdea(tx, t.owner.id, {
        garmentIds,
        plan: { day, occasion },
        origin: 'planner',
        madeBy: BY_PERSON,
      });
      if (picked === 'not-found') throw new Error('garments not found');
      const [entry] = await tx
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.outfitId, picked.id),
            eq(outfitCalendar.day, day),
          ),
        );
      await recordAutoEntry(tx, {
        entryId: entry.id,
        weekPlanId,
        outfitCreated: !picked.alreadySaved,
        needs: null,
      });
      return { entryId: entry.id, outfitId: picked.id };
    });

  beforeAll(async () => {
    t = await createTestApp();
    owner = { userId: t.owner.id, surface: 'page' };
    tops = [
      await garmentIn('White tee', 'tops', 'white'),
      await garmentIn('Grey tee', 'tops', 'grey'),
      await garmentIn('Black tee', 'tops', 'black'),
    ];
    bottoms = [
      await garmentIn('Blue jeans', 'bottoms', 'blue'),
      await garmentIn('Black chinos', 'bottoms', 'black'),
      await garmentIn('Beige chinos', 'bottoms', 'beige'),
    ];
    shoes = [
      await garmentIn('White sneakers', 'footwear', 'white'),
      await garmentIn('Brown boots', 'footwear', 'brown'),
    ];
  });

  afterAll(() => t?.cleanup());

  // Every test starts without outfits, entries or batches, the closet whole
  // (a plain delete is fine: nothing here is worn history).
  beforeEach(async () => {
    await asFixture(t.db, (tx) => tx.delete(outfit));
    await asFixture(t.db, (tx) => tx.delete(weekPlan));
    await t.db.delete(weekReplan);
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ status: 'closet' })
        .where(eq(garment.ownerId, t.owner.id)),
    );
  });

  describe('scheduling against a replace (the unique key)', () => {
    it('a replace that waited on a schedule of its outfit is refused with a 409, not a 500', async () => {
      const day = addDays(t.today(), 2);
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const chosen = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const { id: entryId } = await scheduled(planned, day, 'work');

      const [schedule, replace] = await interleave(
        (tx) =>
          scheduleOutfit(tx, {
            ownerId: t.owner.id,
            outfitId: chosen,
            day,
            occasion: 'evening',
            chooser: BY_PERSON,
          }),
        () =>
          replaceEntryOutfit(
            { db: t.db, logger: t.logger },
            owner,
            { entryId, day, occasion: 'work' },
            { outfitId: chosen },
            BY_PERSON,
          ).catch((refusal: unknown) => refusal),
      );
      expect(schedule).toMatchObject({ outcome: 'scheduled' });
      // Refused under the lock, naming the occasion it kept.
      expect(replace).toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('Evening'),
        logDetail: expect.stringContaining(
          `outfit ${chosen} is already on the day (evening)`,
        ),
      });
      expect(
        (await entriesOn(day)).map((e) => [e.outfitId, e.occasion]),
      ).toEqual([
        [planned, 'work'],
        [chosen, 'evening'],
      ]);
    });

    it('a schedule that waited on a replace to its outfit finds it on the day', async () => {
      const day = addDays(t.today(), 3);
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const chosen = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const { id: entryId } = await scheduled(planned, day, 'work');

      const [replace, schedule] = await interleave(
        (tx) =>
          replaceEntryOutfit(
            { db: tx, logger: t.logger },
            owner,
            { entryId, day, occasion: 'work' },
            { outfitId: chosen },
            BY_PERSON,
          ),
        () =>
          scheduleOutfit(t.db, {
            ownerId: t.owner.id,
            outfitId: chosen,
            day,
            occasion: 'evening',
            chooser: BY_PERSON,
          }),
      );
      expect(replace).toMatchObject({ outcome: 'replaced', outfitId: chosen });
      // The occasion the outfit kept and its entry (the one replaced), read
      // under the lock after the replace.
      expect(schedule).toEqual({
        outcome: 'already-scheduled',
        adopted: false,
        entryId,
        occasion: 'work',
      });
      expect(await entriesOn(day)).toEqual([
        { id: entryId, outfitId: chosen, occasion: 'work', plannedBy: 'user' },
      ]);
    });

    /** `outfitId` planned by the person; the new entry's id. */
    async function scheduled(
      outfitId: number,
      day: IsoDate,
      occasion: Occasion,
    ) {
      const result = await scheduleOutfit(t.db, {
        ownerId: t.owner.id,
        outfitId,
        day,
        occasion,
        chooser: BY_PERSON,
      });
      if (result === 'no-such-outfit' || result.outcome !== 'scheduled') {
        throw new Error(`outfit ${outfitId} not scheduled`);
      }
      return result;
    }
  });

  describe('a replace with the outfit the entry already has', () => {
    it("takes the week planner's entry over, and says so", async () => {
      const day = addDays(t.today(), 1);
      const { entryId, outfitId } = await autoEntry(
        [tops[0], bottoms[0], shoes[0]],
        day,
        'all-day',
      );
      const target = { entryId, day, occasion: 'all-day' as const };
      const outcome = await replaceEntryOutfit(
        { db: t.db, logger: t.logger },
        owner,
        target,
        {
          outfitId,
        },
        BY_PERSON,
      );
      expect(outcome).toMatchObject({
        outcome: 'unchanged',
        outfitId,
        adopted: true,
      });
      expect(await entriesOn(day)).toEqual([
        { id: entryId, outfitId, occasion: 'all-day', plannedBy: 'user' },
      ]);
      expect(t.logs.ops('calendar.entry.changed').at(-1)).toMatchObject({
        userId: t.owner.id,
        entryId,
        outfitId,
        changed: false,
        adopted: true,
      });

      // The person's own entry: nothing to take over.
      const again = await replaceEntryOutfit(
        { db: t.db, logger: t.logger },
        owner,
        target,
        {
          outfitId,
        },
        BY_PERSON,
      );
      expect(again).toMatchObject({ outcome: 'unchanged', adopted: false });
    });

    it('through the pick of its garments too (Today’s Change on the same idea)', async () => {
      const day = addDays(t.today(), 1);
      const garmentIds = [tops[1], bottoms[1], shoes[1]];
      const { entryId, outfitId } = await autoEntry(garmentIds, day, 'work');
      const outcome = await replaceEntryOutfit(
        { db: t.db, logger: t.logger },
        owner,
        { entryId, day, occasion: 'work' },
        { garmentIds, origin: 'idea' },
        BY_PERSON,
      );
      expect(outcome).toMatchObject({
        outcome: 'unchanged',
        outfitId,
        alreadySaved: true,
        adopted: true,
      });
      expect((await entriesOn(day))[0].plannedBy).toBe('user');
    });
  });

  describe('the daily re-plan against a live write', () => {
    let deps: ReplanDeps;

    beforeAll(() => {
      deps = {
        db: t.db,
        weather: undefined,
        push: undefined,
        timeZone: t.timeZone,
        logger: t.logger.child({ logger: 'WeekPlan' }),
      };
    });

    /**
     * Tomorrow's auto entry, whose top is then archived: the re-plan's
     * verdict is a swap (the control case proves it).
     */
    const unwearableAutoEntry = async () => {
      const day = addDays(t.today(), 1);
      const planned = await autoEntry(
        [tops[0], bottoms[0], shoes[0]],
        day,
        'all-day',
      );
      const archived = await setGarmentStatus(t.db, tops[0], t.owner.id, {
        event: 'archive',
      });
      expect(archived.ok).toBe(true);
      return { day, ...planned };
    };

    it('swaps an unwearable auto entry when nobody writes meanwhile (the control)', async () => {
      const { day, outfitId } = await unwearableAutoEntry();
      const outcome = await replanToday(deps, t.owner.id, new Date(), {
        job: 'replan',
      });
      expect(outcome).toMatchObject({ kind: 'replanned' });
      const entries = await entriesOn(day);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ plannedBy: 'auto' });
      expect(entries[0].outfitId).not.toBe(outfitId);
    });

    it('leaves the entry the person took over by planning its outfit again', async () => {
      const { day, entryId, outfitId } = await unwearableAutoEntry();
      const [schedule, replan] = await interleave(
        (tx) =>
          scheduleOutfit(tx, {
            ownerId: t.owner.id,
            outfitId,
            day,
            occasion: 'all-day',
            chooser: BY_PERSON,
          }),
        () => replanToday(deps, t.owner.id, new Date(), { job: 'replan' }),
      );
      expect(schedule).toEqual({
        outcome: 'already-scheduled',
        adopted: true,
        entryId,
        occasion: 'all-day',
      });
      expect(replan).toEqual({ kind: 'skipped' });
      // One outfit in the slot, the person's: no swap beside it.
      expect(await entriesOn(day)).toEqual([
        { id: entryId, outfitId, occasion: 'all-day', plannedBy: 'user' },
      ]);
    });

    it('swaps in nothing for the entry the person deleted', async () => {
      const { day, entryId, outfitId } = await unwearableAutoEntry();
      const outfits = await t.db.$count(outfit);
      const [deleted, replan] = await interleave(
        (tx) => deleteEntry(tx, entryId, t.owner.id),
        () => replanToday(deps, t.owner.id, new Date(), { job: 'replan' }),
      );
      // Its planner-made outfit goes with it (Undo's rule, #659).
      expect(deleted).toMatchObject({ selfies: [], oneOffRemoved: outfitId });
      expect(replan).toEqual({ kind: 'skipped' });
      expect(await entriesOn(day)).toEqual([]);
      expect(await t.db.$count(outfit)).toBe(outfits - 1);
    });

    it('defers, the day unclaimed, behind a write that holds the lock past its timeout (#134)', async () => {
      const { day, outfitId } = await unwearableAutoEntry();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = t.db.transaction(async (tx) => {
        await lockOwner(tx, t.owner.id);
        held();
        await released;
      });
      await Promise.race([holding, holder]);
      const replan = await replanToday(deps, t.owner.id, new Date(), {
        job: 'replan',
      });
      release();
      await holder;

      expect(replan).toEqual({ kind: 'deferred' });
      expect(await t.db.$count(weekReplan)).toBe(0);
      expect(
        t.logs
          .messages('warn', 'WeekPlan')
          .some((line) =>
            line.startsWith(
              `Week re-plan for user ${t.owner.id} on ${t.today()} deferred: replanUser for owner ${t.owner.id} waited`,
            ),
          ),
      ).toBe(true);
      // The next minute's run judges it.
      expect(
        await replanToday(deps, t.owner.id, new Date(), { job: 'replan' }),
      ).toMatchObject({
        kind: 'replanned',
      });
      expect((await entriesOn(day))[0].outfitId).not.toBe(outfitId);
    });
  });

  describe('the lock timeout (#134, #158)', () => {
    // lockOwner sets lock_timeout in the lock's own statement: it bounds the
    // wait only while set_config is computed in the scan below LockRows. The
    // mark the sync triggers read (#196a) is the opposite: set above LockRows,
    // over the row it locked, so a wait that failed leaves no mark.
    it('is set below LockRows, and the mark above it, in the same statement as the lock', async () => {
      const plan = await planOf(lockOwnerQuery(t.db, t.owner.id).getSQL());
      const lock = lockRowsOn(plan, 'user');
      expect(outputOf(scanOf(lock, 'user'))).toContain("'lock_timeout'");
      expect(outputOf(scanOf(lock, 'user'))).not.toContain(
        LOCKED_OWNERS_SETTING,
      );
      const marking = nodesOf(plan).find((node) =>
        outputOf(node).includes(LOCKED_OWNERS_SETTING),
      );
      expect(marking?.['Node Type']).toBe('Subquery Scan');
      expect(nodesOf(marking!)).toContain(lock);
    });

    it("names the joined writer that waited, not its caller's", async () => {
      // Another transaction holds a garment of the idea: pickIdea's FOR
      // SHARE, inside wearIdea's owner transaction, waits past the bound.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = t.db.transaction(async (tx) => {
        await tx
          .select({ id: garment.id })
          .from(garment)
          .where(eq(garment.id, tops[0]))
          .for('update');
        held();
        await released;
      });
      await Promise.race([holding, holder]);
      t.logs.clear();
      const res = await t.inject({
        method: 'POST',
        url: '/today/wear',
        ...formPayload({
          garmentId: [tops[0], bottoms[0]].map(String),
          occasion: 'all-day',
        }),
      });
      release();
      await holder;
      expect(res.statusCode).toBe(503);
      expect(t.logs.messages('warn', 'Web')).toContainEqual(
        expect.stringContaining(
          `(pickIdea for owner ${t.owner.id} waited 5000 ms for a lock)`,
        ),
      );
    });
  });

  describe('a pick against an archive or a delete of its garment', () => {
    const idea = () => [tops[2], bottoms[2], shoes[1]];

    it('a pick that waited on an archive refuses the garment and writes nothing', async () => {
      const day = addDays(t.today(), 1);
      const [archived, pick] = await interleave(
        (tx) => setGarmentStatus(tx, tops[2], t.owner.id, { event: 'archive' }),
        () =>
          pickIdea(t.db, t.owner.id, {
            garmentIds: idea(),
            plan: { day, occasion: 'all-day' },
            origin: 'idea',
            madeBy: BY_PERSON,
          }),
      );
      expect(archived).toMatchObject({ ok: true, to: 'archived' });
      expect(pick).toBe('not-found');
      expect(await t.db.$count(outfit)).toBe(0);
      expect(await entriesOn(day)).toEqual([]);
    });

    it('a pick that waited on a delete refuses the garment and writes nothing', async () => {
      const day = addDays(t.today(), 1);
      const doomed = await garmentIn('Olive tee', 'tops', 'green');
      const [deleted, pick] = await interleave(
        (tx) => deleteGarment(tx, doomed, t.owner.id),
        () =>
          pickIdea(t.db, t.owner.id, {
            garmentIds: [doomed, bottoms[2], shoes[1]],
            plan: { day, occasion: 'all-day' },
            origin: 'idea',
            madeBy: BY_PERSON,
          }),
      );
      // Deleted (it had no photo).
      expect(deleted).toEqual({ ok: true, status: 'closet', photo: null });
      expect(pick).toBe('not-found');
      expect(await t.db.$count(outfit)).toBe(0);
      expect(await entriesOn(day)).toEqual([]);
    });

    it('an archive that waited on a pick comes after its outfit, whole', async () => {
      const day = addDays(t.today(), 1);
      const [pick, archived] = await interleave(
        (tx) =>
          pickIdea(tx, t.owner.id, {
            garmentIds: idea(),
            plan: { day, occasion: 'all-day' },
            origin: 'idea',
            madeBy: BY_PERSON,
          }),
        () => setGarmentStatus(t.db, tops[2], t.owner.id, { event: 'archive' }),
      );
      expect(archived).toMatchObject({ ok: true, to: 'archived' });
      if (pick === 'not-found') throw new Error('the pick was refused');
      const slots = await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, pick.id));
      expect(slots.map((s) => s.garmentId).sort((a, b) => a! - b!)).toEqual(
        idea().sort((a, b) => a - b),
      );
      expect(await entriesOn(day)).toHaveLength(1);
    });
  });

  describe('every synced write takes the owner lock first (#196a)', () => {
    it('folds it ahead of the row locks of lockGarment, lockTrip, lockMembers and the cutout rows', async () => {
      const lock = ownerLockCte(t.db, t.owner.id);
      await expectOwnerLockFirst(
        lockGarmentQuery(t.db, lock, tops[0], t.owner.id).getSQL(),
        'garment',
      );
      await expectOwnerLockFirst(
        lockTripQuery(t.db, 1, t.owner.id).getSQL(),
        'trip',
      );
      await expectOwnerLockFirst(
        lockMembersSql(t.db, t.owner.id, [1, 2], [tops[0], tops[1]]),
        'capsule',
      );
      await expectOwnerLockFirst(
        lockCutoutRowQuery(t.db, 'photo.webp').getSQL(),
        'file',
      );
      // The retry's batch (#544): its owners are read per row beside the
      // lock, so the lock must still run below the rows' LockRows, not
      // above their sort.
      await expectOwnerLockFirst(
        lockCutoutRowsQuery(t.db, ['a.webp', 'b.webp']).getSQL(),
        'file',
      );
    });

    it('a garment autosave that waited on a pick writes after it', async () => {
      const [pick, saved] = await interleave(
        (tx) =>
          pickIdea(tx, t.owner.id, {
            garmentIds: [tops[0], bottoms[0]],
            origin: 'person',
            madeBy: BY_PERSON,
          }),
        () => updateGarmentProperties(t.db, tops[0], t.owner.id, { warmth: 3 }),
      );
      expect(pick).not.toBe('not-found');
      expect(saved).toBe(true);
    });

    it('a trip write that waited on an outfit deletion writes after it, never a deadlock', async () => {
      const day = addDays(t.today(), 3);
      const tripId = await createTrip(t.db, t.owner.id, {
        name: 'Lock order',
        destination: null,
        startsOn: day,
        endsOn: day,
        notes: null,
      });
      const doomed = await outfitOf([tops[1], bottoms[1]]);
      expect(
        await addTripOutfit(t.db, {
          tripId,
          ownerId: t.owner.id,
          outfitId: doomed,
          madeBy: BY_PERSON,
        }),
      ).toBe('added');
      // deleteOutfit holds the owner lock and cascades into the trip's
      // rows; the extras' write waits on the owner, not the trip.
      const [, added] = await interleave(
        (tx) => deleteOutfit(tx, doomed, t.owner.id),
        () => addTripItems(t.db, tripId, t.owner.id, ['Charger']),
      );
      expect(added).toBe(1);
    });

    // Account deletion locks only its own account because no other
    // wardrobe can show a photo row of its: the photo foreign key is the
    // pair (photo_id, owner_id) (#703). Before it, a MANAGE grantee's
    // upload made such rows, and their deletion emptied the owner's garment.
    it("refuses a garment showing another account's photo row", async () => {
      await t.register('lock-uploader@example.com');
      const uploader = await userIdOf(t, 'lock-uploader@example.com');
      const cookie = await t.register('lock-photo-owner@example.com');
      const shown = await createGarment(t, {
        name: 'Shown',
        category: 'tops',
        cookie,
      });
      await expect(
        asFixture(t.db, async (tx) => {
          const photoId = await insertPhotoRow(tx, {
            fileName: `${randomUUID()}.webp`,
            shareableId: randomUUID(),
            createdOn: new Date().toISOString(),
            createdById: uploader,
          });
          await tx
            .update(garment)
            .set({ photoId })
            .where(eq(garment.id, shown));
        }),
      ).rejects.toMatchObject({
        cause: {
          code: '23503',
          constraint: 'garment_photo_id_owner_id_foreign',
        },
      });
    });

    describe("a pending photo's taker against its account's deletion", () => {
      const deps = () => ({
        db: t.db,
        photos: t.photos,
        logger: silentLogger,
        cutouts: { wake: () => undefined, enabled: true },
      });
      const fields = () => {
        const form = readGarmentForm({ category: 'tops' }, { owner: true });
        if (!form.ok) throw new Error('the fixture form must read');
        return form.fields;
      };

      /** A new account holding one pending photo: its id and the photo's name. */
      const saverWithPendingPhoto = async (email: string) => {
        await t.register(email);
        const saver = await userIdOf(t, email);
        const { fileName } = await t.photos.storeImage(
          {
            stream: Readable.from(await jpegPhoto(64, 64)),
            mimetype: 'image/jpeg',
            filename: 'pending.jpg',
          },
          saver,
        );
        await keepPendingPhoto(deps(), fileName, saver);
        return { saver, fileName };
      };

      /** Every taker of a pending row: each locks the owner, then the name (lockOwnerAndPhotoName). */
      const takers: Record<
        string,
        (saver: number, fileName: string) => Promise<unknown>
      > = {
        "a garment's save": (saver, fileName) =>
          createGarmentWithPendingPhoto(
            deps(),
            saver,
            saver,
            fields(),
            fileName,
            'closet',
            BY_PERSON,
          ),
        'a discard': (saver, fileName) =>
          discardPendingPhoto(deps(), fileName, {
            userId: saver,
            ownerId: saver,
          }),
        "a look's save": async (saver, fileName) => {
          const photo = await t.photos.pendingPhotoRow(fileName, saver);
          if (!photo) throw new Error('the fixture photo must be stored');
          return saveInspirationWithPendingPhoto(t.db, saver, photo, {
            title: null,
            sourceUrl: 'https://example.com/look',
          });
        },
      };

      /** A third transaction (backend `pid`) holding what `work` locked until `release`. */
      const holdOpen = async (work: (tx: Queryable) => Promise<unknown>) => {
        let held!: () => void;
        const holding = new Promise<void>((resolve) => (held = resolve));
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let pid!: number;
        const holder = t.db.transaction(async (tx) => {
          await work(tx);
          pid = await backendPid(tx);
          held();
          await released;
        });
        await Promise.race([holding, holder]);
        return {
          pid,
          release: () => {
            release();
            return holder;
          },
        };
      };

      const holdPendingRow = (fileName: string) =>
        holdOpen((tx) =>
          tx
            .select({ fileName: pendingPhoto.fileName })
            .from(pendingPhoto)
            .where(eq(pendingPhoto.fileName, fileName))
            .for('update'),
        );

      /** A third transaction holding a `file` row of `createdById`'s (no garment shows it). */
      const holdPhotoRowOf = async (createdById: number) => {
        const id = await asFixture(t.db, (tx) =>
          insertPhotoRow(tx, {
            fileName: `${randomUUID()}.webp`,
            shareableId: randomUUID(),
            createdOn: new Date().toISOString(),
            createdById,
          }),
        );
        return holdOpen((tx) =>
          tx
            .select({ id: file.id })
            .from(file)
            .where(eq(file.id, id))
            .for('update'),
        );
      };

      /** Whether `fileName`'s bytes are still stored. */
      const stored = (fileName: string) => t.photos.storage.exists(fileName);

      const deleteAccountOf = (userId: number) =>
        deleteAccount({ db: t.db, photos: t.photos, logger: t.logger }, userId);

      describe.each(Object.entries(takers))('%s', (name, take) => {
        const email = (order: string) =>
          `${order}-${name.replace(/\W+/g, '-')}@example.com`;

        // The taker holds the owner and the name, stopped at the row (a third
        // transaction holds it); the deletion waits on the owner, not the
        // row. Taking the row before the owner (lockPhotoName, then the
        // garment's insert locking the owner) deadlocked here, 40P01.
        it('a deletion that waited on it deletes the account after it', async () => {
          const { saver, fileName } = await saverWithPendingPhoto(
            email('take-first'),
          );
          const row = await holdPendingRow(fileName);
          const taken = take(saver, fileName);
          await waitForBlockedOn(t.db, row.pid);
          const deletion = deleteAccountOf(saver);
          await waitForBlockedOn(t.db, row.pid, 2);
          await row.release();
          const [answer] = await Promise.all([taken, deletion]);
          expect(answer).toBeDefined();
          expect(await t.db.$count(user, eq(user.id, saver))).toBe(0);
          expect(
            await t.db.$count(pendingPhoto, eq(pendingPhoto.userId, saver)),
          ).toBe(0);
          // The saved `file` row is the deletion's to unlink (#544): a
          // delete folded into its lock statement read with the snapshot
          // from before the wait, missed the row, and the cascade dropped
          // it with its bytes left behind.
          expect(await stored(fileName)).toBe(false);
        });

        // deleteUserAndFileRows' order, held between its owner lock and its
        // pending rows' delete: the taker must wait on the owner, not take
        // the row first (a deadlock, or a look whose file row the
        // deletion's cascade drops without its bytes).
        it('waits on a deletion and finds its photo gone, never a deadlock', async () => {
          const { saver, fileName } = await saverWithPendingPhoto(
            email('delete-first'),
          );
          let locked!: () => void;
          const ownerHeld = new Promise<void>((resolve) => (locked = resolve));
          let proceed!: () => void;
          const go = new Promise<void>((resolve) => (proceed = resolve));
          let deletionPid!: number;
          const deletion = t.db.transaction(async (tx) => {
            await lockOwner(tx, saver);
            deletionPid = await backendPid(tx);
            locked();
            await go;
            return tx
              .delete(pendingPhoto)
              .where(eq(pendingPhoto.userId, saver))
              .returning({ fileName: pendingPhoto.fileName });
          });
          await Promise.race([ownerHeld, deletion]);
          const taken = take(saver, fileName);
          await waitForBlockedOn(t.db, deletionPid);
          proceed();
          const [deleted, answer] = await Promise.all([deletion, taken]);
          expect(deleted).toEqual([{ fileName }]);
          expect(answer).toBeUndefined();
          expect(await t.db.$count(garment, eq(garment.ownerId, saver))).toBe(
            0,
          );
          expect(
            await t.db.$count(inspiration, eq(inspiration.ownerId, saver)),
          ).toBe(0);
        });
      });

      // A MANAGE grantee's save of their pending photo into the owner's
      // wardrobe writes rows of two accounts: the uploader's pending row and
      // the owner's garment and file row. It locks both, in id order, before
      // either (lockOwnersAndPhotoName), so each account's deletion and the
      // save take turns, whichever goes first, and never deadlock (#544).
      describe("a grantee's save into the owner's wardrobe against either account's deletion", () => {
        const accounts = async (order: string) => {
          const { saver: grantee, fileName } = await saverWithPendingPhoto(
            `grantee-${order}@example.com`,
          );
          await t.register(`wardrobe-${order}@example.com`);
          const owner = await userIdOf(t, `wardrobe-${order}@example.com`);
          return { grantee, owner, fileName };
        };
        const save = (owner: number, grantee: number, fileName: string) =>
          createGarmentWithPendingPhoto(
            deps(),
            owner,
            grantee,
            fields(),
            fileName,
            'closet',
            BY_PERSON,
          );
        /** A third transaction holding the photo's name: a save stops behind its account locks. */
        const holdName = (fileName: string) =>
          holdOpen((tx) => lockOwnersAndPhotoName(tx, [t.owner.id], fileName));

        // Locking only the owner, the save never held the uploader: the
        // deletion took the pending row from under it and the save lost
        // its photo.
        it("an uploader's deletion waits for the save, which keeps the photo", async () => {
          const { grantee, owner, fileName } = await accounts('uploader-later');
          const name = await holdName(fileName);
          const saved = save(owner, grantee, fileName);
          await waitForBlockedOn(t.db, name.pid);
          const deletion = deleteAccountOf(grantee);
          await waitForBlockedOn(t.db, name.pid, 2);
          await name.release();
          const [claimed, photos] = await Promise.all([saved, deletion]);
          expect(photos).toBe(0);
          expect(await garmentRow(t, claimed!.id)).toMatchObject({
            ownerId: owner,
            photo: { fileName, createdById: owner },
          });
          expect(await stored(fileName)).toBe(true);
        });

        // The deletion stops after its locks, at a photo row of the
        // grantee's that a third transaction holds. Locking only the
        // owner, the save took the pending row without waiting.
        it("a save waits on its uploader's deletion and finds the photo gone", async () => {
          const { grantee, owner, fileName } = await accounts('uploader-first');
          const row = await holdPhotoRowOf(grantee);
          const deletion = deleteAccountOf(grantee);
          await waitForBlockedOn(t.db, row.pid);
          const saved = save(owner, grantee, fileName);
          await waitForBlockedOn(t.db, row.pid, 2);
          await row.release();
          const [photos, claimed] = await Promise.all([deletion, saved]);
          expect(claimed).toBeUndefined();
          expect(photos).toBe(2);
          expect(await stored(fileName)).toBe(false);
          expect(await t.db.$count(garment, eq(garment.ownerId, owner))).toBe(
            0,
          );
        });

        // The save's file row is the owner's: the deletion that waited on
        // it must see it, under its locks, and return its bytes.
        it("an owner's deletion waits for the save and deletes its photo", async () => {
          const { grantee, owner, fileName } = await accounts('owner-later');
          const name = await holdName(fileName);
          const saved = save(owner, grantee, fileName);
          await waitForBlockedOn(t.db, name.pid);
          const deletion = deleteAccountOf(owner);
          await waitForBlockedOn(t.db, name.pid, 2);
          await name.release();
          const [claimed, photos] = await Promise.all([saved, deletion]);
          expect(claimed).toBeDefined();
          expect(photos).toBe(1);
          expect(await t.db.$count(file, eq(file.fileName, fileName))).toBe(0);
          expect(await stored(fileName)).toBe(false);
        });

        // The save locked the grantee, not the owner, once the owner was
        // gone: it is refused (every account or nothing), and the pending
        // photo stays the grantee's.
        it("a save waits on the owner's deletion and refuses, the photo still pending", async () => {
          const { grantee, owner, fileName } = await accounts('owner-first');
          const row = await holdPhotoRowOf(owner);
          const deletion = deleteAccountOf(owner);
          await waitForBlockedOn(t.db, row.pid);
          const saved = save(owner, grantee, fileName);
          await waitForBlockedOn(t.db, row.pid, 2);
          await row.release();
          const [photos, claimed] = await Promise.all([deletion, saved]);
          expect(photos).toBe(1);
          expect(claimed).toBeUndefined();
          expect(
            await t.db.$count(
              pendingPhoto,
              eq(pendingPhoto.fileName, fileName),
            ),
          ).toBe(1);
          expect(await stored(fileName)).toBe(true);
        });
      });
    });
  });

  describe('the sync triggers refuse an unlocked write (drizzle/0052_sync-triggers.sql)', () => {
    it('refuses a write to a synced table without its owner lock', async () => {
      await expect(
        t.db
          .update(garment)
          .set({ notes: 'unlocked' })
          .where(eq(garment.id, tops[0])),
      ).rejects.toMatchObject({
        cause: {
          code: 'P0001',
          message: expect.stringMatching(
            /^owner lock not held: a write to garment/,
          ),
        },
      });
    });

    // The cascades of a garment's, an outfit's and an account's deletion
    // write their children with the deleting writer's owner lock held, or
    // with the owner already gone: no refusal, no foreign key error (an
    // account's cascade writes no tombstone).
    it('lets every cascade through: a garment, an outfit and an account deleted with their children', async () => {
      const day = addDays(t.today(), 4);
      const doomed = await garmentIn('Doomed shirt', 'tops', 'red');
      const outfitId = await outfitOf([doomed, bottoms[2]]);
      await insertEntry(t.db, {
        ownerId: t.owner.id,
        outfitId,
        day,
        occasion: 'all-day',
        chooser: BY_PERSON,
      });
      const capsuleId = await createCapsule(t.db, t.owner.id, {
        name: `Cascade ${day}`,
        notes: null,
      });
      if (capsuleId === 'name-taken') throw new Error('capsule name taken');
      await changeMembership(t.db, t.owner.id, {
        add: { capsuleIds: [capsuleId], garmentIds: [doomed] },
      });
      const tripId = await createTrip(t.db, t.owner.id, {
        name: 'Cascade',
        destination: null,
        startsOn: day,
        endsOn: day,
        notes: null,
      });
      await addTripOutfit(t.db, {
        tripId,
        ownerId: t.owner.id,
        outfitId,
        madeBy: BY_PERSON,
      });
      await setPacked(t.db, {
        tripId,
        ownerId: t.owner.id,
        packed: [doomed],
        unpacked: [],
      });
      await setWoreToday(t.db, {
        garmentId: doomed,
        ownerId: t.owner.id,
        day: t.today(),
        worn: true,
        wornAt: null,
      });
      await addRepair(t.db, t.owner.id, doomed, {
        day: t.today(),
        kind: REPAIR_KINDS[0],
        note: 'A button',
        cost: null,
      });

      expect(await deleteGarment(t.db, doomed, t.owner.id)).toMatchObject({
        ok: true,
      });
      expect(await deleteOutfit(t.db, outfitId, t.owner.id)).toBeDefined();
      expect(await deleteTrip(t.db, tripId, t.owner.id)).toBe(true);

      const cookie = await t.register('cascade-account@example.com');
      const theirs = await userIdOf(t, 'cascade-account@example.com');
      const theirGarment = await createGarment(t, {
        name: 'Theirs',
        category: 'tops',
        cookie,
      });
      await pickIdea(t.db, theirs, {
        garmentIds: [theirGarment],
        origin: 'person',
        madeBy: BY_PERSON,
      });
      await saveWeekTemplate(t.db, theirs, [{ weekday: 1, occasion: 'work' }]);
      await deleteAccount(
        { db: t.db, photos: t.photos, logger: t.logger },
        theirs,
      );
      expect(await t.db.$count(garment, eq(garment.ownerId, theirs))).toBe(0);
      expect(await t.db.$count(outfit, inArray(outfit.ownerId, [theirs]))).toBe(
        0,
      );
    });
  });
});
