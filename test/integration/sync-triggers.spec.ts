import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/client';
import { ownerLockCte, ownerLocked } from '../../src/db/owner-lock';
import {
  garment,
  outfitRule,
  styleProfile,
  syncTombstone,
  user,
} from '../../src/db/schema';
import {
  SYNC_CHILDREN,
  SYNC_ROOTS,
  SYNC_STAMPS,
} from '../../src/db/sync-tables';
import { deleteAccount } from '../../src/web/auth/account';
import { deleteOutfit } from '../../src/web/outfits/queries';
import { pickIdea } from '../../src/web/outfits/pick';
import { insertEntry } from '../../src/web/calendar/queries';
import { setWoreToday } from '../../src/web/wears/queries';
import { deleteGarment } from '../../src/web/wardrobe/queries';
import { saveWeekTemplate } from '../../src/web/week-plan/template';
import {
  addOutfitRule,
  deleteOutfitRule,
  type NewOutfitRule,
  saveStyleProfile,
} from '../../src/web/style/queries';
import { NO_MATCHER } from '../../src/web/style/validation';
import { addDays } from '../../src/calendar-date';
import { createGarment } from './garments';
import { asFixture, createTestApp, type TestApp, userIdOf } from './harness';
import { interleave } from './interleave';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * The sync triggers (#196a-2, drizzle/0052_sync-triggers.sql; plan
 * docs/plans/2026-11-12-json-api.md section 7): what the drift test cannot
 * see. Every synced table carries them; a write stamps its row with its
 * owner's revision, one per transaction per owner, rising; a child stamps
 * its parent; a delete leaves a tombstone, cascades included, and an
 * account's deletion none. The refusal of an unlocked write is
 * owner-lock.spec.ts's; a replayed create's tombstone, queued-writes.spec.ts's.
 */
