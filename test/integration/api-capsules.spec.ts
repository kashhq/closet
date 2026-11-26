import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capsule, capsuleGarment } from '../../src/db/schema';
import { deviceToken, expectProblem } from './api';
import { createGarment, createWishlistItem } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * Capsules on /api/v1 (#194b): each its page twin's writer through
 * capsule-actions.ts, with a JSON body. Who may do what is the
 * authorization matrix's (authorization-capsules.spec.ts replays every case
 * on these twins); what each costs is api-statements'.
 */

let t: TestApp;
let token: string;
let strangerToken: string;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

async function newCapsule(name: string): Promise<number> {
  const res = await api('POST', '/capsules', { name });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

const membersOf = async (capsuleId: number) =>
  (
    await t.db
      .select({ id: capsuleGarment.garmentId })
      .from(capsuleGarment)
      .where(eq(capsuleGarment.capsuleId, capsuleId))
  )
    .map(({ id }) => id)
    .sort((a, b) => a - b);

beforeAll(async () => {
  t = await createTestApp();
  token = (await deviceToken(t)).token;
  const email = 'api-capsules-stranger@example.com';
  await t.register(email);
  strangerToken = (await deviceToken(t, { email })).token;
});

afterAll(async () => {
  await t?.cleanup();
});

describe('capsules', () => {
  it('creates, reads, renames and deletes a capsule as the form does', async () => {
    const made = await api('POST', '/capsules', {
      name: '  Office  ',
      notes: ' Weekdays ',
      clientId: '3b0f9d0e-8a7c-4f61-9b2e-5d4c3b2a1f01',
    });
    expect(made.statusCode, made.body).toBe(201);
    const { id } = made.json<{ id: number }>();
    expect(made.headers.location).toBe(`/api/v1/capsules/${id}`);
    expect(t.logs.ops('capsule.created')).toEqual([
      expect.objectContaining({
        capsuleId: id,
        surface: 'api',
        changed: true,
        clientId: '3b0f9d0e-8a7c-4f61-9b2e-5d4c3b2a1f01',
      }),
    ]);
    expect((await api('GET', `/capsules/${id}`)).json()).toEqual({
      id,
      name: 'Office',
      notes: 'Weekdays',
    });

    // The form's refusals, naming the field: blank, and taken in any case.
    const before = await t.db.$count(capsule);
    for (const name of ['  ', 'OFFICE']) {
      const refused = expectProblem(
        await api('POST', '/capsules', { name }),
        400,
        'validation',
      );
      expect(refused.errors?.map(({ path }) => path)).toEqual(['body/name']);
    }
    expect(await t.db.$count(capsule)).toBe(before);

    // PUT replaces both fields: notes left out are cleared.
    const renamed = await api('PUT', `/capsules/${id}`, { name: 'Work' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toEqual({ id, name: 'Work' });
    expect((await api('GET', `/capsules/${id}`)).json()).toEqual({
      id,
      name: 'Work',
    });

    // Another's capsule is the 404 of an unknown id, whatever was sent.
    expectProblem(
      await api('PUT', `/capsules/${id}`, { name: ' ' }, strangerToken),
      404,
      'not_found',
    );

    const gone = await api('DELETE', `/capsules/${id}`);
    expect(gone.statusCode).toBe(204);
    expectProblem(await api('DELETE', `/capsules/${id}`), 404, 'not_found');
  });

  it('lists the capsules by name with their counts, a page at a time', async () => {
    const a = await newCapsule('A list capsule');
    const b = await newCapsule('B list capsule');
    const shirt = await createGarment(t, { name: 'Listed shirt' });
    await api('PATCH', `/capsules/${a}/members`, { add: [shirt] });

    const first = await api('GET', '/capsules?limit=1');
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<{
      data: { id: number; count: number; preview: { id: number }[] }[];
      pagination: { nextCursor?: string; limit: number };
    }>();
    expect(page.data).toEqual([
      {
        id: a,
        name: 'A list capsule',
        count: 1,
        preview: [{ id: shirt, name: 'Listed shirt' }],
      },
    ]);
    const next = await api(
      'GET',
      `/capsules?limit=1&cursor=${page.pagination.nextCursor}`,
    );
    expect(
      next.json<{ data: { id: number }[] }>().data.map(({ id }) => id),
    ).toEqual([b]);
    expectProblem(
      await api('GET', '/capsules?cursor=bogus'),
      400,
      'validation',
    );
  });

  it("changes membership from either side, set-state; another's ids are dropped, another's capsule a 404", async () => {
    const id = await newCapsule('Weekend');
    const [tee, jeans] = [
      await createGarment(t, { name: 'Weekend tee' }),
      await createGarment(t, { name: 'Weekend jeans', category: 'bottoms' }),
    ];
    const wish = await createWishlistItem(t, { name: 'Wished boots' });
    const theirs = await createGarment(t, {
      name: 'Not yours',
      cookie: await t.register('api-capsules-other@example.com'),
    });

    const added = await api('PATCH', `/capsules/${id}/members`, {
      add: [tee, jeans, wish, theirs],
    });
    expect(added.json()).toEqual({ added: 2, removed: 0 });
    expect(await membersOf(id)).toEqual([tee, jeans].sort((x, y) => x - y));
    // A retry changes nothing.
    expect(
      (await api('PATCH', `/capsules/${id}/members`, { add: [tee] })).json(),
    ).toEqual({ added: 0, removed: 0 });
    // Members read as a garment list.
    const listed = await api('GET', `/garments?capsuleId=${id}`);
    expect(listed.json<{ total: number }>().total).toBe(2);

    const toggled = await api('PATCH', `/garments/${tee}/capsules`, {
      remove: [id],
    });
    expect(toggled.json()).toEqual({ added: 0, removed: 1 });
    expect(await membersOf(id)).toEqual([jeans]);

    const before = await membersOf(id);
    expectProblem(
      await api(
        'PATCH',
        `/capsules/${id}/members`,
        { remove: [jeans] },
        strangerToken,
      ),
      404,
      'not_found',
    );
    expectProblem(
      await api(
        'PATCH',
        `/garments/${jeans}/capsules`,
        { remove: [id] },
        strangerToken,
      ),
      404,
      'not_found',
    );
    expect(await membersOf(id)).toEqual(before);
    // Never coerced: ids are integers.
    expectProblem(
      await api('PATCH', `/capsules/${id}/members`, { add: [String(tee)] }),
      400,
      'validation',
    );
  });
});
