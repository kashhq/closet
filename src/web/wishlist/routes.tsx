import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import type { FieldErrors } from '../auth/validation';
import { type IsoDate, parseIsoDate, todayIn } from '../../calendar-date';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { actorOf, type AuthorizedWardrobe } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  garmentAddress,
  garmentGuard,
  garmentIn,
} from '../wardrobe/garment-access';
import type { GarmentDetail } from '../wardrobe/queries';
import { type Purchase } from '../wardrobe/status';
import { garmentUrl } from '../wardrobe/urls';
import { GarmentParams, OwnerQuery } from '../schemas';
import { PRICE_INPUT_MAX, readPrice } from '../wardrobe/garment-input';
import { type BoughtField, type BoughtModel, BoughtPage } from './bought-page';
import { buyWishlistItem, purchaseNeed } from './purchase';
import { garmentRef, type GarmentRef } from './queries';

// "Bought it": the day and the price paid as typed (checked by readPurchase,
// re-rendered with messages), and what only the owner may ask for: the
// archive of the replaced garment.
const BoughtBody = Type.Object({
  acquiredOn: Type.Optional(Type.String({ maxLength: 32 })),
  price: Type.Optional(Type.String({ maxLength: PRICE_INPUT_MAX })),
  archiveReplaced: Type.Optional(Type.Literal('1')),
});
type BoughtBody = Static<typeof BoughtBody>;

/** The purchase as stored (a blank field is null), or what is wrong with it. */
function readPurchase(
  body: BoughtBody,
):
  | { ok: true; purchase: Purchase }
  | { ok: false; errors: FieldErrors<BoughtField> } {
  const typedDay = body.acquiredOn?.trim();
  const acquiredOn: IsoDate | null | undefined = typedDay
    ? parseIsoDate(typedDay)
    : null;
  const price = readPrice(body.price);
  const errors: FieldErrors<BoughtField> = {
    ...(acquiredOn === undefined && {
      acquiredOn: [t('validation.INVALID_DATE')],
    }),
    ...('error' in price && { price: [price.error] }),
  };
  if (acquiredOn === undefined || 'error' in price)
    return { ok: false, errors };
  return { ok: true, purchase: { acquiredOn, price: price.price } };
}

/**
 * "Bought it" (#18, plan section 11; the Wishlist tab itself is Muse's
 * inbox, inbox-routes.tsx). Wishlist items
 * are the wardrobe's garments with status 'wishlist', so they are shared
 * like the rest of it (owner decision, #18): a VIEW grantee reads the
 * grantor's wishlist (a gift list; the owner reading a sibling's), a MANAGE
 * grantee also adds, edits and buys, and only the owner archives the
 * garment a purchase replaces or deletes an item. Adding and editing are
 * the garment form's (src/web/wardrobe, `?to=wishlist`).
 */
export const wishlistRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger, config } = options;
  const authorize = garmentGuard(db);
  /** The replaced garment to offer for the archive: still in the closet, and the requester its owner. */
  async function archivable(
    garment: GarmentDetail,
    { access }: AuthorizedWardrobe,
  ): Promise<GarmentRef | undefined> {
    if (!access.isOwner || garment.replacesGarmentId === null) return undefined;
    const replaced = await garmentRef(
      db,
      garment.replacesGarmentId,
      access.ownerId,
    );
    return replaced?.status === 'closet' ? replaced : undefined;
  }

  function renderBought(
    reply: FastifyReply,
    model: BoughtModel,
    status = 200,
  ): Promise<FastifyReply> {
    return renderPage(
      reply,
      <BoughtPage ctx={viewContext(reply)} model={model} />,
      { status },
    );
  }

  // The form. A garment that is no longer on the wishlist (bought on
  // another phone, a stale link) sends the person to its page.
  app.get(
    '/wardrobe/:id/bought',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { garment, ...authorized } = await authorize.garment(
        request,
        'manage',
      );
      const { viewOwner } = authorized;
      if (garment.status !== 'wishlist') {
        return reply.redirect(garmentUrl(garment.id, viewOwner), 302);
      }
      // "Bought it" needs `manage`, which has `private`: the listed price.
      const { price } = garment;
      return renderBought(reply, {
        garment,
        viewOwner,
        values: {
          acquiredOn: todayIn(config.timeZone, new Date()),
          price: price ?? '',
        },
        archivable: await archivable(garment, authorized),
      });
    },
  );

  // Into the closet (buyWishlistItem: buyGarment's buy and, when asked, the
  // replaced garment's archive, then a Muse pick's need settled, in one
  // transaction), then its page with a toast. A grantee asking for the
  // archive is a 403 before anything is written; an item already bought is
  // a 409.
  app.post(
    '/wardrobe/:id/bought',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: BoughtBody,
      },
    },
    async (request, reply) => {
      const archiveReplaced = request.body.archiveReplaced === '1';
      // Asked before the purchase is read: its refused form is drawn in the
      // wardrobe. buyWishlistItem's own check is free.
      const authorized = await authorize(
        request,
        purchaseNeed(archiveReplaced),
      );
      const { access, viewOwner } = authorized;
      const { id } = request.params;
      const read = readPurchase(request.body);
      if (!read.ok) {
        // Only a refusal reads the garment: its form is drawn again. A
        // purchase goes straight to buyWishlistItem, whose status change is
        // the lookup (an id outside the wardrobe is its 'not-found').
        const garment = await garmentIn(db, access, id);
        logger.warn(
          `Bought it refused for garment ${garment.id}: ${Object.keys(read.errors).join(', ')}`,
        );
        return renderBought(
          reply,
          {
            garment,
            viewOwner,
            values: {
              acquiredOn: request.body.acquiredOn ?? '',
              price: request.body.price ?? '',
            },
            archivable: await archivable(garment, authorized),
            errors: read.errors,
          },
          400,
        );
      }
      await buyWishlistItem(
        options,
        actorOf(request),
        garmentAddress(request),
        { ...read.purchase, archiveReplaced },
      );
      return reply.redirect(garmentUrl(id, viewOwner, '', { bought: 1 }), 303);
    },
  );

  done();
};
