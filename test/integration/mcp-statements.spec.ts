import { PassThrough, Readable } from 'node:stream';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  capsule,
  garment,
  garmentRepair,
  outfit,
  outfitCalendar,
  outfitSlot,
  personalAccessToken,
  trip,
  wardrobeShare,
} from '../../src/db/schema';
import { runSeed } from '../../src/seed/seed';
import { addDays } from '../../src/calendar-date';
import {
  addInspirationPiece,
  saveInspiration,
} from '../../src/web/inspiration/queries';
import { createOptionGroup } from '../../src/web/wishlist/decisions';
import { MCP_WRITES } from '../../src/web/api/operations';
import {
  FULL_SCOPE,
  type TokenScope,
} from '../../src/web/auth/personal-tokens';
import { mcpTools } from '../../src/web/mcp/tools';
import { recordStatements } from '../support/query-recorder';
import {
  STUB_WEATHER_NOW,
  startWeatherStub,
  type WeatherStub,
} from '../support/weather-stub';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  userIdOf,
  asFixture,
} from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { callTool, mcpRequest, mintToken, scopeFields } from './mcp';

/**
 * What each MCP tool costs in statements (#172): production reaches
 * Postgres over a link that costs a round trip per statement (#156), so
 * the count is the latency. Theo (the demo persona) calls every tool as
 * the page audit does (`npm run audit:pages -- --only '#172'`): with the
 * weather on, each call made once untimed and then counted, so a write
 * counts its repeat and a forecast is warm. Every count includes the
 * token's own read (authenticateToken). The tools' behaviour is mcp.spec,
 * mcp-muse.spec and mcp-photos.spec's; this one pins
 * the statements, and proves the reads #172 dropped are gone. With every
 * tool's arguments at hand it also holds the token scopes (#701): a
 * read-only token's reads write nothing, an own-wardrobe-only token is
 * refused every shared wardrobe.
 */

const DEMO_EMAIL = 'demo@closet.invalid';
const DEMO_PASSWORD = 'Closet-demo-1';

/**
 * The token's last-use mark is written at most once a minute
 * (authenticateToken), so whether a call pays it depends on the clock:
 * counts leave it out.
 */
const LAST_USED = /^update "personal_access_token"/;

