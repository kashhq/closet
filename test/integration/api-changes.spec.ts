import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  garment,
  garmentWear,
  outfit,
  syncEpoch,
  user,
  wardrobeShare,
  weekPlan,
  weekPlanEntry,
} from '../../src/db/schema';
import { bumpSyncEpoch } from '../../src/db/sync-epoch';
import { deviceToken, expectProblem } from './api';
import { jpegPhoto } from './garments';
import {
  asFixture,
  createTestApp,
  multipart,
  type TestApp,
  userIdOf,
} from './harness';

/**
 * The changes feed (#196b-1, GET /api/v1/changes; src/web/sync/AGENTS.md):
 * a device's sync, paged, against writes from another session. What a page
 * costs is api-statements'.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.cleanup();
});

interface Item {
  resource: string;
  ownerId: number;
  id: number;
  clientId?: string;
  revision: number;
}
interface Change extends Item {
  data: Record<string, unknown>;
}
interface Page {
  changes: Change[];
  deletions: Item[];
  cursor: string;
  more: boolean;
  revokedWardrobes?: number[];
  snapshot?: { wardrobes: number[] };
}

interface Account {
  id: number;
  /** The syncing device. */
  device: string;
  /** Another device of the same user: "another session". */
  other: string;
}

async function account(email: string): Promise<Account> {
  await t.register(email);
  return {
    id: await userIdOf(t, email),
    device: (await deviceToken(t, { email })).token,
    other: (await deviceToken(t, { email, deviceName: 'iPad' })).token,
  };
}

const api = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) => t.api(token, { method, url: `/api/v1${url}`, payload });

