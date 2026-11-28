import { Type } from '@sinclair/typebox';
import type { FastifyInstance, HTTPMethods, RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADDRESS,
  bootEveryFeature,
  type EveryFeatureApp,
  loadMatrixGroups,
  type RouteKey,
  templateRouter,
} from './app-routes';
import { RESOURCE_ID, RowId } from '../../src/web/schemas';
import { takesOwnerId } from '../../src/web/sharing/share-aware';
import { isStaticPath } from '../../src/static-prefixes';
import { deviceToken } from './api';
import { ownerLinkChecker } from './owner-links';
import { recordQueries, userIdOf } from './harness';
import type { MatrixGroup, Via } from './authorization-matrix';

/**
 * Every route that takes an id is in the authorization matrix (#182): a
 * route whose path has a parameter (`:id`, `:itemId`, a wildcard), or whose
 * querystring or body schema takes `ownerId` (the share-aware wardrobe
 * routes, which address someone's wardrobe without a path parameter), or
 * whose body or querystring carries a RowId anywhere (`garmentIds`,
 * `outfitId`: the schema's RESOURCE_ID mark, src/web/schemas.ts), is
 * requested by some matrix case, or is on EXEMPT with the reason it needs
 * none. A route whose querystring takes `ownerId` is requested with it (the
 * `ownerId` via). So a new id route fails CI until it joins its group's
 * authorization-<group>.spec.ts or EXEMPT.
 *
 * The app's routes are app-routes.ts's inventory (every feature on). The
 * matrix's routes are its cases' requests (each group's
 * authorization-<group>.routes.ts), each resolved to the route template it
 * reaches by Fastify's own router: a mirror app with the same templates,
 * each answering its own name.
 */

/**
 * Id routes the matrix does not request, each with why it needs no case:
 * public by design (static files, a capability URL whose token is the
 * credential), or covered by a named test elsewhere. Keyed
 * `METHOD /template`.
 */
const EXEMPT: Record<RouteKey, string> = {
  'GET /*':
    'public by design: public/ (scripts, styles, icons), static files that belong to nobody',
  'GET /.well-known/*': 'public by design: well-known static files',
  'GET /wardrobe-share/invite/:token':
    'public by design: the invite landing page, a capability URL whose token is the credential; covered by share-lifecycle.spec.ts "the public invite page never shows the inviter email"',
  'POST /wardrobe-share/invite/:token/accept':
    'a capability URL: the token is the credential, not an id of the wardrobe; covered by share-lifecycle.spec.ts "accept edge cases" (twice, taken, own, addressed to someone else, anonymous)',
  'POST /wardrobe-share/invite/:token/decline':
    'a capability URL: the token is the credential, not an id of the wardrobe; covered by share-lifecycle.spec.ts "decline" (by a recipient, the grantor, the addressee, someone else, anonymous)',
  'GET /wardrobe/plans/*':
    'a redirect to the Wishlist inbox that reads nothing (#337, plans removed); covered by plans-removed.spec.ts',
  'GET /wardrobe/:id/plan-items':
    "a redirect to the garment's page that reads nothing (#337, plans removed): the page then authorizes; covered by plans-removed.spec.ts",
  'POST /outfits/ideas/feedback':
    'weather only, and its `capsule` and `with` are echoed into the redirect to the gallery, never read: the gallery then authorizes them, as the matrix\'s "GET /outfits/ideas/more?capsule=" shows; the write is the requester\'s own temperature offset (nudgeTemperatureOffset); covered by gallery.spec.ts',
  'POST /outfits/ideas/allow':
    'the undo of avoid: it deletes the pair where owner_id is the requester (allowPair, an Actor) and answers 404 when none exists, which the shared fixture must not have (it would change what every ideas read draws); covered by api-ideas.spec.ts "avoids a pair once and allows it again; only between your own garments" (same function; a stranger\'s DELETE is a 404)',
  'GET /api/v1/garments/:id/goes-with':
    '"Goes with my closet" (#194b) has no page route of its own (the wishlist item\'s page draws it for the owner alone, so no page case answers what the API\'s does): covered by authorization-wardrobe.spec.ts "GET /api/v1/garments/:id/goes-with is the owner\'s alone"',
  'DELETE /api/v1/garments/:id/wears/:day':
    'the undo of PUT …/wears/:day (#193a), whose matrix case needs a wear to undo, which the shared fixture must not have (insights lists its garment unworn); covered by authorization-wardrobe.spec.ts "DELETE /api/v1/garments/:id/wears/:day refuses as its PUT does"',
  'PUT /api/v1/looks/:id/pieces':
    "MCP's set_inspiration_pieces as a route (#193d): no page route sets a look's whole list (the page adds, saves and removes one piece at a time, whose twins the matrix replays); covered by api-inspiration.spec.ts \"sets the whole list as MCP does; another's look is a 404\"",
  'DELETE /api/v1/garments/:id/clashes/:otherId':
    'the undo of PUT …/clashes/:otherId (#193c), whose matrix case needs an avoided pair, which the shared fixture must not have (it would change what every ideas read draws); covered by api-ideas.spec.ts "avoids a pair once and allows it again; only between your own garments"',
};

