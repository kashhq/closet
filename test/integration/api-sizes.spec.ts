import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodyMeasurements } from '../../src/db/schema';
import { deviceToken, expectProblem } from './api';
import { createTestApp, type TestApp } from './harness';

/**
 * Sizes on /api/v1 (#588): each its page twin's read or writer, in
 * centimetres, a brand body judged by the editor's form reader. Who may do
 * what is the authorization matrix's (authorization-account.spec.ts
 * replays the brand rows' cases on these twins); what each costs is
 * api-statements'. Insights and the recap are today's (today.spec.ts).
 */

let t: TestApp;
let token: string;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => t.api(token, { method, url: `/api/v1${url}`, payload });

beforeAll(async () => {
  t = await createTestApp();
  token = (await deviceToken(t)).token;
});

afterAll(async () => {
  await t?.cleanup();
});

describe('measurements', () => {
  it('saves every length whole in centimetres, two decimals kept, and the unit apart', async () => {
    expect((await api('GET', '/sizes')).json()).toEqual({
      unit: 'in',
      measurements: {},
      brands: [],
    });
    const saved = await api('PUT', '/sizes/measurements', {
      height: 180.456,
      waist: 81.28,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ height: 180.46, waist: 81.28 });
    // Replaced whole: one absent or null is cleared, as the form saves.
    await api('PUT', '/sizes/measurements', { waist: 80, height: null });
    expect((await api('PUT', '/sizes/unit', { unit: 'cm' })).json()).toEqual({
      unit: 'cm',
    });
    expect((await api('GET', '/sizes')).json()).toMatchObject({
      unit: 'cm',
      measurements: { waist: 80 },
    });
    const [row] = await t.db
      .select({
        height: bodyMeasurements.heightCm,
        waist: bodyMeasurements.waistCm,
      })
      .from(bodyMeasurements);
    expect(row).toEqual({ height: null, waist: 80 });
  });

  it('refuses a length outside 1 to 300 cm, or typed as the form types it, naming the field', async () => {
    for (const chest of [301, 0.5, '90']) {
      const refused = expectProblem(
        await api('PUT', '/sizes/measurements', { chest }),
        400,
        'validation',
      );
      expect(refused.errors?.[0].path).toMatch(/^body\/chest/);
    }
  });
});

describe('brand sizes', () => {
  it('adds, finds whatever the case, changes and removes a note', async () => {
    const added = await api('POST', '/sizes/brands', {
      brand: '  Uniqlo ',
      size: 'xl',
    });
    expect(added.statusCode, added.body).toBe(201);
    const { id } = added.json<{ id: number }>();
    expect(added.json()).toEqual({ id, brand: 'Uniqlo', size: 'X-Large' });

    const found = await api('GET', '/sizes/brands?brand=UNIQLO');
    expect(found.json()).toEqual({ data: [added.json()] });
    expect((await api('GET', '/sizes/brands?brand=Cos')).json()).toEqual({
      data: [],
    });

    const changed = await api('PUT', `/sizes/brands/${id}`, {
      brand: 'Uniqlo',
      note: 'Runs small',
    });
    expect(changed.json()).toEqual({ id, brand: 'Uniqlo', note: 'Runs small' });
    expect((await api('GET', '/sizes')).json()).toMatchObject({
      brands: [{ id, brand: 'Uniqlo', note: 'Runs small' }],
    });

    expect((await api('DELETE', `/sizes/brands/${id}`)).statusCode).toBe(204);
    expectProblem(await api('DELETE', `/sizes/brands/${id}`), 404, 'not_found');
  });

  it("refuses what the editor's form refuses, under the field it names", async () => {
    const empty = expectProblem(
      await api('POST', '/sizes/brands', { brand: 'Arket' }),
      400,
      'validation',
    );
    expect(empty.errors?.map((e) => e.path)).toEqual(['body/size']);

    await api('POST', '/sizes/brands', { brand: 'Arket', size: 'M' });
    const taken = expectProblem(
      await api('POST', '/sizes/brands', { brand: 'ARKET', size: 'L' }),
      400,
      'validation',
    );
    expect(taken.errors?.map((e) => e.path)).toEqual(['body/brand']);
  });
});
