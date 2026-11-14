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

/** Whether a JSON schema (TypeBox: objects, unions, intersections) has `ownerId`. */
function takesOwnerId(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const { properties, anyOf, allOf, oneOf } = schema as {
    properties?: Record<string, unknown>;
    anyOf?: unknown[];
    allOf?: unknown[];
    oneOf?: unknown[];
  };
  if (properties && 'ownerId' in properties) return true;
  return [...(anyOf ?? []), ...(allOf ?? []), ...(oneOf ?? [])].some(
    takesOwnerId,
  );
}

/**
 * Whether a schema carries a RowId at any depth: a property, an array's
 * items, a union's member. The ownerId of a querystring is one too, which
 * its own rule already requires.
 */
export function carriesResourceId(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  if (RESOURCE_ID in schema) return true;
  const { properties, items, anyOf, allOf, oneOf } = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    allOf?: unknown[];
    oneOf?: unknown[];
  };
  return [
    ...Object.values(properties ?? {}),
    items,
    ...(anyOf ?? []),
    ...(allOf ?? []),
    ...(oneOf ?? []),
  ].some(carriesResourceId);
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