interface AppRoute {
  key: RouteKey;
  /**
   * The path has a parameter or a wildcard, or the body names a wardrobe
   * (`ownerId`), or the body or querystring carries a RowId.
   */
  takesId: boolean;
  /** Its querystring takes `?ownerId=`: the matrix must send it. */
  ownerQuery: boolean;
}

/** A schema's direct subschemas: properties, items (or a tuple's), unions, patterns. */
function subschemas(schema: object): unknown[] {
  const { properties, items, anyOf, allOf, oneOf, patternProperties } =
    schema as {
      properties?: Record<string, unknown>;
      items?: unknown;
      anyOf?: unknown[];
      allOf?: unknown[];
      oneOf?: unknown[];
      patternProperties?: Record<string, unknown>;
    };
  return [
    ...Object.values(properties ?? {}),
    ...Object.values(patternProperties ?? {}),
    ...[items].flat(),
    ...(anyOf ?? []),
    ...(allOf ?? []),
    ...(oneOf ?? []),
  ];
}

/**
 * Whether a schema carries a RowId at any depth: a property, an array's
 * items, a union's member. The ownerId of a querystring is one too, which
 * its own rule already requires.
 */
export function carriesResourceId(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  return RESOURCE_ID in schema || subschemas(schema).some(carriesResourceId);
}

// `ownerId` is the wardrobe address, which its own rule (takesOwnerId) guards.
const ID_NAME = /^(?!ownerId$)(id|.*Ids?)$/;

/**
 * Properties named like an id (`garmentId`, `ids`) that are integers or
 * arrays of them but not RowId: the guard cannot see them, so a request id
 * must be a RowId.
 */
export function untaggedIdProperties(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const { properties } = schema as { properties?: Record<string, unknown> };
  const own = Object.entries(properties ?? {}).flatMap(([name, property]) => {
    const { type, items } = property as { type?: string; items?: unknown };
    const integer =
      type === 'integer' || (type === 'array' && isInteger(items));
    return ID_NAME.test(name) && integer && !carriesResourceId(property)
      ? [name]
      : [];
  });
  return [...own, ...subschemas(schema).flatMap(untaggedIdProperties)];
}

function isInteger(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    (schema as { type?: string }).type === 'integer' &&
    !(RESOURCE_ID in schema)
  );
}

