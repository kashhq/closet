import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  brandSize,
  optionGroup,
  outfit,
  tripItem,
  tripOutfit,
  weekPlan,
} from '../../src/db/schema';
import { GARMENT_COLORS } from '../../src/wardrobe/properties';
import { addOutfitRule } from '../../src/web/style/queries';
import { NO_MATCHER } from '../../src/web/style/validation';
import { markSuggestion } from '../../src/web/wishlist/decisions';
import { failCutout } from './cutouts';
import {
  createGarment,
  createWishlistItem,
  photoFileName,
  uploadPhoto,
} from './garments';
import { asFixture, type TestApp } from './harness';
import { addLook } from './inspiration';
import { planEntry, postSelfie, selfieOf } from './selfies';

/**
 * The rows api-statements.spec.ts's counts act on. A twin case's builder
 * (twin-statements.ts) makes one side's own set through the pages'
 * requests, so the page and its API twin each change rows no other run
 * sees.
 */

export const idIn = (res: LightMyRequestResponse, pattern: RegExp) =>
  Number(pattern.exec(res.headers.location as string)![1]);

export const garment = (
  t: TestApp,
  name: string,
  category: string,
  cookie?: string,
) => createGarment(t, { name, category, cookie });

export const newOutfit = async (t: TestApp, payload: Record<string, string>) =>
  idIn(
    await t.inject({ method: 'POST', url: '/outfits', payload }),
    /^\/outfits\/(\d+)$/,
  );

const outfitOf = (t: TestApp, garmentId: number) =>
  newOutfit(t, { category: 'shirt', garmentId: String(garmentId) });

export const newTrip = async (
  t: TestApp,
  name: string,
  startsOn: string,
  endsOn: string,
) =>
  idIn(
    await t.inject({
      method: 'POST',
      url: '/trips',
      payload: { name, startsOn, endsOn },
    }),
    /^\/trips\/(\d+)\?/,
  );

/** A garment with a photo, its cutout failed too, or neither; a repair entry logged on it through the API. */
export async function repairedGarment(
  t: TestApp,
  token: string,
  photo: Buffer,
  given?: 'photo' | 'failed',
) {
  const id = await garment(t, 'Counted', 'tops');
  if (given) await uploadPhoto(t, id, photo);
  if (given === 'failed') await failCutout(t, await photoFileName(t, id));
  const logged = await t.api(token, {
    method: 'POST',
    url: `/api/v1/garments/${id}/repairs`,
    payload: { day: t.today(), kind: 'repair', note: 'To remove' },
  });
  return { id, repairId: logged.json<{ id: number }>().id };
}

/** A loose garment (`bare`), and an outfit (`id`) holding another: Muse's proposal for `proposal`. */
export async function outfitRows(t: TestApp, given?: 'proposal') {
  const bare = await garment(t, 'Counted', 'shirt');
  const id = await outfitOf(t, await garment(t, 'Held', 'shirt'));
  if (given) {
    await asFixture(t.db, (tx) =>
      tx
        .update(outfit)
        .set({ proposedAt: new Date(), reaction: 'proposed' })
        .where(eq(outfit.id, id)),
    );
  }
  return { id, bare, day: t.today() };
}

/** An outfit planned today (`id` is its entry), an empty spare, two loose garments and an empty week plan. */
export async function calendarRows(t: TestApp) {
  const today = t.today();
  const outfitId = await outfitOf(t, await garment(t, 'Planned', 'tops'));
  const spareId = await newOutfit(t, { name: 'Spare' });
  const id = await planEntry(t, outfitId, today);
  const [plan] = await asFixture(t.db, (tx) =>
    tx
      .insert(weekPlan)
      .values({ ownerId: t.owner.id })
      .returning({ id: weekPlan.id }),
  );
  const top = await garment(t, 'Loose', 'tops');
  const bottom = await garment(t, 'Loose', 'bottoms');
  return { id, outfitId, spareId, top, bottom, planId: plan.id, today };
}

