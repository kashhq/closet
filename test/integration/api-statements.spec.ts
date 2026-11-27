import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  STUB_WEATHER_NOW,
  startWeatherStub,
  type WeatherStub,
} from '../support/weather-stub';
import { deviceToken, SIGN_IN_URL, signInDevice } from './api';
import { createGarment, jpegPhoto, pngCutout } from './garments';
import {
  createTestApp,
  multipart,
  TEST_PASSWORD,
  type TestApp,
  userIdOf,
} from './harness';
import { jpeg, type LinkSites, startLinkSites } from './link-sites';
import { apiStatementsOf, statementsOf, twinCounter } from './twin-statements';
import {
  brandRow,
  calendarRows,
  everyResource,
  garment,
  ideaRows,
  lookRows,
  newTrip,
  outfitRows,
  repairedGarment,
  ruleRows,
  tripRows,
  wishlistRows,
} from './statement-rows';

/**
 * What each /api/v1 route costs in statements (#190; plan section 10):
 * production pays a round trip per statement, so the count is the latency.
 * These assertions are the gate (#721); each also lands in
 * build/statements.json as `<METHOD>:/api/v1/...` (recordQueries), which
 * the metrics report only reads. Every authenticated count is the token's
 * read (authenticateToken), as a page's is the session's, plus its
 * last-use write when the last one is a minute old (pinned both ways).
 *
 * A route that is a page route's twin (PAGE_WRITES) is pinned to its
 * twin's count, one case each (twin-statements.ts, on statement-rows.ts's
 * rows); the rest are pinned by hand.
 */

let t: TestApp;
let sites: LinkSites;
const twins = twinCounter();

beforeAll(async () => {
  sites = await startLinkSites();
  t = await createTestApp(
    {},
    { outboundFetch: sites.outboundFetch, onRoute: twins.onRoute },
  );
});

afterAll(async () => {
  await t?.cleanup();
  await sites?.close();
});

/**
 * The owner's device for the page-twin comparisons, signed in once: each
 * sign-in counts against SIGN_IN_ACCOUNT_LIMIT (5 a minute per email), and
 * this file signs the owner in for several of its own counts.
 */
let twinDevice: Promise<string> | undefined;
function twinToken(): Promise<string> {
  twinDevice ??= deviceToken(t).then(({ token }) => token);
  return twinDevice;
}

const upload = (
  data: Buffer,
  field: string,
  filename: string,
  contentType = 'image/jpeg',
) => multipart({}, { [field]: { data, filename, contentType } });

/** A GET as a second call of the minute: no last-use write. */
const warmGet = (token: string, url: string) =>
  apiStatementsOf(t, token, { method: 'GET', url });

