import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  brandSize,
  file,
  inspiration,
  optionGroup,
  outfit,
  outfitCalendar,
  selfie,
  tripItem,
  tripOutfit,
  weekPlan,
} from '../../src/db/schema';
import { GARMENT_COLORS } from '../../src/wardrobe/properties';
import { addOutfitRule } from '../../src/web/style/queries';
import { NO_MATCHER } from '../../src/web/style/validation';
import { markSuggestion } from '../../src/web/wishlist/decisions';
import {
  STUB_WEATHER_NOW,
  startWeatherStub,
  type WeatherStub,
} from '../support/weather-stub';
import { deviceToken, SIGN_IN_URL, signInDevice } from './api';
import { failCutout } from './cutouts';
import { jpeg, type LinkSites, startLinkSites } from './link-sites';
import {
  createGarment,
  createWishlistItem,
  jpegPhoto,
  photoFileName,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  asFixture,
  createTestApp,
  multipart,
  recordQueries,
  TEST_PASSWORD,
  type TestApp,
  userIdOf,
} from './harness';

/**
 * What each /api/v1 route costs in statements (#190; plan section 10):
 * production pays a round trip per statement, so the count is the latency.
 * Each runs inside recordQueries, so it lands in build/statements.json as
 * `<METHOD>:/api/v1/...` and the metrics ratchet holds it. Every
 * authenticated count is the token's read (authenticateToken), as a page's
 * is the session's, plus its last-use write when the last one is a minute
 * old (pinned both ways).
 */

let t: TestApp;
let sites: LinkSites;