async function changes(
  token: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<Page> {
  const params = new URLSearchParams();
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const res = await api(token, 'GET', `/changes?${params}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Page>();
}

/** Every page from `cursor` until `more` is false: the pages and the cursor it ends on. */
async function syncAll(
  token: string,
  from: { cursor?: string; limit: number },
): Promise<{ pages: Page[]; cursor: string }> {
  const pages: Page[] = [];
  let cursor = from.cursor;
  // A sync is a bounded walk: no test here has more than a dozen items.
  for (let call = 0; call < 20; call += 1) {
    const page = await changes(token, { cursor, limit: from.limit });
    pages.push(page);
    cursor = page.cursor;
    if (!page.more) return { pages, cursor };
  }
  throw new Error('The feed never finished');
}

const keyOf = (item: Item) => `${item.resource}:${item.id}`;
/**
 * Every user's week template: one per user, set or not, at revision 0
 * until first written (#716), so first in a full sync of an untouched one.
 */
const templateOf = (userId: number) => `weekTemplate:${userId}`;
const changeKeys = (pages: Page[]) =>
  pages.flatMap((page) => page.changes.map(keyOf));
const deletionKeys = (pages: Page[]) =>
  pages.flatMap((page) => page.deletions.map(keyOf));

async function newGarment(token: string, name: string): Promise<number> {
  const res = await api(token, 'POST', '/garments', {
    category: 'shirt',
    name,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

async function newCapsule(token: string, name: string, add: number[]) {
  const res = await api(token, 'POST', '/capsules', { name });
  expect(res.statusCode, res.body).toBe(201);
  const { id } = res.json<{ id: number }>();
  const members = await api(token, 'PATCH', `/capsules/${id}/members`, { add });
  expect(members.statusCode, members.body).toBe(200);
  return id;
}

async function wear(token: string, garmentId: number): Promise<number> {
  const res = await api(
    token,
    'PUT',
    `/garments/${garmentId}/wears/${t.today()}`,
  );
  expect(res.statusCode, res.body).toBe(200);
  const [row] = await t.db
    .select({ id: garmentWear.id })
    .from(garmentWear)
    .where(eq(garmentWear.garmentId, garmentId));
  return row.id;
}

/** A cursor's JSON, to forge one from (cursor.ts' format). */
const cursorFields = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<
    string,
    unknown
  >;
const encodeCursor = (fields: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(fields)).toString('base64url');

const revisionOf = async (userId: number) =>
  (
    await t.db
      .select({ revision: user.revision })
      .from(user)
      .where(eq(user.id, userId))
  )[0].revision;

const setFloor = (userId: number, floor: number) =>
  t.db.update(user).set({ syncFloor: floor }).where(eq(user.id, userId));

describe('the delta', () => {
  it('a device syncs, another session edits and deletes: the next sync is exactly that, then nothing', async () => {
    const a = await account('changes-delta@example.com');
    const [kept, edited, deleted] = [
      await newGarment(a.other, 'Kept'),
      await newGarment(a.other, 'Edited'),
      await newGarment(a.other, 'Deleted'),
    ];
    const capsuleId = await newCapsule(a.other, 'Office', [kept, deleted]);
    const first = await syncAll(a.device, { limit: 2 });
    expect(first.pages.length).toBeGreaterThan(1);
    expect(changeKeys(first.pages).sort()).toEqual(
      [
        `capsule:${capsuleId}`,
        `garment:${deleted}`,
        `garment:${edited}`,
        `garment:${kept}`,
        templateOf(a.id),
      ].sort(),
    );
    expect(deletionKeys(first.pages)).toEqual([]);

    const edit = await api(a.other, 'PATCH', `/garments/${edited}`, {
      name: 'Edited again',
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(
      (await api(a.other, 'DELETE', `/garments/${deleted}`)).statusCode,
    ).toBe(204);
    const wearId = await wear(a.other, kept);

    const delta = await syncAll(a.device, { cursor: first.cursor, limit: 2 });
    // The capsule lost a member with the garment; the wear moved no garment.
    expect(changeKeys(delta.pages).sort()).toEqual(
      [`capsule:${capsuleId}`, `garment:${edited}`, `wear:${wearId}`].sort(),
    );
    expect(deletionKeys(delta.pages)).toEqual([`garment:${deleted}`]);
    const all = delta.pages.flatMap((page) => page.changes);
    expect(all.find((c) => c.resource === 'garment')?.data).toMatchObject({
      id: edited,
      name: 'Edited again',
    });
    expect(all.find((c) => c.resource === 'capsule')?.data).toEqual({
      id: capsuleId,
      name: 'Office',
      garmentIds: [kept],
    });
    expect(all.find((c) => c.resource === 'wear')).toMatchObject({
      ownerId: a.id,
      data: { id: wearId, garmentId: kept, day: t.today() },
    });

    const after = await changes(a.device, { cursor: delta.cursor });
    expect(after).toMatchObject({ changes: [], deletions: [], more: false });
    expect(after.cursor).toBe(delta.cursor);
  });

  it("carries a garment's stored fields only: nothing derived from its wears or capsules", async () => {
    const a = await account('changes-derived@example.com');
    const id = await newGarment(a.device, 'Worn');
    await newCapsule(a.device, 'Weekend', [id]);
    await wear(a.device, id);
    const { pages } = await syncAll(a.device, { limit: 100 });
    const data = pages[0].changes.find((c) => c.resource === 'garment')?.data;
    expect(data).toMatchObject({ id, name: 'Worn', repairs: [] });
    expect(data).not.toHaveProperty('capsules');
    // The owner's stored care records only (none set): no worn, cost or last worn.
    expect(data?.care).toEqual({});
  });

  it('pages across a boundary inside one revision, deletions of several resources before its rows', async () => {
    const a = await account('changes-revision@example.com');
    const ids = [
      await newGarment(a.device, 'One'),
      await newGarment(a.device, 'Two'),
      await newGarment(a.device, 'Three'),
    ];
    const capsuleId = await newCapsule(a.device, 'All', ids);
    const wearId = await wear(a.device, ids[2]);
    const { cursor } = await syncAll(a.device, { limit: 100 });

    // One transaction each: one revision for three garments, then one for a
    // garment's tombstone, its wear's and the capsule it left.
    const bulk = await api(a.device, 'PATCH', '/garments', {
      ids,
      property: 'condition',
      value: 'needs_repair',
    });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(
      (await api(a.device, 'DELETE', `/garments/${ids[2]}`)).statusCode,
    ).toBe(204);

    const { pages } = await syncAll(a.device, { cursor, limit: 1 });
    const items = pages.flatMap((page) => [
      ...page.deletions.map((d) => ({ ...d, deleted: true })),
      ...page.changes.map((c) => ({ ...c, deleted: false })),
    ]);
    const [bulkRevision, deleteRevision] = [
      items[0].revision,
      items[items.length - 1].revision,
    ];
    expect(
      items.map((item) => [keyOf(item), item.deleted, item.revision]),
    ).toEqual([
      [`garment:${ids[0]}`, false, bulkRevision],
      [`garment:${ids[1]}`, false, bulkRevision],
      // Edited, then deleted before the sync: only its deletion.
      [`garment:${ids[2]}`, true, deleteRevision],
      [`wear:${wearId}`, true, deleteRevision],
      [`capsule:${capsuleId}`, false, deleteRevision],
    ]);
    expect(deleteRevision).toBe(bulkRevision + 1);
    expect(pages.at(-1)?.more).toBe(false);
  });

  it('a wardrobe still at the backfill (revision 0) is sent once, then never again', async () => {
    const a = await account('changes-backfill@example.com');
    const ids = [
      await newGarment(a.device, 'Old one'),
      await newGarment(a.device, 'Old two'),
      await newGarment(a.device, 'Old three'),
    ];
    // As #196a's backfill left production: every row and the owner at 0
    // (the stamp trigger would bump them, so it is off for the update).
    await t.db.transaction(async (tx) => {
      await tx.execute('alter table garment disable trigger user');
      await tx
        .update(garment)
        .set({ revision: 0 })
        .where(inArray(garment.id, ids));
      await tx.execute('alter table garment enable trigger user');
      await tx.update(user).set({ revision: 0 }).where(eq(user.id, a.id));
    });
    const first = await syncAll(a.device, { limit: 2 });
    expect(first.pages).toHaveLength(2);
    expect(changeKeys(first.pages).sort()).toEqual(
      [...ids.map((id) => `garment:${id}`), templateOf(a.id)].sort(),
    );
    expect(
      first.pages.flatMap((page) => page.changes.map((c) => c.revision)),
    ).toEqual([0, 0, 0, 0]);
    expect(await changes(a.device, { cursor: first.cursor })).toMatchObject({
      changes: [],
      deletions: [],
      more: false,
    });
  });

  it('a write committing during a paginated read is never lost: it comes on the next call, once', async () => {
    const a = await account('changes-held@example.com');
    const [sent, middle, unsent] = [
      await newGarment(a.device, 'Sent'),
      await newGarment(a.device, 'Middle'),
      await newGarment(a.device, 'Unsent'),
    ];
    const committed = await revisionOf(a.id);
    const page1 = await changes(a.device, { limit: 2 });
    expect(page1.changes.map(keyOf)).toEqual([
      templateOf(a.id),
      `garment:${sent}`,
    ]);

    // The writer holds its transaction (and its revision) open on another
    // connection, as a slow request would, over one garment already sent
    // and one not yet.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let wrote = () => {};
    const written = new Promise<void>((resolve) => (wrote = resolve));
    const writer = asFixture(t.db, async (tx) => {
      await tx
        .update(garment)
        .set({ name: 'Renamed late' })
        .where(inArray(garment.id, [sent, unsent]));
      wrote();
      await held;
    });
    await written;
    const rest = await syncAll(a.device, { cursor: page1.cursor, limit: 1 });
    expect(changeKeys(rest.pages)).toEqual([
      `garment:${middle}`,
      `garment:${unsent}`,
    ]);
    expect(
      rest.pages.flatMap((page) => page.changes.map((c) => c.data.name)),
    ).toEqual(['Middle', 'Unsent']);

    release();
    await writer;
    const late = await changes(a.device, { cursor: rest.cursor });
    // `unsent` twice in all (as it was, then renamed): the harmless resend
    // an upsert absorbs. Nothing skipped.
    expect(
      late.changes.map((c) => [keyOf(c), c.revision, c.data.name]),
    ).toEqual([
      [`garment:${sent}`, committed + 1, 'Renamed late'],
      [`garment:${unsent}`, committed + 1, 'Renamed late'],
    ]);
    expect(late.more).toBe(false);
  });
});

async function newOutfit(token: string, garmentIds: number[]) {
  const res = await api(token, 'POST', '/outfits', {
    name: 'Office',
    slots: garmentIds.map((garmentId) => ({ category: 'shirt', garmentId })),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

async function plan(token: string, outfitId: number): Promise<number> {
  const res = await api(token, 'POST', '/calendar-entries', {
    outfitId,
    day: t.today(),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

async function newTrip(token: string): Promise<number> {
  const res = await api(token, 'POST', '/trips', {
    name: 'Lisbon',
    startsOn: t.today(),
    endsOn: addDays(t.today(), 2),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

async function newBrand(token: string): Promise<number> {
  const res = await api(token, 'POST', '/sizes/brands', {
    brand: 'Uniqlo',
    size: 'xl',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

/** The page's changes of `resource`, by id, as data. */
const dataOf = (pages: Page[], resource: string) =>
  pages
    .flatMap((page) => page.changes)
    .filter((change) => change.resource === resource)
    .map((change) => change.data);

describe("the owner's own resources (#196b-2)", () => {
  it('outfits, entries, selfies and a week plan: each write is its delta; a slot resends its outfit, a garment edit does not', async () => {
    const a = await account('changes-planning@example.com');
    const [top, bottom] = [
      await newGarment(a.other, 'Top'),
      await newGarment(a.other, 'Bottom'),
    ];
    const outfitId = await newOutfit(a.other, [top, bottom]);
    const entryId = await plan(a.other, outfitId);
    // "Plan my week"'s batch over the entry, as the planner records it.
    const weekPlanId = await asFixture(t.db, async (tx) => {
      const [row] = await tx
        .insert(weekPlan)
        .values({ ownerId: a.id })
        .returning({ id: weekPlan.id });
      await tx
        .insert(weekPlanEntry)
        .values({ entryId, weekPlanId: row.id, outfitCreated: false });
      return row.id;
    });
    const first = await syncAll(a.device, { limit: 2 });
    expect(changeKeys(first.pages).sort()).toEqual(
      [
        `calendarEntry:${entryId}`,
        `garment:${bottom}`,
        `garment:${top}`,
        `outfit:${outfitId}`,
        `weekPlan:${weekPlanId}`,
        templateOf(a.id),
      ].sort(),
    );
    expect(dataOf(first.pages, 'outfit')).toEqual([
      {
        id: outfitId,
        name: 'Office',
        origin: 'person',
        slots: [
          { category: 'shirt', garmentId: top },
          { category: 'shirt', garmentId: bottom },
        ],
      },
    ]);
    expect(dataOf(first.pages, 'calendarEntry')).toEqual([
      {
        id: entryId,
        day: t.today(),
        occasion: 'all-day',
        worn: false,
        plannedBy: 'user',
        outfitId,
      },
    ]);
    expect(dataOf(first.pages, 'weekPlan')).toEqual([
      {
        id: weekPlanId,
        createdAt: expect.any(String),
        entries: [{ entryId, outfitCreated: false }],
      },
    ]);

    // A garment renamed moves no outfit: the feed's outfit names it by id.
    await api(a.other, 'PATCH', `/garments/${top}`, { name: 'Top again' });
    const renamed = await syncAll(a.device, {
      cursor: first.cursor,
      limit: 100,
    });
    expect(changeKeys(renamed.pages)).toEqual([`garment:${top}`]);

    // Its rows are its sync child: one replaced resends the outfit alone.
    const edited = await api(a.other, 'PATCH', `/outfits/${outfitId}`, {
      slots: [{ category: 'shirt', garmentId: top }],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const slots = await syncAll(a.device, {
      cursor: renamed.cursor,
      limit: 100,
    });
    expect(changeKeys(slots.pages)).toEqual([`outfit:${outfitId}`]);
    expect(dataOf(slots.pages, 'outfit')[0].slots).toEqual([
      { category: 'shirt', garmentId: top },
    ]);

    // A selfie is its own row and marks its entry worn, logging the wear.
    const taken = await t.api(a.other, {
      method: 'PUT',
      url: `/api/v1/calendar-entries/${entryId}/selfie`,
      ...(await multipart(
        {},
        {
          photo: {
            data: await jpegPhoto(320, 480),
            filename: 'mirror.jpg',
            contentType: 'image/jpeg',
          },
        },
      )),
    });
    expect(taken.statusCode, taken.body).toBe(200);
    const { selfieId } = taken.json<{ selfieId: number }>();
    const worn = await syncAll(a.device, {
      cursor: slots.cursor,
      limit: 100,
    });
    const [wearId] = (
      await t.db
        .select({ id: garmentWear.id })
        .from(garmentWear)
        .where(eq(garmentWear.garmentId, top))
    ).map((row) => row.id);
    expect(changeKeys(worn.pages).sort()).toEqual(
      [
        `calendarEntry:${entryId}`,
        `selfie:${selfieId}`,
        `wear:${wearId}`,
      ].sort(),
    );
    expect(dataOf(worn.pages, 'calendarEntry')[0]).toMatchObject({
      worn: true,
    });
    expect(dataOf(worn.pages, 'selfie')).toEqual([
      {
        id: selfieId,
        day: t.today(),
        calendarEntryId: entryId,
        photo: {
          version: 1,
          originalUrl: expect.stringMatching(/^\/api\/v1\/selfie-photos\//),
          thumbUrl: expect.stringMatching(/^\/api\/v1\/selfie-photos\//),
        },
      },
    ]);

    // The entry deleted takes its selfie and wear; the batch loses its row.
    expect(
      (await api(a.other, 'DELETE', `/calendar-entries/${entryId}`)).statusCode,
    ).toBe(204);
    const deleted = await syncAll(a.device, {
      cursor: worn.cursor,
      limit: 100,
    });
    expect(deletionKeys(deleted.pages).sort()).toEqual(
      [
        `calendarEntry:${entryId}`,
        `selfie:${selfieId}`,
        `wear:${wearId}`,
      ].sort(),
    );
    expect(changeKeys(deleted.pages)).toEqual([`weekPlan:${weekPlanId}`]);
    expect(dataOf(deleted.pages, 'weekPlan')[0].entries).toEqual([]);

    // The agent's proposal is the owner's to answer: in their feed with its
    // reaction (an outfit nothing holds now, as a proposal must be).
    await asFixture(t.db, (tx) =>
      tx
        .update(outfit)
        .set({
          proposedAt: new Date(),
          reaction: 'proposed',
          proposalNote: 'For Monday',
        })
        .where(eq(outfit.id, outfitId)),
    );
    const proposed = await syncAll(a.device, {
      cursor: deleted.cursor,
      limit: 100,
    });
    expect(changeKeys(proposed.pages)).toEqual([`outfit:${outfitId}`]);
    expect(dataOf(proposed.pages, 'outfit')[0].proposal).toEqual({
      reaction: 'proposed',
      note: 'For Monday',
    });
  });

  it('a trip carries its outfits, extras and packed marks: a tick resends the trip alone', async () => {
    const a = await account('changes-trip@example.com');
    const shirt = await newGarment(a.other, 'Linen');
    const outfitId = await newOutfit(a.other, [shirt]);
    const tripId = await newTrip(a.other);
    const added = await api(a.other, 'POST', `/trips/${tripId}/outfits`, {
      outfitId,
      day: t.today(),
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(
      (
        await api(a.other, 'POST', `/trips/${tripId}/items`, {
          label: 'Charger',
        })
      ).statusCode,
    ).toBe(201);
    const first = await syncAll(a.device, { limit: 100 });
    const [trip] = dataOf(first.pages, 'trip');
    expect(trip).toEqual({
      id: tripId,
      name: 'Lisbon',
      located: false,
      startsOn: t.today(),
      endsOn: addDays(t.today(), 2),
      outfits: [{ id: expect.any(Number), outfitId, day: t.today() }],
      extras: [{ id: expect.any(Number), label: 'Charger', packed: false }],
      packedGarmentIds: [],
    });

    const packed = await api(
      a.other,
      'PUT',
      `/trips/${tripId}/packing/${shirt}`,
      {
        packed: true,
      },
    );
    expect(packed.statusCode, packed.body).toBe(200);
    const delta = await syncAll(a.device, { cursor: first.cursor, limit: 100 });
    expect(changeKeys(delta.pages)).toEqual([`trip:${tripId}`]);
    expect(dataOf(delta.pages, 'trip')[0].packedGarmentIds).toEqual([shirt]);

    expect((await api(a.other, 'DELETE', `/trips/${tripId}`)).statusCode).toBe(
      204,
    );
    const gone = await syncAll(a.device, { cursor: delta.cursor, limit: 100 });
    expect(deletionKeys(gone.pages)).toEqual([`trip:${tripId}`]);
    expect(changeKeys(gone.pages)).toEqual([]);
  });

  it('the style profile, measurements and brand notes: one row per user keyed by the user, each write its delta', async () => {
    const a = await account('changes-sizes@example.com');
    const style = await api(a.other, 'PUT', '/style-profile', {
      styles: ['classic'],
      palette: ['black'],
    });
    expect(style.statusCode, style.body).toBe(200);
    const measured = await api(a.other, 'PUT', '/sizes/measurements', {
      waist: 80,
    });
    expect(measured.statusCode, measured.body).toBe(200);
    const brandId = await newBrand(a.other);
    const first = await syncAll(a.device, { limit: 100 });
    expect(changeKeys(first.pages).sort()).toEqual(
      [
        `brandSize:${brandId}`,
        `measurements:${a.id}`,
        `styleProfile:${a.id}`,
        templateOf(a.id),
      ].sort(),
    );
    expect(dataOf(first.pages, 'styleProfile')).toEqual([
      { styles: ['classic'], palette: ['black'], rules: [] },
    ]);
    expect(dataOf(first.pages, 'measurements')).toEqual([
      { unit: 'in', measurements: { waist: 80 } },
    ]);
    expect(dataOf(first.pages, 'brandSize')).toEqual([
      { id: brandId, brand: 'Uniqlo', size: 'X-Large' },
    ]);

    expect(
      (await api(a.other, 'PUT', '/sizes/unit', { unit: 'cm' })).statusCode,
    ).toBe(200);
    expect(
      (await api(a.other, 'DELETE', `/sizes/brands/${brandId}`)).statusCode,
    ).toBe(204);
    const delta = await syncAll(a.device, { cursor: first.cursor, limit: 100 });
    expect(changeKeys(delta.pages)).toEqual([`measurements:${a.id}`]);
    expect(dataOf(delta.pages, 'measurements')[0].unit).toBe('cm');
    expect(deletionKeys(delta.pages)).toEqual([`brandSize:${brandId}`]);
  });

  it('a request to the agent (#681 B1): its ask and its withdrawal are each the delta, as stored', async () => {
    const a = await account('changes-requests@example.com');
    const asked = await api(a.other, 'POST', '/agent-requests', {
      body: 'What goes with my navy coat?',
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const { id } = asked.json<{ id: number }>();
    const first = await syncAll(a.device, { limit: 100 });
    expect(changeKeys(first.pages).sort()).toEqual(
      [`agentRequest:${id}`, templateOf(a.id)].sort(),
    );
    expect(dataOf(first.pages, 'agentRequest')).toEqual([
      {
        id,
        body: 'What goes with my navy coat?',
        status: 'open',
        createdAt: expect.any(String),
      },
    ]);
    const withdrawn = await api(
      a.other,
      'POST',
      `/agent-requests/${id}/withdraw`,
    );
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const delta = await syncAll(a.device, { cursor: first.cursor, limit: 100 });
    expect(changeKeys(delta.pages)).toEqual([`agentRequest:${id}`]);
    expect(dataOf(delta.pages, 'agentRequest')[0]).toMatchObject({
      status: 'withdrawn',
      withdrawnAt: expect.any(String),
    });
  });

  it('the week template and outfit rules (#716): a write on one device is the other device’s delta, the rules in the profile', async () => {
    const a = await account('changes-week@example.com');
    const emptyWeek = {
      days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, around: [] })),
    };
    // Never set: every user has one, sent empty in a full sync.
    const first = await syncAll(a.device, { limit: 100 });
    expect(changeKeys(first.pages)).toEqual([`weekTemplate:${a.id}`]);
    expect(dataOf(first.pages, 'weekTemplate')).toEqual([emptyWeek]);

    const saved = await api(a.other, 'PUT', '/week-template', {
      days: [{ weekday: 1, day: 'work', around: ['workout'] }],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const week = await syncAll(a.device, { cursor: first.cursor, limit: 100 });
    expect(changeKeys(week.pages)).toEqual([`weekTemplate:${a.id}`]);
    expect(dataOf(week.pages, 'weekTemplate')).toEqual([saved.json()]);

    // A rule before any profile: the profile row it creates carries it.
    const added = await api(a.other, 'POST', '/outfit-rules', {
      kind: 'never',
      a: { color: 'red' },
      b: { category: 'footwear' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const ruleId = added.json<{ id: number }>().id;
    const rule = await syncAll(a.device, { cursor: week.cursor, limit: 100 });
    expect(changeKeys(rule.pages)).toEqual([`styleProfile:${a.id}`]);
    expect(dataOf(rule.pages, 'styleProfile')).toEqual([
      {
        styles: [],
        palette: [],
        rules: [
          {
            id: ruleId,
            kind: 'never',
            a: { color: 'red' },
            b: { category: 'footwear' },
          },
        ],
      },
    ]);

    expect(
      (await api(a.other, 'DELETE', `/outfit-rules/${ruleId}`)).statusCode,
    ).toBe(204);
    expect(
      (await api(a.other, 'PUT', '/week-template', { days: [] })).statusCode,
    ).toBe(200);
    const cleared = await syncAll(a.device, {
      cursor: rule.cursor,
      limit: 100,
    });
    // Two transactions, two revisions; neither is a deletion.
    expect(changeKeys(cleared.pages)).toEqual([
      `styleProfile:${a.id}`,
      `weekTemplate:${a.id}`,
    ]);
    expect(deletionKeys(cleared.pages)).toEqual([]);
    expect(dataOf(cleared.pages, 'styleProfile')[0].rules).toEqual([]);
    expect(dataOf(cleared.pages, 'weekTemplate')).toEqual([emptyWeek]);
  });
});

describe('the cursor', () => {
  it('a forged cursor is a 400; one from before a resource joined the feed is expired', async () => {
    const a = await account('changes-forged@example.com');
    for (const cursor of [
      'bm90LWpzb24',
      Buffer.from('{"v":1,"c":7,"w":{"1":[1]}}').toString('base64url'),
    ]) {
      expectProblem(
        await api(a.device, 'GET', `/changes?cursor=${cursor}`),
        400,
        'validation',
      );
    }
    const older = Buffer.from(
      `{"v":1,"c":1,"w":{"${a.id}":[0,2,"",0,0,0]}}`,
    ).toString('base64url');
    expectProblem(
      await api(a.device, 'GET', `/changes?cursor=${older}`),
      410,
      'cursor_expired',
    );
  });

  it("is the user's it was answered to: another account's, or one naming no user, is expired, then the full sync is the caller's own (#617)", async () => {
    const a = await account('changes-bound@example.com');
    const b = await account('changes-switched@example.com');
    await newGarment(a.device, 'Mine');
    const own = await newGarment(b.device, 'Theirs');
    const cursorOfA = (await syncAll(a.device, { limit: 100 })).cursor;
    const fields = cursorFields(cursorOfA);
    const unnamed = encodeCursor({ ...fields, u: undefined });
    // The device switched accounts: a's cursor, presented by b.
    for (const [token, cursor] of [
      [b.device, cursorOfA],
      [b.device, unnamed],
      [a.device, unnamed],
    ]) {
      expectProblem(
        await api(token, 'GET', `/changes?cursor=${cursor}`),
        410,
        'cursor_expired',
      );
    }
    expectProblem(
      await api(
        b.device,
        'GET',
        `/changes?cursor=${encodeCursor({ ...fields, u: String(b.id) })}`,
      ),
      400,
      'validation',
    );

    const fresh = await syncAll(b.device, { limit: 100 });
    expect(changeKeys(fresh.pages)).toEqual([
      templateOf(b.id),
      `garment:${own}`,
    ]);
    expect(fresh.pages[0].snapshot).toEqual({ wardrobes: [b.id] });
    // a's own cursor still reads.
    expect(await changes(a.device, { cursor: cursorOfA })).toMatchObject({
      changes: [],
      more: false,
    });
  });

  it('is a 410 below sync_floor, or inside its deletions; at the floor, past it or fresh it is read', async () => {
    const a = await account('changes-floor@example.com');
    const kept = [
      await newGarment(a.device, 'Kept'),
      await newGarment(a.device, 'Also kept'),
    ];
    const gone = await newGarment(a.device, 'Gone');
    await wear(a.device, gone);
    const synced = await syncAll(a.device, { limit: 100 });
    // A garment's tombstone and its wear's, at one revision: a page of one
    // ends between them.
    expect(
      (await api(a.device, 'DELETE', `/garments/${gone}`)).statusCode,
    ).toBe(204);
    const deletedAt = await revisionOf(a.id);
    const inside = await changes(a.device, { cursor: synced.cursor, limit: 1 });
    expect(inside.deletions.map(keyOf)).toEqual([`garment:${gone}`]);
    const done = await syncAll(a.device, { cursor: inside.cursor, limit: 100 });

    // The prune (#196b-3) records the newest revision it pruned as the floor.
    await setFloor(a.id, deletedAt);
    expectProblem(
      await api(a.device, 'GET', `/changes?cursor=${synced.cursor}`),
      410,
      'cursor_expired',
    );
    expectProblem(
      await api(a.device, 'GET', `/changes?cursor=${inside.cursor}`),
      410,
      'cursor_expired',
    );
    // Exactly at the floor, past its deletions: nothing missed.
    expect(await changes(a.device, { cursor: done.cursor })).toMatchObject({
      changes: [],
      more: false,
    });

    // A fresh sync is never refused, leaves out the deletions at or below
    // the floor (the client held none of their rows), and pages on past
    // revisions below the floor without expiring.
    const fresh = await syncAll(a.device, { limit: 1 });
    expect(changeKeys(fresh.pages)).toEqual([
      templateOf(a.id),
      ...kept.map((id) => `garment:${id}`),
    ]);
    expect(deletionKeys(fresh.pages)).toEqual([]);

    await newGarment(a.device, 'After');
    await setFloor(a.id, await revisionOf(a.id));
    expectProblem(
      await api(a.device, 'GET', `/changes?cursor=${done.cursor}`),
      410,
      'cursor_expired',
    );
  });

  it('is a 410 past the wardrobe it reads: a revision above its current one is another history (#652)', async () => {
    const a = await account('changes-ahead@example.com');
    await newGarment(a.device, 'Kept');
    const fields = cursorFields(
      (await syncAll(a.device, { limit: 100 })).cursor,
    );
    const ahead = encodeCursor({
      ...fields,
      w: { [a.id]: [(await revisionOf(a.id)) + 1, 2, '', 0, 0, 0] },
    });
    expectProblem(
      await api(a.device, 'GET', `/changes?cursor=${ahead}`),
      410,
      'cursor_expired',
    );
  });

  it('belongs to the epoch it was answered under: after a bump it is a 410 and a full sync starts the new one; one from before epochs is current until the first bump (#652)', async () => {
    const a = await account('changes-epoch@example.com');
    const kept = await newGarment(a.device, 'Kept');
    const synced = await syncAll(a.device, { limit: 100 });
    const fields = cursorFields(synced.cursor);
    const beforeEpochs = encodeCursor({ ...fields, e: undefined });
    expect(await changes(a.device, { cursor: beforeEpochs })).toMatchObject({
      changes: [],
      more: false,
    });

    const epoch = await bumpSyncEpoch(t.db);
    expect(epoch).not.toBe(fields.e);
    for (const cursor of [synced.cursor, beforeEpochs]) {
      expectProblem(
        await api(a.device, 'GET', `/changes?cursor=${cursor}`),
        410,
        'cursor_expired',
      );
    }
    const fresh = await syncAll(a.device, { limit: 100 });
    expect(changeKeys(fresh.pages)).toEqual([
      templateOf(a.id),
      `garment:${kept}`,
    ]);
    expect(fresh.pages[0].snapshot).toEqual({ wardrobes: [a.id] });
    expect(cursorFields(fresh.cursor).e).toBe(epoch);
    expect(await changes(a.device, { cursor: fresh.cursor })).toMatchObject({
      changes: [],
      more: false,
    });
  });

  it("without its sync_epoch row the feed is a 500 naming that row, logged once; a deleted account is the token check's 401", async () => {
    const a = await account('changes-no-epoch@example.com');
    const [saved] = await t.db.delete(syncEpoch).returning();
    try {
      const logged = t.logs.records.length;
      const res = await api(a.device, 'GET', '/changes');
      expect(res.statusCode).toBe(500);
      const lines = t.logs.records
        .slice(logged)
        .filter((record) => record.err?.message?.includes('sync_epoch'));
      expect(lines).toHaveLength(1);
    } finally {
      await t.db.insert(syncEpoch).values(saved);
    }

    await asFixture(t.db, (tx) => tx.delete(user).where(eq(user.id, a.id)));
    expect((await api(a.device, 'GET', '/changes')).statusCode).toBe(401);
  });
});

describe('a full sync', () => {
  it('after a 410 is marked a snapshot on every page, carries no deleted row and lists only the wardrobes still seen', async () => {
    const owner = await account('changes-snapshot-owner@example.com');
    const a = await account('changes-snapshot@example.com');
    const kept = [
      await newGarment(a.device, 'Kept'),
      await newGarment(a.device, 'Also kept'),
    ];
    const gone = await newGarment(a.device, 'Gone');
    await t.db.insert(wardrobeShare).values({
      grantorId: owner.id,
      granteeId: a.id,
      permission: 'VIEW',
      acceptedAt: new Date(),
      createdAt: new Date(),
    });
    const synced = await syncAll(a.device, { limit: 100 });
    expect(synced.pages[0].snapshot).toEqual({
      wardrobes: [a.id, owner.id],
    });

    // The deletion pruned, the share revoked: neither is a deletion the
    // full sync can send, so the snapshot's own shape says them.
    expect(
      (await api(a.device, 'DELETE', `/garments/${gone}`)).statusCode,
    ).toBe(204);
    await t.db
      .delete(wardrobeShare)
      .where(
        and(
          eq(wardrobeShare.grantorId, owner.id),
          eq(wardrobeShare.granteeId, a.id),
        ),
      );
    await setFloor(a.id, await revisionOf(a.id));
    expectProblem(
      await api(a.device, 'GET', `/changes?cursor=${synced.cursor}`),
      410,
      'cursor_expired',
    );

    const full = await syncAll(a.device, { limit: 1 });
    expect(full.pages.length).toBeGreaterThanOrEqual(2);
    for (const page of full.pages) {
      expect(page.snapshot).toEqual({ wardrobes: [a.id] });
    }
    expect(changeKeys(full.pages)).toEqual([
      templateOf(a.id),
      ...kept.map((id) => `garment:${id}`),
    ]);
    expect(deletionKeys(full.pages)).toEqual([]);

    // Its end cursor is an incremental sync's: never marked.
    await newGarment(a.device, 'After');
    const delta = await syncAll(a.device, { cursor: full.cursor, limit: 100 });
    expect(changeKeys(delta.pages)).toHaveLength(1);
    for (const page of delta.pages) {
      expect(page).not.toHaveProperty('snapshot');
    }
  });
});

describe("a grantee's feed", () => {
  it("carries the shared wardrobe's garments and capsules in the grantee shape, none of its owner-only records; a revoked share drops out", async () => {
    const owner = await account('changes-owner@example.com');
    const grantee = await account('changes-grantee@example.com');
    const shared = await newGarment(owner.device, 'Shared');
    const capsuleId = await newCapsule(owner.device, 'Shared capsule', [
      shared,
    ]);
    await wear(owner.device, shared);
    expect(
      (
        await api(owner.device, 'POST', `/garments/${shared}/repairs`, {
          day: t.today(),
          kind: 'repair',
          note: 'Owner only',
        })
      ).statusCode,
    ).toBe(201);
    const style = await api(owner.device, 'PUT', '/style-profile', {
      styles: ['classic'],
      palette: ['black'],
      budget: 'mid',
      notes: 'Owner only',
    });
    expect(style.statusCode, style.body).toBe(200);
    const measured = await api(owner.device, 'PUT', '/sizes/measurements', {
      waist: 80,
    });
    expect(measured.statusCode, measured.body).toBe(200);
    // The owner's planning: outfits, the calendar, trips and sizes are theirs alone.
    const ownersOutfit = await newOutfit(owner.device, [shared]);
    await plan(owner.device, ownersOutfit);
    await newTrip(owner.device);
    await newBrand(owner.device);
    const own = await newGarment(grantee.device, 'Mine');
    await t.db.insert(wardrobeShare).values({
      grantorId: owner.id,
      granteeId: grantee.id,
      permission: 'VIEW',
      acceptedAt: new Date(),
      createdAt: new Date(),
    });

    const synced = await syncAll(grantee.device, { limit: 1 });
    const all = synced.pages.flatMap((page) => page.changes);
    // Their own first, then the shared wardrobe by revision: the repair
    // touched the garment after the capsule's members.
    // The owner's template is theirs alone.
    expect(all.map((c) => [c.ownerId, keyOf(c)])).toEqual([
      [grantee.id, templateOf(grantee.id)],
      [grantee.id, `garment:${own}`],
      [owner.id, `capsule:${capsuleId}`],
      [owner.id, `garment:${shared}`],
    ]);
    const sharedGarment = all[3].data;
    expect(sharedGarment).toMatchObject({ id: shared, name: 'Shared' });
    expect(sharedGarment).not.toHaveProperty('care');
    expect(sharedGarment).not.toHaveProperty('repairs');
    expectProblem(
      await api(grantee.device, 'GET', `/changes?ownerId=${owner.id}`),
      400,
      'validation',
    );

    // The owner's wear deletion and their outfit's emptied slot never reach
    // the grantee; the garment's deletion does.
    expect(
      (await api(owner.device, 'DELETE', `/garments/${shared}`)).statusCode,
    ).toBe(204);
    const delta = await syncAll(grantee.device, {
      cursor: synced.cursor,
      limit: 100,
    });
    expect(deletionKeys(delta.pages)).toEqual([`garment:${shared}`]);
    expect(changeKeys(delta.pages)).toEqual([`capsule:${capsuleId}`]);

    await t.db
      .delete(wardrobeShare)
      .where(
        and(
          eq(wardrobeShare.grantorId, owner.id),
          eq(wardrobeShare.granteeId, grantee.id),
        ),
      );
    const revoked = await changes(grantee.device, { cursor: delta.cursor });
    expect(revoked).toMatchObject({
      changes: [],
      deletions: [],
      revokedWardrobes: [owner.id],
    });
    expect(
      await changes(grantee.device, { cursor: revoked.cursor }),
    ).not.toHaveProperty('revokedWardrobes');
  });

  // #1310: the feed is a replica. A request about a shared garment keeps
  // its stored reference when the share ends (no request revision moves);
  // the wardrobe's end arrives as revokedWardrobes and the client drops the
  // garment it resolved the reference against.
  it('a request about a shared garment: the share ending revokes the wardrobe and leaves the request holding its reference', async () => {
    const owner = await account('changes-req-owner@example.com');
    const grantee = await account('changes-req-grantee@example.com');
    const shared = await newGarment(owner.device, 'Shared coat');
    await t.db.insert(wardrobeShare).values({
      grantorId: owner.id,
      granteeId: grantee.id,
      permission: 'VIEW',
      acceptedAt: new Date(),
      createdAt: new Date(),
    });
    const asked = await api(grantee.device, 'POST', '/agent-requests', {
      body: 'What goes with this?',
      subject: { kind: 'garment', id: shared },
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const { id } = asked.json<{ id: number }>();
    const first = await syncAll(grantee.device, { limit: 100 });
    const subject = { subject: { kind: 'garment', id: shared } };
    expect(dataOf(first.pages, 'agentRequest')).toMatchObject([subject]);

    await t.db
      .delete(wardrobeShare)
      .where(
        and(
          eq(wardrobeShare.grantorId, owner.id),
          eq(wardrobeShare.granteeId, grantee.id),
        ),
      );
    const delta = await changes(grantee.device, { cursor: first.cursor });
    expect(delta.revokedWardrobes).toEqual([owner.id]);
    expect(delta.changes).toEqual([]);
    // The request is unchanged and still holds its reference on a fresh
    // sync; the API's resource, a fresh read, no longer shows the garment.
    const fresh = await syncAll(grantee.device, { limit: 100 });
    expect(dataOf(fresh.pages, 'agentRequest')).toMatchObject([subject]);
    const read = await api(grantee.device, 'GET', `/agent-requests/${id}`);
    expect(read.json()).not.toHaveProperty('subject');
  });

  // #680: price and notes are `private`, a MANAGE share's and never a
  // VIEW one's. The grant is part of the cursor (`g`, #959), so a share
  // lowered to VIEW resends the wardrobe's garments, without them: a
  // client replaces the row whole.
  it('carries price and notes on a MANAGE share; lowered to VIEW, resends the garment without them', async () => {
    const owner = await account('changes-private-owner@example.com');
    const grantee = await account('changes-private-grantee@example.com');
    const priced = await api(owner.device, 'POST', '/garments', {
      category: 'shirt',
      name: 'Priced',
      price: '42.50',
      notes: 'Private note',
    });
    expect(priced.statusCode, priced.body).toBe(201);
    const id = priced.json<{ id: number }>().id;
    await t.db.insert(wardrobeShare).values({
      grantorId: owner.id,
      granteeId: grantee.id,
      permission: 'MANAGE',
      acceptedAt: new Date(),
      createdAt: new Date(),
    });
    const sharedRow = (pages: Page[]) =>
      pages
        .flatMap((page) => page.changes)
        .find((change) => keyOf(change) === `garment:${id}`)?.data;

    const managed = await syncAll(grantee.device, { limit: 100 });
    expect(sharedRow(managed.pages)).toMatchObject({
      price: '42.50',
      notes: 'Private note',
    });

    await t.db
      .update(wardrobeShare)
      .set({ permission: 'VIEW' })
      .where(
        and(
          eq(wardrobeShare.grantorId, owner.id),
          eq(wardrobeShare.granteeId, grantee.id),
        ),
      );
    const viewed = await syncAll(grantee.device, {
      cursor: managed.cursor,
      limit: 100,
    });
    const resent = sharedRow(viewed.pages);
    expect(resent).toMatchObject({ id, name: 'Priced' });
    expect(resent).not.toHaveProperty('price');
    expect(resent).not.toHaveProperty('notes');
  });
});
