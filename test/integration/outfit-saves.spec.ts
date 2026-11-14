import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
  weekPlan,
  weekPlanEntry,
} from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { ownerTransaction } from '../../src/web/auth/queries';
import { replaceEntryOutfit } from '../../src/web/calendar/replace';
import { OutfitGarmentsGone } from '../../src/web/outfits/gone-garments';
import { pickIdea } from '../../src/web/outfits/pick';
import { createOutfit } from '../../src/web/outfits/queries';
import { deleteGarment } from '../../src/web/wardrobe/queries';
import { setGarmentStatus } from '../../src/web/wardrobe/status';
import {
  createWeekPlan,
  recordAutoEntry,
} from '../../src/web/week-plan/queries';
import { createWishlistItem } from './garments';
import { createTestApp, hasText, type TestApp, asFixture } from './harness';
import { interleave } from './interleave';
import { callTool, createAccessToken, tool } from './mcp';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * Outfit saves (#219). One outfit per garment set: every save that creates
 * an outfit (createOutfit: a pick, Styling's Save, the outfit form,
 * create_outfit, the week planner) takes the owner lock and reuses an
 * outfit of exactly its garments, so two saves of the same garments at the
 * same moment make one outfit, whichever commits first. And no save drops
 * a garment it cannot hold: it is refused whole, the garment named.
 * The races hold one writer's transaction open while the other waits on
 * its lock (interleave.ts), never timing.
 */

type Fields = Record<string, string | string[]>;

function form(fields: Fields) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

describe('outfit saves', () => {
  let t: TestApp;
  let token: string;
  let top: number;
  let bottom: number;
  let shoes: number;

  const garmentIn = async (name: string, category: string, color: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({
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

  const outfits = () =>
    t.db
      .select({ id: outfit.id, name: outfit.name })
      .from(outfit)
      .where(eq(outfit.ownerId, t.owner.id))
      .orderBy(asc(outfit.id));

  const slotsOf = async (outfitId: number) =>
    (
      await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, outfitId))
        .orderBy(asc(outfitSlot.position))
    ).map((slot) => slot.garmentId);

  /** The outfit form's post (POST /outfits): a row per garment. */
  const formSave = (garmentIds: number[], fields: Fields = {}) =>
    t.inject({
      method: 'POST',
      url: '/outfits',
      ...form({
        ...fields,
        category: garmentIds.map(() => 'tops'),
        garmentId: garmentIds.map(String),
      }),
    });

  /**
   * Styling's Save as the page posts it: a row per garment (role, id,
   * lock) and the sheet's fields.
   */
  const stylingSave = (
    rows: { role: string; garmentId: number }[],
    fields: Fields = {},
  ) =>
    t.inject({
      method: 'POST',
      url: '/styling',
      ...form({
        ...fields,
        role: rows.map((row) => row.role),
        garmentId: rows.map((row) => String(row.garmentId)),
        lock: rows.map(() => ''),
      }),
    });

  const lookRows = () => [
    { role: 'top', garmentId: top },
    { role: 'bottom', garmentId: bottom },
    { role: 'footwear', garmentId: shoes },
  ];
  const look = () => [top, bottom, shoes];

  beforeAll(async () => {
    t = await createTestApp();
    token = await createAccessToken(t);
    top = await garmentIn('Linen shirt', 'tops', 'white');
    bottom = await garmentIn('Navy chinos', 'bottoms', 'blue');
    shoes = await garmentIn('Loafers', 'footwear', 'brown');
  });

  afterAll(() => t?.cleanup());

  // Every case starts without outfits or batches, the closet whole (a
  // plain delete is fine: nothing here is worn history).
  beforeEach(async () => {
    await asFixture(t.db, (tx) => tx.delete(outfit));
    await asFixture(t.db, (tx) => tx.delete(weekPlan));
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ status: 'closet' })
        .where(eq(garment.ownerId, t.owner.id)),
    );
  });

  describe('one outfit per garment set, whichever save commits first', () => {
    it("the outfit form's Save that waited on a pick of the same garments reuses its outfit", async () => {
      const [picked, saved] = await interleave(
        t.db,
        (tx) =>
          pickIdea(tx, t.owner.id, {
            garmentIds: look(),
            origin: 'person',
            madeBy: BY_PERSON,
          }),
        () => formSave(look(), { name: 'Friday' }),
      );
      if (picked === 'not-found') throw new Error('the pick was refused');
      expect(saved.statusCode).toBe(302);
      expect(saved.headers.location).toBe(
        `/outfits/${picked.id}?alreadySaved=1`,
      );
      expect(await outfits()).toEqual([{ id: picked.id, name: picked.name }]);
    });

    it('a pick that waited on the outfit form’s Save finds its outfit', async () => {
      const [created, picked] = await interleave(
        t.db,
        (tx) =>
          createOutfit(tx, t.owner.id, {
            name: 'Friday',
            slots: look().map((garmentId) => ({ category: 'tops', garmentId })),
            origin: 'person',
            madeBy: BY_PERSON,
          }),
        () =>
          pickIdea(t.db, t.owner.id, {
            garmentIds: look(),
            origin: 'person',
            madeBy: BY_PERSON,
          }),
      );
      expect(created.alreadySaved).toBe(false);
      expect(picked).toMatchObject({
        id: created.id,
        name: 'Friday',
        alreadySaved: true,
      });
      expect(await outfits()).toHaveLength(1);
    });

    it('Styling’s Save that waited on a pick lands on the same outfit, “Already saved”', async () => {
      const [picked, saved] = await interleave(
        t.db,
        (tx) =>
          pickIdea(tx, t.owner.id, {
            garmentIds: look(),
            origin: 'person',
            madeBy: BY_PERSON,
          }),
        () => stylingSave(lookRows(), { name: 'Mine' }),
      );
      if (picked === 'not-found') throw new Error('the pick was refused');
      expect(saved.statusCode).toBe(303);
      expect(saved.headers.location).toBe(
        `/outfits/${picked.id}?alreadySaved=1`,
      );
      expect(await outfits()).toHaveLength(1);
    });

    it('create_outfit that waited on a pick answers the pick’s outfit, alreadySaved', async () => {
      const [picked, created] = await interleave(
        t.db,
        (tx) =>
          pickIdea(tx, t.owner.id, {
            garmentIds: look(),
            origin: 'person',
            madeBy: BY_PERSON,
          }),
        () =>
          tool<{ id: number; alreadySaved: boolean }>(
            t,
            token,
            'create_outfit',
            { garmentIds: look(), name: 'Agent’s' },
          ),
      );
      if (picked === 'not-found') throw new Error('the pick was refused');
      expect(created).toMatchObject({ id: picked.id, alreadySaved: true });
      expect(await outfits()).toHaveLength(1);
    });

    it('the week planner’s pick that waited on a person’s save plans that outfit, still the person’s', async () => {
      const day = addDays(t.today(), 1);
      const [created, planned] = await interleave(
        t.db,
        (tx) =>
          createOutfit(tx, t.owner.id, {
            name: 'Friday',
            slots: look().map((garmentId) => ({ category: 'tops', garmentId })),
            origin: 'person',
            madeBy: BY_PERSON,
          }),
        // As "Plan my week" writes: under the owner lock, which it waits on.
        () =>
          ownerTransaction(t.db, t.owner.id, 'planMyWeek', async (tx) => {
            const weekPlanId = await createWeekPlan(tx, t.owner.id);
            const picked = await pickIdea(tx, t.owner.id, {
              garmentIds: look(),
              plan: { day, occasion: 'all-day' },
              origin: 'planner',
              madeBy: BY_PERSON,
            });
            if (picked === 'not-found') throw new Error('refused');
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
            return picked;
          }),
      );
      expect(planned).toMatchObject({
        id: created.id,
        alreadySaved: true,
        adopted: false,
      });
      expect(await outfits()).toHaveLength(1);
    });

    it('a save of the same garments later reuses the outfit, and a person’s save takes a planner-made one over', async () => {
      const day = addDays(t.today(), 2);
      const planned = await pickIdea(t.db, t.owner.id, {
        garmentIds: look(),
        plan: { day, occasion: 'all-day' },
        origin: 'planner',
        madeBy: BY_PERSON,
      });
      if (planned === 'not-found') throw new Error('refused');
      // The planner made it: a batch row says it created the outfit.
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, planned.id));
      await asFixture(t.db, async (tx) =>
        recordAutoEntry(tx, {
          entryId: entry.id,
          weekPlanId: await createWeekPlan(tx, t.owner.id),
          outfitCreated: true,
          needs: null,
        }),
      );
      const res = await formSave([shoes, top, bottom], {
        name: 'Renamed?',
        notes: 'ignored',
      });
      expect(res.headers.location).toBe(
        `/outfits/${planned.id}?alreadySaved=1`,
      );
      // Its own name stays; nothing new; the planner no longer owns it.
      expect(await outfits()).toEqual([{ id: planned.id, name: planned.name }]);
      const [batchRow] = await t.db
        .select({ outfitCreated: weekPlanEntry.outfitCreated })
        .from(weekPlanEntry)
        .where(eq(weekPlanEntry.entryId, entry.id));
      expect(batchRow.outfitCreated).toBe(false);
      expect(
        t.logs
          .messages('info', 'Web')
          .some((line) =>
            line.includes(
              `its garments are already outfit ${planned.id}, nothing created`,
            ),
          ),
      ).toBe(true);
    });
  });

  describe('a save never drops a garment it cannot hold', () => {
    it('Styling’s Save with an archived garment is a 409 naming it, the page kept', async () => {
      await setGarmentStatus(t.db, top, t.owner.id, { event: 'archive' });
      const res = await stylingSave(lookRows(), {
        name: 'Office Friday',
        scheduleDate: addDays(t.today(), 3),
        scheduleOccasion: 'work',
      });
      expect(res.statusCode).toBe(409);
      expect(hasText(res.body, 'Not saved: Linen shirt is archived.')).toBe(
        true,
      );
      expect(res.body).toContain('data-styling-refused');
      // The sheet as posted: the name, the day and the occasion.
      expect(res.body).toContain('value="Office Friday"');
      expect(res.body).toContain(`value="${addDays(t.today(), 3)}"`);
      expect(res.body).toMatch(/<option value="work" selected/);
      // The other rows keep their garments; the archived one's is None.
      expect(res.body).toContain(`name="garmentId" value="${bottom}"`);
      expect(res.body).not.toContain(`name="garmentId" value="${top}"`);
      expect(await outfits()).toEqual([]);
    });

    it('Styling’s Save with a deleted garment says it is gone (404, as any id not yours), the page kept', async () => {
      const doomed = await garmentIn('Old tee', 'tops', 'grey');
      await deleteGarment(t.db, doomed, t.owner.id);
      const res = await stylingSave([
        { role: 'top', garmentId: doomed },
        { role: 'bottom', garmentId: bottom },
      ]);
      expect(res.statusCode).toBe(404);
      expect(
        hasText(
          res.body,
          'Not saved: a garment you chose is no longer in your wardrobe.',
        ),
      ).toBe(true);
      expect(res.body).toContain('id="styling-form"');
      expect(await outfits()).toEqual([]);
    });

    it('Styling’s change of a saved outfit keeps an archived garment and refuses a deleted one', async () => {
      const saved = await createOutfit(t.db, t.owner.id, {
        name: 'Kept',
        slots: look().map((garmentId) => ({ category: 'tops', garmentId })),
        origin: 'person',
        madeBy: BY_PERSON,
      });
      await setGarmentStatus(t.db, shoes, t.owner.id, { event: 'archive' });
      const kept = await stylingSave(lookRows(), { outfit: String(saved.id) });
      expect(kept.statusCode).toBe(303);
      expect(await slotsOf(saved.id)).toEqual([top, bottom, shoes]);

      const doomed = await garmentIn('Old belt', 'accessories', 'brown');
      await deleteGarment(t.db, doomed, t.owner.id);
      const refused = await stylingSave(
        [...lookRows(), { role: 'accessory', garmentId: doomed }],
        { outfit: String(saved.id) },
      );
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toContain(`data-styling-outfit="${saved.id}"`);
      expect(await slotsOf(saved.id)).toEqual([top, bottom, shoes]);
    });

    it('the outfit form refuses a garment that is not the owner’s instead of saving an empty slot', async () => {
      const doomed = await garmentIn('Old scarf', 'accessories', 'red');
      await deleteGarment(t.db, doomed, t.owner.id);
      const res = await formSave([top, doomed], { name: 'Half' });
      expect(res.statusCode).toBe(404);
      expect(
        hasText(
          res.body,
          'Not saved: a garment you chose is no longer in your wardrobe.',
        ),
      ).toBe(true);
      expect(await outfits()).toEqual([]);
    });

    it('a replace with an idea holding an archived garment throws the named 409, every caller’s', async () => {
      const day = addDays(t.today(), 4);
      const planned = await createOutfit(t.db, t.owner.id, {
        name: 'On the day',
        slots: [{ category: 'bottoms', garmentId: bottom }],
        plan: { day, occasion: 'work' },
        origin: 'person',
        madeBy: BY_PERSON,
      });
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, planned.id));
      await setGarmentStatus(t.db, top, t.owner.id, { event: 'archive' });
      const target = { entryId: entry.id, day, occasion: 'work' as const };
      const actor = { userId: t.owner.id, surface: 'page' as const };
      const refusal: unknown = await replaceEntryOutfit(
        { db: t.db, logger: t.logger },
        actor,
        target,
        {
          garmentIds: look(),
          origin: 'idea',
        },
        BY_PERSON,
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(OutfitGarmentsGone);
      expect(refusal).toMatchObject({
        statusCode: 409,
        message: 'Not saved: Linen shirt is archived.',
        gone: [
          { id: top, garment: { name: 'Linen shirt', status: 'archived' } },
        ],
      });
      // A garment not theirs stays the unnamed 404.
      await expect(
        replaceEntryOutfit(
          { db: t.db, logger: t.logger },
          actor,
          target,
          {
            garmentIds: [bottom, 2147483000],
            origin: 'idea',
          },
          BY_PERSON,
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        message:
          'Not saved: a garment you chose is no longer in your wardrobe.',
      });
      // Nothing changed: the entry keeps its outfit, no outfit was made.
      expect(await outfits()).toEqual([{ id: planned.id, name: 'On the day' }]);
    });

    it('create_outfit and pick_outfit refuse the same way, naming what they can', async () => {
      // A pick wears what is in the closet: a wishlist item is named. (A
      // slot write holds one, incomplete: incomplete-outfits.spec.ts.)
      const wish = await createWishlistItem(t, { name: 'Silk scarf' });
      const wished = await callTool(t, token, 'pick_outfit', {
        garmentIds: [top, wish],
      });
      expect(wished).toEqual({
        isError: true,
        value: {
          error: 'Not saved: Silk scarf is on your wishlist, not bought yet.',
        },
      });
      const foreign = await callTool(t, token, 'create_outfit', {
        garmentIds: [top, 2147483000],
      });
      expect(foreign).toEqual({
        isError: true,
        value: {
          error:
            'Not saved: a garment you chose is no longer in your wardrobe.',
        },
      });
      await setGarmentStatus(t.db, bottom, t.owner.id, { event: 'archive' });
      const archived = await callTool(t, token, 'pick_outfit', {
        garmentIds: look(),
      });
      expect(archived).toEqual({
        isError: true,
        value: { error: 'Not saved: Navy chinos is archived.' },
      });
      expect(await outfits()).toEqual([]);
    });

    it('a save that waited on a delete of its garment is refused whole, not saved without it', async () => {
      const doomed = await garmentIn('Old cardigan', 'layers', 'grey');
      const [deleted, res] = await interleave(
        t.db,
        (tx) => deleteGarment(tx, doomed, t.owner.id),
        () => formSave([doomed, bottom], { name: 'Raced' }),
      );
      // Deleted (it had no photo).
      expect(deleted).toEqual({ ok: true, status: 'closet', photo: null });
      expect(res.statusCode).toBe(404);
      expect(
        hasText(
          res.body,
          'Not saved: a garment you chose is no longer in your wardrobe.',
        ),
      ).toBe(true);
      expect(await outfits()).toEqual([]);
    });

    it('a change of a saved outfit that waited on a delete of its garment keeps the outfit as it was', async () => {
      const doomed = await garmentIn('Old watch', 'accessories', 'silver');
      const saved = await createOutfit(t.db, t.owner.id, {
        name: 'Watch',
        slots: [top, bottom].map((garmentId) => ({
          category: 'tops',
          garmentId,
        })),
        origin: 'person',
        madeBy: BY_PERSON,
      });
      const [, res] = await interleave(
        t.db,
        (tx) => deleteGarment(tx, doomed, t.owner.id),
        () =>
          t.inject({
            method: 'POST',
            url: `/outfits/${saved.id}`,
            ...form({
              category: ['tops', 'bottoms', 'accessories'],
              garmentId: [top, bottom, doomed].map(String),
            }),
          }),
      );
      expect(res.statusCode).toBe(404);
      expect(await slotsOf(saved.id)).toEqual([top, bottom]);
    });
  });
});