beforeAll(async () => {
  sites = await startLinkSites();
  t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
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

async function statementsOf(work: () => Promise<{ statusCode: number }>) {
  let status = 0;
  const record = await recordQueries(async () => {
    status = (await work()).statusCode;
  });
  return { status, statements: record.statements, sql: record.sql };
}

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
    expect(await statementsOf(me)).toMatchObject({
      status: 200,
      statements: 1,
    });
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
    expect(
      await statementsOf(() =>
        t.api(token, { method: 'DELETE', url: SIGN_IN_URL }),
      ),
    ).toMatchObject({ status: 204, statements: 3 });
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
      expect(await warm(ownerToken, '/api/v1/garments')).toMatchObject({
        status: 200,
        statements: 3,
      });
      // A grantee's share rides in the token's read (#170).
      const grantee = await warm(viewerToken, `/api/v1/garments${shared()}`);
      expect(grantee).toMatchObject({ status: 200, statements: 3 });
      expect(grantee.sql[0]).toContain('"wardrobe_share"');
    });

    it('GET /garments/{id}: the token, the garment and its context, as its page is 3', async () => {
      const url = `/api/v1/garments/${garmentId}`;
      expect(await warm(ownerToken, url)).toMatchObject({
        status: 200,
        statements: 3,
      });
      expect(await warm(viewerToken, `${url}${shared()}`)).toMatchObject({
        status: 200,
        statements: 3,
      });
    });
  });

  describe('the garment writes: what their page twins cost (#192b)', () => {
    let token: string;

    beforeAll(async () => {
      token = (await deviceToken(t)).token;
    });

    /**
     * Each write's page twin and its API request, each on a garment of its
     * own, and how many statements the API pays beyond the page: PATCH
     * reads the garment it merges into (the form's save posts every field
     * and reads nothing); the tagging card's answer reads the garment
     * again, which the API's does not.
     */
    const CASES: {
      name: string;
      extra: number;
      ok: [page: number, api: number];
      page: (id: number) => InjectOptions;
      api: (id: number) => InjectOptions;
    }[] = [
      {
        name: 'POST /garments (POST /wardrobe)',
        extra: 0,
        ok: [302, 201],
        page: () => ({
          method: 'POST',
          url: '/wardrobe',
          payload: { name: 'Counted', category: 'tops' },
        }),
        api: () => ({
          method: 'POST',
          url: '/api/v1/garments',
          payload: { name: 'Counted', category: 'tops' },
        }),
      },
      {
        name: 'PATCH /garments/{id} (POST /wardrobe/:id)',
        extra: 1,
        ok: [302, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}`,
          payload: { name: 'Renamed', category: 'tops' },
        }),
        api: (id) => ({
          method: 'PATCH',
          url: `/api/v1/garments/${id}`,
          payload: { name: 'Renamed' },
        }),
      },
      {
        name: 'DELETE /garments/{id} (DELETE /wardrobe/:id)',
        extra: 0,
        ok: [200, 204],
        page: (id) => ({ method: 'DELETE', url: `/wardrobe/${id}` }),
        api: (id) => ({ method: 'DELETE', url: `/api/v1/garments/${id}` }),
      },
      {
        name: 'PUT /garments/{id}/status (POST /wardrobe/:id/archive)',
        extra: 0,
        ok: [200, 200],
        page: (id) => ({ method: 'POST', url: `/wardrobe/${id}/archive` }),
        api: (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/status`,
          payload: { status: 'archived' },
        }),
      },
      {
        name: 'PUT /garments/{id}/condition (POST /wardrobe/:id/condition)',
        extra: 0,
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/condition`,
          payload: { condition: 'needs_repair' },
        }),
        api: (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/condition`,
          payload: { condition: 'needs_repair' },
        }),
      },
      {
        name: 'POST /garments/{id}/clones (POST /wardrobe/:id/clone)',
        extra: 0,
        ok: [302, 201],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/clone`,
          payload: { name: 'Twin', category: 'tops' },
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/clones`,
          payload: { name: 'Twin' },
        }),
      },
      {
        name: 'POST /garments/{id}/copies (POST /wardrobe/:id/copies)',
        extra: 0,
        ok: [303, 200],
        page: (id) => ({ method: 'POST', url: `/wardrobe/${id}/copies` }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/copies`,
          payload: { copies: 1 },
        }),
      },
      {
        name: 'PATCH /garments/{id}/tags (POST /wardrobe/:id/tag)',
        extra: -1,
        ok: [200, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/tag`,
          payload: { warmth: '3' },
        }),
        api: (id) => ({
          method: 'PATCH',
          url: `/api/v1/garments/${id}/tags`,
          payload: { warmth: 3 },
        }),
      },
      {
        name: 'PATCH /garments (POST /wardrobe/bulk)',
        extra: 0,
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: '/wardrobe/bulk',
          payload: { ids: [id], property: 'warmth', warmth: '4' },
        }),
        api: (id) => ({
          method: 'PATCH',
          url: '/api/v1/garments',
          payload: { ids: [id], property: 'warmth', value: 4 },
        }),
      },
    ];

    it.each(CASES)('$name', async ({ extra, ok, page, api }) => {
      const [pageId, apiId] = [
        await createGarment(t, { name: 'Counted', category: 'tops' }),
        await createGarment(t, { name: 'Counted', category: 'tops' }),
      ];
      const pageRun = await statementsOf(() => t.inject(page(pageId)));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, api(apiId)));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements + extra);
    });
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

    const file = (
      name: string,
      data: Buffer,
      filename: string,
      contentType: string,
    ) => multipart({}, { [name]: { data, filename, contentType } });

    /** A garment with a photo (`photo`), its cutout failed too (`failed`), or neither. */
    type Setup = 'bare' | 'photo' | 'failed';

    /**
     * Each write's page twin and its API request, each on a garment of its
     * own: the same domain function, so the same statements. A repair
     * entry is logged first where the write removes one.
     */
    const CASES: {
      name: string;
      setup: Setup;
      ok: [page: number, api: number];
      page: (
        id: number,
        repairId: number,
      ) => InjectOptions | Promise<InjectOptions>;
      api: (
        id: number,
        repairId: number,
      ) => InjectOptions | Promise<InjectOptions>;
    }[] = [
      {
        name: 'PUT /garments/{id}/photo (POST /wardrobe/:id/photo)',
        setup: 'bare',
        ok: [303, 200],
        page: async (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/photo`,
          ...(await file('photo', photo, 'photo.jpg', 'image/jpeg')),
        }),
        api: async (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/photo`,
          ...(await file('photo', photo, 'photo.jpg', 'image/jpeg')),
        }),
      },
      {
        name: 'POST /garments/{id}/photo/rotations (POST /wardrobe/:id/photo/rotate)',
        setup: 'photo',
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/photo/rotate`,
          payload: { direction: 'right' },
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/photo/rotations`,
          payload: { direction: 'right' },
        }),
      },
      {
        name: 'PUT /garments/{id}/photo/cutout (POST /wardrobe/:id/nobg)',
        setup: 'photo',
        ok: [200, 200],
        page: async (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/nobg`,
          ...(await file('nobgPhoto', cutout, 'cutout.png', 'image/png')),
        }),
        api: async (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/photo/cutout`,
          ...(await file('cutout', cutout, 'cutout.png', 'image/png')),
        }),
      },
      {
        name: 'POST /garments/{id}/photo/cutout/retries (POST /wardrobe/:id/cutout/retry)',
        setup: 'failed',
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/cutout/retry`,
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/photo/cutout/retries`,
        }),
      },
      {
        name: 'POST /garments/{id}/repairs (POST /wardrobe/:id/repairs)',
        setup: 'bare',
        ok: [303, 201],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/repairs`,
          payload: { day: t.today(), kind: 'repair', note: 'Counted' },
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/repairs`,
          payload: { day: t.today(), kind: 'repair', note: 'Counted' },
        }),
      },
      {
        name: 'DELETE /garments/{id}/repairs/{repairId} (POST /wardrobe/:id/repairs/:repairId/delete)',
        setup: 'bare',
        ok: [303, 204],
        page: (id, repairId) => ({
          method: 'POST',
          url: `/wardrobe/${id}/repairs/${repairId}/delete`,
        }),
        api: (id, repairId) => ({
          method: 'DELETE',
          url: `/api/v1/garments/${id}/repairs/${repairId}`,
        }),
      },
    ];

    /** A garment as `setup` says, with a repair entry logged on it. */
    const garmentFor = async (setup: Setup) => {
      const id = await createGarment(t, { name: 'Counted', category: 'tops' });
      if (setup !== 'bare') await uploadPhoto(t, id, photo);
      if (setup === 'failed') await failCutout(t, await photoFileName(t, id));
      const logged = await t.api(token, {
        method: 'POST',
        url: `/api/v1/garments/${id}/repairs`,
        payload: { day: t.today(), kind: 'repair', note: 'To remove' },
      });
      return { id, repairId: logged.json<{ id: number }>().id };
    };

    it.each(CASES)('$name', async ({ setup, ok, page, api }) => {
      const [onPage, onApi] = [
        await garmentFor(setup),
        await garmentFor(setup),
      ];
      const pageRequest = await page(onPage.id, onPage.repairId);
      const pageRun = await statementsOf(() => t.inject(pageRequest));
      const apiRequest = await api(onApi.id, onApi.repairId);
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, apiRequest));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
    });
  });

  describe('outfits, wears and washes: what their page twins cost (#193a)', () => {
    let token: string;

    beforeAll(async () => {
      token = await twinToken();
    });

    /** One run's garments: one bare, one in an outfit (`outfitId`), which is Muse's proposal for `proposal`. */
    interface Setup {
      bare: number;
      outfitId: number;
      today: string;
    }

    const setupFor = async (proposal: boolean): Promise<Setup> => {
      const bare = await createGarment(t, {
        name: 'Counted',
        category: 'shirt',
      });
      const held = await createGarment(t, { name: 'Held', category: 'shirt' });
      const made = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: { category: 'shirt', garmentId: String(held) },
      });
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(made.headers.location as string)![1],
      );
      if (proposal) {
        await asFixture(t.db, (tx) =>
          tx
            .update(outfit)
            .set({ proposedAt: new Date(), reaction: 'proposed' })
            .where(eq(outfit.id, outfitId)),
        );
      }
      return { bare, outfitId, today: t.today() };
    };

    /**
     * Each route's page twin and its API request, each on a setup of its
     * own: the same domain function, so the same statements, but a rename
     * (PATCH without `slots`), which leaves the rows and the trips alone
     * where the form's save replaces them.
     */
    const CASES: {
      name: string;
      proposal?: boolean;
      extra?: number;
      ok: [page: number, api: number];
      page: (s: Setup) => InjectOptions;
      api: (s: Setup) => InjectOptions;
    }[] = [
      {
        name: 'GET /outfits (GET /outfits)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/outfits' }),
        api: () => ({ method: 'GET', url: '/api/v1/outfits' }),
      },
      {
        name: "GET /outfits?proposed=true (the page's From Muse section: GET /outfits)",
        proposal: true,
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/outfits' }),
        api: () => ({ method: 'GET', url: '/api/v1/outfits?proposed=true' }),
      },
      {
        name: 'GET /outfits/{id} (GET /outfits/:id)',
        ok: [200, 200],
        page: (s) => ({ method: 'GET', url: `/outfits/${s.outfitId}` }),
        api: (s) => ({ method: 'GET', url: `/api/v1/outfits/${s.outfitId}` }),
      },
      {
        name: 'POST /outfits (POST /outfits)',
        ok: [302, 201],
        page: (s) => ({
          method: 'POST',
          url: '/outfits',
          payload: { category: 'shirt', garmentId: String(s.bare) },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/outfits',
          payload: { slots: [{ category: 'shirt', garmentId: s.bare }] },
        }),
      },
      {
        name: 'PATCH /outfits/{id} with slots (POST /outfits/:id)',
        ok: [302, 200],
        page: (s) => ({
          method: 'POST',
          url: `/outfits/${s.outfitId}`,
          payload: {
            name: 'Renamed',
            category: 'shirt',
            garmentId: String(s.bare),
          },
        }),
        api: (s) => ({
          method: 'PATCH',
          url: `/api/v1/outfits/${s.outfitId}`,
          payload: {
            name: 'Renamed',
            slots: [{ category: 'shirt', garmentId: s.bare }],
          },
        }),
      },
      {
        name: 'PATCH /outfits/{id}, a rename (POST /outfits/:id)',
        extra: -2,
        ok: [302, 200],
        page: (s) => ({
          method: 'POST',
          url: `/outfits/${s.outfitId}`,
          payload: { name: 'Renamed' },
        }),
        api: (s) => ({
          method: 'PATCH',
          url: `/api/v1/outfits/${s.outfitId}`,
          payload: { name: 'Renamed' },
        }),
      },
      {
        name: 'DELETE /outfits/{id} (DELETE /outfits/:id)',
        ok: [200, 204],
        page: (s) => ({ method: 'DELETE', url: `/outfits/${s.outfitId}` }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/outfits/${s.outfitId}`,
        }),
      },
      {
        name: 'POST /outfits/{id}/reactions (POST /outfits/:id/love)',
        proposal: true,
        ok: [303, 200],
        page: (s) => ({ method: 'POST', url: `/outfits/${s.outfitId}/love` }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/outfits/${s.outfitId}/reactions`,
          payload: { event: 'love' },
        }),
      },
      {
        name: 'PUT /garments/{id}/wears/{day} (POST /wardrobe/:id/wear)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/wardrobe/${s.bare}/wear`,
          payload: { worn: '1' },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/garments/${s.bare}/wears/${s.today}`,
        }),
      },
      {
        name: 'DELETE /garments/{id}/wears/{day} (POST /wardrobe/:id/wear, worn=0)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/wardrobe/${s.bare}/wear`,
          payload: { worn: '0' },
        }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/garments/${s.bare}/wears/${s.today}`,
        }),
      },
      {
        name: 'POST /garments/{id}/washes (POST /wardrobe/:id/washed)',
        ok: [303, 200],
        page: (s) => ({ method: 'POST', url: `/wardrobe/${s.bare}/washed` }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/garments/${s.bare}/washes`,
          payload: { day: s.today },
        }),
      },
      {
        name: 'POST /garments/washes (POST /laundry)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: '/laundry',
          payload: { ids: [String(s.bare)] },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/garments/washes',
          payload: { garmentIds: [s.bare], day: s.today },
        }),
      },
      {
        name: 'PUT /garments/{id}/away (POST /wardrobe/:id/away)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/wardrobe/${s.bare}/away`,
          payload: { away: 'lent', awayNote: 'Sam' },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/garments/${s.bare}/away`,
          payload: { away: 'lent', note: 'Sam' },
        }),
      },
    ];

    it.each(CASES)(
      '$name',
      async ({ proposal = false, extra = 0, ok, page, api }) => {
        const [onPage, onApi] = [
          await setupFor(proposal),
          await setupFor(proposal),
        ];
        const pageRun = await statementsOf(() => t.inject(page(onPage)));
        // A second call of the minute: no last-use write.
        await t.api(token, { method: 'GET', url: '/api/v1/me' });
        const apiRun = await statementsOf(() => t.api(token, api(onApi)));
        expect([pageRun.status, apiRun.status]).toEqual(ok);
        expect(apiRun.statements).toBe(pageRun.statements + extra);
      },
    );
  });

  describe('the calendar and the week plan: what their page twins cost (#193b)', () => {
    let token: string;

    beforeAll(async () => {
      token = await twinToken();
    });

    /** One run's rows: an outfit planned today, an empty spare, two loose garments and an empty plan. */
    interface Setup {
      outfitId: number;
      spareId: number;
      entryId: number;
      top: number;
      bottom: number;
      weekPlanId: number;
      today: string;
    }

    const outfitOf = async (payload: Record<string, string>) => {
      const made = await t.inject({ method: 'POST', url: '/outfits', payload });
      return Number(
        /^\/outfits\/(\d+)$/.exec(made.headers.location as string)![1],
      );
    };

    const setup = async (): Promise<Setup> => {
      const today = t.today();
      const held = await createGarment(t, {
        name: 'Planned',
        category: 'tops',
      });
      const outfitId = await outfitOf({
        category: 'shirt',
        garmentId: String(held),
      });
      const spareId = await outfitOf({ name: 'Spare' });
      await t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: today, outfitId: String(outfitId) },
      });
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, outfitId));
      const [batch] = await asFixture(t.db, (tx) =>
        tx
          .insert(weekPlan)
          .values({ ownerId: t.owner.id })
          .returning({ id: weekPlan.id }),
      );
      return {
        outfitId,
        spareId,
        entryId: entry.id,
        top: await createGarment(t, { name: 'Loose', category: 'tops' }),
        bottom: await createGarment(t, { name: 'Loose', category: 'bottoms' }),
        weekPlanId: batch.id,
        today,
      };
    };

    /**
     * Each route's page twin and its API request, each on a setup of its
     * own: the same domain function, so the same statements. Plan my week
     * runs without a template (the owner here has none): the template read
     * under the lock, as both twins pay it.
     */
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      page: (s: Setup) => InjectOptions;
      api: (s: Setup) => InjectOptions;
    }[] = [
      {
        name: 'GET /calendar-entries (GET /calendar)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/calendar' }),
        api: () => ({ method: 'GET', url: '/api/v1/calendar-entries' }),
      },
      {
        name: 'POST /calendar-entries (POST /calendar)',
        ok: [302, 201],
        page: (s) => ({
          method: 'POST',
          url: '/calendar',
          payload: { date: addDays(s.today, 2), outfitId: String(s.outfitId) },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/calendar-entries',
          payload: { day: addDays(s.today, 2), outfitId: s.outfitId },
        }),
      },
      {
        name: 'PUT /calendar-entries/{id}/outfit (POST /calendar, replace)',
        ok: [302, 200],
        page: (s) => ({
          method: 'POST',
          url: '/calendar',
          payload: {
            date: s.today,
            outfitId: String(s.spareId),
            replace: String(s.entryId),
          },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/calendar-entries/${s.entryId}/outfit`,
          payload: { outfitId: s.spareId },
        }),
      },
      {
        name: 'PUT /calendar-entries/{id}/worn (POST /calendar/:id/worn)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/calendar/${s.entryId}/worn`,
          payload: { worn: '1' },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/calendar-entries/${s.entryId}/worn`,
          payload: { worn: true },
        }),
      },
      {
        name: 'DELETE /calendar-entries/{id} (POST /calendar/:id/delete)',
        ok: [303, 204],
        page: (s) => ({ method: 'POST', url: `/calendar/${s.entryId}/delete` }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/calendar-entries/${s.entryId}`,
        }),
      },
      {
        name: 'POST /outfit-wears (POST /today/wear)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: '/today/wear',
          payload: {
            garmentId: [String(s.top), String(s.bottom)],
            occasion: 'all-day',
          },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/outfit-wears',
          payload: {
            garmentIds: [s.top, s.bottom],
            occasion: 'all-day',
            day: s.today,
          },
        }),
      },
      {
        name: 'POST /week-plans (POST /calendar/plan-week)',
        ok: [303, 200],
        page: () => ({ method: 'POST', url: '/calendar/plan-week' }),
        api: () => ({ method: 'POST', url: '/api/v1/week-plans' }),
      },
      {
        name: 'DELETE /week-plans/{id} (POST /calendar/plan-week/:id/undo)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/calendar/plan-week/${s.weekPlanId}/undo`,
        }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/week-plans/${s.weekPlanId}`,
        }),
      },
      {
        name: 'PUT /week-template (POST /auth/profile/week)',
        ok: [303, 200],
        page: () => ({
          method: 'POST',
          url: '/auth/profile/week',
          payload: { 'day-1': 'work', 'around-1': 'evening' },
        }),
        api: () => ({
          method: 'PUT',
          url: '/api/v1/week-template',
          payload: { days: [{ weekday: 1, day: 'work', around: ['evening'] }] },
        }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, page, api }) => {
      const [onPage, onApi] = [await setup(), await setup()];
      const pageRun = await statementsOf(() => t.inject(page(onPage)));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, api(onApi)));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
    });

    it('GET /week-template: the token and the template', async () => {
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const run = await statementsOf(() =>
        t.api(token, { method: 'GET', url: '/api/v1/week-template' }),
      );
      expect(run.status).toBe(200);
      expect(run.statements).toBe(2);
    });
  });

  describe('trips and packing: what their page twins cost (#194a)', () => {
    let token: string;

    beforeAll(async () => {
      token = await twinToken();
    });

    /**
     * One run's trip, on today and tomorrow: an outfit on it for today, its
     * garment packed, one extra; another trip with an extra to copy, and a
     * saved outfit not on the trip.
     */
    interface TripSetup {
      tripId: number;
      otherTripId: number;
      tripOutfitId: number;
      itemId: number;
      garmentId: number;
      spareOutfitId: number;
      today: string;
    }

    const newTrip = async (name: string, today: string) => {
      const made = await t.inject({
        method: 'POST',
        url: '/trips',
        payload: { name, startsOn: today, endsOn: addDays(today, 1) },
      });
      return Number(
        /^\/trips\/(\d+)\?/.exec(made.headers.location as string)![1],
      );
    };

    const newOutfit = async (garmentId: number) => {
      const made = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: { category: 'shirt', garmentId: String(garmentId) },
      });
      return Number(
        /^\/outfits\/(\d+)$/.exec(made.headers.location as string)![1],
      );
    };

    const tripSetup = async (): Promise<TripSetup> => {
      const today = t.today();
      const garmentId = await createGarment(t, {
        name: 'Packed',
        category: 'shirt',
      });
      const outfitId = await newOutfit(garmentId);
      const spareOutfitId = await newOutfit(
        await createGarment(t, { name: 'Spare', category: 'shirt' }),
      );
      const tripId = await newTrip('Counted trip', today);
      const otherTripId = await newTrip('Other trip', today);
      for (const [url, payload] of [
        [
          `/trips/${tripId}/outfits`,
          { outfitId: String(outfitId), day: today },
        ],
        [`/trips/${tripId}/packed`, { packed: String(garmentId) }],
        [`/trips/${tripId}/items`, { label: 'Charger' }],
        [`/trips/${otherTripId}/items`, { label: 'Passport' }],
      ] as const) {
        expect(
          (await t.inject({ method: 'POST', url, payload })).statusCode,
        ).toBe(303);
      }
      const [{ id: tripOutfitId }] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, tripId));
      const [{ id: itemId }] = await t.db
        .select({ id: tripItem.id })
        .from(tripItem)
        .where(eq(tripItem.tripId, tripId));
      return {
        tripId,
        otherTripId,
        tripOutfitId,
        itemId,
        garmentId,
        spareOutfitId,
        today,
      };
    };

    /** Each route's page twin and its API request, each on a setup of its own: the same writer, the same statements. */
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      page: (s: TripSetup) => InjectOptions;
      api: (s: TripSetup) => InjectOptions;
    }[] = [
      {
        name: 'GET /trips (GET /trips)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/trips' }),
        api: () => ({ method: 'GET', url: '/api/v1/trips' }),
      },
      {
        name: 'GET /trips/{id} (GET /trips/:id)',
        ok: [200, 200],
        page: (s) => ({ method: 'GET', url: `/trips/${s.tripId}` }),
        api: (s) => ({ method: 'GET', url: `/api/v1/trips/${s.tripId}` }),
      },
      {
        name: 'POST /trips (POST /trips)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: '/trips',
          payload: { name: 'New', startsOn: s.today, endsOn: s.today },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/trips',
          payload: { name: 'New', startsOn: s.today, endsOn: s.today },
        }),
      },
      {
        name: 'PUT /trips/{id} (POST /trips/:id)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}`,
          payload: { name: 'Renamed', startsOn: s.today, endsOn: s.today },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/trips/${s.tripId}`,
          payload: { name: 'Renamed', startsOn: s.today, endsOn: s.today },
        }),
      },
      {
        name: 'DELETE /trips/{id} (DELETE /trips/:id)',
        ok: [200, 204],
        page: (s) => ({ method: 'DELETE', url: `/trips/${s.tripId}` }),
        api: (s) => ({ method: 'DELETE', url: `/api/v1/trips/${s.tripId}` }),
      },
      {
        name: 'POST /trips/{id}/outfits (POST /trips/:id/outfits)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/outfits`,
          payload: { outfitId: String(s.spareOutfitId), day: s.today },
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/trips/${s.tripId}/outfits`,
          payload: { outfitId: s.spareOutfitId, day: s.today },
        }),
      },
      {
        name: 'DELETE /trips/{id}/outfits/{tripOutfitId} (POST …/delete)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/outfits/${s.tripOutfitId}/delete`,
        }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/trips/${s.tripId}/outfits/${s.tripOutfitId}`,
        }),
      },
      {
        name: 'POST /trips/{id}/outfits/{tripOutfitId}/wears (POST …/wear)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/outfits/${s.tripOutfitId}/wear`,
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/trips/${s.tripId}/outfits/${s.tripOutfitId}/wears`,
        }),
      },
      {
        name: 'PUT /trips/{id}/packing/{garmentId} (POST /trips/:id/packed)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/packed`,
          payload: { shown: String(s.garmentId) },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/trips/${s.tripId}/packing/${s.garmentId}`,
          payload: { packed: false },
        }),
      },
      {
        name: 'POST /trips/{id}/items (POST /trips/:id/items)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/items`,
          payload: { label: 'Adapter' },
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/trips/${s.tripId}/items`,
          payload: { label: 'Adapter' },
        }),
      },
      {
        name: 'PATCH /trips/{id}/items/{itemId} (POST /trips/:id/items/packed)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/items/packed`,
          payload: { packed: String(s.itemId), shown: String(s.itemId) },
        }),
        api: (s) => ({
          method: 'PATCH',
          url: `/api/v1/trips/${s.tripId}/items/${s.itemId}`,
          payload: { packed: true },
        }),
      },
      {
        name: 'DELETE /trips/{id}/items/{itemId} (POST …/items/:itemId/delete)',
        ok: [303, 204],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/items/${s.itemId}/delete`,
        }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/trips/${s.tripId}/items/${s.itemId}`,
        }),
      },
      {
        name: 'POST /trips/{id}/items/copies (POST /trips/:id/items/copy)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/trips/${s.tripId}/items/copy`,
          payload: { from: String(s.otherTripId) },
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/trips/${s.tripId}/items/copies`,
          payload: { fromTripId: s.otherTripId },
        }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, page, api }) => {
      const [onPage, onApi] = [await tripSetup(), await tripSetup()];
      const pageRun = await statementsOf(() => t.inject(page(onPage)));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, api(onApi)));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
    });
  });

  describe('the wishlist and capsules: what their page twins cost (#194b)', () => {
    let token: string;

    beforeAll(async () => {
      token = await twinToken();
    });

    /**
     * One run's own rows: a need with two picks and another with one
     * bought, a capsule holding a garment, so each write has something to
     * change and no run sees another's.
     */
    interface ShopSetup {
      needId: number;
      pickId: number;
      boughtId: number;
      capsuleId: number;
      garmentId: number;
      today: string;
    }

    let runs = 0;
    const shopSetup = async (): Promise<ShopSetup> => {
      const tag = ++runs;
      const ownerId = t.owner.id;
      const need = async (name: string) => {
        const [row] = await t.db
          .insert(optionGroup)
          .values({ ownerId, name, budget: '100' })
          .returning({ id: optionGroup.id });
        return row.id;
      };
      const pick = async (name: string, groupId: number) => {
        const id = await createWishlistItem(t, { name, price: '90' });
        const marked = await markSuggestion(t.db, ownerId, id, {
          tokenId: null,
          groupId,
          note: null,
          rank: null,
        });
        expect(marked).toBe('marked');
        return id;
      };
      const needId = await need(`Counted need ${tag}`);
      const pickId = await pick(`Counted pick ${tag}`, needId);
      await pick(`Counted sibling ${tag}`, needId);
      const boughtId = await pick(
        `Counted bought ${tag}`,
        await need(`Counted bought need ${tag}`),
      );
      const bought = await t.inject({
        method: 'POST',
        url: `/wardrobe/${boughtId}/bought`,
        payload: { acquiredOn: t.today() },
      });
      expect(bought.statusCode).toBe(303);
      const garmentId = await createGarment(t, {
        name: `Counted member ${tag}`,
      });
      const made = await t.inject({
        method: 'POST',
        url: '/capsules',
        payload: { name: `Counted capsule ${tag}` },
      });
      const capsuleId = Number(
        /^\/capsules\/(\d+)/.exec(made.headers.location as string)![1],
      );
      expect(
        (
          await t.inject({
            method: 'POST',
            url: `/capsules/${capsuleId}/garments`,
            payload: { ids: [garmentId] },
          })
        ).statusCode,
      ).toBe(303);
      return {
        needId,
        pickId,
        boughtId,
        capsuleId,
        garmentId,
        today: t.today(),
      };
    };

    /**
     * Each route's page twin and its API request, each on a setup of its
     * own: the same writer, the same statements, but `fewer` where the page
     * reads what only its drawing needs.
     */
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      /** Statements the API saves on its page twin, and why. */
      fewer?: number;
      page: (s: ShopSetup) => InjectOptions;
      api: (s: ShopSetup) => InjectOptions;
    }[] = [
      {
        name: 'GET /wishlist (GET /wardrobe/wishlist)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/wardrobe/wishlist' }),
        api: () => ({ method: 'GET', url: '/api/v1/wishlist' }),
      },
      {
        name: 'GET /wishlist/needs/{id} (GET /wardrobe/wishlist/needs/:id)',
        ok: [200, 200],
        page: (s) => ({
          method: 'GET',
          url: `/wardrobe/wishlist/needs/${s.needId}`,
        }),
        api: (s) => ({
          method: 'GET',
          url: `/api/v1/wishlist/needs/${s.needId}`,
        }),
      },
      {
        name: 'POST /wishlist/seen (POST /wardrobe/wishlist/seen)',
        ok: [200, 200],
        page: () => ({ method: 'POST', url: '/wardrobe/wishlist/seen' }),
        api: () => ({ method: 'POST', url: '/api/v1/wishlist/seen' }),
      },
      {
        name: 'POST /garments/{id}/decisions (POST /wardrobe/:id/choose)',
        ok: [303, 200],
        page: (s) => ({ method: 'POST', url: `/wardrobe/${s.pickId}/choose` }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/garments/${s.pickId}/decisions`,
          payload: { event: 'choose' },
        }),
      },
      {
        name: 'POST /wishlist/needs/{id}/decisions (POST …/needs/:id/dismiss)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/wardrobe/wishlist/needs/${s.needId}/dismiss`,
          payload: { reason: 'not_now' },
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/wishlist/needs/${s.needId}/decisions`,
          payload: { event: 'dismiss', reason: 'not_now' },
        }),
      },
      {
        name: 'POST /garments/{id}/purchases (POST /wardrobe/:id/bought)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/wardrobe/${s.pickId}/bought`,
          payload: { acquiredOn: s.today, price: '80' },
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/garments/${s.pickId}/purchases`,
          payload: { acquiredOn: s.today, price: '80' },
        }),
      },
      {
        name: 'POST /garments/{id}/returns (POST /wardrobe/:id/returned)',
        ok: [200, 200],
        page: (s) => ({
          method: 'POST',
          url: `/wardrobe/${s.boughtId}/returned`,
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/garments/${s.boughtId}/returns`,
        }),
      },
      {
        name: 'GET /capsules (GET /capsules)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/capsules' }),
        api: () => ({ method: 'GET', url: '/api/v1/capsules' }),
      },
      {
        // The page reads the capsule's first page of garments and their
        // count beside it; the API's are GET /garments?capsuleId=.
        name: 'GET /capsules/{id} (GET /capsules/:id)',
        ok: [200, 200],
        fewer: 2,
        page: (s) => ({ method: 'GET', url: `/capsules/${s.capsuleId}` }),
        api: (s) => ({ method: 'GET', url: `/api/v1/capsules/${s.capsuleId}` }),
      },
      {
        name: 'POST /capsules (POST /capsules)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: '/capsules',
          payload: { name: `Page capsule ${s.capsuleId}` },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/capsules',
          payload: { name: `Api capsule ${s.capsuleId}` },
        }),
      },
      {
        // The page reads the capsule before the form, to draw a refused
        // one; the API's refusal reads it only then.
        name: 'PUT /capsules/{id} (POST /capsules/:id)',
        ok: [303, 200],
        fewer: 1,
        page: (s) => ({
          method: 'POST',
          url: `/capsules/${s.capsuleId}`,
          payload: { name: `Renamed ${s.capsuleId}` },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/capsules/${s.capsuleId}`,
          payload: { name: `Renamed ${s.capsuleId}` },
        }),
      },
      {
        name: 'DELETE /capsules/{id} (DELETE /capsules/:id)',
        ok: [200, 204],
        page: (s) => ({ method: 'DELETE', url: `/capsules/${s.capsuleId}` }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/capsules/${s.capsuleId}`,
        }),
      },
      {
        name: 'PATCH /capsules/{id}/members (POST /capsules/:id/garments)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/capsules/${s.capsuleId}/garments`,
          payload: { shown: [s.garmentId] },
        }),
        api: (s) => ({
          method: 'PATCH',
          url: `/api/v1/capsules/${s.capsuleId}/members`,
          payload: { remove: [s.garmentId] },
        }),
      },
      {
        name: 'PATCH /garments/{id}/capsules (POST /wardrobe/:id/capsules)',
        ok: [200, 200],
        page: (s) => ({
          method: 'POST',
          url: `/wardrobe/${s.garmentId}/capsules`,
          payload: { shown: [s.capsuleId] },
        }),
        api: (s) => ({
          method: 'PATCH',
          url: `/api/v1/garments/${s.garmentId}/capsules`,
          payload: { remove: [s.capsuleId] },
        }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, fewer = 0, page, api }) => {
      const [onPage, onApi] = [await shopSetup(), await shopSetup()];
      const pageRun = await statementsOf(() => t.inject(page(onPage)));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, api(onApi)));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements - fewer);
    });

    it('GET /garments/{id}/goes-with: the token, then its inputs in one statement', async () => {
      const { pickId } = await shopSetup();
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      expect(
        await statementsOf(() =>
          t.api(token, {
            method: 'GET',
            url: `/api/v1/garments/${pickId}/goes-with`,
          }),
        ),
      ).toMatchObject({ status: 200, statements: 2 });
    });
  });

  describe('ideas, the pick, clashes and selfies: what their page twins cost (#193c)', () => {
    let token: string;
    let photo: Buffer;

    beforeAll(async () => {
      token = await twinToken();
      photo = await jpegPhoto(320, 240);
    });

    const selfieUpload = () =>
      multipart(
        {},
        {
          photo: {
            data: photo,
            filename: 'mirror.jpg',
            contentType: 'image/jpeg',
          },
        },
      );

    /** One run's rows: two loose garments, avoided together, and an outfit planned today with a selfie. */
    interface Setup {
      top: number;
      bottom: number;
      entryId: number;
      selfieId: number;
      selfieFileName: string;
      today: string;
    }

    const setup = async (): Promise<Setup> => {
      const today = t.today();
      const top = await createGarment(t, {
        name: 'Idea tee',
        category: 'tops',
      });
      const bottom = await createGarment(t, {
        name: 'Idea jeans',
        category: 'bottoms',
      });
      await t.inject({
        method: 'POST',
        url: '/outfits/ideas/avoid',
        payload: { garmentId: [String(top), String(bottom)] },
      });
      const held = await createGarment(t, { name: 'Mirror', category: 'tops' });
      const made = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: { category: 'shirt', garmentId: String(held) },
      });
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(made.headers.location as string)![1],
      );
      await t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: today, outfitId: String(outfitId) },
      });
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, outfitId));
      await t.inject({
        method: 'POST',
        url: `/calendar/${entry.id}/selfie`,
        ...(await selfieUpload()),
      });
      const [taken] = await t.db
        .select({ id: selfie.id, fileName: file.fileName })
        .from(selfie)
        .innerJoin(file, eq(file.id, selfie.photoId))
        .where(eq(selfie.outfitCalendarId, entry.id));
      return {
        top,
        bottom,
        entryId: entry.id,
        selfieId: taken.id,
        selfieFileName: taken.fileName,
        today,
      };
    };

    /**
     * Each route's page twin and its API request, each on a setup of its
     * own: the same domain function, so the same statements; GET /ideas
     * with garments locked reads them in the ideas' statement, where the
     * page's `?with=` reads its garment first (one fewer).
     */
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      fewer?: number;
      page: (s: Setup) => InjectOptions | Promise<InjectOptions>;
      api: (s: Setup) => InjectOptions | Promise<InjectOptions>;
    }[] = [
      {
        name: 'GET /ideas (GET /outfits/ideas)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/outfits/ideas' }),
        api: () => ({ method: 'GET', url: '/api/v1/ideas' }),
      },
      {
        name: 'GET /ideas?with= (GET /outfits/ideas?with=)',
        ok: [200, 200],
        fewer: 1,
        page: (s) => ({ method: 'GET', url: `/outfits/ideas?with=${s.top}` }),
        api: (s) => ({ method: 'GET', url: `/api/v1/ideas?with=${s.top}` }),
      },
      {
        name: 'POST /outfit-picks (POST /outfits/ideas/pick)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: '/outfits/ideas/pick',
          payload: {
            garmentId: [String(s.top), String(s.bottom)],
            for: `day:${addDays(s.today, 2)}`,
          },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/outfit-picks',
          payload: {
            garmentIds: [s.top, s.bottom],
            plan: { day: addDays(s.today, 2) },
          },
        }),
      },
      {
        name: 'PUT /garments/{id}/clashes/{otherId} (POST /outfits/ideas/avoid)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: '/outfits/ideas/avoid',
          payload: { garmentId: [String(s.top), String(s.bottom)] },
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/garments/${s.top}/clashes/${s.bottom}`,
        }),
      },
      {
        name: 'DELETE /garments/{id}/clashes/{otherId} (POST /outfits/ideas/allow)',
        ok: [303, 204],
        page: (s) => ({
          method: 'POST',
          url: '/outfits/ideas/allow',
          payload: { garmentId: [String(s.top), String(s.bottom)] },
        }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/garments/${s.top}/clashes/${s.bottom}`,
        }),
      },
      {
        name: 'PUT /calendar-entries/{id}/selfie (POST /calendar/:id/selfie)',
        ok: [303, 200],
        page: async (s) => ({
          method: 'POST',
          url: `/calendar/${s.entryId}/selfie`,
          ...(await selfieUpload()),
        }),
        api: async (s) => ({
          method: 'PUT',
          url: `/api/v1/calendar-entries/${s.entryId}/selfie`,
          ...(await selfieUpload()),
        }),
      },
      {
        name: 'DELETE /selfies/{id} (POST /selfies/:id/delete)',
        ok: [303, 204],
        page: (s) => ({ method: 'POST', url: `/selfies/${s.selfieId}/delete` }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/selfies/${s.selfieId}`,
        }),
      },
      {
        name: 'GET /selfie-photos/{fileName} (GET /selfies/:fileName)',
        ok: [200, 200],
        page: (s) => ({
          method: 'GET',
          url: `/selfies/${s.selfieFileName}?v=1`,
        }),
        api: (s) => ({
          method: 'GET',
          url: `/api/v1/selfie-photos/${s.selfieFileName}?v=1`,
        }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, fewer = 0, page, api }) => {
      const [onPage, onApi] = [await setup(), await setup()];
      const pageRequest = await page(onPage);
      const pageRun = await statementsOf(() => t.inject(pageRequest));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRequest = await api(onApi);
      const apiRun = await statementsOf(() => t.api(token, apiRequest));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements - fewer);
    });
  });

  describe('saved looks: what their page twins cost (#193d)', () => {
    // A user of their own: the shared twin device's API_LIMIT (120 a
    // minute) is spent by the sections above, and the owner's sign-ins by
    // SIGN_IN_ACCOUNT_LIMIT.
    const email = 'looks-statements@example.com';
    let cookie: string;
    let token: string;
    let photo: Buffer;

    /** A page request as this user's session. */
    const asUser = (request: InjectOptions): InjectOptions => ({
      ...request,
      headers: { ...request.headers, cookie },
    });

    beforeAll(async () => {
      cookie = await t.register(email);
      token = (await deviceToken(t, { email })).token;
      photo = await jpegPhoto(320, 240);
      sites.serve('/look-counted.jpg', jpeg(photo));
    });

    const lookUpload = () =>
      multipart(
        {},
        {
          photo: {
            data: photo,
            filename: 'look.jpg',
            contentType: 'image/jpeg',
          },
        },
      );

    /** One run's rows: a look with its photo and one piece (a white tee), and a closet tee. */
    interface Setup {
      id: number;
      fileName: string;
      tee: number;
    }

    const setup = async (): Promise<Setup> => {
      const made = await t.inject(
        asUser({
          method: 'POST',
          url: '/inspiration',
          ...(await lookUpload()),
        }),
      );
      const id = Number(
        /^\/inspiration\/(\d+)$/.exec(made.headers.location as string)![1],
      );
      await t.inject(
        asUser({
          method: 'POST',
          url: `/inspiration/${id}/pieces`,
          payload: {
            kind: 'top/t-shirt',
            color: 'white',
            accent: '',
            pattern: '',
          },
        }),
      );
      const [{ fileName }] = await t.db
        .select({ fileName: file.fileName })
        .from(inspiration)
        .innerJoin(file, eq(file.id, inspiration.photoId))
        .where(eq(inspiration.id, id));
      const tee = await createGarment(t, {
        name: 'Look tee',
        category: 'tops',
        cookie,
      });
      return { id, fileName, tee };
    };

    const piece = {
      kind: 'bottom/jeans',
      color: 'blue',
      accent: '',
      pattern: '',
    };
    const apiPiece = { role: 'bottom', type: 'jeans', colors: ['blue'] };

    /**
     * Each route's page twin and its API request, each on a setup of its
     * own: the same writer or read, so the same statements.
     */
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      page: (s: Setup) => InjectOptions | Promise<InjectOptions>;
      api: (s: Setup) => InjectOptions | Promise<InjectOptions>;
    }[] = [
      {
        name: 'GET /looks (GET /inspiration)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/inspiration' }),
        api: () => ({ method: 'GET', url: '/api/v1/looks' }),
      },
      {
        name: 'GET /looks/{id} (GET /inspiration/:id)',
        ok: [200, 200],
        page: (s) => ({ method: 'GET', url: `/inspiration/${s.id}` }),
        api: (s) => ({ method: 'GET', url: `/api/v1/looks/${s.id}` }),
      },
      {
        name: 'POST /looks (POST /inspiration)',
        ok: [303, 201],
        page: async () => ({
          method: 'POST',
          url: '/inspiration',
          ...(await lookUpload()),
        }),
        api: async () => ({
          method: 'POST',
          url: '/api/v1/looks',
          ...(await lookUpload()),
        }),
      },
      {
        name: 'POST /looks/link-imports (POST /inspiration/link)',
        ok: [303, 201],
        page: () => ({
          method: 'POST',
          url: '/inspiration/link',
          payload: { url: sites.url('/look-counted.jpg') },
        }),
        api: () => ({
          method: 'POST',
          url: '/api/v1/looks/link-imports',
          payload: { url: sites.url('/look-counted.jpg') },
        }),
      },
      {
        name: 'PATCH /looks/{id} (POST /inspiration/:id)',
        ok: [303, 204],
        page: (s) => ({
          method: 'POST',
          url: `/inspiration/${s.id}`,
          payload: { title: 'Counted', note: 'A note' },
        }),
        api: (s) => ({
          method: 'PATCH',
          url: `/api/v1/looks/${s.id}`,
          payload: { title: 'Counted', note: 'A note' },
        }),
      },
      {
        name: 'DELETE /looks/{id} (POST /inspiration/:id/delete)',
        ok: [303, 204],
        page: (s) => ({ method: 'POST', url: `/inspiration/${s.id}/delete` }),
        api: (s) => ({ method: 'DELETE', url: `/api/v1/looks/${s.id}` }),
      },
      {
        name: 'PUT /looks/{id}/photo (POST /inspiration/:id/photo)',
        ok: [303, 200],
        page: async (s) => ({
          method: 'POST',
          url: `/inspiration/${s.id}/photo`,
          ...(await lookUpload()),
        }),
        api: async (s) => ({
          method: 'PUT',
          url: `/api/v1/looks/${s.id}/photo`,
          ...(await lookUpload()),
        }),
      },
      {
        name: 'POST /looks/{id}/pieces (POST /inspiration/:id/pieces)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: `/inspiration/${s.id}/pieces`,
          payload: piece,
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/looks/${s.id}/pieces`,
          payload: apiPiece,
        }),
      },
      {
        name: 'PUT /looks/{id}/pieces/{position} (POST /inspiration/:id/pieces/:position)',
        ok: [303, 200],
        page: (s) => ({
          method: 'POST',
          url: `/inspiration/${s.id}/pieces/0`,
          payload: piece,
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/looks/${s.id}/pieces/0`,
          payload: apiPiece,
        }),
      },
      {
        name: 'DELETE /looks/{id}/pieces/{position} (POST /inspiration/:id/pieces/:position/delete)',
        ok: [303, 204],
        page: (s) => ({
          method: 'POST',
          url: `/inspiration/${s.id}/pieces/0/delete`,
        }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/looks/${s.id}/pieces/0`,
        }),
      },
      {
        name: 'GET /looks/{id}/recreation (GET /inspiration/:id/recreate)',
        ok: [200, 200],
        page: (s) => ({ method: 'GET', url: `/inspiration/${s.id}/recreate` }),
        api: (s) => ({
          method: 'GET',
          url: `/api/v1/looks/${s.id}/recreation`,
        }),
      },
      {
        name: 'POST /looks/{id}/outfits (POST /inspiration/:id/recreate/outfit)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: `/inspiration/${s.id}/recreate/outfit`,
          payload: { position: ['0'], garment: [String(s.tee)] },
        }),
        api: (s) => ({
          method: 'POST',
          url: `/api/v1/looks/${s.id}/outfits`,
          payload: { choices: [{ position: 0, garmentId: s.tee }] },
        }),
      },
      {
        name: 'PUT /looks/{id}/pieces/{position}/wishlist-item (POST /inspiration/:id/pieces/:position/find)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: `/inspiration/${s.id}/pieces/0/find`,
        }),
        api: (s) => ({
          method: 'PUT',
          url: `/api/v1/looks/${s.id}/pieces/0/wishlist-item`,
        }),
      },
      {
        name: 'GET /look-photos/{fileName} (GET /inspiration/photo/:fileName)',
        ok: [200, 200],
        page: (s) => ({
          method: 'GET',
          url: `/inspiration/photo/${s.fileName}?v=1`,
        }),
        api: (s) => ({
          method: 'GET',
          url: `/api/v1/look-photos/${s.fileName}?v=1`,
        }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, page, api }) => {
      const [onPage, onApi] = [await setup(), await setup()];
      const pageRequest = await page(onPage);
      const pageRun = await statementsOf(() => t.inject(asUser(pageRequest)));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRequest = await api(onApi);
      const apiRun = await statementsOf(() => t.api(token, apiRequest));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
    });

    it("PUT /looks/{id}/pieces: the token, then set_inspiration_pieces' transaction (no page twin sets the whole list)", async () => {
      const { id } = await setup();
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const run = await statementsOf(() =>
        t.api(token, {
          method: 'PUT',
          url: `/api/v1/looks/${id}/pieces`,
          payload: { pieces: [apiPiece] },
        }),
      );
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
    let pairs = 0;

    const asUser = (request: InjectOptions): InjectOptions => ({
      ...request,
      headers: { ...request.headers, cookie },
    });

    beforeAll(async () => {
      cookie = await t.register(email);
      token = (await deviceToken(t, { email })).token;
      userId = await userIdOf(t, email);
    });

    /** One run's rows: a rule to remove, and two colours no rule holds yet. */
    interface Setup {
      ruleId: number;
      colors: [string, string];
    }

    const setup = async (): Promise<Setup> => {
      const [a, b, c] = [0, 1, 2].map(
        (i) => GARMENT_COLORS[(pairs * 3 + i) % GARMENT_COLORS.length],
      );
      pairs += 1;
      const ruleId = await addOutfitRule(
        t.db,
        { userId, surface: 'page' },
        {
          kind: 'always',
          a: { ...NO_MATCHER, color: a },
          b: { ...NO_MATCHER, pattern: 'stripes' },
        },
      );
      if (typeof ruleId !== 'number') throw new Error('No rule');
      return { ruleId, colors: [b, c] };
    };

    const profile = {
      styles: ['classic'],
      palette: ['black'],
      budget: 'mid',
      notes: 'Counted',
    };

    // Token auth is the API's one auth statement, as the session is the
    // page's: an extra read on either side fails the equality.
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      page: (s: Setup) => InjectOptions;
      api: (s: Setup) => InjectOptions;
    }[] = [
      {
        name: 'GET /style-profile (GET /auth/profile/style: it reads more in the one statement)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/auth/profile/style' }),
        api: () => ({ method: 'GET', url: '/api/v1/style-profile' }),
      },
      {
        name: 'PUT /style-profile (POST /auth/profile/style)',
        ok: [303, 200],
        page: () => ({
          method: 'POST',
          url: '/auth/profile/style',
          payload: profile,
        }),
        api: () => ({
          method: 'PUT',
          url: '/api/v1/style-profile',
          payload: profile,
        }),
      },
      {
        name: 'POST /outfit-rules (POST /auth/profile/style/rules)',
        ok: [303, 201],
        page: (s) => ({
          method: 'POST',
          url: '/auth/profile/style/rules',
          payload: {
            kind: 'never',
            a: `color:${s.colors[0]}`,
            b: `color:${s.colors[1]}`,
          },
        }),
        api: (s) => ({
          method: 'POST',
          url: '/api/v1/outfit-rules',
          payload: {
            kind: 'never',
            a: { color: s.colors[0] },
            b: { color: s.colors[1] },
          },
        }),
      },
      {
        name: 'DELETE /outfit-rules/{id} (POST /auth/profile/style/rules/:id/delete)',
        ok: [303, 204],
        page: (s) => ({
          method: 'POST',
          url: `/auth/profile/style/rules/${s.ruleId}/delete`,
        }),
        api: (s) => ({
          method: 'DELETE',
          url: `/api/v1/outfit-rules/${s.ruleId}`,
        }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, page, api }) => {
      const [onPage, onApi] = [await setup(), await setup()];
      const pageRun = await statementsOf(() => t.inject(asUser(page(onPage))));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, api(onApi)));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
      expect(apiRun.statements).toBe(2);
    });

    it("GET /shared-wardrobes: the token, then list_shared_wardrobes' one read (no page twin)", async () => {
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const run = await statementsOf(() =>
        t.api(token, { method: 'GET', url: '/api/v1/shared-wardrobes' }),
      );
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

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW });
      stub = await startWeatherStub();
      w = await createTestApp(
        { WEATHER_ENABLED: 'true' },
        { weather: stub.options },
      );
      token = (await deviceToken(w)).token;
      for (const [name, category] of [
        ['Counted tee', 'tops'],
        ['Counted jeans', 'bottoms'],
        ['Counted trainers', 'footwear'],
      ] as const) {
        await createGarment(w, { name, category });
      }
      const today = w.today();
      const made = await w.inject({
        method: 'POST',
        url: '/trips',
        payload: { name: 'Counted trip', startsOn: today, endsOn: today },
      });
      tripId = Number(
        /^\/trips\/(\d+)\?/.exec(made.headers.location as string)![1],
      );
      // A home and the trip's destination with their forecasts kept: a
      // first ask's fetch is the cache's statements, no route's.
      await w.inject({
        method: 'POST',
        url: '/weather/home',
        payload: { name: 'Brooklyn', ...BROOKLYN },
      });
      await w.inject({
        method: 'POST',
        url: `/trips/${tripId}/destination`,
        payload: { name: 'Brooklyn', ...BROOKLYN },
      });
      await w.inject({ method: 'GET', url: '/weather/summary' });
      await w.inject({ method: 'GET', url: `/trips/${tripId}/weather` });
      await w.weather!.settled();
    });

    afterAll(async () => {
      await w?.cleanup();
      await stub?.close();
      vi.useRealTimers();
    });

    const BROOKLYN = { latitude: '40.65', longitude: '-73.95' };
    const place = { name: 'Brooklyn', latitude: 40.65, longitude: -73.95 };

    /** Each route's page twin (a plain post: its 303 reads nothing back) and its API request. */
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      page: () => InjectOptions;
      api: () => InjectOptions;
    }[] = [
      {
        name: 'GET /today (GET /)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/' }),
        api: () => ({ method: 'GET', url: '/api/v1/today' }),
      },
      {
        name: 'GET /weather (GET /weather/summary)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/weather/summary' }),
        api: () => ({ method: 'GET', url: '/api/v1/weather' }),
      },
      {
        name: 'GET /weather/places (GET /weather/places)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/weather/places?q=Brooklyn' }),
        api: () => ({
          method: 'GET',
          url: '/api/v1/weather/places?q=Brooklyn',
        }),
      },
      {
        name: 'PUT /weather/home (POST /weather/home)',
        ok: [303, 200],
        page: () => ({
          method: 'POST',
          url: '/weather/home',
          payload: { name: 'Brooklyn', ...BROOKLYN },
        }),
        api: () => ({
          method: 'PUT',
          url: '/api/v1/weather/home',
          payload: place,
        }),
      },
      {
        name: 'PUT /weather/here (POST /weather/here)',
        ok: [303, 200],
        page: () => ({
          method: 'POST',
          url: '/weather/here',
          payload: BROOKLYN,
        }),
        api: () => ({
          method: 'PUT',
          url: '/api/v1/weather/here',
          payload: { latitude: 40.65, longitude: -73.95 },
        }),
      },
      {
        name: 'DELETE /weather/here (POST /weather/here/clear)',
        ok: [303, 204],
        page: () => ({ method: 'POST', url: '/weather/here/clear' }),
        api: () => ({ method: 'DELETE', url: '/api/v1/weather/here' }),
      },
      {
        name: 'PUT /weather/unit (POST /weather/unit)',
        ok: [303, 200],
        page: () => ({
          method: 'POST',
          url: '/weather/unit',
          payload: { unit: 'celsius' },
        }),
        api: () => ({
          method: 'PUT',
          url: '/api/v1/weather/unit',
          payload: { unit: 'celsius' },
        }),
      },
      {
        name: 'DELETE /weather/offset (POST /weather/offset/reset)',
        ok: [303, 204],
        page: () => ({ method: 'POST', url: '/weather/offset/reset' }),
        api: () => ({ method: 'DELETE', url: '/api/v1/weather/offset' }),
      },
      {
        name: 'GET /trips/{id}/weather (GET /trips/:id/weather)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: `/trips/${tripId}/weather` }),
        api: () => ({ method: 'GET', url: `/api/v1/trips/${tripId}/weather` }),
      },
      {
        name: 'PUT /trips/{id}/destination (POST /trips/:id/destination)',
        ok: [303, 200],
        page: () => ({
          method: 'POST',
          url: `/trips/${tripId}/destination`,
          payload: { name: 'Brooklyn', ...BROOKLYN },
        }),
        api: () => ({
          method: 'PUT',
          url: `/api/v1/trips/${tripId}/destination`,
          payload: place,
        }),
      },
      // Last: the home goes, and with it the forecast the reads above count.
      {
        name: 'DELETE /weather/home (POST /weather/home/clear)',
        ok: [303, 204],
        page: () => ({ method: 'POST', url: '/weather/home/clear' }),
        api: () => ({ method: 'DELETE', url: '/api/v1/weather/home' }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, page, api }) => {
      const pageRun = await statementsOf(() => w.inject(page()));
      // A second call of the minute: no last-use write.
      await w.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => w.api(token, api()));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
    });
  });

  describe('insights, the recap and sizes: what their page twins cost (#588)', () => {
    // A user of their own: the shared twin device's API_LIMIT is spent by
    // the sections above.
    const email = 'sizes-statements@example.com';
    let cookie: string;
    let token: string;
    let brands = 0;

    const asUser = (request: InjectOptions): InjectOptions => ({
      ...request,
      headers: { ...request.headers, cookie },
    });

    beforeAll(async () => {
      cookie = await t.register(email);
      token = (await deviceToken(t, { email })).token;
      const worn = await createGarment(t, { name: 'Counted tee', cookie });
      await t.inject(
        asUser({
          method: 'POST',
          url: `/wardrobe/${worn}/wear`,
          payload: { worn: '1' },
        }),
      );
    });

    /** A brand row of this user's, through the editor: its id and brand. */
    const newBrand = async () => {
      const brand = `Counted ${++brands}`;
      await t.inject(
        asUser({
          method: 'POST',
          url: '/auth/profile/sizes/brands',
          payload: { brand, size: 'M' },
        }),
      );
      const [row] = await t.db
        .select({ id: brandSize.id })
        .from(brandSize)
        .where(eq(brandSize.brand, brand));
      return { id: row.id, brand };
    };
    type Brand = Awaited<ReturnType<typeof newBrand>>;

    /** Each route's page twin and its API request, each on a brand row of its own. */
    const CASES: {
      name: string;
      ok: [page: number, api: number];
      page: (b: Brand) => InjectOptions;
      api: (b: Brand) => InjectOptions;
    }[] = [
      {
        name: 'GET /insights (GET /wardrobe/insights)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/wardrobe/insights' }),
        api: () => ({ method: 'GET', url: '/api/v1/insights' }),
      },
      {
        name: 'GET /insights/recap (GET /wardrobe/recap)',
        ok: [200, 200],
        // The page without ?year= may read a second year (#733), so both
        // twins name this one.
        page: () => ({
          method: 'GET',
          url: `/wardrobe/recap?year=${t.today().slice(0, 4)}`,
        }),
        api: () => ({
          method: 'GET',
          url: `/api/v1/insights/recap?year=${t.today().slice(0, 4)}`,
        }),
      },
      {
        name: 'GET /sizes (GET /auth/profile/sizes)',
        ok: [200, 200],
        page: () => ({ method: 'GET', url: '/auth/profile/sizes' }),
        api: () => ({ method: 'GET', url: '/api/v1/sizes' }),
      },
      {
        name: 'GET /sizes/brands?brand= (GET /auth/profile/sizes/hint)',
        ok: [200, 200],
        page: (b) => ({
          method: 'GET',
          url: `/auth/profile/sizes/hint?brand=${encodeURIComponent(b.brand)}`,
        }),
        api: (b) => ({
          method: 'GET',
          url: `/api/v1/sizes/brands?brand=${encodeURIComponent(b.brand)}`,
        }),
      },
      {
        name: 'PUT /sizes/unit (POST /auth/profile/sizes/unit)',
        ok: [303, 200],
        page: () => ({
          method: 'POST',
          url: '/auth/profile/sizes/unit',
          payload: { unit: 'cm' },
        }),
        api: () => ({
          method: 'PUT',
          url: '/api/v1/sizes/unit',
          payload: { unit: 'cm' },
        }),
      },
      {
        name: 'POST /sizes/brands (POST /auth/profile/sizes/brands)',
        ok: [303, 201],
        page: (b) => ({
          method: 'POST',
          url: '/auth/profile/sizes/brands',
          payload: { brand: `${b.brand} new`, size: 'L' },
        }),
        api: (b) => ({
          method: 'POST',
          url: '/api/v1/sizes/brands',
          payload: { brand: `${b.brand} new`, size: 'L' },
        }),
      },
      {
        name: 'PUT /sizes/brands/{id} (POST /auth/profile/sizes/brands/:id)',
        ok: [303, 200],
        page: (b) => ({
          method: 'POST',
          url: `/auth/profile/sizes/brands/${b.id}`,
          payload: { brand: b.brand, size: 'L', note: 'Runs small' },
        }),
        api: (b) => ({
          method: 'PUT',
          url: `/api/v1/sizes/brands/${b.id}`,
          payload: { brand: b.brand, size: 'L', note: 'Runs small' },
        }),
      },
      {
        name: 'DELETE /sizes/brands/{id} (POST /auth/profile/sizes/brands/:id/delete)',
        ok: [303, 204],
        page: (b) => ({
          method: 'POST',
          url: `/auth/profile/sizes/brands/${b.id}/delete`,
          payload: {},
        }),
        api: (b) => ({ method: 'DELETE', url: `/api/v1/sizes/brands/${b.id}` }),
      },
    ];

    it.each(CASES)('$name', async ({ ok, page, api }) => {
      const [onPage, onApi] = [await newBrand(), await newBrand()];
      const pageRun = await statementsOf(() => t.inject(asUser(page(onPage))));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, api(onApi)));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
    });

    it('PUT /sizes/measurements: one statement fewer than its page twin, which reads the stored lengths first', async () => {
      const pageRun = await statementsOf(() =>
        t.inject(
          asUser({
            method: 'POST',
            url: '/auth/profile/sizes/measurements',
            payload: { unit: 'cm', height: '180' },
          }),
        ),
      );
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() =>
        t.api(token, {
          method: 'PUT',
          url: '/api/v1/sizes/measurements',
          payload: { height: 180 },
        }),
      );
      expect([pageRun.status, apiRun.status]).toEqual([303, 200]);
      // The form keeps a stored length posted as it showed it
      // (readMeasurementsForm), so the page reads them before the save; a
      // length in centimetres has nothing to keep.
      expect(apiRun.statements).toBe(pageRun.statements - 1);
    });
  });

  describe('the changes feed: its cost does not grow with the page (#196b-1)', () => {
    // A user of their own, as the looks' (the twin device's API_LIMIT).
    const email = 'changes-statements@example.com';
    let token: string;

    const page = async (query: string) => {
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      return statementsOf(() =>
        t.api(token, { method: 'GET', url: `/api/v1/changes?${query}` }),
      );
    };

    beforeAll(async () => {
      await t.register(email);
      token = (await deviceToken(t, { email })).token;
      const ids: number[] = [];
      for (const name of ['One', 'Two', 'Three', 'Four']) {
        const res = await t.api(token, {
          method: 'POST',
          url: '/api/v1/garments',
          payload: { category: 'shirt', name },
        });
        ids.push(res.json<{ id: number }>().id);
      }
      const capsule = await t.api(token, {
        method: 'POST',
        url: '/api/v1/capsules',
        payload: { name: 'Counted' },
      });
      await t.api(token, {
        method: 'PATCH',
        url: `/api/v1/capsules/${capsule.json<{ id: number }>().id}/members`,
        payload: { add: ids },
      });
      await t.api(token, {
        method: 'PUT',
        url: `/api/v1/garments/${ids[0]}/wears/${t.today()}`,
      });
      // One of each owner's resource the API writes without a photo.
      const outfit = await t.api(token, {
        method: 'POST',
        url: '/api/v1/outfits',
        payload: { slots: [{ category: 'shirt', garmentId: ids[1] }] },
      });
      const writes: ['POST' | 'PUT', string, object][] = [
        [
          'POST',
          '/calendar-entries',
          { outfitId: outfit.json<{ id: number }>().id, day: t.today() },
        ],
        [
          'POST',
          '/trips',
          { name: 'Counted', startsOn: t.today(), endsOn: t.today() },
        ],
        ['POST', '/sizes/brands', { brand: 'Counted', size: 'xl' }],
        ['PUT', '/sizes/measurements', { waist: 80 }],
        ['PUT', '/style-profile', { styles: ['classic'], palette: ['black'] }],
        // Rides in the profile's read (#716): no statement of its own.
        [
          'POST',
          '/outfit-rules',
          { kind: 'never', a: { color: 'red' }, b: { color: 'green' } },
        ],
        // Written last, so the first pages are garments only.
        ['PUT', '/week-template', { days: [{ weekday: 1, day: 'work' }] }],
      ];
      for (const [method, url, payload] of writes) {
        const res = await t.api(token, {
          method,
          url: `/api/v1${url}`,
          payload,
        });
        expect(res.statusCode, res.body).toBeLessThan(300);
      }
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
      expect(await page(`cursor=${cursor}`)).toMatchObject({
        status: 200,
        statements: 5,
      });
    });
  });

  it('POST /garments/link-imports: the token, the pending photo kept, the claim; no read back', async () => {
    const { token } = await deviceToken(t);
    sites.serve('/counted.jpg', jpeg(await jpegPhoto(320, 240)));
    await t.api(token, { method: 'GET', url: '/api/v1/me' });
    const run = await statementsOf(() =>
      t.api(token, {
        method: 'POST',
        url: '/api/v1/garments/link-imports',
        payload: { url: sites.url('/counted.jpg'), category: 'tops' },
      }),
    );
    // The token; the fetched photo kept as a pending photo (its own
    // transaction, keepPendingPhoto); the claim (createGarmentWithPending
    // Photo: the name's lock, the pending row taken, the file row and the
    // garment). Its page twin answers the prefilled form unsaved, so no
    // count compares; its MCP twin (add_garment_from_link, 13) also reads
    // the garment back and looks for lookalikes.
    expect(run).toMatchObject({ status: 201, statements: 11 });
  });

  it('GET /openapi.json: none', async () => {
    expect(
      await statementsOf(() =>
        t.api(undefined, { method: 'GET', url: '/api/v1/openapi.json' }),
      ),
    ).toMatchObject({ status: 200, statements: 0 });
  });
});
