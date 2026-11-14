import type { WebOptions } from '../plugin';
import { NotFound } from '../refusals';
import {
  type Actor,
  type AuthorizedWardrobe,
  authorizeWardrobe,
  type WardrobeAccess,
  type WardrobeNeed,
  type WardrobeRequest,
} from '../sharing/access';
import {
  type GarmentAddress,
  garmentNotFound,
  garmentWardrobe,
} from '../wardrobe/garment-access';
import {
  type CapsuleDetail,
  type CapsuleFields,
  changeMembership,
  createCapsule,
  createCapsuleOnce,
  deleteCapsule,
  findCapsule,
  type NameTaken,
  updateCapsule,
} from './queries';

type Db = WebOptions['db'];

/**
 * The capsule access path (#188; docs/plans/2026-11-12-json-api.md section
 * 4): every read of one capsule and every change a surface makes to one,
 * each taking the Actor and the address and enforcing access itself, so a
 * page, an MCP tool and the API refuse alike. Capsules are part of the
 * shared wardrobe (owner decision on #8): a view reads them, a MANAGE share
 * (or ownership) changes their membership, and creating, renaming and
 * deleting are the owner's. A capsule outside the wardrobe addressed is a
 * 404 like an unknown id. The queries underneath (queries.ts) trust their
 * `ownerId`: only this path reaches them from a surface.
 *
 * A page that needs the wardrobe before its write (a refused form drawn
 * again) asks its guard first; the writer's own check is then free (one's
 * own wardrobe, or the share the session read ahead), so statement counts
 * hold.
 */

/**
 * A capsule outside the wardrobe addressed, or no capsule: one refusal for
 * both (here, the grid's `?capsule=` and `?pick=`, Styling's and the
 * gallery's `?capsule=`).
 */
export function capsuleNotFound(): NotFound {
  return new NotFound('capsule');
}

/** A capsule as a call addresses it: `ownerId` `''` or absent is the actor's own wardrobe. */
export interface CapsuleAddress {
  id: number;
  ownerId: number | '' | undefined;
  /** As GarmentAddress's: MCP names the wardrobe, so an unseen one reads "Wardrobe not found". */
  unseen?: 'wardrobe';
}

/** The capsule a route's `/:id` and `?ownerId=` address (CapsuleParams, OwnerQuery). */
export function capsuleAddress(
  request: WardrobeRequest & { params: { id: number } },
): CapsuleAddress {
  return { id: request.params.id, ownerId: request.query.ownerId };
}

/** The wardrobe `address` names, if the actor has what the call `need`s, without reading the capsule. */
function capsuleWardrobe(
  db: Db,
  actor: Actor,
  address: CapsuleAddress,
  need: WardrobeNeed,
): Promise<AuthorizedWardrobe> {
  return authorizeWardrobe(
    db,
    actor,
    address.ownerId,
    need,
    address.unseen ?? 'capsule',
  );
}

/**
 * Capsule `id` in a wardrobe already authorized (`access` is only what
 * authorizeWardrobe answers), or the 404 of an unknown id: for the capsule
 * page, which reads it beside its members (inCapsule matches nothing
 * outside the capsule's own wardrobe, so reading them first shows nothing).
 */
export async function capsuleIn(
  db: Db,
  access: WardrobeAccess,
  id: number,
): Promise<CapsuleDetail> {
  const capsule = await findCapsule(db, id, access.ownerId);
  if (!capsule) throw capsuleNotFound();
  return capsule;
}

export interface AuthorizedCapsule extends AuthorizedWardrobe {
  capsule: CapsuleDetail;
}

/** The capsule `address` names, if the actor has what the call `need`s of its wardrobe. */
export async function requireCapsule(
  db: Db,
  actor: Actor,
  address: CapsuleAddress,
  need: WardrobeNeed,
): Promise<AuthorizedCapsule> {
  const wardrobe = await capsuleWardrobe(db, actor, address, need);
  return {
    ...wardrobe,
    capsule: await capsuleIn(db, wardrobe.access, address.id),
  };
}

/**
 * A new capsule in the wardrobe `ownerId` names (the owner's alone): its
 * id, or 'name-taken' for the form to say so (not a refusal: the form is
 * drawn again).
 */
