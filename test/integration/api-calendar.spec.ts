import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../src/calendar-date';
import {
  garmentWear,
  outfitCalendar,
  selfie,
  weekPlan,
} from '../../src/db/schema';
import { t as text } from '../../src/web/i18n';
import { deviceToken, expectProblem } from './api';
import { createGarment, jpegPhoto } from './garments';
import { createTestApp, multipart, type TestApp } from './harness';

/**
 * The calendar, Today's Wear this, outfit selfies and the week plan on
 * /api/v1 (#193b, #193c): each its page twin's domain function with a
 * JSON (or, for a selfie, multipart) body. Who may do what
 * is the authorization matrix's (authorization-outfits.spec.ts and
 * authorization-account.spec.ts replay their cases on these twins); what
 * each costs is api-statements'.
 */

let t: TestApp;
let token: string;
let strangerToken: string;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

/** A new outfit of one new garment of the owner's (one set, one outfit). */
async function newOutfit(
  name: string,
): Promise<{ id: number; garment: number }> {
  const garment = await createGarment(t, { name, category: 'tops' });
  const made = await api('POST', '/outfits', {
    name,
    slots: [{ category: 'shirt', garmentId: garment }],
  });
  expect(made.statusCode, made.body).toBe(201);
  return { id: made.json<{ id: number }>().id, garment };
}

interface Scheduled {
  id: number;
  outcome: string;
  occasion: string;
}

const schedule = async (outfitId: number, day: IsoDate, occasion?: string) => {
  const res = await api('POST', '/calendar-entries', {
    outfitId,
    day,
    ...(occasion && { occasion }),
  });
  expect([200, 201], res.body).toContain(res.statusCode);
  return res.json<Scheduled>();
};

const entryRow = async (id: number) => {
  const [row] = await t.db
    .select({
      outfitId: outfitCalendar.outfitId,
      plannedBy: outfitCalendar.plannedBy,
      wornAt: outfitCalendar.wornAt,
    })
    .from(outfitCalendar)
    .where(eq(outfitCalendar.id, id));
  return row;
};

beforeAll(async () => {
  t = await createTestApp();
  token = (await deviceToken(t)).token;
  const email = 'api-calendar-stranger@example.com';
  await t.register(email);
  strangerToken = (await deviceToken(t, { email })).token;
});

afterAll(async () => {
  await t?.cleanup();
});

