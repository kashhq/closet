import { and, asc, count, eq, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  garment,
  generatorAvoid,
  outfit,
  outfitCalendar,
  outfitRule,
  outfitSlot,
  userWeather,
  weatherForecast,
} from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { pickIdea } from '../../src/web/outfits/pick';
import {
  STUB_WEATHER_NOW,
  startWeatherStub,
  type WeatherStub,
} from '../support/weather-stub';
import { createWishlistItem } from './garments';
import {
  asFixture,
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { callTool, createAccessToken } from './mcp';
import { expectFragment, expectFullPage, HX_FRAGMENT } from './pages';
import { interleave } from './interleave';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * The outfit gallery (#9): the Outfits page's Ideas tab over the generator
 * (src/wardrobe/generator.ts, unit-tested on its own), as a person and an
 * MCP client reach it. Proves the pool is the available closet and nothing
 * else, pages are stable and walk to the end, `?with=` and `?capsule=`
 * scope every idea, a pick is one transaction (outfit, slots, calendar
 * entry), "Clashes" and "too warm" write what they should, and every write
 * is marked for the offline guard.
 */

type Fields = Record<string, string | string[]>;

const form = (fields: Fields) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
};

/** Every card's garment ids, in page order. */
function cardsOf(html: string): number[][] {
  return [...html.matchAll(/data-idea="([\d,]+)"/g)].map((m) =>
    m[1].split(',').map(Number),
  );
}

/** The sentinel's next-page URL, if the page has one. */
function moreUrl(html: string): string | undefined {
  return /hx-get="(\/outfits\/ideas\/more\?[^"]+)"/.exec(
    unescapeHtml(html),
  )?.[1];
}

const keyOf = (ids: number[]) => [...ids].sort((a, b) => a - b).join(',');