describe('MCP statements per tool (#172)', () => {
  let t: TestApp;
  let stub: WeatherStub;
  let sites: LinkSites;
  /** Theo's tokens, taken in turn: /mcp allows 120 calls a minute per token. */
  const tokens: string[] = [];
  let turn = 0;
  let today: string;
  const ids = {
    theo: 0,
    dana: 0,
    garment: 0,
    other: 0,
    copies: 0,
    wishlist: 0,
    outfit: 0,
    outfitGarments: [] as number[],
    capsule: 0,
    danaCapsule: 0,
    trip: 0,
    need: 0,
    look: 0,
  };
  let lookSets = 0;
  /** A closet garment with the wishlist item: a new set at every call. */
  const lookSet = () => [
    [ids.garment, ids.other, ids.copies][lookSets++ % 3],
    ids.wishlist,
  ];

  /** A tee's product page (a JSON-LD product with a photo and a price). */
  const teePage = () =>
    html(`<!doctype html><html><head><title>Pocket Tee</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Heavyweight Pocket Tee',
        brand: { '@type': 'Brand', name: 'Studio Knit' },
        color: 'Navy',
        image: [sites.url('/img/tee.jpg')],
        offers: { price: '48.00', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`);

  beforeAll(async () => {
    // The seed's history and the stub's weather are both the date's.
    vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW });
    stub = await startWeatherStub();
    sites = await startLinkSites();
    sites.serve('/img/tee.jpg', jpeg(await productShot('#223355')));
    sites.serve('/products/tee', teePage());
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options, outboundFetch: sites.outboundFetch },
    );
    let stdout = '';
    const output = new PassThrough();
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const status = await runSeed({
      args: ['--persona', 'demo', '--persona', 'sparse', '--password-stdin'],
      db: t.db,
      photos: t.photos,
      logger: t.logger,
      timeZone: 'America/New_York',
      weatherEnabled: true,
      input: Readable.from([`${DEMO_PASSWORD}\n`]),
      output,
      errors: new PassThrough(),
      now: new Date(),
    });
    expect(status, stdout).toBe(0);
    today = t.today();
    const cookie = await t.login(DEMO_EMAIL, DEMO_PASSWORD);
    for (let i = 0; i < 4; i++) {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: {
          name: `Statements ${i}`,
          currentPassword: DEMO_PASSWORD,
          ...scopeFields(FULL_SCOPE),
        },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      tokens.push(/closet_[A-Za-z0-9_-]{43}/.exec(res.body)![0]);
    }
    await findIds();
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    await t?.cleanup();
    await stub?.close();
    await sites?.close();
  });

  async function findIds() {
    ids.theo = await userIdOf(t, DEMO_EMAIL);
    ids.look = await saveInspiration(t.db, ids.theo, null, {
      title: 'Statements look',
      sourceUrl: sites.url('/products/tee'),
    });
    await addInspirationPiece(t.db, ids.look, ids.theo, {
      role: 'top',
      type: 't-shirt',
      colors: ['blue'],
      pattern: null,
    });
    const [repaired] = await t.db
      .select({ id: garment.id })
      .from(garmentRepair)
      .innerJoin(garment, eq(garment.id, garmentRepair.garmentId))
      .where(and(eq(garment.ownerId, ids.theo), eq(garment.status, 'closet')))
      .orderBy(asc(garmentRepair.id))
      .limit(1);
    ids.garment = repaired.id;
    const closet = await t.db
      .select({ id: garment.id })
      .from(garment)
      .where(
        and(
          eq(garment.ownerId, ids.theo),
          eq(garment.status, 'closet'),
          ne(garment.id, ids.garment),
        ),
      )
      .orderBy(asc(garment.id))
      .limit(2);
    [ids.other, ids.copies] = closet.map((row) => row.id);
    const [wished] = await t.db
      .select({ id: garment.id })
      .from(garment)
      .where(and(eq(garment.ownerId, ids.theo), eq(garment.status, 'wishlist')))
      .orderBy(asc(garment.id))
      .limit(1);
    ids.wishlist = wished.id;
    const [token] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, ids.theo))
      .orderBy(asc(personalAccessToken.id))
      .limit(1);
    const need = await createOptionGroup(t.db, ids.theo, {
      name: 'Statements need',
      budget: null,
      note: null,
      tokenId: token.id,
    });
    if (!need.ok) throw new Error('The statements need exists');
    ids.need = need.id;
    const worn = sql<number>`count(*)`;
    const [favourite] = await t.db
      .select({ id: outfit.id, worn })
      .from(outfit)
      .innerJoin(outfitCalendar, eq(outfitCalendar.outfitId, outfit.id))
      .where(
        and(eq(outfit.ownerId, ids.theo), isNotNull(outfitCalendar.wornAt)),
      )
      .groupBy(outfit.id)
      .orderBy(desc(worn), asc(outfit.id))
      .limit(1);
    ids.outfit = favourite.id;
    const slots = await t.db
      .select({ garmentId: outfitSlot.garmentId })
      .from(outfitSlot)
      .where(
        and(
          eq(outfitSlot.outfitId, ids.outfit),
          isNotNull(outfitSlot.garmentId),
        ),
      )
      .orderBy(asc(outfitSlot.position));
    ids.outfitGarments = slots.map((slot) => slot.garmentId!);
    const [office] = await t.db
      .select({ id: capsule.id })
      .from(capsule)
      .where(and(eq(capsule.ownerId, ids.theo), eq(capsule.name, 'Office')));
    ids.capsule = office.id;
    const [firstTrip] = await t.db
      .select({ id: trip.id })
      .from(trip)
      .where(eq(trip.ownerId, ids.theo))
      .orderBy(asc(trip.id))
      .limit(1);
    ids.trip = firstTrip.id;
    const [share] = await t.db
      .select({ danaId: wardrobeShare.grantorId })
      .from(wardrobeShare)
      .where(eq(wardrobeShare.granteeId, ids.theo));
    ids.dana = share.danaId;
    const [danas] = await asFixture(t.db, (tx) =>
      tx
        .insert(capsule)
        .values({ ownerId: ids.dana, name: 'Dana’s own' })
        .returning({ id: capsule.id }),
    );
    ids.danaCapsule = danas.id;
  }

  const day = (offset: number) => addDays(today, offset);

  /**
   * The tool called once (a write's first effect, a forecast's first
   * fetch), then again, counted: the statements of the second call, the
   * token's last-use mark left out (LAST_USED). `againArgs` for a write
   * that refuses its own repeat (create_plan's name is taken by then).
   */
  async function statementsOf(
    name: string,
    args: Record<string, unknown>,
    againArgs = args,
  ) {
    const token = tokens[turn++ % tokens.length];
    const first = await callTool(t, token, name, args);
    expect(first.isError, JSON.stringify(first.value)).toBe(false);
    const record = await recordQueries(async () => {
      const again = await callTool(t, token, name, againArgs);
      expect(again.isError, JSON.stringify(again.value)).toBe(false);
    });
    return record.sql.filter((statement) => !LAST_USED.test(statement));
  }

  // The tool, its arguments (made anew for each call) and its statements
  // (the token's read included). Before #172 in the comment where it changed.
  let needs = 0;
  let products = 0;
  let warmths = 0;
  /** A product page of its own: suggest_garment refuses a link twice. */
  const product = () => {
    const path = `/products/pick-${++products}`;
    sites.serve(path, teePage());
    return sites.url(path);
  };
  const cases: [string, () => Record<string, unknown>, number][] = [
    ['get_today', () => ({}), 3], // 6: the weather twice, worn apart
    ['search_garments', () => ({ category: 'tops' }), 3],
    // get_wardrobe: the garments, then every garment's wears in one
    // grouped statement (`wearCountsByGarment`); a grantee's has the share read and no wears.
    ['get_wardrobe', () => ({}), 3],
    ['get_wardrobe', () => ({ ownerId: ids.dana }), 3],
    ['get_garment', () => ({ id: ids.garment }), 3], // 5
    ['get_garment_photo', () => ({ id: ids.garment }), 3],
    // The garment, its one update (only what changed: each call a new
    // warmth, or the repeat would write nothing), the answer's context.
    [
      'update_garment',
      () => ({ id: ids.other, warmth: (++warmths % 5) + 1 }),
      4, // 7; 5 until #372 read the garment back
    ],
    ['add_garment_copy', () => ({ id: ids.copies, copies: 1 }), 7], // 9
    ['list_wishlist', () => ({}), 2],
    [
      'add_garment_from_link',
      () => ({ url: sites.url('/products/tee'), destination: 'wishlist' }),
      13, // 14: the capsules and the wears apart
    ],
    ['list_capsules', () => ({}), 2],
    ['get_capsule', () => ({ id: ids.capsule }), 3],
    [
      'set_capsule_membership',
      () => ({ id: ids.capsule, add: [ids.garment] }),
      5, // 7: the capsule read first, and each side locked apart
    ],
    ['list_outfits', () => ({}), 2],
    ['get_outfit', () => ({ id: ids.outfit }), 2],
    [
      'create_outfit',
      () => ({ garmentIds: ids.outfitGarments, name: 'Statements' }),
      7, // 10 with four garments: a read per garment
    ],
    [
      'schedule_outfit',
      () => ({ outfitId: ids.outfit, date: day(5), occasion: 'evening' }),
      6, // 7: the day's entries read again for the occasion kept
    ],
    ['suggest_outfits', () => ({ date: day(1), occasion: 'work' }), 2],
    // Saved looks (#22d): the list's one statement, the match view's one.
    ['list_inspiration', () => ({}), 2],
    ['get_inspiration', () => ({ id: ids.look }), 2],
    // The paste's: the pending photo kept (begin, insert, the cap's
    // eviction, commit), then claimed with the look (begin, the name's
    // lock, the pending row taken, the file, the look, commit), read back.
    ['add_inspiration', () => ({ url: sites.url('/products/tee') }), 12],
    // begin, the look's lock, its pieces (the same ones: no write),
    // commit, then get_inspiration's read.
    [
      'set_inspiration_pieces',
      () => ({
        id: ids.look,
        pieces: [{ role: 'top', type: 't-shirt', colors: ['blue'] }],
      }),
      6,
    ],
    ['goes_with_closet', () => ({ garmentId: ids.wishlist }), 2],
    [
      'pick_outfit',
      () => ({
        garmentIds: ids.outfitGarments,
        date: day(6),
        occasion: 'evening',
      }),
      7,
    ],
    ['get_calendar', () => ({ from: day(-7), to: day(7) }), 2], // 3
    ['laundry_status', () => ({}), 2],
    ['mark_worn', () => ({ garmentId: ids.garment }), 2],
    ['mark_washed', () => ({ garmentIds: [ids.garment] }), 2],
    // The template, the window's entries and its trips in one (#684).
    ['plan_week', () => ({}), 6],
    ['list_trips', () => ({}), 2],
    ['get_trip', () => ({ tripId: ids.trip }), 2],
    // The trip and outfit locked, then the insert judged after the lock
    // (#335: an edit adding a piece to buy must be seen), in a transaction.
    ['plan_trip_outfit', () => ({ tripId: ids.trip, outfitId: ids.outfit }), 5],
    ['wardrobe_stats', () => ({}), 3],
    ['get_weather', () => ({ from: today, to: day(3) }), 2],
    ['list_shared_wardrobes', () => ({}), 2],
    ['compare_with_shared_wardrobe', () => ({ ownerId: ids.dana }), 4],
    ['get_style_profile', () => ({}), 2], // 3
    ['get_sizes', () => ({}), 3],
    // Muse's (#337). The closet, as a plan's gap view read it.
    ['get_closet_coverage', () => ({ targets: [{ category: 'tops' }] }), 2],
    // The inbox's one statement (readInbox) and the Outfits tab's Muse
    // outfits beside it, in parallel.
    ['list_suggestions', () => ({}), 3],
    // Every list and the cursor's move in one statement.
    ['get_suggestion_feedback', () => ({}), 2],
    // begin, owner lock, the lookup and insert in one, commit.
    ['create_option_group', () => ({ name: `Statements need ${++needs}` }), 5],
    // The room and the links read before the fetch (one), the link
    // import's own (add_garment_from_link's, its garment's transaction
    // holding markSuggestedProduct's savepoint, lock, links read again and
    // mark), the garment read back.
    [
      'suggest_garment',
      () => ({ url: product(), groupId: ids.need, note: 'Statements' }),
      18,
    ],
    // create_outfit's: the garments, begin, owner lock, the outfit, its
    // slots, commit.
    [
      'suggest_outfit',
      () => ({ garmentIds: lookSet(), note: 'Statements' }),
      7,
    ],
    // begin, owner lock, the round (the previous one's end, the counts and
    // the insert in one), commit; the cursor's update is one more, left out
    // with the last-use mark (LAST_USED matches both). The counted repeat
    // has nothing new: no round, no notification.
    [
      'finish_round',
      () => ({
        summary: 'Statements',
        feedbackUntil: new Date().toISOString(),
      }),
      5,
    ],
  ];

  it.each(cases)('%s', async (name, args, expected) => {
    const statements = await statementsOf(name, args(), args());
    expect(statements, statements.join('\n\n')).toHaveLength(expected);
  });

  it('lists every tool the server offers', async () => {
    const res = await mcpRequest(t, tokens[0], 'tools/list');
    const listed = res
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((tool) => tool.name);
    expect(new Set(cases.map(([name]) => name))).toEqual(new Set(listed));
  });

  /**
   * Token scope (#701), here for the fixture: every tool's arguments
   * (`cases`) and a MANAGE share (Dana's, the seed's) to refuse.
   */
  describe('a scoped token (#701)', () => {
    let readOnly: { id: number; token: string };
    let ownOnly: { id: number; token: string };
    let danaGarment: number;

    /** Through the writer: four page mints already spent ACCOUNT_LIMIT's minute. */
    const mint = async (name: string, scope: TokenScope) => {
      const created = await mintToken(t, ids.theo, name, 'mcp', scope);
      if (!created.created) throw new Error(`No ${name} token`);
      return { id: created.id, token: created.token };
    };

    beforeAll(async () => {
      readOnly = await mint('Read only', {
        readOnly: true,
        ownWardrobeOnly: false,
      });
      ownOnly = await mint('Own only', {
        readOnly: false,
        ownWardrobeOnly: true,
      });
      const [first] = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(and(eq(garment.ownerId, ids.dana), isNotNull(garment.photoId)))
        .orderBy(asc(garment.id))
        .limit(1);
      danaGarment = first.id;
    });

    /**
     * Every table's rows as one digest each, in one statement: what a call
     * changed, revisions and `updated_at` included. Left out: the location
     * caches (weather_forecast, weather_normals: no user's rows, refreshed
     * by any read of the weather) and the token's own last-use mark.
     */
    async function tableDigests(): Promise<Record<string, string>> {
      const { rows: tables } = await t.db.execute<{ name: string }>(sql`
        select table_name as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
          and table_name not in ('weather_forecast', 'weather_normals')
        order by 1`);
      const digests = tables.map(
        ({ name }) => sql`select ${name} as name, count(*) || ':' ||
          coalesce(md5(string_agg(r::text, '|' order by r::text)), '') as digest
          from (select to_jsonb(x) - 'last_used_at' as r
                from ${sql.identifier(name)} x) rows`,
      );
      const { rows } = await t.db.execute<{ name: string; digest: string }>(
        sql.join(digests, sql` union all `),
      );
      return Object.fromEntries(rows.map((row) => [row.name, row.digest]));
    }

    /** The tables a statement writes, `for update` locks aside. */
    const writtenTables = (statement: string) =>
      [
        ...statement
          .replace(/\bfor (no key )?update( of "\w+")?/gi, '')
          .matchAll(/\b(?:insert into|update|delete from)\s+"(\w+)"/gi),
      ].map((match) => match[1]);
    const WEATHER_CACHES = new Set(['weather_forecast', 'weather_normals']);
    /** The token's last-use mark (authenticateToken), and nothing else of its row. */
    const LAST_USE_MARK =
      /^update "personal_access_token" set "last_used_at" = \$1 where "personal_access_token"\."id" = \$2$/;

    // The read tools, by their flag, each with the arguments its statement
    // case calls it with.
    const readCases = cases.filter(([name]) => !(name in MCP_WRITES));

    it('runs every tool marked writes: false, and only those', () => {
      expect(new Set(readCases.map(([name]) => name))).toEqual(
        new Set(
          mcpTools({ weather: true })
            .filter((listed) => listed.writes === false)
            .map((listed) => listed.name),
        ),
      );
    });

    it.each(readCases)(
      'a read-only token’s %s writes nothing but a location cache, on a cold cache, and wakes no job',
      async (name, args) => {
        // Cold: the forecast and the normals fetched again, the one write
        // a read may make (get_weather, get_today, get_calendar, get_trip).
        await t.db.execute(sql`delete from weather_forecast`);
        await t.db.execute(sql`delete from weather_normals`);
        const wake = vi.spyOn(t.cutouts, 'wake');
        const before = await tableDigests();
        const { statements } = await recordStatements(async () => {
          const answer = await callTool(t, readOnly.token, name, args());
          expect(answer.isError, JSON.stringify(answer.value)).toBe(false);
          await t.weather!.settled();
        });
        expect(await tableDigests()).toEqual(before);
        const writes = statements
          .filter(
            (statement) =>
              !LAST_USE_MARK.test(statement.sql) &&
              writtenTables(statement.sql).some(
                (table) => !WEATHER_CACHES.has(table),
              ),
          )
          .map((statement) => statement.sql);
        expect(writes).toEqual([]);
        expect(wake).not.toHaveBeenCalled();
        wake.mockRestore();
      },
    );

    it('a read-only token’s use is marked once its last mark is a minute old, and nothing else is written', async () => {
      const stale = new Date(Date.now() - 61_000);
      await t.db
        .update(personalAccessToken)
        .set({ lastUsedAt: stale })
        .where(eq(personalAccessToken.id, readOnly.id));
      const before = await tableDigests();
      const { statements } = await recordStatements(() =>
        callTool(t, readOnly.token, 'get_suggestion_feedback'),
      );
      expect(await tableDigests()).toEqual(before);
      expect(statements.filter((s) => writtenTables(s.sql).length > 0)).toEqual(
        [
          expect.objectContaining({
            sql: expect.stringMatching(LAST_USE_MARK),
          }),
        ],
      );
      const [row] = await t.db
        .select({
          lastUsedAt: personalAccessToken.lastUsedAt,
          feedbackReadAt: personalAccessToken.feedbackReadAt,
        })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.id, readOnly.id));
      expect(row.lastUsedAt!.getTime()).toBe(Date.now());
      // A read leaves the cursor where it was: only finish_round moves it.
      expect(row.feedbackReadAt).toBeNull();
    });

    it('an own-wardrobe-only token is refused a MANAGE-shared wardrobe by every tool that takes an ownerId, as an unknown one, writing nothing', async () => {
      const shared = {
        get_wardrobe: {},
        search_garments: {},
        get_garment: { id: danaGarment },
        get_garment_photo: { id: danaGarment },
        update_garment: { id: danaGarment, name: 'Injected' },
        add_garment_copy: { id: danaGarment },
        list_wishlist: {},
        add_garment_from_link: { url: sites.url('/products/tee') },
        list_capsules: {},
        get_capsule: { id: ids.danaCapsule },
        set_capsule_membership: { id: ids.danaCapsule, add: [danaGarment] },
        mark_worn: { garmentId: danaGarment },
        mark_washed: { garmentIds: [danaGarment] },
        compare_with_shared_wardrobe: {},
      } satisfies Record<string, Record<string, unknown>>;
      expect(Object.keys(shared).sort()).toEqual(
        mcpTools({ weather: true })
          .filter((listed) => 'ownerId' in listed.input.shape)
          .map((listed) => listed.name)
          .sort(),
      );
      // The share is real: a full token reads Dana's garment.
      const full = tokens[0];
      expect(
        await callTool(t, full, 'get_garment', {
          id: danaGarment,
          ownerId: ids.dana,
        }),
      ).toMatchObject({ isError: false });

      const unknownOwner = 2_000_000_000;
      const before = await tableDigests();
      for (const [name, args] of Object.entries(shared)) {
        const refused = await callTool(t, ownOnly.token, name, {
          ...args,
          ownerId: ids.dana,
        });
        expect(refused, name).toEqual({
          value: { error: 'Wardrobe not found' },
          isError: true,
        });
        expect(
          await callTool(t, ownOnly.token, name, {
            ...args,
            ownerId: unknownOwner,
          }),
          name,
        ).toEqual(refused);
      }
      expect(await tableDigests()).toEqual(before);

      // No share is listed to it, while a full token's lists Dana's.
      expect(await callTool(t, ownOnly.token, 'list_shared_wardrobes')).toEqual(
        { value: { wardrobes: [] }, isError: false },
      );
      const listed = await callTool(t, full, 'list_shared_wardrobes');
      expect(listed.value.wardrobes).toEqual([
        expect.objectContaining({ ownerId: ids.dana, permission: 'MANAGE' }),
      ]);
      // Its own wardrobe answers as ever.
      expect(
        await callTool(t, ownOnly.token, 'get_garment', { id: ids.garment }),
      ).toMatchObject({ isError: false });
    });
  });

  describe('the reads #172 dropped', () => {
    it('get_garment reads its capsules, wears and repairs in one statement', async () => {
      const statements = await statementsOf('get_garment', { id: ids.garment });
      const context = statements.filter((s) => s.includes('"capsule"'));
      expect(context).toHaveLength(1);
      expect(context[0]).toContain('"garment_wear"');
      expect(context[0]).toContain('"garment_repair"');
    });

    it('create_outfit reads its garments once, whatever their number', async () => {
      const statements = await statementsOf('create_outfit', {
        garmentIds: ids.outfitGarments,
      });
      expect(ids.outfitGarments.length).toBeGreaterThan(1);
      const before = statements.slice(0, statements.indexOf('begin'));
      expect(before.filter((s) => s.includes('from "garment"'))).toHaveLength(
        1,
      );
    });

    it('set_capsule_membership reads no capsule before its write, and refuses another’s after it', async () => {
      const statements = await statementsOf('set_capsule_membership', {
        id: ids.capsule,
        add: [ids.other],
      });
      expect(statements.indexOf('begin')).toBe(1);
      const refused = await callTool(t, tokens[0], 'set_capsule_membership', {
        id: ids.danaCapsule,
        add: [ids.garment],
      });
      expect(refused).toEqual({
        value: { error: 'Capsule not found' },
        isError: true,
      });
    });

    it('schedule_outfit answers the occasion an outfit kept without reading the day', async () => {
      const [first] = await t.db
        .select({ occasion: outfitCalendar.occasion })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.ownerId, ids.theo),
            eq(outfitCalendar.outfitId, ids.outfit),
            eq(outfitCalendar.day, day(5)),
          ),
        );
      expect(first.occasion).toBe('evening');
      const again = await callTool(t, tokens[1], 'schedule_outfit', {
        outfitId: ids.outfit,
        date: day(5),
        occasion: 'work',
      });
      expect(again.value).toEqual({
        outcome: 'already-scheduled',
        date: day(5),
        occasion: 'evening',
      });
    });

    it('get_today reads worn today and the weather in its first statement', async () => {
      const statements = await statementsOf('get_today', {});
      const day = statements.filter((s) => s.includes('"outfit_calendar"'));
      expect(day[0]).toContain('"user_weather"');
      expect(day[0]).toContain('"garment_wear"');
      // The ideas take the model's weather: nothing reads it again.
      expect(
        statements.filter((s) => s.includes('"user_weather"')),
      ).toHaveLength(1);
    });
  });
});
