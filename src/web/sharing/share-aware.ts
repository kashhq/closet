import type { FastifyRequest, RouteOptions } from 'fastify';
import { NotFound } from '../refusals';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Stamped by markShareAware on every route, never spelled by one: its
     * querystring takes `?ownerId=` (OwnerQuery), so it serves a grantee.
     */
    shareAware?: boolean;
  }
}

/**
 * Whether a route schema (TypeBox: objects, unions, intersections) has an
 * `ownerId` property. The authorization matrix's coverage spec asks the
 * same of every route's querystring and body.
 */
export function takesOwnerId(schema: unknown): boolean {
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
 * The root onRoute hook (createApp adds it before any route, so it sees
 * every route a plugin registers after it): a route is share-aware exactly
 * when its querystring schema declares `ownerId` (#680). A route spelling
 * the flag itself stops the boot: the schema is the one declaration.
 */
export function markShareAware(route: RouteOptions): void {
  if (route.config?.shareAware !== undefined) {
    throw new Error(
      `${String(route.method)} ${route.url} sets config.shareAware: declare ownerId in its querystring (OwnerQuery) instead`,
    );
  }
  route.config = {
    ...route.config,
    shareAware: takesOwnerId(route.schema?.querystring),
  };
}

/** The request's route serves a grantee through `?ownerId=` (markShareAware). */
export function isShareAware(request: FastifyRequest): boolean {
  return request.routeOptions.config.shareAware === true;
}

/**
 * A page that is the signed-in user's alone (outfits, the calendar, trips,
 * every route without OwnerQuery) refuses a `?ownerId=` naming anyone else
 * as an unknown wardrobe (#680): it used to ignore it and show the
 * requester's own data under the other's address. The same 404 for a VIEW
 * or MANAGE grantee and a stranger, and no statement: there is no share
 * to read, since no share opens these. `''` and the user's own id are
 * their own wardrobe; anything else (another id, garbage, a repeated
 * parameter) names someone else's. Called by the root preValidation hook
 * with the session's user, before the route's schema, so it reads the raw
 * query string.
 */
export function refuseForeignOwner(
  request: FastifyRequest,
  userId: number,
): void {
  if (isShareAware(request)) return;
  const raw = (request.query as Record<string, unknown> | undefined)?.ownerId;
  if (raw === undefined || raw === '' || raw === String(userId)) return;
  throw new NotFound('wardrobe', {
    logDetail: `?ownerId= on an owner-only route (user ${userId})`,
  });
}
