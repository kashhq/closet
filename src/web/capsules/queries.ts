import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  OWNER_LOCKED,
  lockedOwnerId,
  ownerLockCte,
  ownerLocked,
  ownerLockSql,
} from '../../db/owner-lock';
import { createOnce } from '../../db/create-once';
import { isUniqueViolation } from '../../db/errors';
import { selectScalars } from '../../db/select-scalars';
import {
  capsule,
  CAPSULE_NAME_UNIQUE,
  capsuleGarment,
  file,
  garment,
} from '../../db/schema';
import type { PlinthPhoto } from '../files/image-url';
import { plinthPhoto, plinthPhotoJson } from '../files/queries';
import { inCloset, ownedGarment } from '../wardrobe/status';

/**
 * Capsules' reads and writes (plan section 2): a capsule is a named subset
 * of one owner's garments. Every query names the wardrobe (owner) the
 * route resolved through authorizeWardrobe (src/web/sharing/access.ts); a
 * capsule outside it is a miss like a missing one, and the routes answer
 * 404 either way. The closet itself is not a capsule row: it is every
 * garment in the closet (inCloset), and archived members are left out of
 * every read here while keeping their membership. A wishlist item is never
 * a member (changeMembership).
 */

export interface CapsuleRef {
  id: number;
  name: string;
}

export interface CapsuleDetail extends CapsuleRef {
  notes: string | null;
}

/** What the capsule form writes: the name trimmed and never blank, blank notes null. */
export interface CapsuleFields {
  name: string;
  notes: string | null;
}

/** A garment in a capsule card's strip. */
export interface StripGarment {
  id: number;
  name: string | null;
  /** Its silhouette without a photo (PlinthImage). */
  category: string;
  photo: PlinthPhoto | null;
}

export interface CapsuleCard extends CapsuleRef {
  /** Members in the closet. */
  count: number;
  /** The newest few members in the closet (CARD_STRIP). */
  strip: StripGarment[];
}

/** Thumbs on a capsule card (and the closet's): four fit a phone's width. */
const CARD_STRIP = 4;

/**
 * "The garment is in capsule `capsuleId`", for a query over `garment`: the
 * wardrobe grid's `?capsule=`, Styling's strips, and the outfit
 * gallery's pool (#9) when it comes. Safe on any wardrobe without checking
 * whose capsule it is: a capsule only ever holds its owner's garments
 * (changeMembership), so on another wardrobe it matches nothing. A route
 * that shows the capsule's name still looks it up (findCapsule). Given the
 * `capsule.id` column, it is correlated with an outer capsule row (the list
 * page's cards).
 */
export function inCapsule(capsuleId: number | typeof capsule.id): SQL {
  return sql`${garment.id} in (select ${capsuleGarment.garmentId} from ${capsuleGarment} where ${capsuleGarment.capsuleId} = ${capsuleId})`;
}

const byName = [asc(sql`lower(${capsule.name})`), asc(capsule.id)];

/**
 * The wardrobe's capsules by name as a scalar subquery (a JSON array, empty
 * for none), for a page that reads it in one statement with its other
 * lists: the grid's scope menu (gridContext,
 * src/web/wardrobe/grid-context.ts), Styling's and the outfit gallery's
 * capsule menus.
 */
export function capsuleNamesSql(ownerId: number): SQL<CapsuleRef[]> {
  return sql<CapsuleRef[]>`(
    select coalesce(
      json_agg(
        json_build_object('id', ${capsule.id}, 'name', ${capsule.name})
        order by ${sql.join(byName, sql`, `)}
      ),
      '[]'
    )
    from ${capsule}
    where ${eq(capsule.ownerId, ownerId)}
  )`;
}

/**
 * The capsule `id` in `ownerId`'s wardrobe, by name, as a scalar subquery
 * (null when it is not one), for a route that checks `?capsule=` in the
 * statement that reads with it (Styling, #163): its reads through
 * inCapsule match nothing for another's, so reading before the check
 * shows nothing.
 */
