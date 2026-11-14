import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../../auth/require-session';
import { t } from '../../i18n';
import { loggableUrl } from '../../loggable-url';
import type { WebOptions } from '../../plugin';
import { renderPage } from '../../render';
import { RowId } from '../../schemas';
import { LINK_IMPORT_LIMIT, tooManyAttempts } from '../../security/rate-limit';
import { viewContext } from '../../view-context';
import { importLink, LinkImportError } from '../link-import/import';
import type { LinkImportView } from '../link-import/photo-choice';
import { importedForm } from '../link-import/prefill';
import { renderGarmentForm } from '../render-form';
import { BLANK_GARMENT_VALUES, type GarmentFormValues } from '../garment-input';
import {
  decideOrderItem,
  findPendingOrderItem,
  pendingOrderItems,
  type ReviewItem,
} from './queries';
import { OrderReviewPage } from './review-page';
import { ORDERS_PATH } from './urls';

const ItemParams = Type.Object({ id: RowId });

/** The household's one currency (priceLabel; the link import's prefill). */
const HOUSEHOLD_CURRENCY = 'USD';

/**
 * "From your orders" (#25): the review list of what the order mail's poll
 * found (poll.ts), for ORDER_MAIL_OWNER's account only: anyone else, and
 * everyone with the order mail off, gets a 404 like a route that does not
 * exist. Registered either way, so the static path always wins over
 * /wardrobe/:id (whose id check would answer "orders" with a 400).
 *
 * "Add to closet" is the link import (importLink, as POST
 * /wardrobe/new/from-link runs it) on the item's product link, answering
 * the ordinary new-garment form for the closet with the order's day and
 * price, and the item as `orderItem`, which POST /wardrobe marks added in
 * the garment's own transaction (postedDestination). It fetches a URL, so
 * it counts against a LINK_IMPORT_LIMIT of its own. "Dismiss" moves the
 * item out of the list. Both are native posts (PostForm).
 */
export const orderReviewRoutes: FastifyPluginCallbackTypebox<
  WebOptions & { orderMailOwnerId: number | undefined }
> = (app, options, done) => {
  const { db, logger, photos, fetcher, orderMailOwnerId } = options;
  const importDeps = { db, fetcher, photos, logger };
  const addLimit = app.createRateLimit(LINK_IMPORT_LIMIT);

  // Off (no owner), or not the order account's owner: the app's own 404
  // (its not-found handler), as a route that is not there. A request
  // concern, so a hook: after the schema, before every handler, as the
  // check each handler made first. By id, resolved at boot (#706): an
  // account that takes the owner's old address is still anyone else.
  app.addHook('preHandler', (request, reply, done) => {
    if (
      orderMailOwnerId === undefined ||
      request.auth?.user.id !== orderMailOwnerId
    ) {
      reply.callNotFound();
      return;
    }
    done();
  });

  app.get(ORDERS_PATH, async (request, reply) => {
    const userId = sessionUserId(request);
    const items = await pendingOrderItems(db, userId);
    logger.debug(`Order review for user ${userId}: ${items.length} pending`);
    return renderPage(
      reply,
      <OrderReviewPage ctx={viewContext(reply)} items={items} />,
    );
  });

  // The prefilled garment form (a 200 page: nothing is saved yet). An item
  // no longer pending (a second tap after saving, or dismissed in another
  // tab) goes back to the list.
  app.post(
    `${ORDERS_PATH}/:id/add`,
    { schema: { params: ItemParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const verdict = await addLimit(request);
      if (!verdict.isAllowed && verdict.isExceeded) {
        logger.warn(
          `Rate limit reached: ${request.method} ${loggableUrl(request)} for user ${userId}`,
        );
        throw tooManyAttempts(verdict.ttlInSeconds);
      }
      const item = await findPendingOrderItem(db, request.params.id, userId);
      if (!item) return reply.redirect(ORDERS_PATH, 303);
      const { values, link } = await prefilled(item, userId);
      logger.info(
        `Order item ${item.id} opened for the closet by user ${userId}${link.photo ? `, photo ${link.photo} pending` : ', no photo'}`,
      );
      return renderGarmentForm(reply, db, {
        mode: {
          kind: 'new',
          destination: { to: 'closet', orderItem: item.id },
        },
        suggestionsFrom: userId,
        viewOwner: undefined,
        values,
        link,
      });
    },
  );

  app.post(
    `${ORDERS_PATH}/:id/dismiss`,
    { schema: { params: ItemParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const dismissed = await decideOrderItem(db, request.params.id, userId, {
        event: 'dismiss',
      });
      logger.info(
        dismissed
          ? `Order item ${request.params.id} dismissed by user ${userId}`
          : `Order item ${request.params.id} not dismissed for user ${userId}: not pending`,
      );
      return reply.redirect(ORDERS_PATH, 303);
    },
  );

  /**
   * The form's values: what the link import reads from the product page
   * now (photo choices included), with the order's day and, when the page
   * shows none in dollars, the price the poll stored. A page that cannot
   * be fetched now opens the form with what the poll stored and says so.
   */
  async function prefilled(
    item: ReviewItem,
    userId: number,
  ): Promise<{ values: GarmentFormValues; link: LinkImportView }> {
    const stored = storedValues(item);
    try {
      const imported = importedForm(
        await importLink(importDeps, item.productUrl, userId),
        item.productUrl,
      );
      return {
        values: {
          ...imported.values,
          name: imported.values.name || stored.name,
          brand: imported.values.brand || stored.brand,
          price: imported.values.price || stored.price,
          dateAquired: stored.dateAquired,
        },
        link: imported.link,
      };
    } catch (error) {
      if (!(error instanceof LinkImportError)) throw error;
      logger.warn(
        `Order item ${item.id}: product page refused (${error.reason}); the form opens with the stored details`,
      );
      return {
        values: stored,
        link: {
          photo: undefined,
          choices: [],
          notices: [t('orders.PAGE_UNAVAILABLE')],
          warnings: [],
        },
      };
    }
  }

  done();
};

function storedValues(item: ReviewItem): GarmentFormValues {
  const inDollars =
    item.currency === null || item.currency === HOUSEHOLD_CURRENCY;
  return {
    ...BLANK_GARMENT_VALUES,
    name: item.name ?? '',
    brand: item.brand ?? '',
    sourceUrl: item.productUrl,
    price: inDollars && item.price ? item.price : '',
    dateAquired: item.orderedOn,
  };
}
