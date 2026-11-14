import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  garmentWear,
  optionGroup,
  outfit,
  outfitCalendar,
  personalAccessToken,
} from '../../src/db/schema';
import { selectScalars } from '../../src/db/select-scalars';
import { addDays } from '../../src/calendar-date';
import { t as text } from '../../src/web/i18n';
import {
  FIRST_OUTFIT_PAGE,
  savedOutfitsSql,
} from '../../src/web/outfits/queries';
import { wearIdea } from '../../src/web/today/queries';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import {
  createTestApp,
  recordQueries,
  shownMarkup,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import { createAccessToken, tool } from './mcp';
import {
  expectFragment,
  expectFullPage,
  expectNativePostForms,
  expectNoScriptNavigation,
  HX_FRAGMENT,
} from './pages';
import { interleave } from './interleave';

/**
 * Today (#15), the home screen at GET /: a row per occasion planned today,
 * an all-day row of three ideas while nothing that dresses the day is
 * planned, Refresh through the day's pages, "Wear this" (the pick and the
 * worn mark in one transaction, once however often it is tapped), "Wore
 * it" through the calendar's worn route, and the same model as get_today.
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

const formWith = (cookie: string, fields: Fields) => {
  const { payload, headers } = form(fields);
  return { payload, headers: { ...headers, cookie } };
};

/** The rows of a Today page: [kind, occasion], in page order. */
function rowsOf(html: string): [string, string][] {
  return [
    ...html.matchAll(/data-today-row="(\w+)" data-occasion="([\w-]+)"/g),
  ].map((m) => [m[1], m[2]]);
}

/** Every idea card's garment ids, in page order. */
function cardsOf(html: string): number[][] {
  return [...html.matchAll(/data-idea="([\d,]+)"/g)].map((m) =>
    m[1].split(',').map(Number),
  );
}

function refreshUrl(html: string): string | undefined {
  return /hx-get="(\/today\/ideas\?[^"]+)"/.exec(unescapeHtml(html))?.[1];
}