describe('calendar entries', () => {
  it('plans once per outfit and day: 201, then 200 with the entry and the occasion it kept', async () => {
    const { id: outfitId } = await newOutfit('Planned once');
    const day = addDays(t.today(), 2);
    const made = await api('POST', '/calendar-entries', {
      outfitId,
      day,
      occasion: 'evening',
      clientId: '3b0d6c1e-2f4a-4b5c-8d6e-7f8091a2b3c4',
    });
    expect(made.statusCode, made.body).toBe(201);
    const { id } = made.json<Scheduled>();
    expect(made.json()).toEqual({
      id,
      outcome: 'scheduled',
      occasion: 'evening',
    });
    expect(t.logs.ops('calendar.entry.planned').at(-1)).toMatchObject({
      entryId: id,
      surface: 'api',
      changed: true,
      clientId: '3b0d6c1e',
    });

    const again = await api('POST', '/calendar-entries', { outfitId, day });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({
      id,
      outcome: 'already-scheduled',
      occasion: 'evening',
    });
    expect(
      await t.db.$count(outfitCalendar, eq(outfitCalendar.outfitId, outfitId)),
    ).toBe(1);
  });

  it("refuses another's outfit (404), a string id (never coerced) and an unknown occasion", async () => {
    const { id: outfitId } = await newOutfit('Not theirs');
    const day = t.today();
    expectProblem(
      await api('POST', '/calendar-entries', { outfitId, day }, strangerToken),
      404,
      'not_found',
    );
    expectProblem(
      await api('POST', '/calendar-entries', {
        outfitId: String(outfitId),
        day,
      }),
      400,
      'validation',
    );
    expectProblem(
      await api('POST', '/calendar-entries', {
        outfitId,
        day,
        occasion: 'brunch',
      }),
      400,
      'validation',
    );
    expect(
      await t.db.$count(outfitCalendar, eq(outfitCalendar.outfitId, outfitId)),
    ).toBe(0);
  });

  it('lists a range of days, this week from today unless asked, by day then occasion; at most 62 days', async () => {
    const today = t.today();
    const day = addDays(today, 3);
    const evening = await newOutfit('Listed evening');
    const work = await newOutfit('Listed work');
    const late = await schedule(evening.id, day, 'evening');
    const early = await schedule(work.id, day, 'work');
    await schedule((await newOutfit('Next week')).id, addDays(today, 7));

    const week = await api('GET', '/calendar-entries');
    expect(week.statusCode, week.body).toBe(200);
    const body = week.json<{
      from: IsoDate;
      to: IsoDate;
      data: { id: number; day: IsoDate }[];
    }>();
    expect(body).toMatchObject({ from: today, to: addDays(today, 6) });
    expect(body.data.every((entry) => entry.day <= addDays(today, 6))).toBe(
      true,
    );
    // `to` alone is the week up to it (#570): the week that ended yesterday.
    const yesterday = addDays(today, -1);
    const ended = await api('GET', `/calendar-entries?to=${yesterday}`);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({
      from: addDays(yesterday, -6),
      to: yesterday,
    });

    const one = await api('GET', `/calendar-entries?from=${day}&to=${day}`);
    expect(one.json<{ data: unknown[] }>().data).toEqual([
      {
        id: early.id,
        day,
        occasion: 'work',
        worn: false,
        plannedBy: 'user',
        outfit: {
          id: work.id,
          name: 'Listed work',
          garments: [
            {
              id: work.garment,
              name: 'Listed work',
              category: 'tops',
              role: 'top',
              status: 'closet',
            },
          ],
        },
      },
      expect.objectContaining({ id: late.id, occasion: 'evening' }),
    ]);
    // Entries are private: a stranger's calendar that day is empty.
    const theirs = await api(
      'GET',
      `/calendar-entries?from=${day}&to=${day}`,
      undefined,
      strangerToken,
    );
    expect(theirs.json<{ data: unknown[] }>().data).toEqual([]);

    expectProblem(
      await api(
        'GET',
        `/calendar-entries?from=${today}&to=${addDays(today, 62)}`,
      ),
      400,
      'validation',
    );
    expectProblem(
      await api('GET', `/calendar-entries?from=${day}&to=${today}`),
      400,
      'validation',
    );
  });

  it("changes an entry's outfit in place, set-state; a worn entry and an outfit on the day already are 409s", async () => {
    const today = t.today();
    const first = await newOutfit('Replaced');
    const second = await newOutfit('Replacement');
    const entry = await schedule(first.id, today, 'daytime');
    const change = (outfitId: number, as = token) =>
      api('PUT', `/calendar-entries/${entry.id}/outfit`, { outfitId }, as);

    const changed = await change(second.id);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({
      outcome: 'replaced',
      day: today,
      occasion: 'daytime',
      outfitId: second.id,
      previousOutfitId: first.id,
      selfieKeptAsLook: false,
      plannerOutfitRemoved: false,
    });
    expect((await change(second.id)).json()).toMatchObject({
      outcome: 'unchanged',
    });
    expect((await entryRow(entry.id)).outfitId).toBe(second.id);

    // Each body fault is named at its own field.
    const both = expectProblem(
      await api('PUT', `/calendar-entries/${entry.id}/outfit`, {
        outfitId: second.id,
        garmentIds: [1],
      }),
      400,
      'validation',
    );
    expect(both.errors?.map(({ path }) => path)).toEqual(['body/outfitId']);
    expect(both.errors?.[0]?.message).toBe(text('api.OUTFIT_ONE_OF'));
    const named = expectProblem(
      await api('PUT', `/calendar-entries/${entry.id}/outfit`, {
        outfitId: second.id,
        name: 'Nope',
      }),
      400,
      'validation',
    );
    expect(named.errors?.map(({ path }) => path)).toEqual(['body/name']);
    expect(named.errors?.[0]?.message).toBe(
      text('api.OUTFIT_NAME_NEEDS_GARMENTS'),
    );

    // The first outfit on the day again: the entry would hold it twice.
    await schedule(first.id, today, 'evening');
    expectProblem(await change(first.id), 409, 'conflict');
    expectProblem(await change(second.id, strangerToken), 404, 'not_found');

    await api('PUT', `/calendar-entries/${entry.id}/worn`, { worn: true });
    expectProblem(
      await change((await newOutfit('Too late')).id),
      409,
      'conflict',
    );
  });

  it("marks an entry worn and not, its wears with it; a day ahead is a 409, another's entry a 404", async () => {
    const today = t.today();
    const { id: outfitId, garment } = await newOutfit('Worn entry');
    const entry = await schedule(outfitId, today);
    const worn = (id: number, value: boolean, as = token) =>
      api('PUT', `/calendar-entries/${id}/worn`, { worn: value }, as);
    const wears = () =>
      t.db.$count(garmentWear, eq(garmentWear.garmentId, garment));

    expect((await worn(entry.id, true)).json()).toEqual({
      day: today,
      worn: true,
      changed: true,
      wears: 1,
    });
    expect(await wears()).toBe(1);
    expect((await worn(entry.id, true)).json()).toMatchObject({
      changed: false,
    });
    expect((await worn(entry.id, false)).json()).toEqual({
      day: today,
      worn: false,
      changed: true,
      wears: 1,
    });
    expect(await wears()).toBe(0);

    const ahead = await schedule(outfitId, addDays(today, 1));
    expectProblem(await worn(ahead.id, true), 409, 'conflict');
    expect((await entryRow(ahead.id)).wornAt).toBeNull();
    expectProblem(await worn(entry.id, true, strangerToken), 404, 'not_found');
    expectProblem(
      await api('PUT', `/calendar-entries/${entry.id}/worn`, { worn: 1 }),
      400,
      'validation',
    );
  });

  it('deletes an entry once: 204, then the 404 a retry reads as done', async () => {
    const { id: outfitId } = await newOutfit('Deleted entry');
    const entry = await schedule(outfitId, t.today());
    const del = (as = token) =>
      api('DELETE', `/calendar-entries/${entry.id}`, undefined, as);
    expectProblem(await del(strangerToken), 404, 'not_found');
    expect((await del()).statusCode).toBe(204);
    expect(
      await t.db.$count(outfitCalendar, eq(outfitCalendar.id, entry.id)),
    ).toBe(0);
    expectProblem(await del(), 404, 'not_found');
  });
});

