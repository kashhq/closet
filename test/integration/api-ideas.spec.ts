import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  generatorAvoid,
  outfit,
  outfitCalendar,
  userWeather,
} from '../../src/db/schema';
import { addOutfitRule } from '../../src/web/style/queries';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import { deviceToken, expectProblem } from './api';
import { createGarment } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * Ideas, the pick, clashes and the temperature feedback on /api/v1
 * (#193c): each its page twin's domain function (ideasFor's statement,
 * pickGarments, avoidPair and allowPair, nudgeTemperatureOffset). Who may
 * do what is the authorization matrix's (authorization-outfits.spec.ts and
 * authorization-trips.spec.ts replay their cases on these twins); what
 * each costs is api-statements'. The generator's own rules are
 * generator.spec.ts' and gallery.spec.ts'.
 */

let t: TestApp;
let stub: WeatherStub;
let token: string;
let strangerToken: string;
const closet = { tops: [] as number[], bottoms: [] as number[], shoes: 0 };

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

interface IdeaList {
  data: { name: string; garments: { id: number }[]; problems: string[] }[];
  pagination: { nextCursor?: string; limit: number };
  seed: number;
  day: string;
  occasion: string;
}

beforeAll(async () => {
  stub = await startWeatherStub();
  t = await createTestApp(
    { WEATHER_ENABLED: 'true' },
    { weather: stub.options },
  );
  token = (await deviceToken(t)).token;
  const email = 'api-ideas-stranger@example.com';
  await t.register(email);
  strangerToken = (await deviceToken(t, { email })).token;
  for (let i = 0; i < 3; i += 1) {
    closet.tops.push(
      await createGarment(t, { name: `Tee ${i}`, category: 'tops' }),
    );
    closet.bottoms.push(
      await createGarment(t, { name: `Jeans ${i}`, category: 'bottoms' }),
    );
  }
  closet.shoes = await createGarment(t, {
    name: 'Trainers',
    category: 'footwear',
  });
});

afterAll(async () => {
  await t?.cleanup();
  await stub?.close();
});

describe('ideas', () => {
  it("pages the day's seeded ideas: the cursor continues them, the same seed is the same ideas", async () => {
    const first = await api('GET', '/ideas?limit=2');
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json<IdeaList>();
    expect(page1).toMatchObject({
      day: t.today(),
      occasion: 'all-day',
      pagination: { limit: 2 },
    });
    expect(page1.data).toHaveLength(2);
    expect(page1.data[0].garments.map((g) => g.id)).toContain(closet.shoes);
    const page2 = (
      await api('GET', `/ideas?limit=2&cursor=${page1.pagination.nextCursor!}`)
    ).json<IdeaList>();
    const four = (
      await api('GET', `/ideas?limit=4&seed=${page1.seed}`)
    ).json<IdeaList>();
    expect([...page1.data, ...page2.data]).toEqual(four.data);
    // No weather here (no location): the field is left out.
    expect(four).not.toHaveProperty('weather');

    expectProblem(await api('GET', '/ideas?cursor=bm9wZQ'), 400, 'validation');
    expectProblem(
      await api('GET', '/ideas?occasion=brunch'),
      400,
      'validation',
    );
  });

  it('says why a workout has no idea: this closet has no activewear (#647)', async () => {
    const res = await api('GET', '/ideas?occasion=workout');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<IdeaList & { emptyReason?: string }>()).toMatchObject({
      data: [],
      emptyReason: 'no-activewear',
    });
    expect((await api('GET', '/ideas')).json()).not.toHaveProperty(
      'emptyReason',
    );
  });

  it('holds every garment sent in `with`; one not in your closet, or a capsule not yours, is a 404', async () => {
    const [top] = closet.tops;
    const [bottom] = closet.bottoms;
    const res = await api('GET', `/ideas?with=${top}&with=${bottom}&limit=3`);
    expect(res.statusCode, res.body).toBe(200);
    const ideas = res.json<IdeaList>().data;
    expect(ideas.length).toBeGreaterThan(0);
    for (const idea of ideas) {
      expect(idea.garments.map((g) => g.id)).toEqual(
        expect.arrayContaining([top, bottom]),
      );
    }
    expectProblem(
      await api('GET', `/ideas?with=${top}`, undefined, strangerToken),
      404,
      'not_found',
    );
    expectProblem(
      await api('GET', '/ideas?capsuleId=2147483647'),
      404,
      'not_found',
    );
  });

  it('flags an idea whose locked garments break one of your outfit rules (breaks-rule), naming it', async () => {
    const [, top] = closet.tops;
    const [, bottom] = closet.bottoms;
    const none = {
      garmentId: null,
      category: null,
      type: null,
      color: null,
      pattern: null,
    };
    const ruleId = await addOutfitRule(
      t.db,
      { userId: t.owner.id, surface: 'page' },
      {
        kind: 'never',
        a: { ...none, garmentId: top },
        b: { ...none, garmentId: bottom },
      },
    );
    expect(typeof ruleId).toBe('number');
    const res = await api('GET', `/ideas?with=${top}&with=${bottom}&limit=1`);
    const [idea] = res.json<{
      data: { fits: boolean; problems: string[]; brokenRules: string[] }[];
    }>().data;
    expect(idea.fits).toBe(false);
    expect(idea.problems).toContain('breaks-rule');
    expect(idea.brokenRules).toEqual([expect.stringContaining('Tee 1')]);
  });
});