describe('Today', () => {
  let t: TestApp;
  // 4 tops x 3 bottoms x 2 shoes: 24 ideas, plain and casual.
  let tops: number[];
  let bottoms: number[];
  let shoes: number[];

  const garmentIn = async (name: string, category: string, color: string) => {
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
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });

  /** A saved outfit of these garments; its id. */
  const saveOutfit = async (name: string, garmentIds: number[]) => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...form({
        name,
        category: garmentIds.map(() => 'tops'),
        garmentId: garmentIds.map(String),
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  /** Plans an outfit today for `occasion`; the entry's id. */
  const planToday = async (outfitId: number, occasion: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      payload: { date: t.today(), outfitId: String(outfitId), occasion },
    });
    expect(res.statusCode).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.outfitId, outfitId),
          eq(outfitCalendar.day, t.today()),
        ),
      );
    return entry.id;
  };

  const clearToday = () =>
    asFixture(t.db, (tx) =>
      tx.delete(outfitCalendar).where(eq(outfitCalendar.day, t.today())),
    );

  beforeAll(async () => {
    t = await createTestApp();
    tops = await Promise.all(
      ['white', 'grey', 'black', 'beige'].map((color, i) =>
        garmentIn(`Tee ${i}`, 'tops', color),
      ),
    );
    bottoms = await Promise.all(
      ['blue', 'black', 'beige'].map((color, i) =>
        garmentIn(`Trousers ${i}`, 'bottoms', color),
      ),
    );
    shoes = await Promise.all(
      ['white', 'brown'].map((color, i) =>
        garmentIn(`Shoes ${i}`, 'footwear', color),
      ),
    );
  });

  afterAll(() => t?.cleanup());

  describe('the page', () => {
    it('sends a signed-out visitor to log in', async () => {
      const res = await t.inject({ method: 'GET', url: '/', anonymous: true });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login');
    });

    it('with nothing planned: an all-day row of three ideas to wear, Today lit in the dock', async () => {
      const res = await get('/');
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      expectNativePostForms(res);
      expectNoScriptNavigation(res);
      const html = unescapeHtml(res.body);
      expect(rowsOf(html)).toEqual([['ideas', 'all-day']]);
      const cards = cardsOf(html);
      expect(cards).toHaveLength(3);
      for (const card of cards) {
        expect(card).toHaveLength(3);
      }
      // Each card's "Wear this" posts its garments and the occasion.
      expect(html.match(/action="\/today\/wear"/g)).toHaveLength(3);
      expect(html).toContain('name="occasion" value="all-day"');
      // The dock: Today first and lit.
      expect(html).toMatch(
        /<nav class="dock"[^>]*><a class="dock-active" aria-current="page" href="\/">/,
      );
      // Offline: the writes are guarded and the page says why.
      expect(html).toContain('data-offline-note');
      expect(html.match(/data-needs-network/g)!.length).toBeGreaterThanOrEqual(
        3,
      );
      expect(html).toContain(
        `/outfits/ideas?for=day:${t.today()}&occasion=all-day`,
      );
      expect(html).toContain(`/calendar/plan?for=day:${t.today()}`);
    });

    it('shows the same three on a reload (the day’s seed)', async () => {
      const first = cardsOf((await get('/')).body);
      const again = cardsOf((await get('/')).body);
      expect(again).toEqual(first);
    });

    it('a run and a dinner planned: their rows, and still the all-day ideas first', async () => {
      const run = await saveOutfit('Run', [tops[0], bottoms[0], shoes[0]]);
      const dinner = await saveOutfit('Dinner', [
        tops[2],
        bottoms[1],
        shoes[1],
      ]);
      const runEntry = await planToday(run, 'workout');
      const dinnerEntry = await planToday(dinner, 'evening');
      const html = unescapeHtml((await get('/')).body);
      expect(rowsOf(html)).toEqual([
        ['ideas', 'all-day'],
        ['planned', 'workout'],
        ['planned', 'evening'],
      ]);
      expect(html).toContain(`data-entry="${runEntry}"`);
      // A planned outfit: "Wore it" through the calendar's worn route,
      // back to Today, and "Change" into the gallery for its occasion.
      expect(html).toContain(`action="/calendar/${dinnerEntry}/worn"`);
      expect(html).toContain('name="returnTo" value="/"');
      expect(html).toContain(
        `/outfits/ideas?for=day:${t.today()}&occasion=evening`,
      );
      await clearToday();
    });

    it('an outfit planned for work dresses the day: no ideas row', async () => {
      const office = await saveOutfit('Office', [tops[1], bottoms[2]]);
      await planToday(office, 'work');
      expect(rowsOf((await get('/')).body)).toEqual([['planned', 'work']]);
      await clearToday();
    });

    // #158: production pays a ~114 ms round trip per statement. The session,
    // then today's entries, then (undressed) the pool and the generator's
    // memory (saved outfits and clashes) in one statement (ideasFor's
    // selectScalars, #168). With the weather on, its read joins the
    // entries' round (weather.spec.ts).
    // Nothing reads "worn today": the page never shows it.
    it('reads in three statements, two when the day is dressed', async () => {
      await clearToday();
      const undressed = await recordQueries(() => get('/'));
      expect(undressed.statements).toBe(3);
      // Worn today (somethingWornSql, get_today's `worn`) is not read for
      // the page.
      expect(undressed.sql.join('\n')).not.toMatch(/\)\s+or exists \(/);

      const office = await saveOutfit('Office again', [tops[2], bottoms[0]]);
      await planToday(office, 'work');
      const dressed = await recordQueries(() => get('/'));
      expect(dressed.statements).toBe(2);
      await clearToday();
    });

    // #333: Muse's needs waiting on the owner's choice are a card leading
    // to the Wishlist inbox, read in the day's own statement
    // (needsToDecideSql in readDay), so the counts above stay; it goes once
    // no open need has an option to choose. A plan an agent drafted no
    // longer has a card: the plans are unlinked.
    it('shows Muse’s needs to decide as a card, in the same three statements, until none is left', async () => {
      await clearToday();
      await createAccessToken(t, { name: 'Muse' });
      const [{ id: tokenId }] = await t.db
        .select({ id: personalAccessToken.id })
        .from(personalAccessToken)
        .where(
          and(
            eq(personalAccessToken.userId, t.owner.id),
            eq(personalAccessToken.name, 'Muse'),
          ),
        );
      const needs: number[] = [];
      const picks: number[] = [];
      for (const name of ['White leather sneakers', 'Navy blazer']) {
        const [need] = await t.db
          .insert(optionGroup)
          .values({ ownerId: t.owner.id, name, suggestedByTokenId: tokenId })
          .returning({ id: optionGroup.id });
        const [garmentRow] = await asFixture(t.db, (tx) =>
          tx
            .insert(garment)
            .values({
              shareableId: randomUUID(),
              ownerId: t.owner.id,
              name: `${name} option`,
              category: 'tops',
              status: 'wishlist',
            })
            .returning({ id: garment.id }),
        );
        expect(
          await markSuggestion(t.db, t.owner.id, garmentRow.id, {
            tokenId,
            groupId: need.id,
            note: null,
            rank: null,
          }),
        ).toBe('marked');
        needs.push(need.id);
        picks.push(garmentRow.id);
      }
      // A need with no option yet has nothing to choose.
      await t.db
        .insert(optionGroup)
        .values({ ownerId: t.owner.id, name: 'Rain jacket' });

      const record = await recordQueries(() => get('/'));
      expect(record.statements).toBe(3);
      const html = unescapeHtml((await get('/')).body);
      expect(html).toContain('data-muse-needs="2"');
      expect(html).toContain('Muse has 2 needs for you to decide on');
      expect(html).toMatch(
        /href="\/wardrobe\/wishlist" class="btn btn-primary/,
      );
      expect(html).not.toContain('data-plan-draft');

      await decide(t.db, t.owner.id, { kind: 'choose', garmentId: picks[0] });
      expect(unescapeHtml((await get('/')).body)).toContain(
        'Muse has 1 need for you to decide on',
      );
      await decide(t.db, t.owner.id, {
        kind: 'dismiss-group',
        groupId: needs[1],
        reason: 'not_now',
        note: null,
      });
      expect((await get('/')).body).not.toContain('data-muse-needs');
      await asFixture(t.db, (tx) => tx.delete(optionGroup));
      await asFixture(t.db, (tx) =>
        tx.delete(garment).where(inArray(garment.id, picks)),
      );
    });
  });

  describe('A closet that can be dressed but has nothing available', () => {
    it('says what ideas need: no card, no refresh', async () => {
      const cookie = await t.register('nothing-available@example.com');
      const add = async (name: string, category: string) => {
        const res = await t.inject({
          method: 'POST',
          url: '/wardrobe',
          payload: { name, category },
          headers: { cookie },
        });
        return Number(
          /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
        );
      };
      await add('Tee', 'tops');
      const jeans = await add('Jeans', 'bottoms');
      const away = await t.inject({
        method: 'POST',
        url: `/wardrobe/${jeans}/away`,
        ...formWith(cookie, { away: 'lent', awayNote: 'Dana' }),
      });
      expect(away.statusCode).toBe(303);
      const res = await get('/', { cookie });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      expect(html).not.toContain('data-first-run');
      expect(rowsOf(html)).toEqual([['ideas', 'all-day']]);
      expect(cardsOf(html)).toEqual([]);
      expect(html).toContain('No ideas yet');
      expect(refreshUrl(html)).toBeUndefined();
    });
  });

  describe('Refresh', () => {
    it('walks the day’s pages three at a time, then starts over', async () => {
      const page = (await get('/')).body;
      const seen = cardsOf(page);
      let url = refreshUrl(page);
      expect(url).toMatch(/page=2$/);
      for (
        let pages = 0;
        url && !/page=1$/.test(url) && pages < 12;
        pages += 1
      ) {
        const res = await get(url, HX_FRAGMENT);
        expect(res.statusCode).toBe(200);
        expectFragment(res);
        seen.push(...cardsOf(res.body));
        url = refreshUrl(res.body);
      }
      // No idea twice across the pages.
      const keys = seen.map((ids) => [...ids].sort().join(','));
      expect(new Set(keys).size).toBe(keys.length);
      expect(seen.length).toBeGreaterThan(3);
      expect(url).toMatch(/page=1$/);
    });

    it('reads in two statements: the session, then the pool and the generator’s memory together', async () => {
      const url = refreshUrl((await get('/')).body)!;
      const record = await recordQueries(() => get(url, HX_FRAGMENT));
      expect(record.statements).toBe(2);
    });

    it('reads a malformed occasion or page as all day, page 1', async () => {
      const first = cardsOf((await get('/')).body);
      const res = await get(
        '/today/ideas?occasion=brunch&page=zz',
        HX_FRAGMENT,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('data-occasion="all-day"');
      expect(cardsOf(res.body)).toEqual(first);
    });
  });

  describe('"Wear this"', () => {
    const outfitsOf = async (ids: number[]) =>
      (
        await t.db
          .select({ id: outfit.id })
          .from(outfit)
          .where(
            sql`(select array_agg(garment_id order by garment_id) from outfit_slot where outfit_id = ${outfit.id} and garment_id is not null) = ${sql.raw(`array[${[...ids].sort((a, b) => a - b).join(',')}]::int[]`)}`,
          )
      ).map((row) => row.id);

    const wear = (garmentIds: number[], occasion = 'all-day') =>
      t.inject({
        method: 'POST',
        url: '/today/wear',
        ...form({ garmentId: garmentIds.map(String), occasion }),
      });

    it('plans the idea today and marks it worn, then Today shows it worn', async () => {
      const [idea] = cardsOf((await get('/')).body);
      const res = await wear(idea);
      expect(res.statusCode).toBe(303);
      const [outfitId] = await outfitsOf(idea);
      // A one-off (#659): Worn and planned, never on Saved.
      const [made] = await t.db
        .select({ origin: outfit.origin })
        .from(outfit)
        .where(eq(outfit.id, outfitId));
      expect(made.origin).toBe('idea');
      const [entry] = await t.db
        .select()
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, outfitId));
      expect(entry).toMatchObject({ day: t.today(), occasion: 'all-day' });
      // Lands on Today naming the entry it wore (#679).
      expect(res.headers.location).toBe(`/?wore=${entry.id}`);
      expect(entry.wornAt).not.toBeNull();
      expect(
        await t.db.$count(
          garmentWear,
          eq(garmentWear.outfitCalendarId, entry.id),
        ),
      ).toBe(idea.length);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Idea worn by user ${t.owner.id} on ${t.today()} \\(all-day\\): outfit ${outfitId} .*marked worn`,
          ),
        ),
      );

      const html = unescapeHtml((await get('/')).body);
      // Worn: the day is dressed, so no ideas; the undo posts worn=0.
      expect(rowsOf(html)).toEqual([['planned', 'all-day']]);
      expect(html).toContain('✓ Worn');
      expect(html).toContain('name="worn" value="0"');
      expect(html).not.toContain('data-status-message');

      // The landing: focus on the entry's Undo, the result to say. A flag
      // naming no worn entry of the page says nothing.
      const landed = await get(`/?wore=${entry.id}`);
      expect(landed.body).toMatch(
        new RegExp(
          `<button type="submit" id="entry-${entry.id}-worn" autofocus=""`,
        ),
      );
      expect(landed.body).toContain(
        `<template id="wore-toast" data-status-message="">${text('wear.status.WORN')}</template>`,
      );
      const stale = await get(`/?wore=${entry.id + 1000}`);
      expect(stale.body).not.toContain('data-status-message');
      expect(stale.body).not.toMatch(/-worn" autofocus/);
      // URL state is a fallback, never a 400: a repeated flag reads its
      // first valid value, a malformed one is no flag.
      const repeated = await get(`/?wore=junk&wore=${entry.id}&wore=1`);
      expect(repeated.statusCode).toBe(200);
      expect(repeated.body).toContain('data-status-message');
      expect((await get('/?wore=junk&wore=')).statusCode).toBe(200);
    });

    // adoptOutfit only raises an origin (#659): an idea's reuse of a kept
    // outfit must never send it behind "Worn and planned".
    it("an idea's reuse of a kept outfit (Wear this, an idea pick for a day) leaves it kept", async () => {
      await clearToday();
      const mine = await saveOutfit('Mine', [tops[3], bottoms[2]]);
      const agents = await saveOutfit('Agent', [tops[3], bottoms[1]]);
      await asFixture(t.db, (tx) =>
        tx.update(outfit).set({ origin: 'agent' }).where(eq(outfit.id, agents)),
      );
      const day = addDays(t.today(), 2);
      for (const garmentIds of [
        [tops[3], bottoms[2]],
        [tops[3], bottoms[1]],
      ]) {
        expect((await wear(garmentIds)).statusCode).toBe(303);
        const pick = await t.inject({
          method: 'POST',
          url: '/outfits/ideas/pick',
          ...form({ garmentId: garmentIds.map(String), for: `day:${day}` }),
        });
        expect(pick.headers.location).toBe(
          `/calendar?week=${day}&alreadySaved=1`,
        );
      }
      const origins = await t.db
        .select({ id: outfit.id, origin: outfit.origin })
        .from(outfit)
        .where(inArray(outfit.id, [mine, agents]))
        .orderBy(outfit.id);
      expect(origins).toEqual([
        { id: mine, origin: 'person' },
        { id: agents, origin: 'agent' },
      ]);
      const { kept } = await selectScalars(t.db, {
        kept: savedOutfitsSql(t.owner.id, 'kept', FIRST_OUTFIT_PAGE),
      });
      expect(kept.outfits.map((row) => row.id)).toEqual(
        expect.arrayContaining([mine, agents]),
      );
    });

    it('a second tap changes nothing: one outfit, one entry, the wears once', async () => {
      await clearToday();
      const [idea] = cardsOf((await get('/')).body);
      const before = await t.db.$count(garmentWear);
      for (let n = 0; n < 2; n += 1) {
        expect((await wear(idea)).statusCode).toBe(303);
      }
      const outfits = await outfitsOf(idea);
      expect(outfits).toHaveLength(1);
      expect(
        await t.db.$count(
          outfitCalendar,
          eq(outfitCalendar.outfitId, outfits[0]),
        ),
      ).toBe(1);
      expect(await t.db.$count(garmentWear)).toBe(before + idea.length);
      expect(t.logs.messages('info', 'Web').at(-1)).toMatch(/already worn$/);
    });

    // #158: the owner lock is taken once, by wearIdea; pickIdea, insertEntry
    // and setEntryWorn join its transaction (ownerTransaction) instead of
    // each opening a savepoint and locking again (25 statements before).
    it('a tap is one transaction that locks once: seven statements for a repeat', async () => {
      await clearToday();
      const [idea] = cardsOf((await get('/')).body);
      expect((await wear(idea)).statusCode).toBe(303);
      const again = await recordQueries(() => wear(idea));
      // Session; begin, the lock (with its timeout), the garments with the
      // outfit they already are (one statement, #168), its planner
      // take-over, the entry kept, locked and read already worn (one
      // statement, planToWear, #166); commit.
      expect(again.statements).toBe(7);
      const sql = again.sql.join('\n');
      expect(sql).not.toMatch(/savepoint/i);
      expect(sql.match(/for no key update/g)).toHaveLength(1);
    });

    it('two taps at the same moment make one outfit, one entry, one set of wears', async () => {
      await clearToday();
      const racing = [tops[3], bottoms[2], shoes[1]];
      const ownerId = t.owner.id;
      const input = {
        garmentIds: racing,
        occasion: 'all-day' as const,
        day: t.today(),
        today: t.today(),
        at: new Date(),
      };
      const [first, second] = await interleave(
        t.db,
        (tx) => wearIdea(tx, ownerId, input),
        () => wearIdea(t.db, ownerId, input),
      );
      expect(first).toMatchObject({ worn: { changed: true } });
      expect(second).toMatchObject({
        entryId: (first as { entryId: number }).entryId,
        worn: { changed: false },
      });
      const outfits = await outfitsOf(racing);
      expect(outfits).toHaveLength(1);
      expect(
        (
          await t.db
            .select({ n: count() })
            .from(garmentWear)
            .where(
              eq(
                garmentWear.outfitCalendarId,
                (first as { entryId: number }).entryId,
              ),
            )
        )[0].n,
      ).toBe(racing.length);
    });

    it('refuses garments outside the closet, writing nothing (404), and a malformed post (400)', async () => {
      const cookie = await t.register('other-today@example.com');
      const theirs = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { name: 'Theirs', category: 'tops' },
        headers: { cookie },
      });
      const other = Number(
        /^\/wardrobe\/(\d+)\?/.exec(String(theirs.headers.location))![1],
      );
      const outfitsBefore = await t.db.$count(outfit);
      const res = await wear([other, bottoms[0]]);
      expect(res.statusCode).toBe(404);
      expect(await t.db.$count(outfit)).toBe(outfitsBefore);

      expect((await wear([tops[0]], 'brunch')).statusCode).toBe(400);
      expect(
        (
          await t.inject({
            method: 'POST',
            url: '/today/wear',
            ...form({ occasion: 'all-day' }),
          })
        ).statusCode,
      ).toBe(400);
    });
  });

  describe('"Wore it" on a planned outfit', () => {
    /** The planned card of `entry` on Today, as it shows. */
    const cardOf = (html: string, entry: number) => {
      const start = html.indexOf(`data-entry="${entry}"`);
      return shownMarkup(html.slice(start, html.indexOf('</article>', start)));
    };

    it('marks the entry worn and comes back to Today; an unsafe returnTo goes to the week', async () => {
      await clearToday();
      const planned = await saveOutfit('Planned', [tops[1], bottoms[1]]);
      const entry = await planToday(planned, 'evening');
      const before = cardOf(unescapeHtml((await get('/')).body), entry);
      expect(before).toMatch(
        /data-offline-queue="entry"[\s\S]*name="worn" value="1"[\s\S]*Wore it/,
      );
      expect(before).toContain(`data-change-entry="${entry}"`);
      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/worn`,
        payload: { worn: '1', returnTo: '/' },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/');
      const worn = cardOf(unescapeHtml((await get('/')).body), entry);
      expect(worn).toMatch(/badge-success[^>]*data-worn[\s\S]*✓ Worn/);
      expect(worn).toMatch(/name="worn" value="0"[\s\S]*Undo/);
      expect(worn).not.toContain('Wore it');
      // A worn entry is the day's record: no Change.
      expect(worn).not.toContain('data-change-entry');

      const undo = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/worn`,
        payload: { worn: '0', returnTo: '//evil.example/' },
      });
      expect(undo.statusCode).toBe(303);
      expect(undo.headers.location).toBe('/calendar');
      const undone = cardOf(unescapeHtml((await get('/')).body), entry);
      expect(undone).toContain('Wore it');
      expect(undone).not.toContain('data-worn');
      expect(undone).toContain(`data-change-entry="${entry}"`);
    });
  });

  describe('get_today (MCP)', () => {
    it('answers the page’s model as data', async () => {
      await clearToday();
      const dinner = await saveOutfit('Dinner again', [tops[0], bottoms[1]]);
      const entry = await planToday(dinner, 'evening');
      const token = await createAccessToken(t);
      const today = await tool<{
        day: string;
        wornToday: boolean;
        weather: unknown;
        rows: {
          occasion: string;
          planned?: { entryId: number; worn: boolean }[];
          suggestions?: { garmentIds: number[] }[];
        }[];
      }>(t, token, 'get_today');
      expect(today.day).toBe(t.today());
      expect(today.weather).toBeNull();
      expect(today.rows.map((row) => row.occasion)).toEqual([
        'all-day',
        'evening',
      ]);
      expect(today.rows[0].suggestions!.map((s) => s.garmentIds)).toEqual(
        cardsOf((await get('/')).body),
      );
      expect(today.rows[1].planned).toEqual([
        expect.objectContaining({ entryId: entry, worn: false }),
      ]);
    });
  });
});