/**
 * A trip (`id`) on today and tomorrow: an outfit on it for today, its
 * garment packed, one extra; another trip with an extra to copy, and a
 * saved outfit not on the trip.
 */
export async function tripRows(t: TestApp) {
  const today = t.today();
  const garmentId = await garment(t, 'Packed', 'shirt');
  const outfitId = await outfitOf(t, garmentId);
  const spareOutfitId = await outfitOf(t, await garment(t, 'Spare', 'shirt'));
  const tomorrow = addDays(today, 1);
  const id = await newTrip(t, 'Counted trip', today, tomorrow);
  const otherTripId = await newTrip(t, 'Other trip', today, tomorrow);
  for (const [url, payload] of [
    [`/trips/${id}/outfits`, { outfitId: String(outfitId), day: today }],
    [`/trips/${id}/packed`, { packed: String(garmentId) }],
    [`/trips/${id}/items`, { label: 'Charger' }],
    [`/trips/${otherTripId}/items`, { label: 'Passport' }],
  ] as const) {
    const res = await t.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(303);
  }
  const [{ id: tripOutfitId }] = await t.db
    .select({ id: tripOutfit.id })
    .from(tripOutfit)
    .where(eq(tripOutfit.tripId, id));
  const [{ id: itemId }] = await t.db
    .select({ id: tripItem.id })
    .from(tripItem)
    .where(eq(tripItem.tripId, id));
  return {
    id,
    otherTripId,
    tripOutfitId,
    itemId,
    garmentId,
    spareOutfitId,
    today,
  };
}

/** A need with two picks and another with one bought, and a capsule holding a garment; `tag` keeps their names apart. */
export async function wishlistRows(t: TestApp, tag: number) {
  const ownerId = t.owner.id;
  const need = async (name: string) => {
    const [row] = await t.db
      .insert(optionGroup)
      .values({ ownerId, name, budget: '100' })
      .returning({ id: optionGroup.id });
    return row.id;
  };
  const pick = async (name: string, groupId: number) => {
    const id = await createWishlistItem(t, { name, price: '90' });
    const marked = await markSuggestion(t.db, ownerId, id, {
      tokenId: null,
      groupId,
      note: null,
      rank: null,
    });
    expect(marked).toBe('marked');
    return id;
  };
  const needId = await need(`Counted need ${tag}`);
  const pickId = await pick(`Counted pick ${tag}`, needId);
  await pick(`Counted sibling ${tag}`, needId);
  const boughtNeed = await need(`Counted bought need ${tag}`);
  const boughtId = await pick(`Counted bought ${tag}`, boughtNeed);
  const bought = await t.inject({
    method: 'POST',
    url: `/wardrobe/${boughtId}/bought`,
    payload: { acquiredOn: t.today() },
  });
  expect(bought.statusCode).toBe(303);
  const garmentId = await createGarment(t, { name: `Counted member ${tag}` });
  const capsuleId = idIn(
    await t.inject({
      method: 'POST',
      url: '/capsules',
      payload: { name: `Counted capsule ${tag}` },
    }),
    /^\/capsules\/(\d+)/,
  );
  const held = await t.inject({
    method: 'POST',
    url: `/capsules/${capsuleId}/garments`,
    payload: { ids: [garmentId] },
  });
  expect(held.statusCode).toBe(303);
  return { needId, pickId, boughtId, capsuleId, garmentId };
}

/** Two loose garments, avoided together, and an outfit planned today with a selfie. */
export async function ideaRows(t: TestApp, photo: Buffer) {
  const today = t.today();
  const top = await garment(t, 'Idea tee', 'tops');
  const bottom = await garment(t, 'Idea jeans', 'bottoms');
  await t.inject({
    method: 'POST',
    url: '/outfits/ideas/avoid',
    payload: { garmentId: [String(top), String(bottom)] },
  });
  const outfitId = await outfitOf(t, await garment(t, 'Mirror', 'tops'));
  const entryId = await planEntry(t, outfitId, today);
  await postSelfie(t, entryId, { data: photo, filename: 'mirror.jpg' });
  return { top, bottom, entryId, selfie: await selfieOf(t, entryId), today };
}