function appRoutes(registered: RouteOptions[]): AppRoute[] {
  const routes = registered.flatMap((route) =>
    [route.method].flat().map((method: HTTPMethods) => ({
      method,
      url: route.url,
      ownerQuery: takesOwnerId(route.schema?.querystring),
      ownerBody: takesOwnerId(route.schema?.body),
      resourceIds:
        carriesResourceId(route.schema?.body) ||
        carriesResourceId(route.schema?.querystring),
    })),
  );
  const gets = new Set(
    routes.filter(({ method }) => method === 'GET').map(({ url }) => url),
  );
  return (
    routes
      // Fastify's HEAD beside every GET (exposeHeadRoutes) runs the GET's
      // handler: the GET's cases cover it.
      .filter(({ method, url }) => method !== 'HEAD' || !gets.has(url))
      .map(({ method, url, ownerQuery, ownerBody, resourceIds }) => ({
        key: `${method} ${url}`,
        takesId: /[:*]/.test(url) || ownerQuery || ownerBody || resourceIds,
        ownerQuery,
      }))
  );
}

/**
 * Each template a matrix case requests, and by which vias: a page route's,
 * and its /api/v1 twin's (Route.api), on which every case replays.
 */
async function matrixCoverage(
  groups: MatrixGroup[],
  router: FastifyInstance,
): Promise<{ covered: Map<RouteKey, Set<Via>>; unresolved: string[] }> {
  const covered = new Map<RouteKey, Set<Via>>();
  const unresolved: string[] = [];
  const cases = groups.flatMap(({ group, routes }) =>
    routes.flatMap(({ name, vias, request, api }) =>
      [
        { name, request },
        ...(api ? [{ name: `${name} (api)`, request: api.request }] : []),
      ].flatMap((sent) => vias.map((via) => ({ group, ...sent, via }))),
    ),
  );
  for (const { group, name, request, via } of cases) {
    const query = via === 'ownerId' ? `?ownerId=${ADDRESS.ownerId}` : '';
    const { method, url } = await request(ADDRESS, query);
    const res = await router.inject({ method, url });
    if (res.statusCode !== 200) {
      unresolved.push(`${group}: ${name} (${via}) reaches no route`);
      continue;
    }
    covered.set(res.body, (covered.get(res.body) ?? new Set()).add(via));
  }
  return { covered, unresolved };
}

/** Exemptions that no longer hold: stale, needless or now in the matrix. */
function exemptionProblems(
  routes: AppRoute[],
  covered: Map<RouteKey, Set<Via>>,
  exempt: Record<RouteKey, string>,
): string[] {
  const byKey = new Map(routes.map((route) => [route.key, route]));
  return Object.keys(exempt).flatMap((key) => {
    const route = byKey.get(key);
    if (!route) return [`${key}: exempt, but no such route`];
    if (covered.has(key)) return [`${key}: exempt, but the matrix requests it`];
    if (!route.takesId) return [`${key}: exempt, but it takes no id`];
    return [];
  });
}

/** What fails the spec: each line one route. */
function coverageProblems(
  routes: AppRoute[],
  covered: Map<RouteKey, Set<Via>>,
  exempt: Record<RouteKey, string>,
): string[] {
  const missing = routes.flatMap(({ key, takesId, ownerQuery }) => {
    if (key in exempt) return [];
    const vias = covered.get(key);
    if (takesId && !vias) {
      return [`${key}: takes an id, but no matrix case requests it`];
    }
    if (ownerQuery && !vias?.has('ownerId')) {
      return [`${key}: takes ?ownerId=, but no case sends it`];
    }
    return [];
  });
  return [...missing, ...exemptionProblems(routes, covered, exempt)];
}

