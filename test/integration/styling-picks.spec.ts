import { asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  optionGroup,
  outfit,
  outfitSlot,
  personalAccessToken,
} from '../../src/db/schema';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { createWishlistItem } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { createAccessToken } from './mcp';
import { HX_FRAGMENT } from './pages';

/**
 * Styling's Include picks (#335 part B; docs/plans/2026-10-05-agent-
 * suggestions.md, section 4 E): `?picks=1`, off by default, puts the
 * garments not bought yet that are offered to style with (offeredToStyle:
 * still wanted, not under a need set aside) first on their roles' strips,
 * badged "To buy", a need's options side by side in the agent's rank; the rows
 * carry them through Shuffle and "Add row"; Save makes an incomplete
 * outfit through the outfit writer (the A1 rule:
 * test/integration/incomplete-outfits.spec.ts). Never over a shared
 * wardrobe nor with a destination. It replaced the plan's `?plan=` (#273).
 */
describe('Styling: Include picks (#335)', () => {
  let t: TestApp;
  let ownerId: number;
  let grantee: string;
  let tokenId: number;
  let tee: number;
  let jeans: number;
  /** The blazer need's options, ranked 1 and 2; the other need's one. */
  let blazerOne: number;
  let blazerTwo: number;
  let knit: number;
  /** The owner's own wishlist item, and the agent's boots (a role the closet lacks). */
  let ownShirt: number;
  let boots: number;
  /** Not offered: a pick set aside, and one under a need set aside. */
  let setAside: number;
  let underSetAsideNeed: number;

  const form = (payload: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      for (const one of [value].flat()) body.append(key, one);
    }
    return {
      payload: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
  };

  const get = (url: string, cookie?: string) =>
    t.inject({
      method: 'GET',
      url,
      headers: {
        ...(url.includes('/styling/') ? HX_FRAGMENT : {}),
        ...(cookie ? { cookie } : {}),
      },
    });

  const save = (payload: Record<string, string | string[]>) =>
    t.inject({ method: 'POST', url: '/styling', ...form(payload) });

  const closetGarment = async (name: string, category: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({ name, category, props: '1', formality: '2', color: 'blue' }),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const need = async (name: string) => {
    const [row] = await t.db
      .insert(optionGroup)
      .values({ ownerId, name, suggestedByTokenId: tokenId })
      .returning({ id: optionGroup.id });
    return row.id;
  };

  const pick = async (
    name: string,
    category: string,
    groupId: number | null,
    rank: number | null,
  ) => {
    const id = await createWishlistItem(t, { name, category, price: '100' });
    expect(
      await markSuggestion(t.db, ownerId, id, {
        tokenId,
        groupId,
        note: `Why ${name}`,
        rank,
      }),
    ).toBe('marked');
    return id;
  };

  /** The garment ids a row's strip shows, in order. */
  const stripOf = (html: string, role: string): number[] => {
    const start = html.indexOf(`data-styling-row="${role}"`);
    expect(start, `a ${role} row`).toBeGreaterThan(-1);
    const end = html.indexOf('data-styling-row="', start + 1);
    return [
      ...html
        .slice(start, end === -1 ? undefined : end)
        .matchAll(/data-snap-value="(\d+)"/g),
    ].map((m) => Number(m[1]));
  };

  const rowsQuery = (
    rows: [role: string, garmentId: number | null, locked: boolean][],
    extra: Record<string, string> = {},
  ) => {
    const query = new URLSearchParams(extra);
    for (const [role, garmentId, locked] of rows) {
      query.append('role', role);
      query.append('garmentId', garmentId === null ? '' : String(garmentId));
      query.append('lock', locked ? '1' : '');
    }
    return query.toString();
  };

  const carries = (html: string, garmentId: number) =>
    html.includes(`name="garmentId" value="${garmentId}"`);

  /** The Include picks switch as it answers: its state, the value it posts, the address it pushes. */
  const switchOf = (body: string) => {
    // The raw markup: an attribute's quotes are escaped inside its value.
    const tag = /<button[^>]*data-styling-picks="[^"]*"[^>]*>/.exec(body)?.[0];
    if (!tag) return undefined;
    const attr = (name: string) => {
      const value = new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
      return value === undefined ? undefined : unescapeHtml(value);
    };
    return {
      checked: attr('aria-checked'),
      vals: JSON.parse(attr('hx-vals') ?? '{}') as Record<string, string>,
      push: attr('hx-push-url'),
    };
  };

  /** A wishlist-free closet accessory, for the posted-order row. */
  const accessory = (name: string) => closetGarment(name, 'accessories');

  const slotsOf = async (outfitId: number) =>
    (
      await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, outfitId))
        .orderBy(asc(outfitSlot.position))
    ).map((slot) => slot.garmentId);

  const outfits = async () =>
    (await t.db.select({ n: count() }).from(outfit))[0].n;

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    await createAccessToken(t, { name: 'Stylist' });
    const [token] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, ownerId));
    tokenId = token.id;
    tee = await closetGarment('Blue tee', 'tops');
    jeans = await closetGarment('Jeans', 'bottoms');
    const blazers = await need('A navy blazer');
    const knits = await need('A grey knit');
    // Written out of rank order: the strip puts them in the agent's.
    blazerTwo = await pick('Linen blazer', 'outerwear', blazers, 2);
    knit = await pick('Grey knit', 'outerwear', knits, 1);
    blazerOne = await pick('Wool blazer', 'outerwear', blazers, 1);
    ownShirt = await createWishlistItem(t, {
      name: 'Oxford shirt',
      category: 'tops',
    });
    boots = await pick('Chelsea boots', 'footwear', null, null);
    setAside = await pick('Navy cardigan', 'outerwear', knits, 2);
    expect(
      await decide(t.db, ownerId, {
        kind: 'dismiss-pick',
        garmentId: setAside,
        reason: 'colour',
        note: null,
      }),
    ).toMatchObject({ ok: true });
    const scarves = await need('A scarf');
    underSetAsideNeed = await pick('Silk scarf', 'accessories', scarves, 1);
    expect(
      await decide(t.db, ownerId, {
        kind: 'dismiss-group',
        groupId: scarves,
        reason: 'not_now',
        note: null,
      }),
    ).toMatchObject({ ok: true });

    grantee = await t.register('grantee-picks@example.com');
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const shareToken = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    const accepted = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${shareToken}/accept`,
      payload: {},
      headers: { cookie: grantee },
    });
    expect(accepted.statusCode).toBeLessThan(400);
  });

  afterAll(() => t?.cleanup());

  describe('the toggle', () => {
    it('is off on the bare page, which shows no pick and stays byte-stable', async () => {
      const first = await get('/styling');
      const second = await get('/styling');
      expect(first.body).toBe(second.body);
      expect(first.body).not.toContain('data-mark="to-buy"');
      expect(first.body).not.toContain('name="picks"');
      expect(switchOf(first.body)).toEqual({
        checked: 'false',
        vals: { picks: '1' },
        push: '/styling?picks=1',
      });
    });

    it('on, it switches back off and carries itself in the rows', async () => {
      const page = (await get('/styling?picks=1')).body;
      const html = unescapeHtml(page);
      expect(switchOf(page)).toEqual({
        checked: 'true',
        vals: { picks: '' },
        push: '/styling',
      });
      expect(html).toContain('<input type="hidden" name="picks" value="1"');
      // Anything but 1 is off.
      expect((await get('/styling?picks=yes')).body).toBe(
        (await get('/styling')).body,
      );
    });

    it('is not offered, and not read, while picking for a day or over a shared wardrobe', async () => {
      const day = await get(
        `/styling?for=day:${t.today()}&occasion=all-day&picks=1`,
      );
      expect(day.statusCode).toBe(200);
      expect(day.body).not.toContain('data-styling-picks');
      expect(day.body).not.toContain('data-mark="to-buy"');
      const shared = await get(`/styling?ownerId=${ownerId}&picks=1`, grantee);
      expect(shared.statusCode).toBe(200);
      expect(shared.body).not.toContain('data-styling-picks');
      expect(shared.body).not.toContain('data-mark="to-buy"');
    });

    it('an old ?plan= link is plain Styling', async () => {
      const old = await get('/styling?plan=1');
      expect(old.statusCode).toBe(200);
      expect(old.body).not.toContain('data-mark="to-buy"');
    });
  });

  describe('the strips with picks on', () => {
    it('lead each role with its picks, badged, a need’s options side by side in rank, then the lone and own ones', async () => {
      const page = (await get('/styling?picks=1')).body;
      // Needs newest first (the knit's, then the blazer's in rank order).
      expect(stripOf(page, 'layer')).toEqual([knit, blazerOne, blazerTwo]);
      expect(stripOf(page, 'top')).toEqual([ownShirt, tee]);
      // A role the closet has nothing of still gets its row.
      expect(stripOf(page, 'footwear')).toEqual([boots]);
      expect(page.match(/data-mark="to-buy"/g)).toHaveLength(5);
      // Opened on no garment at all, a piece to buy least of all.
      expect(carries(page, tee)).toBe(false);
      expect(carries(page, blazerOne)).toBe(false);
    });

    it('leave out a pick set aside and the picks of a need set aside', async () => {
      const page = (await get('/styling?picks=1')).body;
      expect(page).not.toContain(`data-snap-value="${setAside}"`);
      expect(page).not.toContain(`data-snap-value="${underSetAsideNeed}"`);
    });

    it('cost no statement more than the bare page', async () => {
      const bare = await recordQueries(() => get('/styling'));
      const picks = await recordQueries(() => get('/styling?picks=1'));
      expect(picks.statements).toBe(bare.statements);
    });
  });

  describe('the switch keeps the composition', () => {
    it('answers the rows posted, locks and all, with the picks on, and pushes the page’s address', async () => {
      const posted: [string, number | null, boolean][] = [
        ['top', tee, true],
        ['bottom', jeans, false],
      ];
      const on = await get(
        `/styling/row?${rowsQuery(posted, { picks: '1', with: String(tee) })}`,
      );
      expect(on.statusCode).toBe(200);
      const html = unescapeHtml(on.body);
      expect(carries(html, tee)).toBe(true);
      expect(carries(html, jeans)).toBe(true);
      const top = html.slice(
        html.indexOf('data-styling-row="top"'),
        html.indexOf('data-styling-row="bottom"'),
      );
      expect(top).toContain('name="lock" value="1"');
      expect(stripOf(html, 'layer')).toEqual([knit, blazerOne, blazerTwo]);
      expect(switchOf(on.body)).toEqual({
        checked: 'true',
        vals: { picks: '' },
        // Where it goes next: off again, "Style this"'s garment kept.
        push: `/styling?with=${tee}`,
      });
    });

    it('replaces the capsule menu out of band, its links carrying the new state', async () => {
      const created = await t.inject({
        method: 'POST',
        url: '/capsules',
        payload: { name: 'Office' },
      });
      const capsuleId = Number(
        /^\/capsules\/(\d+)/.exec(String(created.headers.location))![1],
      );
      const rows: [string, number | null, boolean][] = [['top', tee, false]];
      const scopeOf = (body: string) => {
        const html = unescapeHtml(body);
        const start = html.indexOf('id="styling-scope"');
        expect(start, 'the scope menu').toBeGreaterThan(-1);
        return html.slice(
          html.lastIndexOf('<div', start),
          html.indexOf('</details>', start),
        );
      };
      const on = scopeOf(
        (await get(`/styling/row?${rowsQuery(rows, { picks: '1' })}`)).body,
      );
      expect(on).toContain('hx-swap-oob="true"');
      expect(on).toContain(`href="/styling?capsule=${capsuleId}&picks=1"`);
      expect(on).toContain('href="/styling?picks=1"');
      const off = scopeOf(
        (await get(`/styling/row?${rowsQuery(rows, { picks: '' })}`)).body,
      );
      expect(off).toContain(`href="/styling?capsule=${capsuleId}"`);
      expect(off).not.toContain('picks=1');
    });

    it('off again, a pick chosen leaves its row; the closet’s stay', async () => {
      const off = await get(
        `/styling/row?${rowsQuery(
          [
            ['layer', blazerOne, false],
            ['top', tee, false],
          ],
          { picks: '' },
        )}`,
      );
      const html = unescapeHtml(off.body);
      expect(carries(html, blazerOne)).toBe(false);
      expect(carries(html, tee)).toBe(true);
      expect(html).not.toContain('data-mark="to-buy"');
      expect(switchOf(off.body)?.checked).toBe('false');
    });

    it('is not in the rows over a shared wardrobe nor with a destination', async () => {
      const shared = await get(
        `/styling/row?${rowsQuery([['top', null, false]], { ownerId: String(ownerId), picks: '1' })}`,
        grantee,
      );
      expect(switchOf(shared.body)).toBeUndefined();
      const day = await get(
        `/styling/row?${rowsQuery([['top', tee, false]], { for: `day:${t.today()}`, occasion: 'all-day', picks: '1' })}`,
      );
      expect(switchOf(day.body)).toBeUndefined();
    });
  });

  describe('where the switch is offered', () => {
    it('an empty capsule offers it as a link (picks alone make rows); an empty closet only once on', async () => {
      // The first-run gate (#666): a closet with no outfit in it offers no
      // switch, but ?picks=1 keeps the one that turns it off.
      const cookie = await t.register('empty-closet-picks@example.com');
      await createWishlistItem(t, {
        name: 'First coat',
        category: 'outerwear',
        cookie,
      });
      const empty = (await get('/styling', cookie)).body;
      expect(empty).not.toContain('data-styling-picks');
      const on = unescapeHtml((await get('/styling?picks=1', cookie)).body);
      expect(on).toContain('data-mark="to-buy"');
      expect(on).toContain('data-styling-row="layer"');
      expect(on).toMatch(/data-styling-picks="on"/);
      const capsule = await t.inject({
        method: 'POST',
        url: '/capsules',
        payload: { name: 'Empty for now' },
      });
      const capsuleId = Number(
        /^\/capsules\/(\d+)/.exec(String(capsule.headers.location))![1],
      );
      const inCapsule = unescapeHtml(
        (await get(`/styling?capsule=${capsuleId}`)).body,
      );
      expect(inCapsule).toContain(
        `href="/styling?capsule=${capsuleId}&picks=1"`,
      );
    });

    it('an edit of a planned outfit offers none, and its rows drop a pick posted to them', async () => {
      // Garment sets of their own: a save of a set already saved reuses it.
      const saved = await save({
        role: ['bottom'],
        garmentId: [String(jeans)],
        lock: [''],
        name: 'Planned jeans',
      });
      const id = Number(
        /^\/outfits\/(\d+)/.exec(String(saved.headers.location))![1],
      );
      expect(
        (
          await t.inject({
            method: 'POST',
            url: '/calendar',
            payload: { outfitId: String(id), date: t.today() },
          })
        ).statusCode,
      ).toBe(302);
      const page = (await get(`/styling?outfit=${id}&picks=1`)).body;
      expect(page).not.toContain('data-styling-picks');
      expect(page).not.toContain('data-mark="to-buy"');
      const rows = await get(
        `/styling/row?${rowsQuery(
          [
            ['layer', blazerOne, false],
            ['top', tee, false],
          ],
          { outfit: String(id), picks: '1' },
        )}`,
      );
      expect(carries(rows.body, blazerOne)).toBe(false);
      expect(carries(rows.body, tee)).toBe(true);
      expect(switchOf(rows.body)).toBeUndefined();
      // Unplanned, the same edit offers it again.
      const unplanned = await save({
        role: ['top'],
        garmentId: [String(tee)],
        lock: [''],
        name: 'Tee alone',
      });
      const free = Number(
        /^\/outfits\/(\d+)/.exec(String(unplanned.headers.location))![1],
      );
      expect(
        switchOf((await get(`/styling?outfit=${free}&picks=1`)).body)?.checked,
      ).toBe('true');
    });
  });

  describe('Shuffle and "Add row"', () => {
    it('Shuffle never draws a pick, and keeps a locked one', async () => {
      const res = await get(
        `/styling/shuffle?${rowsQuery(
          [
            ['layer', blazerOne, true],
            ['top', null, false],
            ['bottom', null, false],
          ],
          { picks: '1', seed: '3' },
        )}`,
      );
      expect(res.statusCode).toBe(200);
      expect(carries(res.body, blazerOne)).toBe(true);
      expect(stripOf(res.body, 'layer')).toEqual([knit, blazerOne, blazerTwo]);
      for (const id of [ownShirt, boots, knit, blazerTwo]) {
        expect(carries(res.body, id)).toBe(false);
      }
    });

    it('"Add row" keeps a chosen pick; without picks on the row drops it', async () => {
      const rows: [string, number | null, boolean][] = [
        ['layer', blazerOne, false],
        ['top', tee, false],
      ];
      const on = await get(
        `/styling/row?${rowsQuery(rows, { picks: '1', add: 'footwear' })}`,
      );
      expect(on.statusCode).toBe(200);
      expect(carries(on.body, blazerOne)).toBe(true);
      const off = await get(
        `/styling/row?${rowsQuery(rows, { add: 'footwear' })}`,
      );
      expect(carries(off.body, blazerOne)).toBe(false);
      expect(carries(off.body, tee)).toBe(true);
    });
  });

  describe('Save', () => {
    it('saves an incomplete outfit holding the pick, once however often it is posted', async () => {
      const before = await outfits();
      const posted = {
        picks: '1',
        role: ['layer', 'top', 'bottom'],
        garmentId: [blazerOne, tee, jeans].map(String),
        lock: ['', '', ''],
      };
      const res = await save(posted);
      expect(res.statusCode, res.body).toBe(303);
      const id = Number(
        /^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1],
      );
      expect(await slotsOf(id)).toEqual([blazerOne, tee, jeans]);
      expect(await outfits()).toBe(before + 1);
      const page = unescapeHtml((await get(`/outfits/${id}`)).body);
      expect(page).toContain('To wear this, buy');
      const again = await save(posted);
      expect(again.headers.location).toBe(`/outfits/${id}?alreadySaved=1`);
      expect(await outfits()).toBe(before + 1);
    });

    it('saves a complete one too, and plans it on the sheet’s day', async () => {
      const res = await save({
        picks: '1',
        role: ['top', 'bottom'],
        garmentId: [ownShirt, jeans].map(String),
        lock: ['', ''],
        name: 'Shirt to buy',
      });
      expect(res.statusCode).toBe(303);
      const planned = await save({
        picks: '1',
        role: ['top', 'bottom'],
        garmentId: [tee, jeans].map(String),
        lock: ['', ''],
        scheduleDate: t.today(),
      });
      expect(planned.statusCode).toBe(303);
      expect(planned.headers.location).toBe(`/calendar?week=${t.today()}`);
    });

    it('planned on the sheet’s day with a pick: the page again, its rows and the piece kept, nothing saved', async () => {
      const before = await outfits();
      const res = await save({
        picks: '1',
        role: ['footwear', 'top'],
        garmentId: [boots, tee].map(String),
        lock: ['', ''],
        scheduleDate: t.today(),
        name: 'Boots for today',
      });
      expect(res.statusCode).toBe(409);
      const body = unescapeHtml(res.body);
      expect(body).toContain('data-styling-refused');
      expect(body).toContain(
        'Buy Chelsea boots first: an outfit with pieces not bought yet can’t be planned or packed.',
      );
      expect(body).toContain(`href="/wardrobe/${boots}/bought"`);
      expect(carries(res.body, boots)).toBe(true);
      expect(body).toMatch(/name="name"[^>]*value="Boots for today"/);
      expect(await outfits()).toBe(before);
    });

    it('without picks on, a pick in the rows is refused as before, nothing saved', async () => {
      const before = await outfits();
      const res = await save({
        role: ['layer', 'top'],
        garmentId: [blazerTwo, tee].map(String),
        lock: ['', ''],
      });
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain(
        'Linen blazer is on your wishlist, not bought yet',
      );
      expect(await outfits()).toBe(before);
    });

    it('the writer judges what it may hold: a pick set aside, an archived garment and one set aside after the page loaded are refused, nothing saved', async () => {
      const before = await outfits();
      const aside = await save({
        picks: '1',
        role: ['layer', 'top'],
        garmentId: [setAside, tee].map(String),
        lock: ['', ''],
      });
      expect(aside.statusCode).toBe(409);
      expect(unescapeHtml(aside.body)).toContain(
        'Navy cardigan was set aside, so it is not on offer to style',
      );
      const old = await closetGarment('Old shorts', 'bottoms');
      expect(
        (await t.inject({ method: 'POST', url: `/wardrobe/${old}/archive` }))
          .statusCode,
      ).toBeLessThan(400);
      const archived = await save({
        picks: '1',
        role: ['top', 'bottom'],
        garmentId: [tee, old].map(String),
        lock: ['', ''],
      });
      expect(archived.statusCode).toBe(409);
      expect(unescapeHtml(archived.body)).toContain('Old shorts is archived');
      // Offered when the page loaded, set aside before the Save reached it.
      const late = await pick('Late knit', 'outerwear', null, null);
      const page = (await get('/styling?picks=1')).body;
      expect(page).toContain(`data-snap-value="${late}"`);
      expect(
        await decide(t.db, ownerId, {
          kind: 'dismiss-pick',
          garmentId: late,
          reason: 'style',
          note: null,
        }),
      ).toMatchObject({ ok: true });
      const raced = await save({
        picks: '1',
        role: ['layer', 'top'],
        garmentId: [late, tee].map(String),
        lock: ['', ''],
      });
      expect(raced.statusCode).toBe(409);
      expect(unescapeHtml(raced.body)).toContain('Late knit was set aside');
      expect(await outfits()).toBe(before);
    });

    it('keeps the posted order of two rows of one role', async () => {
      const watch = await accessory('Steel watch');
      const belt = await accessory('Brown belt');
      // Posted newest first: the database's own order would be the other.
      const res = await save({
        picks: '1',
        role: ['top', 'accessory', 'accessory'],
        garmentId: [tee, belt, watch].map(String),
        lock: ['', '', ''],
      });
      expect(res.statusCode, res.body).toBe(303);
      const id = Number(
        /^\/outfits\/(\d+)/.exec(String(res.headers.location))![1],
      );
      expect(await slotsOf(id)).toEqual([tee, belt, watch]);
    });

    it('a saved outfit swaps one pick for another of its need', async () => {
      const created = await save({
        picks: '1',
        role: ['layer', 'bottom'],
        garmentId: [blazerTwo, jeans].map(String),
        lock: ['', ''],
      });
      const id = Number(
        /^\/outfits\/(\d+)/.exec(String(created.headers.location))![1],
      );
      const edited = await save({
        picks: '1',
        outfit: String(id),
        role: ['layer', 'bottom'],
        garmentId: [blazerOne, jeans].map(String),
        lock: ['', ''],
        name: 'The wool one',
      });
      expect(edited.statusCode).toBe(303);
      expect(await slotsOf(id)).toEqual([blazerOne, jeans]);
    });

    it('a post with picks on and a destination is a 400', async () => {
      const res = await save({
        picks: '1',
        for: `day:${t.today()}`,
        occasion: 'all-day',
        role: ['top'],
        garmentId: [String(tee)],
        lock: [''],
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