describe("Today's Wear this", () => {
  it('saves, plans and wears the garments on the day once; outside the window is a 409', async () => {
    const today = t.today();
    const day = addDays(today, -1);
    const top = await createGarment(t, { name: 'Worn top', category: 'tops' });
    const bottom = await createGarment(t, {
      name: 'Worn jeans',
      category: 'bottoms',
    });
    const wear = (payload: object, as = token) =>
      api('POST', '/outfit-wears', payload, as);
    const payload = { garmentIds: [top, bottom], occasion: 'work', day };

    const first = await wear(payload);
    expect(first.statusCode, first.body).toBe(200);
    const worn = first.json<{ outfitId: number; entryId: number }>();
    expect(first.json()).toEqual({
      outfitId: worn.outfitId,
      alreadySaved: false,
      entryId: worn.entryId,
      changed: true,
      wears: 2,
    });
    const [entry] = await t.db
      .select({ day: outfitCalendar.day, occasion: outfitCalendar.occasion })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.id, worn.entryId));
    expect(entry).toEqual({ day, occasion: 'work' });

    expect((await wear(payload)).json()).toEqual({
      ...worn,
      alreadySaved: true,
      changed: false,
      wears: 0,
    });
    expectProblem(
      await wear({ ...payload, day: addDays(today, -8) }),
      409,
      'conflict',
    );
    expectProblem(
      await wear({ ...payload, day: addDays(today, 1) }),
      409,
      'conflict',
    );
    // Not the stranger's closet: a 404 naming nothing, nothing written.
    const before = await t.db.$count(outfitCalendar);
    const refused = await wear(payload, strangerToken);
    expectProblem(refused, 404, 'not_found');
    expect(refused.body).not.toContain('Worn top');
    expect(await t.db.$count(outfitCalendar)).toBe(before);
  });
});