export function capsuleRefSql(
  id: number,
  ownerId: number,
): SQL<CapsuleRef | null> {
  return sql<CapsuleRef | null>`(
    select json_build_object('id', ${capsule.id}, 'name', ${capsule.name})
    from ${capsule}
    where ${and(eq(capsule.id, id), eq(capsule.ownerId, ownerId))}
  )`;
}

/** The capsule in `ownerId`'s wardrobe, or undefined. */
export async function findCapsule(
  db: Db,
  id: number,
  ownerId: number,
): Promise<CapsuleDetail | undefined> {
  const [row] = await db
    .select({ id: capsule.id, name: capsule.name, notes: capsule.notes })
    .from(capsule)
    .where(and(eq(capsule.id, id), eq(capsule.ownerId, ownerId)));
  return row;
}

/** A capsule as the changes feed carries it (capsulesByIds). */
export interface SyncedCapsuleRow extends CapsuleDetail {
  /** Every member, archived ones included (the membership as stored), by id. */
  garmentIds: number[];
}

/**
 * The capsules with these ids and their members, in one statement whatever
 * their owners (the changes feed's page, src/web/sync/feed.ts, which read
 * the ids from the wardrobes its caller may see, in the same snapshot). A
 * membership change touches its capsule (capsule_garment is its sync
 * child), so the feed resends the capsule with its members.
 */
export function capsulesByIds(
  db: Queryable,
  ids: readonly number[],
): Promise<SyncedCapsuleRow[]> {
  return db
    .select({
      id: capsule.id,
      name: capsule.name,
      notes: capsule.notes,
      garmentIds: sql<number[]>`array(
        select ${capsuleGarment.garmentId} from ${capsuleGarment}
        where ${capsuleGarment.capsuleId} = ${capsule.id}
        order by ${capsuleGarment.garmentId}
      )`,
    })
    .from(capsule)
    .where(inArray(capsule.id, [...ids]));
}

/** A card's count and strip as the list's statement reads them (JSON), before readCard. */
interface CardJson {
  count: number;
  strip: (Omit<StripGarment, 'photo'> & {
    photo: Parameters<typeof plinthPhoto>[0];
  })[];
}

type ClosetCard = Pick<CapsuleCard, 'count' | 'strip'>;

/**
 * A card over the closet garments `members` picks: how many, and the
 * newest CARD_STRIP of them with their photos, as one JSON object.
 */
function cardSql(members: SQL | undefined): SQL<CardJson> {
  return sql<CardJson>`json_build_object(
    'count', (select count(*)::int from ${garment} where ${members}),
    'strip', (
      select coalesce(json_agg(strip order by strip.id desc), '[]')
      from (
        select ${garment.id} as id, ${garment.name} as name,
          ${garment.category} as category, ${plinthPhotoJson} as photo
        from ${garment}
        left join ${file} on ${eq(file.id, garment.photoId)}
        where ${members}
        order by ${garment.id} desc
        limit ${CARD_STRIP}
      ) strip
    )
  )`;
}

function readCard({ count, strip }: CardJson): ClosetCard {
  return {
    count,
    strip: strip.map((shown) => ({
      ...shown,
      photo: plinthPhoto(shown.photo),
    })),
  };
}

/** What the list page shows: the closet's card, then each capsule's. */
export interface CapsuleList {
  closet: ClosetCard;
  capsules: CapsuleCard[];
}

/**
 * The list page's cards as scalar subqueries, for its one statement with
 * the app bar's switcher (GET /capsules, #170; it was four): the closet's
 * card (every garment in the closet), and every capsule of the wardrobe by
 * name, each with its count of members in the closet and the newest few
 * of them. Read back with readCapsuleList.
 */
export function capsuleListSql(ownerId: number) {
  // Each capsule's card is correlated with its row (inCapsule on the column).
  const members = inCapsule(capsule.id);
  return {
    closet: cardSql(and(eq(garment.ownerId, ownerId), inCloset())),
    capsules: sql<(CapsuleRef & { card: CardJson })[]>`(
      select coalesce(
        json_agg(
          json_build_object(
            'id', ${capsule.id},
            'name', ${capsule.name},
            'card', ${cardSql(and(members, inCloset()))}
          )
          order by ${sql.join(byName, sql`, `)}
        ),
        '[]'
      )
      from ${capsule}
      where ${eq(capsule.ownerId, ownerId)}
    )`,
  };
}

