import { and, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import { type SharePermission, user, wardrobeShare } from '../../db/schema';
import { sessionUserId } from '../auth/require-session';
import { Forbidden, NotFound, type Resource } from '../refusals';
import { ROW_ID_MAX } from '../schemas';
import { type Surface, surfaceOf } from '../surface';
import { isShareAware } from './share-aware';

/**
 * Who the actor is to the wardrobe a call addresses: its owner, or a
 * grantee by their share's permission.
 */
export type WardrobeRole = 'OWN' | SharePermission;

/**
 * What a share covers (#680, owner decision 2026-11-25), named once here so
 * no surface infers it from which pages happen to read `?ownerId=`:
 *  - `view`: the closet, the wishlist and capsules;
 *  - `manage`: change them (garments, capsules, tags, photos, conditions);
 *  - `launder`: mark day-level wears and washes, see the wash state;
 *  - `private`: a garment's price and notes;
 *  - `own`: the owner's own records and acts (wear history and cost,
 *    outfits, the calendar, trips, away, archive and delete, the export).
 * managesWardrobeSql is the SQL form of `manage`, `launder` and `private`
 * for a batched read; test/integration/share.spec.ts holds the two to the
 * same answers.
 */
export type Capability = 'view' | 'manage' | 'launder' | 'private' | 'own';

const CAPABILITIES: Record<WardrobeRole, ReadonlySet<Capability>> = {
  OWN: new Set(['view', 'manage', 'launder', 'private', 'own']),
  MANAGE: new Set(['view', 'manage', 'launder', 'private']),
  VIEW: new Set(['view']),
};

/** Whether `role` grants `capability` (CAPABILITIES). */
export function can(role: WardrobeRole, capability: Capability): boolean {
  return CAPABILITIES[role].has(capability);
}

/**
 * What the actor may do with the wardrobe a call addresses. `ownerId` is
 * the wardrobe actually being read or written (the actor's own unless a
 * share is in play), so callers pass it straight on. `role` is undefined
 * for a wardrobe the actor cannot see; the flags are `can(role, ...)`.
 *
 * Refusal policy (authorizeWardrobe throws it): without `canView` the
 * wardrobe does not exist for the actor, a 404, so ids never reveal whose
 * data exists. With `canView` but not what the call needs (`canManage`, or
 * ownership), a 403: they know it exists.
 */
export interface WardrobeAccess {
  ownerId: number;
  role: WardrobeRole | undefined;
  isOwner: boolean;
  canView: boolean;
  canManage: boolean;
}

/** The access of `role` (undefined: no share) to `ownerId`'s wardrobe. */
function accessOf(
  ownerId: number,
  role: WardrobeRole | undefined,
): WardrobeAccess {
  const has = (capability: Capability) =>
    role !== undefined && can(role, capability);
  return {
    ownerId,
    role,
    isOwner: role === 'OWN',
    canView: has('view'),
    canManage: has('manage'),
  };
}

/**
 * The one definition of a share that opens `ownerId`'s wardrobe to `userId`:
 * each an id, or a column of the statement asking (the device token's user,
 * authenticateToken; a garment's owner, managesWardrobeSql).
 */
function acceptedShare(
  ownerId: number | AnyPgColumn,
  userId: number | AnyPgColumn,
) {
  return and(
    eq(wardrobeShare.grantorId, ownerId),
    eq(wardrobeShare.granteeId, userId),
    isNotNull(wardrobeShare.acceptedAt),
  );
}

/** What the session statement read of the share a request addresses. */
export interface ShareReadAhead {
  ownerId: number;
  /** Null: no accepted share, so that wardrobe does not exist for the requester. */
  permission: SharePermission | null;
}

const sharesReadAhead = new WeakMap<FastifyRequest, ShareReadAhead>();

/**
 * The other user's wardrobe a request's `?ownerId=` names, whose share the
 * session statement reads in the same round trip (findSessionAccount,
 * src/web/auth/queries.ts), and so does an API request's token read
 * (authenticateToken), so a grantee's request pays no statement of its own
 * for the access check (#170). Undefined for one's own wardrobe (`userId`,
 * when the caller knows it: a token's user is known only once its row is
 * read), for anything but a plain row id: the route's schema judges
 * those, and resolveWardrobeAccess then reads the share itself (a body's
 * `ownerId` too), and on a route that is not share-aware, which reads no
 * share (an owner-only page refuses the id unread: refuseForeignOwner).
 * Both hooks run before validation, so this reads the raw query string.
 */
export function shareToReadAhead(
  request: FastifyRequest,
  userId?: number,
): number | undefined {
  if (!isShareAware(request)) return undefined;
  const raw = (request.query as Record<string, unknown> | undefined)?.ownerId;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return undefined;
  const ownerId = Number(raw);
  return ownerId <= ROW_ID_MAX && ownerId !== userId ? ownerId : undefined;
}

/**
 * The permission of `userId`'s accepted share of `ownerId`'s wardrobe as a
 * scalar subquery, null for none: a column of the session statement.
 */
export function sharePermissionSql(
  ownerId: number,
  userId: number | AnyPgColumn,
): SQL<SharePermission | null> {
  return sql<SharePermission | null>`(
    select ${wardrobeShare.permission} from ${wardrobeShare}
    where ${acceptedShare(ownerId, userId)}
  )`;
}

/**
 * Whether `viewerId` may manage the wardrobe of `ownerId` (a row's owner
 * column), as the resolver's `canManage` answers it: their own, or an
 * accepted MANAGE share. For a batched read across the wardrobes the
 * viewer sees (the changes feed's garments, garmentsByIds), where no
 * resolver runs per row.
 */
export function managesWardrobeSql(
  ownerId: AnyPgColumn,
  viewerId: number | AnyPgColumn,
): SQL<boolean> {
  return sql<boolean>`(${ownerId} = ${viewerId} or exists (
    select from ${wardrobeShare}
    where ${and(acceptedShare(ownerId, viewerId), eq(wardrobeShare.permission, 'MANAGE'))}
  ))`;
}

/**
 * Whether `viewerId` may see the wardrobe of `ownerId` (a row's owner
 * column), as the resolver's `view` answers a session or device token: their
 * own, or any accepted share. For a reference into a wardrobe that is
 * checked inside another statement (an agent request's garment,
 * src/web/requests/queries.ts), where no resolver runs.
 */
export function viewsWardrobeSql(
  ownerId: AnyPgColumn,
  viewerId: number | AnyPgColumn,
): SQL<boolean> {
  return sql<boolean>`(${ownerId} = ${viewerId} or exists (
    select from ${wardrobeShare} where ${acceptedShare(ownerId, viewerId)}
  ))`;
}

/**
 * Keeps what the session statement (or an API request's token read) read,
 * for this request alone: the resolver stores it only for a cookie that
 * opened a session, the API's token hook only for a token it accepted, and
 * the next request reads the share again, so a revoked share stops access
 * there.
 */
export function rememberShareReadAhead(
  request: FastifyRequest,
  share: ShareReadAhead,
): void {
  sharesReadAhead.set(request, share);
}

/**
 * Who a domain function acts for (#188): the user, and on a page or an API
 * request the share its session or token statement read ahead (#170), so a
 * domain function that takes an Actor costs the statements the route's own
 * check did. Built once per call by a surface: `actorOf(request)` here for
 * pages and /api/v1, `actorOf(ctx)` (src/web/mcp/tool.ts) for MCP. No
 * domain function sees a FastifyRequest.
 */
/**
 * The Actor's door: a request's surface, or `cli` for the seed and the audit
 * fixture (the maintenance CLIs build no Actor), so an audit line tells a command-line
 * credential from one a person made on a page. Never a request Surface: the
 * request gates (same-origin, bearer) must not grow a `cli` case.
 */
type ActorSurface = Surface | 'cli';

export interface Actor {
  userId: number;
  /**
   * The door the call came through (#712): what an action's log line names
   * (logOp, src/web/op-log.ts), so the action logs once for every surface.
   * Never an access input: the resolver ignores it.
   */
  surface: ActorSurface;
  shareReadAhead?: ShareReadAhead;
  /**
   * An own-wardrobe-only agent token's (#701, its TokenScope): every
   * wardrobe but the user's own resolves as unseen, the unknown id's
   * NotFound, and no share is listed (sharedWardrobesOf). Only actorOf(ctx)
   * sets it: a session or device token sees its shares as ever.
   */
  ownWardrobeOnly?: true;
}

/**
 * The request's actor: the device token's user on /api/v1 (only its hook
 * sets `accessToken` there), else the session's, on the request's surface
 * (surfaceOf: `api` or `page`; MCP builds its own, actorOf(ctx)). Throws on
 * a public route, as sessionUserId does.
 */
export function actorOf(request: FastifyRequest): Actor {
  const userId = request.accessToken?.user.id ?? sessionUserId(request);
  const surface = surfaceOf(request);
  const shareReadAhead = sharesReadAhead.get(request);
  return shareReadAhead
    ? { userId, surface, shareReadAhead }
    : { userId, surface };
}

/** The actor's share of `ownerId`'s wardrobe: the one read ahead when it is this wardrobe's, else a statement. */
async function sharePermission(
  db: Db,
  actor: Actor,
  ownerId: number,
): Promise<SharePermission | null> {
  const ahead = actor.shareReadAhead;
  if (ahead?.ownerId === ownerId) return ahead.permission;
  const [share] = await db
    .select({ permission: wardrobeShare.permission })
    .from(wardrobeShare)
    .where(acceptedShare(ownerId, actor.userId));
  return share?.permission ?? null;
}

/**
 * The single ownership resolver for wardrobe access. At most one share
 * lookup: none for the actor's own wardrobe, and none for a page whose
 * session statement read the share already.
 */
async function resolveWardrobeAccess(
  db: Db,
  actor: Actor,
  ownerId: number | undefined,
): Promise<WardrobeAccess> {
  if (ownerId == null || ownerId === actor.userId) {
    return accessOf(actor.userId, 'OWN');
  }
  // No share read: the scope refuses before any row is asked, so the answer
  // and its cost are an unknown id's whatever the user was granted.
  const permission = actor.ownWardrobeOnly
    ? null
    : await sharePermission(db, actor, ownerId);
  return accessOf(ownerId, permission ?? undefined);
}

/** What a call needs of the wardrobe it addresses. */
export type WardrobeNeed = Capability;

/** A WardrobeAccess authorizeWardrobe granted: it always has a role. */
export type GrantedAccess = WardrobeAccess & { role: WardrobeRole };

export interface AuthorizedWardrobe {
  access: GrantedAccess;
  /** The shared wardrobe addressed, for links; undefined for one's own. */
  viewOwner: number | undefined;
}

/**
 * The refusal policy above, applied: resolves the wardrobe `ownerId` names
 * (`''` or absent: the actor's own) and throws unless the actor has what
 * the call `need`s: a view (NotFound without one, of `unseen`, so the
 * answer reads like an unknown id of what was asked for), else the
 * capability its role lacks (Forbidden, CAPABILITIES). Every route that takes
 * `?ownerId=` goes through it (a route plugin through its wardrobeGuard),
 * and so does every MCP tool that addresses a wardrobe (wardrobeFor).
 */
export async function authorizeWardrobe(
  db: Db,
  actor: Actor,
  ownerId: number | '' | undefined,
  need: WardrobeNeed,
  unseen: Resource,
): Promise<AuthorizedWardrobe> {
  const access = await resolveWardrobeAccess(db, actor, ownerId || undefined);
  // Every role has `view`: no role is the unseen wardrobe.
  if (access.role === undefined) throw new NotFound(unseen);
  if (!can(access.role, need)) throw new Forbidden();
  // `?ownerId=<self>` is the own wardrobe (nobody shares with themselves),
  // and its links must not carry the parameter.
  return {
    access: { ...access, role: access.role },
    viewOwner: access.isOwner ? undefined : access.ownerId,
  };
}

/** A route request addressing a wardrobe by `?ownerId=` (OwnerQuery). */
export type WardrobeRequest = FastifyRequest & {
  query: { ownerId?: number | '' };
};

/** authorizeWardrobe of the wardrobe the request's `?ownerId=` addresses. */
export type WardrobeGuard = (
  request: WardrobeRequest,
  need: WardrobeNeed,
) => Promise<AuthorizedWardrobe>;

/**
 * A feature's guard, bound once per plugin with what an unseen wardrobe
 * reads as (garmentGuard, the capsule and wishlist plugins), so no route
 * re-declares the wrapper or relays `request.query.ownerId` by hand.
 */
export function wardrobeGuard(db: Db, unseen: Resource): WardrobeGuard {
  return (request, need) =>
    authorizeWardrobe(
      db,
      actorOf(request),
      request.query.ownerId,
      need,
      unseen,
    );
}

export interface SharedWardrobe {
  grantorId: number;
  /** The first name, else the email: what the switcher shows the grantee. */
  grantorName: string;
  /** The first name alone (the MCP tools never pass an email on). */
  grantorFirstName: string | null;
  permission: SharePermission;
}

/** A share with `userId` as sharedWardrobesOf and sharedWardrobesSql read it. */
export interface SharedWardrobeRow {
  grantorId: number;
  firstName: string | null;
  email: string | null;
  permission: SharePermission;
}

/**
 * The shares `userId` has accepted: the wardrobes they see beside their own
 * (the switchers, and the changes feed's wardrobes, src/web/sync/queries.ts).
 */
export function acceptedSharesWith(userId: number) {
  return and(
    eq(wardrobeShare.granteeId, userId),
    isNotNull(wardrobeShare.acceptedAt),
  );
}

export function toSharedWardrobe(row: SharedWardrobeRow): SharedWardrobe {
  return {
    grantorId: row.grantorId,
    grantorName: row.firstName || row.email || '',
    grantorFirstName: row.firstName || null,
    permission: row.permission,
  };
}

/**
 * Wardrobes shared with the actor: the wears page's switcher,
 * list_shared_wardrobes (MCP), GET /api/v1/shared-wardrobes. None, and no
 * statement, for an own-wardrobe-only actor: the list resolveWardrobeAccess
 * would refuse every entry of.
 */
export async function sharedWardrobesOf(
  db: Db,
  actor: Actor,
): Promise<SharedWardrobe[]> {
  if (actor.ownWardrobeOnly) return [];
  const rows = await db
    .select({
      grantorId: wardrobeShare.grantorId,
      firstName: user.firstName,
      email: user.email,
      permission: wardrobeShare.permission,
    })
    .from(wardrobeShare)
    .innerJoin(user, eq(user.id, wardrobeShare.grantorId))
    .where(acceptedSharesWith(actor.userId))
    .orderBy(wardrobeShare.id);
  return rows.map(toSharedWardrobe);
}

/**
 * sharedWardrobesOf's rows as a scalar subquery (a JSON array, empty for
 * none; map each through toSharedWardrobe), for a page that reads it in
 * one statement with its other lists: the grid's switcher (gridContext,
 * src/web/wardrobe/grid-context.ts). Pages only, so it takes the session's
 * user, never scoped: a token's reader is sharedWardrobesOf, which honours
 * an own-wardrobe-only actor (#701).
 */
export function sharedWardrobesSql(userId: number): SQL<SharedWardrobeRow[]> {
  return sql<SharedWardrobeRow[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'grantorId', ${wardrobeShare.grantorId},
          'firstName', ${user.firstName},
          'email', ${user.email},
          'permission', ${wardrobeShare.permission}
        )
        order by ${wardrobeShare.id}
      ),
      '[]'
    )
    from ${wardrobeShare}
    join ${user} on ${eq(user.id, wardrobeShare.grantorId)}
    where ${acceptedSharesWith(userId)}
  )`;
}
