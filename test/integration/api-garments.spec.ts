import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { deviceToken, expectProblem } from './api';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  uploadPhoto,
} from './garments';
import { createTestApp, type TestApp, TEST_PASSWORD } from './harness';
import { insertGarmentOnce } from '../../src/web/wardrobe/queries';
import { interleave } from './interleave';

/**
 * The wardrobe on /api/v1. Reads (#192a): GET /garments (the grid's
 * filters, keyset paging behind an opaque cursor) and GET /garments/{id}
 * (the garment in full, its signed photo URLs, the owner's records only
 * for the owner). Writes (#192b): each its page twin's writer with a JSON
 * body, saved by the garment form's rules. Who may do what is the
 * authorization matrix's (its wardrobe cases replay on these twins,
 * authorization-wardrobe.spec.ts); what each costs is api-statements'.
 */

let t: TestApp;
let ownerToken: string;
let viewerToken: string;
let strangerToken: string;
/** The owner's garments, newest first. */
let ids: number[];
let photographed: number;

interface ListAnswer {
  data: { id: number; name?: string; category: string; photo?: unknown }[];
  pagination: { nextCursor?: string; limit: number };
  total: number;
}

const list = (token: string, query = '') =>
  t.api(token, { method: 'GET', url: `/api/v1/garments${query}` });

const get = (token: string, id: number, query = '') =>
  t.api(token, { method: 'GET', url: `/api/v1/garments/${id}${query}` });

async function signUp(
  email: string,
): Promise<{ cookie: string; token: string }> {
  const cookie = await t.register(email);
  return { cookie, token: (await deviceToken(t, { email })).token };
}

/** The owner's invite, accepted by `cookie`'s account. */
async function share(cookie: string, permission: 'VIEW' | 'MANAGE') {
  const invite = await t.inject({
    method: 'POST',
    url: '/wardrobe-share/create-invite-link',
    payload: { permission, currentPassword: TEST_PASSWORD },
    headers: { 'hx-request': 'true' },
  });
  const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    invite.body,
  )![1];
  const accepted = await t.inject({
    method: 'POST',
    url: `/wardrobe-share/invite/${token}/accept`,
    headers: { cookie },
  });
  expect(accepted.statusCode).toBe(302);
}

beforeAll(async () => {
  t = await createTestApp();
  ownerToken = (await deviceToken(t)).token;
  const viewer = await signUp('api-garments-viewer@example.com');
  viewerToken = viewer.token;
  await share(viewer.cookie, 'VIEW');
  strangerToken = (await signUp('api-garments-stranger@example.com')).token;
  const created: number[] = [];
  for (const [index, category] of [
    'shirt',
    'pants',
    'shirt',
    'pants',
    'shirt',
  ].entries()) {
    created.push(
      await createGarment(t, { name: `Api garment ${index}`, category }),
    );
  }
  ids = created.reverse();
  photographed = ids[0];
  await uploadPhoto(t, photographed, await jpegPhoto(320, 240));
});

afterAll(() => t?.cleanup());