describe('outfit selfies', () => {
  const upload = async (entryId: number, as = token) =>
    t.api(as, {
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

  it("takes an entry's selfie, marking it worn, then replaces it; another's entry is a 404, a day ahead a 409", async () => {
    const { id: outfitId } = await newOutfit('Mirror look');
    const entry = await schedule(outfitId, t.today());
    const before = await t.db.$count(selfie);
    expectProblem(await upload(entry.id, strangerToken), 404, 'not_found');
    const ahead = await schedule(outfitId, addDays(t.today(), 1));
    expectProblem(await upload(ahead.id), 409, 'conflict');
    expect(await t.db.$count(selfie)).toBe(before);

    const taken = await upload(entry.id);
    expect(taken.statusCode, taken.body).toBe(200);
    const { selfieId } = taken.json<{ selfieId: number }>();
    expect(taken.json()).toEqual({
      selfieId,
      day: t.today(),
      replaced: false,
      worn: { changed: true, wears: 1 },
    });
    expect((await entryRow(entry.id)).wornAt).not.toBeNull();
    expect((await upload(entry.id)).json()).toEqual({
      selfieId,
      day: t.today(),
      replaced: true,
      worn: { changed: false, wears: 0 },
    });
    // Private: the entry's resource names it by id, never by a URL.
    const listed = await api(
      'GET',
      `/calendar-entries?from=${t.today()}&to=${t.today()}`,
    );
    expect(listed.json<{ data: { selfieId?: number }[] }>().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ selfieId })]),
    );
  });

  it("serves the owner's selfie bytes as the page does, a problem 404 to anyone else, once replaced or removed", async () => {
    const { id: outfitId } = await newOutfit('Photo look');
    const entry = await schedule(outfitId, t.today());
    const { selfieId } = (await upload(entry.id)).json<{ selfieId: number }>();
    const photoUrls = async () => {
      const [found] = (
        await api('GET', `/calendar-entries?from=${t.today()}&to=${t.today()}`)
      )
        .json<{
          data: {
            id: number;
            selfiePhoto?: { originalUrl: string; thumbUrl: string };
          }[];
        }>()
        .data.filter((e) => e.id === entry.id);
      return found.selfiePhoto!;
    };
    const { originalUrl, thumbUrl } = await photoUrls();
    expect(thumbUrl).toMatch(/\?v=\d+&variant=thumb$/);
    const fileName = originalUrl.split('/').pop()!.split('?')[0];

    for (const url of [originalUrl, thumbUrl]) {
      const bytes = await t.api(token, { method: 'GET', url });
      expect(bytes.statusCode, url).toBe(200);
      expect(bytes.headers['content-type']).toBe('image/webp');
      expect(bytes.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
      const refused = await t.api(strangerToken, { method: 'GET', url });
      expectProblem(refused, 404, 'not_found');
      expect(refused.headers['cache-control']).toBe('no-store');
      expect(refused.body).not.toContain(fileName);
    }

    // A replacement keeps the selfie's id but is another photo: the old URL is gone.
    expect((await upload(entry.id)).json<{ selfieId: number }>().selfieId).toBe(
      selfieId,
    );
    expectProblem(
      await t.api(token, { method: 'GET', url: originalUrl }),
      404,
      'not_found',
    );
    const replaced = await photoUrls();
    expect(replaced.originalUrl).not.toBe(originalUrl);
    expect(
      (await t.api(token, { method: 'GET', url: replaced.thumbUrl }))
        .statusCode,
    ).toBe(200);

    await api('DELETE', `/selfies/${selfieId}`);
    expectProblem(
      await t.api(token, { method: 'GET', url: replaced.originalUrl }),
      404,
      'not_found',
    );
  });

  it('removes a selfie once, the entry still worn: 204, then the 404 a retry reads as done', async () => {
    const { id: outfitId } = await newOutfit('Removed look');
    const entry = await schedule(outfitId, t.today());
    const { selfieId } = (await upload(entry.id)).json<{ selfieId: number }>();
    const remove = (as = token) =>
      api('DELETE', `/selfies/${selfieId}`, undefined, as);
    expectProblem(await remove(strangerToken), 404, 'not_found');
    expect((await remove()).statusCode).toBe(204);
    expect(await t.db.$count(selfie, eq(selfie.id, selfieId))).toBe(0);
    expect((await entryRow(entry.id)).wornAt).not.toBeNull();
    expectProblem(await remove(), 404, 'not_found');
  });
});

