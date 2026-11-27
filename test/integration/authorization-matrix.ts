import type {
  InjectOptions,
  LightMyRequestResponse,
  RouteOptions,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenKind } from '../../src/credential-names';
import committedSpec from '../../src/web/api/openapi.json';
import {
  optionGroup,
  orderItem,
  outfit as outfitTable,
  outfitCalendar,
  tripItem,
  tripOutfit,
  wardrobeShare,
  weekPlan,
} from '../../src/db/schema';
import type { SuggestionDecision } from '../../src/wardrobe/suggestions';
import { setGarmentStatus } from '../../src/web/wardrobe/status';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { addOutfitRule, saveStyleProfile } from '../../src/web/style/queries';
import {
  EMPTY_STYLE_PROFILE,
  NO_MATCHER,
} from '../../src/web/style/validation';
import { LOGIN_PATH } from '../../src/web/auth/login-path';
import { addBrandSize } from '../../src/web/sizes/queries';
import { createInvite } from '../../src/web/sharing/queries';
import { setPublicShare } from '../../src/web/share/queries';
import { addRepair } from '../../src/web/wardrobe/repairs';
import { recordOrderEmail } from '../../src/web/wardrobe/order-mail/queries';
import { addDays, type IsoDate } from '../../src/calendar-date';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  photoFileName,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  type Env,
  OWNER_EMAIL,
  TestApp,
  type TestAppOptions,
  uniqueClient,
  userIdOf,
  asFixture,
  PWA_ENV,
} from './harness';
import { jpeg, type LinkSites, startLinkSites } from './link-sites';
import { deviceToken } from './api';
import { failCutout } from './cutouts';
import { mintToken } from './mcp';
import { addLook } from './inspiration';
import { planEntry, takeSelfie } from './selfies';
import { startJmapStub } from '../support/jmap-stub';
import { ownerLinkChecker } from './owner-links';
import { startWeatherStub } from '../support/weather-stub';

/**
 * The object-level authorization matrix, split by route group into
 * test/integration/authorization-*.spec.ts so Vitest spreads it across
 * workers (#113); each file hands its routes to describeMatrix. One owner (the harness's default
 * user) holds a garment (with a photo), an outfit and a calendar entry; every
 * route that takes one of their ids (plus the `?ownerId=` wardrobe routes)
 * is requested by the owner, a MANAGE grantee, a VIEW grantee, a registered
 * stranger and an anonymous visitor, with and without `?ownerId=<owner>`.
 * Each case asserts the status (or redirect), that refused requests leak
 * no names into the body, and that a refused write changed no row and no
 * stored file. Sharing covers the wardrobe, its garments and its capsules
 * (a VIEW grantee reads them, a MANAGE grantee also changes membership,
 * only the owner creates, renames and deletes a capsule): outfits and
 * calendar entries stay private to their owner whatever the share.
 *
 * Refusals follow WardrobeAccess (src/web/sharing/access.ts): what the
 * requester cannot see does not exist for them, a 404 like an unknown id (a
 * stranger's view of the owner's wardrobe, a garment outside the addressed
 * wardrobe, anyone else's outfit), so ids reveal nothing; what they can see
 * but may not change is a 403 (a VIEW grantee writing, a grantee archiving).
 * Calendar entries and outfits are never shared, so every refusal there is
 * a 404. The wishlist (#18) is the wardrobe's too: a VIEW grantee reads it,
 * a MANAGE grantee buys, only the owner restores an archived garment (and
 * archives what a purchase replaces). Day-level wears, washes and the
 * laundry are `launder`'s (#680): the owner and a MANAGE partner; away (#7)
 * is the owner's own record, about a garment a grantee can see: with
 * `?ownerId=` a 403, without it a 404 (the garment is not in their
 * wardrobe); a garment's condition is a property like any other (MANAGE
 * writes it). Insights (#17) are always the requester's own: a foreign
 * `?ownerId=` is a 404, and /laundry's batch ignores another's ids. The
 * style profile (#34) is private like outfits: anyone else sees their own.
 * Outfit selfies (#19) are the calendar's: taking,
 * removing and seeing one is the owner's alone, and the public /file/**
 * routes refuse a selfie's name and share id to everyone, the owner too;
 * saved looks (#22) and their photos the same, like the style profile.
 * Trips (#10) are the owner's like outfits: every refusal is a 404 (or the
 * requester's own list), including a gallery pick for someone else's trip.
 * So are the weekly auto-plan's batches and the order mail's review list
 * (#25: ORDER_MAIL_OWNER's alone, a 404 like a missing route for anyone
 * else). A share row is its two parties' (grantor and grantee): anyone
 * else, a grantee of the same wardrobe included, gets a 404.
 *
 * authorization-coverage.spec.ts fails when a route that takes an id is in
 * no group here (#182).
 */

type SignedIn = 'owner' | 'manager' | 'viewer' | 'stranger';
type ActorName = SignedIn | 'anonymous';
/** own: the URL as the app links it; ownerId: `?ownerId=<owner>` appended. */
export type Via = 'own' | 'ownerId';

/**
 * ok: the route's success status. Reads that `show` their subject must
 *     render its name; writes must change stored data; clones must add a
 *     garment to the requester's wardrobe and modify nothing that existed.
 * hidden: 200, but the requester's own data only (no owner names).
 * ignored: the route's success status, but the owner's ids were ignored:
 *     nothing leaked, nothing changed (/laundry's batch).
 * forbidden / notFound / login: refused, nothing leaked, nothing changed.
 * unauthorized: a 401 without a body worth reading: the MCP endpoint, where
 *     a session cookie never counts (only a personal access token does).
 */