describe('GET /api/v1/garments', () => {
  it('pages the closet newest first behind an opaque cursor, with the total', async () => {
    const first = await list(ownerToken, '?limit=2');
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<ListAnswer>();
    expect(page.data.map(({ id }) => id)).toEqual(ids.slice(0, 2));
    expect(page.total).toBe(ids.length);
    expect(page.pagination.limit).toBe(2);
    const cursor = page.pagination.nextCursor!;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(String(ids[1]));

    const second = await list(ownerToken, `?limit=2&cursor=${cursor}`);
    expect(second.json<ListAnswer>().data.map(({ id }) => id)).toEqual(
      ids.slice(2, 4),
    );
    const last = await list(
      ownerToken,
      `?limit=2&cursor=${second.json<ListAnswer>().pagination.nextCursor}`,
    );
    expect(last.json<ListAnswer>().data.map(({ id }) => id)).toEqual(
      ids.slice(4),
    );
    expect(last.json<ListAnswer>().pagination).toEqual({ limit: 2 });
  });

  it('keeps a cursor stable: a garment added since shifts nothing onto its page', async () => {
    const first = (await list(ownerToken, '?limit=2')).json<ListAnswer>();
    const cursor = first.pagination.nextCursor!;
    const page = async () => {
      const { data, pagination } = (
        await list(ownerToken, `?limit=2&cursor=${cursor}`)
      ).json<ListAnswer>();
      return { data, pagination };
    };
    const before = await page();
    const added = await createGarment(t, { name: 'Api garment later' });
    try {
      // Only the total counts the new one.
      expect(await page()).toEqual(before);
    } finally {
      await t.inject({ method: 'DELETE', url: `/wardrobe/${added}` });
    }
  });

  it("filters as the grid does, and draws each tile's photo", async () => {
    const res = await list(ownerToken, '?category=shirt&limit=100');
    const page = res.json<ListAnswer>();
    expect(page.total).toBe(3);
    expect(page.data.every(({ category }) => category === 'shirt')).toBe(true);
    expect(
      page.data.find(({ id }) => id === photographed)?.photo,
    ).toMatchObject({
      thumbUrl: expect.stringMatching(/^\/file\/thumb\/[^?]+\?v=\d+.*&s=/),
    });
    // A garment without a photo has no `photo`, never a null.
    expect(page.data.find(({ id }) => id !== photographed)).not.toHaveProperty(
      'photo',
    );
  });

  it('refuses a type without its category, a forged cursor and a limit past 100', async () => {
    expectProblem(await list(ownerToken, '?type=t-shirt'), 400, 'validation');
    const forged = Buffer.from('before:1').toString('base64url');
    expectProblem(
      await list(ownerToken, `?cursor=${forged}`),
      400,
      'validation',
    );
    expectProblem(await list(ownerToken, '?limit=101'), 400, 'validation');
  });

  it("serves a grantee the owner's closet, without what reads the owner's wears", async () => {
    const owner = `?ownerId=${t.owner.id}`;
    const shared = await list(viewerToken, owner);
    expect(shared.statusCode).toBe(200);
    expect(shared.json<ListAnswer>().total).toBe(ids.length);
    const wash = expectProblem(
      await list(viewerToken, `${owner}&needsWash=true`),
      403,
      'forbidden',
    );
    expect(wash.detail).toBe('needsWash reads your own wears only');
    // The grantee's own wardrobe holds none of the owner's garments.
    expect((await list(viewerToken)).json<ListAnswer>().total).toBe(0);
  });

  it("answers a stranger's ?ownerId= with the problem 404 of an unknown wardrobe", async () => {
    const problem = expectProblem(
      await list(strangerToken, `?ownerId=${t.owner.id}`),
      404,
      'not_found',
    );
    expect(problem.detail).toBe('Wardrobe not found');
    expect(problem.detail).not.toContain(String(t.owner.id));
  });
});