describe('the week plan', () => {
  const nightsOut = {
    days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      around: ['night-out'],
    })),
  };

  it('reads and saves the template whole; a weekday twice is a 400', async () => {
    const empty = await api('GET', '/week-template', undefined, strangerToken);
    expect(empty.json<{ days: unknown[] }>().days).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, around: [] })),
    );
    const saved = await api(
      'PUT',
      '/week-template',
      {
        days: [
          {
            weekday: 1,
            day: 'work',
            around: ['evening', 'workout', 'workout'],
          },
          { weekday: 6, day: null },
        ],
      },
      strangerToken,
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const monday = { weekday: 1, day: 'work', around: ['workout', 'evening'] };
    expect(saved.json<{ days: unknown[] }>().days[1]).toEqual(monday);
    const read = await api('GET', '/week-template', undefined, strangerToken);
    expect(read.json()).toEqual(saved.json());

    expectProblem(
      await api(
        'PUT',
        '/week-template',
        {
          days: [
            { weekday: 2, day: 'work' },
            { weekday: 2, day: 'daytime' },
          ],
        },
        strangerToken,
      ),
      400,
      'validation',
    );
    // An occasion around the day is not the day's outfit.
    expectProblem(
      await api(
        'PUT',
        '/week-template',
        { days: [{ weekday: 2, day: 'evening' }] },
        strangerToken,
      ),
      400,
      'validation',
    );
    // Refused whole: the saved week stands.
    expect(
      (await api('GET', '/week-template', undefined, strangerToken)).json(),
    ).toEqual(saved.json());
  });

  it('plans the week once, says so without a template; planning a planned entry takes it over, and Undo leaves it', async () => {
    const email = 'api-week-unset@example.com';
    await t.register(email);
    const unset = (await deviceToken(t, { email })).token;
    const none = await api('POST', '/week-plans', undefined, unset);
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json()).toEqual({
      from: t.today(),
      templateSet: false,
      planned: [],
      unfilled: [],
      away: [],
      weatherDays: 0,
    });

    expect((await api('PUT', '/week-template', nightsOut)).statusCode).toBe(
      200,
    );
    for (const [category, count] of [
      ['tops', 7],
      ['bottoms', 3],
    ] as const) {
      for (let i = 0; i < count; i += 1) {
        await createGarment(t, { name: `Week ${category} ${i}`, category });
      }
    }
    const planned = await api('POST', '/week-plans');
    expect(planned.statusCode, planned.body).toBe(200);
    const plan = planned.json<{
      weekPlanId: number;
      planned: { entryId: number; day: IsoDate; occasion: string }[];
    }>();
    expect(plan.weekPlanId).toBeGreaterThan(0);
    expect(plan.planned.length).toBeGreaterThan(0);
    expect(plan.planned.every((p) => p.occasion === 'night-out')).toBe(true);
    expect((await entryRow(plan.planned[0].entryId)).plannedBy).toBe('auto');

    // A retry plans nothing: every slot it could fill is filled.
    const again = await api('POST', '/week-plans');
    expect(again.json()).not.toHaveProperty('weekPlanId');
    expect(again.json<{ planned: unknown[] }>().planned).toEqual([]);

    // Planning what the planner planned (#571): that entry, now the user's,
    // out of the re-plan's and Undo's reach; said once.
    const [taken] = plan.planned;
    const { outfitId } = await entryRow(taken.entryId);
    const adopt = () =>
      api('POST', '/calendar-entries', {
        outfitId,
        day: taken.day,
        occasion: taken.occasion,
      });
    const adopted = await adopt();
    expect(adopted.statusCode, adopted.body).toBe(200);
    expect(adopted.json()).toEqual({
      id: taken.entryId,
      outcome: 'already-scheduled',
      occasion: taken.occasion,
      adopted: true,
    });
    expect((await entryRow(taken.entryId)).plannedBy).toBe('user');
    expect((await adopt()).json()).not.toHaveProperty('adopted');

    const undo = (as = token) =>
      api('DELETE', `/week-plans/${plan.weekPlanId}`, undefined, as);
    expectProblem(await undo(strangerToken), 404, 'not_found');
    const undone = await undo();
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<{ entriesRemoved: number }>().entriesRemoved).toBe(
      plan.planned.length - 1,
    );
    // The taken entry stays, and so does the batch that planned it: Undo
    // again removes nothing.
    expect(await entryRow(taken.entryId)).toBeDefined();
    expect(await t.db.$count(weekPlan, eq(weekPlan.id, plan.weekPlanId))).toBe(
      1,
    );
    expect((await undo()).json()).toMatchObject({ entriesRemoved: 0 });
  });
});