describe('authorization matrix coverage', () => {
  let app: EveryFeatureApp;
  let routes: AppRoute[];
  let router: FastifyInstance;
  /** The <group> of every authorization-<group>.spec.ts. */
  let specGroups: string[];
  let groups: MatrixGroup[];

  beforeAll(async () => {
    app = await bootEveryFeature();
    routes = appRoutes(app.registered);
    router = await templateRouter(routes.map(({ key }) => key));
    ({ specGroups, groups } = await loadMatrixGroups());
  });

  afterAll(async () => {
    await router?.close();
    await app?.close();
  });

  it('loads the routes of every authorization-<group>.spec.ts', () => {
    expect(specGroups.length).toBeGreaterThan(0);
    expect(groups.map(({ group }) => group).sort()).toEqual(
      [...specGroups].sort(),
    );
  });

  it('resolves every matrix case to a route of the app', async () => {
    const { unresolved } = await matrixCoverage(groups, router);
    expect(unresolved).toEqual([]);
  });

  it('requests every id route, or exempts it with a reason', async () => {
    const { covered } = await matrixCoverage(groups, router);
    expect(coverageProblems(routes, covered, EXEMPT)).toEqual([]);
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim(), key).not.toBe('');
    }
  });

  it('fails on a new id route nobody listed', async () => {
    const { covered } = await matrixCoverage(groups, router);
    const added: AppRoute = {
      key: 'GET /wardrobe/:id/unlisted',
      takesId: true,
      ownerQuery: false,
    };
    expect(coverageProblems([...routes, added], covered, EXEMPT)).toEqual([
      'GET /wardrobe/:id/unlisted: takes an id, but no matrix case requests it',
    ]);
  });

  it('has no request id that is a bare integer instead of a RowId', () => {
    const bare = app.registered.flatMap((route) =>
      ['body', 'querystring'].flatMap((part) =>
        untaggedIdProperties(
          (route.schema as Record<string, unknown> | undefined)?.[part],
        ).map(
          (name) =>
            `${[route.method].flat().join('|')} ${route.url}: ${part}.${name}`,
        ),
      ),
    );
    expect(bare).toEqual([]);
  });

  it('sees a RowId in a body, however nested', () => {
    expect(carriesResourceId(Type.Object({ outfitId: RowId }))).toBe(true);
    expect(
      carriesResourceId(Type.Object({ garmentIds: Type.Array(RowId) })),
    ).toBe(true);
    expect(
      carriesResourceId(
        Type.Union([Type.Object({ a: Type.Optional(RowId) }), Type.Null()]),
      ),
    ).toBe(true);
    expect(
      carriesResourceId(
        Type.Object({ note: Type.String(), n: Type.Integer() }),
      ),
    ).toBe(false);
  });

  it('fails on a body-id route nobody listed', async () => {
    const { covered } = await matrixCoverage(groups, router);
    const [added] = appRoutes([
      {
        method: 'POST',
        url: '/unlisted',
        schema: { body: Type.Object({ garmentIds: Type.Array(RowId) }) },
      } as RouteOptions,
    ]);
    expect(coverageProblems([...routes, added], covered, EXEMPT)).toEqual([
      'POST /unlisted: takes an id, but no matrix case requests it',
    ]);
  });
});

const PROBED = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Probed = (typeof PROBED)[number];

/**
 * Routes the probe leaves out: share-aware ones (they take ?ownerId=),
 * public ones (nobody's wardrobe), the bearer surfaces (their own rules),
 * static paths (no session) and wildcards (the static files).
 */
function unprobed(route: RouteOptions): boolean {
  const { shareAware, public: isPublic, surface } = route.config ?? {};
  if (shareAware || isPublic || surface !== undefined) return true;
  return route.url.includes('*') || isStaticPath(route.url);
}

/**
 * A request for every page route that is not share-aware (no OwnerQuery):
 * each parameter filled with 1, so it reaches the route whatever its ids
 * name.
 */
function ownerOnlyProbes(registered: RouteOptions[]) {
  return registered.flatMap((route) =>
    unprobed(route)
      ? []
      : [route.method]
          .flat()
          // HEAD runs its GET's hooks; the app routes no other method.
          .filter((method): method is Probed =>
            (PROBED as readonly string[]).includes(method),
          )
          .map((method) => ({
            method,
            url: route.url.replace(/:\w+(\([^)]*\))?/g, '1'),
          })),
  );
}