type Outcome =
  | 'ok'
  | 'hidden'
  | 'ignored'
  | 'forbidden'
  | 'notFound'
  | 'login'
  | 'unauthorized';

export interface Fixture {
  garmentId: number;
  garmentName: string;
  /** A wishlist item replacing the garment (#18). */
  wishlistId: number;
  wishlistName: string;
  /**
   * A Muse need of the owner's (#333) with two options, one set aside; a
   * need set aside; and a pick bought (so Returned writes).
   */
  needId: number;
  needName: string;
  needPickId: number;
  setAsidePickId: number;
  asideNeedId: number;
  boughtPickId: number;
  /** An archived garment (Restore). */
  archivedId: number;
  archivedName: string;
  /** A capsule holding the garment. */
  capsuleId: number;
  capsuleName: string;
  outfitId: number;
  outfitName: string;
  /** The garment's and the outfit's public share ids (#669), shared in the fixture. */
  garmentShareId: string;
  outfitShareId: string;
  /** An empty outfit of the owner's, on no day: what the entry's Change picks. */
  spareOutfitId: number;
  /** One of Muse's outfits (#335) waiting on the owner, and one set aside. */
  museOutfitId: number;
  museDeclinedId: number;
  /** The calendar entry, planned on `today` (so worn may mark it). */
  entryId: number;
  /** The entry's outfit selfie (#19), and its photo's names. */
  selfieId: number;
  selfieFileName: string;
  /** A saved look of the owner's (#22) with a photo, and its title and photo's name. */
  inspirationId: number;
  inspirationTitle: string;
  inspirationFileName: string;
  /** A closet tee of the owner's, a match of the look's one piece (a white tee): what its save chooses (#22c). */
  inspirationTeeId: number;
  /** The owner's id. */
  ownerId: number;
  /**
   * A trip of the owner's (#10) on today and tomorrow: the outfit on it for
   * today, the garment packed, one extra; and another trip with an extra.
   */
  tripId: number;
  tripName: string;
  tripOutfitId: number;
  tripItemId: number;
  otherTripId: number;
  /**
   * The app's today (t.today(), APP_TIMEZONE) when the fixture was made:
   * the entry's day, and the day a wishlist item is bought.
   */
  today: IsoDate;
  /**
   * A new personal access token of the owner's, an agent's
   * (OWNER_TOKEN_NAME) or a device's (OWNER_DEVICE_NAME, #189), made when a
   * request asks for it: few routes need one, and the owner may hold only
   * MAX_ACTIVE_TOKENS of each kind.
   */
  ownerToken: (kind?: TokenKind) => Promise<number>;
  /**
   * The owner's size note (#24) for the wishlist item's brand, which only
   * the owner's own pages show (OWNER_SIZE_NOTE).
   */
  brandSizeId: number;
  brand: string;
  /** An outfit rule of the owner's (#21b): never the garment with black. */
  outfitRuleId: number;
  /** A repair log entry on the garment (#23), the owner's own record. */
  repairId: number;
  /**
   * A pending item of the owner's order mail (#25), whose product page the
   * link sites do not serve (the add form opens with the order's details).
   */
  orderItemId: number;
  orderItemName: string;
  /** A batch of the weekly auto-plan of the owner's, all its entries gone. */
  weekPlanId: number;
  /** An open invite link to the owner's wardrobe, not yet accepted, and its token (a bearer secret). */
  inviteShareId: number;
  inviteToken: string;
  /** A phone photo and a cutout to upload, the file's own for every test. */
  photo: Buffer;
  cutout: Buffer;
  /** The link import's "internet": a shop's photo URL (link-sites.ts). */
  shopPhotoUrl: string;
}

export interface Route {
  name: string;
  kind: 'read' | 'write' | 'clone';
  /** Status the route answers on success. */
  ok: number;
  /**
   * An optional feature the route exists only with: the group's app runs
   * with it on, against its stand-in (featureApp).
   */
  feature?: Feature;
  /** Text naming the owner's row: must appear on success, never on a refusal. */
  secret: (f: Fixture) => string;
  /** Success renders the secret (detail pages, lists, forms). */
  shows?: boolean;
  vias: Via[];
  request: (
    f: Fixture,
    ownerQuery: string,
  ) => InjectOptions | Promise<InjectOptions>;
  /** Per signed-in actor, one outcome for every via or one per via. */
  expect: Record<SignedIn, Outcome | Outcome[]>;
  /** A signed-out visitor's outcome when it is not the login redirect. */
  anonymous?: Outcome;
  /**
   * The route's /api/v1 twin (#191: its page route's operation in
   * src/web/api/operations.ts, which api-parity.spec.ts holds this to).
   * Every case replays on it with the actor's device token (anonymous: none)
   * and must answer the same outcome: `ok` the twin's own success status,
   * `login` a 401, a refusal the page's status. A clone's twin answers the
   * new garment as JSON with its `id`.
   */
  api?: {
    ok: number;
    request: (
      f: Fixture,
      ownerQuery: string,
    ) => InjectOptions | Promise<InjectOptions>;
  };
}

