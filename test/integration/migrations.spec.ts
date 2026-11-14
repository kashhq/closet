import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate';
import {
  file,
  garment,
  GARMENT_WEAR_CLIENT_ID_UNIQUE,
  inspiration,
  outfit,
  outfitCalendar,
  outfitSlot,
  selfie,
  weekPlan,
  weekPlanEntry,
} from '../../src/db/schema';
import type { Queryable } from '../../src/db/client';
import { SYNC_ROOTS } from '../../src/db/sync-tables';
import { schemaDrift } from '../support/schema-drift';
import { createGarment } from './garments';
import { insertPhotoRow } from '../../src/web/files/queries';
import { asFixture, createTestApp, TestApp, userIdOf } from './harness';

/**
 * Booting the app runs the Drizzle migrations (src/db/migrate.ts) on a fresh
 * database; the schema they leave behind must be exactly src/db/schema.ts.
 * The legacy path (a database built by MikroORM, as production's was) is
 * test/integration/migration-runner.spec.ts.
 */
describe('migrations', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('leaves no difference between src/db/schema.ts and the migrated schema', async () => {
    expect(await schemaDrift(t.db)).toEqual([]);
  });

  // The drift check compares against the schema file, so an index dropped
  // from both would pass it. Postgres does not index foreign keys on its
  // own: this list is what the queries rely on.
  it('creates the lookup and foreign-key indexes', async () => {
    const { rows } = await t.db.execute<{ name: string }>(
      sql`select indexname as name from pg_indexes where schemaname = current_schema()`,
    );
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        // Share links and the watermark route look rows up by these.
        'file_shareable_id_unique',
        'garment_shareable_id_unique',
        'outfit_shareable_id_unique',
        'file_created_by_id_index',
        // The wardrobe grid's and the wishlist's keyset pages (also the
        // owner_id foreign key) and its category filter, which the outfit
        // builder shares; what a wishlist item replaces (its foreign key).
        'garment_owner_id_status_id_index',
        'garment_replaces_garment_id_index',
        'garment_owner_id_category_id_index',
        // The owner_id foreign key's, with the sync feed's keyset (#709: the
        // single-column indexes beside them were dropped).
        'outfit_owner_id_revision_index',
        'garment_wear_owner_id_revision_index',
        'week_plan_owner_id_revision_index',
        'garment_photo_id_unique',
        // Also the index of outfit_slot.outfit_id.
        'outfit_slot_pkey',
        'outfit_slot_garment_id_index',
        // Also the (owner_id, day) index of the calendar's week queries.
        'outfit_calendar_owner_id_day_outfit_id_unique',
        'outfit_calendar_outfit_id_index',
        'user_device_user_id_index',
        // Pending photos' per-user cap (oldest first); also the user_id key's.
        'pending_photo_user_id_created_at_index',
        // A draft batch's wardrobe (#200): the foreign key's.
        'pending_photo_batch_owner_id_index',
        // Also the grantor_id foreign key's index (#175).
        'wardrobe_share_grantor_id_grantee_id_unique',
        'wardrobe_share_grantee_id_index',
        'wardrobe_share_invite_token_unique',
        // One name per owner, any case; also the owner_id foreign key's.
        'capsule_owner_id_lower_name_unique',
        // Also the index of capsule_garment.capsule_id.
        'capsule_garment_pkey',
        'capsule_garment_garment_id_index',
        // The wear counts (per garment, by day; also garment_id's foreign
        // key), an entry's wears (also outfit_calendar_id's), "Wore today"
        // once a day, and the owner_id foreign key.
        'garment_wear_garment_id_day_index',
        'garment_wear_outfit_calendar_id_garment_id_unique',
        'garment_wear_garment_id_day_single_unique',
        // The generator reads an owner's avoided pairs (also the owner_id
        // foreign key's); each garment's foreign key has its own.
        'generator_avoid_pkey',
        'generator_avoid_garment_a_id_index',
        'generator_avoid_garment_b_id_index',
        // A rule stored once, led by owner_id (the generator's read and the
        // owner_id foreign key's); each side's garment has its own.
        'outfit_rule_owner_id_kind_a_b_unique',
        'outfit_rule_a_garment_id_index',
        'outfit_rule_b_garment_id_index',
        // Every MCP call looks its bearer token up by its hash; the profile
        // lists a user's tokens (also the user_id foreign key's).
        'personal_access_token_token_hash_unique',
        'personal_access_token_user_id_index',
        // Login and every email lookup compare lower(email).
        'user_lower_email_unique',
        // The week template (#16): a user's (also its user_id foreign
        // key's), one outfit for the day per weekday; a user's plans and a
        // plan's entries (their foreign keys); the re-plan's claims (also
        // the user_id foreign key's).
        'week_template_pkey',
        'week_template_user_id_weekday_day_unique',
        'week_plan_entry_week_plan_id_index',
        'week_replan_pkey',
        // Sizes (#24): one row per brand per user, any case (also the
        // user_id foreign key's and the hint's lookup).
        'brand_size_user_id_brand_key_unique',
        // Outfit selfies (#19): an entry's selfie (also outfit_calendar_id's
        // foreign key), a photo's selfie (the public /file route's refusal,
        // photo_id's), a week's detached looks (also owner_id's).
        'selfie_outfit_calendar_id_unique',
        'selfie_photo_id_unique',
        'selfie_owner_id_day_index',
        // Saved looks (#22): the list newest first (also owner_id's), a
        // photo one look's (also photo_id's), a garment's matches (the
        // matched_garment_id foreign key's; the pieces' key leads with
        // inspiration_id).
        'inspiration_owner_id_id_index',
        'inspiration_photo_id_unique',
        'inspiration_piece_matched_garment_id_index',
        // Trips (#10): the list (also owner_id's), a trip's outfits once a
        // day or once undated (also trip_id's), an outfit's trips (the
        // packed marks' pruning; outfit_id's), extras once per label (also
        // trip_id's), packed marks (trip_id's) and a garment's (garment_id's).
        'trip_owner_id_starts_on_index',
        'trip_outfit_trip_id_outfit_id_day_unique',
        'trip_outfit_trip_id_outfit_id_undated_unique',
        'trip_outfit_outfit_id_index',
        'trip_item_trip_id_lower_label_unique',
        'trip_garment_packed_pkey',
        'trip_garment_packed_garment_id_index',
        // A garment's repair log, newest first (#23; also garment_id's
        // foreign key).
        'garment_repair_garment_id_day_index',
        // The order mail (#25): the processed ids and the watermark; the
        // review list, one listing per product (also owner_id's foreign
        // key), an email's items and a garment's item (their foreign keys).
        'order_email_account_id_email_id_unique',
        'order_email_received_at_index',
        'order_item_owner_id_product_url_unique',
        'order_item_order_email_id_index',
        'order_item_garment_id_index',
        // The quiet close of Muse's rounds (#337): each owner's newest
        // suggestion and proposal, read every minute; the latest round.
        'garment_owner_id_suggested_at_index',
        'outfit_owner_id_proposed_at_index',
        'muse_round_owner_id_finished_at_index',
        // The sync (#196a): the feed's keyset per root and of the
        // tombstones (#196b), a replayed create's tombstone lookup, and a
        // retried create's client id.
        ...SYNC_ROOTS.filter((root) => root.id === 'id').map(
          (root) => `${root.table}_${root.owner}_revision_index`,
        ),
        'sync_tombstone_owner_id_revision_index',
        'sync_tombstone_owner_id_client_id_index',
        GARMENT_WEAR_CLIENT_ID_UNIQUE,
      ]),
    );
  });

  // relations() are checked only when a relational query uses them; every
  // relation in the schema is walked once here.
  it('resolves every relation in the schema', async () => {
    await expect(
      Promise.all([
        t.db.query.user.findMany({
          with: {
            devices: true,
            accessTokens: true,
            fileUploads: true,
            garments: true,
            outfits: true,
            capsules: true,
            trips: true,
            calendarEntries: true,
            sharesGranted: true,
            sharesReceived: true,
          },
        }),
        t.db.query.file.findMany({
          with: { createdBy: true, garment: true, selfie: true },
        }),
        t.db.query.selfie.findMany({
          with: { owner: true, entry: true, photo: true },
        }),
        t.db.query.garment.findMany({
          with: {
            photo: true,
            owner: true,
            outfitSlots: true,
            capsuleGarments: true,
            wears: true,
            repairs: true,
          },
        }),
        t.db.query.outfit.findMany({
          with: {
            owner: true,
            slots: true,
            calendarEntries: true,
            trips: true,
          },
        }),
        t.db.query.outfitSlot.findMany({
          with: { outfit: true, garment: true },
        }),
        t.db.query.outfitCalendar.findMany({
          with: { outfit: true, owner: true, wears: true, selfie: true },
        }),
        t.db.query.garmentWear.findMany({
          with: { garment: true, entry: true },
        }),
        t.db.query.garmentRepair.findMany({ with: { garment: true } }),
        t.db.query.wardrobeShare.findMany({
          with: { grantor: true, grantee: true },
        }),
        t.db.query.userDevice.findMany({ with: { user: true } }),
        t.db.query.personalAccessToken.findMany({ with: { user: true } }),
        t.db.query.capsule.findMany({ with: { owner: true, garments: true } }),
        t.db.query.capsuleGarment.findMany({
          with: { capsule: true, garment: true },
        }),
        t.db.query.trip.findMany({
          with: { owner: true, outfits: true, items: true },
        }),
        t.db.query.tripOutfit.findMany({
          with: { trip: true, outfit: true },
        }),
        t.db.query.tripItem.findMany({ with: { trip: true } }),
      ]),
    ).resolves.toBeDefined();
    const owner = await t.db.query.user.findFirst({
      where: (user, { eq }) => eq(user.id, t.owner.id),
    });
    expect(owner?.email).toBe(t.owner.email);
  });

  // 0053's backfill is a synced write in the boot's migration transaction:
  // a lock statement whose mark the sync triggers do not read would refuse
  // it and abort production's boot. So the file itself runs here, on rows
  // as they were before it (the column dropped), in a transaction holding
  // no mark of its own.
  it('backfills outfit origin (0053) under the owner lock the sync triggers read', async () => {
    const otherEmail = 'origin-backfill-other@example.com';
    await t.register(otherEmail);
    const otherId = await userIdOf(t, otherEmail);
    const shirt = await createGarment(t, { name: 'Oxford shirt' });
    const jeans = await createGarment(t, { name: 'Jeans', category: 'jeans' });
    const plannerName = 'Oxford shirt, Jeans';
    const ids = await asFixture(t.db, async (tx) => {
      const insertOutfit = async (
        values: Partial<typeof outfit.$inferInsert> & { ownerId: number },
        plan?: { outfitCreated: boolean },
      ) => {
        const [row] = await tx
          .insert(outfit)
          .values({ shareableId: randomUUID(), ...values })
          .returning({ id: outfit.id });
        if (values.ownerId === t.owner.id) {
          await tx.insert(outfitSlot).values([
            {
              outfitId: row.id,
              position: 0,
              category: 'shirt',
              garmentId: shirt,
            },
            {
              outfitId: row.id,
              position: 1,
              category: 'jeans',
              garmentId: jeans,
            },
          ]);
        }
        if (plan) {
          const [entry] = await tx
            .insert(outfitCalendar)
            .values({
              day: t.today(),
              outfitId: row.id,
              ownerId: values.ownerId,
              plannedBy: 'auto',
            })
            .returning({ id: outfitCalendar.id });
          const [batch] = await tx
            .insert(weekPlan)
            .values({ ownerId: values.ownerId })
            .returning({ id: weekPlan.id });
          await tx.insert(weekPlanEntry).values({
            entryId: entry.id,
            weekPlanId: batch.id,
            outfitCreated: plan.outfitCreated,
          });
        }
        return row.id;
      };
      const owner = t.owner.id;
      return {
        proposal: await insertOutfit({
          ownerId: otherId,
          name: 'Muse pick',
          proposedAt: new Date(),
          reaction: 'proposed',
        }),
        planner: await insertOutfit(
          { ownerId: owner, name: plannerName },
          { outfitCreated: true },
        ),
        adopted: await insertOutfit(
          { ownerId: owner, name: plannerName },
          { outfitCreated: false },
        ),
        withNotes: await insertOutfit(
          { ownerId: owner, name: plannerName, notes: 'Mine now' },
          { outfitCreated: true },
        ),
        person: await insertOutfit({ ownerId: owner, name: 'Weekend' }),
      };
    });
    const revisions = () =>
      t.db
        .select({ id: outfit.id, revision: outfit.revision })
        .from(outfit)
        .where(inArray(outfit.id, Object.values(ids)))
        .orderBy(asc(outfit.id));
    const before = new Map(
      (await revisions()).map((row) => [row.id, row.revision]),
    );

    await t.db.execute(sql`alter table outfit drop column origin`);
    const file = await readFile(
      join(MIGRATIONS_FOLDER, '0053_outfit-origin.sql'),
      'utf8',
    );
    // As drizzle's migrator runs it: each breakpoint's statement in turn,
    // in one transaction.
    await t.db.transaction(async (tx) => {
      for (const statement of file.split('--> statement-breakpoint')) {
        await tx.execute(sql.raw(statement));
      }
    });

    const rows = await t.db
      .select({
        id: outfit.id,
        origin: outfit.origin,
        revision: outfit.revision,
      })
      .from(outfit)
      .where(inArray(outfit.id, Object.values(ids)));
    const after = new Map(rows.map((row) => [row.id, row]));
    expect(
      Object.fromEntries(
        Object.entries(ids).map(([key, id]) => [key, after.get(id)?.origin]),
      ),
    ).toEqual({
      proposal: 'agent',
      planner: 'planner',
      adopted: 'person',
      withNotes: 'person',
      person: 'person',
    });
    // Only the rows whose origin moved got a new revision (the feed re-sends them).
    const moved = Object.entries(ids)
      .filter(([, id]) => after.get(id)?.revision !== before.get(id))
      .map(([key]) => key)
      .sort();
    expect(moved).toEqual(['planner', 'proposal']);
  });

  // 0065 gives each photo row to the owner of the row showing it, then
  // pairs every photo foreign key with its owner (#703). Before #40 a
  // MANAGE grantee's upload made a file row of the grantee's; the file
  // runs here on such rows, rebuilt with the constraints as they were, in
  // a transaction holding no owner lock (it writes no synced row).
  it('gives a legacy photo row to its garment, selfie or look owner (0065), refusing one shown by two owners', async () => {
    const granteeEmail = 'legacy-grantee@example.com';
    await t.register(granteeEmail);
    const grantee = await userIdOf(t, granteeEmail);
    const owner = t.owner.id;
    const coat = await createGarment(t, { name: 'Legacy coat' });
    await t.db.execute(sql.raw(PHOTO_FOREIGN_KEYS_BEFORE_0065));
    const photoOf = (tx: Queryable) =>
      insertPhotoRow(tx, {
        fileName: `${randomUUID()}.webp`,
        shareableId: randomUUID(),
        createdOn: new Date().toISOString(),
        createdById: grantee,
      });
    const ids = await asFixture(t.db, async (tx) => {
      const coatPhoto = await photoOf(tx);
      await tx
        .update(garment)
        .set({ photoId: coatPhoto })
        .where(eq(garment.id, coat));
      const selfiePhoto = await photoOf(tx);
      await tx
        .insert(selfie)
        .values({ ownerId: owner, day: t.today(), photoId: selfiePhoto });
      const lookPhoto = await photoOf(tx);
      await tx
        .insert(inspiration)
        .values({ ownerId: owner, photoId: lookPhoto });
      // The grantee's own look: already theirs, left alone.
      const ownPhoto = await photoOf(tx);
      await tx
        .insert(inspiration)
        .values({ ownerId: grantee, photoId: ownPhoto });
      return { coatPhoto, selfiePhoto, lookPhoto, ownPhoto };
    });
    const [{ revision: coatRevision }] = await t.db
      .select({ revision: garment.revision })
      .from(garment)
      .where(eq(garment.id, coat));
    const migration = await readFile(
      join(MIGRATIONS_FOLDER, '0065_photo-belongs-to-its-owner.sql'),
      'utf8',
    );
    const runMigration = () =>
      t.db.transaction(async (tx) => {
        for (const statement of migration.split('--> statement-breakpoint')) {
          await tx.execute(sql.raw(statement));
        }
      });

    // A photo shown by two owners' rows has no owner to give it: the boot
    // aborts, the batch rolled back.
    const [{ id: shared }] = await asFixture(t.db, (tx) =>
      tx
        .insert(selfie)
        .values({ ownerId: grantee, day: t.today(), photoId: ids.coatPhoto })
        .returning({ id: selfie.id }),
    );
    await expect(runMigration()).rejects.toMatchObject({
      cause: {
        message: `file rows shown by rows of different owners: ${ids.coatPhoto}`,
      },
    });
    await asFixture(t.db, (tx) =>
      tx.delete(selfie).where(eq(selfie.id, shared)),
    );

    await runMigration();
    const owners = await t.db
      .select({ id: file.id, createdById: file.createdById })
      .from(file)
      .where(inArray(file.id, Object.values(ids)));
    expect(
      Object.fromEntries(
        Object.entries(ids).map(([key, id]) => [
          key,
          owners.find((row) => row.id === id)?.createdById,
        ]),
      ),
    ).toEqual({
      coatPhoto: owner,
      selfiePhoto: owner,
      lookPhoto: owner,
      ownPhoto: grantee,
    });
    // No synced field moved: the feed has nothing to re-send.
    const [after] = await t.db
      .select({ revision: garment.revision })
      .from(garment)
      .where(eq(garment.id, coat));
    expect(after.revision).toBe(coatRevision);
    expect(await schemaDrift(t.db)).toEqual([]);
  });
});

/**
 * The photo foreign keys as 0065 found them (drizzle/0000, 0020, 0049),
 * with its own constraints gone: the shape its spec runs it on.
 */
const PHOTO_FOREIGN_KEYS_BEFORE_0065 = `
  ALTER TABLE garment DROP CONSTRAINT garment_photo_id_owner_id_foreign;
  ALTER TABLE selfie DROP CONSTRAINT selfie_photo_id_owner_id_foreign;
  ALTER TABLE inspiration DROP CONSTRAINT inspiration_photo_id_owner_id_foreign;
  ALTER TABLE file DROP CONSTRAINT file_id_created_by_id_unique;
  ALTER TABLE garment ADD CONSTRAINT garment_photo_id_foreign FOREIGN KEY (photo_id) REFERENCES file(id) ON DELETE set null ON UPDATE cascade;
  ALTER TABLE selfie ADD CONSTRAINT selfie_photo_id_foreign FOREIGN KEY (photo_id) REFERENCES file(id) ON DELETE cascade ON UPDATE cascade;
  ALTER TABLE inspiration ADD CONSTRAINT inspiration_photo_id_foreign FOREIGN KEY (photo_id) REFERENCES file(id) ON DELETE cascade ON UPDATE cascade;
`;
