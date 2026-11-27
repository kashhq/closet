import type { Logger } from '../../logger';
import type { GridCursor } from './grid-cursor';
import { findCapsule } from '../capsules/queries';
import type { StoredPhoto } from '../files/image-variant';
import { publicPhoto } from '../files/references';
import type { WebOptions } from '../plugin';
import { Forbidden, NotFound } from '../refusals';
import {
  type Actor,
  actorOf,
  type AuthorizedWardrobe,
  authorizeWardrobe,
  type WardrobeAccess,
  type WardrobeGuard,
  wardrobeGuard,
  type WardrobeNeed,
  type WardrobeRequest,
} from '../sharing/access';
import {
  findGarment,
  type GarmentDetail,
  type GarmentSummary,
  garmentSummaries,
  gridCount,
  type GridFilters,
  taggedGarment,
} from './queries';

type Db = WebOptions['db'];

/**
 * The garment access path (#188): the domain functions every surface reads
 * a garment through, each enforcing access itself and throwing the typed
 * refusal (src/web/refusals.ts), so a page, an MCP tool and the API refuse
 * alike. Who may do what (authorizeWardrobe, src/web/sharing/access.ts): a
 * wardrobe the actor cannot see is a 404 like an unknown id, and so is a
 * garment outside the wardrobe addressed; one they can see but not change
 * is a 403. Reads need a view, writes a MANAGE share (or ownership),
 * archive and delete ownership, and a clone only a view: it lands in the
 * actor's own wardrobe and only reads the source.
 */

/** A garment outside the wardrobe addressed, or no garment: one refusal for both. */
export function garmentNotFound(): NotFound {
  return new NotFound('garment');
}

/** A garment as a call addresses it: `ownerId` `''` or absent is the actor's own wardrobe. */
export interface GarmentAddress {
  id: number;
  ownerId: number | '' | undefined;
  /**
   * What a wardrobe the actor cannot see reads as: an unknown garment (a
   * page's garment URL), unless the caller named the wardrobe, as MCP's
   * `ownerId` does ("Wardrobe not found", #188b-1).
   */
  unseen?: 'wardrobe';
}

/**
 * The wardrobe `address` names, if the actor has what the call `need`s of
 * it, without reading the garment: for a write whose own statement is the
 * lookup (an update answering whether the row was there, #161), and for
 * requireGarment. Costs a statement only for a share no read ahead
 * answered.
 */
export function garmentWardrobe(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
  need: WardrobeNeed,
): Promise<AuthorizedWardrobe> {
  return authorizeWardrobe(
    db,
    actor,
    address.ownerId,
    need,
    address.unseen ?? 'garment',
  );
}

export interface AuthorizedGarment extends AuthorizedWardrobe {
  garment: GarmentDetail;
}

/**
 * Garment `id` in a wardrobe already authorized (`access` is only what
 * authorizeWardrobe answers), or the 404 of an unknown id. For a caller
 * that resolved the wardrobe for more than this garment: MCP's wardrobeFor,
 * whose unseen wardrobe reads "Wardrobe not found", and a write that read
 * its body first.
 */
export async function garmentIn(
  db: Db,
  access: WardrobeAccess,
  id: number,
): Promise<GarmentDetail> {
  const garment = await findGarment(db, id, access);
  if (!garment) throw garmentNotFound();
  return garment;
}

/**
 * The garment `address` names, if the actor has what the call `need`s of
 * its wardrobe; an unseen wardrobe reads as an unknown garment. The
 * statements a route's own check cost: the garment's, plus the share's
 * only when no read ahead answered it.
 */
export async function requireGarment(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
  need: WardrobeNeed,
): Promise<AuthorizedGarment> {
  const wardrobe = await garmentWardrobe(db, actor, address, need);
  return {
    ...wardrobe,
    garment: await garmentIn(db, wardrobe.access, address.id),
  };
}

/**
 * The tagging card's answer after a tap (taggedGarment's one statement:
 * the garment as saved and the count left), in a wardrobe already
 * authorized; a garment deleted since the tap is the 404 of an unknown id.
 */