export const BOTH: Via[] = ['own', 'ownerId'];
export const garmentName = (f: Fixture) => f.garmentName;
export const wishlistName = (f: Fixture) => f.wishlistName;
export const needName = (f: Fixture) => f.needName;
export const archivedName = (f: Fixture) => f.archivedName;
export const capsuleName = (f: Fixture) => f.capsuleName;
export const outfitName = (f: Fixture) => f.outfitName;
export const tripName = (f: Fixture) => f.tripName;
export const orderItemName = (f: Fixture) => f.orderItemName;
// One style profile per user, so one note every fixture saves again.
const OWNER_STYLE_NOTE = 'Owner style notes, never shared';
export const styleNote = () => OWNER_STYLE_NOTE;
// The owner's note on the wishlist item's brand (#24): the owner's body,
// never shown to anyone else, a shared wardrobe's pages included.
export const OWNER_SIZE_NOTE = 'Owner size note, never shared';
export const sizeNote = () => OWNER_SIZE_NOTE;
// A calendar row's edit link: only the entry's owner is shown it. (Error
// pages echo the request path, which rules out the /calendar/:id URLs
// themselves.)
export const calendarEntry = (f: Fixture) =>
  `/styling?outfit=${f.outfitId}&amp;returnTo=`;
export const selfieName = (f: Fixture) => f.selfieFileName;
export const inspirationTitle = (f: Fixture) => f.inspirationTitle;
export const inspirationPhotoName = (f: Fixture) => f.inspirationFileName;
// The fixture garment's and wishlist item's price and the garment's notes
// (#680): `private`, so no answer to a VIEW grantee holds either, on any
// route of the matrix, a success or a refusal (expectAnswer).
export const PRIVATE_PRICE = '913.37';
export const PRIVATE_NOTES = 'Owner notes, never a VIEW share';
export const OWNER_TOKEN_NAME = 'Owner laptop token';
export const OWNER_DEVICE_NAME = 'Owner phone app';

/** A feature off by default whose routes exist only with it on. */
export type Feature = 'weather' | 'orderMail' | 'pwa';

const ORDER_MAIL_TOKEN = 'authorization-matrix';

/**
 * The environment and stand-ins that turn `features` on for createTestApp
 * (the weather against weather-stub.ts, the order mail against
 * jmap-stub.ts, with the harness's owner as ORDER_MAIL_OWNER); `close`
 * stops the stand-ins. authorization-coverage.spec.ts boots with every one.
 */
export async function featureApp(features: ReadonlySet<Feature>): Promise<{
  env: Env;
  options: TestAppOptions;
  close: () => Promise<void>;
}> {
  const [weather, jmap] = await Promise.all([
    features.has('weather') ? startWeatherStub() : undefined,
    features.has('orderMail') ? startJmapStub(ORDER_MAIL_TOKEN) : undefined,
  ]);
  return {
    env: {
      ...(weather ? { WEATHER_ENABLED: 'true' } : {}),
      ...(features.has('pwa') ? PWA_ENV : {}),
      ...(jmap
        ? {
            ORDER_MAIL_JMAP_TOKEN: ORDER_MAIL_TOKEN,
            ORDER_MAIL_SENDERS: 'orders@example.com',
            ORDER_MAIL_OWNER: OWNER_EMAIL,
          }
        : {}),
    },
    options: { weather: weather?.options, orderMail: jmap?.options },
    close: async () => {
      await Promise.all([weather?.close(), jmap?.close()]);
    },
  };
}

/** Every table a wardrobe request could touch. */
const TABLES = [
  'garment',
  'capsule',
  'capsule_garment',
  'garment_wear',
  'garment_repair',
  'file',
  'pending_photo',
  'outfit',
  'outfit_slot',
  'outfit_calendar',
  'selfie',
  'wardrobe_share',
  'personal_access_token',
  'style_profile',
  'week_template',
  'week_plan',
  'week_plan_entry',
  'trip',
  'trip_outfit',
  'trip_item',
  'trip_garment_packed',
  'brand_size',
  'body_measurements',
  // POST /wardrobe marks an order item added (#25).
  'order_item',
  // Muse's needs (#333): a decision settles or sets one aside.
  'option_group',
  // The Style page's outfit rules (#21b).
  'outfit_rule',
  // Saved looks (#22).
  'inspiration',
  'inspiration_piece',
  // An Ideas card's "Clashes" (#193c's matrix case).
  'generator_avoid',
];

/** The page, or the route's /api/v1 twin (Route.api) with a device token. */
type Surface = 'page' | 'api';

/**
 * Columns a credential stamps on every use, which no request writes: a
 * device token's last use (each API twin's case), as a session has none.
 * The snapshots leave them out, so a refused API request changed nothing.
 */
const BOOKKEEPING: Record<string, string[]> = {
  personal_access_token: ['last_used_at'],
};

/** A table's row `r` as jsonb, without its bookkeeping columns. */
const rowOf = (table: string): string => {
  const columns = BOOKKEEPING[table];
  return columns
    ? `to_jsonb(r) - '{${columns.join(',')}}'::text[]`
    : 'to_jsonb(r)';
};

/** The same as text for a digest: the row's own text where nothing is left out. */
const rowText = (table: string): string =>
  table in BOOKKEEPING ? `(${rowOf(table)})::text` : 'r::text';

interface Case {
  title: string;
  route: Route;
  surface: Surface;
  actor: ActorName;
  via: Via;
  outcome: Outcome;
}

/** A grantee's page answered through `?ownerId=`: a share-aware page of the owner's wardrobe. */
const servesGrantee = ({ surface, actor, via, outcome }: Case): boolean =>
  surface === 'page' &&
  via === 'ownerId' &&
  outcome === 'ok' &&
  (actor === 'manager' || actor === 'viewer');

const isHtml = (res: LightMyRequestResponse): boolean =>
  res.statusCode === 200 &&
  String(res.headers['content-type']).startsWith('text/html');

