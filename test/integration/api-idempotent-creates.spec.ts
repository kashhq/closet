import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../src/calendar-date';
import { deviceToken, expectProblem } from './api';
import { createTestApp, type TestApp } from './harness';

/**
 * Every API create that stores the client's id (`createOnce`,
 * src/db/create-once.ts): the first answer is 201, a retry after a lost
 * answer is 200 with the same id (its body, even edited since, is ignored)
 * and creates nothing, and once the row is deleted the id is a 410 `gone`.
 * Outfits and calendar entries are idempotent by their own key and store
 * no id (outfits.spec, calendar specs); a saved look has none at all.
 */

interface Create {
  name: string;
  path: string;
  /** The body for the nth distinct create under `clientId`. */
  body: (n: number, clientId: string, today: IsoDate) => object;
  /** A body naming the same thing as `body(0)` under another client id: still a 400, when the name is unique. */
  sameNameRefused?: string;
}

const CREATES: Create[] = [
  {
    name: 'garments',
    path: '/garments',
    body: (n, clientId) => ({ name: `Once ${n}`, category: 'tops', clientId }),
  },
  {
    name: 'brand sizes',
    path: '/sizes/brands',
    body: (n, clientId) => ({ brand: `Brand ${n}`, size: 'M', clientId }),
    sameNameRefused: 'body/brand',
  },
  {
    name: 'capsules',
    path: '/capsules',
    body: (n, clientId) => ({ name: `Capsule ${n}`, clientId }),
    sameNameRefused: 'body/name',
  },
  {
    name: 'trips',
    path: '/trips',
    body: (n, clientId, today) => ({
      name: `Trip ${n}`,
      destination: 'Lisbon',
      startsOn: addDays(today, 40),
      endsOn: addDays(today, 42),
      clientId,
    }),
  },
];

let t: TestApp;
let token: string;

const api = (method: 'POST' | 'DELETE', url: string, payload?: object) =>
  t.api(token, { method, url: `/api/v1${url}`, payload });

beforeAll(async () => {
  t = await createTestApp();
  token = (await deviceToken(t)).token;
});

afterAll(async () => {
  await t?.cleanup();
});

describe.each(CREATES)('a retried create of $name', (create) => {
  it('answers 201, then 200 with the same id, then 410 once deleted', async () => {
    const clientId = randomUUID();
    const first = await api(
      'POST',
      create.path,
      create.body(0, clientId, t.today()),
    );
    expect(first.statusCode, first.body).toBe(201);
    const { id } = first.json<{ id: number }>();

    // Edited since the lost answer: the id names the create, not its body.
    const retry = await api(
      'POST',
      create.path,
      create.body(1, clientId, t.today()),
    );
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json<{ id: number }>().id).toBe(id);
    if (first.headers.location) {
      expect(retry.headers.location).toBe(first.headers.location);
    }

    // The retry made nothing: a distinct id makes a distinct row.
    const other = await api(
      'POST',
      create.path,
      create.body(2, randomUUID(), t.today()),
    );
    expect(other.statusCode, other.body).toBe(201);
    expect(other.json<{ id: number }>().id).not.toBe(id);

    expect((await api('DELETE', `${create.path}/${id}`)).statusCode).toBe(204);
    expectProblem(
      await api('POST', create.path, create.body(0, clientId, t.today())),
      410,
      'gone',
    );
  });

  it.skipIf(!create.sameNameRefused)(
    'is still a 400 for another client id on a taken name',
    async () => {
      expect(
        (
          await api(
            'POST',
            create.path,
            create.body(7, randomUUID(), t.today()),
          )
        ).statusCode,
      ).toBe(201);
      const taken = expectProblem(
        await api('POST', create.path, create.body(7, randomUUID(), t.today())),
        400,
        'validation',
      );
      expect(taken.errors?.map((e) => e.path)).toEqual([
        create.sameNameRefused,
      ]);
    },
  );
});