describe('API statements per route', () => {
  it('GET /me: the token read, and its last-use write on the first call of a minute', async () => {
    await t.register('me-statements@example.com');
    const { token } = await deviceToken(t, {
      email: 'me-statements@example.com',
    });
    const me = () => t.api(token, { method: 'GET', url: '/api/v1/me' });
    const first = await statementsOf(me);
    expect(first).toMatchObject({ status: 200, statements: 2 });
    expect(first.sql[1]).toMatch(/^update "personal_access_token"/);
    const second = await statementsOf(me);
    expect(second).toMatchObject({ status: 200, statements: 1 });
  });

  it('POST /auth/token: the lookup, then the mint (its twin, POST /auth/tokens, pays the same)', async () => {
    const email = 'sign-in-statements@example.com';
    const cookie = await t.register(email);
    const signIn = await statementsOf(() => signInDevice(t, { email }));
    // findUserByEmail; then createToken: begin, the user's row locked with
    // its password, the list of devices, the insert, commit.
    expect(signIn).toMatchObject({ status: 201, statements: 6 });
    // The page that mints an agent token: the session with the hash, then
    // the same transaction.
    const twin = await statementsOf(() =>
      t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Twin', currentPassword: TEST_PASSWORD },
        headers: { cookie },
      }),
    );
    expect(twin).toMatchObject({ status: 200, statements: signIn.statements });
  });

  it('DELETE /auth/token: the token read and its last-use write, then the revoke', async () => {
    await t.register('sign-out-statements@example.com');
    const { token } = await deviceToken(t, {
      email: 'sign-out-statements@example.com',
    });
    const run = await statementsOf(() =>
      t.api(token, { method: 'DELETE', url: SIGN_IN_URL }),
    );
    expect(run).toMatchObject({ status: 204, statements: 3 });
  });

  describe("the wardrobe's reads: what their page twins cost (#192a)", () => {
    let ownerToken: string;
    let viewerToken: string;
    let garmentId: number;
    const shared = () => `?ownerId=${t.owner.id}`;
    /** A second call of the minute: no last-use write. */
    const warm = async (token: string, url: string) => {
      await t.api(token, { method: 'GET', url });
      return statementsOf(() => t.api(token, { method: 'GET', url }));
    };

    beforeAll(async () => {
      ownerToken = (await deviceToken(t)).token;
      const email = 'garment-statements-viewer@example.com';
      const cookie = await t.register(email);
      viewerToken = (await deviceToken(t, { email })).token;
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'VIEW' },
        headers: { 'hx-request': 'true' },
      });
      const code = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${code}/accept`,
        headers: { cookie },
      });
      garmentId = await createGarment(t, { name: 'Counted tee' });
    });

    it('GET /garments: the token, the page and the count, as GET /wardrobe is 3', async () => {
      const owner = await warm(ownerToken, '/api/v1/garments');
      expect(owner).toMatchObject({ status: 200, statements: 3 });
      // A grantee's share rides in the token's read (#170).
      const grantee = await warm(viewerToken, `/api/v1/garments${shared()}`);
      expect(grantee).toMatchObject({ status: 200, statements: 3 });
      expect(grantee.sql[0]).toContain('"wardrobe_share"');
    });

    it('GET /garments/{id}: the token, the garment and its context, as its page is 3', async () => {
      const url = `/api/v1/garments/${garmentId}`;
      const owner = await warm(ownerToken, url);
      expect(owner).toMatchObject({ status: 200, statements: 3 });
      const grantee = await warm(viewerToken, `${url}${shared()}`);
      expect(grantee).toMatchObject({ status: 200, statements: 3 });
    });
  });

  describe('the garment writes: what their page twins cost (#192b)', () => {
    let token: string;

    beforeAll(async () => {
      token = (await deviceToken(t)).token;
    });

    const counted = { name: 'Counted', category: 'tops' };

    twins.itCounts(
      {
        app: () => t,
        token: () => token,
        setup: async () => ({ id: await garment(t, 'Counted', 'tops') }),
      },
      [
        { page: 'POST /wardrobe', status: 302, body: counted },
        // PATCH reads the garment it merges into; the form's save posts
        // every field and reads nothing.
        {
          page: 'POST /wardrobe/:id',
          status: 302,
          extra: 1,
          form: { name: 'Renamed', category: 'tops' },
          json: { name: 'Renamed' },
        },
        { page: 'DELETE /wardrobe/:id' },
        {
          page: 'POST /wardrobe/:id/archive',
          status: 200,
          json: { status: 'archived' },
        },
        {
          page: 'POST /wardrobe/:id/condition',
          body: { condition: 'needs_repair' },
        },
        // The public link (#959): both one write, setGarmentPublicShare's.
        { page: 'POST /wardrobe/:id/share', status: 200 },
        { page: 'POST /wardrobe/:id/share/stop', status: 200 },
        {
          page: 'POST /wardrobe/:id/clone',
          status: 302,
          form: { name: 'Twin', category: 'tops' },
          json: { name: 'Twin' },
        },
        { page: 'POST /wardrobe/:id/copies', json: { copies: 1 } },
        // The tagging card's answer reads the garment again; the API's
        // does not.
        {
          page: 'POST /wardrobe/:id/tag',
          status: 200,
          extra: -1,
          form: { warmth: '3' },
          json: { warmth: 3 },
        },
        {
          page: 'POST /wardrobe/bulk',
          form: (s) => ({ ids: [s.id], property: 'warmth', warmth: '4' }),
          json: (s) => ({ ids: [s.id], property: 'warmth', value: 4 }),
        },
      ],
    );
  });

  describe('the photo and the repair log: what their page twins cost (#192c)', () => {
    let token: string;
    let photo: Buffer;
    let cutout: Buffer;

    beforeAll(async () => {
      token = (await deviceToken(t)).token;
      [photo, cutout] = await Promise.all([
        jpegPhoto(320, 240),
        pngCutout(320, 240),
      ]);
    });

    const repair = () => ({ day: t.today(), kind: 'repair', note: 'Counted' });

    twins.itCounts(
      {
        app: () => t,
        token: () => token,
        setup: (given?: 'photo' | 'failed') =>
          repairedGarment(t, token, photo, given),
        upload: (field) =>
          field === 'photo'
            ? upload(photo, field, 'photo.jpg')
            : upload(cutout, field, 'cutout.png', 'image/png'),
      },
      [
        { page: 'POST /wardrobe/:id/photo', files: ['photo', 'photo'] },
        {
          page: 'POST /wardrobe/:id/photo/rotate',
          given: 'photo',
          body: { direction: 'right' },
        },
        {
          page: 'POST /wardrobe/:id/nobg',
          given: 'photo',
          status: 200,
          files: ['nobgPhoto', 'cutout'],
        },
        { page: 'POST /wardrobe/:id/cutout/retry', given: 'failed' },
        { page: 'POST /wardrobe/:id/repairs', body: repair },
        { page: 'POST /wardrobe/:id/repairs/:repairId/delete' },
      ],
    );
  });

  describe('outfits, wears and washes: what their page twins cost (#193a)', () => {
    let token: string;

    beforeAll(async () => {
      token = await twinToken();
    });

    /** The garment routes' `:id` is the loose garment, `bare`. */
    const loose = (s: { bare: number; day: string }) => ({
      id: s.bare,
      day: s.day,
    });
    const slots = (s: { bare: number }) => [
      { category: 'shirt', garmentId: s.bare },
    ];

    twins.itCounts(
      {
        app: () => t,
        token: () => token,
        setup: (given?: 'proposal') => outfitRows(t, given),
      },
      [
        { page: 'GET /outfits', op: 'listOutfits' },
        {
          page: 'GET /outfits',
          op: 'listOutfits',
          label: "?proposed=true, the page's From the agent section",
          given: 'proposal',
          query: { proposed: 'true' },
        },
        { page: 'GET /outfits/:id', op: 'getOutfit' },
        {
          page: 'POST /outfits',
          status: 302,
          form: (s) => ({ category: 'shirt', garmentId: String(s.bare) }),
          json: (s) => ({ slots: slots(s) }),
        },
        {
          page: 'POST /outfits/:id',
          label: 'with slots',
          status: 302,
          form: (s) => ({
            name: 'Renamed',
            category: 'shirt',
            garmentId: String(s.bare),
          }),
          json: (s) => ({ name: 'Renamed', slots: slots(s) }),
        },
        // PATCH without `slots` leaves the rows and the trips alone, where
        // the form's save replaces them.
        {
          page: 'POST /outfits/:id',
          label: 'a rename',
          status: 302,
          extra: -2,
          body: { name: 'Renamed' },
        },
        { page: 'DELETE /outfits/:id' },
        { page: 'POST /outfits/:id/share', status: 200 },
        { page: 'POST /outfits/:id/share/stop', status: 200 },
        {
          page: 'POST /outfits/:id/love',
          given: 'proposal',
          json: { event: 'love' },
        },
        {
          page: 'POST /wardrobe/:id/wear',
          op: 'wearGarment',
          ids: loose,
          form: { worn: '1' },
        },
        {
          page: 'POST /wardrobe/:id/wear',
          op: 'unwearGarment',
          label: 'worn=0',
          ids: loose,
          form: { worn: '0' },
        },
        {
          page: 'POST /wardrobe/:id/washed',
          ids: loose,
          json: (s) => ({ day: s.day }),
        },
        {
          page: 'POST /laundry',
          form: (s) => ({ ids: [String(s.bare)] }),
          json: (s) => ({ garmentIds: [s.bare], day: s.day }),
        },
        {
          page: 'POST /wardrobe/:id/away',
          ids: loose,
          form: { away: 'lent', awayNote: 'Sam' },
          json: { away: 'lent', note: 'Sam' },
        },
      ],
    );
  });

  describe('the calendar and the week plan: what their page twins cost (#193b)', () => {
    let token: string;

    beforeAll(async () => {
      token = await twinToken();
    });

    // Plan my week runs without a template (the owner here has none): the
    // template read under the lock, as both twins pay it.
    twins.itCounts(
      { app: () => t, token: () => token, setup: () => calendarRows(t) },
      [
        { page: 'GET /calendar', op: 'listCalendarEntries' },
        {
          page: 'POST /calendar',
          op: 'createCalendarEntry',
          status: 302,
          form: (s) => ({
            date: addDays(s.today, 2),
            outfitId: String(s.outfitId),
          }),
          json: (s) => ({ day: addDays(s.today, 2), outfitId: s.outfitId }),
        },
        {
          page: 'POST /calendar',
          op: 'replaceCalendarEntryOutfit',
          label: 'replace',
          status: 302,
          form: (s) => ({
            date: s.today,
            outfitId: String(s.spareId),
            replace: String(s.id),
          }),
          json: (s) => ({ outfitId: s.spareId }),
        },
        {
          page: 'POST /calendar/:id/worn',
          form: { worn: '1' },
          json: { worn: true },
        },
        { page: 'POST /calendar/:id/delete' },
        {
          page: 'POST /today/wear',
          form: (s) => ({
            garmentId: [String(s.top), String(s.bottom)],
            occasion: 'all-day',
          }),
          json: (s) => ({
            garmentIds: [s.top, s.bottom],
            occasion: 'all-day',
            day: s.today,
          }),
        },
        { page: 'POST /calendar/plan-week' },
        {
          page: 'POST /calendar/plan-week/:id/undo',
          ids: (s) => ({ id: s.planId }),
        },
        {
          page: 'POST /auth/profile/week',
          form: { 'day-1': 'work', 'around-1': 'evening' },
          json: { days: [{ weekday: 1, day: 'work', around: ['evening'] }] },
        },
      ],
    );

    it('GET /week-template: the token and the template', async () => {
      const run = await warmGet(token, '/api/v1/week-template');
      expect(run).toMatchObject({ status: 200, statements: 2 });
    });
  });

  describe('trips and packing: what their page twins cost (#194a)', () => {
    let token: string;

    beforeAll(async () => {
      token = await twinToken();
    });

    const dates = (name: string) => (s: { today: string }) => ({
      name,
      startsOn: s.today,
      endsOn: s.today,
    });

    twins.itCounts(
      { app: () => t, token: () => token, setup: () => tripRows(t) },
      [
        { page: 'GET /trips', op: 'listTrips' },
        { page: 'GET /trips/:id', op: 'getTrip' },
        { page: 'POST /trips', body: dates('New') },
        { page: 'POST /trips/:id', body: dates('Renamed') },
        { page: 'DELETE /trips/:id' },
        {
          page: 'POST /trips/:id/outfits',
          form: (s) => ({ outfitId: String(s.spareOutfitId), day: s.today }),
          json: (s) => ({ outfitId: s.spareOutfitId, day: s.today }),
        },
        { page: 'POST /trips/:id/outfits/:tripOutfitId/delete' },
        { page: 'POST /trips/:id/outfits/:tripOutfitId/wear' },
        {
          page: 'POST /trips/:id/packed',
          form: (s) => ({ shown: String(s.garmentId) }),
          json: { packed: false },
        },
        { page: 'POST /trips/:id/items', body: { label: 'Adapter' } },
        {
          page: 'POST /trips/:id/items/packed',
          form: (s) => ({ packed: String(s.itemId), shown: String(s.itemId) }),
          json: { packed: true },
        },
        { page: 'POST /trips/:id/items/:itemId/delete' },
        {
          page: 'POST /trips/:id/items/copy',
          form: (s) => ({ from: String(s.otherTripId) }),
          json: (s) => ({ fromTripId: s.otherTripId }),
        },
      ],
    );
  });

  describe('the wishlist and capsules: what their page twins cost (#194b)', () => {
    let token: string;
    let runs = 0;

    beforeAll(async () => {
      token = await twinToken();
    });

    const setup = () => wishlistRows(t, ++runs);
    const need = (s: { needId: number }) => ({ id: s.needId });
    const pick = (s: { pickId: number }) => ({ id: s.pickId });
    const capsule = (s: { capsuleId: number }) => ({ id: s.capsuleId });
    const purchase = () => ({ acquiredOn: t.today(), price: '80' });
    const renamed = (s: { capsuleId: number }) => ({
      name: `Renamed ${s.capsuleId}`,
    });

    twins.itCounts({ app: () => t, token: () => token, setup }, [
      { page: 'GET /wardrobe/wishlist', op: 'getWishlist' },
      {
        page: 'GET /wardrobe/wishlist/needs/:id',
        op: 'getWishlistNeed',
        ids: need,
      },
      { page: 'POST /wardrobe/wishlist/seen', status: 200 },
      {
        page: 'POST /wardrobe/:id/choose',
        ids: pick,
        json: { event: 'choose' },
      },
      {
        page: 'POST /wardrobe/wishlist/needs/:id/dismiss',
        ids: need,
        form: { reason: 'not_now' },
        json: { event: 'dismiss', reason: 'not_now' },
      },
      { page: 'POST /wardrobe/:id/bought', ids: pick, body: purchase },
      {
        page: 'POST /wardrobe/:id/returned',
        status: 200,
        ids: (s) => ({ id: s.boughtId }),
      },
      { page: 'GET /capsules', op: 'listCapsules' },
      // The page reads the capsule's first page of garments and their
      // count beside it; the API's are GET /garments?capsuleId=.
      { page: 'GET /capsules/:id', op: 'getCapsule', extra: -2, ids: capsule },
      {
        page: 'POST /capsules',
        form: (s) => ({ name: `Page capsule ${s.capsuleId}` }),
        json: (s) => ({ name: `Api capsule ${s.capsuleId}` }),
      },
      // The page reads the capsule before the form, to draw a refused
      // one; the API's refusal reads it only then.
      { page: 'POST /capsules/:id', extra: -1, ids: capsule, body: renamed },
      { page: 'DELETE /capsules/:id', ids: capsule },
      {
        page: 'POST /capsules/:id/garments',
        ids: capsule,
        form: (s) => ({ shown: [s.garmentId] }),
        json: (s) => ({ remove: [s.garmentId] }),
      },
      {
        page: 'POST /wardrobe/:id/capsules',
        status: 200,
        ids: (s) => ({ id: s.garmentId }),
        form: (s) => ({ shown: [s.capsuleId] }),
        json: (s) => ({ remove: [s.capsuleId] }),
      },
    ]);

    it('GET /garments/{id}/goes-with: the token, then its inputs in one statement', async () => {
      const { pickId } = await setup();
      const run = await warmGet(token, `/api/v1/garments/${pickId}/goes-with`);
      expect(run).toMatchObject({ status: 200, statements: 2 });
    });
  });

  describe('ideas, the pick, clashes and selfies: what their page twins cost (#193c)', () => {
    let token: string;
    let photo: Buffer;

    beforeAll(async () => {
      token = await twinToken();
      photo = await jpegPhoto(320, 240);
    });

    const pair = (s: { top: number; bottom: number }) => ({
      id: s.top,
      otherId: s.bottom,
    });
    const pairForm = (s: { top: number; bottom: number }) => ({
      garmentId: [String(s.top), String(s.bottom)],
    });

    twins.itCounts(
      {
        app: () => t,
        token: () => token,
        setup: () => ideaRows(t, photo),
        upload: (field) => upload(photo, field, 'mirror.jpg'),
      },
      [
        { page: 'GET /outfits/ideas', op: 'listIdeas' },
        // With garments locked, GET /ideas reads them in the ideas'
        // statement, where the page's `?with=` reads its garment first.
        {
          page: 'GET /outfits/ideas',
          op: 'listIdeas',
          label: '?with=',
          extra: -1,
          query: (s) => ({ with: String(s.top) }),
        },
        {
          page: 'POST /outfits/ideas/pick',
          op: 'pickOutfit',
          form: (s) => ({
            garmentId: [String(s.top), String(s.bottom)],
            for: `day:${addDays(s.today, 2)}`,
          }),
          json: (s) => ({
            garmentIds: [s.top, s.bottom],
            plan: { day: addDays(s.today, 2) },
          }),
        },
        { page: 'POST /outfits/ideas/avoid', ids: pair, form: pairForm },
        { page: 'POST /outfits/ideas/allow', ids: pair, form: pairForm },
        {
          page: 'POST /calendar/:id/selfie',
          ids: (s) => ({ id: s.entryId }),
          files: ['photo', 'photo'],
        },
        {
          page: 'POST /selfies/:id/delete',
          ids: (s) => ({ id: s.selfie.id }),
        },
        {
          page: 'GET /selfies/:fileName',
          op: 'getSelfiePhoto',
          ids: (s) => ({ fileName: s.selfie.fileName }),
          query: { v: '1' },
        },
      ],
    );
  });

  describe('saved looks: what their page twins cost (#193d)', () => {
    // A user of their own: the shared twin device's API_LIMIT (120 a
    // minute) is spent by the sections above, and the owner's sign-ins by
    // SIGN_IN_ACCOUNT_LIMIT.
    const email = 'looks-statements@example.com';
    let cookie: string;
    let token: string;
    let photo: Buffer;

    beforeAll(async () => {
      cookie = await t.register(email);
      token = (await deviceToken(t, { email })).token;
      photo = await jpegPhoto(320, 240);
      sites.serve('/look-counted.jpg', jpeg(photo));
    });

    const form = {
      kind: 'bottom/jeans',
      color: 'blue',
      accent: '',
      pattern: '',
    };
    const json = { role: 'bottom', type: 'jeans', colors: ['blue'] };
    const link = () => ({ url: sites.url('/look-counted.jpg') });

    twins.itCounts(
      {
        app: () => t,
        token: () => token,
        cookie: () => cookie,
        setup: () => lookRows(t, photo, cookie),
        upload: (field) => upload(photo, field, 'look.jpg'),
      },
      [
        { page: 'GET /inspiration', op: 'listLooks' },
        { page: 'GET /inspiration/:id', op: 'getLook' },
        { page: 'POST /inspiration', files: ['photo', 'photo'] },
        { page: 'POST /inspiration/link', body: link },
        {
          page: 'POST /inspiration/:id',
          body: { title: 'Counted', note: 'A note' },
        },
        { page: 'POST /inspiration/:id/delete' },
        { page: 'POST /inspiration/:id/photo', files: ['photo', 'photo'] },
        { page: 'POST /inspiration/:id/pieces', form, json },
        { page: 'POST /inspiration/:id/pieces/:position', form, json },
        { page: 'POST /inspiration/:id/pieces/:position/delete' },
        { page: 'GET /inspiration/:id/recreate', op: 'getLookRecreation' },
        {
          page: 'POST /inspiration/:id/recreate/outfit',
          form: (s) => ({ position: ['0'], garment: [String(s.tee)] }),
          json: (s) => ({ choices: [{ position: 0, garmentId: s.tee }] }),
        },
        { page: 'POST /inspiration/:id/pieces/:position/find' },
        {
          page: 'GET /inspiration/photo/:fileName',
          op: 'getLookPhoto',
          query: { v: '1' },
        },
      ],
    );

    it("PUT /looks/{id}/pieces: the token, then set_inspiration_pieces' transaction (no page twin sets the whole list)", async () => {
      const { id } = await lookRows(t, photo, cookie);
      const run = await apiStatementsOf(t, token, {
        method: 'PUT',
        url: `/api/v1/looks/${id}/pieces`,
        payload: { pieces: [json] },
      });
      // The token; then one transaction: begin, the look's lock, its
      // pieces, the white tee removed, the counter taken, the jeans added,
      // commit. MCP's twin reads the recreation back after it.
      expect(run).toMatchObject({ status: 200, statements: 8 });
    });
  });

  describe('the style profile and shared wardrobes: what their page twins cost (#195c)', () => {
    // A user of their own, as the looks' (the twin device's API_LIMIT).
    const email = 'style-statements@example.com';
    let cookie: string;
    let token: string;
    let userId: number;
    let runs = 0;

    beforeAll(async () => {
      cookie = await t.register(email);
      token = (await deviceToken(t, { email })).token;
      userId = await userIdOf(t, email);
    });

    const profile = {
      styles: ['classic'],
      palette: ['black'],
      budget: 'mid',
      notes: 'Counted',
    };

    // Token auth is the API's one auth statement, as the session is the
    // page's: an extra read on either side fails the equality, and each
    // API count is pinned at 2 too.
    twins.itCounts(
      {
        app: () => t,
        token: () => token,
        cookie: () => cookie,
        setup: () => ruleRows(t, userId, runs++),
        statements: 2,
      },
      [
        // The page reads more in the one statement.
        { page: 'GET /auth/profile/style', op: 'getStyleProfile' },
        { page: 'POST /auth/profile/style', body: profile },
        {
          page: 'POST /auth/profile/style/rules',
          form: ({ colors: [a, b] }) => ({
            kind: 'never',
            a: `color:${a}`,
            b: `color:${b}`,
          }),
          json: ({ colors: [a, b] }) => ({
            kind: 'never',
            a: { color: a },
            b: { color: b },
          }),
        },
        { page: 'POST /auth/profile/style/rules/:id/delete' },
      ],
    );

    it("GET /shared-wardrobes: the token, then list_shared_wardrobes' one read (no page twin)", async () => {
      const run = await warmGet(token, '/api/v1/shared-wardrobes');
      expect(run).toMatchObject({ status: 200, statements: 2 });
    });
  });

  describe('Today and the weather: what their page twins cost (#195a)', () => {
    // An app of its own with the weather on (the file's runs without), so
    // its owner is a user of its own too: the shared twin device's
    // API_LIMIT is spent by the sections above. Date is pinned to the
    // stub's day before it boots (the weather, and its branches, the
    // date's).
    let w: TestApp;
    let stub: WeatherStub;
    let token: string;
    let tripId: number;

    const BROOKLYN = { latitude: '40.65', longitude: '-73.95' };
    const named = { name: 'Brooklyn', ...BROOKLYN };
    const place = { name: 'Brooklyn', latitude: 40.65, longitude: -73.95 };

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW });
      stub = await startWeatherStub();
      w = await createTestApp(
        { WEATHER_ENABLED: 'true' },
        { weather: stub.options, onRoute: twins.onRoute },
      );
      token = (await deviceToken(w)).token;
      for (const [name, category] of [
        ['Counted tee', 'tops'],
        ['Counted jeans', 'bottoms'],
        ['Counted trainers', 'footwear'],
      ] as const) {
        await createGarment(w, { name, category });
      }
      tripId = await newTrip(w, 'Counted trip', w.today(), w.today());
      // A home and the trip's destination with their forecasts kept: a
      // first ask's fetch is the cache's statements, no route's.
      for (const url of ['/weather/home', `/trips/${tripId}/destination`]) {
        await w.inject({ method: 'POST', url, payload: named });
      }
      await w.inject({ method: 'GET', url: '/weather/summary' });
      await w.inject({ method: 'GET', url: `/trips/${tripId}/weather` });
      await w.weather!.settled();
    });

    afterAll(async () => {
      await w?.cleanup();
      await stub?.close();
      vi.useRealTimers();
    });

    // A plain post's 303 reads nothing back. In order: the last case's
    // clear removes the forecast the reads count.
    twins.itCounts(
      {
        app: () => w,
        token: () => token,
        setup: () => Promise.resolve({ id: tripId }),
      },
      [
        { page: 'GET /', op: 'getToday' },
        { page: 'GET /weather/summary', op: 'getWeather' },
        {
          page: 'GET /weather/places',
          op: 'searchPlaces',
          query: { q: 'Brooklyn' },
        },
        { page: 'POST /weather/home', form: named, json: place },
        {
          page: 'POST /weather/here',
          form: BROOKLYN,
          json: { latitude: 40.65, longitude: -73.95 },
        },
        { page: 'POST /weather/here/clear' },
        { page: 'POST /weather/unit', body: { unit: 'celsius' } },
        { page: 'POST /weather/offset/reset' },
        { page: 'GET /trips/:id/weather', op: 'getTripWeather' },
        { page: 'POST /trips/:id/destination', form: named, json: place },
        { page: 'POST /weather/home/clear' },
      ],
    );
  });

  describe('insights, the recap and sizes: what their page twins cost (#588)', () => {
    // A user of their own: the shared twin device's API_LIMIT is spent by
    // the sections above.
    const email = 'sizes-statements@example.com';
    let cookie: string;
    let token: string;
    let brands = 0;

    beforeAll(async () => {
      cookie = await t.register(email);
      token = (await deviceToken(t, { email })).token;
      const worn = await createGarment(t, { name: 'Counted tee', cookie });
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${worn}/wear`,
        payload: { worn: '1' },
        headers: { cookie },
      });
    });

    twins.itCounts(
      {
        app: () => t,
        token: () => token,
        cookie: () => cookie,
        setup: () => brandRow(t, cookie, `Counted ${++brands}`),
      },
      [
        { page: 'GET /wardrobe/insights', op: 'getInsights' },
        // The page without ?year= may read a second year (#733), so both
        // twins name this one.
        {
          page: 'GET /wardrobe/recap',
          op: 'getRecap',
          query: () => ({ year: t.today().slice(0, 4) }),
        },
        { page: 'GET /auth/profile/sizes', op: 'getSizes' },
        {
          page: 'GET /auth/profile/sizes/hint',
          op: 'listBrandSizes',
          query: (s) => ({ brand: s.brand }),
        },
        { page: 'POST /auth/profile/sizes/unit', body: { unit: 'cm' } },
        {
          page: 'POST /auth/profile/sizes/brands',
          body: (s) => ({ brand: `${s.brand} new`, size: 'L' }),
        },
        {
          page: 'POST /auth/profile/sizes/brands/:id',
          body: (s) => ({ brand: s.brand, size: 'L', note: 'Runs small' }),
        },
        { page: 'POST /auth/profile/sizes/brands/:id/delete', form: {} },
        // The form keeps a stored length posted as it showed it
        // (readMeasurementsForm), so the page reads them before the save;
        // a length in centimetres has nothing to keep.
        {
          page: 'POST /auth/profile/sizes/measurements',
          extra: -1,
          form: { unit: 'cm', height: '180' },
          json: { height: 180 },
        },
      ],
    );
  });

  describe('the changes feed: its cost does not grow with the page (#196b-1)', () => {
    // A user of their own, as the looks' (the twin device's API_LIMIT).
    const email = 'changes-statements@example.com';
    let token: string;

    const page = (query: string) => warmGet(token, `/api/v1/changes?${query}`);

    beforeAll(async () => {
      await t.register(email);
      token = (await deviceToken(t, { email })).token;
      await everyResource(t, token);
    });

    it('a page of garments: the token, BEGIN, the wardrobes, the keyset read, the garments, COMMIT; as many at 4 as at 2', async () => {
      const [two, four] = [await page('limit=2'), await page('limit=4')];
      expect(two).toMatchObject({ status: 200, statements: 6 });
      expect(four).toMatchObject({ status: 200, statements: 6 });
    });

    it('a page of every resource: one statement each; an empty page none', async () => {
      // Garments, wears, capsules, outfits, entries, trips, brand notes,
      // measurements, the style profile and the week template: 10 reads
      // after the keyset's.
      const all = await page('limit=100');
      expect(all).toMatchObject({ status: 200, statements: 15 });
      const { cursor } = (
        await t.api(token, { method: 'GET', url: '/api/v1/changes' })
      ).json<{ cursor: string }>();
      const empty = await page(`cursor=${cursor}`);
      expect(empty).toMatchObject({ status: 200, statements: 5 });
    });
  });

  it('POST /garments/link-imports: the token, the pending photo kept, the claim; no read back', async () => {
    const { token } = await deviceToken(t);
    sites.serve('/counted.jpg', jpeg(await jpegPhoto(320, 240)));
    const run = await apiStatementsOf(t, token, {
      method: 'POST',
      url: '/api/v1/garments/link-imports',
      payload: { url: sites.url('/counted.jpg'), category: 'tops' },
    });
    // The token; the fetched photo kept as a pending photo (its own
    // transaction, keepPendingPhoto); the claim (createGarmentWithPending
    // Photo: the name's lock, the pending row taken, the file row and the
    // garment). Its page twin answers the prefilled form unsaved, so no
    // count compares; its MCP twin (add_garment_from_link, 13) also reads
    // the garment back and looks for lookalikes.
    expect(run).toMatchObject({ status: 201, statements: 11 });
  });

  it('GET /openapi.json: none', async () => {
    const run = await statementsOf(() =>
      t.api(undefined, { method: 'GET', url: '/api/v1/openapi.json' }),
    );
    expect(run).toMatchObject({ status: 200, statements: 0 });
  });
});