const casesOf = (routes: Route[]): Case[] =>
  routes.flatMap((route) =>
    (route.api ? (['page', 'api'] as const) : (['page'] as const)).flatMap(
      (surface) =>
        route.vias.flatMap((via, i) =>
          (
            ['owner', 'manager', 'viewer', 'stranger', 'anonymous'] as const
          ).map((actor): Case => {
            const expected =
              actor === 'anonymous'
                ? (route.anonymous ?? 'login')
                : route.expect[actor];
            const outcome = Array.isArray(expected) ? expected[i] : expected;
            const where = via === 'ownerId' ? ' ?ownerId=<owner>' : '';
            const twin = surface === 'api' ? ' (api)' : '';
            return {
              title: `${route.name}${twin}${where} as ${actor}: ${outcome}`,
              route,
              surface,
              actor,
              via,
              outcome,
            };
          }),
        ),
    ),
  );

/**
 * What an extra test beside a group's matrix reads, set by the matrix's
 * beforeAll (read it inside a test, never at collection).
 */
/**
 * A signed-in actor's id, email and session; with a device token too when
 * the group has an API twin (Route.api). The anonymous visitor has none.
 */
interface MatrixActor {
  id?: number;
  email?: string;
  cookie?: string;
  token?: string;
}

export interface Matrix {
  t: TestApp;
  actors: Record<ActorName, MatrixActor>;
  /** The fixture the read-only and refused cases share. */
  shared: Fixture;
}

/**
 * One group's routes: authorization-<group>.routes.ts's ROUTES, which its
 * authorization-<group>.spec.ts describes (describeMatrix) and the
 * route-coverage spec (authorization-coverage.spec.ts) holds the app's
 * routes against. A module of its own, never read out of the spec: the
 * integration project shares each worker's module graph across files
 * (vitest.config.mts), and a spec file another file had imported would
 * collect no tests when its own turn came.
 */
export interface MatrixGroup {
  group: string;
  routes: Route[];
}

/**
 * The matrix for one group of routes: five actors, each route by each via,
 * on its own scratch database (one spec file each, so Vitest runs the groups
 * in parallel), and `extras`, the group's own tests over the same app and
 * fixture.
 */
