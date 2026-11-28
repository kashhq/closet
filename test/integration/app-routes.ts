import Fastify, { type HTTPMethods, type RouteOptions } from 'fastify';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startSentryStub } from '../support/sentry-stub';
import {
  featureApp,
  type Fixture,
  type MatrixGroup,
  type Route,
} from './authorization-matrix';
import { createTestApp, PWA_ENV, type TestApp } from './harness';

/**
 * The app's routes as the inventory specs see them: authorization-coverage
 * (every id route is in the matrix, #182) and api-parity (every page write
 * route is classified, #191). The routes are what the app's Fastify
 * instance registered, seen by createApp's onRoute option (the routes
 * register inside createApp, before a spec could add a hook), on an app
 * with every optional feature on, so a route behind a flag counts too.
 */

/** `METHOD /template`: the key the inventories and their reports use. */
export type RouteKey = string;

export interface EveryFeatureApp {
  t: TestApp;
  /** Every route as it registered, HEAD twins included. */
  registered: RouteOptions[];
  close: () => Promise<void>;
}

export async function bootEveryFeature(): Promise<EveryFeatureApp> {
  const [features, sentry] = await Promise.all([
    featureApp(new Set(['weather', 'orderMail'])),
    startSentryStub(),
  ]);
  const registered: RouteOptions[] = [];
  const t = await createTestApp(
    {
      ...features.env,
      ...PWA_ENV,
      METRICS_ENABLED: 'true',
      SENTRY_DSN: sentry.dsn,
    },
    { ...features.options, onRoute: (route) => registered.push(route) },
  );
  return {
    t,
    registered,
    close: async () => {
      await t.cleanup();
      await Promise.all([features.close(), sentry.close()]);
    },
  };
}

/** One key per method of each registered route. */
export function routeKeysOf(route: RouteOptions): RouteKey[] {
  return [route.method].flat().map((method) => `${method} ${route.url}`);
}

/**
 * Fastify's router over the app's templates: each answers its own key, so a
 * concrete request resolves to the template the app would run.
 */
export async function templateRouter(keys: RouteKey[]) {
  const mirror = Fastify({ exposeHeadRoutes: false });
  for (const key of keys) {
    const [method, url] = key.split(' ') as [HTTPMethods, string];
    mirror.route({
      method,
      url,
      handler: (_request, reply) => reply.send(key),
    });
  }
  await mirror.ready();
  return mirror;
}

/**
 * Stand-ins for the fixture's ids and names: only the URL a case requests
 * matters to an inventory, never the data behind it.
 */
export const ADDRESS: Fixture = {
  garmentId: 101,
  garmentName: 'Coat',
  wishlistId: 102,
  wishlistName: 'Wish',
  needId: 131,
  needName: 'Need',
  needPickId: 132,
  setAsidePickId: 133,
  asideNeedId: 134,
  boughtPickId: 135,
  archivedId: 103,
  archivedName: 'Old',
  capsuleId: 104,
  capsuleName: 'Capsule',
  outfitId: 105,
  garmentShareId: '00000000-0000-4000-8000-000000000105',
  outfitShareId: '00000000-0000-4000-8000-000000000106',
  spareOutfitId: 143,
  agentOutfitId: 141,
  agentDeclinedId: 142,
  outfitName: 'Look',
  entryId: 106,
  selfieId: 107,
  selfieFileName: 'selfie.webp',
  inspirationId: 150,
  inspirationTitle: 'Inspo',
  inspirationFileName: 'look.webp',
  inspirationTeeId: 151,
  ownerId: 1,
  tripId: 110,
  tripName: 'Trip',
  tripOutfitId: 111,
  tripItemId: 112,
  otherTripId: 113,
  today: '2026-09-28',
  ownerToken: () => Promise.resolve(114),
  brandSizeId: 115,
  outfitRuleId: 120,
  brand: 'Brand',
  repairId: 116,
  orderItemId: 117,
  orderItemName: 'Ordered',
  weekPlanId: 118,
  agentRequestId: 121,
  agentRequestBody: 'Ask',
  inviteShareId: 119,
  inviteToken: 'invite-token',
  photo: Buffer.alloc(0),
  cutout: Buffer.alloc(0),
  shopPhotoUrl: 'http://shop.test/photo.jpg',
};

/**
 * Every matrix group: the <group> of each authorization-<group>.spec.ts
 * (`specGroups`) and the ROUTES of each authorization-<group>.routes.ts
 * (`groups`), read from the route tables, never the specs (a spec file
 * another file imported collects no tests: authorization-matrix.ts,
 * MatrixGroup).
 */
export async function loadMatrixGroups(): Promise<{
  specGroups: string[];
  groups: MatrixGroup[];
}> {
  const entries = await readdir(__dirname);
  const groupsOf = (pattern: RegExp) =>
    entries.flatMap((file) => {
      const group = pattern.exec(file)?.[1];
      return group && group !== 'coverage' ? [group] : [];
    });
  const groups = await Promise.all(
    groupsOf(/^authorization-(.+)\.routes\.ts$/).map(async (group) => {
      const module = (await import(
        join(__dirname, `authorization-${group}.routes.ts`)
      )) as { ROUTES: Route[] };
      return { group, routes: module.ROUTES };
    }),
  );
  return { specGroups: groupsOf(/^authorization-(.+)\.spec\.ts$/), groups };
}