describe('the sync triggers', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  const revisionOf = async (ownerId: number) =>
    (
      await t.db
        .select({ revision: user.revision })
        .from(user)
        .where(eq(user.id, ownerId))
    )[0].revision;

  const garmentRevision = async (id: number) =>
    (
      await t.db
        .select({ revision: garment.revision })
        .from(garment)
        .where(eq(garment.id, id))
    )[0].revision;

  /** A row's revision, by table and id (the roots' ids). */
  const rowRevision = async (table: string, id: number) =>
    (
      await t.db.execute<{ revision: number }>(
        sql`select revision::int from ${sql.identifier(table)} where id = ${id}`,
      )
    ).rows[0]?.revision;

  /** A bare garment of `ownerId`'s, written in `tx`. */
  const insertGarment = async (tx: Queryable, ownerId: number) =>
    (
      await tx
        .insert(garment)
        .values({ shareableId: randomUUID(), category: 'tops', ownerId })
        .returning({ id: garment.id, revision: garment.revision })
    )[0];

  const tombstonesOf = (ownerId: number) =>
    t.db
      .select({
        resource: syncTombstone.resource,
        resourceId: syncTombstone.resourceId,
        clientId: syncTombstone.clientId,
        revision: syncTombstone.revision,
      })
      .from(syncTombstone)
      .where(eq(syncTombstone.ownerId, ownerId));

  it('are on every synced table, and only there, each calling its function', async () => {
    const { rows } = await t.db.execute<{
      relation: string;
      name: string;
      fn: string;
    }>(
      sql`select c.relname as relation, tg.tgname as name, p.proname as fn
          from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
          join pg_proc p on p.oid = tg.tgfoid
          where not tg.tgisinternal and tg.tgname like 'closet_sync%'`,
    );
    const expected = [
      ['user', 'closet_sync_owner_gone', 'closet_sync_owner_gone'],
      ...SYNC_ROOTS.flatMap((root) => [
        [root.table, 'closet_sync_stamp', 'closet_sync_stamp'],
        [root.table, 'closet_sync_tombstone', 'closet_sync_tombstone'],
      ]),
      // A photo counts only on update (its version, its cutout); a child
      // that may come before its parent row creates it (0069).
      ...SYNC_CHILDREN.flatMap((child) => {
        if (child.table === 'file') {
          return [
            ['file', 'closet_sync_touch_update', 'closet_sync_touch_photo'],
          ];
        }
        const fn =
          'createsParent' in child
            ? 'closet_sync_touch_or_create'
            : 'closet_sync_touch';
        return ['insert', 'update', 'delete'].map((event) => [
          child.table,
          `closet_sync_touch_${event}`,
          fn,
        ]);
      }),
      // A stamp's table is its resource's (the week template's).
      ...SYNC_STAMPS.flatMap((stamp) =>
        ['insert', 'update', 'delete'].map((event) => [
          stamp.resource,
          `closet_sync_week_template_${event}`,
          'closet_sync_week_template',
        ]),
      ),
    ];
    expect(rows.map((row) => [row.relation, row.name, row.fn]).sort()).toEqual(
      expected.sort(),
    );
  });

  it('stamp one revision per transaction per owner, rising, two owners each their own', async () => {
    await t.register('sync-second@example.com');
    const second = await userIdOf(t, 'sync-second@example.com');
    const [mine, theirs] = [
      await revisionOf(t.owner.id),
      await revisionOf(second),
    ];

    const written = await asFixture(t.db, async (tx) => {
      const a = await insertGarment(tx, t.owner.id);
      const b = await insertGarment(tx, t.owner.id);
      const c = await insertGarment(tx, second);
      await tx
        .update(garment)
        .set({ notes: 'again' })
        .where(eq(garment.id, a.id));
      return { a, b, c };
    });
    expect([written.a.revision, written.b.revision]).toEqual([
      mine + 1,
      mine + 1,
    ]);
    expect(await garmentRevision(written.a.id)).toBe(mine + 1);
    expect(written.c.revision).toBe(theirs + 1);
    expect([await revisionOf(t.owner.id), await revisionOf(second)]).toEqual([
      mine + 1,
      theirs + 1,
    ]);

    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ notes: 'later' })
        .where(eq(garment.id, written.b.id)),
    );
    expect(await garmentRevision(written.b.id)).toBe(mine + 2);
    expect(await revisionOf(t.owner.id)).toBe(mine + 2);
  });

  it('revert the bump with a savepoint rolled back, and bump again after it', async () => {
    const before = await revisionOf(t.owner.id);
    const kept = await asFixture(t.db, async (tx) => {
      await tx
        .transaction(async (savepoint) => {
          await insertGarment(savepoint, t.owner.id);
          throw new Error('rolled back');
        })
        .catch(() => undefined);
      return insertGarment(tx, t.owner.id);
    });
    expect(kept.revision).toBe(before + 1);
    expect(await revisionOf(t.owner.id)).toBe(before + 1);
  });

  it('stamp a parent once per statement for its child, never for a photo lease', async () => {
    const shirt = await createGarment(t, {
      name: 'Sync shirt',
      category: 'tops',
    });
    const pick = await pickIdea(t.db, t.owner.id, {
      garmentIds: [shirt],
      origin: 'person',
      madeBy: BY_PERSON,
    });
    if (pick === 'not-found') throw new Error('garment not found');

    const before = await revisionOf(t.owner.id);
    await asFixture(t.db, (tx) =>
      tx.execute(
        sql`update outfit_slot set category = 'tops' where outfit_id = ${pick.id}`,
      ),
    );
    expect(await rowRevision('outfit', pick.id)).toBe(before + 1);

    // A garment's photo: a new version stamps the garment, a lease does not.
    const photo = await asFixture(t.db, async (tx) => {
      const { rows } = await tx.execute<{ id: number }>(
        sql`insert into file (shareable_id, file_name, created_on, created_by_id, cutout_status)
            values (${randomUUID()}, ${`${randomUUID()}.webp`}, '2026-11-13', ${t.owner.id}, 'pending')
            returning id`,
      );
      await tx
        .update(garment)
        .set({ photoId: rows[0].id })
        .where(eq(garment.id, shirt));
      return rows[0].id;
    });
    const shown = await garmentRevision(shirt);
    await asFixture(t.db, (tx) =>
      tx.execute(
        sql`update file set cutout_worker = 'w1', cutout_started_at = now() where id = ${photo}`,
      ),
    );
    expect(await garmentRevision(shirt)).toBe(shown);
    await asFixture(t.db, (tx) =>
      tx.execute(
        sql`update file set version = version + 1 where id = ${photo}`,
      ),
    );
    expect(await garmentRevision(shirt)).toBe(shown + 1);

    // The week template, a per-user aggregate with no row of its own.
    await saveWeekTemplate(t.db, t.owner.id, [
      { weekday: 1, occasion: 'work' },
    ]);
    const [owner] = await t.db
      .select({
        revision: user.revision,
        weekTemplate: user.weekTemplateRevision,
      })
      .from(user)
      .where(eq(user.id, t.owner.id));
    expect(owner.weekTemplate).toBe(owner.revision);
  });

  describe("an outfit rule stamps its owner's style profile (#716)", () => {
    const colours = (
      a: 'red' | 'blue',
      b: 'green' | 'black',
    ): NewOutfitRule => ({
      kind: 'never',
      a: { ...NO_MATCHER, color: a },
      b: { ...NO_MATCHER, color: b },
    });

    const profileOf = async (userId: number) =>
      (
        await t.db
          .select({
            revision: styleProfile.revision,
            styles: styleProfile.styles,
          })
          .from(styleProfile)
          .where(eq(styleProfile.userId, userId))
      )[0];

    const newUser = async (email: string) => {
      await t.register(email);
      return userIdOf(t, email);
    };

    it('creates the profile row a rule comes before, and moves it on every add and delete', async () => {
      const userId = await newUser('rules-first@example.com');
      expect(await profileOf(userId)).toBeUndefined();

      const id = await addOutfitRule(
        t.db,
        { userId, surface: 'page' },
        colours('red', 'green'),
      );
      if (id === 'duplicate') throw new Error('duplicate');
      const added = await profileOf(userId);
      expect(added).toEqual({
        revision: await revisionOf(userId),
        styles: null,
      });

      await deleteOutfitRule(t.db, { userId, surface: 'page' }, id);
      const removed = await profileOf(userId);
      expect(removed.revision).toBe(await revisionOf(userId));
      expect(removed.revision).toBeGreaterThan(added.revision);
    });

    it("goes with a garment's delete, the profile in its one revision", async () => {
      const cookie = await t.register('rules-garment@example.com');
      const userId = await userIdOf(t, 'rules-garment@example.com');
      const coat = await createGarment(t, { name: 'Rule coat', cookie });
      expect(
        await addOutfitRule(
          t.db,
          { userId, surface: 'page' },
          {
            kind: 'never',
            a: { ...NO_MATCHER, garmentId: coat },
            b: { ...NO_MATCHER, color: 'black' },
          },
        ),
      ).toEqual(expect.any(Number));
      const before = await revisionOf(userId);

      expect(await deleteGarment(t.db, coat, userId)).toMatchObject({
        ok: true,
      });
      expect(await revisionOf(userId)).toBe(before + 1);
      expect((await profileOf(userId)).revision).toBe(before + 1);
      expect(
        await t.db.$count(outfitRule, eq(outfitRule.ownerId, userId)),
      ).toBe(0);
    });

    it('goes with its account, the profile too, stamping and tombstoning nothing', async () => {
      const userId = await newUser('rules-gone@example.com');
      await saveStyleProfile(t.db, userId, {
        styles: ['classic'],
        budget: null,
        palette: null,
        notes: null,
      });
      await addOutfitRule(
        t.db,
        { userId, surface: 'page' },
        colours('blue', 'black'),
      );

      await deleteAccount(
        { db: t.db, photos: t.photos, logger: t.logger },
        userId,
      );
      expect(await profileOf(userId)).toBeUndefined();
      expect(
        await t.db.$count(outfitRule, eq(outfitRule.ownerId, userId)),
      ).toBe(0);
      expect(await tombstonesOf(userId)).toEqual([]);
    });

    // The rule's insert creates the profile row its trigger stamps; a
    // profile save upserts the same row. Both take the owner lock first, so
    // either order queues the second behind the first, never a deadlock.
    it.each([
      ['a rule, then a profile save', true],
      ['a profile save, then a rule', false],
    ])(
      '%s for a user without a profile: the second waits on the owner lock, both land',
      async (_name, ruleFirst) => {
        const userId = await newUser(
          `rules-race-${String(ruleFirst)}@example.com`,
        );
        const rule = (db: Queryable) =>
          addOutfitRule(
            db,
            { userId, surface: 'page' },
            colours('red', 'black'),
          );
        const save = (db: Queryable) =>
          saveStyleProfile(db, userId, {
            styles: ['minimal'],
            budget: null,
            palette: null,
            notes: null,
          });
        await (ruleFirst
          ? interleave(t.db, rule, () => save(t.db))
          : interleave(t.db, save, () => rule(t.db)));

        expect(await profileOf(userId)).toEqual({
          revision: await revisionOf(userId),
          styles: ['minimal'],
        });
        expect(
          await t.db.$count(outfitRule, eq(outfitRule.ownerId, userId)),
        ).toBe(1);
      },
    );
  });

  it('tombstone every deleted root with its client id, a cascade in its deleting revision', async () => {
    const day = addDays(t.today(), -1);
    const doomed = await createGarment(t, { name: 'Doomed', category: 'tops' });
    const clientId = randomUUID();
    expect(
      await setWoreToday(t.db, {
        garmentId: doomed,
        ownerId: t.owner.id,
        day,
        worn: true,
        wornAt: null,
        clientId,
      }),
    ).toBe('changed');
    const pick = await pickIdea(t.db, t.owner.id, {
      garmentIds: [doomed],
      origin: 'person',
      madeBy: BY_PERSON,
    });
    if (pick === 'not-found') throw new Error('garment not found');
    const entry = await insertEntry(t.db, {
      ownerId: t.owner.id,
      outfitId: pick.id,
      day: addDays(t.today(), 3),
      occasion: 'all-day',
      chooser: BY_PERSON,
    });
    if (entry.outcome !== 'scheduled') throw new Error('not scheduled');

    expect(await deleteOutfit(t.db, pick.id, t.owner.id)).toBeDefined();
    const afterOutfit = await revisionOf(t.owner.id);
    expect(await deleteGarment(t.db, doomed, t.owner.id)).toMatchObject({
      ok: true,
    });
    const afterGarment = await revisionOf(t.owner.id);

    expect(await tombstonesOf(t.owner.id)).toEqual(
      expect.arrayContaining([
        {
          resource: 'outfit',
          resourceId: pick.id,
          clientId: null,
          revision: afterOutfit,
        },
        {
          resource: 'outfit_calendar',
          resourceId: entry.id,
          clientId: null,
          revision: afterOutfit,
        },
        {
          resource: 'garment',
          resourceId: doomed,
          clientId: null,
          revision: afterGarment,
        },
        expect.objectContaining({
          resource: 'garment_wear',
          clientId,
          revision: afterGarment,
        }),
      ]),
    );
  });

  it('leave no tombstone for an account deleted, and take its old ones with it', async () => {
    const cookie = await t.register('sync-gone@example.com');
    const gone = await userIdOf(t, 'sync-gone@example.com');
    const theirs = await createGarment(t, {
      name: 'Theirs',
      category: 'tops',
      cookie,
    });
    const other = await createGarment(t, {
      name: 'Other',
      category: 'tops',
      cookie,
    });
    expect(await deleteGarment(t.db, other, gone)).toMatchObject({ ok: true });
    expect(await tombstonesOf(gone)).toHaveLength(1);

    await deleteAccount({ db: t.db, photos: t.photos, logger: t.logger }, gone);
    expect(await tombstonesOf(gone)).toEqual([]);
    expect(await t.db.$count(garment, eq(garment.id, theirs))).toBe(0);
  });

  it('commit one owner’s held writers in revision order', async () => {
    const first = await createGarment(t, { name: 'First', category: 'tops' });
    const second = await createGarment(t, { name: 'Second', category: 'tops' });
    const lockedUpdate = async (db: Queryable, id: number) => {
      const lock = ownerLockCte(db, t.owner.id);
      return await db
        .with(lock)
        .update(garment)
        .set({ notes: 'held' })
        .where(and(eq(garment.id, id), ownerLocked(db, lock)))
        .returning({ revision: garment.revision });
    };
    const [[held], [waited]] = await interleave(
      t.db,
      (tx) => lockedUpdate(tx, first),
      () => lockedUpdate(t.db, second),
    );
    expect(waited.revision).toBe(held.revision + 1);
  });
});