export function describeMatrix(
  group: string,
  routes: Route[],
  extras?: (matrix: Matrix) => void,
): void {
  describe(`authorization matrix: ${group}`, () => {
    let t: TestApp;
    const actors = {} as Record<ActorName, MatrixActor>;
    /** Read-only and refused cases share it; successful writes get their own. */
    let shared: Fixture;
    let photo: Buffer;
    let cutout: Buffer;
    /** The link import's "internet": a shop serving /photo.jpg. */
    let sites: LinkSites;
    /** The stand-ins of the features the group's routes need. */
    let features: Awaited<ReturnType<typeof featureApp>> | undefined;
    /** The app's routes as registered, for ownerLinkChecker. */
    const registered: RouteOptions[] = [];
    let ownerLinks: Awaited<ReturnType<typeof ownerLinkChecker>>;

    const signUp = async (email: string) => {
      const cookie = await t.register(email);
      const id = await userIdOf(t, email);
      return { id, email, cookie };
    };

    /**
     * A new open invite link to the owner's wardrobe; its token. Through
     * the writer: the route asks an edit link for the password and limits
     * it (INVITE_LIMIT, #668; share-lifecycle.spec.ts drives it).
     */
    const createInviteLink = async (permission: 'VIEW' | 'MANAGE') =>
      (await createInvite(t.db, t.owner.id, permission)).inviteToken;

    const share = async (grantee: SignedIn, permission: 'VIEW' | 'MANAGE') => {
      const token = await createInviteLink(permission);
      const accept = await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie: actors[grantee].cookie },
      });
      // Accept lands on the grantor's wardrobe (#661).
      expect(accept.headers.location).toMatch(/^\/wardrobe\?ownerId=\d+$/);
    };

    /** The owner's Muse needs and picks (#333), written through the one writers. */
    const museFixture = async (tag: string) => {
      const ownerId = t.owner.id;
      const cookie = actors.owner.cookie!;
      const need = async (name: string) => {
        const [row] = await t.db
          .insert(optionGroup)
          .values({ ownerId, name, budget: '100' })
          .returning({ id: optionGroup.id });
        return row.id;
      };
      const pick = async (name: string, groupId: number) => {
        const id = await createWishlistItem(t, { name, price: '90', cookie });
        const marked = await markSuggestion(t.db, ownerId, id, {
          tokenId: null,
          groupId,
          note: `Muse on ${name}`,
          rank: null,
        });
        if (marked !== 'marked') throw new Error(`${name}: ${marked}`);
        return id;
      };
      const decided = async (decision: SuggestionDecision) => {
        const outcome = await decide(t.db, ownerId, decision);
        if (!outcome.ok) throw new Error(`${decision.kind}: ${outcome.reason}`);
      };
      const needName = `Need ${tag}`;
      const needId = await need(needName);
      const needPickId = await pick(`Pick ${tag}`, needId);
      const setAsidePickId = await pick(`Aside ${tag}`, needId);
      await decided({
        kind: 'dismiss-pick',
        garmentId: setAsidePickId,
        reason: 'too_pricey',
        note: null,
      });
      const asideNeedId = await need(`Aside need ${tag}`);
      await decided({
        kind: 'dismiss-group',
        groupId: asideNeedId,
        reason: 'not_now',
        note: null,
      });
      const boughtPickId = await pick(
        `Bought ${tag}`,
        await need(`Bought need ${tag}`),
      );
      const bought = await setGarmentStatus(t.db, boughtPickId, ownerId, {
        event: 'buy',
        acquiredOn: null,
        price: null,
      });
      if (!bought.ok) throw new Error(`Bought ${tag}: ${bought.reason}`);
      await decided({ kind: 'bought', garmentId: boughtPickId });
      return {
        needId,
        needName,
        needPickId,
        setAsidePickId,
        asideNeedId,
        boughtPickId,
      };
    };

    const createFixture = async (): Promise<Fixture> => {
      const cookie = actors.owner.cookie!;
      const tag = randomUUID().slice(0, 8);
      const garmentName = `Coat ${tag}`;
      const capsuleName = `Capsule ${tag}`;
      const outfitName = `Look ${tag}`;
      const garmentId = await createGarment(t, {
        name: garmentName,
        cookie,
        price: PRIVATE_PRICE,
        notes: PRIVATE_NOTES,
      });
      await uploadPhoto(t, garmentId, photo, cookie);
      // Its cutout failed (no queue runs here), so "Try again" requeues it.
      await failCutout(t, await photoFileName(t, garmentId));
      const wishlistName = `Wish ${tag}`;
      const brand = `Brand ${tag}`;
      const wishlistId = await createWishlistItem(t, {
        name: wishlistName,
        brand,
        replaces: garmentId,
        cookie,
        price: PRIVATE_PRICE,
      });
      const brandSizeId = await addBrandSize(t.db, t.owner.id, {
        brand,
        size: 'M',
        note: OWNER_SIZE_NOTE,
      });
      if (brandSizeId === 'brand-taken') throw new Error(`${brand} is taken`);
      const outfitRuleId = await addOutfitRule(
        t.db,
        { userId: t.owner.id, surface: 'page' },
        {
          kind: 'never',
          a: { ...NO_MATCHER, garmentId },
          b: { ...NO_MATCHER, color: 'black' },
        },
      );
      if (typeof outfitRuleId !== 'number') {
        throw new Error(`No outfit rule: ${outfitRuleId}`);
      }
      const muse = await museFixture(tag);
      const archivedName = `Old ${tag}`;
      const archivedId = await createGarment(t, { name: archivedName, cookie });
      const archived = await t.inject({
        method: 'POST',
        url: `/wardrobe/${archivedId}/archive`,
        headers: { cookie },
      });
      expect(archived.statusCode).toBe(200);

      const created = await t.inject({
        method: 'POST',
        url: '/capsules',
        payload: { name: capsuleName },
        headers: { cookie },
      });
      const capsuleId = Number(
        /^\/capsules\/(\d+)\?/.exec(created.headers.location as string)?.[1],
      );
      expect(capsuleId).toBeGreaterThan(0);
      const chosen = await t.inject({
        method: 'POST',
        url: `/capsules/${capsuleId}/garments`,
        payload: { ids: [garmentId], shown: [garmentId] },
        headers: { cookie },
      });
      expect(chosen.statusCode).toBe(303);

      const outfit = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: {
          name: outfitName,
          category: 'shirt',
          garmentId: String(garmentId),
        },
        headers: { cookie },
      });
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(outfit.headers.location as string)?.[1],
      );
      expect(outfitId).toBeGreaterThan(0);
      const spare = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: { name: `Spare ${tag}` },
        headers: { cookie },
      });
      const spareOutfitId = Number(
        /^\/outfits\/(\d+)$/.exec(spare.headers.location as string)?.[1],
      );
      expect(spareOutfitId).toBeGreaterThan(0);
      // Muse's outfits (#335): the garment with the wishlist item, then
      // marked as proposed, as the agent's tool will (phase 3).
      const museOutfit = async (
        reaction: 'proposed' | 'declined',
        garments: number[],
      ) => {
        const made = await t.inject({
          method: 'POST',
          url: '/outfits',
          payload: {
            name: `Muse ${reaction} ${tag}`,
            category: garments.map(() => 'shirt'),
            garmentId: garments.map(String),
          },
          headers: { cookie },
        });
        const id = Number(
          /^\/outfits\/(\d+)$/.exec(made.headers.location as string)?.[1],
        );
        expect(id, made.body).toBeGreaterThan(0);
        await asFixture(t.db, (tx) =>
          tx
            .update(outfitTable)
            .set({
              proposedAt: new Date(),
              proposalNote: 'Why this',
              reaction,
              dismissedReason: reaction === 'declined' ? 'style' : null,
            })
            .where(eq(outfitTable.id, id)),
        );
        return id;
      };
      // Garment sets of their own: a save of a set already saved reuses it.
      const museOutfitId = await museOutfit('proposed', [
        garmentId,
        wishlistId,
      ]);
      const museDeclinedId = await museOutfit('declined', [wishlistId]);

      const today = t.today();
      const scheduled = await t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: today, outfitId: String(outfitId) },
        headers: { cookie },
      });
      expect(scheduled.statusCode).toBe(302);
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, outfitId));
      // The owner's mirror photo (#19) of the same outfit yesterday, which
      // marks that entry worn (today's stays unworn for the pages' wear
      // controls and the worn pill).
      const ownSelfie = await takeSelfie(
        t,
        await planEntry(t, outfitId, addDays(today, -1), cookie),
        cookie,
      );

      // A saved look (#22), named through its page's autosave.
      const inspirationTitle = `Inspo ${tag}`;
      const look = await addLook(t, photo, cookie);
      const named = await t.inject({
        method: 'POST',
        url: `/inspiration/${look.id}`,
        payload: { title: inspirationTitle, note: '' },
        headers: { cookie, 'hx-request': 'true' },
      });
      expect(named.statusCode).toBe(200);
      // A white tee of the closet, the piece's match (#22c's save).
      const inspirationTeeId = await createGarment(t, {
        name: `Tee ${tag}`,
        category: 'tops',
        cookie,
      });
      // One piece read in it (#22b), at position 0.
      const tagged = await t.inject({
        method: 'POST',
        url: `/inspiration/${look.id}/pieces`,
        payload: {
          kind: 'top/t-shirt',
          color: 'white',
          accent: '',
          pattern: '',
        },
        headers: { cookie },
      });
      expect(tagged.statusCode).toBe(303);

      await saveStyleProfile(t.db, t.owner.id, {
        ...EMPTY_STYLE_PROFILE,
        notes: OWNER_STYLE_NOTE,
      });

      const tripName = `Trip ${tag}`;
      const newTrip = async (name: string) => {
        const created = await t.inject({
          method: 'POST',
          url: '/trips',
          payload: { name, startsOn: today, endsOn: addDays(today, 1) },
          headers: { cookie },
        });
        const id = Number(
          /^\/trips\/(\d+)\?/.exec(created.headers.location as string)?.[1],
        );
        expect(id).toBeGreaterThan(0);
        return id;
      };
      const tripId = await newTrip(tripName);
      const otherTripId = await newTrip(`Other ${tag}`);
      for (const [url, payload] of [
        [
          `/trips/${tripId}/outfits`,
          { outfitId: String(outfitId), day: today },
        ],
        [`/trips/${tripId}/items`, { label: 'Charger' }],
        [`/trips/${tripId}/packed`, { packed: String(garmentId) }],
        [`/trips/${otherTripId}/items`, { label: 'Passport' }],
      ] as const) {
        const res = await t.inject({
          method: 'POST',
          url,
          payload,
          headers: { cookie },
        });
        expect(res.statusCode, url).toBe(303);
      }
      const [{ id: tripOutfitId }] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, tripId));
      const [{ id: tripItemId }] = await t.db
        .select({ id: tripItem.id })
        .from(tripItem)
        .where(eq(tripItem.tripId, tripId));
      const repairId = await addRepair(t.db, t.owner.id, garmentId, {
        day: today,
        kind: 'repair',
        note: `Mended ${tag}`,
        cost: '12.00',
      });
      if (repairId === undefined) throw new Error('No repair logged');

      const orderItemName = `Ordered ${tag}`;
      const listed = await recordOrderEmail(
        t.db,
        {
          accountId: 'authorization-matrix',
          emailId: `order-${tag}`,
          receivedAt: new Date(),
          outcome: 'imported',
        },
        t.owner.id,
        today,
        [
          {
            productUrl: sites.url(`/products/${tag}`),
            name: orderItemName,
            brand: null,
            price: '30.00',
            currency: 'USD',
          },
        ],
      );
      expect(listed).toBe(1);
      const [{ id: orderItemId }] = await t.db
        .select({ id: orderItem.id })
        .from(orderItem)
        .where(eq(orderItem.name, orderItemName));
      const [{ id: weekPlanId }] = await asFixture(t.db, (tx) =>
        tx
          .insert(weekPlan)
          .values({ ownerId: t.owner.id })
          .returning({ id: weekPlan.id }),
      );
      const inviteToken = await createInviteLink('VIEW');
      const garmentShare = await setPublicShare(
        t.db,
        'garment',
        garmentId,
        t.owner.id,
        true,
      );
      const outfitShare = await setPublicShare(
        t.db,
        'outfit',
        outfitId,
        t.owner.id,
        true,
      );
      const [{ id: inviteShareId }] = await t.db
        .select({ id: wardrobeShare.id })
        .from(wardrobeShare)
        .where(eq(wardrobeShare.inviteToken, inviteToken));
      return {
        garmentId,
        garmentName,
        wishlistId,
        wishlistName,
        ...muse,
        archivedId,
        archivedName,
        capsuleId,
        capsuleName,
        outfitId,
        outfitName,
        garmentShareId: garmentShare!.shareableId,
        outfitShareId: outfitShare!.shareableId,
        spareOutfitId,
        museOutfitId,
        museDeclinedId,
        entryId: entry.id,
        selfieId: ownSelfie.id,
        selfieFileName: ownSelfie.fileName,
        inspirationId: look.id,
        inspirationTitle,
        inspirationFileName: look.fileName,
        inspirationTeeId,
        today,
        ownerId: t.owner.id,
        tripId,
        tripName,
        tripOutfitId,
        tripItemId,
        otherTripId,
        brand,
        brandSizeId,
        outfitRuleId,
        repairId,
        orderItemId,
        orderItemName,
        weekPlanId,
        inviteShareId,
        inviteToken,
        photo,
        cutout,
        shopPhotoUrl: sites.url('/photo.jpg'),
        ownerToken: async (kind = 'mcp') => {
          const token = await mintToken(
            t,
            t.owner.id,
            kind === 'mcp' ? OWNER_TOKEN_NAME : OWNER_DEVICE_NAME,
            kind,
          );
          if (!token.created)
            throw new Error('The owner holds too many tokens');
          return token.id;
        },
      };
    };

    const results = {} as Matrix;

    /**
     * What a request could have changed, in one statement: an md5 per table
     * over its rows as text, sorted (equal digests are equal rows), and the
     * photo files on disk. Refused and read-only cases compare digests alone;
     * only a difference fetches rows, to name what changed (changedRows).
     * Selecting every row of 25 tables twice per case was over a third of the
     * matrix's time (#113).
     */
    const snapshot = async (): Promise<Record<string, string>> => {
      const { rows } = await t.db.execute<{ name: string; digest: string }>(
        sql.raw(
          TABLES.map(
            (table) =>
              `select '${table}' as name, md5(coalesce(string_agg(${rowText(table)}, E'\\n' order by ${rowText(table)}), '')) as digest from "${table}" r`,
          ).join(' union all '),
        ),
      );
      const stored = (await readdir(t.dataPath))
        .filter((name) => name.endsWith('.webp'))
        .sort();
      return {
        ...Object.fromEntries(rows.map((row) => [row.name, row.digest])),
        stored: stored.join(' '),
      };
    };

    const changedTables = (
      before: Record<string, string>,
      after: Record<string, string>,
    ): string[] =>
      Object.keys(after).filter((key) => after[key] !== before[key]);

    /** The rows now in each changed table: a failure's explanation. */
    const changedRows = async (changed: string[]): Promise<string[]> => {
      const lines = await Promise.all(
        changed.map(async (table) => {
          if (table === 'stored') return ['stored photo files changed'];
          const result = await t.db.execute<{ row: unknown }>(
            sql.raw(`select ${rowOf(table)} as row from "${table}" r`),
          );
          return [
            `${table} changed; now:`,
            ...result.rows.map(({ row }) => `  ${JSON.stringify(row)}`),
          ];
        }),
      );
      return lines.flat();
    };

    /**
     * Every row a wardrobe request could touch plus the photo files, one
     * sorted string per row: a clone's success is judged row by row (rows
     * added, none modified).
     */
    const allRows = async (): Promise<string[]> => {
      const rows = await Promise.all(
        TABLES.map(async (table) => {
          const result = await t.db.execute<{ row: unknown }>(
            sql.raw(`select ${rowOf(table)} as row from "${table}" r`),
          );
          return result.rows.map(
            ({ row }) => `${table} ${JSON.stringify(row)}`,
          );
        }),
      );
      const stored = (await readdir(t.dataPath))
        .filter((name) => name.endsWith('.webp'))
        .map((name) => `stored ${name}`);
      return [...rows.flat(), ...stored].sort();
    };

    /** A page request with the actor's session, or a twin's with their device token. */
    const send = (
      surface: Surface,
      actor: ActorName,
      request: InjectOptions,
    ): Promise<LightMyRequestResponse> => {
      const { cookie, token } = actors[actor];
      // Each tokenless twin request comes from an address of its own: the
      // matrix proves the 401, and from one address a group's replays would
      // spend BEARER_REFUSAL_LIMIT and meet its 429 (bearer-gate.spec.ts).
      if (surface === 'api') {
        return t.api(
          token,
          token
            ? request
            : {
                ...request,
                headers: { ...uniqueClient(), ...request.headers },
              },
        );
      }
      return t.inject({
        ...request,
        headers: { ...request.headers, ...(cookie ? { cookie } : {}) },
        anonymous: actor === 'anonymous',
      });
    };

    const REFUSED_STATUS: Record<Exclude<Outcome, 'ok' | 'ignored'>, number> = {
      hidden: 200,
      forbidden: 403,
      notFound: 404,
      login: 302,
      unauthorized: 401,
    };

    /**
     * Whether the API twin takes `?ownerId=` (the committed spec's declared
     * parameters). The API's querystring is closed (#577): on an owner-only
     * route (trips, outfits) the page's "ownerId ignored" is a 400 there.
     */
    const apiTakesOwnerId = (request: InjectOptions): boolean => {
      const path = (request.url as string).split('?')[0];
      // The most literal template wins, as the router's: /garments/washes
      // beats /garments/{id}.
      const [, operations] = Object.entries(committedSpec.paths)
        .filter(([template]) =>
          new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path),
        )
        .sort(([a], [b]) => a.split('{').length - b.split('{').length)[0];
      const operation = (
        operations as Record<
          string,
          { parameters?: { name: string; in: string }[] }
        >
      )[String(request.method).toLowerCase()];
      return (operation.parameters ?? []).some(
        (parameter) => parameter.in === 'query' && parameter.name === 'ownerId',
      );
    };

    const expectOwnerIdRefused = async (
      actor: ActorName,
      request: InjectOptions,
      secret: string,
    ) => {
      const before = await snapshot();
      const res = await send('api', actor, request);
      expect(res.statusCode).toBe(actor === 'anonymous' ? 401 : 400);
      expect(res.body).not.toContain(secret);
      // Refused before the handler: nobody's rows change, the owner's least.
      expect(
        await changedRows(changedTables(before, await snapshot())),
      ).toEqual([]);
    };

    /** The case's request and success status on its surface. */
    const onSurface = async (
      { route, surface }: Pick<Case, 'route' | 'surface'>,
      fixture: Fixture,
      ownerQuery: string,
    ): Promise<{ ok: number; request: InjectOptions }> => {
      const twin = surface === 'api' ? route.api! : route;
      return { ok: twin.ok, request: await twin.request(fixture, ownerQuery) };
    };

    /** A VIEW grantee's answer, a success or a refusal, holds no price and no notes (#680). */
    const expectNothingPrivate = (
      actor: ActorName,
      res: LightMyRequestResponse,
    ) => {
      if (actor !== 'viewer') return;
      expect(res.body).not.toContain(PRIVATE_PRICE);
      expect(res.body).not.toContain(PRIVATE_NOTES);
    };

    /**
     * The answer: a success's status (a page read that shows its subject
     * names it), or a refusal's, leaking nothing. On the API a signed-out
     * request is the 401 every refused token gets, never the login redirect.
     */
    const expectAnswer = (
      { route, surface, outcome, actor }: Case,
      ok: number,
      res: LightMyRequestResponse,
      secret: string,
    ) => {
      expectNothingPrivate(actor, res);
      if (outcome === 'ok') {
        expect(res.statusCode).toBe(ok);
        if (surface === 'page' && route.kind === 'read' && route.shows) {
          expect(res.body).toContain(secret);
        }
        return;
      }
      if (outcome === 'ignored') expect(res.statusCode).toBe(ok);
      else if (surface === 'api' && outcome === 'login') {
        expect(res.statusCode).toBe(401);
      } else expect(res.statusCode).toBe(REFUSED_STATUS[outcome]);
      if (surface === 'page' && outcome === 'login') {
        // A GET returns there after sign-in (?returnTo=, #661; auth.spec.ts).
        expect(res.headers.location?.split('?')[0]).toBe(LOGIN_PATH);
      }
      expect(res.body).not.toContain(secret);
    };

    /**
     * A grantee's share-aware page never sends ownerId to a route that is
     * not share-aware, which would answer them a 404 (#680, owner-links.ts).
     */
    const expectOwnerLinksShareAware = async (
      matrixCase: Case,
      res: LightMyRequestResponse,
      request: InjectOptions,
    ) => {
      if (!servesGrantee(matrixCase) || !isHtml(res)) return;
      expect(await ownerLinks.offenders(res.body, request.url)).toEqual([]);
    };

    /**
     * A clone lands in the requester's wardrobe and only adds rows: the page
     * redirects to the new garment, the twin answers it with its `id`.
     */
    const expectCloned = async (
      { surface, actor }: Case,
      ok: number,
      request: InjectOptions,
    ) => {
      const before = await allRows();
      const res = await send(surface, actor, request);
      const after = await allRows();
      expect(res.statusCode).toBe(ok);
      const cloneId =
        surface === 'api'
          ? res.json<{ id: number }>().id
          : Number(
              /^\/wardrobe\/(\d+)$/.exec(res.headers.location as string)?.[1],
            );
      const clone = await garmentRow(t, cloneId);
      expect(clone?.ownerId).toBe(actors[actor].id);
      // Added rows only: nothing that existed (the source) was modified.
      expect(after).toEqual(expect.arrayContaining(before));
    };

    beforeAll(async () => {
      sites = await startLinkSites();
      features = await featureApp(
        new Set(routes.flatMap(({ feature }) => feature ?? [])),
      );
      t = await createTestApp(features.env, {
        ...features.options,
        outboundFetch: sites.outboundFetch,
        // Each case's fixture uploads its photos and selfies as the owner:
        // hundreds a minute, past PHOTO_UPLOAD_LIMIT (photo-upload-limit.spec.ts).
        photoUploadMax: Number.MAX_SAFE_INTEGER,
        onRoute: (route) => registered.push(route),
      });
      ownerLinks = await ownerLinkChecker(registered);
      [photo, cutout] = await Promise.all([
        jpegPhoto(320, 240),
        pngCutout(320, 240),
      ]);
      sites.serve('/photo.jpg', jpeg(photo));
      actors.owner = t.owner;
      actors.manager = await signUp('manager@example.com');
      actors.viewer = await signUp('viewer@example.com');
      actors.stranger = await signUp('stranger@example.com');
      actors.anonymous = {};
      await share('manager', 'MANAGE');
      await share('viewer', 'VIEW');
      // Each signed-in actor's device, for the API twins' cases only: a
      // sign-in costs a bcrypt comparison.
      if (routes.some(({ api }) => api)) {
        for (const actor of [
          'owner',
          'manager',
          'viewer',
          'stranger',
        ] as const) {
          const { email } = actors[actor];
          actors[actor].token = (await deviceToken(t, { email })).token;
        }
      }
      shared = await createFixture();
      // What the viewer's answers are held to never contain is stored.
      expect(await garmentRow(t, shared.garmentId)).toMatchObject({
        price: PRIVATE_PRICE,
        notes: PRIVATE_NOTES,
      });
      Object.assign(results, { t, actors, shared });
    });

    afterAll(async () => {
      await t?.cleanup();
      await sites?.close();
      await features?.close();
      await ownerLinks?.close();
    });

    it.each(casesOf(routes))('$title', async (matrixCase) => {
      const { route, surface, actor, via, outcome } = matrixCase;
      const mutates = outcome === 'ok' && route.kind === 'write';
      const fixture = mutates ? await createFixture() : shared;
      const secret = route.secret(fixture);
      const ownerQuery = via === 'ownerId' ? `?ownerId=${actors.owner.id}` : '';
      const { ok, request } = await onSurface(matrixCase, fixture, ownerQuery);

      if (outcome === 'ok' && route.kind === 'clone') {
        await expectCloned(matrixCase, ok, request);
        return;
      }

      if (surface === 'api' && via === 'ownerId' && !apiTakesOwnerId(request)) {
        await expectOwnerIdRefused(actor, request, secret);
        return;
      }

      const before = await snapshot();
      const res = await send(surface, actor, request);
      const changed = changedTables(before, await snapshot());

      expectAnswer(matrixCase, ok, res, secret);
      await expectOwnerLinksShareAware(matrixCase, res, request);
      // A successful write changed something; nothing else changes a row.
      if (mutates) {
        expect(changed).not.toEqual([]);
        return;
      }
      expect(await changedRows(changed)).toEqual([]);
    });

    extras?.(results);
  });
}
