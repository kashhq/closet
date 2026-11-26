import { asc, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bodyMeasurements,
  brandSize,
  capsule,
  capsuleGarment,
  file,
  garment,
  garmentWear,
  generatorAvoid,
  outfit,
  outfitCalendar,
  outfitSlot,
  selfie,
  styleProfile,
  trip,
  tripGarmentPacked,
  tripItem,
  tripOutfit,
  user,
  userWeather,
  wardrobeShare,
  weekPlan,
  weekTemplate,
} from '../../src/db/schema';
import { dayOfWeek } from '../../src/calendar-date';
import { weeklyRhythm } from '../../src/wardrobe/week';
import { findWeekTemplate } from '../../src/web/week-plan/template';
import { selectScalars } from '../../src/db/select-scalars';
import { styleProfileSql } from '../../src/web/style/queries';
import { brandSizesOf, findMeasurements } from '../../src/web/sizes/queries';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import { variantFileName } from '../../src/web/files/image-variant';
import { loadPersona } from '../../src/seed/persona';
import { runSeed, seedPersona } from '../../src/seed/seed';
import { countToTag } from '../../src/web/wardrobe/queries';
import { countNeedingWash, laundryList } from '../../src/web/wears/queries';
import {
  createTestApp,
  extractImgSrcs,
  OWNER_EMAIL,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { dayColumns } from './calendar-page';

/**
 * `npm run seed`, run as the CLI runs it (runSeed) against the real app's
 * database and storage: the personas are written through the app's own
 * writers, so the pages show them, and seeding is idempotent, rebuildable
 * and removable without leftovers.
 */
describe('seed personas', () => {
  let t: TestApp;
  const PASSWORD = 'Closet-demo-1';
  const ANCHOR = '2026-09-26';
  const EMAILS = ['demo', 'fresh', 'sparse'].map((p) => `${p}@closet.invalid`);

  const run = async (args: string[], stdin = `${PASSWORD}\n`) => {
    const output = new PassThrough();
    const errors = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    errors.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const status = await runSeed({
      args,
      db: t.db,
      photos: t.photos,
      logger: t.logger,
      timeZone: 'America/New_York',
      weatherEnabled: true,
      input: Readable.from([stdin]),
      output,
      errors,
      now: new Date('2026-09-26T16:00:00Z'),
    });
    return { status, stdout, stderr };
  };

  const seedAll = (...extra: string[]) =>
    run(['--persona', 'all', '--anchor', ANCHOR, '--password-stdin', ...extra]);

  const personaIds = async () =>
    (
      await t.db
        .select({ id: user.id })
        .from(user)
        .where(inArray(user.email, EMAILS))
    ).map((row) => row.id);

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();

  const sha = async (name: string) =>
    createHash('sha256')
      .update(await readFile(join(t.dataPath, name)))
      .digest('hex');

  // Differ between runs by design: ids, UUIDs, the photo row's id, when
  // the sync triggers last stamped it.
  const VARYING = [
    'id',
    'shareableId',
    'photoId',
    'ownerId',
    'replacesGarmentId',
    'updatedAt',
  ] as const;

  /**
   * What a persona is, without what differs between runs by design (row
   * ids, UUIDs, file names): every garment field and its cutout's bytes,
   * outfits with their slots, capsules with their garments, the calendar,
   * the wears, shares.
   */
  const snapshot = async (email: string) => {
    const id = await userIdOf(t, email);
    const garments = await t.db
      .select({ garment, fileName: file.fileName, cutout: file.cutoutStatus })
      .from(garment)
      .leftJoin(file, eq(file.id, garment.photoId))
      .where(eq(garment.ownerId, id))
      .orderBy(asc(garment.id));
    const ids = new Map(garments.map((g) => [g.garment.id, g.garment.name]));
    const outfits = await t.db.query.outfit.findMany({
      where: eq(outfit.ownerId, id),
      orderBy: asc(outfit.id),
      with: { slots: { orderBy: asc(outfitSlot.position) } },
    });
    const names = new Map(outfits.map((o) => [o.id, o.name]));
    const capsules = await t.db.query.capsule.findMany({
      where: eq(capsule.ownerId, id),
      orderBy: asc(capsule.id),
      with: { garments: { orderBy: asc(capsuleGarment.garmentId) } },
    });
    const calendar = await t.db
      .select()
      .from(outfitCalendar)
      .where(eq(outfitCalendar.ownerId, id))
      .orderBy(asc(outfitCalendar.day), asc(outfitCalendar.id));
    const wears = await t.db
      .select({ garmentId: garmentWear.garmentId, day: garmentWear.day })
      .from(garmentWear)
      .where(eq(garmentWear.ownerId, id))
      .orderBy(asc(garmentWear.day), asc(garmentWear.garmentId));
    const avoided = await t.db
      .select({ a: generatorAvoid.garmentAId, b: generatorAvoid.garmentBId })
      .from(generatorAvoid)
      .where(eq(generatorAvoid.ownerId, id));
    const selfies = await t.db
      .select({
        day: selfie.day,
        outfitId: outfitCalendar.outfitId,
        fileName: file.fileName,
        cutout: file.cutoutStatus,
      })
      .from(selfie)
      .innerJoin(outfitCalendar, eq(outfitCalendar.id, selfie.outfitCalendarId))
      .innerJoin(file, eq(file.id, selfie.photoId))
      .where(eq(selfie.ownerId, id))
      .orderBy(asc(selfie.day), asc(selfie.id));
    const trips = await t.db.query.trip.findMany({
      where: eq(trip.ownerId, id),
      orderBy: asc(trip.id),
      with: {
        outfits: { orderBy: [asc(tripOutfit.day), asc(tripOutfit.id)] },
        items: { orderBy: asc(tripItem.id) },
      },
    });
    const packed = await t.db
      .select({
        tripId: tripGarmentPacked.tripId,
        id: tripGarmentPacked.garmentId,
      })
      .from(tripGarmentPacked)
      .innerJoin(trip, eq(trip.id, tripGarmentPacked.tripId))
      .where(eq(trip.ownerId, id));
    const shares = await t.db
      .select({
        grantee: wardrobeShare.granteeId,
        permission: wardrobeShare.permission,
      })
      .from(wardrobeShare)
      .where(eq(wardrobeShare.grantorId, id));
    return {
      garments: await Promise.all(
        garments.map(async ({ garment: g, fileName, cutout }) => {
          const fields: Partial<typeof g> = { ...g };
          for (const key of VARYING) delete fields[key];
          return {
            ...fields,
            // The replaced garment by name: its id differs between runs.
            replaces:
              g.replacesGarmentId === null
                ? null
                : ids.get(g.replacesGarmentId),
            cutout,
            nobg: fileName && (await sha(variantFileName(fileName, 'nobg'))),
          };
        }),
      ),
      outfits: outfits.map((o) => ({
        name: o.name,
        slots: o.slots.map((s) => [
          s.category,
          s.garmentId && ids.get(s.garmentId),
        ]),
      })),
      capsules: capsules.map((c) => ({
        name: c.name,
        notes: c.notes,
        garments: c.garments.map((g) => ids.get(g.garmentId)),
      })),
      calendar: calendar.map((c) => ({
        day: c.day,
        occasion: c.occasion,
        outfit: names.get(c.outfitId),
        wornAt: c.wornAt?.toISOString() ?? null,
        plannedBy: c.plannedBy,
      })),
      weekTemplate: await findWeekTemplate(t.db, id),
      wears: wears.map((w) => [ids.get(w.garmentId), w.day]),
      // Outfit selfies (#19): the day, the outfit and the photo's bytes.
      selfies: await Promise.all(
        selfies.map(async (s) => ({
          day: s.day,
          outfit: names.get(s.outfitId),
          cutout: s.cutout,
          photo: await sha(s.fileName),
        })),
      ),
      styleProfile: (
        await selectScalars(t.db, { profile: styleProfileSql(id) })
      ).profile,
      // Sizes (#24): the brands without their ids, which differ between runs.
      sizes: {
        ...(await findMeasurements(t.db, id)),
        brands: (await brandSizesOf(t.db, id)).map(({ brand, size, note }) => ({
          brand,
          size,
          note,
        })),
      },
      // By name, each pair and the list sorted: ids differ between runs.
      avoided: avoided
        .map(({ a, b }) => [ids.get(a), ids.get(b)].sort())
        .sort(),
      // Trips (#10): by name, ids differ between runs.
      trips: trips.map((row) => ({
        name: row.name,
        destination: row.destination,
        located: row.latitude !== null,
        startsOn: row.startsOn,
        endsOn: row.endsOn,
        outfits: row.outfits.map((o) => [
          names.get(o.outfitId),
          o.day,
          o.occasion,
        ]),
        extras: row.items.map((item) => [item.label, item.packed]),
        packed: packed
          .filter((p) => p.tripId === row.id)
          .map((p) => ids.get(p.id))
          .sort(),
      })),
      shares: shares.length,
    };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('seeds every persona through the app, prints the logins once, and a second run changes nothing', async () => {
    const first = await seedAll();
    expect(first).toMatchObject({ status: 0, stderr: '' });
    expect(first.stdout).toContain(
      'demo: seeded 83 garments, 3 wishlist items, 86 photos, 26 outfits, 4 capsules,',
    );
    expect(first.stdout).toContain(
      `Sign in as demo@closet.invalid with ${PASSWORD}`,
    );
    expect(first.stdout).toContain(
      'fresh: seeded 0 garments, 0 wishlist items, 0 photos, 0 outfits, 0 capsules',
    );
    expect(first.stdout).toContain(
      'sparse: seeded 12 garments, 0 wishlist items, 8 photos, 1 outfits, 0 capsules',
    );

    const demo = await snapshot(EMAILS[0]);
    const withStatus = (status: string) =>
      demo.garments.filter((g) => g.status === status).map((g) => g.name);
    expect(withStatus('archived')).toHaveLength(3);
    expect(withStatus('closet')).toHaveLength(80);
    // Theo's Next buys (#18): on the wishlist, never worn, in no outfit or
    // capsule; the new merino replaces the pilling one.
    expect(withStatus('wishlist')).toEqual([
      'New grey merino crewneck',
      'Padded shirt jacket',
      'White Couriers',
    ]);
    const merino = demo.garments.find(
      (g) => g.name === 'New grey merino crewneck',
    )!;
    expect(merino).toMatchObject({
      replaces: 'Grey merino crewneck',
      price: '49.90',
      acquiredOn: null,
      sourceUrl: 'https://www.uniqlo.com/us/en/products/E450535-000/00',
    });
    const wishlisted = new Set(withStatus('wishlist'));
    expect(demo.wears.some(([name]) => wishlisted.has(name as string))).toBe(
      false,
    );
    expect(
      demo.outfits.some((o) =>
        o.slots.some(([, name]) => wishlisted.has(name as string)),
      ),
    ).toBe(false);
    // His Clashes (#9): the gallery never pairs them.
    expect(demo.avoided).toEqual([
      ['Denim jacket', 'Western denim shirt'],
      ['Olive chinos', 'Olive chore coat'],
    ]);
    // The art is its own cutout: nothing waits in the background-removal queue.
    expect(new Set(demo.garments.map((g) => g.cutout))).toEqual(
      new Set(['ready']),
    );
    const jeans = demo.garments.find((g) => g.name === 'Raw selvedge jeans')!;
    expect(jeans).toMatchObject({
      brand: 'The Unbranded Brand',
      type: 'jeans',
      warmth: 4,
      fabricWeight: 492,
      price: '112.00',
      acquiredOn: '2026-05-02',
      sourceUrl: expect.stringMatching(/^https:\/\/theunbrandedbrand\.com\//),
    });
    // His weather home (#14), rounded as the app stores every location;
    // Riley and Dana have none.
    expect(
      await t.db
        .select({
          userId: userWeather.userId,
          homeName: userWeather.homeName,
          homeLatitude: userWeather.homeLatitude,
          homeLongitude: userWeather.homeLongitude,
          temperatureUnit: userWeather.temperatureUnit,
        })
        .from(userWeather),
    ).toEqual([
      {
        userId: await userIdOf(t, EMAILS[0]),
        homeName: 'Fort Greene, Brooklyn',
        homeLatitude: 40.69,
        homeLongitude: -73.98,
        temperatureUnit: 'fahrenheit',
      },
    ]);
    const worn = demo.calendar.filter((entry) => entry.wornAt);
    expect(worn.length).toBeGreaterThan(60);
    // Worn that evening in New York; the planned week after the anchor is not.
    expect(worn.find((entry) => entry.day === '2026-08-29')).toEqual({
      day: '2026-08-29',
      occasion: 'all-day',
      outfit: 'Wedding',
      wornAt: '2026-08-30T01:00:00.000Z',
      plannedBy: 'user',
    });
    // Occasions (#13): a Thursday of a morning run, the office and drinks
    // after, stacked on the calendar in occasion order.
    expect(
      demo.calendar
        .filter((entry) => entry.day === '2026-08-13')
        .map((entry) => [entry.occasion, entry.outfit]),
    ).toEqual([
      ['workout', 'Run'],
      ['work', 'Sweater-polo office'],
      ['night-out', 'Rooftop drinks'],
    ]);
    expect(
      demo.calendar.filter((entry) => entry.occasion === 'workout').length,
    ).toBeGreaterThan(20);
    expect(
      demo.calendar
        .filter((entry) => entry.day > ANCHOR)
        .every((entry) => entry.wornAt === null),
    ).toBe(true);
    // Theo's capsules, from the bible's table; Weekend keeps the archived
    // 511s it held before the archive.
    expect(demo.capsules.map((c) => [c.name, c.garments.length])).toEqual([
      ['Office', 29],
      ['Weekend', 23],
      ['Date night', 18],
      ['Travel', 16],
    ]);
    expect(demo.capsules[1].garments).toContain('Old 511s');
    // Fully tagged, the socks too (#685): typed, never drawn into an idea.
    const demoId = await userIdOf(t, EMAILS[0]);
    expect(await countToTag(t.db, demoId)).toBe(0);

    // Wears and washes (#7): every worn entry's garments, the laundry
    // Sundays, the bible's multiples, condition and away.
    const byName = (name: string) =>
      demo.garments.find((g) => g.name === name)!;
    expect(demo.wears.length).toBeGreaterThan(250);
    // Each wear is a worn entry's day.
    const wornDays = new Set(worn.map((entry) => entry.day));
    expect(demo.wears.every(([, day]) => wornDays.has(day as string))).toBe(
      true,
    );
    expect(byName('White tee')).toMatchObject({
      quantity: 3,
      lastWashedOn: '2026-09-20',
    });
    expect(byName('Black socks')).toMatchObject({
      type: 'socks',
      quantity: 6,
      washAfterWears: 1,
    });
    // The raw denim is never washed, shoes are never laundered.
    expect(byName('Raw selvedge jeans')).toMatchObject({
      washAfterWears: 0,
      lastWashedOn: null,
    });
    expect(byName('White sneakers').lastWashedOn).toBeNull();
    expect(byName('Duffel')).toMatchObject({
      away: 'lent',
      awayNote: expect.stringMatching(/Dana/),
    });
    expect(byName('Bean Boots').away).toBe('repair');
    expect(byName('Grey merino crewneck')).toMatchObject({
      condition: 'replace_soon',
      conditionNote: expect.stringMatching(/Pilling/),
    });
    expect(byName('501s').condition).toBe('needs_repair');
    // Seeded on a Saturday: the week's wears are in the hamper.
    expect(await countNeedingWash(t.db, demoId)).toBeGreaterThan(0);
    expect((await laundryList(t.db, demoId)).length).toBeGreaterThan(3);
    // Dana logged nothing: nothing to wash.
    expect(await laundryList(t.db, await userIdOf(t, EMAILS[2]))).toEqual([]);
    // Dana's wardrobe is shared with Theo, MANAGE.
    expect((await snapshot(EMAILS[2])).shares).toBe(1);

    // The style profile (#34): Theo's, from the bible's table; Riley and
    // Dana have none.
    expect(demo.styleProfile).toMatchObject({
      styles: ['elevated-basics', 'smart-casual', 'outdoor-technical'],
      budget: 'mid',
    });
    // His week template (#16) is the bible's week table, and "Plan my week"
    // planned the week after the anchor: the template's slots are auto,
    // the evenings he plans himself are his.
    expect(weeklyRhythm(demo.weekTemplate)).toEqual([
      { occasion: 'all-day', perWeek: 4 },
      { occasion: 'workout', perWeek: 3 },
      { occasion: 'work', perWeek: 3 },
    ]);
    const plannedWeek = demo.calendar.filter((entry) => entry.day > ANCHOR);
    const auto = plannedWeek.filter((entry) => entry.plannedBy === 'auto');
    expect(auto.length).toBeGreaterThanOrEqual(8);
    expect(
      auto.every((entry) =>
        demo.weekTemplate.some(
          (slot) =>
            slot.weekday === dayOfWeek(entry.day) &&
            slot.occasion === entry.occasion,
        ),
      ),
    ).toBe(true);
    expect(
      plannedWeek
        .filter((entry) => entry.plannedBy === 'user')
        .every((entry) => ['evening', 'night-out'].includes(entry.occasion)),
    ).toBe(true);
    // No outfit twice in the planned week.
    expect(new Set(auto.map((entry) => entry.outfit)).size).toBe(auto.length);
    expect(
      demo.calendar
        .filter((entry) => entry.day <= ANCHOR)
        .every((entry) => entry.plannedBy === 'user'),
    ).toBe(true);
    // His sizes (#24): the His sizes tables, in inches.
    expect(demo.sizes).toMatchObject({
      unit: 'in',
      lengths: { waist: 81.28, inseam: 81.28, height: 177.8 },
    });
    expect(demo.sizes.brands).toHaveLength(8);
    expect(demo.sizes.brands).toContainEqual({
      brand: 'Allbirds',
      size: '10',
      note: 'Whole sizes only; true to size.',
    });
    for (const email of [EMAILS[1], EMAILS[2]]) {
      expect(await snapshot(email)).toMatchObject({
        styleProfile: null,
        trips: [],
        sizes: { unit: 'in', lengths: { waist: null }, brands: [] },
      });
    }
    // His Austin conference (#10), from the bible's Trips tables: partly
    // packed, the destination located (the seed runs with weather on).
    expect(demo.trips).toEqual([
      {
        name: 'Austin conference',
        destination: 'Austin, Texas, United States',
        located: true,
        startsOn: '2026-08-19',
        endsOn: '2026-08-21',
        outfits: [
          ['Conference travel', '2026-08-19', 'all-day'],
          ['Run', '2026-08-20', 'workout'],
          ['Sweater-polo office', '2026-08-20', 'work'],
          ['Rooftop drinks', '2026-08-20', 'evening'],
          ['Conference travel', '2026-08-21', 'all-day'],
        ],
        extras: [
          ['Laptop and charger', true],
          ['Phone charger', true],
          ['Toiletry kit', true],
          ['Conference badge', false],
          ['Sunscreen', false],
        ],
        packed: expect.arrayContaining([
          'Charcoal heavyweight tee',
          'Olive chinos',
          'Running tee',
        ]),
      },
    ]);
    expect(demo.trips[0].packed).toHaveLength(9);

    const files = await storedFiles();
    const again = await seedAll();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('demo: already seeded');
    expect(again.stdout).not.toContain(PASSWORD);
    expect(await storedFiles()).toEqual(files);
    expect(await snapshot(EMAILS[0])).toEqual(demo);
  });

  it('shows the seeded wardrobe, outfits and calendar on the app pages', async () => {
    const cookie = await t.login(EMAILS[0], PASSWORD);
    const grid = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie },
    });
    expect(grid.statusCode).toBe(200);
    expect(grid.body).toContain('Olive chore coat');
    // Nothing left to tag: no "to tag" chip (#685).
    expect(grid.body).not.toContain('to tag');
    const thumb = extractImgSrcs(unescapeHtml(grid.body)).find((src) =>
      src.startsWith('/file/'),
    )!;
    const image = await t.inject({
      method: 'GET',
      url: thumb,
      headers: { cookie },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');

    const week = await t.inject({
      method: 'GET',
      url: '/calendar?week=2026-08-23',
      headers: { cookie },
    });
    expect(week.body).toContain('Wedding');
    const threeOutfits = await t.inject({
      method: 'GET',
      url: '/calendar?week=2026-08-09',
      headers: { cookie },
    });
    const thursday = dayColumns(threeOutfits.body).get('2026-08-13')!;
    expect(
      [...thursday.matchAll(/data-occasion="([a-z-]+)"/g)].map((m) => m[1]),
    ).toEqual(['workout', 'work', 'night-out']);

    // His recent evenings out carry a mirror selfie (#19): on the week, on
    // the outfit's Worn strip, served to him through /selfies/ only.
    const [look] = await t.db
      .select({ day: selfie.day, outfitId: outfitCalendar.outfitId })
      .from(selfie)
      .innerJoin(outfitCalendar, eq(outfitCalendar.id, selfie.outfitCalendarId))
      .where(eq(selfie.ownerId, await userIdOf(t, EMAILS[0])))
      .orderBy(asc(selfie.day))
      .limit(1);
    const selfieThumb = (html: string) =>
      extractImgSrcs(unescapeHtml(html)).find((src) =>
        src.startsWith('/selfies/thumb/'),
      );
    const lookWeek = await t.inject({
      method: 'GET',
      url: `/calendar?week=${look.day}`,
      headers: { cookie },
    });
    expect(selfieThumb(lookWeek.body)).toBeDefined();
    const lookOutfit = await t.inject({
      method: 'GET',
      url: `/outfits/${look.outfitId}`,
      headers: { cookie },
    });
    expect(lookOutfit.body).toContain('data-worn-strip');
    const lookImage = await t.inject({
      method: 'GET',
      url: selfieThumb(lookOutfit.body)!,
      headers: { cookie },
    });
    expect(lookImage.statusCode).toBe(200);
    expect(lookImage.headers['content-type']).toBe('image/webp');

    // Theo manages his sister's wardrobe through her share: tagging included.
    const sparseId = await userIdOf(t, EMAILS[2]);
    const tag = await t.inject({
      method: 'GET',
      url: `/wardrobe/tag?ownerId=${sparseId}`,
      headers: { cookie },
    });
    expect(tag.statusCode).toBe(200);
  });

  it("shows Theo's size in each wishlist item's brand, and his sizes on Profile › Sizes (#24)", async () => {
    const cookie = await t.login(EMAILS[0], PASSWORD);
    const wishlist = await t.inject({
      method: 'GET',
      url: '/wardrobe/wishlist',
      headers: { cookie },
    });
    expect(wishlist.body).toContain('Your size in Uniqlo: Medium');
    expect(wishlist.body).toContain('Your size in Allbirds: 10');
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile/sizes',
      headers: { cookie },
    });
    expect(profile.body).toMatch(/name="waist" value="32"/);
    // Dana's wardrobe, which he manages: no note of his.
    const dana = await userIdOf(t, EMAILS[2]);
    const danaForm = await t.inject({
      method: 'GET',
      url: `/wardrobe/new?ownerId=${dana}`,
      headers: { cookie },
    });
    expect(danaForm.statusCode).toBe(200);
    expect(danaForm.body).not.toContain('brand-size-hint');
  });

  it("opens Theo's Today at the anchor half lived: the date planned tonight, ideas for the day (#15)", async () => {
    // The anchor's afternoon, as the seed ran it.
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-09-26T16:00:00Z'),
    });
    try {
      const cookie = await t.login(EMAILS[0], PASSWORD);
      const today = unescapeHtml(
        (await t.inject({ method: 'GET', url: '/', headers: { cookie } })).body,
      );
      expect(
        [
          ...today.matchAll(/data-today-row="(\w+)" data-occasion="([\w-]+)"/g),
        ].map((m) => [m[1], m[2]]),
      ).toEqual([
        ['ideas', 'all-day'],
        ['planned', 'evening'],
      ]);
      expect(today).toContain('Summer date');
      expect(today.match(/data-idea="/g)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('--reset rebuilds the same persona', async () => {
    const before = await snapshot(EMAILS[0]);
    const reset = await run([
      '--persona',
      'demo',
      '--reset',
      '--anchor',
      ANCHOR,
      '--password-stdin',
    ]);
    expect(reset.status).toBe(0);
    expect(reset.stdout).toContain('demo: removed');
    expect(reset.stdout).toContain('demo: seeded');
    expect(await snapshot(EMAILS[0])).toEqual(before);
    // The share from sparse came back with the new demo account.
    expect((await snapshot(EMAILS[2])).shares).toBe(1);
  });

  it('checks every input before --reset deletes anything (#119)', async () => {
    const ids = await personaIds();
    const files = await storedFiles();
    const before = await snapshot(EMAILS[0]);
    const reset = (stdin: string, ...extra: string[]) =>
      run(
        [
          '--persona',
          'demo',
          '--reset',
          '--anchor',
          ANCHOR,
          '--password-stdin',
          ...extra,
        ],
        stdin,
      );

    const weak = await reset('short\n');
    expect(weak.status).toBe(1);
    expect(weak.stderr).not.toBe('');
    expect(weak.stdout).not.toContain('demo: removed');

    const itself = await reset(`${PASSWORD}\n`, '--share-with', EMAILS[0]);
    expect(itself.status).toBe(1);
    expect(itself.stderr).toContain('cannot be shared with itself');

    expect(await personaIds()).toEqual(ids);
    expect(await storedFiles()).toEqual(files);
    expect(await snapshot(EMAILS[0])).toEqual(before);
  });

  it('--share-with gives an existing account a view of the persona, and refuses an unknown one before writing', async () => {
    const unknown = await seedAll('--share-with', 'nobody@example.com');
    expect(unknown).toMatchObject({ status: 1 });
    expect(unknown.stderr).toContain('No account uses nobody@example.com');

    const shared = await run([
      '--persona',
      'demo',
      '--share-with',
      OWNER_EMAIL,
      '--password-stdin',
    ]);
    expect(shared.stdout).toContain(`demo: shared (VIEW) with ${OWNER_EMAIL}`);
    const demoId = await userIdOf(t, EMAILS[0]);
    const theirs = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${demoId}`,
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body).toContain('Olive chore coat');
    // The owner's VIEW of Theo reaches his capsules (owner decision, #8).
    const capsules = await t.inject({
      method: 'GET',
      url: `/capsules?ownerId=${demoId}`,
    });
    expect(capsules.statusCode).toBe(200);
    for (const name of ['Office', 'Weekend', 'Date night', 'Travel']) {
      expect(capsules.body).toContain(name);
    }
    const [weekend] = await t.db
      .select({ id: capsule.id })
      .from(capsule)
      .where(eq(capsule.name, 'Weekend'));
    const page = await t.inject({
      method: 'GET',
      url: `/capsules/${weekend.id}?ownerId=${demoId}`,
    });
    expect(page.statusCode).toBe(200);
    // 22 of 23: the archived 511s keep their membership, hidden.
    expect(page.body).toContain('22 garments');
    expect(page.body).not.toContain('Old 511s');
  });

  it('rolls a persona back whole, photos included, when a write fails', async () => {
    const files = await storedFiles();
    const sparse = loadPersona('sparse');
    const broken = {
      ...sparse,
      account: { ...sparse.account, email: 'broken@closet.invalid' },
      outfits: [{ ...sparse.outfits[0], garmentIds: ['S01', 'S99'] }],
    };
    await expect(
      seedPersona(
        {
          db: t.db,
          photos: t.photos,
          logger: t.logger,
          timeZone: 'UTC',
          weatherEnabled: true,
        },
        broken,
        { anchor: ANCHOR, password: PASSWORD },
      ),
    ).rejects.toThrow();
    const [row] = await t.db
      .select()
      .from(user)
      .where(eq(user.email, 'broken@closet.invalid'));
    expect(row).toBeUndefined();
    expect(await storedFiles()).toEqual(files);
  });

  it('--remove deletes every row and photo file, and reconciliation finds nothing left', async () => {
    const removed = await run(['--persona', 'all', '--remove']);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain('demo: removed');
    expect(await personaIds()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
    expect(await t.db.$count(garment)).toBe(0);
    expect(await t.db.$count(file)).toBe(0);
    expect(await t.db.$count(capsule)).toBe(0);
    expect(await t.db.$count(capsuleGarment)).toBe(0);
    expect(await t.db.$count(garmentWear)).toBe(0);
    expect(await t.db.$count(styleProfile)).toBe(0);
    expect(await t.db.$count(brandSize)).toBe(0);
    expect(await t.db.$count(bodyMeasurements)).toBe(0);
    expect(await t.db.$count(weekTemplate)).toBe(0);
    expect(await t.db.$count(weekPlan)).toBe(0);
    expect(await t.db.$count(generatorAvoid)).toBe(0);
    expect(await t.db.$count(selfie)).toBe(0);
    const report = await reconcileStorage(
      { db: t.db, photos: t.photos, logger: t.logger, timeZone: t.timeZone },
      { dryRun: true, olderThanMs: 0 },
    );
    expect(report).toMatchObject({
      orphanedSetsQuarantined: 0,
      orphanedRowsDeleted: 0,
      missingOriginals: 0,
    });

    const again = await run(['--persona', 'demo', '--remove']);
    expect(again.stdout).toContain('demo: not seeded, nothing to remove');
  });

  it('refuses usage it does not understand', async () => {
    for (const args of [
      [],
      ['--persona', 'nobody'],
      ['--persona', 'demo', '--reset', '--remove'],
      ['--persona', 'demo', '--anchor', '2026-02-30'],
    ]) {
      expect((await run(args)).status).toBe(2);
    }
  });
});