// #680: an owner-only page given another user's ?ownerId= used to ignore it
// and show the requester's own data under the other's address.
describe('?ownerId= on an owner-only route', () => {
  let app: EveryFeatureApp;
  let otherId: number;

  beforeAll(async () => {
    app = await bootEveryFeature();
    await app.t.register('foreign-owner@example.com');
    otherId = await userIdOf(app.t, 'foreign-owner@example.com');
  });

  afterAll(async () => {
    await app?.close();
  });

  // The onRoute hook is the root's, so it stamps the routes every plugin
  // registers after it; the querystring schema is the one declaration.
  it('marks every route, share-aware exactly when its querystring takes ownerId', () => {
    const wrong = app.registered.flatMap((route) =>
      route.config?.shareAware === takesOwnerId(route.schema?.querystring)
        ? []
        : [`${[route.method].flat().join('|')} ${route.url}`],
    );
    expect(wrong).toEqual([]);
    expect(
      app.registered.filter((route) => route.config?.shareAware).length,
    ).toBeGreaterThan(20);
  });

  it('is a 404 on every page route without OwnerQuery, reading nothing but the session', async () => {
    const probes = ownerOnlyProbes(app.registered);
    expect(probes.length).toBeGreaterThan(100);
    const problems: string[] = [];
    for (const { method, url } of probes) {
      let status = 0;
      const record = await recordQueries(async () => {
        status = (
          await app.t.inject({ method, url: `${url}?ownerId=${otherId}` })
        ).statusCode;
      });
      // The session's one statement, with no share read ahead.
      const reads = record.sql.filter((text) => !/wardrobe_share/.test(text));
      if (status !== 404 || record.statements !== 1 || reads.length !== 1) {
        problems.push(
          `${method} ${url}: ${status}, ${record.statements} statements`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  // The matrix runs ownerLinkChecker over every grantee page it opens;
  // this holds the checker to what each kind of request sends.
  it('finds a page request that sends ownerId to an owner-only route', async () => {
    const links = await ownerLinkChecker(app.registered);
    const page = [
      '<a href="/outfits?ownerId=7">outfits</a>',
      '<a href="/wardrobe?ownerId=7">shared, fine</a>',
      '<form method="get" action="/calendar"><input type="hidden" name="ownerId" value="7"></form>',
      '<form method="post" action="/styling"><input type="hidden" name="ownerId" value="7"></form>',
      '<input type="hidden" id="owner-field" name="ownerId" value="7">',
      '<div hx-get="/auth/profile/sizes/hint" hx-include="#owner-field"></div>',
      '<div data-load="/trips?ownerId=7"></div>',
    ].join('');
    try {
      expect(await links.offenders(page, '/wardrobe?ownerId=7')).toEqual([
        expect.stringMatching(/^GET \/outfits\?ownerId=7: <a /),
        expect.stringMatching(/^GET \/calendar: <form /),
        expect.stringMatching(/^GET \/auth\/profile\/sizes\/hint: <div /),
        expect.stringMatching(/^script \/trips\?ownerId=7: <div /),
      ]);
    } finally {
      await links.close();
    }
  });

  it("lets the owner's own id and an empty one through", async () => {
    for (const query of [`?ownerId=${app.t.owner.id}`, '?ownerId=']) {
      const res = await app.t.inject({ url: `/outfits${query}` });
      expect(res.statusCode, query).toBe(200);
    }
  });

  // The bearer surfaces have their own rules: the API's closed query is a
  // 400, /mcp takes no query string and answers its own 401 without a token.
  it('leaves the API and MCP to their own surfaces', async () => {
    const { token } = await deviceToken(app.t);
    const api = await app.t.api(token, {
      method: 'GET',
      url: `/api/v1/outfits?ownerId=${otherId}`,
    });
    expect(api.statusCode).toBe(400);
    const mcp = await app.t.inject({
      method: 'POST',
      url: `/mcp?ownerId=${otherId}`,
      anonymous: true,
    });
    expect(mcp.statusCode).toBe(401);
  });
});