describe('the pick', () => {
  it('saves once: 201 with its Location, then 200 alreadySaved, planned when asked', async () => {
    const garmentIds = [closet.tops[2], closet.bottoms[2], closet.shoes];
    const day = addDays(t.today(), 3);
    const made = await api('POST', '/outfit-picks', {
      garmentIds,
      clientId: '9a1d6c1e-2f4a-4b5c-8d6e-7f8091a2b3c4',
    });
    expect(made.statusCode, made.body).toBe(201);
    const { id } = made.json<{ id: number }>();
    expect(made.headers.location).toBe(`/api/v1/outfits/${id}`);
    expect(made.json()).toEqual({ id, alreadySaved: false });
    const [saved] = await t.db
      .select({ name: outfit.name })
      .from(outfit)
      .where(eq(outfit.id, id));
    expect(saved.name).toBe('Tee 2, Jeans 2, Trainers');

    const planned = await api('POST', '/outfit-picks', {
      garmentIds: [...garmentIds].reverse(),
      plan: { day, occasion: 'evening' },
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json()).toEqual({
      id,
      alreadySaved: true,
      schedule: 'scheduled',
    });
    expect(
      await t.db.$count(
        outfitCalendar,
        and(eq(outfitCalendar.outfitId, id), eq(outfitCalendar.day, day)),
      ),
    ).toBe(1);
  });

  it("refuses another's garments (404, nothing written) and a string id", async () => {
    const before = await t.db.$count(outfit);
    const refused = await api(
      'POST',
      '/outfit-picks',
      { garmentIds: [closet.tops[0]] },
      strangerToken,
    );
    expectProblem(refused, 404, 'not_found');
    expect(refused.body).not.toContain('Tee 0');
    expectProblem(
      await api('POST', '/outfit-picks', {
        garmentIds: [String(closet.tops[0])],
      }),
      400,
      'validation',
    );
    expect(await t.db.$count(outfit)).toBe(before);
  });

  it("puts an idea in an entry's place: the outfit of its garments, saved when new", async () => {
    const planned = await api('POST', '/outfit-picks', {
      garmentIds: [closet.tops[0]],
      plan: { day: addDays(t.today(), 4) },
    });
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, planned.json<{ id: number }>().id));
    const change = (payload: object) =>
      api('PUT', `/calendar-entries/${entry.id}/outfit`, payload);
    const changed = await change({
      garmentIds: [closet.tops[1], closet.bottoms[0]],
      name: 'Swapped in',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const { outfitId } = changed.json<{ outfitId: number }>();
    expect(changed.json()).toMatchObject({
      outcome: 'replaced',
      alreadySaved: false,
    });
    const [row] = await t.db
      .select({ name: outfit.name })
      .from(outfit)
      .where(eq(outfit.id, outfitId));
    expect(row.name).toBe('Swapped in');
    expectProblem(
      await change({ outfitId, garmentIds: [closet.tops[1]] }),
      400,
      'validation',
    );
    expectProblem(await change({}), 400, 'validation');
  });
});

describe('clashes', () => {
  it('avoids a pair once and allows it again; only between your own garments', async () => {
    const [a] = closet.tops;
    const [, b] = closet.bottoms;
    const clash = (method: 'PUT' | 'DELETE', as = token, x = a, y = b) =>
      api(method, `/garments/${x}/clashes/${y}`, undefined, as);
    const pairs = () =>
      t.db.$count(generatorAvoid, eq(generatorAvoid.ownerId, t.owner.id));

    expectProblem(await clash('PUT', strangerToken), 404, 'not_found');
    expectProblem(await clash('PUT', token, a, a), 404, 'not_found');
    expect(await pairs()).toBe(0);
    expect((await clash('PUT')).json()).toEqual({ changed: true });
    // Either order is the pair.
    expect((await clash('PUT', token, b, a)).json()).toEqual({
      changed: false,
    });
    expect(await pairs()).toBe(1);
    const ideas = (
      await api('GET', `/ideas?with=${a}&limit=6`)
    ).json<IdeaList>().data;
    expect(ideas.some((idea) => idea.garments.some((g) => g.id === b))).toBe(
      false,
    );

    expectProblem(await clash('DELETE', strangerToken), 404, 'not_found');
    expect((await clash('DELETE')).statusCode).toBe(204);
    expect(await pairs()).toBe(0);
    expectProblem(await clash('DELETE'), 404, 'not_found');
  });
});

describe('the temperature feedback', () => {
  it('moves your offset a step per call, within its limit', async () => {
    const feedback = (feeling: string) =>
      api('POST', '/weather/feedback', { feeling });
    expect((await feedback('too-warm')).json()).toEqual({ offset: 0.5 });
    expect((await feedback('too-cold')).json()).toEqual({ offset: 0 });
    expectProblem(await feedback('too-wet'), 400, 'validation');
    const [row] = await t.db
      .select({ offset: userWeather.temperatureOffset })
      .from(userWeather)
      .where(eq(userWeather.userId, t.owner.id));
    expect(row.offset).toBe(0);
  });
});