export async function taggedGarmentIn(
  db: Db,
  access: WardrobeAccess,
  id: number,
): Promise<{ garment: GarmentDetail; left: number }> {
  const tagged = await taggedGarment(db, id, access.ownerId);
  if (!tagged) throw garmentNotFound();
  return tagged;
}

/** A route request addressing a garment: `/:id` with `?ownerId=` (GarmentParams, OwnerQuery). */
export type GarmentRequest = WardrobeRequest & { params: { id: number } };

/** The garment a route's `/:id` and `?ownerId=` address, for a domain function. */
export function garmentAddress(request: GarmentRequest): GarmentAddress {
  return { id: request.params.id, ownerId: request.query.ownerId };
}

/**
 * A garment plugin's guard, bound once (`const authorize = garmentGuard(db)`):
 * `authorize(request, need)` for the wardrobe a route addresses, and
 * `authorize.garment(request, need)` (requireGarment) for the garment its
 * `/:id` names, so no route relays `?ownerId=` or the id by hand.
 */
export type GarmentGuard = WardrobeGuard & {
  garment(
    request: GarmentRequest,
    need: WardrobeNeed,
  ): Promise<AuthorizedGarment>;
};

export function garmentGuard(db: Db): GarmentGuard {
  return Object.assign(wardrobeGuard(db, 'garment'), {
    garment: (request: GarmentRequest, need: WardrobeNeed) =>
      requireGarment(db, actorOf(request), garmentAddress(request), need),
  });
}

/**
 * The garment's photo for a picture leaving the app (get_garment_photo),
 * in a wardrobe already authorized: a garment without one is "Garment has
 * no photo", and a selfie's file is never a garment's to give (publicPhoto,
 * as the public /file/** routes refuse it), so it reads as an unknown
 * garment, with a warn line.
 */
export async function garmentPhotoIn(
  db: Db,
  logger: Logger,
  access: WardrobeAccess,
  id: number,
): Promise<{ garment: GarmentDetail; photo: StoredPhoto }> {
  const garment = await garmentIn(db, access, id);
  if (!garment.photo) throw new NotFound('garmentPhoto');
  // A garment's photo is never a selfie (each has its own file row), but
  // the rule that no selfie leaves through anything but its owner's
  // session is checked here as on the public /file routes.
  const photo = await publicPhoto(db, garment.photo.fileName);
  if (!photo) {
    logger.warn(
      `Refused a selfie as garment ${id}'s photo in wardrobe ${access.ownerId}`,
    );
    throw garmentNotFound();
  }
  return { garment, photo };
}

export interface GarmentSearch {
  ownerId: number | undefined;
  filters: GridFilters;
  before?: GridCursor;
  limit: number;
}

/**
 * A page of the closet `search.ownerId` names (the filters parsed as the
 * grid's), refusing where the grid would quietly drop or 404: needs-wash on
 * a shared wardrobe (it reads the owner's wears; an unfiltered answer would
 * be misread), a capsule outside the wardrobe. An unseen wardrobe is
 * "Wardrobe not found": the caller named it. search_garments (MCP).
 */
export async function searchGarments(
  db: Db,
  actor: Actor,
  search: GarmentSearch,
): Promise<{
  total: number;
  garments: GarmentSummary[];
  next: GridCursor | null;
}> {
  const { access } = await authorizeWardrobe(
    db,
    actor,
    search.ownerId,
    'view',
    'wardrobe',
  );
  const { filters } = search;
  if (filters.needsWash && !access.isOwner) {
    throw new Forbidden({ reason: 'ownWearsOnly' });
  }
  if (
    filters.capsule !== undefined &&
    !(await findCapsule(db, filters.capsule, access.ownerId))
  ) {
    throw new NotFound('capsule');
  }
  const [page, total] = await Promise.all([
    garmentSummaries(db, access, filters, {
      before: search.before,
      limit: search.limit,
    }),
    gridCount(db, access, filters),
  ]);
  return { total, garments: page.garments, next: page.before ?? null };
}