export async function createOwnCapsule(
  db: Db,
  actor: Actor,
  ownerId: number | '' | undefined,
  fields: CapsuleFields,
): Promise<NameTaken | (AuthorizedWardrobe & { id: number })> {
  const wardrobe = await authorizeWardrobe(
    db,
    actor,
    ownerId,
    'own',
    'capsule',
  );
  const id = await createCapsule(db, wardrobe.access.ownerId, fields);
  return id === 'name-taken' ? id : { ...wardrobe, id };
}

/**
 * createOwnCapsule for the API's retried create (`clientId`): 'gone' for
 * the id of a capsule deleted since, `created: false` for a retry.
 */
export async function createOwnCapsuleOnce(
  db: Db,
  actor: Actor,
  ownerId: number | '' | undefined,
  fields: CapsuleFields,
  clientId: string,
): Promise<
  NameTaken | 'gone' | (AuthorizedWardrobe & { id: number; created: boolean })
> {
  const wardrobe = await authorizeWardrobe(
    db,
    actor,
    ownerId,
    'own',
    'capsule',
  );
  const once = await createCapsuleOnce(
    db,
    wardrobe.access.ownerId,
    fields,
    clientId,
  );
  return typeof once === 'string' ? once : { ...wardrobe, ...once };
}

/** Rename and notes (the owner's alone), or 'name-taken' for the form to say so. */
export async function renameCapsule(
  db: Db,
  actor: Actor,
  address: CapsuleAddress,
  fields: CapsuleFields,
): Promise<NameTaken | AuthorizedWardrobe> {
  const wardrobe = await capsuleWardrobe(db, actor, address, 'own');
  const saved = await updateCapsule(
    db,
    address.id,
    wardrobe.access.ownerId,
    fields,
  );
  if (saved === 'not-found') throw capsuleNotFound();
  return saved === 'name-taken' ? saved : wardrobe;
}

/** Deletes the capsule (the owner's alone); its garments stay. */
export async function deleteOwnCapsule(
  db: Db,
  actor: Actor,
  address: CapsuleAddress,
): Promise<AuthorizedWardrobe> {
  const wardrobe = await capsuleWardrobe(db, actor, address, 'own');
  if (!(await deleteCapsule(db, address.id, wardrobe.access.ownerId))) {
    throw capsuleNotFound();
  }
  return wardrobe;
}

/** What one membership change asks: ids outside the wardrobe are dropped, not refused. */
export interface MembersChange {
  add: number[];
  remove: number[];
}

export type MembershipChanged = AuthorizedWardrobe & {
  added: number;
  removed: number;
};

/**
 * The capsule's members changed from its side (the picker's Save,
 * set_capsule_membership): a MANAGE share or ownership. No capsule lookup
 * first (#172, #251): changeMembership answers which capsules took part,
 * so another wardrobe's capsule is the 404 after a write that changed
 * nothing.
 */
export async function setCapsuleMembers(
  db: Db,
  actor: Actor,
  address: CapsuleAddress,
  garments: MembersChange,
): Promise<MembershipChanged> {
  const wardrobe = await capsuleWardrobe(db, actor, address, 'manage');
  const { added, removed, capsules } = await changeMembership(
    db,
    wardrobe.access.ownerId,
    {
      add: { capsuleIds: [address.id], garmentIds: garments.add },
      remove: { capsuleIds: [address.id], garmentIds: garments.remove },
    },
  );
  if (!capsules.has(address.id)) throw capsuleNotFound();
  return { ...wardrobe, added, removed };
}

/**
 * The garment's capsules changed from its side (the garment page's
 * toggles): the same rule, the garment the 404 (a wishlist item is found,
 * and changes nothing).
 */
export async function setGarmentCapsules(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
  capsules: MembersChange,
): Promise<MembershipChanged> {
  const wardrobe = await garmentWardrobe(db, actor, address, 'manage');
  const { added, removed, garments } = await changeMembership(
    db,
    wardrobe.access.ownerId,
    {
      add: { capsuleIds: capsules.add, garmentIds: [address.id] },
      remove: { capsuleIds: capsules.remove, garmentIds: [address.id] },
    },
  );
  if (!garments.has(address.id)) throw garmentNotFound();
  return { ...wardrobe, added, removed };
}