/** `cookie`'s look with its photo and one piece (a white tee, `position` 0), and a closet tee. */
export async function lookRows(t: TestApp, photo: Buffer, cookie: string) {
  const { id, fileName } = await addLook(t, photo, cookie);
  await t.inject({
    method: 'POST',
    url: `/inspiration/${id}/pieces`,
    payload: { kind: 'top/t-shirt', color: 'white', accent: '', pattern: '' },
    headers: { cookie },
  });
  const tee = await garment(t, 'Look tee', 'tops', cookie);
  return { id, position: 0, fileName, tee };
}

/** `userId`'s rule to remove (`id`), and two colours no rule holds yet; `run` picks them. */
export async function ruleRows(t: TestApp, userId: number, run: number) {
  const [a, b, c] = [0, 1, 2].map(
    (i) => GARMENT_COLORS[(run * 3 + i) % GARMENT_COLORS.length],
  );
  const id = await addOutfitRule(
    t.db,
    { userId, surface: 'page' },
    {
      kind: 'always',
      a: { ...NO_MATCHER, color: a },
      b: { ...NO_MATCHER, pattern: 'stripes' },
    },
  );
  if (typeof id !== 'number') throw new Error('No rule');
  return { id, colors: [b, c] };
}

/** `cookie`'s brand row of `brand`, through the editor: its id and brand. */
export async function brandRow(t: TestApp, cookie: string, brand: string) {
  await t.inject({
    method: 'POST',
    url: '/auth/profile/sizes/brands',
    payload: { brand, size: 'M' },
    headers: { cookie },
  });
  const [row] = await t.db
    .select({ id: brandSize.id })
    .from(brandSize)
    .where(eq(brandSize.brand, brand));
  return { id: row.id, brand };
}

/**
 * One of each owner's resource the API writes without a photo, through
 * `token`: four garments in a capsule, a wear, an outfit planned, a trip,
 * a brand note, measurements, the style profile and a rule, and the week
 * template last (the changes feed's first pages are garments only).
 */
export async function everyResource(t: TestApp, token: string) {
  type Write = 'POST' | 'PUT' | 'PATCH';
  const write = (method: Write, url: string, payload?: object) =>
    t.api(token, { method, url: `/api/v1${url}`, payload });
  const ids: number[] = [];
  for (const name of ['One', 'Two', 'Three', 'Four']) {
    const res = await write('POST', '/garments', {
      category: 'shirt',
      name,
    });
    ids.push(res.json<{ id: number }>().id);
  }
  const capsule = await write('POST', '/capsules', { name: 'Counted' });
  const capsuleId = capsule.json<{ id: number }>().id;
  await write('PATCH', `/capsules/${capsuleId}/members`, { add: ids });
  const today = t.today();
  await write('PUT', `/garments/${ids[0]}/wears/${today}`);
  const slots = [{ category: 'shirt', garmentId: ids[1] }];
  const made = await write('POST', '/outfits', { slots });
  const outfitId = made.json<{ id: number }>().id;
  const writes: [Write, string, object][] = [
    ['POST', '/calendar-entries', { outfitId, day: today }],
    ['POST', '/trips', { name: 'Counted', startsOn: today, endsOn: today }],
    ['POST', '/sizes/brands', { brand: 'Counted', size: 'xl' }],
    ['PUT', '/sizes/measurements', { waist: 80 }],
    ['PUT', '/style-profile', { styles: ['classic'], palette: ['black'] }],
    // Rides in the profile's read (#716): no statement of its own.
    [
      'POST',
      '/outfit-rules',
      { kind: 'never', a: { color: 'red' }, b: { color: 'green' } },
    ],
    ['PUT', '/week-template', { days: [{ weekday: 1, day: 'work' }] }],
  ];
  for (const [method, url, payload] of writes) {
    const res = await write(method, url, payload);
    expect(res.statusCode, res.body).toBeLessThan(300);
  }
}
