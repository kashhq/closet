import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatorAvoid, outfitRule, styleProfile } from '../../src/db/schema';
import { avoidPair } from '../../src/web/gallery/queries';
import { saveWeekTemplate } from '../../src/web/week-plan/template';
import { findWeatherSettings, setHome } from '../../src/web/weather/queries';
import { recordStatements } from '../support/query-recorder';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import { createGarment } from './garments';
import {
  asFixture,
  createTestApp,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectFullPage } from './pages';

/**
 * The style profile (#34, slice 34a; src/web/style/AGENTS.md), through
 * HTTP: the form saves every part and shows it again, its sets only take
 * their own values, the week's rhythm and the home city are shown
 * read-only from where they live, and nobody else reads it. Moved whole
 * from the wardrobe plans' spec when plans went (#337). Its outfit rules
 * (#21b): added, refused with a message, removed, and the avoided pairs'
 * undo. The matrix rows are authorization-account.spec.ts's.
 */
describe('the style profile', () => {
  let t: TestApp;
  let ownerId: number;
  let stranger: string;

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: object, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    stranger = await t.register('stranger-style@example.com');
  });

  afterAll(() => t?.cleanup());

  it('starts empty, saves every part, and shows it again', async () => {
    const blank = await get('/auth/profile/style');
    expect(blank.statusCode).toBe(200);
    expectFullPage(blank);
    expect(blank.body).toContain('Style profile');
    expect(blank.body).not.toMatch(/value="smart-casual"[^>]*checked/);

    const res = await post('/auth/profile/style', {
      styles: ['smart-casual', 'elevated-basics'],
      budget: 'mid',
      palette: ['blue', 'white', 'grey'],
      notes: '  Office three days  ',
      // A page cached before #16 still posts the rhythm: stripped, unread.
      'times-work': '3',
      'per-work': 'week',
    });
    expect(res.statusCode, res.body).toBe(303);
    expect(res.headers.location).toBe('/auth/profile/style?saved=profile');
    const [row] = await t.db
      .select()
      .from(styleProfile)
      .where(eq(styleProfile.userId, ownerId));
    // Sets in their list's order, whatever the post's.
    expect(row).toMatchObject({
      styles: ['elevated-basics', 'smart-casual'],
      budget: 'mid',
      palette: ['blue', 'white', 'grey'],
      notes: 'Office three days',
    });
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      `Style profile saved by user ${ownerId}: 2 styles, 3 colours`,
    );

    const page = await get('/auth/profile/style?saved=profile');
    expectFullPage(page);
    expect(page.body).toContain('Style profile saved');
    expect(page.body).toMatch(/value="smart-casual"[^>]*checked/);
    expect(page.body).not.toContain('name="times-work"');
  });

  it("shows the week's rhythm read-only, derived from the week template (#16)", async () => {
    const unset = await get('/auth/profile/style');
    expect(unset.body).toContain('Not set yet');
    expect(unset.body).toContain('href="/auth/profile#week"');
    await saveWeekTemplate(t.db, ownerId, [
      { weekday: 1, occasion: 'work' },
      { weekday: 2, occasion: 'work' },
      { weekday: 2, occasion: 'workout' },
      { weekday: 6, occasion: 'daytime' },
    ]);
    const page = unescapeHtml((await get('/auth/profile/style')).body);
    expect(
      [...page.matchAll(/<li data-occasion="([\w-]+)">([^<]+)</g)].map(
        ([, occasion, text]) => [occasion, text],
      ),
    ).toEqual([
      ['workout', 'Workout 1× a week'],
      ['work', 'Work 2× a week'],
      ['daytime', 'Daytime 1× a week'],
    ]);
    await saveWeekTemplate(t.db, ownerId, []);
  });

  it('clears the sets on the next save', async () => {
    const res = await post('/auth/profile/style', { budget: '' });
    expect(res.statusCode).toBe(303);
    const [row] = await t.db
      .select()
      .from(styleProfile)
      .where(eq(styleProfile.userId, ownerId));
    expect(row).toMatchObject({
      styles: null,
      budget: null,
      palette: null,
      notes: null,
    });
  });

  it('refuses a style outside the set', async () => {
    const outside = await post('/auth/profile/style', { styles: ['goth'] });
    expect(outside.statusCode).toBe(400);
    const [row] = await t.db
      .select({ styles: styleProfile.styles })
      .from(styleProfile)
      .where(eq(styleProfile.userId, ownerId));
    expect(row.styles).toBeNull();
  });

  it('is the user’s own: another user sees theirs, empty', async () => {
    const theirs = await get('/auth/profile/style', { cookie: stranger });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body).not.toMatch(/value="smart-casual"[^>]*checked/);
  });

  it('is linked from the profile', async () => {
    const profile = await get('/auth/profile');
    expect(profile.body).toContain('href="/auth/profile/style"');
  });

  it('says nothing of a home city with the weather off', async () => {
    const page = await get('/auth/profile/style');
    expect(page.body).not.toContain('id="style-home"');
  });

  // A round trip per statement in production (#156): the session, then
  // the profile, the week template and the outfit rules' parts in one
  // statement (#251; it was one each), and no weather read with the
  // weather off.
  it('reads the page in 2 statements', async () => {
    const { result, statements } = await recordStatements(() =>
      get('/auth/profile/style'),
    );
    expect(result.statusCode).toBe(200);
    expect(statements).toHaveLength(2); // 3 before #251
    for (const table of [
      'style_profile',
      'week_template',
      'outfit_rule',
      'garment',
      'generator_avoid',
    ]) {
      expect(statements[1].sql).toContain(`"${table}"`);
    }
    expect(statements[1].sql).not.toContain('"user_weather"');
  });

  describe('outfit rules (#21b)', () => {
    const RULES = '/auth/profile/style/rules';
    const ADDED = '/auth/profile/style?saved=rule-added#outfit-rules';
    let jeans: number;
    let boots: number;
    let belt: number;

    const rules = () =>
      t.db
        .select()
        .from(outfitRule)
        .where(eq(outfitRule.ownerId, ownerId))
        .orderBy(outfitRule.id);
    /** The page's rule sentences, in list order. */
    const sentences = async () =>
      [
        ...unescapeHtml((await get('/auth/profile/style')).body).matchAll(
          /<li [^>]*data-rule="\d+"><span>([^<]+)</g,
        ),
      ].map(([, sentence]) => sentence);

    beforeAll(async () => {
      jeans = await createGarment(t, {
        name: 'Selvedge jeans',
        category: 'bottoms',
      });
      boots = await createGarment(t, {
        name: 'Brown boots',
        category: 'footwear',
      });
      belt = await createGarment(t, {
        name: 'Brown belt',
        category: 'accessories',
      });
    });

    afterAll(async () => {
      await asFixture(t.db, (tx) => tx.delete(outfitRule));
    });

    it('adds rules by property, type and garment, and lists them as sentences', async () => {
      const empty = await get('/auth/profile/style');
      expect(empty.body).toContain('No rules yet.');
      // Every side's select offers the closet's garments; what the
      // generator never draws is marked for the always-rule hint.
      const form = unescapeHtml(empty.body);
      expect(form).toContain(`<option value="garment:${jeans}">Selvedge jeans`);
      expect(form).toContain(
        `<option value="garment:${belt}" data-undrawn="">Brown belt`,
      );
      expect(form).toContain('<option value="category:tops">Tops, any type');
      expect(form).toContain('id="rule-undrawn-hint"');

      for (const payload of [
        { kind: 'never', a: 'color:blue', b: 'color:black' },
        {
          kind: 'never',
          a: 'category:footwear:sneakers',
          b: 'category:outerwear',
        },
        { kind: 'always', a: `garment:${jeans}`, b: `garment:${boots}` },
      ]) {
        const res = await post(RULES, payload);
        expect(res.statusCode, res.body).toBe(303);
        expect(res.headers.location).toBe(ADDED);
      }
      expect(await rules()).toMatchObject([
        // A never-rule is stored with its sides in one order (storedSides).
        { kind: 'never', aColor: 'black', bColor: 'blue' },
        {
          kind: 'never',
          aCategory: 'footwear',
          aType: 'sneakers',
          bCategory: 'outerwear',
          bType: null,
        },
        { kind: 'always', aGarmentId: jeans, bGarmentId: boots },
      ]);
      expect(await sentences()).toEqual([
        'Never black with blue',
        'Never Sneakers with Outerwear',
        'Always Brown boots with Selvedge jeans',
      ]);
      const [first] = await rules();
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Outfit rule ${first.id} added by user ${ownerId}: never color:blue with color:black`,
      );
      expect((await get(ADDED)).body).toContain('Rule added');
    });

    it('refuses the same side twice and a rule it has, keeping the form', async () => {
      const before = await rules();
      const same = await post(RULES, {
        kind: 'always',
        a: `garment:${belt}`,
        b: `garment:${belt}`,
      });
      expect(same.statusCode).toBe(400);
      expectFullPage(same);
      expect(same.body).toContain('Choose two different things.');
      expect(unescapeHtml(same.body)).toMatch(
        new RegExp(`<option value="garment:${belt}" selected`),
      );
      expect(same.body).toMatch(/value="always"[^>]*checked/);
      // The same never-rule either way round: never is symmetric.
      for (const payload of [
        { kind: 'never', a: 'color:blue', b: 'color:black' },
        { kind: 'never', a: 'color:black', b: 'color:blue' },
        {
          kind: 'never',
          a: 'category:outerwear',
          b: 'category:footwear:sneakers',
        },
      ]) {
        const again = await post(RULES, payload);
        expect(again.statusCode, JSON.stringify(payload)).toBe(400);
        expect(again.body).toContain('You have this rule already.');
      }
      expect(await rules()).toEqual(before);
    });

    it("refuses a value outside its set, a type outside its category, and a garment not the owner's", async () => {
      const before = await rules();
      for (const payload of [
        { kind: 'sometimes', a: 'color:blue', b: 'color:red' },
        { kind: 'never', a: 'color:navy', b: 'color:red' },
        // Jeans are bottoms: only a hand-made request pairs them with tops.
        { kind: 'never', a: 'category:tops:jeans', b: 'color:red' },
        { kind: 'never', a: 'garment:9999999999', b: 'color:red' },
      ]) {
        const res = await post(RULES, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const theirs = await post(
        RULES,
        { kind: 'never', a: `garment:${jeans}`, b: 'color:red' },
        stranger,
      );
      expect(theirs.statusCode).toBe(404);
      expect(theirs.body).not.toContain('Selvedge jeans');
      expect(await rules()).toEqual(before);
    });

    it('removes a rule, once', async () => {
      const [first] = await rules();
      const removed = await post(`${RULES}/${first.id}/delete`, {});
      expect(removed.statusCode).toBe(303);
      expect(removed.headers.location).toBe(
        '/auth/profile/style?saved=rule-removed#outfit-rules',
      );
      expect((await rules()).map(({ id }) => id)).not.toContain(first.id);
      const again = await post(`${RULES}/${first.id}/delete`, {});
      expect(again.statusCode).toBe(404);
    });

    it('lists the avoided pairs, and Allow again comes back here', async () => {
      expect((await get('/auth/profile/style')).body).not.toContain(
        'id="style-avoided"',
      );
      expect(await avoidPair(t.db, ownerId, boots, jeans)).toBe('added');
      const page = unescapeHtml((await get('/auth/profile/style')).body);
      expect(page).toMatch(
        /id="style-avoided"[\s\S]*<span>Selvedge jeans and Brown boots<\/span>/,
      );
      const allowed = await post('/outfits/ideas/allow', {
        garmentId: [String(jeans), String(boots)],
        returnTo: '/auth/profile/style?saved=pair-allowed#outfit-rules',
      });
      expect(allowed.statusCode).toBe(303);
      expect(allowed.headers.location).toBe(
        '/auth/profile/style?saved=pair-allowed#outfit-rules',
      );
      expect(await t.db.$count(generatorAvoid)).toBe(0);
    });
  });
});

/**
 * The style page and the weather's home city (#14): shown read-only from
 * user_weather, with the way to change it (Profile › Weather); the style
 * profile never stores a location of its own.
 */
describe('the style profile beside the weather', () => {
  let stub: WeatherStub;
  let t: TestApp;

  beforeAll(async () => {
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await stub?.close();
  });

  it('offers to set a home city when there is none', async () => {
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: '/auth/profile/style' })).body,
    );
    expect(page).toMatch(
      /id="style-home"[\s\S]*href="\/auth\/profile#weather"[^>]*>Add your city for the weather/,
    );
  });

  it('shows the home city read-only, linking to Weather to change it, and stores none of it', async () => {
    await setHome(t.db, t.owner.id, {
      name: 'Fort Greene, Brooklyn',
      location: { latitude: 40.69, longitude: -73.97 },
    });
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: '/auth/profile/style' })).body,
    );
    expect(page).toContain('Home: Fort Greene, Brooklyn');
    expect(page).toMatch(
      /id="style-home"[\s\S]*href="\/auth\/profile#weather"[^>]*>Change it in Weather/,
    );
    // No field posts it: saving the style profile cannot write a location.
    expect(page).not.toMatch(/name="(home|city|location)/);
    const saved = await t.inject({
      method: 'POST',
      url: '/auth/profile/style',
      payload: { styles: 'minimal', home: 'Elsewhere' },
    });
    expect(saved.statusCode).toBe(303);
    const settings = await findWeatherSettings(t.db, t.owner.id);
    expect(settings.home?.name).toBe('Fort Greene, Brooklyn');
  });

  // The home city rides in the page's one statement with the profile and
  // the week template (#251; they were three).
  it('reads the page in 2 statements, the home city among them', async () => {
    const { result, statements } = await recordStatements(() =>
      t.inject({ method: 'GET', url: '/auth/profile/style' }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Home: Fort Greene, Brooklyn');
    expect(statements).toHaveLength(2); // 4 before #251
    for (const table of ['style_profile', 'week_template', 'user_weather']) {
      expect(statements[1].sql).toContain(`"${table}"`);
    }
  });
});