export function readCapsuleList(row: {
  closet: CardJson;
  capsules: (CapsuleRef & { card: CardJson })[];
}): CapsuleList {
  return {
    closet: readCard(row.closet),
    capsules: readCapsuleCards(row.capsules),
  };
}

function readCapsuleCards(
  rows: (CapsuleRef & { card: CardJson })[],
): CapsuleCard[] {
  return rows.map(({ id, name, card }) => ({ id, name, ...readCard(card) }));
}

/** The capsules' cards alone, in one statement: list_capsules (src/web/mcp/tools/capsules.ts). */
export async function listCapsules(
  db: Queryable,
  ownerId: number,
): Promise<CapsuleCard[]> {
  const { capsules } = await selectScalars(db, {
    capsules: capsuleListSql(ownerId).capsules,
  });
  return readCapsuleCards(capsules);
}

export interface GarmentCapsule extends CapsuleRef {
  member: boolean;
}

/**
 * The garment page's capsules row: every capsule of the wardrobe, by name,
 * and whether the garment is in it. A scalar subquery (a JSON array, empty
 * for none), so the page reads it in one statement with its other lists
 * (garmentContext, src/web/wardrobe/garment-context.ts).
 */
export function capsulesOfGarmentSql(
  ownerId: number,
  garmentId: number,
): SQL<GarmentCapsule[]> {
  return sql<GarmentCapsule[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${capsule.id},
          'name', ${capsule.name},
          'member', ${capsuleGarment.garmentId} is not null
        )
        order by ${sql.join(byName, sql`, `)}
      ),
      '[]'
    )
    from ${capsule}
    left join ${capsuleGarment} on ${and(
      eq(capsuleGarment.capsuleId, capsule.id),
      eq(capsuleGarment.garmentId, garmentId),
    )}
    where ${eq(capsule.ownerId, ownerId)}
  )`;
}

/**
 * The owner already has a capsule by this name, whatever its case
 * (capsule_owner_id_lower_name_unique). The index is the rule, so a
 * concurrent save cannot slip past a check made first.
 */
const NAME_TAKEN = 'name-taken';
export type NameTaken = typeof NAME_TAKEN;

/**
 * Creates a capsule in `ownerId`'s wardrobe (the form, the seed): its id,
 * or 'name-taken'. In a savepoint, so a caller's transaction (the seed's)
 * survives the refusal.
 */
export async function createCapsule(
  db: Queryable,
  ownerId: number,
  fields: CapsuleFields,
): Promise<number | NameTaken> {
  try {
    return await db.transaction(async (tx) => {
      const lock = ownerLockCte(tx, ownerId);
      const [row] = await tx
        .with(lock)
        .insert(capsule)
        .values({ ownerId: lockedOwnerId(lock), ...fields })
        .returning({ id: capsule.id });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, CAPSULE_NAME_UNIQUE)) return NAME_TAKEN;
    throw error;
  }
}

/**
 * createCapsule for a create that carries the client's own id (the API's,
 * a retried offline create): see createOnce. A retry answers the first
 * capsule whatever its name now says; another client id for a name taken
 * is still 'name-taken'.
 */
export async function createCapsuleOnce(
  db: Queryable,
  ownerId: number,
  fields: CapsuleFields,
  clientId: string,
): Promise<{ id: number; created: boolean } | NameTaken | 'gone'> {
  try {
    const once = await createOnce(
      async () => {
        const lock = ownerLockCte(db, ownerId);
        const [row] = await db
          .with(lock)
          .insert(capsule)
          .values({ ownerId: lockedOwnerId(lock), ...fields, clientId })
          .onConflictDoNothing({ target: [capsule.ownerId, capsule.clientId] })
          .returning({ id: capsule.id });
        return row?.id;
      },
      async () => {
        const [first] = await db
          .select({ id: capsule.id })
          .from(capsule)
          .where(
            and(eq(capsule.ownerId, ownerId), eq(capsule.clientId, clientId)),
          );
        return first?.id;
      },
    );
    return once === 'gone' ? once : { id: once.row, created: once.created };
  } catch (error) {
    if (isUniqueViolation(error, CAPSULE_NAME_UNIQUE)) return NAME_TAKEN;
    throw error;
  }
}

/** Renames it: 'not-found' outside `ownerId`'s wardrobe, 'name-taken' for another capsule's name. */
export async function updateCapsule(
  db: Db,
  id: number,
  ownerId: number,
  fields: CapsuleFields,
): Promise<'updated' | 'not-found' | NameTaken> {
  try {
    const lock = ownerLockCte(db, ownerId);
    const updated = await db
      .with(lock)
      .update(capsule)
      .set(fields)
      .where(
        and(
          eq(capsule.id, id),
          eq(capsule.ownerId, ownerId),
          ownerLocked(db, lock),
        ),
      )
      .returning({ id: capsule.id });
    return updated.length > 0 ? 'updated' : 'not-found';
  } catch (error) {
    if (isUniqueViolation(error, CAPSULE_NAME_UNIQUE)) return NAME_TAKEN;
    throw error;
  }
}

/** Deletes it (its membership cascades, its garments stay); false when not in `ownerId`'s wardrobe. */
export async function deleteCapsule(
  db: Db,
  id: number,
  ownerId: number,
): Promise<boolean> {
  const lock = ownerLockCte(db, ownerId);
  const deleted = await db
    .with(lock)
    .delete(capsule)
    .where(
      and(
        eq(capsule.id, id),
        eq(capsule.ownerId, ownerId),
        ownerLocked(db, lock),
      ),
    )
    .returning({ id: capsule.id });
  return deleted.length > 0;
}

/** Every pairing of these capsules with these garments. */
interface MembershipSet {
  capsuleIds: number[];
  garmentIds: number[];
}

export interface MembershipChange {
  add?: MembershipSet;
  remove?: MembershipSet;
}

/**
 * The one writer of capsule_garment: removes every pairing in `remove`,
 * then adds every pairing in `add` (one already there is kept), in one
 * transaction. Only capsules and garments of `ownerId`'s wardrobe take
 * part: any other id is dropped, so a capsule never holds another
 * wardrobe's garment, nor a wishlist item (not in the closet; an archived
 * garment keeps its membership and may still be listed). Both sides are locked FOR SHARE, so a capsule or
 * garment deleted meanwhile waits for this to commit rather than failing a
 * foreign key halfway. The picker (a capsule and the tiles it showed), the
 * garment page's toggles (a garment and the capsules it listed),
 * set_capsule_membership (MCP) and the seed all go through it. Answers
 * which of the named capsules and garments are the wardrobe's (`capsules`,
 * `garments`; a wishlist item is the wardrobe's, found but never paired),
 * so a caller that must refuse another's capsule or garment learns it from
 * the write (the 404 after a write that changed nothing) rather than
 * reading it first (#172 for MCP, #251 for the picker and the toggles).
 */
export function changeMembership(
  db: Queryable,
  ownerId: number,
  change: MembershipChange,
): Promise<{
  added: number;
  removed: number;
  capsules: ReadonlySet<number>;
  garments: ReadonlySet<number>;
}> {
  return db.transaction(async (tx) => {
    const sets = [change.add, change.remove].flatMap((set) => set ?? []);
    const { capsules, garments, pairable } = await lockMembers(
      tx,
      ownerId,
      sets.flatMap((set) => set.capsuleIds),
      sets.flatMap((set) => set.garmentIds),
    );
    // Each id once: a form may post one twice.
    const owned = (set: MembershipSet | undefined): MembershipSet => ({
      capsuleIds: [...new Set(set?.capsuleIds)].filter((id) =>
        capsules.has(id),
      ),
      garmentIds: [...new Set(set?.garmentIds)].filter((id) =>
        pairable.has(id),
      ),
    });
    const remove = owned(change.remove);
    const add = owned(change.add);
    let removed = 0;
    if (remove.capsuleIds.length > 0 && remove.garmentIds.length > 0) {
      removed = (
        await tx
          .delete(capsuleGarment)
          .where(
            and(
              inArray(capsuleGarment.capsuleId, remove.capsuleIds),
              inArray(capsuleGarment.garmentId, remove.garmentIds),
            ),
          )
          .returning({ capsuleId: capsuleGarment.capsuleId })
      ).length;
    }
    let added = 0;
    if (add.capsuleIds.length > 0 && add.garmentIds.length > 0) {
      added = (
        await tx
          .insert(capsuleGarment)
          .values(
            add.capsuleIds.flatMap((capsuleId) =>
              add.garmentIds.map((garmentId) => ({ capsuleId, garmentId })),
            ),
          )
          .onConflictDoNothing()
          .returning({ capsuleId: capsuleGarment.capsuleId })
      ).length;
    }
    return { added, removed, capsules, garments };
  });
}

/**
 * Which of `capsuleIds` are capsules of `ownerId`'s wardrobe, and which of
 * `garmentIds` its garments (`garments`, any status) and of those the ones
 * a capsule may hold (`pairable`: owned now or once, not wishlist items),
 * all locked FOR SHARE, in one statement (#172: it was one per side).
 * The owner lock first (src/db/owner-lock.ts), then capsules, then
 * garments, each in id order, as every multi-row
 * garment locker takes them (pickedGarments), so two lockers never
 * deadlock on each other's. A side with no ids reads nothing.
 */
async function lockMembers(
  tx: Queryable,
  ownerId: number,
  capsuleIds: number[],
  garmentIds: number[],
): Promise<{
  capsules: Set<number>;
  garments: Set<number>;
  pairable: Set<number>;
}> {
  if (capsuleIds.length === 0 && garmentIds.length === 0) {
    return { capsules: new Set(), garments: new Set(), pairable: new Set() };
  }
  const { rows } = await tx.execute<{
    capsules: number[];
    garments: number[];
    pairable: number[];
  }>(lockMembersSql(tx, ownerId, capsuleIds, garmentIds));
  const [row] = rows;
  return {
    capsules: new Set(row.capsules),
    garments: new Set(row.garments),
    pairable: new Set(row.pairable),
  };
}

/** lockMembers' statement, exported for owner-lock.spec.ts, which EXPLAINs it. */
export function lockMembersSql(
  tx: Queryable,
  ownerId: number,
  capsuleIds: number[],
  garmentIds: number[],
): SQL {
  const ids = (list: number[]) =>
    sql`array[${sql.join(
      list.map((id) => sql`${id}`),
      sql`, `,
    )}]::int[]`;
  // A side with no ids is `false`: an empty array literal needs a type
  // Postgres cannot infer from `array[]`.
  const among = (column: SQL, list: number[]) =>
    list.length === 0 ? sql`false` : sql`${column} = any(${ids(list)})`;
  return sql`
    with ${ownerLockSql(tx, ownerId)},
    capsules as (
      select ${capsule.id} as id from ${capsule}
      where ${capsule.ownerId} = ${ownerId} and ${among(sql`${capsule.id}`, capsuleIds)}
        and ${OWNER_LOCKED}
      order by ${capsule.id}
      for share
    ),
    garments as (
      select ${garment.id} as id, ${ownedGarment()} as pairable from ${garment}
      where ${garment.ownerId} = ${ownerId} and ${among(sql`${garment.id}`, garmentIds)}
        and ${OWNER_LOCKED}
      order by ${garment.id}
      for share
    )
    select
      (select coalesce(json_agg(id), '[]') from capsules) as capsules,
      (select coalesce(json_agg(id), '[]') from garments) as garments,
      (select coalesce(json_agg(id) filter (where pairable), '[]') from garments) as pairable`;
}