describe('outfit gallery', () => {
  let t: TestApp;
  // The available closet: 3 tops x 2 bottoms x 2 shoes = 12 ideas, all
  // plain and casual (all day's formality, 2 to 3).
  let tops: number[];
  let bottoms: number[];
  let shoes: number[];
  let belt: number;
  // Never drawn: dirty, away, archived, on the wishlist, no role.
  let dirtyTee: number;
  let lentShorts: number;
  let archivedTee: number;
  let wishlistTee: number;
  let umbrella: number;
  let capsuleId: number;

  const garmentIn = async (
    name: string,
    category: string,
    color: string,
    cookie?: string,
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: {
        name,
        category,
        props: '1',
        formality: '2',
        pattern: 'solid',
        color: [color],
      },
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const get = (url: string) => t.inject({ method: 'GET', url });

  /** Every idea of a gallery URL, page after page through the sentinel. */
  const allIdeas = async (url: string): Promise<number[][]> => {
    const ideas: number[][] = [];
    let next: string | undefined = url;
    for (let pages = 0; next && pages < 20; pages += 1) {
      const res = await t.inject({
        method: 'GET',
        url: next,
        headers: pages === 0 ? {} : HX_FRAGMENT,
      });
      expect(res.statusCode, next).toBe(200);
      ideas.push(...cardsOf(res.body));
      next = moreUrl(res.body);
    }
    return ideas;
  };

  const outfitCount = async () =>
    (await t.db.select({ n: count() }).from(outfit))[0].n;

  beforeAll(async () => {
    t = await createTestApp();
    tops = [
      await garmentIn('White tee', 'tops', 'white'),
      await garmentIn('Grey tee', 'tops', 'grey'),
      await garmentIn('Navy polo', 'tops', 'blue'),
    ];
    bottoms = [
      await garmentIn('Raw jeans', 'bottoms', 'blue'),
      await garmentIn('Khaki chinos', 'bottoms', 'beige'),
    ];
    shoes = [
      await garmentIn('White sneakers', 'footwear', 'white'),
      await garmentIn('Brown boots', 'footwear', 'brown'),
    ];
    belt = await garmentIn('Brown belt', 'accessories', 'brown');
    umbrella = await garmentIn('Umbrella', 'other', 'black');

    dirtyTee = await garmentIn('Worn tee', 'tops', 'black');
    const wore = await t.inject({
      method: 'POST',
      url: `/wardrobe/${dirtyTee}/wear`,
      ...form({ worn: '1' }),
    });
    expect(wore.statusCode).toBe(303);
    lentShorts = await garmentIn('Lent shorts', 'bottoms', 'black');
    const away = await t.inject({
      method: 'POST',
      url: `/wardrobe/${lentShorts}/away`,
      ...form({ away: 'lent', awayNote: 'Dana' }),
    });
    expect(away.statusCode).toBe(303);
    archivedTee = await garmentIn('Old tee', 'tops', 'white');
    const archived = await t.inject({
      method: 'POST',
      url: `/wardrobe/${archivedTee}/archive`,
    });
    expect(archived.statusCode).toBeLessThan(400);
    wishlistTee = await createWishlistItem(t, { name: 'Wanted tee' });

    const capsule = await t.inject({
      method: 'POST',
      url: '/capsules',
      payload: { name: 'Weekend' },
    });
    capsuleId = Number(
      /^\/capsules\/(\d+)\?/.exec(String(capsule.headers.location))![1],
    );
    const members = await t.inject({
      method: 'POST',
      url: `/capsules/${capsuleId}/garments`,
      payload: { ids: [tops[0], bottoms[0], shoes[0], shoes[1]] },
    });
    expect(members.statusCode).toBe(303);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe('the Ideas tab', () => {
    it('shows cards of cutouts in a scroll-snap strip, and a sentinel for the next page', async () => {
      const res = await get('/outfits/ideas');
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      expect(res.body).toContain('snap-x snap-mandatory');
      expect(res.body.match(/<article[^>]*snap-center/g)).toHaveLength(6);
      // The tabs, Ideas current.
      expect(res.body).toMatch(/href="\/outfits"[^>]*class="tab"/);
      expect(res.body).toMatch(
        /href="\/outfits\/ideas"[^>]*class="tab tab-active"/,
      );
      // The day's seed is in the sentinel, so page 2 is the same ideas' page 2.
      const more = moreUrl(res.body)!;
      expect(more).toMatch(/seed=\d+&page=2$/);
      expect(unescapeHtml(res.body)).toContain('hx-trigger="intersect once"');
      // No carousel script: swiping is the browser's scrolling.
      expect(res.body).not.toMatch(/<script[^>]+src="[^"]*(carousel|swipe)/);
    });

    it('draws only available closet garments of the drawn roles, and every combination once', async () => {
      const ideas = await allIdeas('/outfits/ideas');
      expect(ideas).toHaveLength(12);
      expect(new Set(ideas.map(keyOf)).size).toBe(12);
      const allowed = new Set([...tops, ...bottoms, ...shoes]);
      for (const idea of ideas) {
        for (const id of idea)
          expect(allowed.has(id), `garment ${id}`).toBe(true);
      }
      const drawn = new Set(ideas.flat());
      for (const excluded of [
        dirtyTee,
        lentShorts,
        archivedTee,
        wishlistTee,
        belt,
        umbrella,
      ]) {
        expect(drawn.has(excluded)).toBe(false);
      }
    });

    it('pages are stable for a seed, and Shuffle is another seed', async () => {
      const first = await get('/outfits/ideas?seed=42');
      const again = await get('/outfits/ideas?seed=42');
      expect(cardsOf(again.body)).toEqual(cardsOf(first.body));
      const pageTwo = await t.inject({
        method: 'GET',
        url: '/outfits/ideas/more?seed=42&page=2',
        headers: HX_FRAGMENT,
      });
      expectFragment(pageTwo);
      const whole = [...cardsOf(first.body), ...cardsOf(pageTwo.body)];
      expect(new Set(whole.map(keyOf)).size).toBe(12);
      // Without a seed: the day's, the same on every load.
      const daily = await get('/outfits/ideas');
      expect(cardsOf((await get('/outfits/ideas')).body)).toEqual(
        cardsOf(daily.body),
      );
      const shuffle =
        /href="(\/outfits\/ideas\?seed=\d+)"[^>]*data-shuffle/.exec(
          unescapeHtml(first.body),
        )![1];
      expect(shuffle).not.toBe('/outfits/ideas?seed=42');
      expect(cardsOf((await get(shuffle)).body)).not.toEqual(
        cardsOf(first.body),
      );
    });

    it('falls back on a malformed seed or page, and refuses what names data', async () => {
      expect((await get('/outfits/ideas?seed=banana&page=-3')).statusCode).toBe(
        200,
      );
      expect((await get('/outfits/ideas?capsule=abc')).statusCode).toBe(400);
      expect((await get('/outfits/ideas?with=abc')).statusCode).toBe(400);
      expect((await get('/outfits/ideas?with=999999')).statusCode).toBe(404);
      // A garment outside the closet is not one to style.
      expect((await get(`/outfits/ideas?with=${archivedTee}`)).statusCode).toBe(
        404,
      );
      expect((await get(`/outfits/ideas?with=${wishlistTee}`)).statusCode).toBe(
        404,
      );
    });

    it('?with= puts the garment in every idea, clean or not', async () => {
      for (const id of [bottoms[1], dirtyTee, belt]) {
        const ideas = await allIdeas(`/outfits/ideas?with=${id}`);
        expect(ideas.length).toBeGreaterThan(0);
        for (const idea of ideas) expect(idea).toContain(id);
      }
      const page = await get(`/outfits/ideas?with=${bottoms[1]}`);
      expect(page.body).toContain('With Khaki chinos');
    });

    it('?capsule= draws only its members', async () => {
      const ideas = await allIdeas(`/outfits/ideas?capsule=${capsuleId}`);
      // 1 top x 1 bottom x 2 shoes.
      expect(ideas.map(keyOf).sort()).toEqual(
        [
          keyOf([tops[0], bottoms[0], shoes[0]]),
          keyOf([tops[0], bottoms[0], shoes[1]]),
        ].sort(),
      );
    });

    it("refuses someone else's capsule and garment like unknown ids", async () => {
      const cookie = await t.register('gallery-other@example.com');
      const theirs = await garmentIn('Their tee', 'tops', 'red', cookie);
      const capsule = await t.inject({
        method: 'POST',
        url: '/capsules',
        payload: { name: 'Theirs' },
        headers: { cookie },
      });
      const theirCapsule = Number(
        /^\/capsules\/(\d+)\?/.exec(String(capsule.headers.location))![1],
      );
      expect((await get(`/outfits/ideas?with=${theirs}`)).statusCode).toBe(404);
      expect(
        (await get(`/outfits/ideas?capsule=${theirCapsule}`)).statusCode,
      ).toBe(404);
      // Nor can a pick or a clash name it.
      const before = await outfitCount();
      const pick = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/pick',
        ...form({ garmentId: [String(theirs), String(bottoms[0])] }),
      });
      expect(pick.statusCode).toBe(404);
      expect(await outfitCount()).toBe(before);
      const clash = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/avoid',
        ...form({ garmentId: [String(theirs), String(bottoms[0])] }),
      });
      expect(clash.statusCode).toBe(404);
      expect(await t.db.$count(generatorAvoid)).toBe(0);
    });

    it('marks every write for the offline guard and says what offline means', async () => {
      const res = await get('/outfits/ideas');
      const html = unescapeHtml(res.body);
      expect(html).toContain('data-offline-note');
      const pickForms = html.match(
        /<form[^>]*action="\/outfits\/ideas\/pick"[^>]*>/g,
      )!;
      const avoidForms = html.match(
        /<form[^>]*action="\/outfits\/ideas\/avoid"[^>]*>/g,
      )!;
      expect(pickForms).toHaveLength(6);
      // Three garments a card: three pairs to choose the clash from.
      expect(avoidForms).toHaveLength(18);
      for (const tag of [...pickForms, ...avoidForms]) {
        expect(tag).toContain('data-needs-network');
      }
      // Without the weather, no "too warm": the offset means nothing.
      expect(html).not.toContain('/outfits/ideas/feedback');
    });
  });

  describe('picking', () => {
    it('saves an idea as an outfit named for its garments, slots top to toe', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/pick',
        // Posted toe to top: stored top to toe.
        ...form({
          garmentId: [String(shoes[1]), String(bottoms[1]), String(tops[1])],
        }),
      });
      expect(res.statusCode).toBe(303);
      const id = Number(
        /^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1],
      );
      const [saved] = await t.db.select().from(outfit).where(eq(outfit.id, id));
      expect(saved.name).toBe('Grey tee, Khaki chinos, Brown boots');
      const slots = await t.db
        .select({
          category: outfitSlot.category,
          garmentId: outfitSlot.garmentId,
        })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, id))
        .orderBy(asc(outfitSlot.position));
      expect(slots).toEqual([
        { category: 'tops', garmentId: tops[1] },
        { category: 'bottoms', garmentId: bottoms[1] },
        { category: 'footwear', garmentId: shoes[1] },
      ]);
      expect(
        await t.db.$count(outfitCalendar, eq(outfitCalendar.outfitId, id)),
      ).toBe(0);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(`^Idea picked by user \\d+: outfit ${id} .*saved$`),
        ),
      );
      // Saved now: the gallery never offers it again.
      const ideas = await allIdeas('/outfits/ideas');
      expect(ideas).toHaveLength(11);
      expect(ideas.map(keyOf)).not.toContain(
        keyOf([tops[1], bottoms[1], shoes[1]]),
      );
    });

    it('for a day and occasion (?for=), plans it there in the same transaction', async () => {
      const day = addDays(t.today(), 3);
      const page = await get(`/outfits/ideas?for=day:${day}&occasion=evening`);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Plan for ');
      expect(page.body).toContain('Evening');
      expect(unescapeHtml(page.body)).toContain(
        `href="/calendar/plan?for=day:${day}&occasion=evening"`,
      );
      const res = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/pick',
        ...form({
          garmentId: [String(tops[2]), String(bottoms[0]), String(shoes[0])],
          for: `day:${day}`,
          occasion: 'evening',
          seed: '42',
        }),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/calendar?week=${day}`);
      const [entry] = await t.db
        .select({
          outfitId: outfitCalendar.outfitId,
          occasion: outfitCalendar.occasion,
          name: outfit.name,
        })
        .from(outfitCalendar)
        .innerJoin(outfit, eq(outfit.id, outfitCalendar.outfitId))
        .where(eq(outfitCalendar.day, day));
      expect(entry).toMatchObject({
        occasion: 'evening',
        name: 'Navy polo, Raw jeans, White sneakers',
      });
    });

    it('writes nothing when the calendar entry fails: outfit, slots and entry are one transaction', async () => {
      await t.db.execute(sql`
        create function gallery_spec_refuse() returns trigger language plpgsql as $$
        begin raise exception 'gallery spec: no entries'; end $$`);
      await t.db.execute(sql`
        create trigger gallery_spec_refuse before insert on outfit_calendar
        for each row execute function gallery_spec_refuse()`);
      try {
        const [outfits, slots] = [
          await outfitCount(),
          await t.db.$count(outfitSlot),
        ];
        const res = await t.inject({
          method: 'POST',
          url: '/outfits/ideas/pick',
          ...form({
            garmentId: [String(tops[0]), String(bottoms[1]), String(shoes[0])],
            for: `day:${t.today()}`,
          }),
        });
        expect(res.statusCode).toBe(500);
        expect(await outfitCount()).toBe(outfits);
        expect(await t.db.$count(outfitSlot)).toBe(slots);
      } finally {
        await t.db.execute(
          sql`drop trigger gallery_spec_refuse on outfit_calendar`,
        );
        await t.db.execute(sql`drop function gallery_spec_refuse()`);
      }
    });

    it('refuses a malformed destination and a garment no longer in the closet', async () => {
      const bad = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/pick',
        ...form({ garmentId: [String(tops[0])], for: 'day:2026-02-30' }),
      });
      expect(bad.statusCode).toBe(400);
      const archived = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/pick',
        ...form({ garmentId: [String(tops[0]), String(archivedTee)] }),
      });
      // Refused whole, the archived garment named (#219): a 409, since it
      // is the owner's; an id that is not theirs stays a 404.
      expect(archived.statusCode).toBe(409);
      expect(unescapeHtml(archived.body)).toContain(
        'Not saved: Old tee is archived.',
      );
      const foreign = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/pick',
        ...form({ garmentId: [String(tops[0]), '2147483000'] }),
      });
      expect(foreign.statusCode).toBe(404);
    });
  });

  describe('a pick is made once (a double tap, a retried post)', () => {
    // A combination no other spec picks: the grey tee, khaki chinos,
    // white sneakers.
    const garments = () => [tops[1], bottoms[1], shoes[0]];
    const outfitsOf = async (ids: number[]) => {
      const { rows } = await t.db.execute<{ id: number }>(sql`
        select o.id from outfit o join outfit_slot s on s.outfit_id = o.id
        where s.garment_id is not null
        group by o.id
        having array_agg(distinct s.garment_id order by s.garment_id)
          = ${sql.raw(`array[${[...ids].sort((a, b) => a - b).join(',')}]::int[]`)}`);
      return rows.map((row) => row.id);
    };

    it('a second pick of the same idea reuses the outfit and says it is already saved', async () => {
      const pick = (fields: Fields) =>
        t.inject({
          method: 'POST',
          url: '/outfits/ideas/pick',
          ...form({ garmentId: garments().map(String), ...fields }),
        });
      const first = await pick({});
      expect(first.statusCode).toBe(303);
      const id = Number(
        /^\/outfits\/(\d+)$/.exec(String(first.headers.location))![1],
      );
      const again = await pick({});
      expect(again.statusCode).toBe(303);
      expect(again.headers.location).toBe(`/outfits/${id}?alreadySaved=1`);
      expect(await outfitsOf(garments())).toEqual([id]);
      const page = await get(String(again.headers.location));
      expect(page.body).toContain('Already saved');
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(`already outfit ${id}; nothing created$`),
        ),
      );
      // For a day: the same outfit is planned there, once, however often.
      const day = addDays(t.today(), 4);
      for (let n = 0; n < 2; n += 1) {
        const planned = await pick({ for: `day:${day}`, occasion: 'work' });
        expect(planned.headers.location).toBe(
          `/calendar?week=${day}&alreadySaved=1`,
        );
      }
      expect(
        await t.db
          .select({ id: outfitCalendar.outfitId })
          .from(outfitCalendar)
          .where(eq(outfitCalendar.day, day)),
      ).toEqual([{ id }]);
      expect(
        (await get(`/calendar?week=${day}&alreadySaved=1`)).body,
      ).toContain('Already saved');
    });

    it('two picks at the same moment make one outfit and one calendar entry', async () => {
      const racing = [tops[2], bottoms[1], shoes[1]];
      const day = addDays(t.today(), 6);
      const plan = { day, occasion: 'evening' as const };
      const ownerId = t.owner.id;
      // B, the second tap, must wait for A's commit and then find its outfit.
      const [first, second] = await interleave(
        t.db,
        (tx) =>
          pickIdea(tx, ownerId, {
            garmentIds: racing,
            plan,
            origin: 'person',
            madeBy: BY_PERSON,
          }),
        () =>
          pickIdea(t.db, ownerId, {
            garmentIds: racing,
            plan,
            origin: 'person',
            madeBy: BY_PERSON,
          }),
      );
      expect(first).toMatchObject({
        alreadySaved: false,
        schedule: 'scheduled',
      });
      expect(second).toMatchObject({
        id: (first as { id: number }).id,
        alreadySaved: true,
        schedule: 'already-scheduled',
      });
      expect(await outfitsOf(racing)).toHaveLength(1);
      expect(
        await t.db.$count(outfitCalendar, eq(outfitCalendar.day, day)),
      ).toBe(1);
    });
  });

  describe('say why not', () => {
    it('"Clashes" stores the pair once, removes the card, and the pair never comes back', async () => {
      const [a, b] = [tops[0], bottoms[1]];
      const res = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/avoid',
        headers: {
          ...HX_FRAGMENT,
          'content-type': 'application/x-www-form-urlencoded',
        },
        // Posted larger id first: stored smaller first.
        payload: new URLSearchParams([
          ['garmentId', String(b)],
          ['garmentId', String(a)],
          ['seed', '42'],
        ]).toString(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
      const ownerId = t.owner.id;
      expect(await t.db.select().from(generatorAvoid)).toEqual([
        {
          ownerId,
          garmentAId: Math.min(a, b),
          garmentBId: Math.max(a, b),
          createdAt: expect.any(Date),
        },
      ]);
      // Again, as a plain post: nothing more, and back to the same gallery.
      const again = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/avoid',
        ...form({
          garmentId: [String(a), String(b)],
          seed: '42',
          capsule: String(capsuleId),
        }),
      });
      expect(again.statusCode).toBe(303);
      expect(again.headers.location).toBe(
        `/outfits/ideas?capsule=${capsuleId}&seed=42`,
      );
      expect(await t.db.$count(generatorAvoid)).toBe(1);
      for (const idea of await allIdeas('/outfits/ideas')) {
        expect(idea.includes(a) && idea.includes(b)).toBe(false);
      }
    });

    it("lists the pair on the garment's page, with its undo", async () => {
      const [a, b] = [tops[0], bottoms[1]];
      const page = await get(`/wardrobe/${a}`);
      expect(page.body).toContain('Never paired with');
      expect(page.body).toContain('Khaki chinos');
      // "Style this" opens Styling on it (#42).
      expect(unescapeHtml(page.body)).toContain(`href="/styling?with=${a}"`);
      const undo = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/allow',
        ...form({ garmentId: [String(a), String(b)] }),
      });
      expect(undo.statusCode).toBe(303);
      expect(undo.headers.location).toBe(`/wardrobe/${a}`);
      expect(await t.db.$count(generatorAvoid)).toBe(0);
      const gone = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/allow',
        ...form({ garmentId: [String(a), String(b)] }),
      });
      expect(gone.statusCode).toBe(404);
      // A wishlist item has nothing to style.
      expect((await get(`/wardrobe/${wishlistTee}`)).body).not.toContain(
        '/styling?with=',
      );
    });

    it('"too warm" needs the weather', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/outfits/ideas/feedback',
        ...form({ feeling: 'too-warm' }),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('outfit rules (#21)', () => {
    // Rows, as the Style page's form (#21b) will write them: never a blue
    // garment with the brown boots; the white tee always with the sneakers.
    beforeAll(async () => {
      await asFixture(t.db, (tx) =>
        tx.insert(outfitRule).values([
          {
            ownerId: t.owner.id,
            kind: 'never',
            aColor: 'blue',
            bColor: 'brown',
          },
          {
            ownerId: t.owner.id,
            kind: 'always',
            aGarmentId: tops[0],
            bGarmentId: shoes[0],
          },
        ]),
      );
    });

    afterAll(async () => {
      await asFixture(t.db, (tx) => tx.delete(outfitRule));
    });

    it('every idea keeps them, and they ride in the ideas statement', async () => {
      const ideas = await allIdeas('/outfits/ideas');
      const blue = [tops[2], bottoms[0]];
      const [sneakers, boots] = shoes;
      for (const idea of ideas) {
        const anyBlue = blue.some((id) => idea.includes(id));
        expect(anyBlue && idea.includes(boots), String(idea)).toBe(false);
        if (idea.includes(tops[0])) expect(idea).toContain(sneakers);
      }
      // The always-rule narrows the white tee's ideas, never empties them.
      expect(ideas.some((idea) => idea.includes(tops[0]))).toBe(true);
      const read = await recordQueries(() => get('/outfits/ideas'));
      expect(read.statements).toBe(2);
    });
  });

  describe('entry points', () => {
    it('the calendar plan page offers Ideas for its day and occasion', async () => {
      const day = addDays(t.today(), 2);
      const res = await get(`/calendar/plan?for=day:${day}&occasion=work`);
      expect(unescapeHtml(res.body)).toContain(
        `href="/outfits/ideas?for=day:${day}&occasion=work"`,
      );
    });

    it("a capsule page offers to swipe the capsule's outfits", async () => {
      const res = await get(`/capsules/${capsuleId}`);
      expect(unescapeHtml(res.body)).toContain(
        `href="/outfits/ideas?capsule=${capsuleId}"`,
      );
    });

    it('the Saved tab links to Ideas', async () => {
      const res = await get('/outfits');
      expect(res.body).toMatch(/href="\/outfits\/ideas"[^>]*class="tab"/);
    });
  });

  describe('MCP', () => {
    let token: string;

    beforeAll(async () => {
      token = await createAccessToken(t);
    });

    it('suggest_outfits gives ideas with reasons, scoped like the page', async () => {
      const answer = await callTool(t, token, 'suggest_outfits', {
        withGarmentId: shoes[1],
        seed: 7,
      });
      expect(answer.isError).toBe(false);
      const value = answer.value as {
        seed: number;
        occasion: string;
        weather: unknown;
        ideas: {
          garmentIds: number[];
          name: string;
          fits: boolean;
          problems: string[];
        }[];
      };
      expect(value).toMatchObject({
        seed: 7,
        occasion: 'all-day',
        weather: null,
      });
      expect(value.ideas.length).toBeGreaterThan(0);
      for (const idea of value.ideas) {
        expect(idea.garmentIds).toContain(shoes[1]);
        expect(idea.name).toContain('Brown boots');
        expect(idea).toMatchObject({ fits: true, problems: [] });
      }
      const again = await callTool(t, token, 'suggest_outfits', {
        withGarmentId: shoes[1],
        seed: 7,
      });
      expect(again.value).toEqual(answer.value);
      const refused = await callTool(t, token, 'suggest_outfits', {
        capsuleId: 999999,
      });
      expect(refused).toMatchObject({
        isError: true,
        value: { error: 'Capsule not found' },
      });
    });

    it('pick_outfit saves an idea and plans it', async () => {
      const day = addDays(t.today(), 5);
      const answer = await callTool(t, token, 'pick_outfit', {
        garmentIds: [tops[1], bottoms[0], shoes[0]],
        date: day,
        occasion: 'daytime',
      });
      expect(answer.isError).toBe(false);
      const { id, name } = answer.value as { id: number; name: string };
      expect(name).toBe('Grey tee, Raw jeans, White sneakers');
      const [entry] = await t.db
        .select({ occasion: outfitCalendar.occasion })
        .from(outfitCalendar)
        .where(
          and(eq(outfitCalendar.outfitId, id), eq(outfitCalendar.day, day)),
        );
      expect(entry).toEqual({ occasion: 'daytime' });
      // Retried (a client that lost the answer): the same outfit, nothing new.
      const retried = await callTool(t, token, 'pick_outfit', {
        garmentIds: [tops[1], bottoms[0], shoes[0]],
        date: day,
        occasion: 'daytime',
      });
      expect(retried.value).toMatchObject({
        id,
        alreadySaved: true,
        scheduled: { day, occasion: 'daytime', outcome: 'already-scheduled' },
      });
      const refused = await callTool(t, token, 'pick_outfit', {
        garmentIds: [wishlistTee],
      });
      expect(refused.isError).toBe(true);
    });
  });

  // A closet of its own: 10 tops, 10 bottoms and 4 shoes in neutrals make
  // 400 ideas, more than the 50 pages of 6 the gallery goes to.
  describe('a closet past the last page (#123)', () => {
    let cookie: string;
    let unnamedTop: number;

    beforeAll(async () => {
      cookie = await t.register('big-closet@example.com');
      const neutrals = ['white', 'grey', 'black', 'beige', 'brown'];
      for (let i = 0; i < 10; i += 1) {
        await garmentIn(`Top ${i}`, 'tops', neutrals[i % 5], cookie);
        await garmentIn(`Bottom ${i}`, 'bottoms', neutrals[i % 5], cookie);
      }
      for (let i = 0; i < 4; i += 1) {
        await garmentIn(`Shoe ${i}`, 'footwear', neutrals[i], cookie);
      }
      unnamedTop = await garmentIn('', 'tops', 'white', cookie);
    });

    const getAs = (url: string, headers: Record<string, string> = {}) =>
      t.inject({ method: 'GET', url, headers: { cookie, ...headers } });

    it('offers no page past the last: the sentinel stops at page 50', async () => {
      const before = await getAs('/outfits/ideas/more?seed=3&page=49', {
        ...HX_FRAGMENT,
      });
      expect(moreUrl(before.body)).toMatch(/seed=3&page=50$/);
      const last = await getAs('/outfits/ideas/more?seed=3&page=50', {
        ...HX_FRAGMENT,
      });
      expect(cardsOf(last.body)).toHaveLength(6);
      expect(moreUrl(last.body)).toBeUndefined();
      expect(last.body).not.toContain('data-ideas-more');
    });

    it('suggest_outfits says there is no more on the last page it takes', async () => {
      const token = await createAccessToken(t, { cookie });
      const more = async (page: number) =>
        (
          (await callTool(t, token, 'suggest_outfits', { seed: 3, page }))
            .value as { more: boolean }
        ).more;
      expect(await more(49)).toBe(true);
      expect(await more(50)).toBe(false);
    });

    it('names an unnamed garment by its category in "With" and the clash pairs', async () => {
      const page = unescapeHtml(
        (await getAs(`/outfits/ideas?with=${unnamedTop}&seed=3`)).body,
      );
      expect(page).toContain('With Tops');
      expect(page).toMatch(/>\s*Tops \+ Bottom \d\s*</);
      expect(page).not.toMatch(/>\s*\+ /);
    });
  });

  // Production reaches Postgres over a link where each statement is a round
  // trip (#156), so each route's count is pinned: a new read shows up here.
  // Every request's first statement is the session's user.
  describe('statements per request (#168)', () => {
    it('the page: the session, then the pool, saved outfits, clashes, rules and the capsule menu in one', async () => {
      const read = await recordQueries(() => get('/outfits/ideas'));
      expect(read.statements).toBe(2);
      const [, ideas] = read.sql;
      for (const table of [
        '"garment_wear"',
        '"outfit_slot"',
        '"generator_avoid"',
        '"outfit_rule"',
        '"capsule"',
      ]) {
        expect(ideas).toContain(table);
      }
      const more = await recordQueries(() =>
        t.inject({
          method: 'GET',
          url: '/outfits/ideas/more?seed=7&page=2',
          headers: HX_FRAGMENT,
        }),
      );
      // The same, without the capsule menu: a fragment has none.
      expect(more.statements).toBe(2);
      expect(more.sql[1]).not.toContain('"capsule"');
    });

    it('?capsule= and ?with= each validate first, a statement before the ideas', async () => {
      const scoped = await recordQueries(() =>
        get(`/outfits/ideas?capsule=${capsuleId}`),
      );
      expect(scoped.statements).toBe(3);
      const styled = await recordQueries(() =>
        get(`/outfits/ideas?with=${tops[0]}`),
      );
      expect(styled.statements).toBe(3);
    });

    it('a clash is one statement, and refuses a wishlist item in it', async () => {
      const [a, b] = [tops[2], shoes[0]];
      const clash = (ids: number[]) =>
        t.inject({
          method: 'POST',
          url: '/outfits/ideas/avoid',
          ...form({ garmentId: ids.map(String) }),
        });
      const added = await recordQueries(() => clash([a, b]));
      expect(added.statements).toBe(2);
      const again = await recordQueries(() => clash([b, a]));
      expect(again.statements).toBe(2);
      expect((await clash([a, wishlistTee])).statusCode).toBe(404);
      // An archived garment is still owned: it may come back.
      expect((await clash([a, archivedTee])).statusCode).toBe(303);
      const pairs = await t.db
        .select({ b: generatorAvoid.garmentBId })
        .from(generatorAvoid)
        .where(eq(generatorAvoid.garmentAId, Math.min(a, b)));
      expect(pairs.map((pair) => pair.b).sort()).toEqual(
        [Math.max(a, b), archivedTee].sort(),
      );
      for (const pair of [
        [a, b],
        [a, archivedTee],
      ]) {
        const allowed = await t.inject({
          method: 'POST',
          url: '/outfits/ideas/allow',
          ...form({ garmentId: pair.map(String) }),
        });
        expect(allowed.statusCode).toBe(303);
      }
    });

    it('a pick reads its garments and the outfit they already are in one statement', async () => {
      const garments = [tops[0], bottoms[1], shoes[1]].map(String);
      const pick = () =>
        t.inject({
          method: 'POST',
          url: '/outfits/ideas/pick',
          ...form({ garmentId: garments }),
        });
      const first = await recordQueries(pick);
      const again = await recordQueries(pick);
      const reads = (sql: string[]) =>
        sql.filter((q) => /^select .* from "garment"/.test(q));
      // One read of the garments (FOR SHARE) with the outfit they already
      // are; the slots check their garments in their own insert.
      for (const record of [first, again]) {
        expect(reads(record.sql)).toHaveLength(1);
        expect(reads(record.sql)[0]).toMatch(/for share of "garment"$/);
      }
      // The session; begin, and the owner lock with its timeout (#215);
      // the read; the outfit (inserted unless one of these garments exists,
      // #219) and its slots, in createOutfit, which joins the pick's owner
      // transaction (no savepoint); commit.
      expect(first.statements).toBe(7);
      expect(again.sql.some((q) => q.startsWith('insert into "outfit"'))).toBe(
        false,
      );
      // Already saved: the session; begin and the lock; the read; the
      // planner's take-over; commit.
      expect(again.statements).toBe(6);
    });
  });
});

describe('outfit gallery with the weather', () => {
  let stub: WeatherStub;
  let t: TestApp;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW });
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
    for (const [name, category, color] of [
      ['White tee', 'tops', 'white'],
      ['Raw jeans', 'bottoms', 'blue'],
      ['Sneakers', 'footwear', 'white'],
    ]) {
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { name, category, props: '1', color: [color] },
      });
      expect(res.statusCode).toBe(302);
    }
    const home = await t.inject({
      method: 'POST',
      url: '/weather/home',
      payload: { name: 'Fort Greene', latitude: 40.69, longitude: -73.97 },
    });
    expect(home.statusCode).toBe(303);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await t.cleanup();
    await stub.close();
  });

  it("matches today's ideas to the forecast and says so", async () => {
    const res = await t.inject({ method: 'GET', url: '/outfits/ideas' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-ideas-weather');
    expect(res.body).toMatch(/Feels -?\d+–-?\d+ °F/);
    expect(res.body).toContain('/outfits/ideas/feedback');
    // A day past the forecast is dressed without it, and fetches nothing new:
    // climate normals are a trip destination's alone.
    const far = await t.inject({
      method: 'GET',
      url: `/outfits/ideas?for=day:${addDays(t.today(), 40)}`,
    });
    expect(far.body).not.toContain('data-ideas-weather');
    expect(stub.hits.filter((hit) => hit.startsWith('/v1/archive'))).toEqual(
      [],
    );
  });

  it('reads the weather settings and the cached forecast in the ideas’ one statement (#168)', async () => {
    await t.inject({ method: 'GET', url: '/outfits/ideas' });
    const hits = stub.hits.length;
    const read = await recordQueries(() =>
      t.inject({ method: 'GET', url: '/outfits/ideas' }),
    );
    // The session, then the pool, the generator's memory, the capsule menu
    // and the settings with their location's forecast row. A fresh row read
    // back from JSON (its timestamps as strings) is served, not fetched.
    expect(read.statements).toBe(2);
    expect(read.sql[1]).toContain('"weather_forecast"');
    expect(stub.hits).toHaveLength(hits);
  });

  describe('rain (#648)', () => {
    /** Today's cached forecast made `feelsLike` °C with rain from 8:00 to 22:00. */
    const rainyToday = async (feelsLike: number) => {
      const forecast = kept.forecast!;
      const days = forecast.days.map((day) =>
        day.day === t.today()
          ? {
              ...day,
              hours: day.hours.map((h) => ({
                ...h,
                feelsLike,
                precipitationChance: h.hour >= 8 && h.hour < 22 ? 90 : 0,
              })),
            }
          : day,
      );
      await t.db
        .update(weatherForecast)
        .set({ forecast: { ...forecast, days }, fetchedAt: new Date() });
    };
    // The forecast row is shared with every spec of the file, and the Rain
    // hat is in the closet they draw from: both go back after each.
    let kept: typeof weatherForecast.$inferSelect;
    beforeEach(async () => {
      [kept] = await t.db.select().from(weatherForecast);
    });
    afterEach(async () => {
      await t.db
        .update(weatherForecast)
        .set({ forecast: kept.forecast, fetchedAt: kept.fetchedAt });
      await asFixture(t.db, (tx) =>
        tx.delete(garment).where(eq(garment.name, 'Rain hat')),
      );
    });
    const pages = async () =>
      Promise.all(
        ['/outfits/ideas', '/'].map(async (url) => {
          const res = await t.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(200);
          return unescapeHtml(res.body);
        }),
      );
    const umbrellas = (html: string) =>
      html.split('Take the umbrella').length - 1;

    it('in the heat is "Take the umbrella" once on Ideas and Today, no card missing it', async () => {
      await rainyToday(30);
      for (const html of await pages()) {
        expect(umbrellas(html)).toBe(1);
        expect(html).toContain('data-idea=');
        expect(html).not.toContain('Rain: nothing waterproof');
      }
    });

    it('on a cool day asks the outfit for it, until the closet has a rain accessory', async () => {
      await rainyToday(12);
      for (const html of await pages()) {
        expect(umbrellas(html)).toBe(0);
        expect(html).toContain('Rain: nothing waterproof');
      }
      const umbrella = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          name: 'Rain hat',
          category: 'accessories',
          type: 'hat',
          props: '1',
          color: ['black'],
          waterResistant: 'true',
        },
      });
      expect(umbrella.statusCode).toBe(302);
      for (const html of await pages()) {
        expect(umbrellas(html)).toBe(1);
        expect(html).not.toContain('Rain: nothing waterproof');
      }
    });
  });

  it('"too warm" nudges the offset and comes back to the same ideas', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits/ideas/feedback',
      ...form({ feeling: 'too-warm', seed: '9' }),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/outfits/ideas?seed=9');
    const ownerId = await userIdOf(t, t.owner.email);
    const [settings] = await t.db
      .select({ offset: userWeather.temperatureOffset })
      .from(userWeather)
      .where(eq(userWeather.userId, ownerId));
    expect(settings.offset).toBe(0.5);
  });
});