describe('GET /api/v1/garments/{id}', () => {
  it("answers the owner the garment in full, the owner's records and signed photo URLs", async () => {
    const res = await get(ownerToken, photographed);
    expect(res.statusCode, res.body).toBe(200);
    const garment = res.json<Record<string, unknown>>();
    expect(garment).toMatchObject({
      id: photographed,
      name: 'Api garment 4',
      category: 'shirt',
      status: 'closet',
      colors: [],
      quantity: 1,
      condition: 'good',
      capsules: [],
      care: { worn: 0, wornSinceWash: 0 },
      repairs: [],
    });
    // Nulls are left out, never sent as null or "".
    expect(garment).not.toHaveProperty('brand');
    expect(JSON.stringify(garment)).not.toContain('null');
    const photo = garment.photo as Record<string, string>;
    expect(photo.originalUrl).toMatch(/^\/file\/[^/?]+\?v=\d+.*&s=/);
    const thumb = await t.inject({
      method: 'GET',
      url: photo.thumbUrl,
      anonymous: true,
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
  });

  it("answers a VIEW grantee the garment without the owner's records", async () => {
    const res = await get(viewerToken, photographed, `?ownerId=${t.owner.id}`);
    expect(res.statusCode).toBe(200);
    const garment = res.json<Record<string, unknown>>();
    expect(garment).toMatchObject({ id: photographed, name: 'Api garment 4' });
    expect(garment).not.toHaveProperty('care');
    expect(garment).not.toHaveProperty('repairs');
  });

  it('answers a stranger, and a grantee outside the share, the problem 404 of an unknown garment', async () => {
    for (const [token, query] of [
      [strangerToken, `?ownerId=${t.owner.id}`],
      [strangerToken, ''],
      [viewerToken, ''],
    ] as const) {
      const problem = expectProblem(
        await get(token, photographed, query),
        404,
        'not_found',
      );
      expect(problem.detail).toBe('Garment not found');
      expect(JSON.stringify(problem)).not.toContain('Api garment');
    }
  });
});

describe('the garment writes', () => {
  const send = (
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    token = ownerToken,
  ) => t.api(token, { method, url: `/api/v1${url}`, payload });

  async function created(payload: object): Promise<number> {
    const res = await send('POST', '/garments', payload);
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json<{ id: number }>();
    expect(res.headers.location).toBe(`/api/v1/garments/${id}`);
    return id;
  }

  it("POST /garments saves by the form's rules: normalized, the type's presets, the wishlist", async () => {
    const id = await created({
      name: '  Writes tee ',
      category: 'Tops',
      size: 'xl',
      price: '49.9',
      colors: ['white'],
      properties: { type: 't-shirt' },
      careLabel: { notes: 'Cold wash' },
      clientId: '7d1f3c2e-1b9a-4c8e-9f0a-2b3c4d5e6f70',
    });
    expect(await garmentRow(t, id)).toMatchObject({
      ownerId: t.owner.id,
      name: 'Writes tee',
      category: 'tops',
      size: 'X-Large',
      price: '49.90',
      colors: ['white'],
      type: 't-shirt',
      warmth: 2,
      sleeve: 'short',
      washingDetails: 'Cold wash',
      status: 'closet',
    });
    const wish = await created({
      category: 'tops',
      destination: 'wishlist',
      replacesGarmentId: id,
    });
    expect(await garmentRow(t, wish)).toMatchObject({
      status: 'wishlist',
      replacesGarmentId: id,
    });
  });

  describe('a clientId (#563)', () => {
    const rowsOf = (ownerId: number, clientId: string) =>
      t.db
        .select({ id: garment.id, name: garment.name })
        .from(garment)
        .where(
          and(eq(garment.ownerId, ownerId), eq(garment.clientId, clientId)),
        );

    it('stores it, answers a retry with the first row (200, its Location) and creates nothing', async () => {
      const clientId = randomUUID();
      const id = await created({ name: 'Once', category: 'tops', clientId });
      expect(await rowsOf(t.owner.id, clientId)).toEqual([
        { id, name: 'Once' },
      ]);
      // The retry may follow the client's own edit: the id names the create.
      const retry = await send('POST', '/garments', {
        name: 'Once, retried',
        category: 'tops',
        clientId,
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual({ id });
      expect(retry.headers.location).toBe(`/api/v1/garments/${id}`);
      expect(await rowsOf(t.owner.id, clientId)).toEqual([
        { id, name: 'Once' },
      ]);
    });

    it('stores none for a create without one', async () => {
      const id = await created({ name: 'Anonymous', category: 'tops' });
      expect((await garmentRow(t, id))?.clientId).toBeNull();
    });

    it('is scoped to the wardrobe it lands in: a manager creates into the owner’s, their own is another', async () => {
      const manager = await signUp('api-garments-manager@example.com');
      await share(manager.cookie, 'MANAGE');
      const clientId = randomUUID();
      const body = { name: 'Managed', category: 'tops', clientId };
      const into = `/garments?ownerId=${t.owner.id}`;
      const first = await send('POST', into, body, manager.token);
      expect(first.statusCode, first.body).toBe(201);
      const { id } = first.json<{ id: number }>();
      expect((await garmentRow(t, id))?.ownerId).toBe(t.owner.id);
      // The retry, and the owner's own create of that id, find the owner's row.
      for (const [url, token] of [
        [into, manager.token],
        ['/garments', ownerToken],
      ] as const) {
        const again = await send('POST', url, body, token);
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json()).toEqual({ id });
      }
      // In the manager's own wardrobe the same id is a different row.
      const own = await send('POST', '/garments', body, manager.token);
      expect(own.statusCode, own.body).toBe(201);
      expect(own.json<{ id: number }>().id).not.toBe(id);
      expect(await rowsOf(t.owner.id, clientId)).toHaveLength(1);
    });

    it('makes two concurrent creates of one id one row: the second waits on the owner lock, then answers the first’s row', async () => {
      const clientId = randomUUID();
      let held!: number;
      const [, retry] = await interleave(
        t.db,
        async (tx) => {
          held = (await insertGarmentOnce(
            tx,
            t.owner.id,
            {
              name: 'Held',
              category: 'tops',
              brand: null,
              colors: null,
              size: null,
              notes: null,
              washingDetails: null,
              acquiredOn: null,
            },
            'closet',
            clientId,
          ))!;
        },
        () =>
          send('POST', '/garments', {
            name: 'Racer',
            category: 'tops',
            clientId,
          }),
      );
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual({ id: held });
      expect(await rowsOf(t.owner.id, clientId)).toEqual([
        { id: held, name: 'Held' },
      ]);
    });
  });

  it('refuses what the form refuses as a 400 naming each field, and stores nothing', async () => {
    const blank = expectProblem(
      await send('POST', '/garments', {
        category: ' ',
        sourceUrl: 'javascript:alert(1)',
      }),
      400,
      'validation',
    );
    expect(blank.errors?.map(({ path }) => path).sort()).toEqual([
      'body/category',
      'body/sourceUrl',
    ]);
    const replaces = expectProblem(
      await send('POST', '/garments', {
        category: 'tops',
        replacesGarmentId: ids[0],
      }),
      400,
      'validation',
    );
    expect(replaces.errors).toEqual([
      { path: 'body/replacesGarmentId', message: replaces.detail },
    ]);
  });

  it('PATCH /garments/{id} writes what was sent: null clears, a new role drops and names what it lacks', async () => {
    const id = await created({
      name: 'Patched',
      category: 'tops',
      brand: 'Kept',
      notes: 'Old notes',
      properties: { type: 't-shirt', fabricWeightGsm: 180 },
    });
    const res = await send('PATCH', `/garments/${id}`, {
      notes: null,
      category: 'footwear',
      properties: { warmth: null },
      care: { washAfterWears: 3 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      ignored: expect.arrayContaining(['properties.type', 'properties.sleeve']),
    });
    expect(await garmentRow(t, id)).toMatchObject({
      name: 'Patched',
      brand: 'Kept',
      notes: null,
      category: 'footwear',
      type: null,
      sleeve: null,
      warmth: null,
      washAfterWears: 3,
    });
    // Sent again: nothing differs, nothing is written.
    const again = await send('PATCH', `/garments/${id}`, { notes: null });
    expect(again.json()).toEqual({ ignored: [] });
    expectProblem(
      await send('PATCH', `/garments/${id}`, { acquiredOn: '2026-02-30' }),
      400,
      'validation',
    );
    expectProblem(
      await send('PATCH', `/garments/${id}`, {
        category: 'tops',
        properties: { type: 'boot' },
      }),
      400,
      'validation',
    );
  });

  it('takes a JSON body as sent: a never-wash 0 stays 0, a string for a number is a 400', async () => {
    // Fastify's ajv coerces by default, which once turned this 0 into null
    // (the role's default) through Nullable's null branch (validator.ts).
    const neverWash = { care: { washAfterWears: 0 } };
    const id = await created({ category: 'tops', ...neverWash });
    expect((await garmentRow(t, id))?.washAfterWears).toBe(0);
    const patched = await created({
      category: 'tops',
      care: { washAfterWears: 3 },
    });
    expect(
      (await send('PATCH', `/garments/${patched}`, neverWash)).statusCode,
    ).toBe(200);
    expect((await garmentRow(t, patched))?.washAfterWears).toBe(0);
    const clone = await send('POST', `/garments/${patched}/clones`, {
      name: 'Never washed',
      ...neverWash,
    });
    expect(clone.statusCode, clone.body).toBe(201);
    expect(
      (await garmentRow(t, clone.json<{ id: number }>().id))?.washAfterWears,
    ).toBe(0);
    const coerced = expectProblem(
      await send('PATCH', `/garments/${id}`, {
        care: { washAfterWears: '3' },
      }),
      400,
      'validation',
    );
    expect(coerced.errors?.[0]?.path).toMatch(/^body\/care/);
    expect((await garmentRow(t, id))?.washAfterWears).toBe(0);
  });

  it('PUT /garments/{id}/status archives and restores, a repeat answered as it is', async () => {
    const id = await created({ category: 'tops' });
    const put = (status: string) =>
      send('PUT', `/garments/${id}/status`, { status });
    for (const status of ['archived', 'archived', 'closet', 'closet']) {
      const res = await put(status);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ status });
      expect((await garmentRow(t, id))?.status).toBe(status);
    }
    const wish = await createWishlistItem(t, { name: 'Not bought' });
    expectProblem(
      await send('PUT', `/garments/${wish}/status`, { status: 'closet' }),
      409,
      'conflict',
    );
  });

  it('PUT /garments/{id}/condition keeps the note only with a problem', async () => {
    const id = await created({ category: 'tops' });
    const set = async (body: object) =>
      (await send('PUT', `/garments/${id}/condition`, body)).json<unknown>();
    expect(
      await set({ condition: 'needs_repair', conditionNote: ' Loose hem ' }),
    ).toEqual({ condition: 'needs_repair', conditionNote: 'Loose hem' });
    expect(await set({ condition: 'good', conditionNote: 'Gone' })).toEqual({
      condition: 'good',
    });
    expect(await garmentRow(t, id)).toMatchObject({
      condition: 'good',
      conditionNote: null,
    });
  });

  it("POST /garments/{id}/clones copies a garment a VIEW grantee sees into the grantee's own wardrobe", async () => {
    const source = await created({
      name: 'Source',
      category: 'tops',
      brand: 'Same',
      care: { washAfterWears: 5 },
    });
    const res = await send(
      'POST',
      `/garments/${source}/clones?ownerId=${t.owner.id}`,
      { size: 'm' },
      viewerToken,
    );
    expect(res.statusCode, res.body).toBe(201);
    const clone = await garmentRow(t, res.json<{ id: number }>().id);
    expect(clone).toMatchObject({
      name: 'Source (cloned)',
      brand: 'Same',
      size: 'Medium',
      // The owner's wash limit is the owner's own record.
      washAfterWears: null,
    });
    expect(clone?.ownerId).not.toBe(t.owner.id);
    expect(res.headers.location).toBe(`/api/v1/garments/${clone?.id}`);
    // No body: the source as it is.
    const plain = await send('POST', `/garments/${source}/clones`);
    expect(plain.statusCode, plain.body).toBe(201);
  });

  it('POST /garments/{id}/copies counts more copies, and refuses a wishlist item', async () => {
    const id = await created({ category: 'tops' });
    expect(
      (await send('POST', `/garments/${id}/copies`, { copies: 2 })).json(),
    ).toEqual({ quantity: 3 });
    expect((await send('POST', `/garments/${id}/copies`)).json()).toEqual({
      quantity: 4,
    });
    const wish = await createWishlistItem(t, { name: 'Wished' });
    expectProblem(
      await send('POST', `/garments/${wish}/copies`),
      409,
      'conflict',
    );
  });

  it("PATCH /garments/{id}/tags writes what differs, a new type's presets included", async () => {
    const id = await created({ category: 'tops' });
    const tag = (body: object) => send('PATCH', `/garments/${id}/tags`, body);
    const first = await tag({ type: 't-shirt', formality: 3 });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ changed: string[] }>().changed.sort()).toEqual([
      'formality',
      'sleeve',
      'type',
      'warmth',
    ]);
    expect(await garmentRow(t, id)).toMatchObject({
      type: 't-shirt',
      warmth: 2,
      formality: 3,
    });
    expect((await tag({ type: 't-shirt' })).json()).toEqual({ changed: [] });
    expect((await tag({ warmth: null })).json()).toEqual({
      changed: ['warmth'],
    });
    expectProblem(await tag({ type: 'boot' }), 400, 'validation');
  });

  it('PATCH /garments sets one property on the garments named, skipping what its role lacks', async () => {
    const top = await created({ category: 'tops' });
    const shoe = await created({ category: 'footwear' });
    const res = await send('PATCH', '/garments', {
      ids: [top, shoe],
      property: 'sleeve',
      value: 'long',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ updated: 1, skipped: 1 });
    expect((await garmentRow(t, top))?.sleeve).toBe('long');
    expectProblem(
      await send('PATCH', '/garments', {
        ids: [top],
        property: 'warmth',
        value: 'silk',
      }),
      400,
      'validation',
    );
  });

  it('DELETE /garments/{id} is a 204, then the 404 a retry reads as done', async () => {
    const id = await created({ category: 'tops' });
    const res = await send('DELETE', `/garments/${id}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await garmentRow(t, id)).toBeUndefined();
    expectProblem(await send('DELETE', `/garments/${id}`), 404, 'not_found');
  });
});
