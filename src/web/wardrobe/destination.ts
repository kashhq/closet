import type { Db, Queryable } from '../../db/client';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { NotFound } from '../refusals';
import type { GrantedAccess } from '../sharing/access';
import type { EntryStatus } from '../../wardrobe/status';
import { decide } from '../wishlist/decisions';
import { findNeedToBuyFor, type NeedBoughtFor } from '../wishlist/inbox';
import { decideOrderItem, findPendingOrderItem } from './order-mail/queries';
import type { WithGarment } from './writes';
import { findGarment, type GarmentDetail } from './queries';
import { TO_CLOSET, type Destination } from './urls';
import {
  BLANK_CARE,
  BLANK_CARE_LABEL,
  BLANK_GARMENT_VALUES,
  type GarmentBody,
  type GarmentFormValues,
  type PropertyFormValues,
  storedPropertyValues,
} from './garment-input';
import { type DestinationQuery } from './garment-schemas';
import { garmentNotFound } from './garment-access';

/**
 * The Muse need `needId` a new closet garment is bought for ("Bought a
 * different one", #333): the requester's own need still to buy for (open,
 * or chosen and unbought), in their own wardrobe (decisions are the
 * owner's); anything else a 404 like an unknown id, before anything is
 * stored. decide checks it again under the owner lock (a 409 then).
 */
async function resolveNeed(
  db: Queryable,
  needId: number,
  access: GrantedAccess,
): Promise<NeedBoughtFor> {
  const need = access.isOwner
    ? await findNeedToBuyFor(db, access.ownerId, needId)
    : undefined;
  if (!need) throw new NotFound('need');
  return need;
}

/**
 * A new garment's post's destination (POST /wardrobe): the closet or the
 * wishlist; for an order's "Add to closet" (#25) the order item, checked
 * before anything is stored (resolveOrderItem) and marked added in the
 * garment's own transaction; for a Muse need's "Bought a different one"
 * (#333) the need (resolveNeed), settled by the garment in that
 * transaction through decide, the one writer of a decision. `db` is the
 * pool, or the transaction the checks must share with the write
 * (createGarmentOnce's settle): a check on the pool from inside a
 * transaction holding the owner lock would take a second connection.
 */
export async function postedDestination(
  db: Queryable,
  body: Pick<GarmentBody, 'to' | 'orderItem' | 'forNeed'>,
  access: GrantedAccess,
): Promise<{
  destination: Destination & { to: EntryStatus };
  boughtFor?: NeedBoughtFor;
  withGarment?: WithGarment;
}> {
  const to = body.to ?? 'closet';
  if (to === 'closet' && body.forNeed) {
    const need = await resolveNeed(db, body.forNeed, access);
    return {
      destination: { to, forNeed: need.id },
      boughtFor: need,
      withGarment: async (tx, garmentId) => {
        const settled = await decide(tx, access.ownerId, {
          kind: 'bought',
          garmentId,
          groupId: need.id,
        });
        // Settled meanwhile (chosen or set aside on another phone): the
        // garment rolls back with this, and the form says why.
        if (!settled.ok) throw new HttpError(409, t('muse.STALE'));
      },
    };
  }
  if (to === 'closet' && body.orderItem) {
    const orderItem = await resolveOrderItem(db, body.orderItem, access);
    return {
      destination: { to, orderItem },
      withGarment: async (tx, garmentId) => {
        const added = await decideOrderItem(tx, orderItem, access.ownerId, {
          event: 'add',
          garmentId,
        });
        // Dismissed, or added by an earlier save of the same form, since
        // the check above: the garment rolls back with this.
        if (!added) throw new HttpError(409, t('refusal.garment.alreadyAdded'));
      },
    };
  }
  return { destination: { to } };
}

/**
 * The order item `orderItemId` a new closet garment is added from: the
 * requester's own pending one, in their own wardrobe; anything else a 404
 * like an unknown id, before anything is stored.
 */
async function resolveOrderItem(
  db: Queryable,
  orderItemId: number,
  access: GrantedAccess,
): Promise<number> {
  const item = access.isOwner
    ? await findPendingOrderItem(db, orderItemId, access.ownerId)
    : undefined;
  if (!item) throw new NotFound('orderItem');
  return item.id;
}

/**
 * Where a new garment's form lands, from its URL (DestinationQuery): the
 * closet, the wishlist, the wishlist as a replacement for a garment of the
 * addressed wardrobe (a garment's "Find a replacement"; any other id is a
 * 404 like an unknown garment). Shared by GET
 * /wardrobe/new and the link import's routes, which carry it through to
 * the form.
 */
export async function resolveDestination(
  db: Db,
  query: DestinationQuery,
  access: GrantedAccess,
): Promise<{
  destination: Destination;
  replaced?: GarmentDetail;
  boughtFor?: NeedBoughtFor;
  /** The garment its values are prefilled from: the replaced one, or the need's best pick. */
  prefill?: GarmentDetail;
}> {
  if (query.to !== 'wishlist') {
    if (!query.forNeed) return { destination: TO_CLOSET };
    const need = await resolveNeed(db, query.forNeed, access);
    const pick =
      need.pickId === null
        ? undefined
        : await findGarment(db, need.pickId, access);
    return {
      destination: { to: 'closet', forNeed: need.id },
      boughtFor: need,
      prefill: pick,
    };
  }
  const replaced = query.replaces
    ? await findGarment(db, query.replaces, access)
    : null;
  if (replaced === undefined) throw garmentNotFound();
  return {
    destination: {
      to: 'wishlist',
      ...(replaced && { replaces: replaced.id }),
    },
    replaced: replaced ?? undefined,
    prefill: replaced ?? undefined,
  };
}

/**
 * A new garment form's values: blank (the closet's, or a wishlist item's),
 * or prefilled from `prefill` (the garment a wishlist item replaces, or a
 * Muse need's pick for "Bought a different one") with what describes the
 * kind of garment (category, type and the other properties, brand,
 * colours, size), never what belonged to that one (its name, notes,
 * dates, price, link, care).
 */
export function destinationValues(
  destination: Destination,
  prefill: GarmentDetail | undefined,
): GarmentFormValues {
  const replaces =
    destination.replaces === undefined ? '' : String(destination.replaces);
  if (!prefill) return { ...BLANK_GARMENT_VALUES, replaces };
  return {
    ...BLANK_GARMENT_VALUES,
    category: prefill.category,
    brand: prefill.brand ?? '',
    colors: prefill.colors ?? [],
    size: prefill.size ?? '',
    properties: withoutCareLabel(storedPropertyValues(prefill)),
    care: BLANK_CARE,
    replaces,
  };
}

/**
 * A prefill's properties without that garment's care label, which is
 * that garment's own: none chosen, and no materials behind the presets, so
 * the form's first refresh fills the label from the materials.
 */
function withoutCareLabel(values: PropertyFormValues): PropertyFormValues {
  return {
    ...values,
    ...BLANK_CARE_LABEL,
    preset: { ...values.preset, materials: '' },
  };
}
